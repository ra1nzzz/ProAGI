import { z } from 'zod';
import { hashCanonical, sha256, semanticId } from './canonical';
import type { BehaviorEvent, EventAttributes, FixtureEventInput, Hash } from './types';

export const READONLY_ADAPTER_ID = 'readonly-test-results';
export const READONLY_ADAPTER_VERSION = '1.0.0';
export const READONLY_POLICY_VERSION = 'readonly-test-results-v1';

const safeToken = z.string().min(1).max(80).regex(/^[\p{L}\p{N}._-]+$/u);
const eventKind = z.enum(['app.focus', 'file.changed', 'terminal.completed', 'git.changed', 'test.completed']);
const appId = z.enum(['vscode', 'cursor', 'terminal', 'browser', 'git', 'other']);
const hash = z.custom<Hash>((value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value));
const attributes = z.object({
  projectKey: safeToken.optional(), appId: appId.optional(), fileExt: z.string().min(1).max(12).regex(/^[A-Za-z0-9]+$/).optional(),
  operation: z.enum(['open', 'modify', 'create', 'rename']).optional(), commandClass: z.enum(['build', 'test', 'lint', 'git', 'package', 'other']).optional(),
  exitCode: z.number().int().min(-255).max(255).optional(), branchHash: hash.optional(),
  testOutcome: z.enum(['passed', 'failed', 'skipped']).optional(), durationMs: z.number().int().min(0).max(86_400_000).optional(),
}).strict();
const event = z.object({
  sourceItemKey: safeToken,
  occurredAt: z.string().min(1),
  kind: eventKind,
  subject: z.object({ appId, projectKey: safeToken.optional() }).strict(),
  attributes,
}).strict();

export type ReadonlyNoiseCode = 'drop' | 'duplicate' | 'reorder' | 'clock-skew' | 'schema-drift' | 'locale-timezone';

export interface ReadonlyDiagnostic {
  readonly code: ReadonlyNoiseCode;
  readonly count: number;
  readonly itemKeys: readonly string[];
}

export interface ReadonlyEventCandidate extends FixtureEventInput {
  readonly redactionCount: number;
}

export interface ReadonlyParseResult {
  readonly sourceItemKey: string;
  readonly capturedAt: string;
  readonly timezone: string;
  readonly locale: string;
  readonly accepted: readonly ReadonlyEventCandidate[];
  readonly rejected: readonly { readonly itemKey: string; readonly code: 'ERR_SCHEMA_INVALID' | 'ERR_UNKNOWN_FIELD' | 'ERR_CLOCK_SKEW' | 'ERR_DUPLICATE_CONFLICT'; readonly fieldPath: string }[];
  readonly diagnostics: readonly ReadonlyDiagnostic[];
}

export interface ReadonlyMaterializationOptions {
  readonly consentId: string;
  readonly purpose: string;
  readonly policyVersion: string;
  readonly sourceItemKey: string;
  readonly projectKey?: string;
}

export interface ReadonlyInputOptions {
  readonly sourceItemKey: string;
  readonly capturedAt?: string;
  readonly timezone?: string;
  readonly locale?: string;
  readonly projectKey?: string;
}

const DEFAULT_CAPTURED_AT = '1970-01-01T00:00:00.000Z';

export function parseReadonlyInput(utf8: string, options: ReadonlyInputOptions): ReadonlyParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(utf8) as unknown;
  } catch {
    throw new Error('ERR_SCHEMA_INVALID');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ERR_SCHEMA_INVALID');
  const root = raw as Record<string, unknown>;
  const capturedAt = normalizeTimestamp(root.capturedAt) ?? normalizeTimestamp(options.capturedAt) ?? DEFAULT_CAPTURED_AT;
  const timezone = typeof root.timezone === 'string' && root.timezone.length <= 80 ? root.timezone : options.timezone ?? 'UTC';
  const locale = typeof root.locale === 'string' && root.locale.length <= 32 ? root.locale : options.locale ?? 'zh-CN';
  const projectKey = safeToken.safeParse(root.projectAlias).success ? String(root.projectAlias) : options.projectKey;
  const rawItems: Array<{ item: unknown; index: number; redactionCount?: number }> = Array.isArray(root.events)
    ? root.events.map((item, index) => ({ item, index, redactionCount: 0 })) : flattenPlaywrightResults(root);
  if (rawItems.length === 0) throw new Error('ERR_SCHEMA_INVALID');

  const accepted: ReadonlyEventCandidate[] = [];
  const rejected: ReadonlyParseResult['rejected'][number][] = [];
  const diagnostics = new Map<ReadonlyNoiseCode, { count: number; itemKeys: string[] }>();
  const byKey = new Map<string, ReadonlyEventCandidate>();
  let previousTime = '';
  for (const { item, index, redactionCount = 0 } of rawItems) {
    const itemKey = itemKeyFor(item, index);
    const candidate = normalizeCandidate(item, projectKey, redactionCount);
    if (!candidate) {
      const drift = hasUnknownEventField(item);
      rejected.push({ itemKey, code: drift ? 'ERR_UNKNOWN_FIELD' : 'ERR_SCHEMA_INVALID', fieldPath: drift ? '$unknown' : '$' });
      addDiagnostic(diagnostics, drift ? 'schema-drift' : 'drop', itemKey);
      continue;
    }
    const normalizedAt = normalizeTimestamp(candidate.occurredAt);
    if (!normalizedAt) {
      rejected.push({ itemKey, code: 'ERR_SCHEMA_INVALID', fieldPath: '/occurredAt' });
      addDiagnostic(diagnostics, 'schema-drift', itemKey);
      continue;
    }
    if (normalizedAt > new Date(Date.parse(capturedAt) + 5 * 60_000).toISOString()) {
      rejected.push({ itemKey, code: 'ERR_CLOCK_SKEW', fieldPath: '/occurredAt' });
      addDiagnostic(diagnostics, 'clock-skew', itemKey);
      continue;
    }
    const normalized: ReadonlyEventCandidate = Object.freeze({ ...candidate, occurredAt: normalizedAt, sourceItemKey: itemKey });
    if (previousTime && normalizedAt < previousTime) addDiagnostic(diagnostics, 'reorder', itemKey);
    previousTime = normalizedAt;
    const previous = byKey.get(itemKey);
    if (previous) {
      if (hashCanonical(previous) !== hashCanonical(normalized)) {
        rejected.push({ itemKey, code: 'ERR_DUPLICATE_CONFLICT', fieldPath: '/sourceItemKey' });
        addDiagnostic(diagnostics, 'duplicate', itemKey);
      } else {
        addDiagnostic(diagnostics, 'duplicate', itemKey);
      }
      continue;
    }
    byKey.set(itemKey, normalized);
    accepted.push(normalized);
  }
  if (timezone !== 'UTC' || locale !== 'en-US') addDiagnostic(diagnostics, 'locale-timezone', options.sourceItemKey);
  accepted.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.sourceItemKey.localeCompare(b.sourceItemKey));
  return Object.freeze({
    sourceItemKey: options.sourceItemKey,
    capturedAt,
    timezone,
    locale,
    accepted,
    rejected,
    diagnostics: [...diagnostics.entries()].map(([code, value]) => ({ code, count: value.count, itemKeys: [...value.itemKeys] })),
  });
}

export function materializeReadonlyBehaviorEvents(parsed: ReadonlyParseResult, options: ReadonlyMaterializationOptions): readonly BehaviorEvent[] {
  return parsed.accepted.map((input) => {
    const { redactionCount, ...candidate } = input;
    const source = {
      kind: 'readonly-adapter' as const,
      sourceItemKey: options.sourceItemKey,
      adapterId: READONLY_ADAPTER_ID,
      adapterVersion: READONLY_ADAPTER_VERSION,
      consentId: options.consentId,
      policyVersion: options.policyVersion,
      purpose: options.purpose,
    };
    const dedupeKey = hashCanonical({ source, sourceItemKey: input.sourceItemKey });
    const factHash = hashCanonical({ occurredAt: input.occurredAt, kind: input.kind, subject: input.subject, attributes: input.attributes });
    const privacy = { classification: 'local-sensitive' as const, policyVersion: options.policyVersion, redactionCount };
    const semantic = { schemaVersion: '1.0.0' as const, ...candidate, source, privacy, dedupeKey, factHash, provenanceHash: hashCanonical({ dedupeKey, factHash, source, privacy }) };
    return Object.freeze({ ...semantic, id: semanticId('behavior-event-v1', { dedupeKey, factHash, consentId: options.consentId }), contentHash: hashCanonical(semantic) });
  });
}

function normalizeCandidate(value: unknown, projectKey: string | undefined, redactionCount: number): ReadonlyEventCandidate | undefined {
  const parsed = event.safeParse(value);
  if (!parsed.success) return undefined;
  const input = parsed.data;
  const subject = projectKey && !input.subject.projectKey ? { ...input.subject, projectKey } : input.subject;
  const nextAttributes: EventAttributes = { ...input.attributes, ...(projectKey && !input.attributes.projectKey ? { projectKey } : {}) };
  return { ...input, subject, attributes: nextAttributes, redactionCount };
}

function flattenPlaywrightResults(root: Record<string, unknown>): Array<{ item: unknown; index: number; redactionCount: number }> {
  const suites = Array.isArray(root.suites) ? root.suites : [];
  const items: Array<{ item: unknown; index: number; redactionCount: number }> = [];
  let index = 0;
  const visit = (suite: unknown, parents: string[]): void => {
    if (!suite || typeof suite !== 'object' || Array.isArray(suite)) return;
    const value = suite as Record<string, unknown>;
    const title = typeof value.title === 'string' ? value.title : 'suite';
    const specs = Array.isArray(value.specs) ? value.specs : [];
    for (const spec of specs) {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
      const specValue = spec as Record<string, unknown>;
      const specTitle = typeof specValue.title === 'string' ? specValue.title : 'test';
      const tests = Array.isArray(specValue.tests) ? specValue.tests : [];
      for (const test of tests) {
        if (!test || typeof test !== 'object' || Array.isArray(test)) continue;
        const testValue = test as Record<string, unknown>;
        const projectName = typeof testValue.projectName === 'string' ? testValue.projectName : 'default';
        const results = Array.isArray(testValue.results) ? testValue.results : [];
        const result = results.at(-1);
        const resultValue = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
        const status = typeof resultValue.status === 'string' ? resultValue.status : typeof specValue.ok === 'boolean' ? specValue.ok ? 'passed' : 'failed' : 'skipped';
        const mappedStatus = status === 'passed' ? 'passed' : status === 'skipped' || status === 'interrupted' ? 'skipped' : 'failed';
        const startTime = normalizeTimestamp(resultValue.startTime) ?? normalizeTimestamp(root.startedAt) ?? DEFAULT_CAPTURED_AT;
        const duration = typeof resultValue.duration === 'number' && Number.isFinite(resultValue.duration) ? Math.max(0, Math.min(86_400_000, Math.round(resultValue.duration))) : undefined;
        items.push({
          index: index++, redactionCount: ['error', 'errors', 'stdout', 'stderr', 'attachments'].filter((key) => key in resultValue).length,
          item: {
            sourceItemKey: `test-${sha256(`${projectName}:${parents.concat(title, specTitle).join('/')}`).slice(7, 23)}`,
            occurredAt: startTime,
            kind: 'test.completed' as const,
            subject: { appId: 'terminal' as const },
            attributes: { appId: 'terminal' as const, commandClass: 'test' as const, testOutcome: mappedStatus, ...(duration === undefined ? {} : { durationMs: duration }) },
          },
        });
      }
    }
    for (const child of Array.isArray(value.suites) ? value.suites : []) visit(child, parents.concat(title));
  };
  suites.forEach((suite) => visit(suite, []));
  return items;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function itemKeyFor(value: unknown, index: number): string {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).sourceItemKey === 'string') {
    const sourceItemKey = (value as Record<string, unknown>).sourceItemKey as string;
    if (safeToken.safeParse(sourceItemKey).success) return sourceItemKey;
  }
  return `item-${index + 1}`;
}

function hasUnknownEventField(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).some((key) => !['sourceItemKey', 'occurredAt', 'kind', 'subject', 'attributes'].includes(key));
}

function addDiagnostic(diagnostics: Map<ReadonlyNoiseCode, { count: number; itemKeys: string[] }>, code: ReadonlyNoiseCode, itemKey: string): void {
  const current = diagnostics.get(code) ?? { count: 0, itemKeys: [] };
  current.count += 1;
  if (current.itemKeys.length < 20) current.itemKeys.push(itemKey);
  diagnostics.set(code, current);
}
