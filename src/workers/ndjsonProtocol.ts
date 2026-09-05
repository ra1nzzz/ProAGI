import { hashCanonical, sha256 } from '../domain/canonical';
import type { Hash } from '../domain/types';
import { parseFixtureJson } from '../domain/fixture';

export class WorkerProtocolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WorkerProtocolError';
  }
}

const MAX_STREAM_BYTES = 100 * 1024 * 1024;
const MAX_LINE_CODE_UNITS = 1024 * 1024;
const MAX_DECLARED_EVENTS = 50_000;

export interface NdjsonHeader {
  lineType: 'header';
  format: 'proagi-behavior-events';
  formatVersion: '1';
  schemaVersion: string;
  inputIdentity: unknown;
  declaredEventCount: number;
}

export interface ValidatedEventCandidate {
  sequence: string;
  event: Record<string, unknown>;
}

export interface WorkerValidatedMessage {
  type: 'VALIDATED';
  streamId: string;
  chunkId: string;
  sequence: string;
  candidates: readonly ValidatedEventCandidate[];
  rejected: readonly { itemKey: string; errorCode: string }[];
  workerBytesHash: Hash;
}

export interface WorkerValidationReceipt {
  streamId: string;
  state: 'validated' | 'cancelled' | 'failed';
  rawChunkBytes: number;
  declaredEventCount: number;
  validatedEventCount: number;
  rejectedEventCount: number;
  orderedWorkerBytesHash?: Hash;
  errorCode?: string;
}

export interface WorkerCompleteMessage {
  type: 'COMPLETE';
  streamId: string;
  receipt: WorkerValidationReceipt;
}

export type PushResult =
  | { status: 'accepted'; message: WorkerValidatedMessage }
  | { status: 'backpressure'; retainedByteLength: number };

interface PendingValidation {
  key: string;
  message: WorkerValidatedMessage;
  retainedBytes: number;
}

export class NdjsonWorkerProtocol {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private textBuffer = '';
  private readonly pending: PendingValidation[] = [];
  private readonly accepted: ValidatedEventCandidate[] = [];
  private readonly rejected: { itemKey: string; errorCode: string }[] = [];
  private readonly chunkHashes: Hash[] = [];
  private nextSequence = 0n;
  private footer?: { eventCount: number; orderedEventsHash: Hash };
  private rawChunkBytes = 0;
  private terminal?: WorkerCompleteMessage;
  private disposed = false;

  constructor(
    readonly streamId: string,
    readonly header: NdjsonHeader,
    readonly maxChunkBytes = 262_144,
    readonly maxUnacked: 2 = 2,
  ) {
    if (header.lineType !== 'header' || header.format !== 'proagi-behavior-events' || header.formatVersion !== '1') throw new WorkerProtocolError('ERR_NDJSON_HEADER');
    if (!Number.isSafeInteger(header.declaredEventCount) || header.declaredEventCount < 0 || header.declaredEventCount > MAX_DECLARED_EVENTS) throw new WorkerProtocolError('ERR_NDJSON_COUNT');
    if (maxChunkBytes > 262_144 || maxChunkBytes <= 0 || maxUnacked !== 2) throw new WorkerProtocolError('ERR_WORKER_LIMIT');
  }

  pushChunk(input: { streamId: string; chunkId: string; sequence: string; bytes: ArrayBuffer | Uint8Array; byteLength?: number }): PushResult {
    this.assertLive(input.streamId);
    const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
    const byteLength = input.byteLength ?? bytes.byteLength;
    if (byteLength !== bytes.byteLength || byteLength > this.maxChunkBytes) throw new WorkerProtocolError('ERR_CHUNK_LIMIT');
    if (this.pending.length >= this.maxUnacked) return { status: 'backpressure', retainedByteLength: this.retainedByteLength };
    if (this.pending.some((item) => item.key === messageKey(input))) throw new WorkerProtocolError('ERR_WORKER_DUPLICATE_CHUNK');
    if (this.footer) throw new WorkerProtocolError('ERR_NDJSON_TRAILING_BYTES');

    let decoded: string;
    try {
      decoded = this.decoder.decode(bytes, { stream: true });
    } catch {
      this.fail('ERR_INVALID_UTF8');
      throw new WorkerProtocolError('ERR_INVALID_UTF8');
    }
    this.rawChunkBytes += bytes.byteLength;
    if (this.rawChunkBytes > MAX_STREAM_BYTES) {
      this.fail('ERR_STREAM_LIMIT');
      throw new WorkerProtocolError('ERR_STREAM_LIMIT');
    }
    this.chunkHashes.push(hashRawBytes(bytes));
    this.textBuffer += decoded;
    const beforeAccepted = this.accepted.length;
    const beforeRejected = this.rejected.length;
    this.consumeCompleteLines();
    if (this.textBuffer.length > MAX_LINE_CODE_UNITS) {
      this.fail('ERR_LINE_LIMIT');
      throw new WorkerProtocolError('ERR_LINE_LIMIT');
    }
    const message: WorkerValidatedMessage = {
      type: 'VALIDATED',
      streamId: this.streamId,
      chunkId: input.chunkId,
      sequence: input.sequence,
      candidates: this.accepted.slice(beforeAccepted),
      rejected: this.rejected.slice(beforeRejected),
      workerBytesHash: hashRawBytes(bytes),
    };
    this.pending.push({ key: messageKey(input), message, retainedBytes: bytes.byteLength });
    return { status: 'accepted', message };
  }

  ack(input: { streamId: string; chunkId: string; sequence: string }): void {
    this.assertLive(input.streamId);
    const first = this.pending[0];
    if (!first || first.key !== messageKey(input)) throw new WorkerProtocolError('ERR_WORKER_ACK_MISMATCH');
    this.pending.shift();
  }

  finish(): WorkerCompleteMessage {
    this.assertLive(this.streamId);
    if (this.pending.length > 0) throw new WorkerProtocolError('ERR_WORKER_ACK_PENDING');
    try {
      this.textBuffer += this.decoder.decode();
    } catch {
      return this.fail('ERR_INVALID_UTF8');
    }
    if (this.textBuffer.length > 0) {
      this.consumeLine(this.textBuffer.endsWith('\r') ? this.textBuffer.slice(0, -1) : this.textBuffer);
      this.textBuffer = '';
    }
    if (!this.footer) return this.fail('ERR_NDJSON_FOOTER');
    const expectedHash = orderedEventsHash(this.accepted);
    if (this.accepted.length !== this.header.declaredEventCount || this.footer.eventCount !== this.header.declaredEventCount || this.footer.eventCount !== this.accepted.length || this.footer.orderedEventsHash !== expectedHash) return this.fail('ERR_NDJSON_COUNT_HASH');
    this.terminal = {
      type: 'COMPLETE',
      streamId: this.streamId,
      receipt: {
        streamId: this.streamId,
        state: 'validated',
        rawChunkBytes: this.rawChunkBytes,
        declaredEventCount: this.header.declaredEventCount,
        validatedEventCount: this.accepted.length,
        rejectedEventCount: this.rejected.length,
        orderedWorkerBytesHash: hashCanonical(this.chunkHashes),
      },
    };
    return this.terminal;
  }

  cancel(): WorkerCompleteMessage {
    if (this.terminal) return this.terminal;
    this.pending.length = 0;
    this.textBuffer = '';
    this.terminal = {
      type: 'COMPLETE',
      streamId: this.streamId,
      receipt: {
        streamId: this.streamId,
        state: 'cancelled',
        rawChunkBytes: this.rawChunkBytes,
        declaredEventCount: this.header.declaredEventCount,
        validatedEventCount: this.accepted.length,
        rejectedEventCount: this.rejected.length,
      },
    };
    return this.terminal;
  }

  dispose(): void {
    this.disposed = true;
    this.pending.length = 0;
    this.accepted.length = 0;
    this.rejected.length = 0;
    this.chunkHashes.length = 0;
    this.textBuffer = '';
  }

  get retainedByteLength(): number {
    return this.pending.reduce((total, item) => total + item.retainedBytes, 0) + new TextEncoder().encode(this.textBuffer).byteLength;
  }

  get unackedCount(): number {
    return this.pending.length;
  }

  get candidates(): readonly ValidatedEventCandidate[] {
    return this.accepted;
  }

  private consumeCompleteLines(): void {
    while (true) {
      const newline = this.textBuffer.indexOf('\n');
      if (newline < 0) return;
      let line = this.textBuffer.slice(0, newline);
      this.textBuffer = this.textBuffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    if (line.length === 0) return;
    if (line.length > MAX_LINE_CODE_UNITS) throw new WorkerProtocolError('ERR_LINE_LIMIT');
    if (this.footer) throw new WorkerProtocolError('ERR_NDJSON_TRAILING_BYTES');
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new WorkerProtocolError('ERR_NDJSON_JSON');
    }
    if (!parsed || typeof parsed !== 'object') throw new WorkerProtocolError('ERR_NDJSON_SCHEMA');
    const value = parsed as Record<string, unknown>;
    if (value.lineType === 'header') throw new WorkerProtocolError('ERR_NDJSON_DUPLICATE_HEADER');
    if (value.lineType === 'footer') {
      if (!Number.isSafeInteger(value.eventCount) || typeof value.orderedEventsHash !== 'string') throw new WorkerProtocolError('ERR_NDJSON_FOOTER');
      this.footer = { eventCount: value.eventCount as number, orderedEventsHash: value.orderedEventsHash as Hash };
      return;
    }
    if (value.lineType !== 'event' || typeof value.sequence !== 'string' || !value.event || typeof value.event !== 'object') throw new WorkerProtocolError('ERR_NDJSON_SCHEMA');
    if (!/^(0|[1-9][0-9]*)$/.test(value.sequence) || BigInt(value.sequence) !== this.nextSequence) throw new WorkerProtocolError('ERR_NDJSON_SEQUENCE');
    const event = value.event as Record<string, unknown>;
    const validated = parseFixtureJson(JSON.stringify({
      schemaVersion: '1.0.0', fixtureId: 'worker-stream', adapterId: 'synthetic-fixture', adapterVersion: '1.0.0', events: [event],
    }));
    const accepted = validated.accepted[0];
    if (!accepted) {
      this.rejected.push({
        itemKey: typeof event.sourceItemKey === 'string' ? event.sourceItemKey : '$unknown',
        errorCode: validated.rejected[0]?.code ?? 'ERR_NDJSON_SCHEMA',
      });
    } else {
      this.accepted.push({ sequence: value.sequence, event: accepted as unknown as Record<string, unknown> });
    }
    this.nextSequence += 1n;
  }

  private fail(errorCode: string): WorkerCompleteMessage {
    if (this.terminal) return this.terminal;
    this.pending.length = 0;
    this.textBuffer = '';
    this.terminal = {
      type: 'COMPLETE',
      streamId: this.streamId,
      receipt: {
        streamId: this.streamId,
        state: 'failed',
        rawChunkBytes: this.rawChunkBytes,
        declaredEventCount: this.header.declaredEventCount,
        validatedEventCount: this.accepted.length,
        rejectedEventCount: this.rejected.length,
        errorCode,
      },
    };
    return this.terminal;
  }

  private assertLive(streamId: string): void {
    if (this.disposed) throw new WorkerProtocolError('ERR_WORKER_DISPOSED');
    if (streamId !== this.streamId) throw new WorkerProtocolError('ERR_WORKER_STREAM');
    if (this.terminal) throw new WorkerProtocolError('ERR_WORKER_TERMINAL');
  }
}

export function orderedEventsHash(events: readonly ValidatedEventCandidate[]): Hash {
  return hashCanonical(events.map(({ sequence, event }) => ({ sequence, event })));
}

export function hashRawBytes(bytes: Uint8Array): Hash {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return sha256(hex);
}

function messageKey(input: { streamId: string; chunkId: string; sequence: string }): string {
  return `${input.streamId}\u0000${input.chunkId}\u0000${input.sequence}`;
}

export interface DisposableReader { cancel(): void | Promise<void> }
export interface DisposableWorker { terminate(): void }

export class ImportStreamController {
  private readers = new Set<DisposableReader>();
  private workers = new Set<DisposableWorker>();
  private listeners = new Set<() => void>();
  private timers = new Set<number>();
  private objectUrls = new Set<string>();
  private buffers = new Set<ArrayBuffer>();
  private disposed = false;

  trackReader(value: DisposableReader): void { this.assertOpen(); this.readers.add(value); }
  trackWorker(value: DisposableWorker): void { this.assertOpen(); this.workers.add(value); }
  trackListener(remove: () => void): void { this.assertOpen(); this.listeners.add(remove); }
  trackTimer(value: number): void { this.assertOpen(); this.timers.add(value); }
  trackObjectUrl(value: string): void { this.assertOpen(); this.objectUrls.add(value); }
  trackBuffer(value: ArrayBuffer): void { this.assertOpen(); this.buffers.add(value); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readers.forEach((reader) => { void reader.cancel(); });
    this.workers.forEach((worker) => worker.terminate());
    this.listeners.forEach((remove) => remove());
    this.timers.forEach((timer) => clearTimeout(timer));
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.readers.clear();
    this.workers.clear();
    this.listeners.clear();
    this.timers.clear();
    this.objectUrls.clear();
    this.buffers.clear();
  }

  get resourceCount(): number {
    return this.readers.size + this.workers.size + this.listeners.size + this.timers.size + this.objectUrls.size + this.buffers.size;
  }

  private assertOpen(): void {
    if (this.disposed) throw new WorkerProtocolError('ERR_IMPORT_CONTROLLER_DISPOSED');
  }
}
