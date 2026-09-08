import { canonicalJson, hashCanonical, sha256 } from '../domain/canonical';
import type { Hash } from '../domain/types';
import { toStoredRecord, type StoredRecord } from './storageContracts';

export const TRACE_SCHEMA_VERSION = 'trace-event-v1' as const;
export const TRACE_RECORD_TYPE = 'trace_event_v1' as const;
export const TRACE_RETENTION_POLICY_ID = 'trace-local-v1' as const;
export const TRACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const TRACE_MAX_RECORDS = 2_048;
export const TRACE_MAX_BYTES = 1024 * 1024;
export const TRACE_MAX_MEMORY_RECORDS = 512;
export const TRACE_MANUAL_CASE_IDS = Object.freeze([
  'M1c.nvda',
  'M1c.visual',
  'M2.pilot',
  'M3.live-model',
  'M4.action-decision',
  'M5.native-smoke',
] as const);

export const TRACE_EVENT_NAMES = Object.freeze([
  'runtime.start',
  'runtime.snapshot',
  'runtime.preview',
  'runtime.commit',
  'runtime.import',
  'runtime.preview-bundled',
  'runtime.commit-bundled',
  'runtime.preview-readonly',
  'runtime.grant-consent',
  'runtime.revoke-consent',
  'runtime.shorten-retention',
  'runtime.expire-retention',
  'runtime.correction',
  'runtime.privacy',
  'runtime.replay',
  'runtime.evaluate-replay',
  'runtime.clear',
  'runtime.recover',
  'runtime.close',
  'runtime.background',
  'runtime.operation',
  'projection.rebuild',
  'projection.export',
  'projection.disable',
  'artifact.export',
  'manual.check',
  'pilot.step',
  'runtime.error',
] as const);

export type TraceEventName = typeof TRACE_EVENT_NAMES[number];
export type TraceLevel = 'info' | 'warn' | 'error';
export type TraceResultCode = 'OK' | 'PASS' | 'FAIL' | 'NOT_RUN' | 'SKIPPED' | `ERR_${string}`;

const TRACE_COUNT_KEYS = Object.freeze([
  'accepted', 'rejected', 'events', 'episodes', 'claims', 'evidence', 'corrections',
  'redactions', 'unknownSchema', 'conflicts', 'remnants', 'bytes',
] as const);
type TraceCountKey = typeof TRACE_COUNT_KEYS[number];

export type TraceCounts = Partial<Record<TraceCountKey, number>>;

export interface TraceManualCheck {
  readonly caseId: string;
  readonly stepId: string;
  readonly reviewerId: string;
  readonly result: 'PASS' | 'FAIL' | 'NOT_RUN';
  readonly artifactHashes: readonly Hash[];
}

export interface TraceEventPayload {
  readonly schemaVersion: typeof TRACE_SCHEMA_VERSION;
  readonly timestamp: string;
  readonly level: TraceLevel;
  readonly eventName: TraceEventName;
  readonly correlationId: string;
  readonly durationMs: number;
  readonly resultCode: TraceResultCode;
  readonly algorithmPins: readonly string[];
  readonly counts?: TraceCounts;
  readonly manualCheck?: TraceManualCheck;
}

export type TraceRecord = StoredRecord<TraceEventPayload>;

export interface TraceExportPreview {
  readonly schemaVersion: 'trace-export-v1';
  readonly sourceCursor: string;
  readonly privacyEpoch: number;
  readonly eventCount: number;
  readonly events: readonly TraceRecord[];
  readonly content: string;
  readonly contentHash: Hash;
  readonly filename: 'proagi-trace.json';
  readonly mediaType: 'application/json';
  readonly highestClassification: 'internal-diagnostics';
  readonly notice: 'LOCAL_FILE_CANNOT_BE_REMOTELY_REVOKED';
}

export function makeTraceExportPreview(input: { readonly sourceCursor: string; readonly privacyEpoch: number; readonly events: readonly TraceRecord[] }): TraceExportPreview {
  const envelope = {
    schemaVersion: 'trace-export-v1' as const,
    sourceCursor: input.sourceCursor,
    privacyEpoch: input.privacyEpoch,
    eventCount: input.events.length,
    events: input.events,
  };
  const content = `${canonicalJson(envelope)}\n`;
  return Object.freeze({
    ...envelope,
    events: Object.freeze([...input.events]),
    content,
    contentHash: sha256(content),
    filename: 'proagi-trace.json' as const,
    mediaType: 'application/json' as const,
    highestClassification: 'internal-diagnostics' as const,
    notice: 'LOCAL_FILE_CANNOT_BE_REMOTELY_REVOKED' as const,
  });
}

export interface TraceEventInput {
  readonly eventName: TraceEventName;
  readonly level?: TraceLevel;
  readonly correlationId: string;
  readonly resultCode: TraceResultCode;
  readonly durationMs?: number;
  readonly algorithmPins?: readonly string[];
  readonly counts?: TraceCounts;
  readonly manualCheck?: TraceManualCheck;
  readonly timestamp?: string;
}

export interface TraceSink {
  appendTraceEvents(events: readonly TraceRecord[]): Promise<void>;
}

const NOOP_TRACE_SINK: TraceSink = Object.freeze({ appendTraceEvents: async () => undefined });

export class TraceRecorder {
  private readonly traceId: string;
  private readonly clock: () => number;
  private readonly sink: TraceSink;
  private readonly maxEvents: number;
  private sequence = 0;
  private writeTail = Promise.resolve();
  private readonly records: TraceRecord[] = [];
  private pending: TraceRecord[] = [];

  constructor(sink: TraceSink = NOOP_TRACE_SINK, clock: () => number = Date.now, traceId: string = crypto.randomUUID(), maxEvents = TRACE_MAX_MEMORY_RECORDS) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(traceId)) throw new Error('ERR_TRACE_ID_INVALID');
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > TRACE_MAX_RECORDS) throw new Error('ERR_TRACE_CAPACITY_INVALID');
    this.traceId = traceId;
    this.clock = clock;
    this.sink = sink;
    this.maxEvents = maxEvents;
  }

  record(input: TraceEventInput): Promise<TraceRecord> {
    const record = this.makeRecord(input);
    this.writeTail = this.writeTail.then(async () => {
      this.records.push(record);
      while (this.records.length > this.maxEvents) this.records.shift();
      this.pending.push(record);
      while (this.pending.length > this.maxEvents) this.pending.shift();
      try {
        await this.sink.appendTraceEvents(this.pending);
        this.pending = [];
      } catch {
        // Diagnostics must never turn an otherwise valid Core operation into a failure.
      }
    }).catch(() => undefined);
    return this.writeTail.then(() => record);
  }

  recordManualCheck(input: TraceManualCheck & { readonly correlationId: string; readonly artifactHashes: readonly Hash[] }): Promise<TraceRecord> {
    return this.record({
      eventName: 'manual.check',
      correlationId: input.correlationId,
      resultCode: input.result,
      manualCheck: {
        caseId: input.caseId,
        stepId: input.stepId,
        reviewerId: input.reviewerId,
        result: input.result,
        artifactHashes: input.artifactHashes,
      },
    });
  }

  async flush(): Promise<void> {
    await this.writeTail;
    if (this.pending.length === 0) return;
    const pending = [...this.pending];
    try {
      await this.sink.appendTraceEvents(pending);
      this.pending = this.pending.filter((record) => !pending.some((item) => item.recordId === record.recordId));
    } catch {
      // A later application operation may retry the bounded pending queue.
    }
  }

  snapshot(): readonly TraceRecord[] {
    return this.records.slice();
  }

  private makeRecord(input: TraceEventInput): TraceRecord {
    assertTraceEventInput(input);
    const timestamp = input.timestamp ?? new Date(readClock(this.clock)).toISOString();
    const sequence = this.sequence++;
    const payload: TraceEventPayload = Object.freeze({
      schemaVersion: TRACE_SCHEMA_VERSION,
      timestamp,
      level: input.level ?? 'info',
      eventName: input.eventName,
      correlationId: input.correlationId,
      durationMs: input.durationMs ?? 0,
      resultCode: input.resultCode,
      algorithmPins: Object.freeze([...(input.algorithmPins ?? [])]),
      ...(input.counts ? { counts: Object.freeze({ ...input.counts }) } : {}),
      ...(input.manualCheck ? { manualCheck: Object.freeze({ ...input.manualCheck, artifactHashes: Object.freeze([...input.manualCheck.artifactHashes]) }) } : {}),
    });
    const writtenAt = timestamp;
    const expiresAt = new Date(Date.parse(timestamp) + TRACE_RETENTION_MS).toISOString();
    return toStoredRecord(
      `trace:${this.traceId}:${sequence.toString(36).padStart(8, '0')}`,
      TRACE_RECORD_TYPE,
      payload,
      writtenAt,
      { retentionClass: 'derived', retentionPolicyId: TRACE_RETENTION_POLICY_ID, expiresAt },
    );
  }
}

export function assertTraceRecord(record: StoredRecord): asserts record is TraceRecord {
  if (!record || record.recordType !== TRACE_RECORD_TYPE || typeof record.recordId !== 'string' || !/^trace:[A-Za-z0-9._:-]{1,128}:[0-9a-z]{8}$/.test(record.recordId)) throw new Error('ERR_TRACE_RECORD_INVALID');
  if (typeof record.writtenAt !== 'string' || !Number.isFinite(Date.parse(record.writtenAt))) throw new Error('ERR_TRACE_RECORD_INVALID');
  if (record.retentionPolicyId !== TRACE_RETENTION_POLICY_ID || record.retentionClass !== 'derived' || typeof record.expiresAt !== 'string' || !Number.isFinite(Date.parse(record.expiresAt))) throw new Error('ERR_TRACE_RECORD_INVALID');
  assertTracePayload(record.payload);
  const { contentHash, ...base } = record;
  if (typeof contentHash !== 'string' || hashCanonical(base) !== contentHash) throw new Error('ERR_TRACE_RECORD_HASH_INVALID');
}

export function assertTracePayload(value: unknown): asserts value is TraceEventPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ERR_TRACE_PAYLOAD_INVALID');
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'timestamp', 'level', 'eventName', 'correlationId', 'durationMs', 'resultCode', 'algorithmPins', 'counts', 'manualCheck']);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) throw new Error('ERR_TRACE_FIELD_FORBIDDEN');
  if (candidate.schemaVersion !== TRACE_SCHEMA_VERSION || typeof candidate.timestamp !== 'string' || !Number.isFinite(Date.parse(candidate.timestamp))) throw new Error('ERR_TRACE_PAYLOAD_INVALID');
  if (!['info', 'warn', 'error'].includes(String(candidate.level)) || !TRACE_EVENT_NAMES.includes(candidate.eventName as TraceEventName)) throw new Error('ERR_TRACE_PAYLOAD_INVALID');
  if (typeof candidate.correlationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(candidate.correlationId)) throw new Error('ERR_TRACE_PAYLOAD_INVALID');
  if (typeof candidate.durationMs !== 'number' || !Number.isSafeInteger(candidate.durationMs) || candidate.durationMs < 0 || candidate.durationMs > 86_400_000) throw new Error('ERR_TRACE_PAYLOAD_INVALID');
  if (typeof candidate.resultCode !== 'string' || !/^(?:OK|PASS|FAIL|NOT_RUN|SKIPPED|ERR_[A-Z0-9_]+)$/.test(candidate.resultCode)) throw new Error('ERR_TRACE_RESULT_INVALID');
  assertTokenArray(candidate.algorithmPins, 'ERR_TRACE_ALGORITHM_INVALID');
  if (candidate.counts !== undefined) assertTraceCounts(candidate.counts);
  if (candidate.manualCheck !== undefined) assertManualCheck(candidate.manualCheck);
  if (candidate.eventName === 'manual.check' && candidate.manualCheck === undefined) throw new Error('ERR_TRACE_MANUAL_MISSING');
  if (candidate.eventName !== 'manual.check' && candidate.manualCheck !== undefined) throw new Error('ERR_TRACE_MANUAL_SCOPE');
}

function assertTraceEventInput(input: TraceEventInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('ERR_TRACE_INPUT_INVALID');
  const allowed = new Set(['eventName', 'level', 'correlationId', 'resultCode', 'durationMs', 'algorithmPins', 'counts', 'manualCheck', 'timestamp']);
  if (Object.keys(input as object).some((key) => !allowed.has(key))) throw new Error('ERR_TRACE_FIELD_FORBIDDEN');
  const timestamp = input.timestamp ?? new Date(readClock(Date.now)).toISOString();
  assertTracePayload({
    schemaVersion: TRACE_SCHEMA_VERSION,
    timestamp,
    level: input.level ?? 'info',
    eventName: input.eventName,
    correlationId: input.correlationId,
    durationMs: input.durationMs ?? 0,
    resultCode: input.resultCode,
    algorithmPins: input.algorithmPins ?? [],
    ...(input.counts ? { counts: input.counts } : {}),
    ...(input.manualCheck ? { manualCheck: input.manualCheck } : {}),
  });
}

function assertTraceCounts(value: unknown): asserts value is TraceCounts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ERR_TRACE_COUNTS_INVALID');
  const keys = new Set<string>(TRACE_COUNT_KEYS);
  for (const [key, item] of Object.entries(value)) {
    if (!keys.has(key) || typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0 || item > 1_000_000_000) throw new Error('ERR_TRACE_COUNTS_INVALID');
  }
}

function assertManualCheck(value: unknown): asserts value is TraceManualCheck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ERR_TRACE_MANUAL_INVALID');
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !['caseId', 'stepId', 'reviewerId', 'result', 'artifactHashes'].includes(key))) throw new Error('ERR_TRACE_FIELD_FORBIDDEN');
  for (const key of ['caseId', 'stepId', 'reviewerId']) if (typeof candidate[key] !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(candidate[key] as string)) throw new Error('ERR_TRACE_MANUAL_INVALID');
  if (!TRACE_MANUAL_CASE_IDS.includes(candidate.caseId as typeof TRACE_MANUAL_CASE_IDS[number])) throw new Error('ERR_TRACE_MANUAL_CASE_UNKNOWN');
  if (!['PASS', 'FAIL', 'NOT_RUN'].includes(String(candidate.result))) throw new Error('ERR_TRACE_MANUAL_INVALID');
  if (!Array.isArray(candidate.artifactHashes) || candidate.artifactHashes.length > 32 || candidate.artifactHashes.some((hash) => typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash))) throw new Error('ERR_TRACE_MANUAL_INVALID');
}

function assertTokenArray(value: unknown, code: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(item))) throw new Error(code);
}

function readClock(clock: () => number): number {
  try {
    const value = clock();
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}
