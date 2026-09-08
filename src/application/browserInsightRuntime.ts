import { makeBatch, toStoredRecord, CommitResponseLostError } from './storageContracts';
import type { AtomicMutationBatch, StoredRecord } from './storageContracts';
import { hashCanonical, sha256 } from '../domain/canonical';
import { materializeJsonImportBehaviorEvents, parseFixtureJson } from '../domain/fixture';
import type { BehaviorEvent, CorrectionAction, CorrectionCommand, Hash, JsonImportInputIdentity, KnowledgeSnapshot, WorkModelClaim } from '../domain/types';
import { runInsightLoop } from '../domain/insightLoop';
import type { ReadonlyObservationAdapter } from './ports';
import { makeConsentGrant, makeConsentRevocation, makeRetentionPolicy, type ConsentGrant, type ConsentRevocation, type ReadonlyConsentSnapshot, type RetentionPolicy } from './m2Consent';
import { developerDayFixture, developerDayFixtureJson } from '../fixtures/developerDay';
import { validateBundledFixtureWithWorker, validateNdjsonStreamWithWorker } from '../workers/browserImport';
import { orderedEventsHash } from '../workers/ndjsonProtocol';
import type { CorrectionResult } from './knowledge';
import { EXTERNAL_PURGE_EVENT, PURGE_COMMITTED_EVENT, RUNTIME_ERROR_EVENT, RUNTIME_SNAPSHOT_EVENT, type ControlPort, type CorrectionPort, type ExternalPurgeNotification, type InsightServicePort, type ObservationPort, type ObservationPreviewDTO, type PurgeCommittedNotification, type RuntimeErrorNotification, type RuntimeNotificationPort, type RuntimeSnapshotNotification } from './ports';
import type { ImportCommit } from './insightService';
import { decodeBehaviorEvent, decodeCorrectionRecord, decodeFixtureMarker, decodeKnowledgeHead, decodeKnowledgeVersion, decodeWorkModelClaim } from './persistedDecoders';
import type { RuntimeStoragePort } from './storagePort';
import { assertTraceRecord, makeTraceExportPreview, TraceRecorder, type TraceCounts, type TraceEventName, type TraceExportPreview, type TraceManualCheck, type TraceRecord, type TraceResultCode } from './trace';

const FIXTURE_MARKER_ID = 'fixture-commit:developer-day-bundled-v1';
const PURGE_CLIENT_WAIT_MS = 15_000;
const PURGE_CLIENT_LEASE_MS = 6_000;
const CACHE_CLEAR_TIMEOUT_MS = 10_000;
const PURGE_UI_TIMEOUT_MS = 2_000;
const READONLY_PREVIEW_TTL_MS = 5 * 60_000;

export interface BrowserRuntimeScheduler {
  readonly setTimeout: typeof setTimeout;
  readonly clearTimeout: typeof clearTimeout;
  readonly setInterval: typeof setInterval;
  readonly clearInterval: typeof clearInterval;
}

export interface BrowserRuntimeCacheStore {
  keys(): Promise<string[]>;
  delete(request: string): Promise<boolean>;
}

const DEFAULT_RUNTIME_SCHEDULER: BrowserRuntimeScheduler = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};

const defaultCacheStore = (): BrowserRuntimeCacheStore | null => 'caches' in globalThis ? globalThis.caches : null;

const NOOP_RUNTIME_NOTIFICATION_PORT: RuntimeNotificationPort = Object.freeze({
  prepareForPurge: async () => undefined,
  publishSnapshot: () => undefined,
  publishError: () => undefined,
});

export function createWindowRuntimeNotificationPort(): RuntimeNotificationPort {
  return {
    prepareForPurge: (detail) => {
      if (typeof window === 'undefined') return Promise.resolve();
      const requestId = crypto.randomUUID();
      return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          window.clearTimeout(timer);
          window.removeEventListener(PURGE_COMMITTED_EVENT, onCommitted);
        };
        const onCommitted = (event: Event) => {
          const committed = (event as CustomEvent<PurgeCommittedNotification>).detail;
          if (committed?.requestId !== requestId) return;
          cleanup();
          resolve();
        };
        const timer = window.setTimeout(() => {
          cleanup();
          reject(new Error('ERR_PURGE_UI_UNCONFIRMED'));
        }, PURGE_UI_TIMEOUT_MS);
        window.addEventListener(PURGE_COMMITTED_EVENT, onCommitted);
        const notification: ExternalPurgeNotification = { ...detail, requestId };
        window.dispatchEvent(new CustomEvent<ExternalPurgeNotification>(EXTERNAL_PURGE_EVENT, { detail: notification }));
      });
    },
    publishSnapshot: (detail) => {
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<RuntimeSnapshotNotification>(RUNTIME_SNAPSHOT_EVENT, { detail }));
    },
    publishError: (detail) => {
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<RuntimeErrorNotification>(RUNTIME_ERROR_EVENT, { detail }));
    },
  };
}

type FixtureMarker = { readonly asOf: number; readonly fixtureId: 'developer-day-bundled-v1' };
type PurgeChannelMessage =
  | { readonly type: 'STATE_CHANGED'; readonly clientId: string }
  | { readonly type: 'PURGE_REQUEST'; readonly deletionId: string; readonly generation: string; readonly clientId: string };

function decodePurgeChannelMessage(value: unknown): PurgeChannelMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.clientId !== 'string' || candidate.clientId.length === 0 || typeof candidate.type !== 'string') return undefined;
  if (candidate.type === 'STATE_CHANGED') return { type: 'STATE_CHANGED', clientId: candidate.clientId };
  if (candidate.type === 'PURGE_REQUEST' && typeof candidate.deletionId === 'string' && candidate.deletionId.length > 0 && typeof candidate.generation === 'string' && candidate.generation.length > 0) {
    return { type: 'PURGE_REQUEST', deletionId: candidate.deletionId, generation: candidate.generation, clientId: candidate.clientId };
  }
  return undefined;
}

type GuardPendingPreview = {
  readonly kind: 'guard';
  readonly candidate: InsightServicePort;
  readonly commit: ImportCommit;
  readonly token: string;
  readonly batch: AtomicMutationBatch;
  readonly createdAt: number;
};

type NdjsonPendingPreview = {
  readonly kind: 'ndjson';
  readonly candidate: InsightServicePort;
  readonly commit: ImportCommit;
  readonly token: string;
  readonly createdAt: number;
  readonly streamId: string;
  readonly inputIdentity: JsonImportInputIdentity;
  readonly appCanonicalEventsHash: Hash;
  readonly workerRawBytes: number;
  readonly privacyEpoch: number;
  readonly events: readonly BehaviorEvent[];
  readonly records: readonly StoredRecord[];
};

type PendingPreview = GuardPendingPreview | NdjsonPendingPreview;

export interface BrowserRuntimeSnapshot {
  readonly observationMode: 'ACTIVE' | 'PRIVATE';
  readonly cursor: string;
  readonly privacyEpoch: number;
  readonly imported: ImportCommit | null;
  readonly runtimeFaulted: boolean;
  readonly readonlyConsent: ReadonlyConsentSnapshot | null;
}

export interface BrowserRuntimeTestHooks {
  readonly afterCommitPersisted?: () => void | Promise<void>;
  readonly beforePurgeRelease?: () => void | Promise<void>;
  readonly simulateDeletionResponseLoss?: () => boolean;
}

// Storage is injected through the independent application port; IndexedDB is only the browser default.
export interface BrowserInsightRuntimeOptions {
  readonly adapterFactory: () => RuntimeStoragePort;
  readonly serviceFactory: () => InsightServicePort;
  readonly readonlyAdapter: ReadonlyObservationAdapter;
  readonly channelFactory?: () => BroadcastChannel | null;
  readonly clientIdFactory?: () => string;
  readonly clock?: () => number;
  readonly scheduler?: BrowserRuntimeScheduler;
  readonly cacheStore?: BrowserRuntimeCacheStore | null;
  readonly notificationPort?: RuntimeNotificationPort;
  readonly cacheClearTimeoutMs?: number;
  readonly testHooks?: BrowserRuntimeTestHooks;
  readonly trace?: TraceRecorder;
  readonly workerFactory?: (() => Worker) | null;
}

export class BrowserInsightRuntime implements ObservationPort, CorrectionPort, ControlPort {
  private readonly adapterFactory: () => RuntimeStoragePort;
  private adapter: RuntimeStoragePort;
  private readonly clientId: string;
  private readonly purgeChannel: BroadcastChannel | null;
  private readonly serviceFactory: () => InsightServicePort;
  private readonly readonlyAdapter: ReadonlyObservationAdapter;
  private readonly notificationPort: RuntimeNotificationPort;
  private readonly clock: () => number;
  private readonly scheduler: BrowserRuntimeScheduler;
  private readonly cacheStore: BrowserRuntimeCacheStore | null;
  private readonly trace: TraceRecorder;
  private readonly workerFactory: (() => Worker) | null;
  private clientRenewal: ReturnType<typeof setInterval> | null = null;
  private clientRegistered = false;
  private operationGeneration = 0;
  private readonly purgeReleases = new Set<string>();
  private service: InsightServicePort;
  private imported: ImportCommit | null = null;
  private started = false;
  private closed = false;
  private runtimeFaulted = false;
  private starting: Promise<void> | null = null;
  private pendingPreview: PendingPreview | null = null;
  private previewing: Promise<ImportCommit> | null = null;
  private lastDurableCursor: string | null = null;
  private lastStorageIncarnation: string | null = null;
  private ownCommitCursor: string | null = null;
  private purgeFenceCheck: Promise<boolean> | null = null;
  private closePromise: Promise<void> | null = null;
  private clearPromise: Promise<void> | null = null;
  private pendingTraceExport: TraceExportPreview | null = null;
  private readonly cacheClearTimeoutMs: number;
  private inFlightOperations = 0;
  private readonly operationDrainWaiters = new Set<() => void>();
  private readonly visibilityHandler = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') this.runBackgroundOperation('visibility-catch-up', () => this.catchUpPurgeFence());
  };
  private lifecycleFrozen = false;
  private readonly freezeHandler = () => { this.lifecycleFrozen = true; };
  private readonly resumeHandler = () => {
    this.lifecycleFrozen = false;
    this.runBackgroundOperation('lifecycle-resume-catch-up', () => this.catchUpPurgeFence());
  };
  private readonly lifecycleHandler = () => {
    this.runBackgroundOperation('lifecycle-catch-up', () => this.catchUpPurgeFence());
  };
  private rootRegistered = false;
  private unregisterRuntimeRoot!: () => void;
  private readonly testHooks: BrowserRuntimeTestHooks;
  private readonlyConsent: ReadonlyConsentSnapshot | null = null;
  private readonlyConsentLoaded = false;
  private readonly purgeMessageHandler = (event: MessageEvent<unknown>) => {
    const data = decodePurgeChannelMessage(event.data);
    if (!data) {
      this.reportBackgroundFailure('purge-channel-protocol', new Error('ERR_PURGE_PROTOCOL_INVALID'));
      return;
    }
    if (data.clientId === this.clientId) return;
    if (data.type === 'PURGE_REQUEST') {
      if (this.lifecycleFrozen) return;
      this.runBackgroundOperation('external-purge-release', () => this.releaseForPurge(data.deletionId, data.generation));
      return;
    }
    if (!this.lifecycleFrozen && this.started && this.inFlightOperations === 0) {
      void this.withRuntimeOperation(async () => {
        await this.catchUpPurgeFence();
        if (!this.closed) this.notifyRuntimeSnapshot(false);
      }, false, 'runtime.background').catch((error) => this.reportBackgroundFailure('state-change-catch-up', error));
    }
  };

  constructor(options: BrowserInsightRuntimeOptions) {
    this.testHooks = options.testHooks ?? {};
    this.adapterFactory = options.adapterFactory;
    this.serviceFactory = options.serviceFactory;
    this.readonlyAdapter = options.readonlyAdapter;
    this.notificationPort = options.notificationPort ?? NOOP_RUNTIME_NOTIFICATION_PORT;
    this.clock = options.clock ?? Date.now;
    this.scheduler = options.scheduler ?? DEFAULT_RUNTIME_SCHEDULER;
    this.cacheStore = options.cacheStore === undefined ? defaultCacheStore() : options.cacheStore;
    this.workerFactory = options.workerFactory ?? null;
    this.adapter = this.adapterFactory();
    this.trace = options.trace ?? new TraceRecorder({ appendTraceEvents: (events) => this.adapter.appendTraceEvents(events) }, this.clock);
    this.service = this.serviceFactory();
    this.clientId = (options.clientIdFactory ?? (() => crypto.randomUUID()))();
    this.purgeChannel = (options.channelFactory ?? (() => typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('proagi-purge-v1')))();
    this.cacheClearTimeoutMs = options.cacheClearTimeoutMs ?? CACHE_CLEAR_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.cacheClearTimeoutMs) || this.cacheClearTimeoutMs <= 0) throw new Error('ERR_CACHE_CLEAR_TIMEOUT_INVALID');
    this.unregisterRuntimeRoot = this.registerRuntimeRoot();
    this.rootRegistered = true;
    if (typeof document !== 'undefined') {
       document.addEventListener('visibilitychange', this.visibilityHandler);
       document.addEventListener('freeze', this.freezeHandler);
       document.addEventListener('resume', this.resumeHandler);
     }
     if (typeof window !== 'undefined') {
       window.addEventListener('pageshow', this.lifecycleHandler);
       window.addEventListener('focus', this.lifecycleHandler);
     }
    this.purgeChannel?.addEventListener('message', this.purgeMessageHandler);

   }

  private async catchUpPurgeFence(): Promise<boolean> {
    if (this.purgeFenceCheck) return this.purgeFenceCheck;
    this.purgeFenceCheck = (async () => {
      const observedGeneration = this.operationGeneration;
      const { meta, journals } = await this.adapter.readPurgeFence();
      if (this.closed || observedGeneration !== this.operationGeneration) return false;
      const active = journals.find((item) => item.recordType === 'active_deletion_journal' && item.state !== 'FAILED');
      if (active) {
        this.pendingTraceExport = null;
        await this.releaseForPurge(active.id, active.purge.generation);
        return true;
      }
      if (meta.recoveryMode !== 'NORMAL') {
        this.pendingTraceExport = null;
        await this.releaseLocalRuntime();
        if (this.closed) return false;
        this.notifyRuntimeSnapshot(true, meta.observationMode);
        await this.awaitUiPurgeCommit('recovery-only', `${meta.cursor}:${meta.privacyEpoch}`);
        if (this.closed) return false;
        throw new Error('ERR_PURGE_IN_PROGRESS');
      }
      const previousCursor = this.lastDurableCursor;
      const incarnationChanged = this.lastStorageIncarnation !== null && meta.incarnation !== this.lastStorageIncarnation;
      const cursorRegressed = previousCursor !== null && BigInt(meta.cursor) < BigInt(previousCursor);
      if (cursorRegressed) {
        await this.releaseLocalRuntime();
        if (this.closed) return false;
        this.notifyRuntimeSnapshot(true, meta.observationMode);
        await this.awaitUiPurgeCommit('cursor-regression', `${meta.cursor}:${meta.privacyEpoch}`);
        if (this.closed) return false;
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
        this.pendingTraceExport = null;
        // Any unexplained external cursor advance invalidates in-memory state.
        // A durable purge cursor (or retained watermark) is required before
        // asking the UI to perform the destructive purge handshake.
        await this.releaseLocalRuntime();
        if (this.closed) return false;
        if (purgeAdvance) await this.awaitUiPurgeCommit(staleWatermark?.deletionId ?? 'cursor-gap', staleWatermark?.generation ?? 'unknown');
        if (this.closed) return false;
        await this.hydrate();
        if (this.closed) return false;
        this.notifyRuntimeSnapshot(purgeAdvance, meta.observationMode, Boolean(staleWatermark), Boolean(staleWatermark));
      }
      this.lastDurableCursor = meta.cursor;
      this.lastStorageIncarnation = meta.incarnation ?? null;
      return false;
    })().finally(() => { this.purgeFenceCheck = null; });
    return this.purgeFenceCheck;
  }

  private async awaitUiPurgeCommit(deletionId: string, generation: string, source: 'owner' | 'external' = 'external'): Promise<void> {
    await this.notificationPort.prepareForPurge({ deletionId, generation, external: source === 'external' });
  }

  private notifyRuntimeSnapshot(purge = false, observationMode?: 'ACTIVE' | 'PRIVATE', purgeVerified = false, externalPurge = false): void {
    const detail: RuntimeSnapshotNotification = { imported: this.imported, observationMode, purge, purgeVerified, externalPurge, runtimeFaulted: this.runtimeFaulted };
    this.notificationPort.publishSnapshot(detail);
  }

  private runBackgroundOperation(operation: string, task: () => Promise<unknown>): void {
    try {
      void this.withRuntimeOperation(task, false, 'runtime.background').catch((error) => this.reportBackgroundFailure(operation, error));
    } catch (error) {
      this.reportBackgroundFailure(operation, error);
    }
  }

  private async bestEffort(operation: string, task: () => Promise<unknown>): Promise<void> {
    try { await task(); } catch (error) { this.reportBackgroundFailure(operation, error); }
  }

  private reportBackgroundFailure(operation: string, error: unknown): void {
    if (isBenignRuntimeError(error)) return;
    this.latchRuntimeFault(error);
    const detail: RuntimeErrorNotification = { operation, code: runtimeErrorCode(error), runtimeFaulted: this.runtimeFaulted };
    this.notificationPort.publishError(detail);
  }

  private latchRuntimeFault(error: unknown): void {
    if (!isBenignRuntimeError(error)) this.runtimeFaulted = true;
  }

  private async releaseLocalRuntime(): Promise<void> {
    this.operationGeneration += 1;
    const pending = this.pendingPreview;
    this.pendingPreview = null;
    this.imported = null;
    this.service = this.serviceFactory();
    if (pending?.kind === 'guard') await this.bestEffort('release-runtime-preview-cancel', () => this.adapter.cancelPreview(pending.token));
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
      if (!journal) {
        if (!this.closed && meta.recoveryMode === 'NORMAL' && await this.hasVerifiedPurgeReceipt(deletionId)) this.notifyRuntimeSnapshot(false, meta.observationMode, true, true);
        return;
      }
      if (journal.state === 'FAILED') return;
      await this.testHooks.beforePurgeRelease?.();
      if (this.closed) return;
      await this.releaseLocalRuntime();
      await this.awaitUiPurgeCommit(deletionId, generation);
      if (this.closed) return;
      const latestFence = await this.adapter.readPurgeFence();
      const latestJournal = latestFence.journals.find((item) => item.recordType === 'active_deletion_journal' && item.id === deletionId && item.purge.generation === generation);
      if (latestJournal && !latestJournal.purge.sealedAt) await this.adapter.acknowledgePurge(deletionId, generation, this.clientId);
      const verified = await this.waitForPurgeVerification(deletionId, generation);
      if (verified && !this.closed) this.notifyRuntimeSnapshot(false, latestFence.meta.observationMode, true, true);
    } catch (error) {
      this.reportBackgroundFailure('purge-release', error);
      // A later lifecycle notification may retry the same generation. The
      // durable journal/receipt, rather than this in-memory guard, is the
      // idempotency authority.
    } finally {
      this.purgeReleases.delete(releaseKey);
    }
  }

  private async waitForPurgeVerification(deletionId: string, generation: string): Promise<boolean> {
    const deadline = this.clock() + 10_000;
    while (!this.closed && this.clock() < deadline) {
      const fence = await this.adapter.readPurgeFence();
      const active = fence.journals.find((item) => item.recordType === 'active_deletion_journal' && item.id === deletionId && item.purge.generation === generation);
      if (active?.state === 'FAILED') return false;
      if (!active && fence.meta.recoveryMode === 'NORMAL') return this.hasVerifiedPurgeReceipt(deletionId);
      await new Promise((resolve) => this.scheduler.setTimeout(resolve, 100));
    }
    return false;
  }

  private async hasVerifiedPurgeReceipt(deletionId: string): Promise<boolean> {
    try {
      await this.adapter.verifyDeletion(deletionId, this.clientId, '');
      return true;
    } catch (error) {
      if (runtimeErrorCode(error) === 'ERR_DELETION_STATE') return false;
      throw error;
    }
  }

  async start(): Promise<BrowserRuntimeSnapshot> { return this.withRuntimeOperation(() => this.startInternal(), true, 'runtime.start'); }

  private async startInternal(): Promise<BrowserRuntimeSnapshot> {
    if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
    if (!this.started) {
      this.starting ??= (async () => {
        try {
        let expectedGeneration = this.operationGeneration;
        const assertOpen = () => {
          if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
          if (expectedGeneration !== this.operationGeneration) throw new Error('ERR_OPERATION_STALE');
        };
        if (!this.rootRegistered) {
          this.unregisterRuntimeRoot = this.registerRuntimeRoot();
          this.rootRegistered = true;
        }
        await this.adapter.open();
        assertOpen();
        const registration = await this.adapter.registerClient(this.clientId);
        this.clientRegistered = true;
        assertOpen();
        const { meta, journals } = await this.adapter.readPurgeFence();
        assertOpen();
        const failed = journals.find((item) => item.recordType === 'active_deletion_journal' && item.state === 'FAILED');
        if (failed) {
          await this.bestEffort('close-client-after-start-failure', () => this.adapter.closeClient(this.clientId));
          this.clientRegistered = false;
          throw new Error('ERR_RECOVERY_FAILED');
        }
        this.clientRenewal ??= this.scheduler.setInterval(() => { this.runBackgroundOperation('client-lease-renewal', () => this.adapter.renewClient(this.clientId)); }, 2_000);
        if (registration.state === 'QUARANTINED') {
          const active = journals.find((item) => item.recordType === 'active_deletion_journal' && item.state !== 'FAILED');
          this.imported = null;
          this.service = this.serviceFactory();
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
          // Catch-up may intentionally advance the runtime generation while
          // releasing stale local state. Continue under that new generation;
          // only close or an unrelated mutation remains stale.
          expectedGeneration = this.operationGeneration;
          assertOpen();
          if (!purgeActive) await this.hydrate(0, expectedGeneration);
        }
        assertOpen();
        this.started = true;
        } catch (error) {
          if (this.clientRenewal) this.scheduler.clearInterval(this.clientRenewal);
          this.clientRenewal = null;
          if (this.clientRegistered) {
            await this.bestEffort('close-client-after-start-failure', () => this.adapter.closeClient(this.clientId));
            this.clientRegistered = false;
          }
          this.imported = null;
          this.service = this.serviceFactory();
          throw error;
        }
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
    this.service = this.serviceFactory();
  }

  private registerRuntimeRoot(): () => void {
    return this.adapter.registerInProcessRoot('application.runtime', () => [
      this.imported, this.service.knowledgeSnapshot(), this.pendingPreview?.commit,
    ], { freeze: () => this.freezeRuntimeRoot(), unfreeze: () => undefined });
  }

  currentClaim(): WorkModelClaim | null {
    const claimKey = this.imported?.output.claims[0]?.claimKey;
    return claimKey ? (this.service.currentClaim(claimKey) ?? null) : null;
  }

  async getReadonlyConsent(): Promise<ReadonlyConsentSnapshot | null> {
    return this.withRuntimeOperation(async () => {
      await this.start();
      return this.loadReadonlyConsent();
    }, true, 'runtime.snapshot');
  }

  async revokeConsent(consentId?: string): Promise<void> {
    return this.revokeReadonlyConsent(consentId);
  }

  async shortenReadonlyRetention(input: { readonly eventTtlDays: number; readonly derivedTtlDays: number }): Promise<ReadonlyConsentSnapshot> {
    return this.withRuntimeOperation(async () => {
      await this.start();
      await this.enforcePurgeFence();
      const snapshot = await this.loadReadonlyConsent();
      if (!snapshot || snapshot.revoked) throw new Error('ERR_CONSENT_STALE');
      const now = readM2Clock(this.clock);
      if (input.eventTtlDays > snapshot.policy.eventTtlDays || input.derivedTtlDays > snapshot.policy.derivedTtlDays) {
        throw new Error('ERR_RETENTION_EXTENSION_REQUIRES_CONSENT');
      }
      const policy = makeRetentionPolicy(snapshot.policy.id, input.eventTtlDays, input.derivedTtlDays);
      if (policy.eventTtlDays === snapshot.policy.eventTtlDays && policy.derivedTtlDays === snapshot.policy.derivedTtlDays) return snapshot;
      const policyRecordId = `retention-policy:${snapshot.grant.retentionPolicyId}`;
      const currentPolicyRecord = await this.adapter.getRecord<StoredRecord>('system', policyRecordId);
      if (!currentPolicyRecord || currentPolicyRecord.recordType !== 'retention_policy_v1') throw new Error('ERR_RETENTION_POLICY_MISSING');
      assertConsentRecord(currentPolicyRecord);
      const pending = this.pendingPreview;
      this.pendingPreview = null;
      if (pending?.kind === 'guard') await this.bestEffort('retention-preview-cancel', () => this.adapter.cancelPreview(pending.token));
      const meta = await this.adapter.getMeta();
      const nextPolicyRecord = toStoredRecord(policyRecordId, 'retention_policy_v1', policy, new Date(now).toISOString());
      const batch = makeBatch({
        idempotencyKey: crypto.randomUUID(), expectedCursor: meta.cursor, expectedPrivacyEpoch: meta.privacyEpoch,
        storeNames: ['system'], mutations: [{ kind: 'casSingleton' as const, storeName: 'system' as const, record: nextPolicyRecord, expectedContentHash: currentPolicyRecord.contentHash }],
      });
      await this.adapter.commit(batch);
      this.pendingTraceExport = null;
      this.readonlyConsent = { ...snapshot, policy };
      await this.expireReadonlyRetentionInternal(now);
      this.purgeChannel?.postMessage({ type: 'STATE_CHANGED', clientId: this.clientId });
      const durableMeta = await this.adapter.getMeta();
      this.lastDurableCursor = durableMeta.cursor;
      this.lastStorageIncarnation = durableMeta.incarnation ?? null;
      this.notifyRuntimeSnapshot(false, durableMeta.observationMode);
      return this.readonlyConsent;
    }, false, 'runtime.shorten-retention');
  }

  async grantReadonlyConsent(input: { readonly sourceItemKey: string; readonly eventTtlDays?: number; readonly derivedTtlDays?: number }): Promise<ReadonlyConsentSnapshot> {
    return this.withRuntimeOperation(async () => {
      await this.start();
      await this.enforcePurgeFence();
      if (!/^[\p{L}\p{N}._-]{1,80}$/u.test(input.sourceItemKey)) throw new Error('ERR_SOURCE_ID_INVALID');
      const existing = await this.loadReadonlyConsent();
      if (existing && !existing.revoked) throw new Error('ERR_CONSENT_ALREADY_ACTIVE');
      const meta = await this.adapter.getMeta();
      if (meta.observationMode !== 'ACTIVE') throw new Error('ERR_PRIVACY_MODE');
      const now = readM2Clock(this.clock);
      const policy = makeRetentionPolicy(crypto.randomUUID(), input.eventTtlDays, input.derivedTtlDays);
      const grant = makeConsentGrant({
        id: crypto.randomUUID(), sourceItemKey: input.sourceItemKey, adapterId: this.readonlyAdapter.id,
        adapterVersion: this.readonlyAdapter.version, retentionPolicyId: policy.id, grantedAt: new Date(now).toISOString(),
      });
      const policyRecord = toStoredRecord(`retention-policy:${policy.id}`, 'retention_policy_v1', policy);
      const grantRecord = toStoredRecord(`consent-grant:${grant.id}`, 'consent_grant_v1', grant);
      const batch = makeBatch({
        idempotencyKey: grant.id, expectedCursor: meta.cursor, expectedPrivacyEpoch: meta.privacyEpoch,
        requiresActiveObservation: true, storeNames: ['system'],
        mutations: [
          { kind: 'insertImmutable' as const, storeName: 'system' as const, record: policyRecord },
          { kind: 'insertImmutable' as const, storeName: 'system' as const, record: grantRecord },
        ],
      });
      await this.adapter.commit(batch);
      const snapshot = { grant, policy, revoked: false } as const;
      this.readonlyConsent = snapshot;
      return snapshot;
    }, false, 'runtime.grant-consent');
  }

  async previewReadonly(input: { readonly utf8: string; readonly sourceItemKey?: string }): Promise<ObservationPreviewDTO> {
    return this.withRuntimeOperation(async () => {
      await this.start();
      await this.enforcePurgeFence();
      const consent = await this.loadReadonlyConsent();
      if (!consent || consent.revoked) throw new Error('ERR_CONSENT_STALE');
      if (consent.grant.source.adapterId !== this.readonlyAdapter.id || consent.grant.source.adapterVersion !== this.readonlyAdapter.version) throw new Error('ERR_CONSENT_SCOPE');
      if (input.sourceItemKey !== undefined && input.sourceItemKey !== consent.grant.source.sourceItemKey) throw new Error('ERR_CONSENT_SCOPE');
      if (this.imported || this.pendingPreview) throw new Error('ERR_PREVIEW_ALREADY_EXISTS');
      const now = readM2Clock(this.clock);
      const meta = await this.adapter.getMeta();
      if (meta.observationMode !== 'ACTIVE') throw new Error('ERR_PRIVACY_MODE');
      const parsed = this.readonlyAdapter.preview(input.utf8, {
        sourceItemKey: consent.grant.source.sourceItemKey, consentId: consent.grant.id, purpose: consent.grant.purpose,
        policyVersion: consent.grant.policyVersion, projectKey: 'readonly', capturedAt: new Date(now).toISOString(),
      });
      if (parsed.events.length === 0) throw new Error('ERR_NO_ACCEPTED_EVENTS');
      const candidate = this.serviceFactory();
      const commit = buildReadonlyImport(candidate, parsed.events, parsed.parsed, consent.grant);
      const idempotencyKey = crypto.randomUUID();
      const expiresAt = new Date(now + READONLY_PREVIEW_TTL_MS).toISOString();
      const staged = await this.adapter.stagePreview({
        callerId: 'proagi-web', idempotencyKey, inputHash: parsed.inputHash, bytes: new TextEncoder().encode(input.utf8),
        privacyEpoch: meta.privacyEpoch, expiresAt, consentId: consent.grant.id,
        purpose: consent.grant.purpose, policyVersion: consent.grant.policyVersion, retentionPolicyId: consent.grant.retentionPolicyId,
        allowedFieldsHash: hashCanonical(consent.grant.allowedFields),
      });
      const records = recordsForCommit(commit, now, { consentId: consent.grant.id, retentionPolicyId: consent.grant.retentionPolicyId, eventTtlDays: consent.policy.eventTtlDays, derivedTtlDays: consent.policy.derivedTtlDays });
      const batch = makeBatch({
        idempotencyKey, expectedCursor: meta.cursor, expectedPrivacyEpoch: meta.privacyEpoch,
        requiresActiveObservation: true, requiresPreview: true, storeNames: ['business'],
        mutations: records.map((record) => ({ kind: 'insertImmutable' as const, storeName: 'business' as const, record })),
      });
      try {
        await this.adapter.bindPreviewBatch(staged.token, batch.batchHash);
        this.pendingPreview = { kind: 'guard', candidate, commit, token: staged.token, batch, createdAt: now };
        return {
          token: staged.token, acceptedCount: parsed.parsed.accepted.length, episodeCount: commit.output.episodes.length,
          insightCount: commit.output.claims.length, source: 'readonly-test-results', inputHash: parsed.inputHash,
          consentId: consent.grant.id, expiresAt, rejected: parsed.parsed.rejected, diagnostics: parsed.parsed.diagnostics,
        };
      } catch (error) {
        await this.bestEffort('readonly-preview-cancel', () => this.adapter.cancelPreview(staged.token));
        throw error;
      }
    }, false, 'runtime.preview-readonly');
  }

  async previewNdjson(stream: ReadableStream<Uint8Array>): Promise<ObservationPreviewDTO> {
    return this.withRuntimeOperation(async () => {
      await this.start();
      await this.enforcePurgeFence();
      if (!this.workerFactory) throw new Error('ERR_WORKER_UNAVAILABLE');
      if (this.imported || this.pendingPreview) throw new Error('ERR_PREVIEW_ALREADY_EXISTS');
      const generation = this.operationGeneration;
      const now = readM2Clock(this.clock);
      const meta = await this.adapter.getMeta();
      if (meta.observationMode !== 'ACTIVE') throw new Error('ERR_PRIVACY_MODE');
      const validation = await validateNdjsonStreamWithWorker({ stream, workerFactory: this.workerFactory });
      if (generation !== this.operationGeneration) throw new Error('ERR_OPERATION_STALE');
      const latestMeta = await this.adapter.getMeta();
      if (latestMeta.privacyEpoch !== meta.privacyEpoch || latestMeta.observationMode !== 'ACTIVE' || latestMeta.recoveryMode !== 'NORMAL') throw new Error('ERR_PRIVACY_EPOCH_STALE');
      const inputIdentity = parseJsonImportIdentity(validation.header.inputIdentity);
      if (inputIdentity.inputHash !== orderedEventsHash(validation.candidates)) throw new Error('ERR_NDJSON_INPUT_HASH');
      if (validation.rejected.length > 0) throw new Error('ERR_NDJSON_REJECTED');
      const parsed = parseFixtureJson(JSON.stringify({
        schemaVersion: validation.header.schemaVersion,
        fixtureId: 'json-import',
        adapterId: 'synthetic-fixture',
        adapterVersion: '1.0.0',
        events: validation.candidates.map(({ event }) => event),
      }));
      if (parsed.rejected.length > 0 || parsed.accepted.length !== validation.candidates.length) throw new Error('ERR_APP_SCHEMA_INVALID');
      const events = materializeJsonImportBehaviorEvents(parsed.accepted, inputIdentity);
      events.forEach(assertApplicationBehaviorEvent);
      const candidate = this.serviceFactory();
      const commit = buildJsonImport(candidate, events, inputIdentity);
      const records = recordsForCommit(commit, now);
      const token = crypto.randomUUID();
      const pending: NdjsonPendingPreview = {
        kind: 'ndjson', candidate, commit, token, createdAt: now, streamId: validation.receipt.streamId,
        inputIdentity, appCanonicalEventsHash: hashCanonical(events),
        workerRawBytes: validation.receipt.rawChunkBytes, privacyEpoch: meta.privacyEpoch, events, records,
      };
      const releaseMutation = this.adapter.beginInProcessRootMutation();
      try {
        if (generation !== this.operationGeneration || this.closed) throw new Error('ERR_OPERATION_STALE');
        this.pendingPreview = pending;
      } finally {
        releaseMutation();
      }
      await this.trace.record({
        eventName: 'runtime.worker', correlationId: crypto.randomUUID(), resultCode: 'OK',
        counts: { events: validation.receipt.validatedEventCount, bytes: validation.receipt.rawChunkBytes },
      }).catch(() => undefined);
      return {
        token, acceptedCount: events.length, episodeCount: commit.output.episodes.length, insightCount: commit.output.claims.length,
        source: 'json-import', inputIdentity, inputHash: inputIdentity.inputHash, importBatchId: inputIdentity.importBatchId,
        expiresAt: new Date(now + READONLY_PREVIEW_TTL_MS).toISOString(), rejected: [], diagnostics: [],
      };
    }, false, 'runtime.preview-ndjson');
  }

  async revokeReadonlyConsent(consentId?: string): Promise<void> {
    return this.withRuntimeOperation(async () => {
      await this.start();
      await this.enforcePurgeFence();
      this.pendingTraceExport = null;
      const snapshot = await this.loadReadonlyConsent();
      const id = consentId ?? snapshot?.grant.id;
      if (!snapshot || !id || snapshot.grant.id !== id) throw new Error('ERR_CONSENT_NOT_FOUND');
      if (snapshot.revoked) return;
      const pending = this.pendingPreview;
      this.pendingPreview = null;
      if (pending?.kind === 'guard') await this.bestEffort('revoke-preview-cancel', () => this.adapter.cancelPreview(pending.token));
      const meta = await this.adapter.getMeta();
      const revocation = makeConsentRevocation({ id: crypto.randomUUID(), consentId: id, revokedAt: new Date(readM2Clock(this.clock)).toISOString(), reason: 'user', privacyEpochAfter: meta.privacyEpoch + 1 });
      const record = toStoredRecord(`consent-revocation:${id}`, 'consent_revocation_v1', revocation);
      await this.adapter.revokeConsent(id, record, meta.cursor, meta.privacyEpoch, revocation.id);
      this.readonlyConsent = { ...snapshot, revoked: true, revocation };
      await this.deleteReadonlyConsentLineage(id);
      await this.hydrate();
      const verifiedMeta = await this.adapter.getMeta();
      this.notifyRuntimeSnapshot(false, verifiedMeta.observationMode, true, false);
    }, false, 'runtime.revoke-consent');
  }

  async expireReadonlyRetention(now?: number): Promise<number> {
    return this.withRuntimeOperation(async () => {
      await this.start();
      await this.enforcePurgeFence();
      const effectiveNow = now ?? readM2Clock(this.clock);
      if (!Number.isFinite(effectiveNow)) throw new Error('ERR_CLOCK_UNAVAILABLE');
      return this.expireReadonlyRetentionInternal(effectiveNow);
    }, false, 'runtime.expire-retention');
  }

  private async expireReadonlyRetentionInternal(effectiveNow: number): Promise<number> {
    const consent = await this.loadReadonlyConsent();
    const records = await this.adapter.scanPublishedBusiness();
    const expired = records.filter((record) => {
      if (record.retentionClass !== 'event' || !isReadonlyEventRecord(record)) return false;
      const consentId = (record.payload as { source?: { consentId?: unknown } }).source?.consentId;
      if (typeof consentId !== 'string') return false;
      const storedExpiry = record.expiresAt ? Date.parse(record.expiresAt) : Number.NaN;
      const policyExpiry = consent && !consent.revoked && consent.grant.id === consentId
        ? Date.parse(record.writtenAt) + consent.policy.eventTtlDays * 86_400_000 : Number.NaN;
      const expiry = [storedExpiry, policyExpiry].filter(Number.isFinite).sort((left, right) => left - right)[0];
      return expiry !== undefined && expiry <= effectiveNow;
    });
    const consentIds = [...new Set(expired.map((record) => String((record.payload as { source: { consentId: string } }).source.consentId)))];
    for (const id of consentIds) await this.deleteReadonlyConsentLineage(id, 'retention-expired');
    return expired.length;
  }

  private async loadReadonlyConsent(): Promise<ReadonlyConsentSnapshot | null> {
    const records = await this.adapter.getAll<StoredRecord<Record<string, unknown>>>('system');
    const grantRecord = records.filter((record) => record.recordType === 'consent_grant_v1').at(-1);
    if (!grantRecord) {
      this.readonlyConsent = null;
      this.readonlyConsentLoaded = true;
      return null;
    }
    assertConsentRecord(grantRecord);
    const grant = grantRecord.payload as unknown as ConsentGrant;
    const policyRecord = records.find((record) => record.recordType === 'retention_policy_v1' && record.recordId === `retention-policy:${grant.retentionPolicyId}`);
    if (!policyRecord) throw new Error('ERR_RETENTION_POLICY_MISSING');
    assertConsentRecord(policyRecord);
    const policy = policyRecord.payload as unknown as RetentionPolicy;
    const revocationRecord = records.find((record) => record.recordType === 'consent_revocation_v1' && record.payload?.consentId === grant.id);
    const revocation = revocationRecord ? (assertConsentRecord(revocationRecord), revocationRecord.payload as unknown as ConsentRevocation) : undefined;
    const snapshot = { grant, policy, revoked: Boolean(revocation), ...(revocation ? { revocation } : {}) };
    this.readonlyConsent = snapshot;
    this.readonlyConsentLoaded = true;
    return snapshot;
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
    }, false, 'runtime.preview');
  }

  async commit(token: string): Promise<ImportCommit> {
    return this.withRuntimeOperation(async () => {
      await this.start();
      await this.enforcePurgeFence();
      if (!this.pendingPreview || this.pendingPreview.token !== token) throw new Error('ERR_PREVIEW_STALE');
      return this.pendingPreview.kind === 'ndjson'
        ? this.commitNdjsonInternal(this.pendingPreview)
        : this.commitBundledInternal();
    }, false, 'runtime.commit');
  }

  async submit(action: Exclude<CorrectionAction, 'restore'>): Promise<CorrectionResult> {
    return this.withRuntimeOperation(() => this.correct(action), false, 'runtime.correction');
  }

  async pausePrivacy(): Promise<{ readonly privacyEpoch: number }> {
    return this.withRuntimeOperation(async () => {
      const snapshot = await this.setPrivacyMode('PRIVATE');
      return { privacyEpoch: snapshot.privacyEpoch };
    }, false, 'runtime.privacy');
  }

  async resumePrivacy(): Promise<{ readonly privacyEpoch: number }> {
    return this.withRuntimeOperation(async () => {
      const snapshot = await this.setPrivacyMode('ACTIVE');
      return { privacyEpoch: snapshot.privacyEpoch };
    }, false, 'runtime.privacy');
  }

  async evaluateReplay() {
    return this.withRuntimeOperation(async () => {
      await this.start();
      await this.enforcePurgeFence();
      return this.replay();
    }, false, 'runtime.evaluate-replay');
  }

  async previewBundled(now = this.clock()): Promise<ImportCommit> { return this.withRuntimeOperation(() => this.previewBundledInternal(now), false, 'runtime.preview-bundled'); }

  private async previewBundledInternal(now = this.clock()): Promise<ImportCommit> {
    await this.start();
    await this.enforcePurgeFence();
    if (this.imported) return this.imported;
    if (this.pendingPreview) {
      if (this.pendingPreview.kind !== 'guard') throw new Error('ERR_PREVIEW_ALREADY_EXISTS');
      return this.pendingPreview.commit;
    }
    this.previewing ??= this.createBundledPreview(now).finally(() => { this.previewing = null; });
    return this.previewing;
  }

  private async createBundledPreview(now: number): Promise<ImportCommit> {
    const generation = this.operationGeneration;
    const meta = await this.adapter.getMeta();
    if (generation !== this.operationGeneration) throw new Error('ERR_OPERATION_STALE');
    if (meta.observationMode !== 'ACTIVE') throw new Error('ERR_PRIVACY_MODE');
    if (this.workerFactory) {
      const workerValidation = await validateBundledFixtureWithWorker(this.workerFactory);
      const expectedCandidates = developerDayFixture.events.map((event, index) => ({ sequence: String(index), event: event as unknown as Record<string, unknown> }));
      if (workerValidation.receipt.state !== 'validated'
        || workerValidation.receipt.validatedEventCount !== expectedCandidates.length
        || hashCanonical(workerValidation.candidates) !== hashCanonical(expectedCandidates)) throw new Error('ERR_WORKER_VALIDATION');
      await this.trace.record({
        eventName: 'runtime.worker', correlationId: crypto.randomUUID(), resultCode: 'OK',
        counts: { events: workerValidation.receipt.validatedEventCount, bytes: workerValidation.receipt.rawChunkBytes },
      }).catch(() => undefined);
    }
    const candidate = this.serviceFactory();
    const preview = candidate.preview(developerDayFixtureJson, now);
    const receipt = await candidate.commit(preview.token, crypto.randomUUID(), now);
    const idempotencyKey = crypto.randomUUID();
    const staged = await this.adapter.stagePreview({
      callerId: 'proagi-web', idempotencyKey, inputHash: sha256(developerDayFixtureJson),
      bytes: new TextEncoder().encode(developerDayFixtureJson), privacyEpoch: meta.privacyEpoch,
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    if (generation !== this.operationGeneration) {
      await this.bestEffort('stale-preview-cancel', () => this.adapter.cancelPreview(staged.token));
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
        this.pendingPreview = { kind: 'guard', candidate, commit: receipt.result, token: staged.token, batch, createdAt: now };
      } finally {
        releaseMutation();
      }
      return receipt.result;
    } catch (error) {
      await this.bestEffort('stale-preview-cancel', () => this.adapter.cancelPreview(staged.token));
      throw error;
    }
  }

  async commitBundled(options: { simulateResponseLoss?: boolean } = {}): Promise<ImportCommit> { return this.withRuntimeOperation(() => this.commitBundledInternal(options), false, 'runtime.commit-bundled'); }

  private async commitBundledInternal(options: { simulateResponseLoss?: boolean } = {}): Promise<ImportCommit> {
    const generation = this.operationGeneration;
    await this.start();
    await this.enforcePurgeFence();
    if (generation !== this.operationGeneration) throw new Error('ERR_OPERATION_STALE');
    if (this.imported) return this.imported;
    const pending = this.pendingPreview;
    if (!pending || pending.kind !== 'guard') throw new Error('ERR_PREVIEW_REQUIRED');
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
          throw new Error('ERR_COMMIT_RECONCILIATION_INVALID', { cause: retryError });
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
        await this.bestEffort('runtime-rehydrate', () => this.hydrate(0, generation));
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

  private async commitNdjsonInternal(pending: NdjsonPendingPreview): Promise<ImportCommit> {
    const generation = this.operationGeneration;
    await this.start();
    await this.enforcePurgeFence();
    if (generation !== this.operationGeneration || this.closed || this.pendingPreview !== pending) throw new Error('ERR_OPERATION_STALE');
    const meta = await this.adapter.getMeta();
    if (meta.observationMode !== 'ACTIVE' || meta.recoveryMode !== 'NORMAL' || meta.privacyEpoch !== pending.privacyEpoch) throw new Error('ERR_PRIVACY_EPOCH_STALE');
    const sessionId = crypto.randomUUID();
    let sessionCreated = false;
    let committedCursor: string | undefined;
    try {
      let session = await this.adapter.createImportSession(pending.streamId, sessionId, pending.inputIdentity);
      sessionCreated = true;
      const batches = splitImportRecords(pending.records);
      if (hashCanonical(pending.events) !== pending.appCanonicalEventsHash) throw new Error('ERR_APP_EVENT_HASH');
      for (const batch of batches) {
        if (generation !== this.operationGeneration || this.closed) throw new Error('ERR_OPERATION_STALE');
        session = await this.adapter.stageImportBatch(sessionId, batch, hashCanonical(batch));
      }
      if (session.committedEventCount !== pending.records.length || session.committedBatchHashes.length !== batches.length) throw new Error('ERR_IMPORT_COUNT_MISMATCH');
      const publishIdempotencyKey = crypto.randomUUID();
      const expectedPublishHash = hashCanonical({ kind: 'publish-import', sessionId, hashes: session.committedBatchHashes });
      const published = await this.adapter.publishImportSession(sessionId, publishIdempotencyKey);
      if (!published.applied || published.ledger.idempotencyKey !== publishIdempotencyKey || published.ledger.batchHash !== expectedPublishHash) throw new Error('ERR_IMPORT_RECEIPT_INVALID');
      committedCursor = published.cursor;
      this.ownCommitCursor = committedCursor;
      this.purgeChannel?.postMessage({ type: 'STATE_CHANGED', clientId: this.clientId });
      await this.testHooks.afterCommitPersisted?.();
      const committedMeta = await this.adapter.getMeta();
      if (committedCursor === undefined || committedMeta.cursor !== committedCursor || committedMeta.privacyEpoch !== pending.privacyEpoch || committedMeta.recoveryMode !== 'NORMAL') throw new Error('ERR_CURSOR_CONFLICT');
      await this.enforcePurgeFence();
      if (generation !== this.operationGeneration) throw new Error('ERR_OPERATION_STALE');
      const finalMeta = await this.adapter.getMeta();
      if (finalMeta.cursor !== committedMeta.cursor || finalMeta.privacyEpoch !== committedMeta.privacyEpoch || finalMeta.recoveryMode !== 'NORMAL') throw new Error('ERR_CURSOR_CONFLICT');
      const releaseMutation = this.adapter.beginInProcessRootMutation();
      try {
        if (generation !== this.operationGeneration || this.pendingPreview !== pending) throw new Error('ERR_OPERATION_STALE');
        this.lastDurableCursor = finalMeta.cursor;
        this.lastStorageIncarnation = finalMeta.incarnation ?? null;
        this.service = pending.candidate;
        this.imported = pending.commit;
        this.pendingPreview = null;
      } finally {
        releaseMutation();
      }
      await this.trace.record({
        eventName: 'runtime.import', correlationId: crypto.randomUUID(), resultCode: 'OK',
        counts: { events: pending.events.length, bytes: pending.workerRawBytes, claims: pending.commit.output.claims.length },
      }).catch(() => undefined);
      return pending.commit;
    } catch (error) {
      if (sessionCreated) await this.bestEffort('import-session-cancel', () => this.adapter.cancelImportSession(sessionId));
      throw error;
    } finally {
      if (committedCursor !== undefined && this.ownCommitCursor === committedCursor) this.ownCommitCursor = null;
    }
  }

  async importBundled(now = this.clock()): Promise<ImportCommit> {
    return this.withRuntimeOperation(async () => {
      await this.previewBundled(now);
      return this.commitBundled();
    }, false, 'runtime.import');
  }

  async setPrivacyMode(mode: 'ACTIVE' | 'PRIVATE'): Promise<BrowserRuntimeSnapshot> { return this.withRuntimeOperation(() => this.setPrivacyModeInternal(mode), false, 'runtime.privacy'); }

  private async setPrivacyModeInternal(mode: 'ACTIVE' | 'PRIVATE'): Promise<BrowserRuntimeSnapshot> {
    await this.start();
    await this.enforcePurgeFence();
    const meta = await this.adapter.getMeta();
    await this.adapter.setPrivacyMode(meta.cursor, meta.privacyEpoch, mode, crypto.randomUUID());
    this.lastDurableCursor = (await this.adapter.getMeta()).cursor;
    if (mode === 'PRIVATE') this.pendingTraceExport = null;
    this.purgeChannel?.postMessage({ type: 'STATE_CHANGED', clientId: this.clientId });
    if (mode === 'PRIVATE') this.pendingPreview = null;
    return this.snapshot();
  }

  async correct(action: Exclude<CorrectionAction, 'restore'>): Promise<CorrectionResult> { return this.withRuntimeOperation(() => this.correctInternal(action), false, 'runtime.correction'); }

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
        if (!this.closed && generation === this.operationGeneration) await this.bestEffort('runtime-rehydrate', () => this.hydrate(0, generation));
        if (!deleteRetried && (error as { code?: string }).code === 'ERR_CURSOR_CONFLICT') { deleteRetried = true; await this.deleteClaimLineage(current); return result; }
        throw error;
      }
    }

    try {
      if (generation !== this.operationGeneration || this.closed) throw new Error('ERR_OPERATION_STALE');
      if (!result.claim || !result.head) throw new Error('ERR_KNOWLEDGE_LINEAGE');
      const version = correctionService.knowledgeSnapshot().versions.find((item) => item.id === result.head!.versionId);
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
       this.purgeChannel?.postMessage({ type: 'STATE_CHANGED', clientId: this.clientId });
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
      if (!this.closed && generation === this.operationGeneration) await this.bestEffort('runtime-rehydrate', () => this.hydrate(0, generation));
      throw error;
    }
  }

  private async deleteClaimLineage(claim: WorkModelClaim): Promise<void> {
    const lineageAnchors = await this.collectClaimLineageAnchors(claim.claimKey);
    const target = await this.adapter.getRecord<StoredRecord>('business', claim.id);
    const storedClaim = target ? decodeWorkModelClaim(target.payload) : undefined;
    if (!target || storedClaim?.contentHash !== claim.contentHash) throw new Error('ERR_NOT_FOUND');
    const plan = await this.adapter.planDeletion({
      storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType,
      lineageAnchorDigests: lineageAnchors.map((anchor) => sha256(anchor)),
    });
    const ownerClientId = crypto.randomUUID();
    const startedAt = this.clock();
    const fenced = await this.adapter.fenceDeletion(plan, ownerClientId, startedAt);
    let journal = fenced.journal;
    while (journal.state === 'FENCED') {
      await this.adapter.renewRecoveryLease(ownerClientId, fenced.lease.fencingToken, this.clock());
      journal = await this.adapter.enumerateDeletionPage(journal.id, ownerClientId, fenced.lease.fencingToken, 128, this.clock());
    }
    while (journal.state === 'DELETING') {
      await this.adapter.renewRecoveryLease(ownerClientId, fenced.lease.fencingToken, this.clock());
      journal = await this.adapter.deleteChunk(journal.id, ownerClientId, fenced.lease.fencingToken, 128, this.clock());
    }

    if (this.imported) this.imported = withoutClaim(this.imported, claim, lineageAnchors);
    this.service = this.serviceFactory();
    await this.awaitUiPurgeCommit(journal.id, journal.purge.generation, 'owner');
    if (journal.state === 'PURGE_PENDING') {
      await this.adapter.renewRecoveryLease(ownerClientId, fenced.lease.fencingToken, this.clock());
      this.purgeChannel?.postMessage({ type: 'PURGE_REQUEST', deletionId: journal.id, generation: journal.purge.generation, clientId: this.clientId });
      await this.adapter.acknowledgePurge(journal.id, journal.purge.generation, this.clientId, this.clock());
      if (!this.purgeChannel && journal.purge.requiredClientIds.some((clientId) => clientId !== this.clientId)) {
        throw new Error('ERR_PURGE_CLIENTS_PENDING');
      }
      await new Promise((resolve) => this.scheduler.setTimeout(resolve, 100));
    }
    let audit = await this.adapter.sealAndAudit(journal.id, ownerClientId, fenced.lease.fencingToken, this.clock());
    const waitStarted = this.clock();
    const waitUntil = waitStarted + PURGE_CLIENT_WAIT_MS;
    let purgeRetried = false;
    while (audit.outcome === 'CLIENTS_PENDING' && this.clock() < waitUntil) {
      const now = this.clock();
      await this.adapter.renewRecoveryLease(ownerClientId, fenced.lease.fencingToken, now);
      if (!purgeRetried && now - waitStarted >= PURGE_CLIENT_LEASE_MS) {
        journal = await this.adapter.retryPurge(journal.id, ownerClientId, fenced.lease.fencingToken, [this.clientId], now);
        purgeRetried = true;
        this.purgeChannel?.postMessage({ type: 'PURGE_REQUEST', deletionId: journal.id, generation: journal.purge.generation, clientId: this.clientId });
        if (journal.purge.requiredClientIds.includes(this.clientId)) await this.adapter.acknowledgePurge(journal.id, journal.purge.generation, this.clientId, now);
      } else {
        this.purgeChannel?.postMessage({ type: 'PURGE_REQUEST', deletionId: journal.id, generation: journal.purge.generation, clientId: this.clientId });
      }
      await new Promise((resolve) => this.scheduler.setTimeout(resolve, 250));
      audit = await this.adapter.sealAndAudit(journal.id, ownerClientId, fenced.lease.fencingToken, this.clock());
    }
    if (audit.outcome !== 'CLEAN') {
      const roots = audit.receipts.filter((receipt) => receipt.forbiddenReferenceCount > 0)
        .map((receipt) => receipt.rootId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()).join('_');
      throw new Error(audit.outcome === 'CLIENTS_PENDING' ? 'ERR_PURGE_CLIENTS_PENDING' : `ERR_DELETE_REACHABLE_${roots || 'UNKNOWN'}`);
    }
    let finalizing = await this.adapter.finalizeDeletionPage(journal.id, ownerClientId, fenced.lease.fencingToken, 128, this.clock());
    while (!finalizing.finalizing.complete) {
      await this.adapter.renewRecoveryLease(ownerClientId, fenced.lease.fencingToken, this.clock());
      finalizing = await this.adapter.finalizeDeletionPage(journal.id, ownerClientId, fenced.lease.fencingToken, 128, this.clock());
    }
    try {
      await this.adapter.verifyDeletion(journal.id, ownerClientId, fenced.lease.fencingToken, this.clock(), this.testHooks.simulateDeletionResponseLoss?.() === true);
    } catch (error) {
      if (!(error instanceof CommitResponseLostError)) throw error;
      // The transaction is already committed. Re-read the authenticated
      // terminal receipt instead of reporting a false delete failure.
      await this.adapter.verifyDeletion(journal.id, ownerClientId, fenced.lease.fencingToken, this.clock());
    }
    await this.hydrate(0, this.operationGeneration);
    const verifiedMeta = await this.adapter.getMeta();
    this.lastDurableCursor = verifiedMeta.cursor;
  }

  private async deleteReadonlyConsentLineage(consentId: string, cause: 'consent-revoked' | 'retention-expired' = 'consent-revoked'): Promise<void> {
    const records = await this.adapter.scanPublishedBusiness();
    const sourceRecords = records.filter((record) => isReadonlyEventRecord(record)
      && (record.payload as { source: { consentId?: unknown } }).source.consentId === consentId);
    const target = sourceRecords[0];
    if (!target) return;
    const anchors = expandLineageAnchors(records, sourceRecords);
    const plan = await this.adapter.planDeletion({
      storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType,
      lineageAnchorDigests: anchors.map((anchor) => sha256(anchor)),
    }, cause);
    const ownerClientId = crypto.randomUUID();
    const fenced = await this.adapter.fenceDeletion(plan, ownerClientId, this.clock());
    let journal = fenced.journal;
    while (journal.state === 'FENCED') {
      await this.adapter.renewRecoveryLease(ownerClientId, fenced.lease.fencingToken, this.clock());
      journal = await this.adapter.enumerateDeletionPage(journal.id, ownerClientId, fenced.lease.fencingToken, 128, this.clock());
    }
    while (journal.state === 'DELETING') {
      await this.adapter.renewRecoveryLease(ownerClientId, fenced.lease.fencingToken, this.clock());
      journal = await this.adapter.deleteChunk(journal.id, ownerClientId, fenced.lease.fencingToken, 128, this.clock());
    }
    this.imported = null;
    this.pendingPreview = null;
    this.service = this.serviceFactory();
    await this.awaitUiPurgeCommit(journal.id, journal.purge.generation, 'owner');
    if (journal.state === 'PURGE_PENDING') {
      await this.adapter.renewRecoveryLease(ownerClientId, fenced.lease.fencingToken, this.clock());
      this.purgeChannel?.postMessage({ type: 'PURGE_REQUEST', deletionId: journal.id, generation: journal.purge.generation, clientId: this.clientId });
      await this.adapter.acknowledgePurge(journal.id, journal.purge.generation, this.clientId, this.clock());
      if (!this.purgeChannel && journal.purge.requiredClientIds.some((clientId) => clientId !== this.clientId)) throw new Error('ERR_PURGE_CLIENTS_PENDING');
      await new Promise((resolve) => this.scheduler.setTimeout(resolve, 100));
    }
    let audit = await this.adapter.sealAndAudit(journal.id, ownerClientId, fenced.lease.fencingToken, this.clock());
    const waitStarted = this.clock();
    let purgeRetried = false;
    while (audit.outcome === 'CLIENTS_PENDING' && this.clock() < waitStarted + PURGE_CLIENT_WAIT_MS) {
      const now = this.clock();
      await this.adapter.renewRecoveryLease(ownerClientId, fenced.lease.fencingToken, now);
      if (!purgeRetried && now - waitStarted >= PURGE_CLIENT_LEASE_MS) {
        journal = await this.adapter.retryPurge(journal.id, ownerClientId, fenced.lease.fencingToken, [this.clientId], now);
        purgeRetried = true;
        this.purgeChannel?.postMessage({ type: 'PURGE_REQUEST', deletionId: journal.id, generation: journal.purge.generation, clientId: this.clientId });
        if (journal.purge.requiredClientIds.includes(this.clientId)) await this.adapter.acknowledgePurge(journal.id, journal.purge.generation, this.clientId, now);
      } else this.purgeChannel?.postMessage({ type: 'PURGE_REQUEST', deletionId: journal.id, generation: journal.purge.generation, clientId: this.clientId });
      await new Promise((resolve) => this.scheduler.setTimeout(resolve, 250));
      audit = await this.adapter.sealAndAudit(journal.id, ownerClientId, fenced.lease.fencingToken, this.clock());
    }
    if (audit.outcome !== 'CLEAN') throw new Error(audit.outcome === 'CLIENTS_PENDING' ? 'ERR_PURGE_CLIENTS_PENDING' : 'ERR_DELETE_REACHABLE_READONLY');
    let finalizing = await this.adapter.finalizeDeletionPage(journal.id, ownerClientId, fenced.lease.fencingToken, 128, this.clock());
    while (!finalizing.finalizing.complete) {
      await this.adapter.renewRecoveryLease(ownerClientId, fenced.lease.fencingToken, this.clock());
      finalizing = await this.adapter.finalizeDeletionPage(journal.id, ownerClientId, fenced.lease.fencingToken, 128, this.clock());
    }
    try {
      await this.adapter.verifyDeletion(journal.id, ownerClientId, fenced.lease.fencingToken, this.clock(), this.testHooks.simulateDeletionResponseLoss?.() === true);
    } catch (error) {
      if (!(error instanceof CommitResponseLostError)) throw error;
      await this.adapter.verifyDeletion(journal.id, ownerClientId, fenced.lease.fencingToken, this.clock());
    }
    await this.hydrate(0, this.operationGeneration);
    this.lastDurableCursor = (await this.adapter.getMeta()).cursor;
  }

  private async collectClaimLineageAnchors(claimKey: string): Promise<readonly string[]> {
    const business = await this.adapter.scanPublishedBusiness();
    const heads = await this.adapter.getAll<StoredRecord>('heads');
    const lineageRecords = [...business, ...heads].filter((record) => recordTargetsClaimKey(record, claimKey));
    return [...new Set(lineageRecords.flatMap(identityAnchors))].sort();
  }

  async clear(): Promise<void> { return this.withRuntimeOperation(() => this.clearInternal(), true, 'runtime.clear'); }

  private async clearInternal(): Promise<void> {
    if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
    if (this.clearPromise) return this.clearPromise;
    this.pendingTraceExport = null;
    this.clearPromise = (async () => {
      await this.start();
      if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
      const cachesCleared = await clearControlledCaches(this.cacheClearTimeoutMs, this.cacheStore, this.scheduler);
      const cleared = await this.adapter.clearAll({ cachesCleared });
      if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
      if (cleared.state !== 'SUCCEEDED') {
        await this.bestEffort('clear-rehydrate', () => this.hydrate());
        throw new Error('ERR_CLEAR_BLOCKED');
      }
      if (this.rootRegistered) {
        this.unregisterRuntimeRoot();
        this.rootRegistered = false;
      }
      this.adapter.dispose();
      this.clientRegistered = false;
      this.adapter = this.adapterFactory();
      this.unregisterRuntimeRoot = this.registerRuntimeRoot();
      this.rootRegistered = true;
      this.started = false;
      this.service = this.serviceFactory();
      this.imported = null;
      this.pendingPreview = null;
      this.lastDurableCursor = null;
      this.lastStorageIncarnation = null;
      if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
      await this.start();
    await this.clearRuntimeFaultAfterVerifiedRecovery();
     })().finally(() => { this.clearPromise = null; });
    return this.clearPromise;
  }

  async recover(): Promise<void> { return this.withRuntimeOperation(() => this.recoverInternal(), true, 'runtime.recover'); }

  private async clearRuntimeFaultAfterVerifiedRecovery(purge = false): Promise<void> {
    const snapshot = await this.snapshotInternal();
    this.runtimeFaulted = false;
    this.notifyRuntimeSnapshot(purge, snapshot.observationMode);
  }

  private async recoverInternal(): Promise<void> {
    await this.start();
    const { journals } = await this.adapter.readPurgeFence();
    let journal = journals.find((item) => item.recordType === 'active_deletion_journal' && item.state !== 'FAILED');
    if (!journal) {
      await this.clearRuntimeFaultAfterVerifiedRecovery();
      return;
    }
    await this.releaseLocalRuntime();
    await this.awaitUiPurgeCommit(journal.id, journal.purge.generation, 'owner');
    const lease = await this.adapter.stealRecoveryLease(this.clientId, this.clock());
    while (journal.state === 'FENCED' || journal.state === 'DELETING') {
      await this.adapter.renewRecoveryLease(this.clientId, lease.fencingToken, this.clock());
      journal = journal.state === 'FENCED'
        ? await this.adapter.enumerateDeletionPage(journal.id, this.clientId, lease.fencingToken, 128, this.clock())
        : await this.adapter.deleteChunk(journal.id, this.clientId, lease.fencingToken, 128, this.clock());
    }
    if (journal.state === 'PURGE_PENDING') {
      journal = await this.adapter.retryPurge(journal.id, this.clientId, lease.fencingToken, [], this.clock());
      this.purgeChannel?.postMessage({ type: 'PURGE_REQUEST', deletionId: journal.id, generation: journal.purge.generation, clientId: this.clientId });
      await this.adapter.acknowledgePurge(journal.id, journal.purge.generation, this.clientId, this.clock());
    }
    if (journal.state === 'PURGE_PENDING' || journal.state === 'AUDITING') {
      await this.adapter.renewRecoveryLease(this.clientId, lease.fencingToken, this.clock());
      const audit = await this.adapter.sealAndAudit(journal.id, this.clientId, lease.fencingToken, this.clock());
      if (audit.outcome !== 'CLEAN') throw new Error(audit.outcome === 'CLIENTS_PENDING' ? 'ERR_PURGE_CLIENTS_PENDING' : 'ERR_DELETE_REACHABLE');
    }
    let finalizing = await this.adapter.finalizeDeletionPage(journal.id, this.clientId, lease.fencingToken, 128, this.clock());
    while (!finalizing.finalizing.complete) {
      await this.adapter.renewRecoveryLease(this.clientId, lease.fencingToken, this.clock());
      finalizing = await this.adapter.finalizeDeletionPage(journal.id, this.clientId, lease.fencingToken, 128, this.clock());
    }
    await this.adapter.renewRecoveryLease(this.clientId, lease.fencingToken, this.clock());
    await this.adapter.verifyDeletion(journal.id, this.clientId, lease.fencingToken, this.clock());
    await this.hydrate();
    await this.clearRuntimeFaultAfterVerifiedRecovery(true);
  }

  async replay() { return this.withRuntimeOperation(() => this.replayInternal(), false, 'runtime.replay'); }

  private async replayInternal() {
    await this.start();
    await this.enforcePurgeFence();
    if (!this.imported) throw new Error('ERR_NOT_FOUND');
    return this.service.replay();
  }

  async snapshot(): Promise<BrowserRuntimeSnapshot> { return this.withRuntimeOperation(() => this.snapshotInternal(), true, 'runtime.snapshot'); }

  async recordManualCheck(input: TraceManualCheck): Promise<void> {
    if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
    this.pendingTraceExport = null;
    await this.trace.recordManualCheck({ ...input, correlationId: crypto.randomUUID() });
  }

  async getTraceEvents(): Promise<readonly TraceRecord[]> {
    if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
    await this.trace.flush();
    return (await this.adapter.getAll<TraceRecord>('audit')).filter((record) => {
      if (record.recordType !== 'trace_event_v1') return false;
      assertTraceRecord(record);
      return true;
    }).sort((left, right) => left.recordId.localeCompare(right.recordId));
  }

  async prepareTraceExport(): Promise<TraceExportPreview> {
    if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
    await this.startInternal();
    const events = await this.getTraceEvents();
    const meta = await this.adapter.getMeta();
    const preview = makeTraceExportPreview({ sourceCursor: meta.cursor, privacyEpoch: meta.privacyEpoch, events });
    this.pendingTraceExport = preview;
    return preview;
  }

  async exportTrace(confirmation: { readonly confirmedHash: Hash; readonly acknowledgeIrrevocable: true }): Promise<TraceExportPreview> {
    return this.withRuntimeOperation(async () => {
      await this.enforcePurgeFence();
      const preview = this.pendingTraceExport;
      if (!preview) throw new Error('ERR_EXPORT_PREVIEW_REQUIRED');
      if (confirmation.acknowledgeIrrevocable !== true) throw new Error('ERR_EXPORT_CONFIRMATION');
      const meta = await this.adapter.getMeta();
      if (meta.recoveryMode !== 'NORMAL' || meta.privacyEpoch !== preview.privacyEpoch) {
        this.pendingTraceExport = null;
        throw new Error('ERR_EXPORT_STALE');
      }
      if (preview.contentHash !== confirmation.confirmedHash) throw new Error('ERR_EXPORT_STALE');
      this.pendingTraceExport = null;
      return preview;
    }, false, 'artifact.export');
  }

  private async snapshotInternal(): Promise<BrowserRuntimeSnapshot> {
    await this.start();
    await this.enforcePurgeFence();
    return this.readSnapshot();
  }

  private async readSnapshot(): Promise<BrowserRuntimeSnapshot> {
    const meta = await this.adapter.getMeta();
    return { observationMode: meta.observationMode, cursor: meta.cursor, privacyEpoch: meta.privacyEpoch, imported: this.imported, runtimeFaulted: this.runtimeFaulted, readonlyConsent: this.readonlyConsentLoaded ? this.readonlyConsent : null };
  }

  private withRuntimeOperation<T>(operation: () => Promise<T>, allowFaulted = false, traceName: TraceEventName = 'runtime.operation'): Promise<T> {
    if (this.closed) throw new Error('ERR_RUNTIME_CLOSED');
    if (this.runtimeFaulted && !allowFaulted) throw new Error('ERR_RUNTIME_FAULTED');
    this.inFlightOperations += 1;
    const correlationId = crypto.randomUUID();
    const startedAt = traceClock(this.clock);
    const recordTrace = (level: 'info' | 'warn' | 'error', resultCode: string, value?: unknown): Promise<void> => {
      const counts = traceCounts(value);
      return this.trace.record({
        eventName: traceName,
        level,
        correlationId,
        resultCode: toTraceResultCode(resultCode),
        durationMs: Math.max(0, Math.round(traceClock(this.clock) - startedAt)),
        ...(counts ? { counts } : {}),
      }).then(() => undefined).catch(() => undefined);
    };
    let result: Promise<T>;
    try {
      result = operation();
    } catch (error) {
      this.releaseRuntimeOperation();
      this.latchRuntimeFault(error);
      void recordTrace(isBenignRuntimeError(error) ? 'warn' : 'error', runtimeErrorCode(error));
      throw error;
    }
    return result
      .then(async (value) => {
        await recordTrace('info', 'OK', value);
        return value;
      })
      .catch((error) => {
        this.latchRuntimeFault(error);
        return recordTrace(isBenignRuntimeError(error) ? 'warn' : 'error', runtimeErrorCode(error)).then(() => { throw error; });
      })
      .finally(() => this.releaseRuntimeOperation());
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
    this.pendingTraceExport = null;
    this.operationGeneration += 1;
    this.imported = null;
    this.service = this.serviceFactory();
    // Keep the closed root harmless until adapter disposal can detach it. If a
    // final verification owns quiescence, disposal is deferred by the adapter.
    this.rootRegistered = false;
    if (this.clientRenewal) this.scheduler.clearInterval(this.clientRenewal);
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
    this.purgeChannel?.removeEventListener('message', this.purgeMessageHandler);
    this.purgeChannel?.close();
    const adapter = this.adapter;
    const pending = this.pendingPreview;
    this.pendingPreview = null;
    const startup = this.starting;
    const clearing = this.clearPromise;
    const operations = this.waitForRuntimeOperations();
    this.started = false;
    this.closePromise = (async () => {
      await startup?.catch((error) => this.reportBackgroundFailure('close-startup', error));
      await clearing?.catch((error) => this.reportBackgroundFailure('close-clearing', error));
      await operations;
      if (pending?.kind === 'guard') await this.bestEffort('close-preview-cancel', () => adapter.cancelPreview(pending.token));
      if (this.clientRegistered) {
        await this.bestEffort('close-client', () => adapter.closeClient(this.clientId));
        this.clientRegistered = false;
      }
      await this.trace.record({ eventName: 'runtime.close', correlationId: crypto.randomUUID(), resultCode: 'OK' }).catch(() => undefined);
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
    const events = records.filter((record) => record.recordType === 'behavior_event_v1').map((record) => decodeBehaviorEvent(record.payload));
    const claims = records.filter((record) => record.recordType === 'work_model_claim_v1').map((record) => decodeWorkModelClaim(record.payload));
    const versions = records.filter((record) => record.recordType === 'knowledge_version_v1').map((record) => decodeKnowledgeVersion(record.payload));
    const corrections = records.filter((record) => record.recordType === 'correction_record_v1').map((record) => decodeCorrectionRecord(record.payload));
    const heads = headRecords.map((record) => decodeKnowledgeHead(record.payload));
    const markerRecord = records.find((record) => record.recordId === FIXTURE_MARKER_ID);
    const marker = markerRecord ? decodeFixtureMarker(markerRecord.payload) : undefined;
    const service = this.serviceFactory();
    service.restoreEvents(events);
    const snapshot: KnowledgeSnapshot = { claims, heads, versions, corrections, deletedClaimKeys: [] };
    let imported: ImportCommit | null = null;
    if (marker) {
      const asOf = marker.asOf;
      const preview = service.preview(developerDayFixtureJson, asOf);
      const receipt = await service.commit(preview.token, `hydrate:${markerRecord!.contentHash}`, asOf);
      const hasStoredClaim = claims.length > 0;
      const base = receipt.result.output.claims[0];
      const fixtureSnapshot: KnowledgeSnapshot = {
        claims,
        heads,
        versions,
        corrections,
        deletedClaimKeys: !hasStoredClaim && base ? [base.claimKey] : [],
      };
      service.hydrateKnowledge(fixtureSnapshot);
      imported = !hasStoredClaim && base ? withoutClaim(receipt.result, base) : receipt.result;
    } else if (events.length > 0) {
      service.hydrateKnowledge(snapshot);
      const output = runInsightLoop(events, { asOf: latestEventAt(events), timezone: 'UTC', knowledge: snapshot });
      imported = Object.freeze({
        events, output, acceptedCount: events.length, rejectedCount: 0,
        ...(events[0]?.source.kind === 'readonly-adapter' ? {
          source: 'readonly-test-results' as const, consentId: events[0].source.consentId, sourceItemKey: events[0].source.sourceItemKey,
        } : events[0]?.source.kind === 'json-import' ? {
          source: 'json-import' as const, importBatchId: events[0].source.importBatchId,
        } : {}),
      });
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

interface RetentionMetadata {
  readonly consentId: string;
  readonly retentionPolicyId: string;
  readonly eventTtlDays: number;
  readonly derivedTtlDays: number;
}

function recordsForCommit(commit: ImportCommit, asOf: number, retention?: RetentionMetadata): StoredRecord[] {
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
    ...(!retention && commit.source !== 'json-import' ? [{ id: FIXTURE_MARKER_ID, type: 'fixture_commit_v1', payload: { asOf, fixtureId: 'developer-day-bundled-v1' } satisfies FixtureMarker }] : []),
  ];
  const eventExpiresAt = retention ? new Date(asOf + retention.eventTtlDays * 86_400_000).toISOString() : undefined;
  const derivedExpiresAt = retention ? new Date(asOf + retention.derivedTtlDays * 86_400_000).toISOString() : undefined;
  return entities.map((entity) => toStoredRecord(entity.id, entity.type, entity.payload, writtenAt, retention ? {
    retentionClass: entity.type === 'behavior_event_v1' ? 'event' : 'derived',
    retentionPolicyId: retention.retentionPolicyId,
    consentId: retention.consentId,
    expiresAt: entity.type === 'behavior_event_v1' ? eventExpiresAt : derivedExpiresAt,
  } : {}));
}

function buildJsonImport(service: InsightServicePort, events: readonly BehaviorEvent[], identity: JsonImportInputIdentity): ImportCommit {
  const knowledge = service.knowledgeSnapshot();
  service.restoreEvents(events);
  const output = runInsightLoop(events, { asOf: latestEventAt(events), timezone: 'UTC', knowledge });
  service.hydrateKnowledge({ ...knowledge, claims: [...knowledge.claims, ...output.claims.filter((claim) => !knowledge.claims.some((known) => known.id === claim.id))] });
  return Object.freeze({
    events, output, acceptedCount: events.length, rejectedCount: 0, source: 'json-import' as const,
    importBatchId: identity.importBatchId,
  });
}

function buildReadonlyImport(
  service: InsightServicePort,
  events: readonly BehaviorEvent[],
  parsed: { readonly capturedAt: string; readonly timezone: string; readonly accepted: readonly unknown[]; readonly rejected: readonly unknown[]; readonly diagnostics: readonly { readonly code: string; readonly count: number }[]; readonly sourceItemKey: string },
  grant: ConsentGrant,
): ImportCommit {
  const knowledge = service.knowledgeSnapshot();
  service.restoreEvents(events);
  const output = runInsightLoop(events, { asOf: latestEventAt(events), timezone: parsed.timezone, knowledge });
  service.hydrateKnowledge({ ...knowledge, claims: [...knowledge.claims, ...output.claims.filter((claim) => !knowledge.claims.some((known) => known.id === claim.id))] });
  return Object.freeze({
    events, output, acceptedCount: parsed.accepted.length, rejectedCount: parsed.rejected.length,
    source: 'readonly-test-results' as const, consentId: grant.id, sourceItemKey: parsed.sourceItemKey,
    diagnostics: parsed.diagnostics.map((item) => ({ code: item.code, count: item.count })),
  });
}

function latestEventAt(events: readonly BehaviorEvent[]): string {
  return events.reduce((latest, event) => event.occurredAt > latest ? event.occurredAt : latest, '1970-01-01T00:00:00.000Z');
}

function parseJsonImportIdentity(value: unknown): JsonImportInputIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ERR_INPUT_IDENTITY_INVALID');
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort().join('|');
  if (keys !== 'importBatchId|inputHash|kind' || candidate.kind !== 'json-import'
    || typeof candidate.importBatchId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.importBatchId)
    || typeof candidate.inputHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(candidate.inputHash)) throw new Error('ERR_INPUT_IDENTITY_INVALID');
  return { kind: 'json-import', importBatchId: candidate.importBatchId, inputHash: candidate.inputHash as Hash };
}

function assertApplicationBehaviorEvent(event: BehaviorEvent): void {
  const decoded = decodeBehaviorEvent(event);
  if (hashCanonical({ ...decoded, id: undefined, contentHash: undefined }) !== decoded.contentHash) throw new Error('ERR_APP_EVENT_HASH');
}

function splitImportRecords(records: readonly StoredRecord[]): readonly (readonly StoredRecord[])[] {
  const maxBytes = 4 * 1024 * 1024;
  const batches: StoredRecord[][] = [];
  let current: StoredRecord[] = [];
  let currentBytes = 2;
  for (const record of records) {
    const mutationBytes = new TextEncoder().encode(JSON.stringify({ kind: 'insertImmutable', storeName: 'business', record })).byteLength;
    if (mutationBytes + 2 > maxBytes) throw new Error('ERR_BATCH_LIMIT');
    if (current.length >= 500 || (current.length > 0 && currentBytes + mutationBytes + 1 > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(record);
    currentBytes += mutationBytes + (current.length > 1 ? 1 : 0);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function readM2Clock(clock: () => number): number {
  const now = clock();
  if (!Number.isFinite(now)) throw new Error('ERR_CLOCK_UNAVAILABLE');
  return now;
}

function traceClock(clock: () => number): number {
  try {
    const value = clock();
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function toTraceResultCode(code: string): TraceResultCode {
  return /^(?:OK|PASS|FAIL|NOT_RUN|SKIPPED|ERR_[A-Z0-9_]+)$/.test(code) ? code as TraceResultCode : 'ERR_RUNTIME_BACKGROUND';
}

function traceCounts(value: unknown): TraceCounts | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const counts: TraceCounts = {};
  const fields: readonly (readonly [string, keyof TraceCounts])[] = [
    ['acceptedCount', 'accepted'], ['rejectedCount', 'rejected'], ['episodeCount', 'episodes'], ['insightCount', 'claims'],
  ];
  for (const [sourceKey, traceKey] of fields) {
    const item = source[sourceKey];
    if (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0) counts[traceKey] = item;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function isReadonlyEventRecord(record: StoredRecord): boolean {
  return record.recordType === 'behavior_event_v1' && Boolean(record.payload && typeof record.payload === 'object'
    && 'source' in record.payload && (record.payload as { source?: { kind?: unknown } }).source?.kind === 'readonly-adapter');
}

function assertConsentRecord(record: StoredRecord): void {
  const { contentHash, ...base } = record;
  if (contentHash === undefined || hashCanonical(base) !== contentHash) throw new Error('ERR_CONSENT_INVALID');
}

const LINEAGE_IDENTITY_FIELDS = [
  'id', 'contentHash', 'commandId', 'baseRevisionId', 'resultClaimRevisionId', 'parentRevisionId',
  'versionId', 'basedOnVersionId', 'causedByCorrectionId', 'actionIntentRevisionId',
] as const;

function runtimeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^ERR_[A-Z0-9_]+$/.test(message) ? message : 'ERR_RUNTIME_BACKGROUND';
}

type RuntimeErrorDisposition = 'expected' | 'fault';

const RUNTIME_ERROR_DISPOSITION: Readonly<Record<string, RuntimeErrorDisposition>> = Object.freeze({
  ERR_RUNTIME_CLOSED: 'expected',
  ERR_RUNTIME_FAULTED: 'expected',
  ERR_OPERATION_STALE: 'expected',
  ERR_NOT_FOUND: 'expected',
  ERR_PREVIEW_REQUIRED: 'expected',
  ERR_PREVIEW_STALE: 'expected',
  ERR_PREVIEW_INVALID: 'expected',
  ERR_PREVIEW_RETRY_INVALID: 'fault',
  ERR_COMMIT_RECONCILIATION_INVALID: 'fault',
  ERR_PREVIEW_BUFFER_MISSING: 'expected',
  ERR_PRIVACY_MODE: 'expected',
  ERR_PRIVACY_MODE_ACTIVE: 'expected',
  ERR_PURGE_IN_PROGRESS: 'expected',
  ERR_PURGE_QUIESCED: 'expected',
  ERR_PURGE_CLIENTS_PENDING: 'expected',
  ERR_PURGE_GENERATION_STALE: 'expected',
  ERR_PURGE_SEALED: 'expected',
  ERR_PURGE_SEALED_RETRY: 'expected',
  ERR_PURGE_CLIENT_UNKNOWN: 'expected',
  ERR_DELETION_STATE: 'expected',
  ERR_CURSOR_CONFLICT: 'expected',
  ERR_PRIVACY_EPOCH_STALE: 'expected',
  ERR_IMPORT_SESSION_STATE: 'expected',
  ERR_PROJECTION_STALE: 'expected',
  ERR_IDEMPOTENCY_CONFLICT: 'expected',
  ERR_PREVIEW_CONSUMED: 'expected',
  ERR_PREVIEW_EXPIRED: 'expected',
  ERR_PREVIEW_INPUT_MISMATCH: 'expected',
  ERR_PREVIEW_BATCH_MISMATCH: 'expected',
  ERR_RECOVERY_REQUIRED: 'expected',
  ERR_CLIENT_NOT_REGISTERED: 'expected',
  ERR_CLIENT_CLOSING: 'expected',
  ERR_RECOVERY_LEASE_HELD: 'expected',
  ERR_QUOTA_LOGICAL: 'expected',
  ERR_CHUNK_LIMIT: 'expected',
  ERR_BATCH_LIMIT: 'expected',
  ERR_SOURCE_ID_INVALID: 'expected',
  ERR_CONSENT_NOT_FOUND: 'expected',
  ERR_CONSENT_INVALID: 'expected',
  ERR_CONSENT_STALE: 'expected',
  ERR_CONSENT_SCOPE: 'expected',
  ERR_CONSENT_ALREADY_ACTIVE: 'expected',
  ERR_CLOCK_UNAVAILABLE: 'fault',
  ERR_CONSENT_REVOKED: 'expected',
  ERR_RETENTION_RANGE: 'expected',
  ERR_RETENTION_EXTENSION_REQUIRES_CONSENT: 'expected',
  ERR_RETENTION_POLICY_MISSING: 'expected',
  ERR_RETENTION_POLICY_INVALID: 'expected',
  ERR_NO_ACCEPTED_EVENTS: 'expected',
  ERR_PREVIEW_ALREADY_EXISTS: 'expected',
  ERR_WORKER_UNAVAILABLE: 'expected',
  ERR_WORKER_FAILURE: 'expected',
  ERR_WORKER_STREAM: 'expected',
  ERR_WORKER_ACK_MISMATCH: 'expected',
  ERR_WORKER_BYTES_HASH: 'expected',
  ERR_WORKER_RECEIPT_INVALID: 'expected',
  ERR_WORKER_VALIDATION: 'expected',
  ERR_WORKER_BACKPRESSURE: 'expected',
  ERR_WORKER_DECODER: 'expected',
  ERR_WORKER_SEQUENCE: 'expected',
  ERR_INVALID_UTF8: 'expected',
  ERR_STREAM_LIMIT: 'expected',
  ERR_LINE_LIMIT: 'expected',
  ERR_NDJSON_HEADER: 'expected',
  ERR_NDJSON_COUNT: 'expected',
  ERR_NDJSON_FOOTER: 'expected',
  ERR_NDJSON_JSON: 'expected',
  ERR_NDJSON_SCHEMA: 'expected',
  ERR_NDJSON_SEQUENCE: 'expected',
  ERR_NDJSON_COUNT_HASH: 'expected',
  ERR_NDJSON_TRAILING_BYTES: 'expected',
  ERR_NDJSON_DUPLICATE_HEADER: 'expected',
  ERR_NDJSON_INPUT_HASH: 'expected',
  ERR_NDJSON_REJECTED: 'expected',
  ERR_APP_SCHEMA_INVALID: 'expected',
  ERR_APP_EVENT_HASH: 'fault',
  ERR_INPUT_IDENTITY_INVALID: 'expected',
  ERR_IMPORT_RECEIPT_INVALID: 'fault',
  ERR_IMPORT_COUNT_MISMATCH: 'fault',
  ERR_RECORD_HASH_INVALID: 'fault',
  ERR_DELETE_REACHABLE_READONLY: 'fault',
});

function isBenignRuntimeError(error: unknown): boolean {
  return RUNTIME_ERROR_DISPOSITION[runtimeErrorCode(error)] === 'expected';
}

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

function expandLineageAnchors(records: readonly StoredRecord[], roots: readonly StoredRecord[]): readonly string[] {
  const anchors = new Set(roots.flatMap(identityAnchors));
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (!containsAnyRawAnchor(record, anchors)) continue;
      for (const anchor of identityAnchors(record)) {
        if (!anchors.has(anchor)) { anchors.add(anchor); changed = true; }
      }
    }
  }
  return [...anchors].sort();
}

function containsAnyRawAnchor(value: unknown, anchors: ReadonlySet<string>, depth = 0): boolean {
  if (depth > 256) throw new Error('ERR_MUTATION_DEPTH');
  if (typeof value === 'string') return anchors.has(value);
  if (Array.isArray(value)) return value.some((item) => containsAnyRawAnchor(item, anchors, depth + 1));
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some((item) => containsAnyRawAnchor(item, anchors, depth + 1));
  return false;
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

async function clearControlledCaches(
  timeoutMs = CACHE_CLEAR_TIMEOUT_MS,
  storage: BrowserRuntimeCacheStore | null = defaultCacheStore(),
  scheduler: BrowserRuntimeScheduler = DEFAULT_RUNTIME_SCHEDULER,
): Promise<boolean> {
  if (!storage) return true;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return false;
  let timedOut = false;
  const operation = (async () => {
    try {
      const keys = await storage.keys();
      await Promise.all(keys.map((key) => storage.delete(key)));
      return (await storage.keys()).length === 0;
    } catch {
      return false;
    }
  })().then((result) => timedOut ? false : result);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timeoutHandle = scheduler.setTimeout(() => { timedOut = true; resolve(false); }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutHandle) scheduler.clearTimeout(timeoutHandle);
  }
}
