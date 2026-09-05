import { z } from 'zod';
import { canonicalJson, hashCanonical, semanticId } from './canonical';
import type { BehaviorEvent, FixtureEventInput, FixtureInput, Hash } from './types';

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const timestamp = z.string().regex(timestampPattern).refine((value) => {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return false;
  const normalized = value.includes('.')
    ? value.replace(/\.(\d{1,3})Z$/, (_, fraction: string) => `.${fraction.padEnd(3, '0')}Z`)
    : value.replace(/Z$/, '.000Z');
  return new Date(instant).toISOString() === normalized;
}, { message: 'invalid UTC instant' });
const safeToken = z.string().min(1).max(80).regex(/^[\p{L}\p{N}._-]+$/u);
const appId = z.enum(['vscode', 'cursor', 'terminal', 'browser', 'git', 'other']);
const eventKind = z.enum(['app.focus', 'file.changed', 'terminal.completed', 'git.changed', 'test.completed']);
const hash = z.custom<Hash>((value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value));

const attributesSchema = z.object({
  projectKey: safeToken.optional(),
  appId: appId.optional(),
  fileExt: z.string().min(1).max(12).regex(/^[A-Za-z0-9]+$/).optional(),
  operation: z.enum(['open', 'modify', 'create', 'rename']).optional(),
  commandClass: z.enum(['build', 'test', 'lint', 'git', 'package', 'other']).optional(),
  exitCode: z.number().int().min(-255).max(255).optional(),
  branchHash: hash.optional(),
  testOutcome: z.enum(['passed', 'failed', 'skipped']).optional(),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
}).strict();

const eventSchema = z.object({
  sourceItemKey: safeToken,
  occurredAt: timestamp,
  kind: eventKind,
  subject: z.object({ appId, projectKey: safeToken.optional() }).strict(),
  attributes: attributesSchema,
}).strict();

const envelopeSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  fixtureId: safeToken,
  adapterId: z.literal('synthetic-fixture'),
  adapterVersion: z.literal('1.0.0'),
  events: z.array(z.unknown()).max(10_000),
}).strict();

export interface FixtureItemRejection {
  readonly itemKey: string;
  readonly code: 'ERR_SCHEMA_INVALID' | 'ERR_UNKNOWN_FIELD';
  readonly fieldPath: string;
}

export interface FixtureParseResult {
  readonly fixture: Omit<FixtureInput, 'events'>;
  readonly accepted: readonly FixtureEventInput[];
  readonly rejected: readonly FixtureItemRejection[];
}

export function parseFixtureJson(utf8: string): FixtureParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(utf8) as unknown;
  } catch {
    throw new Error('ERR_SCHEMA_INVALID');
  }
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) throw new Error('ERR_SCHEMA_INVALID');

  const accepted: FixtureEventInput[] = [];
  const rejected: FixtureItemRejection[] = [];
  envelope.data.events.forEach((candidate, index) => {
    const parsed = eventSchema.safeParse(candidate);
    if (parsed.success) {
      accepted.push(parsed.data);
      return;
    }
    const issue = parsed.error.issues[0];
    const unknown = issue?.code === 'unrecognized_keys';
    rejected.push({
      itemKey: typeof candidate === 'object' && candidate !== null && 'sourceItemKey' in candidate
        && typeof candidate.sourceItemKey === 'string' ? candidate.sourceItemKey : String(index),
      code: unknown ? 'ERR_UNKNOWN_FIELD' : 'ERR_SCHEMA_INVALID',
      fieldPath: unknown ? '$unknown' : staticFieldPath(issue?.path),
    });
  });
  return {
    fixture: {
      schemaVersion: envelope.data.schemaVersion,
      fixtureId: envelope.data.fixtureId,
      adapterId: envelope.data.adapterId,
      adapterVersion: envelope.data.adapterVersion,
    },
    accepted,
    rejected,
  };
}

function staticFieldPath(path: PropertyKey[] | undefined): string {
  const allowed = new Set(['sourceItemKey', 'occurredAt', 'kind', 'subject', 'appId', 'projectKey', 'attributes',
    'fileExt', 'operation', 'commandClass', 'exitCode', 'branchHash', 'testOutcome', 'durationMs']);
  const tokens = (path ?? []).filter((value): value is string => typeof value === 'string' && allowed.has(value));
  return tokens.length === 0 ? '$' : `/${tokens.join('/')}`;
}

export function materializeBehaviorEvents(result: FixtureParseResult): readonly BehaviorEvent[] {
  return result.accepted.map((input) => {
    const source = {
      kind: 'fixture' as const,
      fixtureId: result.fixture.fixtureId,
      adapterId: result.fixture.adapterId,
      adapterVersion: result.fixture.adapterVersion,
    };
    const dedupeKey = hashCanonical({ source, sourceItemKey: input.sourceItemKey });
    const factHash = hashCanonical({
      occurredAt: input.occurredAt,
      kind: input.kind,
      subject: input.subject,
      attributes: input.attributes,
    });
    const privacy = {
      classification: 'local-sensitive' as const,
      policyVersion: 'allowlist-v1' as const,
      redactionCount: 0,
    };
    const provenanceHash = hashCanonical({ dedupeKey, factHash, source, privacy });
    const semantic = { schemaVersion: '1.0.0' as const, ...input, source, privacy, dedupeKey, factHash, provenanceHash };
    return Object.freeze({
      ...semantic,
      id: semanticId('behavior-event-v1', { dedupeKey, factHash }),
      contentHash: hashCanonical(semantic),
    });
  });
}

export function assertAllowlistedEvent(event: BehaviorEvent): void {
  const allowed = ['attributes', 'contentHash', 'dedupeKey', 'factHash', 'id', 'kind', 'occurredAt', 'privacy',
    'provenanceHash', 'schemaVersion', 'source', 'sourceItemKey', 'subject'];
  if (canonicalJson(Object.keys(event).sort()) !== canonicalJson(allowed)) throw new Error('ERR_UNKNOWN_FIELD');
}
