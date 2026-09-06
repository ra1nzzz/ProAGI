import { IndexedDbM1bAdapter, makeBatch, toStoredRecord } from '../adapters/indexedDbM1b';
import { CommitResponseLostError } from '../adapters/m1bTypes';
import type { AtomicMutationBatch, StoredRecord } from '../adapters/m1bTypes';
import { sha256 } from '../domain/canonical';
import type { BehaviorEvent, CorrectionAction, CorrectionCommand, CorrectionRecord, KnowledgeHead, KnowledgeSnapshot, KnowledgeVersion, WorkModelClaim } from '../domain/types';
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

export interface BrowserRuntimeTestHooks {
  readonly afterCommitPersisted?: () => void | Promise<void>;
  readonly beforePurgeRelease?: () => void | Promise<void>;
}

export class BrowserInsightRuntime implements ObservationPort, CorrectionPort, ControlPort {
  private adapter = new IndexedDbM1bAdapter(DATABASE_NAME);
  private readonly clientId = crypto.randomUUID();
  private readonly purgeChannel: BroadcastChannel | null = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('proagi-purge-v1');
  private clientRenewal: ReturnType<typeof setInterval> | null = null;
  private operationGeneration = 0;
  private readonly purgeReleases = new Set<string>();
  private service = new InsightLoopService();
  private imported: ImportCommit | null = null;
  private started = false;
  private closed = false;
  private starting: Promise<void> | null = null;
  private pendingPreview: PendingPreview | null = null;
  private previewing: Promise<ImportCommit> | null = null;
  private lastDurableCursor: string | null = null;
  private lastStorageIncarnation: string | null = null;
  private ownCommitCursor: string | null = null;
  private purgeFenceCheck: Promise<boolean> | null = null;
  private closePromise: Promise<void> | null = null;
  private clearPromise: Promise<void> | null = null;
  private inFlightOperations = 0;
  private readonly operationDrainWaiters = new Set<() => void>();
  private readonly visibilityHandler = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') void this.withRuntimeOperation(() => this.catchUpPurgeFence()).catch(() => undefined);
  };
  private lifecycleFrozen = false;
  private readonly freezeHandler = () => { this.lifecycleFrozen = true; };
  private readonly resumeHandler = () => {
    this.lifecycleFrozen = false;
    void this.withRuntimeOperation(() => this.catchUpPurgeFence()).catch(() => undefined);
  };
  private readonly lifecycleHandler = () => {
    void this.withRuntimeOperation(() => this.catchUpPurgeFence()).catch(() => undefined);
  };
  private rootRegistered = true;
  private unregisterRuntimeRoot = this.registerRuntimeRoot();

  constructor(private readonly testHooks: BrowserRuntimeTestHooks = {}) {
    if (typeof document !== 'undefined') {
       document.addEventListener('visibilitychange', this.visibilityHandler);
       document.addEventListener('freeze', this.freezeHandler);
       document.addEventListener('resume', this.resumeHandler);
     }
     if (typeof window !== 'undefined') {
       window.addEventListener('pageshow', this.lifecycleHandler);
       window.addEventListener('focus', this.lifecycleHandler);
     }
    this.purgeChannel?.addEventListener('message', (event) => {
      const data = event.data as { type?: string; deletionId?: string; generation?: string; clientId?: string };
      if (data.clientId === this.clientId) return;
      if (data.type === 'PURGE_REQUEST' && data.deletionId && data.generation) {
        if (this.lifecycleFrozen) return;
        void this.withRuntimeOperation(() => this.releaseForPurge(data.deletionId!, data.generation!)).catch(() => undefined);
        return;
      }
      if (data.type === 'STATE_CHANGED' && !this.lifecycleFrozen) {
        void this.withRuntimeOperation(async () => {
          await this.catchUpPurgeFence();
          if (!this.closed) this.notifyRuntimeSnapshot(false);
        }).catch(() => undefined);
      }
    });
  }

  private async catchUpPurgeFence(): Promise<boolean> {
    if (this.purgeFenceCheck) return this.purgeFenceCheck;
    this.purgeFenceCheck = (async () => {
      const { meta, journals } = await this.adapter.readPurgeFence();
      const active = journals.find((item) => item.recordType === 'active_deletion_journal' && item.state !== 'FAILED');
      if (active) {
        await this.releaseForPurge(active.id, active.purge.generation);
        return true;
      }
      if (meta.recoveryMode !== 'NORMAL') {
        await this.releaseLocalRuntime();
        this.notifyRuntimeSnapshot(true, meta.observationMode);
        await this.awaitUiPurgeCommit('recovery-only', `${meta.cursor}:${meta.privacyEpoch}`);
        throw new Error('ERR_PURGE_IN_PROGRESS');
      }
      const previousCursor = this.lastDurableCursor;
      const incarnationChanged = this.lastStorageIncarnation !== null && meta.incarnation !== this.lastStorageIncarnation;
      const cursorRegressed = previousCursor !== null && BigInt(meta.cursor) < BigInt(previousCursor);
      if (cursorRegressed) {
        await this.releaseLocalRuntime();
        this.notifyRuntimeSnapshot(true, meta.observationMode);
        await this.awaitUiPurgeCommit('cursor-regression', `${meta.cursor}:${meta.privacyEpoch}`);
        throw new Error('ERR_CURSOR_CONFLICT');
      }
      const ownCommit = this.ownCommitCursor === meta.cursor;
      const durableAdvanced = !ownCommit && ((previousCursor !== null && BigInt(meta.cursor) > BigInt(previousCursor)) || incarnationChanged);
      const watermarks = meta.purgeWatermarks ?? (meta.purgeWatermark ? [meta.purgeWatermark] : []);
      const staleWatermark = durableAdvanced && previousCursor !== null
        ? watermarks.filter((watermark) => BigInt(watermark.cursor) > BigInt(previousCursor!)).sort((a, b) => BigInt(a.cursor) < BigInt(b.cursor) ? -1 : 1).at(-1)
        : undefined;
      const purgeAdvance = incarnationChanged || Boolean(meta.lastPurgeCursor && previousCursor !== null && BigInt(meta.lastPurgeCursor) > BigInt(previousCursor)) || Boolean(staleWatermark);
      if (durableAdvanced) {
        // Any unexplained external cursor advance invalidates in-memory state.
        // A durable purge cursor (or retained watermark) is required before
        // asking the UI to perform the destructive purge handshake.
        await this.releaseLocalRuntime();
        if (purgeAdvance) await this.awaitUiPurgeCommit(staleWatermark?.deletionId ?? 'cursor-gap', staleWatermark?.generation ?? 'unknown');
        await this.hydrate();
        this.notifyRuntimeSnapshot(purgeAdvance, meta.observationMode);
      }
      this.lastDurableCursor = meta.cursor;
      this.lastStorageIncarnation = meta.incarnation ?? null;
      return false;
    })().finally(() => { this.purgeFenceCheck = null; });
    return this.purgeFenceCheck;
  }

  private async awaitUiPurgeCommit(deletionId: string, generation: string): Promise<void> {
    if (typeof window === 'undefined' || !(window as Window & { __proagiPurgeUiBridge?: boolean }).__proagiPurgeUiBridge) return;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('ERR_PURGE_UI_UNCONFIRMED')), 2_000);
      const onCommitted = () => { window.clearTimeout(timer); resolve(); };
      window.dispatchEvent(new CustomEvent('proagi:external-purge', { detail: { deletionId, generation, onCommitted } }));
    });
  }

  private notifyRuntimeSnapshot(purge = false, observationMode?: 'ACTIVE' | 'PRIVATE', purgeVerified = false): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('proagi:runtime-snapshot', {
      detail: { imported: this.imported, observationMode, purge, purgeVerified },
    }));
  }

  private async releaseLocalRuntime(): Promise<void> {
    this.operationGeneration += 1;
    const pending = this.pendingPreview;
    this.pendingPreview = null;
    this.imported = null;
    this.service = new InsightLoopService();
    if (pending) await this.adapter.cancelPreview(pending.token).catch(() => undefined);
  }

  private async enforcePurgeFence(): Promise<void> {
    if (await this.catchUpPurgeFence()) throw new Error('ERR_PURGE_IN_PROGRESS');
  }

  private async releaseForPurge(deletionId: string, generation: string): Promise<void> {
    const releaseKey = `${deletionId}:${generation}`;
    if (this.purgeReleases.has(releaseKey)) return;
    this.purgeReleases.add(releaseKey);
    try {
      const { meta, journals } = await this.adapter.readPurgeFence();
      const journal = journals.find((item) => item.recordType === 'active_deletion_journal' && item.id === deletionId && item.purge.generation === generation);
      if (!journal || journal.state === 'FAILED') {
        if (!this.closed && meta.recoveryMode === 'NORMAL') this.notifyRuntimeSnapshot(false, meta.observationMode, true);
        return;
      }
      await this.testHooks.beforePurgeRelease?.();
      if (this.closed) return;
      await this.releaseLocalRuntime();
      await this.awaitUiPurgeCommit(deletionId, generation);
      if (this.closed) return;
      const latestFence = await this.adapter.readPurgeFence();
      const latestJournal = latestFence.journals.find((item) => item.recordType === 'active_deletion_journal' && item.id === deletionId && item.purge.generation === generation);
      if (latestJournal && !latestJournal.purge.sealedAt) await this.adapter.acknowledgePurge(deletionId, generation, this.clientId);
      const verified = await this.waitForPurgeVerification(deletionId, generation);
      if (verified && !this.closed) this.notifyRuntimeSnapshot(false, latestFence.meta.observationMode, true);
    } catch {
      this.purgeReleases.delete(releaseKey);
    }
  }

  private async waitForPurgeVerification(deletionId: string, generation: string): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    while (!this.closed && Date.now() < deadline) {
      const fence = await this.adapter.readPurgeFence();
      const active = fence.journals.some((item) => item.recordType === 'active_deletion_journal' && item.id === deletionId && item.purge.generation === generation);
      if (!active && fence.meta.recoveryMode === 'NORMAL') return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  async start(): Promise<BrowserRuntimeSnapshot> { return this.withRuntimeOperation(() => this.startInternal()); }

  private async startInternal(): Promise<BrowserRuntimeSnapshot> {
    if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
    if (!this.started) {
      this.starting ??= (async () => {
        const startGeneration = this.operationGeneration;
        const assertOpen = () => {
          if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
          if (startGeneration !== this.operationGeneration) throw new Error('ERR_OPERATION_STALE');
        };
        if (!this.rootRegistered) {
          this.unregisterRuntimeRoot = this.registerRuntimeRoot();
          this.rootRegistered = true;
        }
        await this.adapter.open();
        assertOpen();
        const registration = await this.adapter.registerClient(this.clientId);
        assertOpen();
        const { meta, journals } = await this.adapter.readPurgeFence();
        assertOpen();
        const failed = journals.find((item) => item.recordType === 'active_deletion_journal' && item.state === 'FAILED');
        if (failed) {
          await this.adapter.closeClient(this.clientId).catch(() => undefined);
          throw new Error('ERR_RECOVERY_FAILED');
        }
        this.clientRenewal ??= setInterval(() => { void this.withRuntimeOperation(() => this.adapter.renewClient(this.clientId)).catch(() => undefined); }, 2_000);
        if (registration.state === 'QUARANTINED') {
          const active = journals.find((item) => item.recordType === 'active_deletion_journal' && item.state !== 'FAILED');
          this.imported = null;
          this.service = new InsightLoopService();
          this.lastDurableCursor = meta.cursor;
          this.lastStorageIncarnation = meta.incarnation ?? null;
          if (active && !active.purge.sealedAt) {
            await this.awaitUiPurgeCommit(active.id, active.purge.generation);
            assertOpen();
            const latest = await this.adapter.readPurgeFence();
            const latestJournal = latest.journals.find((item) => item.recordType === 'active_deletion_journal' && item.id === active.id && item.purge.generation === active.purge.generation);
            if (latestJournal && !latestJournal.purge.sealedAt) await this.adapter.acknowledgePurge(active.id, active.purge.generation, this.clientId);
          }
        } else {
          const purgeActive = await this.catchUpPurgeFence();
          assertOpen();
          if (!purgeActive) await this.hydrate(0, startGeneration);
        }
        assertOpen();
        this.started = true;
      })().finally(() => { this.starting = null; });
      await this.starting;
    }
    if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
    return this.readSnapshot();
  }

  private freezeRuntimeRoot(): void {
    this.operationGeneration += 1;
    this.pendingPreview = null;
    this.imported = null;
    this.service = new InsightLoopService();
  }

  private registerRuntimeRoot(): () => void {
    return this.adapter.registerInProcessRoot('application.runtime', () => [
      this.imported, this.service.knowledge.snapshot(), this.pendingPreview?.commit,
    ], { freeze: () => this.freezeRuntimeRoot(), unfreeze: () => undefined });
  }

  currentClaim(): WorkModelClaim | null {
    const claimKey = this.imported?.output.claims[0]?.claimKey;
    return claimKey ? (this.service.knowledge.currentClaim(claimKey) ?? null) : null;
  }

  async preview(): Promise<ObservationPreviewDTO> {
    return this.withRuntimeOperation(async () => {
      const result = await this.previewBundled();
      const token = this.pendingPreview?.token;
      if (!token) throw new Error('ERR_PREVIEW_STALE');
      return {
        token, acceptedCount: result.acceptedCount, episodeCount: result.output.episodes.length,
        insightCount: result.output.claims.length, source: 'bundled-synthetic-fixture',
      };
    });
  }

  async commit(token: string): Promise<ImportCommit> {
    return this.withRuntimeOperation(async () => {
      await this.start();
      await this.enforcePurgeFence();
      if (!this.pendingPreview || this.pendingPreview.token !== token) throw new Error('ERR_PREVIEW_STALE');
      return this.commitBundled();
    });
  }

  async submit(action: Exclude<CorrectionAction, 'restore'>): Promise<CorrectionResult> {
    return this.withRuntimeOperation(() => this.correct(action));
  }

  async pausePrivacy(): Promise<{ readonly privacyEpoch: number }> {
    return this.withRuntimeOperation(async () => {
      const snapshot = await this.setPrivacyMode('PRIVATE');
      return { privacyEpoch: snapshot.privacyEpoch };
    });
  }

  async resumePrivacy(): Promise<{ readonly privacyEpoch: number }> {
    return this.withRuntimeOperation(async () => {
      const snapshot = await this.setPrivacyMode('ACTIVE');
      return { privacyEpoch: snapshot.privacyEpoch };
    });
  }

  async evaluateReplay() {
    return this.withRuntimeOperation(async () => {
      await this.start();
      await this.enforcePurgeFence();
      return this.replay();
    });
  }

  async previewBundled(now = Date.now()): Promise<ImportCommit> { return this.withRuntimeOperation(() => this.previewBundledInternal(now)); }

  private async previewBundledInternal(now = Date.now()): Promise<ImportCommit> {
    await this.start();
    await this.enforcePurgeFence();
    if (this.imported) return this.imported;
    if (this.pendingPreview) return this.pendingPreview.commit;
    this.previewing ??= this.createBundledPreview(now).finally(() => { this.previewing = null; });
    return this.previewing;
  }

  private async createBundledPreview(now: number): Promise<ImportCommit> {
    const generation = this.operationGeneration;
    const meta = await this.adapter.getMeta();
    if (generation !== this.operationGeneration) throw new Error('ERR_OPERATION_STALE');
    if (meta.observationMode !== 'ACTIVE') throw new Error('ERR_PRIVACY_MODE');
    const candidate = new InsightLoopService();
    const preview = candidate.preview(developerDayFixtureJson, now);
    const receipt = await candidate.commit(preview.token, crypto.randomUUID(), now);
    const idempotencyKey = crypto.randomUUID();
    const staged = await this.adapter.stagePreview({
      callerId: 'proagi-web', idempotencyKey, inputHash: sha256(developerDayFixtureJson),
      bytes: new TextEncoder().encode(developerDayFixtureJson), privacyEpoch: meta.privacyEpoch,
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    if (generation !== this.operationGeneration) {
      await this.adapter.cancelPreview(staged.token).catch(() => undefined);
      throw new Error('ERR_OPERATION_STALE');
    }
    const records = recordsForCommit(receipt.result, now);
    const batch = makeBatch({
      idempotencyKey, expectedCursor: meta.cursor, expectedPrivacyEpoch: meta.privacyEpoch,
      requiresActiveObservation: true, requiresPreview: true, storeNames: ['business'],
      mutations: records.map((record) => ({ kind: 'insertImmutable' as const, storeName: 'business' as const, record })),
    });
    try {
      await this.adapter.bindPreviewBatch(staged.token, batch.batchHash);
      const releaseMutation = this.adapter.beginInProcessRootMutation();
      try {
        if (generation !== this.operationGeneration || this.closed) throw new Error('ERR_OPERATION_STALE');
        this.pendingPreview = { candidate, commit: receipt.result, token: staged.token, batch, createdAt: now };
      } finally {
        releaseMutation();
      }
      return receipt.result;
    } catch (error) {
      await this.adapter.cancelPreview(staged.token).catch(() => undefined);
      throw error;
    }
  }

  async commitBundled(options: { simulateResponseLoss?: boolean } = {}): Promise<ImportCommit> { return this.withRuntimeOperation(() => this.commitBundledInternal(options)); }

  private async commitBundledInternal(options: { simulateResponseLoss?: boolean } = {}): Promise<ImportCommit> {
    const generation = this.operationGeneration;
    await this.start();
    await this.enforcePurgeFence();
    if (generation !== this.operationGeneration) throw new Error('ERR_OPERATION_STALE');
    if (this.imported) return this.imported;
    const pending = this.pendingPreview;
    if (!pending) throw new Error('ERR_PREVIEW_REQUIRED');
    let committedCursor: string | undefined;
    try {
      try {
        const commitResult = await this.adapter.commitPreview(pending.token, 'proagi-web', pending.batch, undefined, options.simulateResponseLoss === true);
        if (commitResult.ledger.idempotencyKey !== pending.batch.idempotencyKey || commitResult.ledger.batchHash !== pending.batch.batchHash) throw new Error('ERR_COMMIT_RECEIPT_INVALID');
        committedCursor = commitResult.cursor;
        this.ownCommitCursor = committedCursor;
      } catch (error) {
        if (!(error instanceof CommitResponseLostError)) {
          throw error;
        }
        try {
          // Retry the exact authenticated operation. The adapter validates the
          // consumed guard, caller, batch hash, receipt, and ledger together.
          const reconciled = await this.adapter.commitPreview(pending.token, 'proagi-web', pending.batch);
          if (reconciled.ledger.idempotencyKey !== pending.batch.idempotencyKey || reconciled.ledger.batchHash !== pending.batch.batchHash) throw new Error('ERR_COMMIT_RECEIPT_INVALID');
          committedCursor = reconciled.cursor;
          this.ownCommitCursor = committedCursor;
        } catch (retryError) {
          this.pendingPreview = null;
          throw retryError;
        }
      }
      this.purgeChannel?.postMessage({ type: 'STATE_CHANGED', clientId: this.clientId });
      await this.testHooks.afterCommitPersisted?.();
      if (generation !== this.operationGeneration) {
        this.pendingPreview = null;
        throw new Error('ERR_OPERATION_STALE');
      }
      const committedMeta = await this.adapter.getMeta();
      if (committedCursor === undefined || committedMeta.cursor !== committedCursor || committedMeta.privacyEpoch !== pending.batch.expectedPrivacyEpoch || committedMeta.recoveryMode !== 'NORMAL') {
        this.pendingPreview = null;
        await this.hydrate(0, generation).catch(() => undefined);
        throw new Error(committedMeta.recoveryMode === 'NORMAL' ? 'ERR_CURSOR_CONFLICT' : 'ERR_PURGE_IN_PROGRESS');
      }
      await this.enforcePurgeFence();
      if (generation !== this.operationGeneration) {
        this.pendingPreview = null;
        throw new Error('ERR_OPERATION_STALE');
      }
      const finalMeta = await this.adapter.getMeta();
      if (finalMeta.cursor !== committedMeta.cursor || finalMeta.privacyEpoch !== committedMeta.privacyEpoch || finalMeta.recoveryMode !== 'NORMAL') {
        this.pendingPreview = null;
        await this.hydrate(0, generation);
        throw new Error('ERR_CURSOR_CONFLICT');
      }
      const releaseMutation = this.adapter.beginInProcessRootMutation();
      try {
        if (generation !== this.operationGeneration) {
          this.pendingPreview = null;
          throw new Error('ERR_OPERATION_STALE');
        }
        this.lastDurableCursor = finalMeta.cursor;
        this.lastStorageIncarnation = finalMeta.incarnation ?? null;
        this.service = pending.candidate;
        this.imported = pending.commit;
        this.pendingPreview = null;
        return pending.commit;
      } finally {
        releaseMutation();
      }
    } finally {
      if (committedCursor !== undefined && this.ownCommitCursor === committedCursor) this.ownCommitCursor = null;
    }
  }

  async importBundled(now = Date.now()): Promise<ImportCommit> {
    return this.withRuntimeOperation(async () => {
      await this.previewBundled(now);
      return this.commitBundled();
    });
  }

  async setPrivacyMode(mode: 'ACTIVE' | 'PRIVATE'): Promise<BrowserRuntimeSnapshot> { return this.withRuntimeOperation(() => this.setPrivacyModeInternal(mode)); }

  private async setPrivacyModeInternal(mode: 'ACTIVE' | 'PRIVATE'): Promise<BrowserRuntimeSnapshot> {
    await this.start();
    await this.enforcePurgeFence();
    const meta = await this.adapter.getMeta();
    await this.adapter.setPrivacyMode(meta.cursor, meta.privacyEpoch, mode, crypto.randomUUID());
    this.lastDurableCursor = (await this.adapter.getMeta()).cursor;
    this.purgeChannel?.postMessage({ type: 'STATE_CHANGED', clientId: this.clientId });
    if (mode === 'PRIVATE') this.pendingPreview = null;
    return this.snapshot();
  }

  async correct(action: Exclude<CorrectionAction, 'restore'>): Promise<CorrectionResult> { return this.withRuntimeOperation(() => this.correctInternal(action)); }

  private async correctInternal(action: Exclude<CorrectionAction, 'restore'>): Promise<CorrectionResult> {
    const generation = this.operationGeneration;
    await this.start();
    await this.enforcePurgeFence();
    const metaBeforeCorrection = await this.adapter.getMeta();
    if (action !== 'delete' && metaBeforeCorrection.observationMode !== 'ACTIVE') throw new Error('ERR_PRIVACY_MODE_ACTIVE');
    const current = this.currentClaim();
    if (!current) throw new Error('ERR_NOT_FOUND');
     const baselineHead = await this.adapter.getRecord<StoredRecord>('heads', `knowledge-head:${current.claimKey}`);
     const baselineCursor = metaBeforeCorrection.cursor;
    const command: CorrectionCommand = {
      commandId: crypto.randomUUID(), targetClaimKey: current.claimKey, baseRevisionId: current.id, action,
      ...(action === 'edit' ? { statement: `${current.statement}（已由你缩小适用范围）`, scope: current.scope } : {}),
    };
    const correctionService = this.service.fork();
    const result = correctionService.correct(command);
    if (!result.ok) return result;

    if (action === 'delete') {
      let deleteRetried = false;
      try {
        await this.deleteClaimLineage(current);
        return result;
      } catch (error) {
        if (!this.closed && generation === this.operationGeneration) await this.hydrate(0, generation).catch(() => undefined);
        if (!deleteRetried && (error as { code?: string }).code === 'ERR_CURSOR_CONFLICT') { deleteRetried = true; await this.deleteClaimLineage(current); return result; }
        throw error;
      }
    }

    try {
      if (generation !== this.operationGeneration || this.closed) throw new Error('ERR_OPERATION_STALE');
      if (!result.claim || !result.head) throw new Error('ERR_KNOWLEDGE_LINEAGE');
      const version = correctionService.knowledge.snapshot().versions.find((item) => item.id === result.head!.versionId);
      if (!version) throw new Error('ERR_KNOWLEDGE_LINEAGE');
      const records = [
        toStoredRecord(result.record.id, 'correction_record_v1', result.record),
        toStoredRecord(result.claim.id, 'work_model_claim_v1', result.claim),
        toStoredRecord(version.id, 'knowledge_version_v1', version),
      ];
      const headRecord = toStoredRecord(`knowledge-head:${result.head.knowledgeKey}`, 'knowledge_head_v1', result.head);
      const priorHead = baselineHead;
      const batch = makeBatch({
        idempotencyKey: command.commandId, expectedCursor: baselineCursor, expectedPrivacyEpoch: metaBeforeCorrection.privacyEpoch,
         requiresActiveObservation: true,
        storeNames: ['business', 'heads'],
        mutations: [
          ...records.map((record) => ({ kind: 'insertImmutable' as const, storeName: 'business' as const, record })),
          { kind: 'casSingleton' as const, storeName: 'heads' as const, record: headRecord, expectedContentHash: priorHead?.contentHash ?? null },
        ],
      });
      const commitResult = await this.adapter.commit(batch);
       if (generation !== this.operationGeneration || this.closed) throw new Error('ERR_OPERATION_STALE');
       const durableMeta = await this.adapter.getMeta();
       const durableHead = await this.adapter.getRecord<StoredRecord>('heads', headRecord.recordId);
       if (durableMeta.cursor !== commitResult.cursor || durableMeta.privacyEpoch !== metaBeforeCorrection.privacyEpoch || durableMeta.recoveryMode !== 'NORMAL' || durableHead?.contentHash !== headRecord.contentHash) {
         await this.hydrate(0, generation);
         this.notifyRuntimeSnapshot(false, durableMeta.observationMode);
         return result;
       }
       const releaseMutation = this.adapter.beginInProcessRootMutation();
       try {
         if (generation !== this.operationGeneration || this.closed) throw new Error('ERR_OPERATION_STALE');
         this.service = correctionService;
         this.lastDurableCursor = commitResult.cursor;
         this.lastStorageIncarnation = durableMeta.incarnation ?? null;
         return result;
       } finally {
         releaseMutation();
       }
     } catch (error) {
      if (!this.closed && generation === this.operationGeneration) await this.hydrate(0, generation).catch(() => undefined);
      throw error;
    }
  }

  private async deleteClaimLineage(claim: WorkModelClaim): Promise<void> {
    const lineageAnchors = await this.collectClaimLineageAnchors(claim.claimKey);
    const target = await this.adapter.getRecord('business', claim.id) as StoredRecord | undefined;
    const storedClaim = target?.payload as WorkModelClaim | undefined;
    if (!target || storedClaim?.contentHash !== claim.contentHash) throw new Error('ERR_NOT_FOUND');
    const plan = await this.adapter.planDeletion({
      storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType,
      lineageAnchorDigests: lineageAnchors.map((anchor) => sha256(anchor)),
    });
    const ownerClientId = crypto.randomUUID();
    const startedAt = Date.now();
    const fenced = await this.adapter.fenceDeletion(plan, ownerClientId, startedAt);
    let journal = fenced.journal;
    while (journal.state === 'FENCED') {
      await this.adapter.renewRecoveryLease(ownerClientId, fenced.lease.fencingToken, Date.now());
      journal = await this.adapter.enumerateDeletionPage(journal.id, ownerClientId, fenced.lease.fencingToken, 128, Date.now());
    }
    while (journal.state === 'DELETING') {
      await this.adapter.renewRecoveryLease(ownerClientId, fenced.lease.fencingToken, Date.now());
      journal = await this.adapter.deleteChunk(journal.id, ownerClientId, fenced.lease.fencingToken, 128, Date.now());
    }

    if (this.imported) this.imported = withoutClaim(this.imported, claim, lineageAnchors);
    this.service = new InsightLoopService();
    await this.awaitUiPurgeCommit(journal.id, journal.purge.generation);
    if (journal.state === 'PURGE_PENDING') {
      await this.adapter.renewRecoveryLease(ownerClientId, fenced.lease.fencingToken, Date.now());
      this.purgeChannel?.postMessage({ type: 'PURGE_REQUEST', deletionId: journal.id, generation: journal.purge.generation, clientId: this.clientId });
      await this.adapter.acknowledgePurge(journal.id, journal.purge.generation, this.clientId, Date.now());
      if (!this.purgeChannel && journal.purge.requiredClientIds.some((clientId) => clientId !== this.clientId)) {
        throw new Error('ERR_PURGE_CLIENTS_PENDING');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let audit = await this.adapter.sealAndAudit(journal.id, ownerClientId, fenced.lease.fencingToken, Date.now());
    const waitUntil = Date.now() + 5_000;
    while (audit.outcome === 'CLIENTS_PENDING' && Date.now() < waitUntil) {
      await this.adapter.renewRecoveryLease(ownerClientId, fenced.lease.fencingToken, Date.now());
      this.purgeChannel?.postMessage({ type: 'PURGE_REQUEST', deletionId: journal.id, generation: journal.purge.generation, clientId: this.clientId });
      await new Promise((resolve) => setTimeout(resolve, 250));
      audit = await this.adapter.sealAndAudit(journal.id, ownerClientId, fenced.lease.fencingToken, Date.now());
    }
    if (audit.outcome !== 'CLEAN') {
      const roots = audit.receipts.filter((receipt) => receipt.forbiddenReferenceCount > 0)
        .map((receipt) => receipt.rootId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()).join('_');
      throw new Error(audit.outcome === 'CLIENTS_PENDING' ? 'ERR_PURGE_CLIENTS_PENDING' : `ERR_DELETE_REACHABLE_${roots || 'UNKNOWN'}`);
    }
    let finalizing = await this.adapter.finalizeDeletionPage(journal.id, ownerClientId, fenced.lease.fencingToken, 128, Date.now());
    while (!finalizing.finalizing.complete) {
      await this.adapter.renewRecoveryLease(ownerClientId, fenced.lease.fencingToken, Date.now());
      finalizing = await this.adapter.finalizeDeletionPage(journal.id, ownerClientId, fenced.lease.fencingToken, 128, Date.now());
    }
    try {
      await this.adapter.verifyDeletion(journal.id, ownerClientId, fenced.lease.fencingToken, Date.now());
    } catch (error) {
      if (!(error instanceof CommitResponseLostError)) throw error;
      // The transaction is already committed. Re-read the authenticated
      // terminal receipt instead of reporting a false delete failure.
      await this.adapter.verifyDeletion(journal.id, ownerClientId, fenced.lease.fencingToken, Date.now());
    }
    await this.hydrate(0, this.operationGeneration);
    const verifiedMeta = await this.adapter.getMeta();
    this.lastDurableCursor = verifiedMeta.cursor;
    this.notifyRuntimeSnapshot(false, verifiedMeta.observationMode, true);
  }

  private async collectClaimLineageAnchors(claimKey: string): Promise<readonly string[]> {
    const business = await this.adapter.scanPublishedBusiness();
    const heads = await this.adapter.getAll<StoredRecord>('heads');
    const lineageRecords = [...business, ...heads].filter((record) => recordTargetsClaimKey(record, claimKey));
    return [...new Set(lineageRecords.flatMap(identityAnchors))].sort();
  }

  async clear(): Promise<void> { return this.withRuntimeOperation(() => this.clearInternal()); }

  private async clearInternal(): Promise<void> {
    if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
    if (this.clearPromise) return this.clearPromise;
    this.clearPromise = (async () => {
      await this.start();
      if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
      const cachesCleared = await clearControlledCaches();
      const cleared = await this.adapter.clearAll({ cachesCleared });
      if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
      if (cleared.state !== 'SUCCEEDED') {
        await this.hydrate().catch(() => undefined);
        throw new Error('ERR_CLEAR_BLOCKED');
      }
      if (this.rootRegistered) {
        this.unregisterRuntimeRoot();
        this.rootRegistered = false;
      }
      this.adapter.dispose();
      this.adapter = new IndexedDbM1bAdapter(DATABASE_NAME);
      this.unregisterRuntimeRoot = this.registerRuntimeRoot();
      this.rootRegistered = true;
      this.started = false;
      this.service = new InsightLoopService();
      this.imported = null;
      this.pendingPreview = null;
      this.lastDurableCursor = null;
      this.lastStorageIncarnation = null;
      if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
      await this.start();
    })().finally(() => { this.clearPromise = null; });
    return this.clearPromise;
  }

  async recover(): Promise<void> { return this.withRuntimeOperation(() => this.recoverInternal()); }

  private async recoverInternal(): Promise<void> {
    await this.start();
    const { journals } = await this.adapter.readPurgeFence();
    let journal = journals.find((item) => item.recordType === 'active_deletion_journal' && item.state !== 'FAILED');
    if (!journal) return;
    await this.releaseLocalRuntime();
    await this.awaitUiPurgeCommit(journal.id, journal.purge.generation);
    const lease = await this.adapter.stealRecoveryLease(this.clientId, Date.now());
    while (journal.state === 'FENCED' || journal.state === 'DELETING') {
      await this.adapter.renewRecoveryLease(this.clientId, lease.fencingToken, Date.now());
      journal = journal.state === 'FENCED'
        ? await this.adapter.enumerateDeletionPage(journal.id, this.clientId, lease.fencingToken, 128, Date.now())
        : await this.adapter.deleteChunk(journal.id, this.clientId, lease.fencingToken, 128, Date.now());
    }
    if (journal.state === 'PURGE_PENDING') {
      journal = await this.adapter.retryPurge(journal.id, this.clientId, lease.fencingToken, [], Date.now());
      this.purgeChannel?.postMessage({ type: 'PURGE_REQUEST', deletionId: journal.id, generation: journal.purge.generation, clientId: this.clientId });
      await this.adapter.acknowledgePurge(journal.id, journal.purge.generation, this.clientId, Date.now());
    }
    if (journal.state === 'PURGE_PENDING' || journal.state === 'AUDITING') {
      await this.adapter.renewRecoveryLease(this.clientId, lease.fencingToken, Date.now());
      const audit = await this.adapter.sealAndAudit(journal.id, this.clientId, lease.fencingToken, Date.now());
      if (audit.outcome !== 'CLEAN') throw new Error(audit.outcome === 'CLIENTS_PENDING' ? 'ERR_PURGE_CLIENTS_PENDING' : 'ERR_DELETE_REACHABLE');
    }
    let finalizing = await this.adapter.finalizeDeletionPage(journal.id, this.clientId, lease.fencingToken, 128, Date.now());
    while (!finalizing.finalizing.complete) {
      await this.adapter.renewRecoveryLease(this.clientId, lease.fencingToken, Date.now());
      finalizing = await this.adapter.finalizeDeletionPage(journal.id, this.clientId, lease.fencingToken, 128, Date.now());
    }
    await this.adapter.renewRecoveryLease(this.clientId, lease.fencingToken, Date.now());
    await this.adapter.verifyDeletion(journal.id, this.clientId, lease.fencingToken, Date.now());
    await this.hydrate();
    this.notifyRuntimeSnapshot(true);
  }

  async replay() { return this.withRuntimeOperation(() => this.replayInternal()); }

  private async replayInternal() {
    await this.start();
    await this.enforcePurgeFence();
    if (!this.imported) throw new Error('ERR_NOT_FOUND');
    return this.service.replay();
  }

  async snapshot(): Promise<BrowserRuntimeSnapshot> { return this.withRuntimeOperation(() => this.snapshotInternal()); }

  private async snapshotInternal(): Promise<BrowserRuntimeSnapshot> {
    await this.start();
    await this.enforcePurgeFence();
    return this.readSnapshot();
  }

  private async readSnapshot(): Promise<BrowserRuntimeSnapshot> {
    const meta = await this.adapter.getMeta();
    return { observationMode: meta.observationMode, cursor: meta.cursor, privacyEpoch: meta.privacyEpoch, imported: this.imported };
  }

  private withRuntimeOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
    this.inFlightOperations += 1;
    let result: Promise<T>;
    try {
      result = operation();
    } catch (error) {
      this.releaseRuntimeOperation();
      throw error;
    }
    return result.finally(() => this.releaseRuntimeOperation());
  }

  private releaseRuntimeOperation(): void {
    this.inFlightOperations = Math.max(0, this.inFlightOperations - 1);
    if (this.inFlightOperations === 0) {
      const waiters = [...this.operationDrainWaiters];
      this.operationDrainWaiters.clear();
      waiters.forEach((resolve) => resolve());
    }
  }

  private waitForRuntimeOperations(): Promise<void> {
    if (this.inFlightOperations === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.operationDrainWaiters.add(resolve));
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.operationGeneration += 1;
    this.imported = null;
    this.service = new InsightLoopService();
    // Keep the closed root harmless until adapter disposal can detach it. If a
    // final verification owns quiescence, disposal is deferred by the adapter.
    this.rootRegistered = false;
    if (this.clientRenewal) clearInterval(this.clientRenewal);
    this.clientRenewal = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      document.removeEventListener('freeze', this.freezeHandler);
      document.removeEventListener('resume', this.resumeHandler);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pageshow', this.lifecycleHandler);
      window.removeEventListener('focus', this.lifecycleHandler);
    }
    this.purgeChannel?.close();
    const adapter = this.adapter;
    const pending = this.pendingPreview;
    this.pendingPreview = null;
    const startup = this.starting;
    const clearing = this.clearPromise;
    const shouldCloseClient = this.started || Boolean(startup);
    const operations = this.waitForRuntimeOperations();
    this.started = false;
    this.closePromise = (async () => {
      await startup?.catch(() => undefined);
      await clearing?.catch(() => undefined);
      await operations;
      if (pending) await adapter.cancelPreview(pending.token).catch(() => undefined);
      if (shouldCloseClient) await adapter.closeClient(this.clientId).catch(() => undefined);
      adapter.dispose();
    })();
    return this.closePromise;
  }

  private async hydrate(attempt = 0, expectedGeneration = this.operationGeneration): Promise<void> {
    const generation = expectedGeneration;
    if (this.closed || generation !== this.operationGeneration) throw new Error('ERR_OPERATION_STALE');
    const { meta: initialMeta, business: records, heads: headRecords } = await this.adapter.readCanonicalSnapshot();
    if (initialMeta.recoveryMode !== 'NORMAL') {
      await this.releaseLocalRuntime();
      return;
    }
    if (this.closed || generation !== this.operationGeneration) return;
    const marker = records.find((record) => record.recordId === FIXTURE_MARKER_ID) as StoredRecord<FixtureMarker> | undefined;
    const service = new InsightLoopService();
    service.restoreEvents(records.filter((record) => record.recordType === 'behavior_event_v1').map((record) => record.payload as BehaviorEvent));
    let imported: ImportCommit | null = null;
    if (marker) {
      const asOf = marker.payload.asOf;
      const preview = service.preview(developerDayFixtureJson, asOf);
      const receipt = await service.commit(preview.token, `hydrate:${marker.contentHash}`, asOf);
      const claims = records.filter((record) => record.recordType === 'work_model_claim_v1').map((record) => record.payload as WorkModelClaim);
      const versions = records.filter((record) => record.recordType === 'knowledge_version_v1').map((record) => record.payload as KnowledgeVersion);
      const corrections = records.filter((record) => record.recordType === 'correction_record_v1').map((record) => record.payload as CorrectionRecord);
      const hasStoredClaim = claims.length > 0;
      const base = receipt.result.output.claims[0];
      const snapshot: KnowledgeSnapshot = {
        claims,
        heads: headRecords.map((record) => record.payload as KnowledgeHead),
        versions,
        corrections,
        deletedClaimKeys: !hasStoredClaim && base ? [base.claimKey] : [],
      };
      service.knowledge.hydrate(snapshot);
      imported = !hasStoredClaim && base ? withoutClaim(receipt.result, base) : receipt.result;
    }
    if (generation !== this.operationGeneration) return;
    const { meta: stableMeta, journals } = await this.adapter.readPurgeFence();
    const active = journals.find((journal) => journal.recordType === 'active_deletion_journal' && journal.state !== 'FAILED');
    if (stableMeta.recoveryMode !== 'NORMAL' || active) {
      await this.releaseLocalRuntime();
      return;
    }
    if (this.closed || generation !== this.operationGeneration) return;
    if (stableMeta.cursor !== initialMeta.cursor || stableMeta.privacyEpoch !== initialMeta.privacyEpoch || stableMeta.incarnation !== initialMeta.incarnation) {
      await this.releaseLocalRuntime();
      if (attempt < 2) return this.hydrate(attempt + 1, this.operationGeneration);
      throw new Error('ERR_SNAPSHOT_CONFLICT');
    }
    const releaseMutation = this.adapter.beginInProcessRootMutation();
    try {
      if (this.closed || generation !== this.operationGeneration) return;
      this.service = service;
      this.imported = imported;
      this.lastDurableCursor = initialMeta.cursor;
      this.lastStorageIncarnation = initialMeta.incarnation ?? null;
    } finally {
      releaseMutation();
    }
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
