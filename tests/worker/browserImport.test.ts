import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrowserInsightRuntime } from '../../src/application/browserRuntimeComposition';
import { IndexedDbM1bAdapter } from '../../src/adapters/indexedDbM1b';
import { installNdjsonWorker, type NdjsonWorkerInput, type WorkerMessageScope } from '../../src/workers/ndjson.worker';
import { orderedEventsHash, type ValidatedEventCandidate } from '../../src/workers/ndjsonProtocol';
import type { BrowserInsightRuntime } from '../../src/application/browserInsightRuntime';

const runtimes: BrowserInsightRuntime[] = [];

class InlineWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private readonly scope: WorkerMessageScope;
  private readonly disposeWorker: () => void;

  constructor() {
    this.scope = {
      onmessage: null,
      postMessage: (message) => queueMicrotask(() => this.onmessage?.({ data: message } as MessageEvent<unknown>)),
    };
    this.disposeWorker = installNdjsonWorker(this.scope);
  }

  postMessage(message: NdjsonWorkerInput): void {
    queueMicrotask(() => this.scope.onmessage?.({ data: message } as MessageEvent<NdjsonWorkerInput>));
  }

  terminate(): void { this.disposeWorker(); }
}

function ndjsonStream(): ReadableStream<Uint8Array> {
  const events: ValidatedEventCandidate[] = [{
    sequence: '0',
    event: {
      sourceItemKey: 'user-file-event',
      occurredAt: '2026-01-02T09:12:00.000Z',
      kind: 'app.focus',
      subject: { appId: 'vscode', projectKey: 'proagi' },
      attributes: { appId: 'vscode', projectKey: 'proagi' },
    },
  }];
  const header = {
    lineType: 'header' as const,
    format: 'proagi-behavior-events' as const,
    formatVersion: '1' as const,
    schemaVersion: '1.0.0',
    inputIdentity: { kind: 'json-import' as const, importBatchId: crypto.randomUUID(), inputHash: orderedEventsHash(events) },
    declaredEventCount: events.length,
  };
  const text = [
    JSON.stringify(header),
    ...events.map((event) => JSON.stringify({ lineType: 'event', ...event })),
    JSON.stringify({ lineType: 'footer', eventCount: events.length, orderedEventsHash: orderedEventsHash(events) }),
  ].join('\r\n');
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start: (streamController) => { streamController.enqueue(bytes); streamController.close(); } });
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe('browser NDJSON import path', () => {
  it('keeps user-file data unpublished until confirmation and records import TRACE', async () => {
    const adapter = new IndexedDbM1bAdapter(`worker-import-${crypto.randomUUID()}`);
    const runtime = createBrowserInsightRuntime({
      adapterFactory: () => adapter,
      channelFactory: () => null,
      workerFactory: () => new InlineWorker() as unknown as Worker,
    });
    runtimes.push(runtime);

    const preview = await runtime.previewNdjson(ndjsonStream());
    expect(preview).toMatchObject({ source: 'json-import', acceptedCount: 1, inputIdentity: { kind: 'json-import' } });
    expect(await adapter.scanPublishedBusiness()).toEqual([]);
    expect((await adapter.getAll<{ recordType: string }>('system')).some((record) => record.recordType === 'import_session')).toBe(false);

    const committed = await runtime.commit(preview.token);
    expect(committed).toMatchObject({ source: 'json-import', acceptedCount: 1 });
    expect(await adapter.scanPublishedBusiness()).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: 'behavior_event_v1', payload: expect.objectContaining({ source: expect.objectContaining({ kind: 'json-import' }) }) }),
    ]));
    expect(await adapter.getAll<{ recordType: string; state?: string }>('system')).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: 'import_session', state: 'PUBLISHED' }),
    ]));
    const trace = await runtime.getTraceEvents();
    expect(trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ eventName: 'runtime.worker', resultCode: 'OK' }) }),
      expect.objectContaining({ payload: expect.objectContaining({ eventName: 'runtime.import', resultCode: 'OK' }) }),
    ]));
  });
});
