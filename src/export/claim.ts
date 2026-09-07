// Ontology Phase 2 export: WorkModelClaim -> canonical Claim 信封.
// 映射依据：mappings/proagi.yaml（WorkModelClaim.canonical = Knowledge.Claim）
//          MEMORY-SPEC v0.1 §5（Claim 元模型：statement/evidence/counterEvidence/
//          confidence/status/version/head/corrections）。
// Claim 元模型本身由 ProAGI 吸收进 Canonical（本产品是 Knowledge 元模型源头），
// 导出只做信封投影，不改动本地版本化机制。
// status 映射（canonical 无 rejected/invalidated 词汇，原值保留在 provenance.localStatus）：
//   proposed -> proposed | confirmed -> confirmed | rejected -> refuted | invalidated -> refuted
import type { EvidenceRef, WorkModelClaim } from '../domain/types';
import type { CanonicalClaim, CanonicalClaimStatus, CanonicalEvidenceRef } from './types';

export function toCanonicalClaimStatus(status: WorkModelClaim['status']): CanonicalClaimStatus {
  switch (status) {
    case 'proposed': return 'proposed';
    case 'confirmed': return 'confirmed';
    case 'rejected':
    case 'invalidated': return 'refuted';
  }
}

function toCanonicalEvidenceRef(refs: readonly EvidenceRef[]): readonly CanonicalEvidenceRef[] {
  return refs.map((evidence) => Object.freeze({
    ref: `evidence:proagi:${evidence.entityType}/${evidence.entityId}`,
    role: evidence.role,
    entityHash: evidence.entityHash,
  }));
}

export function exportClaim(claim: WorkModelClaim): CanonicalClaim {
  const canonical: CanonicalClaim = Object.freeze({
    id: `claim:proagi:${claim.claimKey}`,
    statement: claim.statement,
    evidence: toCanonicalEvidenceRef(claim.evidence),
    counterEvidence: toCanonicalEvidenceRef(claim.counterEvidence),
    confidence: claim.confidence,
    status: toCanonicalClaimStatus(claim.status),
    version: claim.revision,
    head: claim.id,
    corrections: Object.freeze([]),
    provenance: Object.freeze({
      product: 'proagi' as const,
      localClaimId: claim.id,
      claimKey: claim.claimKey,
      semanticKey: claim.semanticKey,
      predicateId: claim.predicateId,
      ...(claim.parentRevisionId === undefined ? {} : { parentRevisionId: claim.parentRevisionId }),
      localStatus: claim.status,
      contentHash: claim.contentHash,
    }),
  });
  return canonical;
}
