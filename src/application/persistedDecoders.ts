import { z } from 'zod';
import type {
  BehaviorEvent, CorrectionRecord, EvidenceRef, Hash, KnowledgeHead, KnowledgeVersion,
  WorkModelClaim,
} from '../domain/types';

const hash: z.ZodType<Hash> = z.custom<Hash>((value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value));
const timestamp = z.string().datetime({ offset: true });
const safeString = z.string().min(1);
const scope = z.object({
  projectKey: safeString.optional(),
  activityKind: z.enum(['code', 'test', 'review', 'research', 'build', 'other']).optional(),
}).strict();
const evidenceRef: z.ZodType<EvidenceRef> = z.object({
  entityType: z.enum(['behavior_event', 'episode', 'work_model_claim']),
  entityId: safeString,
  entityHash: hash,
  role: z.enum(['support', 'counter', 'lineage']),
  transform: z.object({ name: safeString, version: safeString, inputHash: hash }).strict(),
}).strict();

const behaviorEventSchema: z.ZodType<BehaviorEvent> = z.object({
  schemaVersion: z.literal('1.0.0'),
  id: safeString,
  sourceItemKey: safeString,
  occurredAt: timestamp,
  kind: z.enum(['app.focus', 'file.changed', 'terminal.completed', 'git.changed', 'test.completed']),
  subject: z.object({
    appId: z.enum(['vscode', 'cursor', 'terminal', 'browser', 'git', 'other']),
    projectKey: safeString.optional(),
  }).strict(),
  attributes: z.object({
    projectKey: safeString.optional(),
    appId: z.enum(['vscode', 'cursor', 'terminal', 'browser', 'git', 'other']).optional(),
    fileExt: safeString.optional(),
    operation: z.enum(['open', 'modify', 'create', 'rename']).optional(),
    commandClass: z.enum(['build', 'test', 'lint', 'git', 'package', 'other']).optional(),
    exitCode: z.number().int().min(-255).max(255).optional(),
    branchHash: hash.optional(),
    testOutcome: z.enum(['passed', 'failed', 'skipped']).optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
  }).strict(),
  source: z.object({
    kind: z.literal('fixture'), fixtureId: safeString, adapterId: safeString, adapterVersion: safeString,
  }).strict(),
  privacy: z.object({
    classification: z.literal('local-sensitive'), policyVersion: z.literal('allowlist-v1'), redactionCount: z.number().int().min(0),
  }).strict(),
  dedupeKey: hash,
  factHash: hash,
  provenanceHash: hash,
  contentHash: hash,
}).strict();

const claimSchema: z.ZodType<WorkModelClaim> = z.object({
  schemaVersion: z.literal('1.0.0'),
  id: safeString,
  claimKey: safeString,
  semanticKey: safeString,
  predicateId: safeString,
  parentRevisionId: safeString.optional(),
  revision: z.number().int().min(1),
  statement: safeString,
  scope,
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceRef),
  counterEvidence: z.array(evidenceRef),
  status: z.enum(['proposed', 'confirmed', 'rejected', 'invalidated']),
  contentHash: hash,
}).strict();

const versionSchema: z.ZodType<KnowledgeVersion> = z.object({
  id: safeString, knowledgeKey: safeString, version: z.number().int().min(1), claimRevisionId: safeString,
  basedOnVersionId: safeString.optional(), causedByCorrectionId: safeString, contentHash: hash,
}).strict();

const headSchema: z.ZodType<KnowledgeHead> = z.object({
  knowledgeKey: safeString, versionId: safeString, version: z.number().int().min(1), contentHash: hash,
}).strict();

const correctionSchema: z.ZodType<CorrectionRecord> = z.object({
  id: safeString, commandId: safeString, targetClaimKey: safeString, baseRevisionId: safeString,
  action: z.enum(['accept', 'edit', 'reject', 'delete', 'restore']), status: z.enum(['applied', 'failed']),
  resultClaimRevisionId: safeString.optional(),
  errorCode: z.enum(['ERR_REVISION_CONFLICT', 'ERR_NOT_FOUND', 'ERR_DELETED_RESTORE_FORBIDDEN']).optional(),
  contentHash: hash,
}).strict();

export class PersistedDecodeError extends Error {
  readonly code = 'ERR_STORAGE_CORRUPT' as const;
  constructor(readonly entity: string, readonly issuePath: string) {
    super('ERR_STORAGE_CORRUPT');
    this.name = 'PersistedDecodeError';
  }
}

function decode<T>(schema: z.ZodType<T>, value: unknown, entity: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issuePath = result.error.issues[0]?.path.map(String).join('.') || '<root>';
    throw new PersistedDecodeError(entity, issuePath);
  }
  return result.data;
}

export function decodeBehaviorEvent(value: unknown): BehaviorEvent { return decode(behaviorEventSchema, value, 'behavior-event'); }
export function decodeWorkModelClaim(value: unknown): WorkModelClaim { return decode(claimSchema, value, 'work-model-claim'); }
export function decodeKnowledgeVersion(value: unknown): KnowledgeVersion { return decode(versionSchema, value, 'knowledge-version'); }
export function decodeKnowledgeHead(value: unknown): KnowledgeHead { return decode(headSchema, value, 'knowledge-head'); }
export function decodeCorrectionRecord(value: unknown): CorrectionRecord { return decode(correctionSchema, value, 'correction-record'); }

export interface FixtureMarkerPayload {
  readonly asOf: number;
  readonly fixtureId: 'developer-day-bundled-v1';
}

const fixtureMarkerSchema: z.ZodType<FixtureMarkerPayload> = z.object({
  asOf: z.number().int().min(-8_640_000_000_000_000).max(8_640_000_000_000_000), fixtureId: z.literal('developer-day-bundled-v1'),
}).strict();

export function decodeFixtureMarker(value: unknown): FixtureMarkerPayload { return decode(fixtureMarkerSchema, value, 'fixture-marker'); }
