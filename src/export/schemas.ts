// Zod schemas for canonical export shapes.
// 导出格式 schema 校验的对齐基准：ACTION-SPEC v0.1 §2 / MEMORY-SPEC v0.1 §2/§5 / ARTIFACT-SPEC v0.1 §2。
// InPeak 的 Observation 解析器可直接复用这些 schema 做跨产品断言（PHASE 9）。
import { z } from 'zod';
import type { CanonicalArtifact, CanonicalClaim, CanonicalEpisodicMemory, CanonicalObservation } from './types';

const isoTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
const hash = z.custom<`sha256:${string}`>((value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value));
const uriToken = /[\p{L}\p{N}._-]+/u;

export const canonicalObservationSchema = z.object({
  id: z.string().regex(new RegExp(`^observation:proagi:${uriToken.source}$`, 'u')),
  environmentRef: z.string().regex(new RegExp(`^environment:${uriToken.source}:${uriToken.source}$`, 'u')),
  subject: z.string().regex(new RegExp(`^app:${uriToken.source}(?:/${uriToken.source})?$`, 'u')),
  kind: z.enum(['visual', 'dom', 'network', 'event', 'file', 'system']),
  content: z.object({
    eventKind: z.enum(['app.focus', 'file.changed', 'terminal.completed', 'git.changed', 'test.completed']),
    sourceItemKey: z.string().min(1),
    attributes: z.record(z.string(), z.unknown()),
    factHash: hash,
    dedupeKey: hash,
    privacy: z.object({
      classification: z.literal('local-sensitive'),
      policyVersion: z.literal('allowlist-v1'),
      redactionCount: z.number().int().min(0),
    }).strict(),
  }).strict(),
  ts: isoTimestamp,
  evidence: z.array(z.string().min(1)).optional(),
}).strict();

export const canonicalEvidenceRefSchema = z.object({
  ref: z.string().regex(new RegExp(`^evidence:proagi:${uriToken.source}/${uriToken.source}$`, 'u')),
  role: z.enum(['support', 'counter', 'lineage']),
  entityHash: hash,
}).strict();

export const canonicalClaimSchema = z.object({
  id: z.string().regex(new RegExp(`^claim:proagi:${uriToken.source}$`, 'u')),
  statement: z.string().min(1),
  evidence: z.array(canonicalEvidenceRefSchema),
  counterEvidence: z.array(canonicalEvidenceRefSchema),
  confidence: z.number().min(0).max(1),
  status: z.enum(['proposed', 'confirmed', 'revised', 'refuted']),
  version: z.number().int().min(1),
  head: z.string().min(1),
  corrections: z.array(z.object({
    ref: z.string().min(1),
    action: z.string().min(1),
  }).strict()),
  provenance: z.object({
    product: z.literal('proagi'),
    localClaimId: z.string().min(1),
    claimKey: z.string().min(1),
    semanticKey: z.string().min(1),
    predicateId: z.string().min(1),
    parentRevisionId: z.string().min(1).optional(),
    localStatus: z.enum(['proposed', 'confirmed', 'rejected', 'invalidated']),
    contentHash: hash,
  }).strict(),
}).strict();

export function parseCanonicalObservation(value: unknown): CanonicalObservation {
  return canonicalObservationSchema.parse(value) as CanonicalObservation;
}

export function parseCanonicalClaim(value: unknown): CanonicalClaim {
  return canonicalClaimSchema.parse(value) as CanonicalClaim;
}

export const canonicalVerificationSchema = z.object({
  status: z.enum(['unverified', 'passed', 'failed']),
  method: z.string().min(1).optional(),
  result: z.string().min(1).optional(),
}).strict();

export const canonicalArtifactSchema = z.object({
  id: z.string().regex(new RegExp(`^artifact:proagi:(evidence|report)/${uriToken.source}(?:/${uriToken.source})?$`, 'u')),
  kind: z.enum(['file', 'document', 'code', 'dataset', 'report', 'image', 'video',
    'skill_package', 'workflow_definition', 'execution_trace', 'evidence']),
  uri: z.string().min(1).optional(),
  hash,
  verification: canonicalVerificationSchema,
  provenance: z.object({
    createdBy: z.string().min(1),
    derivedFrom: z.array(z.string().min(1)).optional(),
    transform: z.object({
      name: z.string().min(1),
      version: z.string().min(1),
      inputHash: hash,
    }).strict().optional(),
    local: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  }).strict(),
}).strict();

export const canonicalEpisodicMemorySchema = z.object({
  id: z.string().regex(new RegExp(`^memory:proagi:episode/${uriToken.source}$`, 'u')),
  layer: z.literal('episodic'),
  title: z.string().min(1),
  startAt: isoTimestamp,
  endAt: isoTimestamp,
  projectKey: z.string().min(1).optional(),
  activityKind: z.string().min(1),
  eventRefs: z.array(z.string().regex(new RegExp(`^observation:proagi:${uriToken.source}$`, 'u'))),
  evidence: z.array(canonicalEvidenceRefSchema),
  confidence: z.number().min(0).max(1),
  provenance: z.object({
    product: z.literal('proagi'),
    localEpisodeId: z.string().min(1),
    segmentationVersion: z.string().min(1),
    contentHash: hash,
  }).strict(),
}).strict();

export function parseCanonicalArtifact(value: unknown): CanonicalArtifact {
  return canonicalArtifactSchema.parse(value) as CanonicalArtifact;
}

export function parseCanonicalEpisodicMemory(value: unknown): CanonicalEpisodicMemory {
  return canonicalEpisodicMemorySchema.parse(value) as CanonicalEpisodicMemory;
}
