// Internal shared helpers for the export layer (not part of the public barrel contract).
import type { EvidenceRef } from '../domain/types';
import type { CanonicalEvidenceRef } from './types';

/** EvidenceRef → canonical 证据指针（Phase 2 起共用）。 */
export function toCanonicalEvidenceRef(refs: readonly EvidenceRef[]): readonly CanonicalEvidenceRef[] {
  return refs.map((evidence) => Object.freeze({
    ref: `evidence:proagi:${evidence.entityType}/${evidence.entityId}`,
    role: evidence.role,
    entityHash: evidence.entityHash,
  }));
}
