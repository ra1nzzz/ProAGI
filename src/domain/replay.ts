import { hashCanonical, semanticId } from './canonical';
import { dedupeAndSortEvents, runInsightLoop } from './insightLoop';
import type { BehaviorEvent, Hash, InsightLoopOutput, KnowledgeSnapshot, WorkModelClaim } from './types';

export interface ReplayInputV1 {
  readonly replayInputVersion: '1';
  readonly events: readonly BehaviorEvent[];
  readonly knowledge: KnowledgeSnapshot;
  readonly asOf: string;
  readonly timezone: string;
  readonly locale: string;
  readonly clockSeed: Hash;
  readonly pins: {
    readonly schema: '1.0.0';
    readonly segmentation: 'segment-v1';
    readonly inference: 'insight-v1';
    readonly canonicalization: 'canonical-json-v1';
  };
}

export interface ReplaySnapshotV1 {
  readonly snapshotVersion: '1';
  readonly replayKey: Hash;
  readonly output: InsightLoopOutput;
  readonly snapshotHash: Hash;
}

export type ReplayV1 = (input: Readonly<ReplayInputV1>) => ReplaySnapshotV1;

export const replayV1: ReplayV1 = (input) => {
  if (input.replayInputVersion !== '1' || input.pins.schema !== '1.0.0') throw new Error('ERR_REPLAY_PIN_MISSING');
  const events = dedupeAndSortEvents(input.events.map((event) => Object.freeze({
    ...event,
    id: semanticId('replay-event-v1', {
      occurredAt: event.occurredAt,
      kind: event.kind,
      factHash: event.factHash,
      dedupeKey: event.dedupeKey,
      contentHash: event.contentHash,
    }),
  })));
  const knowledge = normalizeKnowledge(input.knowledge);
  const semanticInput = {
    replayInputVersion: input.replayInputVersion,
    events: events.map(pickReplayEvent),
    knowledge: {
      claims: knowledge.claims.map(pickReplayClaim),
      heads: knowledge.heads.map((head) => ({
        knowledgeKey: head.knowledgeKey,
        version: head.version,
        contentHash: head.contentHash,
      })),
      versions: knowledge.versions.map((version) => ({
        knowledgeKey: version.knowledgeKey,
        version: version.version,
        contentHash: version.contentHash,
      })),
      corrections: knowledge.corrections.map((record) => ({
        targetClaimKey: record.targetClaimKey,
        action: record.action,
        status: record.status,
        ...(record.errorCode ? { errorCode: record.errorCode } : {}),
        contentHash: record.contentHash,
      })),
      deletedClaimKeys: [...knowledge.deletedClaimKeys].sort(),
    },
    asOf: input.asOf,
    timezone: input.timezone,
    locale: input.locale,
    clockSeed: input.clockSeed,
    pins: input.pins,
  };
  const replayKey = hashCanonical(semanticInput);
  const output = runInsightLoop(events, { asOf: input.asOf, timezone: input.timezone, knowledge });
  return Object.freeze({ snapshotVersion: '1', replayKey, output, snapshotHash: hashCanonical({ replayKey, output }) });
};

function pickReplayEvent(event: BehaviorEvent) {
  return {
    schemaVersion: event.schemaVersion,
    sourceItemKey: event.sourceItemKey,
    occurredAt: event.occurredAt,
    kind: event.kind,
    subject: event.subject,
    attributes: event.attributes,
    source: event.source,
    privacy: event.privacy,
    dedupeKey: event.dedupeKey,
    factHash: event.factHash,
    provenanceHash: event.provenanceHash,
    contentHash: event.contentHash,
  };
}

function pickReplayClaim(claim: WorkModelClaim) {
  return {
    schemaVersion: claim.schemaVersion,
    claimKey: claim.claimKey,
    semanticKey: claim.semanticKey,
    predicateId: claim.predicateId,
    revision: claim.revision,
    statement: claim.statement,
    scope: claim.scope,
    confidence: claim.confidence,
    evidence: claim.evidence,
    counterEvidence: claim.counterEvidence,
    status: claim.status,
    contentHash: claim.contentHash,
  };
}

function normalizeKnowledge(snapshot: KnowledgeSnapshot): KnowledgeSnapshot {
  const claimIds = new Map<string, string>();
  const claims = snapshot.claims.map((claim): WorkModelClaim => {
    const id = semanticId('replay-claim-revision-v1', { claimKey: claim.claimKey, revision: claim.revision, contentHash: claim.contentHash });
    claimIds.set(claim.id, id);
    return Object.freeze({ ...claim, id, parentRevisionId: undefined });
  });
  const versionIds = new Map<string, string>();
  const versions = snapshot.versions.map((version) => {
    const id = semanticId('replay-knowledge-version-v1', {
      knowledgeKey: version.knowledgeKey, version: version.version, contentHash: version.contentHash,
    });
    versionIds.set(version.id, id);
    return Object.freeze({
      ...version,
      id,
      claimRevisionId: claimIds.get(version.claimRevisionId) ?? version.claimRevisionId,
      basedOnVersionId: version.basedOnVersionId ? versionIds.get(version.basedOnVersionId) : undefined,
      causedByCorrectionId: semanticId('replay-correction-v1', version.causedByCorrectionId),
    });
  });
  const heads = snapshot.heads.map((head) => Object.freeze({ ...head, versionId: versionIds.get(head.versionId) ?? head.versionId }));
  return Object.freeze({
    claims,
    versions,
    heads,
    corrections: snapshot.corrections,
    deletedClaimKeys: [...snapshot.deletedClaimKeys].sort(),
  });
}
