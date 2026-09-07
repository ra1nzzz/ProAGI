// Ontology Phase 3 (Adopt) export: canonical Artifact 信封（ARTIFACT-SPEC v0.1 §2）。
// 映射依据：mappings/proagi.yaml（EvidenceRef.canonical = Artifact(kind=evidence) reference；
//          DailyReportSnapshot.canonical = Artifact(kind=report)）。
// 补齐 uri/hash/provenance 元数据（迁移文档 §8「evidence 结构对齐」项）。
// 铁律：纯函数、显式调用、无 I/O；uri 由调用方显式提供，绝不自动落盘或外发。
import type { DailyReportSnapshot, EvidenceRef } from '../domain/types';
import type { CanonicalArtifact, CanonicalVerification } from './types';

export interface ExportArtifactOptions {
  /** 实体物理存储位置（如 file://...）；省略表示尚未落盘。 */
  readonly uri?: string;
  /** 验证状态；默认 unverified（不谎报已验证）。 */
  readonly verification?: CanonicalVerification;
}

export function exportEvidenceArtifact(evidence: EvidenceRef, options: ExportArtifactOptions = {}): CanonicalArtifact {
  return Object.freeze<CanonicalArtifact>({
    id: `artifact:proagi:evidence/${evidence.entityType}/${evidence.entityId}`,
    kind: 'evidence',
    ...(options.uri === undefined ? {} : { uri: options.uri }),
    hash: evidence.entityHash,
    verification: Object.freeze(options.verification ?? { status: 'unverified' }),
    provenance: Object.freeze({
      createdBy: 'agent:proagi',
      ...(evidence.transform === undefined ? {} : { transform: { ...evidence.transform } }),
      local: Object.freeze({ role: evidence.role }),
    }),
  });
}

export function exportReportArtifact(report: DailyReportSnapshot, options: ExportArtifactOptions = {}): CanonicalArtifact {
  return Object.freeze<CanonicalArtifact>({
    id: `artifact:proagi:report/${report.id}`,
    kind: 'report',
    ...(options.uri === undefined ? {} : { uri: options.uri }),
    hash: report.contentHash,
    verification: Object.freeze(options.verification ?? { status: 'unverified' }),
    provenance: Object.freeze({
      createdBy: 'agent:proagi',
      local: Object.freeze({
        projectionVersion: report.projectionVersion,
        localDate: report.localDate,
        timezone: report.timezone,
        episodeCount: report.episodeIds.length,
        learnedClaimCount: report.sections.learnedClaimIds.length,
        questionCount: report.sections.questionIds.length,
        skillCandidateCount: report.sections.skillCandidateIds.length,
      }),
    }),
  });
}
