import { hashCanonical, semanticId } from '../domain/canonical';
import type {
  CorrectionCommand, CorrectionRecord, KnowledgeHead, KnowledgeSnapshot, KnowledgeVersion,
  WorkModelClaim,
} from '../domain/types';

export interface CorrectionResult {
  readonly ok: boolean;
  readonly record: CorrectionRecord;
  readonly claim?: WorkModelClaim;
  readonly head?: KnowledgeHead;
}

export interface KnowledgePort {
  hydrate(snapshot: KnowledgeSnapshot): void;
  registerProposed(claims: readonly WorkModelClaim[]): void;
  submitCorrection(command: CorrectionCommand): CorrectionResult;
  snapshot(): KnowledgeSnapshot;
  currentClaim(claimKey: string): WorkModelClaim | undefined;
}

export class InMemoryKnowledgePort implements KnowledgePort {
  private readonly claims = new Map<string, WorkModelClaim>();
  private readonly claimHeads = new Map<string, string>();
  private readonly versions = new Map<string, KnowledgeVersion>();
  private readonly knowledgeHeads = new Map<string, KnowledgeHead>();
  private readonly corrections = new Map<string, CorrectionRecord>();
  private readonly deleted = new Set<string>();

  registerProposed(claims: readonly WorkModelClaim[]): void {
    for (const claim of claims) {
      if (this.deleted.has(claim.claimKey)) continue;
      const current = this.currentClaim(claim.claimKey);
      if (!current) {
        this.claims.set(claim.id, deepFreeze(claim));
        this.claimHeads.set(claim.claimKey, claim.id);
      }
    }
  }

  hydrate(snapshot: KnowledgeSnapshot): void {
    this.claims.clear();
    this.claimHeads.clear();
    this.versions.clear();
    this.knowledgeHeads.clear();
    this.corrections.clear();
    this.deleted.clear();
    for (const claim of snapshot.claims) this.claims.set(claim.id, deepFreeze(claim));
    for (const version of snapshot.versions) this.versions.set(version.id, deepFreeze(version));
    for (const head of snapshot.heads) {
      this.knowledgeHeads.set(head.knowledgeKey, deepFreeze(head));
      const version = this.versions.get(head.versionId);
      if (version) this.claimHeads.set(head.knowledgeKey, version.claimRevisionId);
    }
    for (const claim of snapshot.claims) {
      const currentId = this.claimHeads.get(claim.claimKey);
      const current = currentId ? this.claims.get(currentId) : undefined;
      if (!current || claim.revision > current.revision) this.claimHeads.set(claim.claimKey, claim.id);
    }
    for (const correction of snapshot.corrections) this.corrections.set(correction.id, deepFreeze(correction));
    for (const key of snapshot.deletedClaimKeys) this.deleteLineage(key);
  }

  currentClaim(claimKey: string): WorkModelClaim | undefined {
    const id = this.claimHeads.get(claimKey);
    return id ? this.claims.get(id) : undefined;
  }

  submitCorrection(command: CorrectionCommand): CorrectionResult {
    if (this.deleted.has(command.targetClaimKey)) {
      return this.failure(command, 'ERR_DELETED_RESTORE_FORBIDDEN');
    }
    const current = this.currentClaim(command.targetClaimKey);
    if (!current) return this.failure(command, 'ERR_NOT_FOUND');
    if (current.id !== command.baseRevisionId) return this.failure(command, 'ERR_REVISION_CONFLICT');

    if (command.action === 'delete') {
      this.deleteLineage(command.targetClaimKey);
      // The delete result is returned ephemerally; retaining it would recreate a
      // target-linked record after the lineage purge completed.
      const record = makeCorrectionRecord(command, undefined);
      return { ok: true, record };
    }

    const source = command.action === 'restore'
      ? this.claims.get(command.restoreFromRevisionId ?? '')
      : current;
    if (!source || source.claimKey !== command.targetClaimKey) return this.failure(command, 'ERR_NOT_FOUND');

    const status = command.action === 'reject' ? 'rejected' as const : 'confirmed' as const;
    const revisionNumber = current.revision + 1;
    const semantic = {
      schemaVersion: '1.0.0' as const,
      claimKey: current.claimKey,
      semanticKey: command.action === 'edit' && command.scope
        ? semanticKeyFor(source.predicateId, command.scope)
        : source.semanticKey,
      predicateId: source.predicateId,
      parentRevisionId: current.id,
      revision: revisionNumber,
      statement: command.action === 'edit' ? (command.statement ?? source.statement) : source.statement,
      scope: command.action === 'edit' ? (command.scope ?? source.scope) : source.scope,
      confidence: status === 'confirmed' ? 1 : source.confidence,
      evidence: source.evidence,
      counterEvidence: source.counterEvidence,
      status,
    };
    const claim: WorkModelClaim = deepFreeze({
      ...semantic,
      id: semanticId('claim-revision-v1', { claimKey: current.claimKey, revision: revisionNumber, semantic }),
      contentHash: hashCanonical(semantic),
    });
    const provisionalCorrectionId = semanticId('correction-v1', {
      commandId: command.commandId,
      claimKey: command.targetClaimKey,
      base: current.contentHash,
      action: command.action,
      result: claim.contentHash,
    });
    const previousHead = this.knowledgeHeads.get(command.targetClaimKey);
    const versionNumber = (previousHead?.version ?? 0) + 1;
    const versionSemantic = {
      knowledgeKey: command.targetClaimKey,
      version: versionNumber,
      claimContentHash: claim.contentHash,
      ...(previousHead ? { basedOnVersionContentHash: this.versions.get(previousHead.versionId)?.contentHash } : {}),
      correctionSemanticId: provisionalCorrectionId,
    };
    const version: KnowledgeVersion = deepFreeze({
      id: semanticId('knowledge-version-v1', versionSemantic),
      knowledgeKey: command.targetClaimKey,
      version: versionNumber,
      claimRevisionId: claim.id,
      ...(previousHead ? { basedOnVersionId: previousHead.versionId } : {}),
      causedByCorrectionId: provisionalCorrectionId,
      contentHash: hashCanonical(versionSemantic),
    });
    const headSemantic = { knowledgeKey: command.targetClaimKey, version: versionNumber, versionContentHash: version.contentHash };
    const head: KnowledgeHead = deepFreeze({
      knowledgeKey: command.targetClaimKey,
      versionId: version.id,
      version: versionNumber,
      contentHash: hashCanonical(headSemantic),
    });
    const record = makeCorrectionRecord(command, claim, provisionalCorrectionId);

    // One synchronous commit is the M1a linearization point. No state is published before this block.
    this.claims.set(claim.id, claim);
    this.claimHeads.set(claim.claimKey, claim.id);
    this.versions.set(version.id, version);
    this.knowledgeHeads.set(head.knowledgeKey, head);
    this.corrections.set(record.id, record);
    return { ok: true, record, claim, head };
  }

  snapshot(): KnowledgeSnapshot {
    return deepFreeze({
      claims: [...this.claims.values()].sort((a, b) => a.claimKey.localeCompare(b.claimKey) || a.revision - b.revision),
      heads: [...this.knowledgeHeads.values()].sort((a, b) => a.knowledgeKey.localeCompare(b.knowledgeKey)),
      versions: [...this.versions.values()].sort((a, b) => a.knowledgeKey.localeCompare(b.knowledgeKey) || a.version - b.version),
      corrections: [...this.corrections.values()].sort((a, b) => a.contentHash.localeCompare(b.contentHash)),
      deletedClaimKeys: [...this.deleted].sort(),
    });
  }

  private deleteLineage(claimKey: string): void {
    this.deleted.add(claimKey);
    for (const [id, claim] of this.claims) if (claim.claimKey === claimKey) this.claims.delete(id);
    for (const [id, version] of this.versions) if (version.knowledgeKey === claimKey) this.versions.delete(id);
    this.claimHeads.delete(claimKey);
    this.knowledgeHeads.delete(claimKey);
    for (const [id, correction] of this.corrections) if (correction.targetClaimKey === claimKey) this.corrections.delete(id);
  }

  private failure(command: CorrectionCommand, errorCode: NonNullable<CorrectionRecord['errorCode']>): CorrectionResult {
    const record = makeCorrectionRecord(command, undefined, undefined, errorCode);
    return { ok: false, record };
  }
}

function semanticKeyFor(predicateId: string, scope: { readonly projectKey?: string; readonly activityKind?: string }): string {
  return `workflow-v1:${predicateId.replace(/-v\d+$/, '')}:${scope.projectKey ?? 'unscoped'}:${scope.activityKind ?? 'other'}`;
}

function makeCorrectionRecord(
  command: CorrectionCommand,
  claim: WorkModelClaim | undefined,
  forcedId?: string,
  errorCode?: NonNullable<CorrectionRecord['errorCode']>,
): CorrectionRecord {
  const semantic = {
    targetClaimKey: command.targetClaimKey,
    action: command.action,
    status: errorCode ? 'failed' as const : 'applied' as const,
    ...(claim ? { resultClaimContentHash: claim.contentHash } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
  const id = forcedId ?? semanticId('correction-v1', { commandId: command.commandId, baseRevisionId: command.baseRevisionId, semantic });
  return deepFreeze({
    id,
    commandId: command.commandId,
    targetClaimKey: command.targetClaimKey,
    baseRevisionId: command.baseRevisionId,
    action: command.action,
    status: semantic.status,
    ...(claim ? { resultClaimRevisionId: claim.id } : {}),
    ...(errorCode ? { errorCode } : {}),
    contentHash: hashCanonical(semantic),
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
