import { describe, expect, it, vi } from 'vitest';
import { ImportStreamController, NdjsonWorkerProtocol, orderedEventsHash, type NdjsonHeader, type ValidatedEventCandidate } from '../../src/workers/ndjsonProtocol';
import { installNdjsonWorker, type NdjsonWorkerInput, type WorkerMessageScope } from '../../src/workers/ndjson.worker';

const header: NdjsonHeader = {
  lineType: 'header',
  format: 'proagi-behavior-events',
  formatVersion: '1',
  schemaVersion: '1.0.0',
  inputIdentity: { kind: 'fixture', fixtureId: 'worker' },
  declaredEventCount: 1,
};

function candidate(label = '项目'): ValidatedEventCandidate {
  return {
    sequence: '0',
    event: {
      sourceItemKey: `item-${label}`,
      occurredAt: '2025-01-01T00:00:00.000Z',
      kind: 'app.focus',
      subject: { appId: 'vscode' },
      attributes: { projectKey: label },
    },
  };
}

function streamBytes(value = candidate()): Uint8Array {
  const event = JSON.stringify({ lineType: 'event', ...value });
  const footer = JSON.stringify({ lineType: 'footer', eventCount: 1, orderedEventsHash: orderedEventsHash([value]) });
  return new TextEncoder().encode(`${event}\r\n${footer}`);
}

describe('raw byte NDJSON worker protocol', () => {
  it('fatal-decodes a multibyte code point split at every arbitrary byte boundary', () => {
    const bytes = streamBytes();
    const protocol = new NdjsonWorkerProtocol('stream-split', header, 262_144, 2);
    for (let index = 0; index < bytes.length; index += 1) {
      const result = protocol.pushChunk({ streamId: 'stream-split', chunkId: `chunk-${index}`, sequence: String(index), bytes: bytes.slice(index, index + 1) });
      expect(result.status).toBe('accepted');
      protocol.ack({ streamId: 'stream-split', chunkId: `chunk-${index}`, sequence: String(index) });
    }
    const complete = protocol.finish();
    expect(complete.receipt).toMatchObject({ state: 'validated', declaredEventCount: 1, validatedEventCount: 1, rejectedEventCount: 0, rawChunkBytes: bytes.length });
    expect(protocol.candidates[0]?.event.attributes).toEqual({ projectKey: '项目' });
  });

  it('rejects invalid and truncated UTF-8 without replacement characters', () => {
    const invalid = new NdjsonWorkerProtocol('invalid', { ...header, declaredEventCount: 0 });
    expect(() => invalid.pushChunk({ streamId: 'invalid', chunkId: 'bad', sequence: '0', bytes: new Uint8Array([0xc3, 0x28]) })).toThrowError(expect.objectContaining({ code: 'ERR_INVALID_UTF8' }));

    const truncated = new NdjsonWorkerProtocol('truncated', { ...header, declaredEventCount: 0 });
    const pushed = truncated.pushChunk({ streamId: 'truncated', chunkId: 'partial', sequence: '0', bytes: new Uint8Array([0xf0, 0x9f, 0x99]) });
    expect(pushed.status).toBe('accepted');
    truncated.ack({ streamId: 'truncated', chunkId: 'partial', sequence: '0' });
    expect(truncated.finish().receipt).toMatchObject({ state: 'failed', errorCode: 'ERR_INVALID_UTF8' });
  });

  it('holds a hard two-message backpressure window and validates exact ACK identity', () => {
    const protocol = new NdjsonWorkerProtocol('pressure', { ...header, declaredEventCount: 0 });
    const first = protocol.pushChunk({ streamId: 'pressure', chunkId: 'one', sequence: '0', bytes: new TextEncoder().encode('\n') });
    const second = protocol.pushChunk({ streamId: 'pressure', chunkId: 'two', sequence: '1', bytes: new TextEncoder().encode('\n') });
    expect(first.status).toBe('accepted');
    expect(second.status).toBe('accepted');
    const retained = protocol.retainedByteLength;
    expect(protocol.pushChunk({ streamId: 'pressure', chunkId: 'three', sequence: '2', bytes: new TextEncoder().encode('not-consumed') })).toEqual({ status: 'backpressure', retainedByteLength: retained });
    expect(() => protocol.ack({ streamId: 'pressure', chunkId: 'two', sequence: '1' })).toThrowError(expect.objectContaining({ code: 'ERR_WORKER_ACK_MISMATCH' }));
    protocol.ack({ streamId: 'pressure', chunkId: 'one', sequence: '0' });
    expect(protocol.pushChunk({ streamId: 'pressure', chunkId: 'three', sequence: '2', bytes: new TextEncoder().encode('\n') }).status).toBe('accepted');
  });

  it('cancels once, releases pending bytes, and refuses late chunks', () => {
    const protocol = new NdjsonWorkerProtocol('cancel', { ...header, declaredEventCount: 0 });
    protocol.pushChunk({ streamId: 'cancel', chunkId: 'one', sequence: '0', bytes: new TextEncoder().encode('partial') });
    const first = protocol.cancel();
    const second = protocol.cancel();
    expect(first).toBe(second);
    expect(first.receipt.state).toBe('cancelled');
    expect(protocol.retainedByteLength).toBe(0);
    expect(() => protocol.pushChunk({ streamId: 'cancel', chunkId: 'late', sequence: '1', bytes: new Uint8Array() })).toThrowError(expect.objectContaining({ code: 'ERR_WORKER_TERMINAL' }));
  });

  it('rejects excessive declared counts and an overlong unterminated line', () => {
    expect(() => new NdjsonWorkerProtocol('too-many', { ...header, declaredEventCount: 50_001 }))
      .toThrowError(expect.objectContaining({ code: 'ERR_NDJSON_COUNT' }));
    const protocol = new NdjsonWorkerProtocol('long-line', header);
    for (let index = 0; index < 4; index += 1) {
      const result = protocol.pushChunk({ streamId: 'long-line', chunkId: `part-${index}`, sequence: String(index), bytes: new Uint8Array(262_144).fill(97) });
      expect(result.status).toBe('accepted');
      protocol.ack({ streamId: 'long-line', chunkId: `part-${index}`, sequence: String(index) });
    }
    expect(() => protocol.pushChunk({ streamId: 'long-line', chunkId: 'overflow', sequence: '4', bytes: new Uint8Array([97]) }))
      .toThrowError(expect.objectContaining({ code: 'ERR_LINE_LIMIT' }));
  });

  it('preserves protocol error codes and transfers a backpressured chunk back to its owner', () => {
    const posted: Array<{ message: unknown; transfer?: Transferable[] }> = [];
    const scope: WorkerMessageScope = {
      onmessage: null,
      postMessage: (message, transfer) => { posted.push({ message, transfer }); },
    };
    const dispose = installNdjsonWorker(scope);
    const send = (data: NdjsonWorkerInput) => scope.onmessage?.({ data } as MessageEvent<NdjsonWorkerInput>);
    send({ type: 'INIT', streamId: 'boundary', header: { ...header, declaredEventCount: 0 }, maxChunkBytes: 262_144, maxUnacked: 2 });
    send({ type: 'CHUNK', streamId: 'boundary', chunkId: 'one', sequence: '0', bytes: new TextEncoder().encode('\n').buffer, byteLength: 1 });
    send({ type: 'CHUNK', streamId: 'boundary', chunkId: 'two', sequence: '1', bytes: new TextEncoder().encode('\n').buffer, byteLength: 1 });
    const returned = new TextEncoder().encode('retry-me').buffer;
    send({ type: 'CHUNK', streamId: 'boundary', chunkId: 'three', sequence: '2', bytes: returned, byteLength: returned.byteLength });
    expect(posted.at(-1)?.message).toMatchObject({ status: 'backpressure', chunkId: 'three', bytes: returned });
    expect(posted.at(-1)?.transfer).toEqual([returned]);
    dispose();

    const errors: unknown[] = [];
    const errorScope: WorkerMessageScope = { onmessage: null, postMessage: (message) => { errors.push(message); } };
    installNdjsonWorker(errorScope);
    errorScope.onmessage?.({ data: { type: 'INIT', streamId: 'errors', header: { ...header, declaredEventCount: 0 }, maxChunkBytes: 262_144, maxUnacked: 2 } } as MessageEvent<NdjsonWorkerInput>);
    errorScope.onmessage?.({ data: { type: 'CHUNK', streamId: 'errors', chunkId: 'bad', sequence: '0', bytes: new Uint8Array([0xc3, 0x28]).buffer, byteLength: 2 } } as MessageEvent<NdjsonWorkerInput>);
    expect(errors.at(-1)).toMatchObject({ type: 'ERROR', errorCode: 'ERR_INVALID_UTF8' });
  });

  it('disposes every tracked import resource idempotently', () => {
    const controller = new ImportStreamController();
    const cancel = vi.fn();
    const terminate = vi.fn();
    const remove = vi.fn();
    controller.trackReader({ cancel });
    controller.trackWorker({ terminate });
    controller.trackListener(remove);
    controller.trackBuffer(new ArrayBuffer(8));
    expect(controller.resourceCount).toBe(4);
    controller.dispose();
    controller.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(controller.resourceCount).toBe(0);
  });
});
