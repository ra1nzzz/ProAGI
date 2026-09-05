export type Hash = `sha256:${string}`;
export type Timestamp = string;
export type EventKind =
  | 'app.focus'
  | 'file.changed'
  | 'terminal.completed'
  | 'git.changed'
  | 'test.completed';

export type ActivityKind = 'code' | 'test' | 'review' | 'research' | 'build' | 'other';
export type AppId = 'vscode' | 'cursor' | 'terminal' | 'browser' | 'git' | 'other';

export interface EventAttributes {
  readonly projectKey?: string;
  readonly appId?: AppId;
  readonly fileExt?: string;
  readonly operation?: 'open' | 'modify' | 'create' | 'rename';
  readonly commandClass?: 'build' | 'test' | 'lint' | 'git' | 'package' | 'other';
  readonly exitCode?: number;
  readonly branchHash?: Hash;
  readonly testOutcome?: 'passed' | 'failed' | 'skipped';
  readonly durationMs?: number;
}

export interface FixtureEventInput {
  readonly sourceItemKey: string;
  readonly occurredAt: Timestamp;
  readonly kind: EventKind;
  readonly subject: { readonly appId: AppId; readonly projectKey?: string };
  readonly attributes: EventAttributes;
}

export interface FixtureInput {
  readonly schemaVersion: '1.0.0';
  readonly fixtureId: string;
  readonly adapterId: 'synthetic-fixture';
  readonly adapterVersion: '1.0.0';
  readonly events: readonly FixtureEventInput[];
}

export interface BehaviorEvent extends FixtureEventInput {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly source: {
    readonly kind: 'fixture';
    readonly fixtureId: string;
    readonly adapterId: string;
    readonly adapterVersion: string;
  };
  readonly privacy: {
    readonly classification: 'local-sensitive';
    readonly policyVersion: 'allowlist-v1';
    readonly redactionCount: number;
  };
  readonly dedupeKey: Hash;
  readonly factHash: Hash;
  readonly provenanceHash: Hash;
  readonly contentHash: Hash;
}

export interface EvidenceRef {
  readonly entityType: 'behavior_event' | 'episode' | 'work_model_claim';
  readonly entityId: string;
  readonly entityHash: Hash;
  readonly role: 'support' | 'counter' | 'lineage';
  readonly transform: { readonly name: string; readonly version: string; readonly inputHash: Hash };
}

export interface Scope {
  readonly projectKey?: string;
  readonly activityKind?: ActivityKind;
}

export interface Episode {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly startAt: Timestamp;
  readonly endAt: Timestamp;
  readonly title: string;
  readonly projectKey?: string;
  readonly activityKind: ActivityKind;
  readonly eventIds: readonly string[];
  readonly evidence: readonly EvidenceRef[];
  readonly confidence: number;
  readonly segmentationVersion: 'segment-v1';
  readonly status: 'final';
  readonly contentHash: Hash;
}

export type ClaimStatus = 'proposed' | 'confirmed' | 'rejected' | 'invalidated';
export interface WorkModelClaim {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly claimKey: string;
  readonly semanticKey: string;
  readonly predicateId: string;
  readonly parentRevisionId?: string;
  readonly revision: number;
  readonly statement: string;
  readonly scope: Scope;
  readonly confidence: number;
  readonly evidence: readonly EvidenceRef[];
  readonly counterEvidence: readonly EvidenceRef[];
  readonly status: ClaimStatus;
  readonly contentHash: Hash;
}

export interface Question {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly workflowKey: string;
  readonly revision: 1;
  readonly prompt: string;
  readonly gapType: 'error' | 'workflow';
  readonly scope: Scope;
  readonly evidence: readonly EvidenceRef[];
  readonly expectedInformationGain: number;
  readonly status: 'queued';
  readonly contentHash: Hash;
}

export const FORBIDDEN_EFFECTS = [
  'fetch', 'xhr', 'websocket', 'eventsource', 'beacon',
  'navigation', 'window-open', 'download', 'clipboard', 'web-share',
  'service-worker', 'worker-bridge', 'custom-scheme',
] as const;
export type ForbiddenEffect = (typeof FORBIDDEN_EFFECTS)[number];

export interface ActionIntent {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly workflowKey: string;
  readonly revision: 1;
  readonly mode: 'shadow';
  readonly summary: string;
  readonly preconditions: readonly string[];
  readonly hypotheticalSteps: readonly {
    readonly order: number;
    readonly description: string;
    readonly effect: string;
  }[];
  readonly expectedEffects: readonly string[];
  readonly forbiddenEffects: readonly ForbiddenEffect[];
  readonly status: 'draft';
  readonly contentHash: Hash;
}

export interface SkillCandidate {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly workflowKey: string;
  readonly revision: 1;
  readonly name: string;
  readonly purpose: string;
  readonly triggerSummary: string;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly evidence: readonly EvidenceRef[];
  readonly estimatedBenefitMinutes: number;
  readonly risk: 'low';
  readonly confidence: number;
  readonly actionIntentRevisionId: string;
  readonly status: 'proposed';
  readonly contentHash: Hash;
}

export interface DailyReportSnapshot {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly projectionVersion: 'daily-report-v1';
  readonly localDate: string;
  readonly timezone: string;
  readonly episodeIds: readonly string[];
  readonly sections: {
    readonly work: readonly { readonly episodeId: string; readonly summary: string }[];
    readonly learnedClaimIds: readonly string[];
    readonly questionIds: readonly string[];
    readonly skillCandidateIds: readonly string[];
  };
  readonly evidence: readonly EvidenceRef[];
  readonly status: 'published';
  readonly contentHash: Hash;
}

export interface InsightLoopOutput {
  readonly events: readonly BehaviorEvent[];
  readonly episodes: readonly Episode[];
  readonly claims: readonly WorkModelClaim[];
  readonly questions: readonly Question[];
  readonly skillCandidates: readonly SkillCandidate[];
  readonly actionIntents: readonly ActionIntent[];
  readonly report: DailyReportSnapshot;
  readonly snapshotHash: Hash;
}

export type CorrectionAction = 'accept' | 'edit' | 'reject' | 'delete' | 'restore';
export interface CorrectionCommand {
  readonly commandId: string;
  readonly targetClaimKey: string;
  readonly baseRevisionId: string;
  readonly action: CorrectionAction;
  readonly statement?: string;
  readonly scope?: Scope;
  readonly restoreFromRevisionId?: string;
}

export interface CorrectionRecord {
  readonly id: string;
  readonly commandId: string;
  readonly targetClaimKey: string;
  readonly baseRevisionId: string;
  readonly action: CorrectionAction;
  readonly status: 'applied' | 'failed';
  readonly resultClaimRevisionId?: string;
  readonly errorCode?: 'ERR_REVISION_CONFLICT' | 'ERR_NOT_FOUND' | 'ERR_DELETED_RESTORE_FORBIDDEN';
  readonly contentHash: Hash;
}

export interface KnowledgeVersion {
  readonly id: string;
  readonly knowledgeKey: string;
  readonly version: number;
  readonly claimRevisionId: string;
  readonly basedOnVersionId?: string;
  readonly causedByCorrectionId: string;
  readonly contentHash: Hash;
}

export interface KnowledgeHead {
  readonly knowledgeKey: string;
  readonly versionId: string;
  readonly version: number;
  readonly contentHash: Hash;
}

export interface KnowledgeSnapshot {
  readonly claims: readonly WorkModelClaim[];
  readonly heads: readonly KnowledgeHead[];
  readonly versions: readonly KnowledgeVersion[];
  readonly corrections: readonly CorrectionRecord[];
  readonly deletedClaimKeys: readonly string[];
}
