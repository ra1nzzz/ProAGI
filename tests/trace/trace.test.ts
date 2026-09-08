import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDbM1bAdapter } from '../../src/adapters/indexedDbM1b';
import { hashCanonical } from '../../src/domain/canonical';
import { createBrowserInsightRuntime } from '../../src/application/browserRuntimeComposition';
import type { BrowserInsightRuntime } from '../../src/application/browserInsightRuntime';
import {
  TRACE_RECORD_TYPE,
  TraceRecorder,
  assertTracePayload,
  type TraceRecord,
} from '../../src/application/trace';

const adapters: IndexedDbM1bAdapter[] = [];
const runtimes: BrowserInsightRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(adapters.splice(0).map((adapter) => adapter.destroy()));
});

describe('local TRACE diagnostics', () => {
  it('persists an allowlisted event with a stable authenticated record', async () => {
    const events: TraceRecord[] = [];
    const recorder = new TraceRecorder({ appendTraceEvents: async (batch) => { events.push(...batch); } }, () => Date.parse('2026-09-08T00:00:00.000Z'), 'trace-test');
    const record = await recorder.record({
      eventName: 'runtime.commit', correlationId: 'corr-1', resultCode: 'OK', durationMs: 12,
      counts: { accepted: 2, claims: 1 }, algorithmPins: ['insight-loop-v1'],
    });

    expect(record.recordType).toBe(TRACE_RECORD_TYPE);
    expect(events).toEqual([record]);
    expect(record.payload).not.toHaveProperty('input');
    expect(record.payload).not.toHaveProperty('path');
    const { contentHash, ...base } = record;
    expect(contentHash).toBe(hashCanonical(base));
  });

  it('rejects dynamic or sensitive fields before they can enter the sink', () => {
    expect(() => assertTracePayload({
      schemaVersion: 'trace-event-v1', timestamp: '2026-09-08T00:00:00.000Z', level: 'info',
      eventName: 'runtime.operation', correlationId: 'corr-1', durationMs: 0, resultCode: 'OK',
      algorithmPins: [], message: 'user text',
    })).toThrow('ERR_TRACE_FIELD_FORBIDDEN');
    expect(() => assertTracePayload({
      schemaVersion: 'trace-event-v1', timestamp: '2026-09-08T00:00:00.000Z', level: 'info',
      eventName: 'runtime.operation', correlationId: 'corr-1', durationMs: 0, resultCode: 'OK',
      algorithmPins: [], counts: { dynamicKey: 1 },
    })).toThrow('ERR_TRACE_COUNTS_INVALID');
  });

  it('records manual evidence as metadata and keeps sink failures non-fatal', async () => {
    const recorder = new TraceRecorder({ appendTraceEvents: async () => { throw new Error('sink unavailable'); } }, () => Date.parse('2026-09-08T00:00:00.000Z'), 'manual-test');
    const record = await recorder.recordManualCheck({
      caseId: 'M1c.visual', stepId: 'logs-redacted', reviewerId: 'reviewer-1', result: 'PASS',
      correlationId: 'corr-2', artifactHashes: ['sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    });
    expect(record.payload.manualCheck).toEqual({
      caseId: 'M1c.visual', stepId: 'logs-redacted', reviewerId: 'reviewer-1', result: 'PASS',
      artifactHashes: ['sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    });
    await expect(recorder.flush()).resolves.toBeUndefined();
    expect(recorder.snapshot()).toHaveLength(1);
  });

  it('rejects manual checks outside the pre-registered case set', () => {
    const recorder = new TraceRecorder(undefined, () => Date.parse('2026-09-08T00:00:00.000Z'), 'manual-case');
    expect(() => recorder.recordManualCheck({
      caseId: 'unregistered-case', stepId: 'step', reviewerId: 'reviewer-1', result: 'NOT_RUN',
      correlationId: 'corr-unknown', artifactHashes: [],
    })).toThrow('ERR_TRACE_MANUAL_CASE_UNKNOWN');
  });

  it('stores TRACE in the existing audit store with TTL and byte/count boundaries', async () => {
    const adapter = new IndexedDbM1bAdapter(`trace-store-${crypto.randomUUID()}`);
    adapters.push(adapter);
    const recorder = new TraceRecorder(adapter, () => Date.parse('2026-09-08T00:00:00.000Z'), 'idb-test', 8);
    await recorder.record({ eventName: 'runtime.start', correlationId: 'corr-3', resultCode: 'OK' });
    await recorder.flush();
    const audit = await adapter.getAll<TraceRecord>('audit');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.recordType).toBe(TRACE_RECORD_TYPE);
    expect((await adapter.getAll('business')).length).toBe(0);
  });

  it('automatically records runtime operations without exposing their inputs', async () => {
    const adapter = new IndexedDbM1bAdapter(`trace-runtime-${crypto.randomUUID()}`);
    adapters.push(adapter);
    const runtime = createBrowserInsightRuntime({ adapterFactory: () => adapter, channelFactory: () => null });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.preview();
    const trace = await adapter.getAll<TraceRecord>('audit');
    expect(trace.map((record) => record.payload.eventName)).toEqual(expect.arrayContaining(['runtime.start', 'runtime.preview']));
    expect(JSON.stringify(trace)).not.toContain('developer-day-bundled-v1');
    expect(JSON.stringify(trace)).not.toContain('sourceItemKey');
  });

  it('exports the explicitly prepared snapshot when later diagnostics arrive', async () => {
    const adapter = new IndexedDbM1bAdapter(`trace-export-${crypto.randomUUID()}`);
    adapters.push(adapter);
    const runtime = createBrowserInsightRuntime({ adapterFactory: () => adapter, channelFactory: () => null });
    runtimes.push(runtime);
    await runtime.start();
    const preview = await runtime.prepareTraceExport();
    await runtime.snapshot();
    const exported = await runtime.exportTrace({ confirmedHash: preview.contentHash, acknowledgeIrrevocable: true });
    expect(exported.contentHash).toBe(preview.contentHash);
    expect(exported.content).toBe(preview.content);
    expect((await runtime.getTraceEvents()).length).toBeGreaterThan(preview.eventCount);
  });

  it('invalidates a pending export when privacy epoch changes', async () => {
    const adapter = new IndexedDbM1bAdapter(`trace-private-${crypto.randomUUID()}`);
    adapters.push(adapter);
    const runtime = createBrowserInsightRuntime({ adapterFactory: () => adapter, channelFactory: () => null });
    runtimes.push(runtime);
    await runtime.start();
    const preview = await runtime.prepareTraceExport();
    await runtime.pausePrivacy();
    await expect(runtime.exportTrace({ confirmedHash: preview.contentHash, acknowledgeIrrevocable: true })).rejects.toThrow('ERR_EXPORT_PREVIEW_REQUIRED');
  });
});
