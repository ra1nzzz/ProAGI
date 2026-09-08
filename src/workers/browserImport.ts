import { hashCanonical } from '../domain/canonical';
import { developerDayFixture } from '../fixtures/developerDay';
import {
  ImportStreamController,
  WorkerProtocolError,
  hashRawBytes,
  orderedEventsHash,
  type NdjsonHeader,
  type ValidatedEventCandidate,
  type WorkerCompleteMessage,
  type WorkerValidatedMessage,
} from './ndjsonProtocol';
import type { NdjsonWorkerInput } from './ndjson.worker';
import type { Hash } from '../domain/types';

export const MAX_CHUNK_BYTES = 262_144;
export const MAX_UNACKED = 2 as const;

type WorkerMessage =
  | WorkerValidatedMessage
  | WorkerCompleteMessage
  | { readonly type: 'ERROR'; readonly streamId: string; readonly errorCode: string }
  | { readonly status: 'backpressure'; readonly streamId: string; readonly chunkId: string; readonly sequence: string };

type WorkerBackpressureMessage = Extract<WorkerMessage, { readonly status: 'backpressure' }>;

export function createNdjsonWorker(): Worker {
  if (typeof Worker === 'undefined') throw new WorkerProtocolError('ERR_WORKER_UNAVAILABLE');
  return new Worker(new URL('./ndjson.worker.ts', import.meta.url), { type: 'module' });
}

export interface WorkerStreamValidation {
  readonly header: NdjsonHeader;
  readonly candidates: readonly ValidatedEventCandidate[];
  readonly rejected: readonly { readonly itemKey: string; readonly errorCode: string }[];
  readonly receipt: WorkerCompleteMessage['receipt'];
}

export interface BundledWorkerValidation {
  readonly candidates: readonly ValidatedEventCandidate[];
  readonly receipt: WorkerCompleteMessage['receipt'];
}

/**
 * Streams raw bytes to the Worker. The main thread only slices bytes to the
 * transport limit; framing, UTF-8 and schema validation remain in the Worker.
 */
export async function validateNdjsonStreamWithWorker(input: {
  readonly stream: ReadableStream<Uint8Array>;
  readonly workerFactory: () => Worker;
  readonly expectedHeader?: NdjsonHeader;
}): Promise<WorkerStreamValidation> {
  const controller = new ImportStreamController();
  let worker: Worker | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    worker = input.workerFactory();
    controller.trackWorker(worker);
    reader = input.stream.getReader();
    controller.trackReader(reader);
    const streamId = crypto.randomUUID();
    const messages: WorkerMessage[] = [];
    let nextMessageResolver: ((message: WorkerMessage) => void) | null = null;
    const enqueue = (message: WorkerMessage): void => {
      if (nextMessageResolver) {
        const resolve = nextMessageResolver;
        nextMessageResolver = null;
        resolve(message);
      } else {
        messages.push(message);
      }
    };
    const nextMessage = (): Promise<WorkerMessage> => {
      const message = messages.shift();
      if (message) return Promise.resolve(message);
      return new Promise<WorkerMessage>((resolve) => { nextMessageResolver = resolve; });
    };
    const post = (message: NdjsonWorkerInput, transfer?: Transferable[]): void => {
      try {
        worker!.postMessage(message, transfer ?? []);
      } catch {
        throw new WorkerProtocolError('ERR_WORKER_FAILURE');
      }
    };
    const removeListeners = (): void => { worker!.onmessage = null; worker!.onerror = null; };
    controller.trackListener(removeListeners);
    worker.onerror = () => enqueue({ type: 'ERROR', streamId, errorCode: 'ERR_WORKER_FAILURE' });
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (!event.data || typeof event.data !== 'object') {
        enqueue({ type: 'ERROR', streamId, errorCode: 'ERR_WORKER_FAILURE' });
        return;
      }
      enqueue(event.data as WorkerMessage);
    };
    post({
      type: 'INIT',
      streamId,
      ...(input.expectedHeader ? { header: input.expectedHeader } : {}),
      maxChunkBytes: MAX_CHUNK_BYTES,
      maxUnacked: MAX_UNACKED,
      decoder: 'utf-8-fatal-stream-v1',
    });

    let sourceDone = false;
    let remainder = new Uint8Array();
    const readChunk = async (): Promise<Uint8Array | null> => {
      while (!sourceDone && remainder.byteLength < MAX_CHUNK_BYTES) {
        const result = await reader!.read();
        if (result.done) {
          sourceDone = true;
          break;
        }
        if (result.value.byteLength === 0) continue;
        const next = result.value.slice();
        if (remainder.byteLength === 0) remainder = next;
        else {
          const combined = new Uint8Array(remainder.byteLength + next.byteLength);
          combined.set(remainder);
          combined.set(next, remainder.byteLength);
          remainder = combined;
        }
      }
      if (remainder.byteLength === 0) return null;
      const chunk = remainder.byteLength <= MAX_CHUNK_BYTES ? remainder : remainder.slice(0, MAX_CHUNK_BYTES);
      remainder = remainder.byteLength <= MAX_CHUNK_BYTES ? new Uint8Array() : remainder.slice(MAX_CHUNK_BYTES);
      return chunk;
    };

    const accepted: ValidatedEventCandidate[] = [];
    const rejected: WorkerValidatedMessage['rejected'][number][] = [];
    const pending: Array<{ readonly chunkId: string; readonly sequence: string; readonly bytesHash: Hash }> = [];
    const chunkHashes: Hash[] = [];
    let totalBytes = 0;
    let nextChunk = 0;
    const consumeValidated = async (): Promise<void> => {
      const message = await nextMessage();
      if (!message || message.streamId !== streamId) throw new WorkerProtocolError('ERR_WORKER_STREAM');
      if (isBackpressureMessage(message)) throw new WorkerProtocolError('ERR_WORKER_BACKPRESSURE');
      if (message.type === 'ERROR') throw new WorkerProtocolError(message.errorCode);
      if (message.type !== 'VALIDATED') throw new WorkerProtocolError('ERR_WORKER_ACK_MISMATCH');
      const expected = pending[0];
      if (!expected || expected.chunkId !== message.chunkId || expected.sequence !== message.sequence) throw new WorkerProtocolError('ERR_WORKER_ACK_MISMATCH');
      if (expected.bytesHash !== message.workerBytesHash) throw new WorkerProtocolError('ERR_WORKER_BYTES_HASH');
      accepted.push(...message.candidates);
      rejected.push(...message.rejected);
      pending.shift();
      post({ type: 'ACK', streamId, chunkId: message.chunkId, sequence: message.sequence });
    };

    while (!sourceDone || pending.length > 0) {
      while (!sourceDone && pending.length < MAX_UNACKED) {
        const bytes = await readChunk();
        if (!bytes) break;
        const chunkId = `chunk-${nextChunk}`;
        const sequence = String(nextChunk);
        nextChunk += 1;
        totalBytes += bytes.byteLength;
        const bytesHash = hashRawBytes(bytes);
        chunkHashes.push(bytesHash);
        pending.push({ chunkId, sequence, bytesHash });
        const transferable = bytes.buffer as ArrayBuffer;
        post({ type: 'CHUNK', streamId, chunkId, sequence, bytes: transferable, byteLength: bytes.byteLength }, [transferable]);
      }
      if (pending.length > 0) await consumeValidated();
    }

    post({ type: 'FINISH', streamId });
    const complete = await nextMessage();
    if (!complete || complete.streamId !== streamId) throw new WorkerProtocolError('ERR_WORKER_STREAM');
    if (isBackpressureMessage(complete)) throw new WorkerProtocolError('ERR_WORKER_BACKPRESSURE');
    if (complete.type === 'ERROR') throw new WorkerProtocolError(complete.errorCode);
    if (complete.type !== 'COMPLETE' || complete.receipt.state !== 'validated') {
      throw new WorkerProtocolError(complete.type === 'COMPLETE' ? complete.receipt.errorCode ?? 'ERR_WORKER_VALIDATION' : 'ERR_WORKER_VALIDATION');
    }
    const receipt = complete.receipt;
    const header = receipt.header;
    if (!header) throw new WorkerProtocolError('ERR_NDJSON_HEADER');
    if (receipt.rawChunkBytes !== totalBytes
      || receipt.orderedWorkerBytesHash !== hashCanonical(chunkHashes)
      || receipt.validatedEventCount !== accepted.length
      || receipt.rejectedEventCount !== rejected.length
      || receipt.declaredEventCount !== header.declaredEventCount
      || accepted.length !== header.declaredEventCount) throw new WorkerProtocolError('ERR_WORKER_RECEIPT_INVALID');
    return { header, candidates: accepted, rejected, receipt };
  } finally {
    controller.dispose();
  }
}

function isBackpressureMessage(message: WorkerMessage): message is WorkerBackpressureMessage {
  return 'status' in message && message.status === 'backpressure';
}

export async function validateBundledFixtureWithWorker(workerFactory: () => Worker): Promise<BundledWorkerValidation> {
  const sourceCandidates = developerDayFixture.events.map((event, index) => ({
    sequence: String(index), event: event as unknown as Record<string, unknown>,
  }));
  const header: NdjsonHeader = {
    lineType: 'header', format: 'proagi-behavior-events', formatVersion: '1', schemaVersion: '1.0.0',
    inputIdentity: { kind: 'fixture', fixtureId: developerDayFixture.fixtureId }, declaredEventCount: sourceCandidates.length,
  };
  const stream = [
    JSON.stringify(header),
    ...sourceCandidates.map((item) => JSON.stringify({ lineType: 'event', ...item })),
    JSON.stringify({ lineType: 'footer', eventCount: sourceCandidates.length, orderedEventsHash: orderedEventsHash(sourceCandidates) }),
  ].join('\r\n');
  const encoded = new TextEncoder().encode(stream);
  const result = await validateNdjsonStreamWithWorker({
    workerFactory,
    expectedHeader: header,
    stream: new ReadableStream<Uint8Array>({ start: (streamController) => { streamController.enqueue(encoded); streamController.close(); } }),
  });
  return { candidates: result.candidates, receipt: result.receipt };
}
