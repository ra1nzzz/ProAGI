import { z } from 'zod';
import { hashCanonical, sha256 } from '../domain/canonical';
import type { Hash, WorkModelClaim } from '../domain/types';
import { decodeWorkModelClaim } from '../application/persistedDecoders';
import type { MarkdownExport, MarkdownProjection, ProjectionPort, ProjectionStoragePort } from '../application/projectionPort';
import type { ProjectionHeadRecord, StoredRecord } from '../application/storageContracts';

export const MARKDOWN_PROJECTION_ID = 'markdown-knowledge-v1';
const payloadSchema = z.object({
  version: z.literal('markdown-knowledge-v1'), privacyEpoch: z.number().int().min(0), incarnation: z.string(),
  claims: z.array(z.unknown()), markdown: z.string(), contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

/** Managed Markdown is disposable. Export returns bytes only; the caller owns any download. */
export class MarkdownProjectionAdapter implements ProjectionPort {
  private enabled = true;
  private trustedHeadHash?: Hash;
  constructor(private readonly store: ProjectionStoragePort) {}

  async rebuild(options: { readonly forceFull?: boolean } = {}): Promise<MarkdownProjection> {
    this.assertEnabled();
    const release = this.store.beginInProcessRootMutation();
    try {
      const head = await this.store.getRecord<ProjectionHeadRecord>('projection', MARKDOWN_PROJECTION_ID);
      const old = head ? this.decode(head) : undefined;
      if (head && this.trustedHeadHash !== undefined && head.projectionHash !== this.trustedHeadHash) throw new Error('ERR_PROJECTION_CONFLICT');
      let meta;
      let claims: WorkModelClaim[] = [];
      let mode: MarkdownProjection['mode'] = 'full';
      if (head && old && this.trustedHeadHash === head.projectionHash && !options.forceFull) {
        const page = await this.store.loadChangesSince(head.sourceCursor);
        meta = page.meta;
        if (!page.fullSnapshotRequired && old.privacyEpoch === meta.privacyEpoch && old.incarnation === meta.incarnation) {
          claims = latestClaims([...old.claims.map(decodeWorkModelClaim), ...decodeRecords(page.records)]);
          mode = 'incremental';
        }
      }
      if (mode === 'full') {
        const snapshot = await this.store.readCanonicalSnapshot();
        meta = snapshot.meta;
        claims = latestClaims(decodeRecords(snapshot.business));
      }
      if (!meta || meta.recoveryMode !== 'NORMAL') throw new Error('ERR_RECOVERY_REQUIRED');
      const markdown = renderMarkdown(claims);
      const contentHash = sha256(markdown);
      // A new adapter reconstructs from Core before trusting any persisted cache.
      if (head?.sourceCursor === meta.cursor && old?.incarnation === (meta.incarnation ?? '') && old.contentHash !== contentHash) throw new Error('ERR_PROJECTION_CONFLICT');
      const payload = { version: MARKDOWN_PROJECTION_ID, privacyEpoch: meta.privacyEpoch, incarnation: meta.incarnation ?? '', claims, markdown, contentHash };
      this.assertEnabled();
      await this.store.publishProjection({
        projectionId: MARKDOWN_PROJECTION_ID, sourceCursor: meta.cursor,
        projectionHash: hashCanonical(payload), revision: (head?.revision ?? 0) + 1, payload,
      }, head?.sourceCursor ?? '0', { privacyEpoch: meta.privacyEpoch, incarnation: meta.incarnation, projectionHash: head?.projectionHash ?? null });
      this.trustedHeadHash = hashCanonical(payload);
      return { sourceCursor: meta.cursor, privacyEpoch: meta.privacyEpoch, incarnation: meta.incarnation, markdown, documentCount: claims.length, mode, contentHash };
    } finally { release(); }
  }

  async export(confirmation: { readonly capability: 'projection.export'; readonly confirmedHash: Hash; readonly acknowledgeIrrevocable: true }): Promise<MarkdownExport> {
    this.assertEnabled();
    if (confirmation.capability !== 'projection.export' || confirmation.acknowledgeIrrevocable !== true) throw new Error('ERR_EXPORT_CONFIRMATION');
    const release = this.store.beginInProcessRootMutation();
    try {
      const projection = await this.rebuild();
      if (projection.contentHash !== confirmation.confirmedHash) throw new Error('ERR_EXPORT_STALE');
      const meta = await this.store.getMeta();
      if (meta.recoveryMode !== 'NORMAL' || meta.cursor !== projection.sourceCursor || meta.privacyEpoch !== projection.privacyEpoch || meta.incarnation !== projection.incarnation) throw new Error('ERR_EXPORT_STALE');
      this.assertEnabled();
      return { ...projection, filename: 'proagi-knowledge.md', mediaType: 'text/markdown', highestClassification: 'local-sensitive', notice: 'LOCAL_FILE_CANNOT_BE_REMOTELY_REVOKED' };
    } finally { release(); }
  }
  disable(): void { this.enabled = false; }
  private assertEnabled(): void { if (!this.enabled) throw new Error('ERR_PROJECTION_DISABLED'); }
  private decode(head: ProjectionHeadRecord) {
    const result = payloadSchema.safeParse(head.payload);
    if (!result.success || hashCanonical(result.data) !== head.projectionHash || sha256(result.data.markdown) !== result.data.contentHash) throw new Error('ERR_PROJECTION_CONFLICT');
    // Even a consistently rehashed manual edit must not be mistaken for canonical knowledge.
    if (renderMarkdown(result.data.claims.map(decodeWorkModelClaim)) !== result.data.markdown) throw new Error('ERR_PROJECTION_CONFLICT');
    return result.data;
  }
}

function decodeRecords(records: readonly StoredRecord[]): WorkModelClaim[] {
  return records.filter((record) => record.recordType === 'work_model_claim_v1').map((record) => {
    const { contentHash, ...base } = record;
    if (hashCanonical(base) !== contentHash) throw new Error('ERR_PROJECTION_SOURCE');
    return decodeWorkModelClaim(record.payload);
  });
}
function latestClaims(claims: readonly WorkModelClaim[]): WorkModelClaim[] {
  const latest = new Map<string, WorkModelClaim>();
  for (const claim of claims) {
    const current = latest.get(claim.claimKey);
    if (current && current.revision === claim.revision && current.contentHash !== claim.contentHash) throw new Error('ERR_PROJECTION_SOURCE');
    if (!current || current.revision < claim.revision) latest.set(claim.claimKey, claim);
  }
  return [...latest.values()].sort((a, b) => a.claimKey < b.claimKey ? -1 : a.claimKey > b.claimKey ? 1 : 0);
}
// Escape active Markdown/Obsidian/HTML syntax, including embeds and remote images.
function literal(value: string): string {
  return [...value].map((char) => (char.codePointAt(0)! < 32 || char.codePointAt(0) === 127) ? ' ' : char).join('')
    .replace(/[&<>"'\\`*_{}[\]()#+.!|~:$=^-]/g, (char) => `&#${char.codePointAt(0)};`);
}
function renderMarkdown(claims: readonly WorkModelClaim[]): string {
  return [
    '---', 'proagi_projection: markdown-knowledge-v1', 'classification: local-sensitive', '---',
    '# ProAGI Knowledge', '', 'Read-only projection. Edit knowledge in ProAGI; exported copies cannot be remotely revoked.', '',
    ...claims.flatMap((claim) => [
      `## ${literal(claim.statement)}`, '',
      `- Status: ${claim.status === 'confirmed' ? 'user-confirmed' : 'inferred'} / ${claim.status}`,
      `- Revision: ${claim.revision}`, `- Confidence: ${claim.confidence}`,
      `- Scope: ${literal(claim.scope.projectKey ?? 'all')} / ${claim.scope.activityKind ?? 'other'}`,
      `- Evidence: ${claim.evidence.length} supporting; ${claim.counterEvidence.length} counter`,
      ...[...claim.evidence, ...claim.counterEvidence].map((ref) => `  - ${ref.role}: ${literal(ref.entityType)} / ${literal(ref.entityId)}`), '',
    ]),
  ].join('\n');
}
