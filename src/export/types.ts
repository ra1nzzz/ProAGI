// Canonical export types (Ontology Phase 2+3, Compatible/Adopt).
// These shapes mirror the Canonical Ontology — they are EXPORT-ONLY projections.
// 不得用这些类型替换内部模型（BehaviorEvent/WorkModelClaim/SkillCandidate 保留原名原义）。
// ACTION-SPEC v0.1 §2 Observation · MEMORY-SPEC v0.1 §2/§5 · ARTIFACT-SPEC v0.1 §2 Artifact。
import type { EventAttributes, EventKind, Hash } from '../domain/types';

/** ACTION-SPEC §2 kind 全集；ProAGI Phase 2 仅产出 kind:"event"。 */
export type CanonicalObservationKind = 'visual' | 'dom' | 'network' | 'event' | 'file' | 'system';

/** MEMORY-SPEC §5 canonical Claim status；由本地 ClaimStatus 映射而来（见 export/claim.ts）。 */
export type CanonicalClaimStatus = 'proposed' | 'confirmed' | 'revised' | 'refuted';

/** ACTION-SPEC §2 Observation —— 字段与规范一一对应，不增删顶层字段。 */
export interface CanonicalObservation {
  readonly id: string;
  readonly environmentRef: string;
  readonly subject: string;
  readonly kind: CanonicalObservationKind;
  readonly content: CanonicalObservationEventContent;
  readonly ts: string;
  /** 规范中为可选证据（artifact 引用）；无证据时整个字段省略。 */
  readonly evidence?: readonly string[];
}

/** kind:"event" 的结构化负载（BehaviorEvent 投影，保留隐私标注与事实哈希）。 */
export interface CanonicalObservationEventContent {
  /** 本地 BehaviorEvent.kind（app.focus / file.changed / ...），避免与 canonical kind 混淆改名。 */
  readonly eventKind: EventKind;
  readonly sourceItemKey: string;
  readonly attributes: EventAttributes;
  readonly factHash: Hash;
  readonly dedupeKey: Hash;
  readonly privacy: {
    readonly classification: 'local-sensitive';
    readonly policyVersion: string;
    readonly redactionCount: number;
  };
}

/** MEMORY-SPEC §5 证据引用（EvidenceRef → canonical 证据指针）。 */
export interface CanonicalEvidenceRef {
  readonly ref: string;
  readonly role: 'support' | 'counter' | 'lineage';
  readonly entityHash: Hash;
}

/** MEMORY-SPEC §5 canonical Claim 信封 —— 字段与规范一一对应。 */
export interface CanonicalClaim {
  readonly id: string;
  readonly statement: string;
  readonly evidence: readonly CanonicalEvidenceRef[];
  readonly counterEvidence: readonly CanonicalEvidenceRef[];
  readonly confidence: number;
  readonly status: CanonicalClaimStatus;
  readonly version: number;
  /** 当前指针：指向本地 claim revision id（head）。 */
  readonly head: string;
  readonly corrections: readonly CanonicalCorrectionRef[];
  /** 可追溯性（MEMORY-SPEC §7：每个写入可溯源）；canonical 字段之外一律收敛到 provenance。 */
  readonly provenance: CanonicalClaimProvenance;
}

export interface CanonicalCorrectionRef {
  readonly ref: string;
  readonly action: string;
}

export interface CanonicalClaimProvenance {
  readonly product: 'proagi';
  readonly localClaimId: string;
  readonly claimKey: string;
  readonly semanticKey: string;
  readonly predicateId: string;
  readonly parentRevisionId?: string;
  /** 本地原始 status（rejected/invalidated 映射为 canonical refuted，原文留档）。 */
  readonly localStatus: 'proposed' | 'confirmed' | 'rejected' | 'invalidated';
  readonly contentHash: Hash;
}

// ── Phase 3 (Adopt)：Artifact 信封（ARTIFACT-SPEC v0.1 §2）与 EpisodicMemory（MEMORY-SPEC v0.1 §2） ──

/** ARTIFACT-SPEC §2 kind 全集中 ProAGI 导出涉及的子集。 */
export type CanonicalArtifactKind =
  | 'file' | 'document' | 'code' | 'dataset' | 'report' | 'image' | 'video'
  | 'skill_package' | 'workflow_definition' | 'execution_trace' | 'evidence';

/** ARTIFACT-SPEC §2 verification 块（OrchClaw 骨架 + Ordexa Validation）。 */
export interface CanonicalVerification {
  readonly status: 'unverified' | 'passed' | 'failed';
  readonly method?: string;
  readonly result?: string;
}

/** ARTIFACT-SPEC §2 provenance 块；canonical 字段之外一律收敛到 local。 */
export interface CanonicalArtifactProvenance {
  readonly createdBy: string;
  readonly derivedFrom?: readonly string[];
  /** 本地 EvidenceRef.transform（产出该实体的转换）留档。 */
  readonly transform?: {
    readonly name: string;
    readonly version: string;
    readonly inputHash: Hash;
  };
  /** 本地元数据留档（不进 canonical 词汇）。 */
  readonly local: Record<string, string | number | boolean>;
}

/** ARTIFACT-SPEC §2 canonical Artifact 信封 —— 字段与规范一一对应。 */
export interface CanonicalArtifact {
  readonly id: string;
  readonly kind: CanonicalArtifactKind;
  /** 存储位置（file:// 等）；本地实体尚无物理落盘时整个字段省略。 */
  readonly uri?: string;
  /** 内容完整性哈希（entityHash / contentHash）。 */
  readonly hash: Hash;
  readonly verification: CanonicalVerification;
  readonly provenance: CanonicalArtifactProvenance;
}

/** MEMORY-SPEC §2 EpisodicMemory 层投影（Episode 导出；事件引用复用 Phase 2 的 observation id）。 */
export interface CanonicalEpisodicMemory {
  readonly id: string;
  readonly layer: 'episodic';
  readonly title: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly projectKey?: string;
  readonly activityKind: string;
  readonly eventRefs: readonly string[];
  readonly evidence: readonly CanonicalEvidenceRef[];
  readonly confidence: number;
  readonly provenance: {
    readonly product: 'proagi';
    readonly localEpisodeId: string;
    readonly segmentationVersion: string;
    readonly contentHash: Hash;
  };
}
