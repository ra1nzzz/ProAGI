import { developerDayFixture } from '../fixtures/developerDay';
import { ImportStreamController, WorkerProtocolError, orderedEventsHash, type NdjsonHeader, type ValidatedEventCandidate, type WorkerCompleteMessage, type WorkerValidatedMessage } from './ndjsonProtocol';
import type { NdjsonWorkerInput } from './ndjson.worker';

const MAX_CHUNK_BYTES = 262_144;
const MAX_UNACKED = 2 as const;

type WorkerMessage = WorkerValidatedMessage | WorkerCompleteMessage | { readonly type: 'ERROR'; readonly streamId: string; readonly errorCode: string };

export function createNdjsonWorker(): Worker {
  if (typeof Worker === 'undefined') throw new WorkerProtocolError('ERR_WORKER_UNAVAILABLE');
  return new Worker(new URL('./ndjson.worker.ts', import.meta.url), { type: 'module' });
}

export interface BundledWorkerValidation {
  readonly candidates: readonly ValidatedEventCandidate[];
  readonly receipt: WorkerCompleteMessage['receipt'];
}

export async function validateBundledFixtureWithWorker(workerFactory: () => Worker): Promise<BundledWorkerValidation> {
  const worker = workerFactory();
  const controller = new ImportStreamController();
  controller.trackWorker(worker);
  const streamId = crypto.randomUUID();
  const sourceCandidates = developerDayFixture.events.map((event, index) => ({
    sequence: String(index), event: event as unknown as Record<string, unknown>,
  }));
  const header: NdjsonHeader = {
    lineType: 'header', format: 'proagi-behavior-events', formatVersion: '1', schemaVersion: '1.0.0',
    inputIdentity: { kind: 'fixture', fixtureId: developerDayFixture.fixtureId }, declaredEventCount: sourceCandidates.length,
  };
  const stream = `${sourceCandidates.map((item) => JSON.stringify({ lineType: 'event', ...item })).join('\r\n')}\r\n${JSON.stringify({ lineType: 'footer', eventCount: sourceCandidates.length, orderedEventsHash: orderedEventsHash(sourceCandidates) })}`;
  const encoded = new TextEncoder().encode(stream);
  const chunks = Array.from({ length: Math.ceil(encoded.byteLength / MAX_CHUNK_BYTES) }, (_, index) => {
    const start = index * MAX_CHUNK_BYTES;
    return encoded.slice(start, start + MAX_CHUNK_BYTES).buffer as ArrayBuffer;
  });

  try {
    return await new Promise<BundledWorkerValidation>((resolve, reject) => {
      const accepted: ValidatedEventCandidate[] = [];
      const pending: Array<{ readonly chunkId: string; readonly sequence: string }> = [];
      let nextChunk = 0;
      let finished = false;
      let settled = false;
      const fail = (code: string) => {
        if (settled) return;
        settled = true;
        reject(new WorkerProtocolError(code));
      };
      const post = (message: NdjsonWorkerInput, transfer?: Transferable[]) => {
        try { worker.postMessage(message, transfer ?? []); } catch { fail('ERR_WORKER_FAILURE'); }
      };
      const sendAvailable = () => {
        while (!settled && nextChunk < chunks.length && pending.length < MAX_UNACKED) {
          const index = nextChunk++;
          const bytes = chunks[index]!;
          const chunkId = `chunk-${index}`;
          const sequence = String(index);
          pending.push({ chunkId, sequence });
          post({ type: 'CHUNK', streamId, chunkId, sequence, bytes, byteLength: bytes.byteLength }, [bytes]);
        }
        if (!settled && !finished && nextChunk === chunks.length && pending.length === 0) {
          finished = true;
          post({ type: 'FINISH', streamId });
        }
      };
      const removeListeners = () => { worker.onmessage = null; worker.onerror = null; };
      controller.trackListener(removeListeners);
      worker.onerror = () => fail('ERR_WORKER_FAILURE');
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        if (!message || message.streamId !== streamId) return fail('ERR_WORKER_STREAM');
        if (message.type === 'ERROR') return fail(message.errorCode);
        if (message.type === 'VALIDATED') {
          const expected = pending[0];
          if (!expected || expected.chunkId !== message.chunkId || expected.sequence !== message.sequence) return fail('ERR_WORKER_ACK_MISMATCH');
          accepted.push(...message.candidates);
          pending.shift();
          post({ type: 'ACK', streamId, chunkId: message.chunkId, sequence: message.sequence });
          sendAvailable();
          return;
        }
        if (message.type === 'COMPLETE') {
          if (pending.length > 0 || nextChunk !== chunks.length || message.receipt.state !== 'validated') return fail(message.receipt.errorCode ?? 'ERR_WORKER_VALIDATION');
          settled = true;
          resolve({ candidates: accepted, receipt: message.receipt });
        }
      };
      post({ type: 'INIT', streamId, header, maxChunkBytes: MAX_CHUNK_BYTES, maxUnacked: MAX_UNACKED });
      sendAvailable();
    });
  } finally {
    controller.dispose();
  }
}
