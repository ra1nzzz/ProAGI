import { IndexedDbM1bAdapter, makeBatch, toStoredRecord } from '../adapters/indexedDbM1b';
import type { AtomicMutationBatch, CommitLedgerRecord, StoredRecord } from '../adapters/m1bTypes';
import { hashCanonical } from '../domain/canonical';
import type { CorrectionAction, CorrectionCommand, CorrectionRecord, KnowledgeHead, KnowledgeSnapshot, KnowledgeVersion, WorkModelClaim } from '../domain/types';
import { developerDayFixtureJson } from '../fixtures/developerDay';
import type { CorrectionResult } from './knowledge';
import type { ControlPort, CorrectionPort, ObservationPort, ObservationPreviewDTO } from './ports';
import { InsightLoopService, type ImportCommit } from './insightService';

const DATABASE_NAME = 'proagi-insight-loop-m1-v1';
const FIXTURE_MARKER_ID = 'fixture-commit:developer-day-bundled-v1';

type FixtureMarker = { readonly asOf: number; readonly fixtureId: 'developer-day-bundled-v1' };
type PendingPreview = {
  readonly candidate: InsightLoopService;
  readonly commit: ImportCommit;
  readonly token: string;
  readonly batch: AtomicMutationBatch;
  readonly createdAt: number;
};

export interface BrowserRuntimeSnapshot {
  readonly observationMode: 'ACTIVE' | 'PRIVATE';
  readonly cursor: string;
  readonly privacyEpoch: number;
  readonly imported: ImportCommit | null;
}

export class BrowserInsightRuntime implements ObservationPort, CorrectionPort, ControlPort {
  private adapter = new IndexedDbM1bAdapter(DATABASE_NAME);
  private service = new InsightLoopService();
  private imported: ImportCommit | null = null;
  private started = false;
  private starting: Promise<void> | null = null;
  private pendingPreview: PendingPreview | null = null;
  private previewing: Promise<ImportCommit> | null = null;
  private unregisterRuntimeRoot = this.registerRuntimeRoot();

  async start(): Promise<BrowserRuntimeSnapshot> {
    if (!this.started) {
      this.starting ??= (async () => {
        await this.adapter.open();
        await this.hydrate();
        this.started = true;
      })().finally(() => { this.starting = null; });
      await this.starting;
    }
    return this.snapshot();
  }

  private registerRuntimeRoot(): () => void {
    return this.adapter.registerInProcessRoot('application.runtime', () => [
      this.imported, this.service.knowledge.snapshot(), this.pendingPreview?.commit,
    ]);
  }

  currentClaim(): WorkModelClaim | null {
    const claimKey = this.imported?.output.claims[0]?.claimKey;
    return claimKey ? (this.service.knowledge.currentClaim(claimKey) ?? null) : null;
  }

  async preview(): Promise<ObservationPreviewDTO> {
    if (this.imported) throw new Error('ERR_ALREADY_IMPORTED');
    const result = await this.previewBundled();
    const token = this.pendingPreview?.token;
    if (!token) throw new Error('ERR_PREVIEW_STALE');
    return {
      token, acceptedCount: result.acceptedCount, episodeCount: result.output.episodes.length,
      insightCount: result.output.claims.length, source: 'bundled-synthetic-fixture',
    };
  }

  async commit(token: string): Promise<ImportCommit> {
    if (!this.pendingPreview || this.pendingPreview.token !== token) throw new Error('ERR_PREVIEW_STALE');
    return this.commitBundled();
  }

  async submit(action: Exclude<CorrectionAction, 'restore'>): Promise<CorrectionResult> {
    return this.correct(action);
  }

  async pausePrivacy(): Promise<{ readonly privacyEpoch: number }> {
    const snapshot = await this.setPrivacyMode('PRIVATE');
    return { privacyEpoch: snapshot.privacyEpoch };
  }

  async resumePrivacy(): Promise<{ readonly privacyEpoch: number }> {
    const snapshot = await this.setPrivacyMode('ACTIVE');
    return { privacyEpoch: snapshot.privacyEpoch };
  }

  evaluateReplay() {
    return this.replay();
  }

  async previewBundled(now = Date.now()): Promise<ImportCommit> {
    await this.start();
    if (this.imported) return this.imported;
    if (this.pendingPreview) return this.pendingPreview.commit;
    this.previewing ??= this.createBundledPreview(now).finally(() => { this.previewing = null; });
    return this.previewing;
  }

  private async createBundledPreview(now: number): Promise<ImportCommit> {
    const meta = await this.adapter.getMeta();
    if (meta.observationMode !== 'ACTIVE') throw new Error('ERR_PRIVACY_MODE');
    const candidate = new InsightLoopService();
    const preview = candidate.preview(developerDayFixtureJson, now);
    const receipt = await candidate.commit(preview.token, crypto.randomUUID(), now);
    const idempotencyKey = crypto.randomUUID();
    const staged = await this.adapter.stagePreview({
      callerId: 'proagi-web', idempotencyKey, inputHash: hashCanonical(developerDayFixtureJson),
      bytes: new TextEncoder().encode(developerDayFixtureJson), privacyEpoch: meta.privacyEpoch,
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    const records = recordsForCommit(receipt.result, now);
    const batch = makeBatch({
      idempotencyKey, expectedCursor: meta.cursor, expectedPrivacyEpoch: meta.privacyEpoch,
      requiresActiveObservation: true, storeNames: ['business'],
      mutations: records.map((record) => ({ kind: 'insertImmutable' as const, storeName: 'business' as const, record })),
    });
    this.pendingPreview = { candidate, commit: receipt.result, token: staged.token, batch, createdAt: now };
    return receipt.result;
  }

  async commitBundled(options: { simulateResponseLoss?: boolean } = {}): Promise<ImportCommit> {
    await this.start();
    if (this.imported) return this.imported;
    const pending = this.pendingPreview;
    if (!pending) throw new Error('ERR_PREVIEW_REQUIRED');
    try {
      await this.adapter.commitPreview(pending.token, 'proagi-web', pending.batch, new Date().toISOString(), options.simulateResponseLoss === true);
    } catch (error) {
      const ledger = await this.adapter.getRecord('ledger', pending.batch.idempotencyKey) as CommitLedgerRecord | undefined;
      if (!ledger || ledger.batchHash !== pending.batch.batchHash) {
        await this.adapter.cancelPreview(pending.token).catch(() => undefined);
        this.pendingPreview = null;
        throw error;
      }
    }
    this.service = pending.candidate;
    this.imported = pending.commit;
    this.pendingPreview = null;
    return pending.commit;
  }

  async importBundled(now = Date.now()): Promise<ImportCommit> {
    await this.previewBundled(now);
    return this.commitBundled();
  }

  async setPrivacyMode(mode: 'ACTIVE' | 'PRIVATE'): Promise<BrowserRuntimeSnapshot> {
    await this.start();
    const meta = await this.adapter.getMeta();
    await this.adapter.setPrivacyMode(meta.cursor, meta.privacyEpoch, mode, crypto.randomUUID());
    if (mode === 'PRIVATE') this.pendingPreview = null;
    return this.snapshot();
  }

  async correct(action: Exclude<CorrectionAction, 'restore'>): Promise<CorrectionResult> {
    await this.start();
    const current = this.currentClaim();
    if (!current) throw new Error('ERR_NOT_FOUND');
    const command: CorrectionCommand = {
      commandId: crypto.randomUUID(), targetClaimKey: current.claimKey, baseRevisionId: current.id, action,
      ...(action === 'edit' ? { statement: `${current.statement}（已由你缩小适用范围）`, scope: current.scope } : {}),
    };
    const result = this.service.correct(command);
    if (!result.ok) return result;

    if (action === 'delete') {
      try {
        await this.deleteClaimLineage(current);
        return result;
      } catch (error) {
        await this.hydrate();
        throw error;
      }
    }

    try {
      const meta = await this.adapter.getMeta();
      if (!result.claim || !result.head) throw new Error('ERR_KNOWLEDGE_LINEAGE');
      const version = this.service.knowledge.snapshot().versions.find((item) => item.id === result.head!.versionId);
      if (!version) throw new Error('ERR_KNOWLEDGE_LINEAGE');
      const records = [
        toStoredRecord(result.record.id, 'correction_record_v1', result.record),
        toStoredRecord(result.claim.id, 'work_model_claim_v1', result.claim),
        toStoredRecord(version.id, 'knowledge_version_v1', version),
      ];
      const headRecord = toStoredRecord(`knowledge-head:${result.head.knowledgeKey}`, 'knowledge_head_v1', result.head);
      const priorHead = await this.adapter.getRecord('heads', headRecord.recordId) as StoredRecord | undefined;
      const batch = makeBatch({
        idempotencyKey: command.commandId, expectedCursor: meta.cursor, expectedPrivacyEpoch: meta.privacyEpoch,
        storeNames: ['business', 'heads'],
        mutations: [
          ...records.map((record) => ({ kind: 'insertImmutable' as const, storeName: 'business' as const, record })),
          { kind: 'casSingleton' as const, storeName: 'heads' as const, record: headRecord, expectedContentHash: priorHead?.contentHash ?? null },
        ],
      });
      await this.adapter.commit(batch);
      return result;
    } catch (error) {
      await this.hydrate();
      throw error;
    }
  }

  private async deleteClaimLineage(claim: WorkModelClaim): Promise<void> {
    const lineageAnchors = await this.collectClaimLineageAnchors(claim.claimKey);
    const target = await this.adapter.getRecord('business', claim.id) as StoredRecord | undefined;
    const storedClaim = target?.payload as WorkModelClaim | undefined;
    if (!target || storedClaim?.contentHash !== claim.contentHash) throw new Error('ERR_NOT_FOUND');
    const plan = await this.adapter.planDeletion({
      storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType, lineageAnchors,
    });
    const ownerClientId = crypto.randomUUID();
    const startedAt = Date.now();
    const fenced = await this.adapter.fenceDeletion(plan, ownerClientId, startedAt);
    let journal = fenced.journal;
    while (journal.state === 'FENCED') {
      journal = await this.adapter.enumerateDeletionPage(journal.id, ownerClientId, fenced.lease.fencingToken, 128, Date.now());
    }
    while (journal.state === 'DELETING') {
      journal = await this.adapter.deleteChunk(journal.id, ownerClientId, fenced.lease.fencingToken, 128, Date.now());
    }

    if (this.imported) this.imported = withoutClaim(this.imported, claim, lineageAnchors);
    if (journal.state === 'PURGE_PENDING') { /* no registered peer clients in M1 */
      void journal;
    }
    const audit = await this.adapter.sealAndAudit(journal.id, ownerClientId, fenced.lease.fencingToken, Date.now());
    if (audit.outcome !== 'CLEAN') {
      const roots = audit.receipts.filter((receipt) => receipt.forbiddenReferenceCount > 0)
        .map((receipt) => receipt.rootId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()).join('_');
      throw new Error(`ERR_DELETE_REACHABLE_${roots || 'UNKNOWN'}`);
    }
    let finalizing = await this.adapter.finalizeDeletionPage(journal.id, ownerClientId, fenced.lease.fencingToken, 128, Date.now());
    while (!finalizing.finalizing.complete) {
      finalizing = await this.adapter.finalizeDeletionPage(journal.id, ownerClientId, fenced.lease.fencingToken, 128, Date.now());
    }
    await this.adapter.verifyDeletion(journal.id, ownerClientId, fenced.lease.fencingToken, Date.now());
  }

  private async collectClaimLineageAnchors(claimKey: string): Promise<readonly string[]> {
    const business = await this.adapter.scanPublishedBusiness();
    const heads = await this.adapter.getAll<StoredRecord>('heads');
    const lineageRecords = [...business, ...heads].filter((record) => recordTargetsClaimKey(record, claimKey));
    return [...new Set(lineageRecords.flatMap(identityAnchors))].sort();
  }

  async clear(): Promise<void> {
    await this.start();
    const cachesCleared = await clearControlledCaches();
    const cleared = await this.adapter.clearAll({ cachesCleared });
    if (cleared.state !== 'SUCCEEDED') {
      await this.hydrate();
      throw new Error('ERR_CLEAR_BLOCKED');
    }
    this.unregisterRuntimeRoot();
    this.adapter.close();
    this.adapter = new IndexedDbM1bAdapter(DATABASE_NAME);
    this.unregisterRuntimeRoot = this.registerRuntimeRoot();
    this.started = false;
    this.service = new InsightLoopService();
    this.imported = null;
    this.pendingPreview = null;
    await this.start();
  }

  replay() {
    if (!this.imported) throw new Error('ERR_NOT_FOUND');
    return this.service.replay();
  }

  async snapshot(): Promise<BrowserRuntimeSnapshot> {
    const meta = await this.adapter.getMeta();
    return { observationMode: meta.observationMode, cursor: meta.cursor, privacyEpoch: meta.privacyEpoch, imported: this.imported };
  }

  close(): void {
    const adapter = this.adapter;
    const pending = this.pendingPreview;
    this.pendingPreview = null;
    if (pending) {
      void adapter.cancelPreview(pending.token).finally(() => adapter.close());
    } else {
      adapter.close();
    }
    if (this.starting) void this.starting.then(() => adapter.close(), () => undefined);
    this.started = false;
  }

  private async hydrate(): Promise<void> {
    const records = await this.adapter.scanPublishedBusiness();
    const marker = records.find((record) => record.recordId === FIXTURE_MARKER_ID) as StoredRecord<FixtureMarker> | undefined;
    if (!marker) {
      this.service = new InsightLoopService();
      this.imported = null;
      return;
    }
    const asOf = marker.payload.asOf;
    const service = new InsightLoopService();
    const preview = service.preview(developerDayFixtureJson, asOf);
    const receipt = await service.commit(preview.token, `hydrate:${marker.contentHash}`, asOf);
    const headRecords = await this.adapter.getAll<StoredRecord<KnowledgeHead>>('heads');
    const claims = records.filter((record) => record.recordType === 'work_model_claim_v1').map((record) => record.payload as WorkModelClaim);
    const versions = records.filter((record) => record.recordType === 'knowledge_version_v1').map((record) => record.payload as KnowledgeVersion);
    const corrections = records.filter((record) => record.recordType === 'correction_record_v1').map((record) => record.payload as CorrectionRecord);
    const hasStoredClaim = claims.length > 0;
    const base = receipt.result.output.claims[0];
    const snapshot: KnowledgeSnapshot = {
      claims,
      heads: headRecords.map((record) => record.payload),
      versions,
      corrections,
      deletedClaimKeys: !hasStoredClaim && base ? [base.claimKey] : [],
    };
    service.knowledge.hydrate(snapshot);
    this.service = service;
    this.imported = !hasStoredClaim && base ? withoutClaim(receipt.result, base) : receipt.result;
  }
}

function recordsForCommit(commit: ImportCommit, asOf: number): StoredRecord[] {
  const writtenAt = new Date(asOf).toISOString();
  const output = commit.output;
  const entities: Array<{ id: string; type: string; payload: unknown }> = [
    ...output.events.map((payload) => ({ id: payload.id, type: 'behavior_event_v1', payload })),
    ...output.episodes.map((payload) => ({ id: payload.id, type: 'episode_v1', payload })),
    ...output.claims.map((payload) => ({ id: payload.id, type: 'work_model_claim_v1', payload })),
    ...output.questions.map((payload) => ({ id: payload.id, type: 'question_v1', payload })),
    ...output.skillCandidates.map((payload) => ({ id: payload.id, type: 'skill_candidate_v1', payload })),
    ...output.actionIntents.map((payload) => ({ id: payload.id, type: 'action_intent_v1', payload })),
    { id: output.report.id, type: 'daily_report_snapshot_v1', payload: output.report },
    { id: FIXTURE_MARKER_ID, type: 'fixture_commit_v1', payload: { asOf, fixtureId: 'developer-day-bundled-v1' } satisfies FixtureMarker },
  ];
  return entities.map((entity) => toStoredRecord(entity.id, entity.type, entity.payload, writtenAt));
}

const LINEAGE_IDENTITY_FIELDS = [
  'id', 'contentHash', 'commandId', 'baseRevisionId', 'resultClaimRevisionId', 'parentRevisionId',
  'versionId', 'basedOnVersionId', 'causedByCorrectionId',
] as const;

function recordTargetsClaimKey(record: StoredRecord, claimKey: string): boolean {
  if (!record.payload || typeof record.payload !== 'object') return false;
  const payload = record.payload as Record<string, unknown>;
  return payload.claimKey === claimKey || payload.targetClaimKey === claimKey || payload.knowledgeKey === claimKey;
}

function identityAnchors(record: StoredRecord): string[] {
  const anchors = [record.recordId, record.contentHash];
  if (!record.payload || typeof record.payload !== 'object') return anchors;
  const payload = record.payload as Record<string, unknown>;
  for (const field of LINEAGE_IDENTITY_FIELDS) {
    if (typeof payload[field] === 'string') anchors.push(payload[field]);
  }
  return anchors;
}

function withoutClaim(commit: ImportCommit, claim: WorkModelClaim, lineageAnchors: readonly string[] = [claim.id]): ImportCommit {
  const anchorSet = new Set(lineageAnchors);
  return Object.freeze({
    ...commit,
    output: Object.freeze({
      ...commit.output,
      claims: commit.output.claims.filter((item) => item.claimKey !== claim.claimKey),
      report: Object.freeze({
        ...commit.output.report,
        sections: Object.freeze({
          ...commit.output.report.sections,
          learnedClaimIds: commit.output.report.sections.learnedClaimIds.filter((id) => !anchorSet.has(id)),
        }),
      }),
    }),
  });
}

async function clearControlledCaches(): Promise<boolean> {
  if (!('caches' in globalThis)) return true;
  try {
    const storage = globalThis.caches;
    const keys = await storage.keys();
    await Promise.all(keys.map((key) => storage.delete(key)));
    return (await storage.keys()).length === 0;
  } catch {
    return false;
  }
}
