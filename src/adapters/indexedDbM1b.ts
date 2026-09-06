import { hashCanonical, sha256 } from '../domain/canonical';
import type { Hash } from '../domain/types';
import type { RuntimeStoragePort } from '../application/storagePort';
import { toStoredRecord } from '../application/storageContracts';
export { makeBatch, toStoredRecord } from '../application/storageContracts';
import {
  CommitResponseLostError,
  M1bError,
  STORE_NAMES,
  type ActiveDeletionJournalRecord,
  type AtomicMutationBatch,
  type CanonicalMutation,
  type ClearAllResult,
  type ClientRegistrationRecord,
  type CommitLedgerRecord,
  type CommitResult,
  type Cursor,
  type DeletionPlanRecord,
  type DeletionTerminalRecord,
  type DeletionVerificationReceiptRecord,
  type DeletionWorkItemRecord,
  type ImportSessionRecord,
  type M1bRuntimeContract,
  type PreviewCommitGuardRecord,
  type PreviewCommitReceipt,
  type ProjectionHeadRecord,
  type PhysicalStoreName,
  type PurgeAckRecord,
  type PurgeWatermark,
  type ReachabilityResult,
  type RecoveryLeaseRecord,
  type StoreMetaRecord,
  type StoreName,
  type StoredRecord,
} from './m1bTypes';

const DB_VERSION = 4;
const OPEN_TIMEOUT_MS = 5_000;
const NORMAL_WRITE_LIMIT = 100 * 1024 * 1024;
const PREVIEW_RECEIPT_RETENTION_MS = 10 * 60 * 1000;
const RECOVERY_RESERVE = 5 * 1024 * 1024;
const LEASE_MS = 6_000;
const QUIESCENCE_DRAIN_TIMEOUT_MS = 10_000;
const ROOT_STORES: readonly PhysicalStoreName[] = ['meta', ...STORE_NAMES];

interface BufferedPreview {
  bytes: Uint8Array;
  bufferHandleHash: Hash;
  expiresAt: string;
}

interface CommitOptions {
  simulateResponseLoss?: boolean;
  preview?: { token: string; callerId: string };
}

export interface RootHooks {
  readonly freeze: () => void;
  readonly unfreeze: () => void;
}

interface RegisteredRoot {
  readonly rootId: string;
  readonly registrationKey: string;
  readonly ownerId: string;
  readonly revision: number;
  readonly read: () => readonly unknown[];
  readonly hooks: RootHooks;
}

interface RootQuiescence {
  readonly token: symbol;
  readonly deletionId: string;
  readonly generation: string;
  readonly revision: number;
  readonly frozenRoots: readonly RegisteredRoot[];
}

interface RootCoordinator {
  readonly roots: Map<string, RegisteredRoot>;
  revision: number;
  activeMutations: number;
  adapterRefs: number;
  readonly adapters: Set<IndexedDbM1bAdapter>;
  readonly deferredDisposals: Set<IndexedDbM1bAdapter>;
  readonly mutationWaiters: Set<() => void>;
  databaseDeletionPending?: Promise<boolean>;
  quiescence: RootQuiescence | null;
}

const rootCoordinators = new Map<string, RootCoordinator>();

function rootCoordinatorFor(databaseName: string): RootCoordinator {
  let coordinator = rootCoordinators.get(databaseName);
  if (!coordinator) {
    coordinator = { roots: new Map(), revision: 0, activeMutations: 0, adapterRefs: 0, adapters: new Set(), deferredDisposals: new Set(), mutationWaiters: new Set(), quiescence: null };
    rootCoordinators.set(databaseName, coordinator);
  }
  return coordinator;
}

function maybeDropRootCoordinator(databaseName: string, coordinator: RootCoordinator): void {
  if (coordinator.adapterRefs === 0 && coordinator.roots.size === 0 && coordinator.quiescence === null && coordinator.activeMutations === 0 && coordinator.deferredDisposals.size === 0 && coordinator.databaseDeletionPending === undefined && rootCoordinators.get(databaseName) === coordinator) rootCoordinators.delete(databaseName);
}

function sweepConsumedPreviewRecords(store: IDBObjectStore, records: readonly unknown[], now: number): void {
  const cutoff = now - PREVIEW_RECEIPT_RETENTION_MS;
  const receiptIds = new Set<string>();
  for (const value of records) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (record.recordType === 'preview_commit_guard' && record.state === 'CONSUMED' && typeof record.recordId === 'string' && typeof record.writtenAt === 'string' && Date.parse(record.writtenAt) <= cutoff) {
      if (typeof record.receiptId === 'string') receiptIds.add(record.receiptId);
      const tokenHash = typeof record.tokenHash === 'string' ? record.tokenHash : record.recordId.startsWith('preview-guard:') ? record.recordId.slice('preview-guard:'.length) : undefined;
      // Retain a compact, authenticated token tombstone when the bulky guard
      // and receipt expire. Known tokens must never become reusable.
      if (tokenHash && /^sha256:[0-9a-f]{64}$/.test(tokenHash)) {
        const tombstoneBase = { recordId: `preview-token-tombstone:${tokenHash}`, recordType: 'preview_token_tombstone', writtenAt: record.writtenAt, tokenHash, consumedAt: record.writtenAt };
        store.put({ ...tombstoneBase, contentHash: hashCanonical(tombstoneBase) });
        store.delete(record.recordId);
      }
    }
  }
  for (const value of records) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (record.recordType === 'observation_commit_receipt' && typeof record.recordId === 'string' && typeof record.writtenAt === 'string' && Date.parse(record.writtenAt) <= cutoff) store.delete(record.recordId);
  }
  receiptIds.forEach((receiptId) => store.delete(`preview-receipt:${receiptId}`));
}

export class IndexedDbM1bAdapter implements RuntimeStoragePort {
  static readonly runtimeContract: M1bRuntimeContract = Object.freeze({
    indexedDb: true,
    crossTabBrowserVerified: false,
    purgeCoverage: 'single-browser-in-process',
    broadcastChannelRequiredForCorrectness: false,
  });

  private db?: IDBDatabase;
  private opening?: Promise<IDBDatabase>;
  private readonly previewBuffers = new Map<Hash, BufferedPreview>();
  private readonly adapterId = crypto.randomUUID();
  private readonly ownedRootKeys = new Set<string>();
  private readonly rootCoordinator: RootCoordinator;
  private pendingDatabaseDeletion?: Promise<boolean>;
  private disposed = false;

  constructor(readonly databaseName = `proagi-m1b-${crypto.randomUUID()}`, private readonly clock: () => number = Date.now, private readonly openTimeoutMs = OPEN_TIMEOUT_MS) {
    if (!Number.isSafeInteger(openTimeoutMs) || openTimeoutMs <= 0) throw new M1bError('ERR_OPEN_TIMEOUT_INVALID');
    this.rootCoordinator = rootCoordinatorFor(databaseName);
    if (this.rootCoordinator.quiescence) throw new M1bError('ERR_PURGE_QUIESCED');
    this.rootCoordinator.adapterRefs += 1;
    this.rootCoordinator.adapters.add(this);
    this.rootCoordinator.revision += 1;
  }

  async open(): Promise<void> {
    if (this.disposed) throw new M1bError('ERR_STORAGE_UNAVAILABLE');
    if (this.pendingDatabaseDeletion || this.rootCoordinator.databaseDeletionPending) throw new M1bError('ERR_STORAGE_BLOCKED');
    if (this.db) return;
    if (this.opening) {
      const opened = await this.opening;
      if (this.disposed) throw new M1bError('ERR_STORAGE_UNAVAILABLE');
      if (!this.db) this.db = opened;
      return;
    }
    const request = indexedDB.open(this.databaseName, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'key' });
      const business = database.objectStoreNames.contains('business')
        ? request.transaction!.objectStore('business')
        : database.createObjectStore('business', { keyPath: 'recordId' });
      if (!business.indexNames.contains('byDedupeKey')) business.createIndex('byDedupeKey', 'payload.dedupeKey', { unique: true });
      if (!database.objectStoreNames.contains('system')) database.createObjectStore('system', { keyPath: 'recordId' });
      if (!database.objectStoreNames.contains('heads')) database.createObjectStore('heads', { keyPath: 'recordId' });
      if (!database.objectStoreNames.contains('ledger')) database.createObjectStore('ledger', { keyPath: 'idempotencyKey' });
      const journal = database.objectStoreNames.contains('journal')
         ? request.transaction!.objectStore('journal')
         : database.createObjectStore('journal', { keyPath: 'id' });
       if (!journal.indexNames.contains('byDeletionId')) journal.createIndex('byDeletionId', 'deletionId', { unique: false });
      if (!database.objectStoreNames.contains('audit')) database.createObjectStore('audit', { keyPath: 'recordId' });
      if (!database.objectStoreNames.contains('projection')) database.createObjectStore('projection', { keyPath: 'projectionId' });
      if (!database.objectStoreNames.contains('changes')) {
        const changes = database.createObjectStore('changes', { keyPath: 'id' });
        changes.createIndex('byCursor', 'cursor', { unique: false });
      }
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      if (oldVersion === 0) request.transaction?.objectStore('meta').put(initialMeta());
      else if (oldVersion < 3) migrateLegacyMeta(request.transaction!);
    };
    this.opening = openDatabaseRequest(request, this.openTimeoutMs);
    try {
      const opened = await this.opening;
      if (this.disposed) {
        opened.close();
        throw new M1bError('ERR_STORAGE_UNAVAILABLE');
      }
      this.db = opened;
      opened.onversionchange = () => {
        opened.close();
        if (this.db === opened) this.db = undefined;
      };
    } finally {
      this.opening = undefined;
    }
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  async destroy(): Promise<void> {
    if (this.disposed) return;
    if (this.rootCoordinator.quiescence) throw new M1bError('ERR_PURGE_QUIESCED');
    this.dispose();
    await deleteDatabase(this.databaseName);
  }

  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.previewBuffers.clear();
    this.disposed = true;
    if (this.rootCoordinator.quiescence) {
      this.rootCoordinator.deferredDisposals.add(this);
      return;
    }
    this.detachFromCoordinator();
  }

  private detachFromCoordinator(): void {
    for (const registrationKey of this.ownedRootKeys) {
      const root = this.rootCoordinator.roots.get(registrationKey);
      if (root?.ownerId === this.adapterId) {
        this.rootCoordinator.roots.delete(registrationKey);
        this.rootCoordinator.revision += 1;
      }
    }
    this.ownedRootKeys.clear();
    if (this.rootCoordinator.adapters.delete(this)) this.rootCoordinator.revision += 1;
    this.rootCoordinator.deferredDisposals.delete(this);
    this.rootCoordinator.adapterRefs = Math.max(0, this.rootCoordinator.adapterRefs - 1);
    maybeDropRootCoordinator(this.databaseName, this.rootCoordinator);
  }

  beginInProcessRootMutation(): () => void {
    if (this.rootCoordinator.quiescence) throw new M1bError('ERR_PURGE_QUIESCED');
    this.rootCoordinator.activeMutations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.rootCoordinator.activeMutations -= 1;
      if (this.rootCoordinator.activeMutations === 0) {
        const waiters = [...this.rootCoordinator.mutationWaiters];
        this.rootCoordinator.mutationWaiters.clear();
        waiters.forEach((resolve) => resolve());
      }
    };
  }

  private assertQuiescenceStable(): void {
    const quiescence = this.rootCoordinator.quiescence;
    if (!quiescence || quiescence.revision !== this.rootCoordinator.revision || this.rootCoordinator.activeMutations !== 0) {
      throw new M1bError('ERR_PURGE_QUIESCENCE_CHANGED');
    }
  }

  private releaseRootQuiescence(token: symbol, frozenRoots: readonly RegisteredRoot[]): unknown {
    if (this.rootCoordinator.quiescence?.token !== token) return undefined;
    let firstError: unknown;
    for (const root of [...frozenRoots].reverse()) {
      try { root.hooks.unfreeze(); } catch (error) { firstError ??= error; }
    }
    this.rootCoordinator.quiescence = null;
    const deferred = [...this.rootCoordinator.deferredDisposals];
    this.rootCoordinator.deferredDisposals.clear();
    for (const adapter of deferred) {
      try { adapter.detachFromCoordinator(); } catch (error) { firstError ??= error; }
    }
    maybeDropRootCoordinator(this.databaseName, this.rootCoordinator);
    return firstError;
  }

  private async acquireRootQuiescence(deletionId: string, generation: string, timeoutMs = QUIESCENCE_DRAIN_TIMEOUT_MS): Promise<() => void> {
    if (this.rootCoordinator.quiescence) throw new M1bError('ERR_PURGE_QUIESCENCE_BUSY');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new M1bError('ERR_PURGE_QUIESCENCE_TIMEOUT');
    const token = Symbol('root-quiescence');
    // Publish the barrier before waiting so no new mutation or topology change
    // can enter while already-admitted work drains.
    this.rootCoordinator.quiescence = { token, deletionId, generation, revision: this.rootCoordinator.revision, frozenRoots: [] };
    if (this.rootCoordinator.activeMutations > 0) {
      const drain = new Promise<void>((resolve) => this.rootCoordinator.mutationWaiters.add(resolve));
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => { timeoutHandle = setTimeout(() => resolve(false), timeoutMs); });
      const drained = await Promise.race([drain.then(() => true), timeout]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (!drained) {
        void drain.then(() => { this.releaseRootQuiescence(token, []); });
        throw new M1bError('ERR_PURGE_QUIESCENCE_TIMEOUT');
      }
    }
    const frozenRoots = [...this.rootCoordinator.roots.values()];
    this.rootCoordinator.quiescence = { token, deletionId, generation, revision: this.rootCoordinator.revision, frozenRoots };
    const frozen: RegisteredRoot[] = [];
    try {
      for (const root of frozenRoots) {
        root.hooks.freeze();
        frozen.push(root);
      }
    } catch (error) {
      const cleanupError = this.releaseRootQuiescence(token, frozen);
      throw error ?? cleanupError;
    }
    return () => {
      const cleanupError = this.releaseRootQuiescence(token, frozen);
      if (cleanupError) throw new M1bError('ERR_PURGE_UNFREEZE');
    };
  }

  registerInProcessRoot(rootId: string, read: () => readonly unknown[], hooks: RootHooks): () => void {
    if (this.rootCoordinator.quiescence) throw new M1bError('ERR_PURGE_QUIESCED');
    const registrationKey = `${this.adapterId}:${rootId}`;
    if (this.rootCoordinator.roots.has(registrationKey)) throw new M1bError('ERR_DUPLICATE_ROOT');
    const revision = ++this.rootCoordinator.revision;
    const entry = { rootId, registrationKey, ownerId: this.adapterId, revision, read, hooks };
    this.rootCoordinator.roots.set(registrationKey, entry);
    this.ownedRootKeys.add(registrationKey);
    return () => {
      if (this.rootCoordinator.quiescence) throw new M1bError('ERR_PURGE_QUIESCED');
      const current = this.rootCoordinator.roots.get(registrationKey);
      if (current?.ownerId !== this.adapterId || current.revision !== revision) return;
      this.rootCoordinator.roots.delete(registrationKey);
      this.ownedRootKeys.delete(registrationKey);
      this.rootCoordinator.revision += 1;
      maybeDropRootCoordinator(this.databaseName, this.rootCoordinator);
    };
  }

  getRuntimeContract(): M1bRuntimeContract {
    return IndexedDbM1bAdapter.runtimeContract;
  }

  async getMeta(): Promise<StoreMetaRecord> {
    const db = await this.database();
    const tx = db.transaction('meta', 'readonly');
    const result = await requestValue<StoreMetaRecord>(tx.objectStore('meta').get('canonical'));
    await transactionDone(tx);
    if (!result) throw new M1bError('ERR_STORAGE_CORRUPT');
    assertMetaWatermarks(result);
    return result;
  }

  async getRecord<T>(storeName: StoreName, key: IDBValidKey): Promise<T | undefined> {
    const db = await this.database();
    const tx = db.transaction(storeName, 'readonly');
    const value = await requestValue<T | undefined>(tx.objectStore(storeName).get(key));
    await transactionDone(tx);
    return value;
  }

  async getAll<T>(storeName: StoreName): Promise<T[]> {
    const db = await this.database();
    const tx = db.transaction(storeName, 'readonly');
    const values = await requestValue<T[]>(tx.objectStore(storeName).getAll());
    await transactionDone(tx);
    return values;
  }

  async readPurgeFence(): Promise<{ meta: StoreMetaRecord; journals: ActiveDeletionJournalRecord[] }> {
    const db = await this.database();
    const tx = db.transaction(['meta', 'journal'], 'readonly');
    const done = transactionDone(tx);
    try {
      const meta = await requestValue<StoreMetaRecord>(tx.objectStore('meta').get('canonical'));
       const journals = await requestValue<ActiveDeletionJournalRecord[]>(tx.objectStore('journal').getAll());
      if (!meta) throw new M1bError('ERR_STORAGE_CORRUPT');
      assertMetaWatermarks(meta);
      assertJournalCollection(journals);
      await done;
      return { meta, journals };
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
  }

  async readCanonicalSnapshot(): Promise<{ meta: StoreMetaRecord; business: StoredRecord[]; heads: StoredRecord[] }> {
    const db = await this.database();
    const tx = db.transaction(['meta', 'business', 'heads'], 'readonly');
    const done = transactionDone(tx);
    try {
      const meta = await requestValue<StoreMetaRecord>(tx.objectStore('meta').get('canonical'));
      const business = await requestValue<StoredRecord[]>(tx.objectStore('business').getAll());
      const heads = await requestValue<StoredRecord[]>(tx.objectStore('heads').getAll());
       assertStoredRecordCollection(business, 'ERR_BUSINESS_RECORD_HASH_INVALID');
       assertStoredRecordCollection(heads, 'ERR_HEAD_RECORD_HASH_INVALID');
      if (!meta) throw new M1bError('ERR_STORAGE_CORRUPT');
      assertMetaWatermarks(meta);
      await done;
      return { meta, business, heads };
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
  }

  async commit(batch: AtomicMutationBatch, options: Omit<CommitOptions, 'preview'> = {}): Promise<CommitResult> {
    return this.commitInternal(batch, options);
  }

  async setPrivacyMode(expectedCursor: Cursor, expectedPrivacyEpoch: number, mode: 'ACTIVE' | 'PRIVATE', idempotencyKey: string): Promise<CommitResult> {
    const releaseMutation = this.beginInProcessRootMutation();
    try {
      const db = await this.database();
    const tx = this.mutationTransaction(db, ['meta', 'ledger', 'system'], 'readwrite');
    const done = transactionDone(tx);
    try {
      const metaStore = tx.objectStore('meta');
      const ledgerStore = tx.objectStore('ledger');
      const systemStore = tx.objectStore('system');
      const batchHash = hashCanonical({ kind: 'privacy-mode', expectedCursor, expectedPrivacyEpoch, mode });
      const prior = await requestValue<CommitLedgerRecord | undefined>(ledgerStore.get(idempotencyKey));
      if (prior) {
        if (prior.batchHash !== batchHash) throw new M1bError('ERR_IDEMPOTENCY_CONFLICT');
        await done;
        return { cursor: prior.committedCursor, applied: false, ledger: prior };
      }
      const meta = await requestValue<StoreMetaRecord>(metaStore.get('canonical'));
      assertMeta(meta, expectedCursor, expectedPrivacyEpoch, false);
      const nextCursor = incrementCursor(meta.cursor);
      const nextMeta: StoreMetaRecord = { ...meta, cursor: nextCursor, privacyEpoch: meta.privacyEpoch + 1, observationMode: mode };
      const invalidatedRefs: { recordType: string; recordId: string }[] = [];
      if (mode === 'PRIVATE') {
        const systemRecords = await requestValue<Array<StoredRecord | ImportSessionRecord>>(systemStore.getAll());
        for (const record of systemRecords) {
          const cancelImport = record.recordType === 'import_staging'
            || (record.recordType === 'import_session' && (record as ImportSessionRecord).state !== 'PUBLISHED');
          if (record.recordType === 'preview_commit_guard' || cancelImport) {
            systemStore.delete(record.recordId);
            invalidatedRefs.push({ recordType: record.recordType, recordId: record.recordId });
          }
        }
      }
      const ledger: CommitLedgerRecord = {
        idempotencyKey,
        batchHash,
        committedCursor: nextCursor,
        affectedRefs: [{ recordType: 'store_meta', recordId: 'canonical' }, ...invalidatedRefs],
        committedAt: new Date().toISOString(),
      };
      metaStore.put(nextMeta);
      ledgerStore.add(ledger);
      await done;
      if (mode === 'PRIVATE') this.previewBuffers.clear();
      return { cursor: nextCursor, applied: true, ledger };
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    } finally {
      releaseMutation();
    }
  }

  async stagePreview(input: {
    token?: string;
    callerId: string;
    idempotencyKey: string;
    inputHash: Hash;
    bytes: Uint8Array;
    privacyEpoch: number;
    expiresAt: string;
  }): Promise<{ token: string; guard: PreviewCommitGuardRecord }> {
    return this.withRootMutation(async () => {
    const bytes = input.bytes.slice();
    const { callerId, idempotencyKey, inputHash, privacyEpoch, expiresAt, token: suppliedToken } = input;
    if (bytes.byteLength > 262_144) throw new M1bError('ERR_CHUNK_LIMIT');
    const now = this.clock();
    if (inputHash !== sha256(new TextDecoder().decode(bytes))) throw new M1bError('ERR_PREVIEW_INPUT_MISMATCH');
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now) throw new M1bError('ERR_PREVIEW_EXPIRED');
    this.sweepExpiredPreviewBuffers(now);
    const retainedBytes = [...this.previewBuffers.values()].reduce((sum, item) => sum + item.bytes.byteLength, 0);
    if (retainedBytes + bytes.byteLength > 4_194_304) throw new M1bError('ERR_QUOTA_LOGICAL');
    const db = await this.database();
    const token = suppliedToken ?? `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const tokenHash = sha256(token);
    const bufferHandleHash = hashBytes(bytes);
    const recordId = `preview-guard:${tokenHash}`;
    const writtenAt = new Date().toISOString();
    const guardBase = {
      recordId,
      recordType: 'preview_commit_guard' as const,
      writtenAt,
      tokenHash,
      bufferHandleHash,
      inputHash: inputHash,
      privacyEpoch: privacyEpoch,
      callerId: callerId,
      expiresAt: expiresAt,
      state: 'READY' as const,
      idempotencyKey: idempotencyKey,
    };
    const guard: PreviewCommitGuardRecord = { ...guardBase, contentHash: hashCanonical(guardBase) };
    const tx = this.mutationTransaction(db, ['meta', 'system'], 'readwrite');
    const done = transactionDone(tx);
    try {
      const meta = await requestValue<StoreMetaRecord>(tx.objectStore('meta').get('canonical'));
      assertMeta(meta, meta.cursor, privacyEpoch, true);
      assertNoPurgedPreviewReference(bytes, meta);
      const system = tx.objectStore('system');
      const existing = await requestValue<Record<string, unknown>[]>(system.getAll());
      sweepConsumedPreviewRecords(system, existing, now);
      const tokenTombstoneId = `preview-token-tombstone:${tokenHash}`;
      const tokenReuseRejected = existing.some((record) => (record.recordType === 'preview_token_tombstone' && record.recordId === tokenTombstoneId) || (record.recordType === 'preview_commit_guard' && record.recordId === recordId && record.state === 'CONSUMED'));
      for (const record of existing) {
        if (record.recordType === 'preview_commit_guard' && record.state === 'READY' && typeof record.recordId === 'string' && typeof record.expiresAt === 'string' && Date.parse(record.expiresAt) <= now) system.delete(record.recordId);
      }
      if (!tokenReuseRejected) system.add(guard);
      await done;
      if (tokenReuseRejected) throw new M1bError('ERR_PREVIEW_CONSUMED');
      this.previewBuffers.set(tokenHash, { bytes, bufferHandleHash, expiresAt: expiresAt });
      return { token, guard };
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async bindPreviewBatch(token: string, batchHash: Hash): Promise<PreviewCommitGuardRecord> {
    return this.withRootMutation(async () => {
    const db = await this.database();
    const tx = this.mutationTransaction(db, 'system', 'readwrite');
    const done = transactionDone(tx);
    try {
      const store = tx.objectStore('system');
      const guard = await requestValue<PreviewCommitGuardRecord | undefined>(store.get(`preview-guard:${sha256(token)}`));
      if (!guard) throw new M1bError('ERR_PREVIEW_INVALID');
      assertCanonicalHash(guard, 'ERR_PREVIEW_INVALID');
      if (guard.state !== 'READY') throw new M1bError('ERR_PREVIEW_CONSUMED');
      if (guard.batchHash && guard.batchHash !== batchHash) throw new M1bError('ERR_PREVIEW_BATCH_MISMATCH');
      const base = { ...guard, batchHash, writtenAt: new Date().toISOString() };
      const next: PreviewCommitGuardRecord = { ...base, contentHash: hashCanonical(withoutHash(base)) };
      store.put(next);
      await done;
      return next;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async commitPreview(token: string, callerId: string, batch: AtomicMutationBatch, _legacyNow?: string, simulateResponseLoss = false): Promise<CommitResult> {
    return this.commitInternal(batch, { preview: { token, callerId }, simulateResponseLoss });
  }

  releasePreviewBuffer(token: string): void {
    const releaseMutation = this.beginInProcessRootMutation();
    try {
      this.previewBuffers.delete(sha256(token));
    } finally {
      releaseMutation();
    }
  }

  async cancelPreview(token: string): Promise<void> {
    return this.withRootMutation(async () => {
    const tokenHash = sha256(token);
    const db = await this.database();
    const tx = this.mutationTransaction(db, 'system', 'readwrite');
    this.previewBuffers.delete(tokenHash);
    const done = transactionDone(tx);
    tx.objectStore('system').delete(`preview-guard:${tokenHash}`);
    await done;
    });
  }

  async publishProjection(next: ProjectionHeadRecord, expectedSourceCursor: Cursor): Promise<{ applied: boolean; head: ProjectionHeadRecord }> {
    return this.withRootMutation(async () => {
    const db = await this.database();
    const tx = this.mutationTransaction(db, ['meta', 'projection'], 'readwrite');
    const done = transactionDone(tx);
    try {
      const store = tx.objectStore('projection');
       assertProjectionHead(next, 'ERR_PROJECTION_HASH_INVALID');
      const meta = await requestValue<StoreMetaRecord>(tx.objectStore('meta').get('canonical'));
      if (meta.recoveryMode !== 'NORMAL') throw new M1bError('ERR_RECOVERY_REQUIRED');
      assertNoPurgedReference({ kind: 'casProjectionHead', storeName: 'projection', expectedSourceCursor, next }, meta);
       const current = await requestValue<ProjectionHeadRecord | undefined>(store.get(next.projectionId));
      const actual = current?.sourceCursor ?? '0';
      if (actual !== expectedSourceCursor) throw new M1bError('ERR_PROJECTION_STALE');
      if (BigInt(next.sourceCursor) < BigInt(actual) || BigInt(next.sourceCursor) > BigInt(meta.cursor)) throw new M1bError('ERR_PROJECTION_STALE');
      store.put(next);
      await done;
      return { applied: true, head: next };
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async createImportSession(streamId: string, sessionId: string = crypto.randomUUID()): Promise<ImportSessionRecord> {
    return this.withRootMutation(async () => {
    const db = await this.database();
    const tx = this.mutationTransaction(db, ['meta', 'system'], 'readwrite');
    const done = transactionDone(tx);
    try {
      const meta = await requestValue<StoreMetaRecord>(tx.objectStore('meta').get('canonical'));
      assertMeta(meta, meta.cursor, meta.privacyEpoch, true);
      const base = {
        recordId: `import-session:${sessionId}`,
        recordType: 'import_session' as const,
        writtenAt: new Date().toISOString(),
        streamId,
        state: 'RECEIVING' as const,
        baseCursor: meta.cursor,
        privacyEpoch: meta.privacyEpoch,
        committedBatchHashes: [] as readonly Hash[],
        committedEventCount: 0,
      };
      const session: ImportSessionRecord = { ...base, contentHash: hashCanonical(base) };
      tx.objectStore('system').add(session);
      await done;
      return session;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async stageImportBatch(sessionId: string, records: readonly StoredRecord[], batchHash: Hash): Promise<ImportSessionRecord> {
    return this.withRootMutation(async () => {
    const snapshotRecords = structuredClone(records);
    if (hashCanonical(snapshotRecords) !== batchHash) throw new M1bError('ERR_BATCH_HASH_MISMATCH');
    const db = await this.database();
    const tx = this.mutationTransaction(db, ['meta', 'system'], 'readwrite');
    const done = transactionDone(tx);
    try {
      const metaStore = tx.objectStore('meta');
      const system = tx.objectStore('system');
      const meta = await requestValue<StoreMetaRecord>(metaStore.get('canonical'));
      const key = `import-session:${sessionId}`;
      const session = await requestValue<ImportSessionRecord | undefined>(system.get(key));
      if (!session || !['RECEIVING', 'VALIDATED', 'COMMITTING'].includes(session.state)) throw new M1bError('ERR_IMPORT_SESSION_STATE');
       assertCanonicalHash(session, 'ERR_IMPORT_SESSION_HASH_INVALID');
      if (session.privacyEpoch !== meta.privacyEpoch || meta.observationMode !== 'ACTIVE' || meta.recoveryMode !== 'NORMAL') throw new M1bError('ERR_PRIVACY_EPOCH_STALE');
      assertStoredRecordCollection(snapshotRecords, 'ERR_RECORD_HASH_INVALID');
       if (!/^sha256:[0-9a-f]{64}$/.test(batchHash)) throw new M1bError('ERR_BATCH_HASH_MISMATCH');
       let delta = 0;
      for (const record of snapshotRecords) {
        assertNoPurgedReference({ kind: 'insertImmutable', storeName: 'business', record }, meta);
         const staged = toStoredRecord(`import-stage:${sessionId}:${record.recordId}`, 'import_staging', { sessionId, record });
        delta += estimateBytes(staged);
        system.add(staged);
      }
      if (meta.logicalBytes + delta > NORMAL_WRITE_LIMIT) throw new M1bError('ERR_QUOTA_LOGICAL');
      const nextBase = {
        ...session,
        state: 'COMMITTING' as const,
        committedBatchHashes: [...session.committedBatchHashes, batchHash],
        committedEventCount: session.committedEventCount + snapshotRecords.length,
        writtenAt: new Date().toISOString(),
      };
      const next: ImportSessionRecord = { ...nextBase, contentHash: hashCanonical(withoutHash(nextBase)) };
      system.put(next);
      metaStore.put({ ...meta, logicalBytes: meta.logicalBytes + delta });
      await done;
      return next;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async publishImportSession(sessionId: string, idempotencyKey: string): Promise<CommitResult> {
    return this.withRootMutation(async () => {
    const db = await this.database();
    const tx = this.mutationTransaction(db, ['meta', 'system', 'business', 'ledger', 'changes'], 'readwrite');
    const done = transactionDone(tx);
    try {
      const metaStore = tx.objectStore('meta');
      const system = tx.objectStore('system');
      const ledgerStore = tx.objectStore('ledger');
      const prior = await requestValue<CommitLedgerRecord | undefined>(ledgerStore.get(idempotencyKey));
      const sessionKey = `import-session:${sessionId}`;
      const session = await requestValue<ImportSessionRecord | undefined>(system.get(sessionKey));
      if (!session) throw new M1bError('ERR_IMPORT_SESSION_STATE');
       assertCanonicalHash(session, 'ERR_IMPORT_SESSION_HASH_INVALID');
      const batchHash = hashCanonical({ kind: 'publish-import', sessionId, hashes: session.committedBatchHashes });
      if (prior) {
        if (prior.batchHash !== batchHash) throw new M1bError('ERR_IDEMPOTENCY_CONFLICT');
        await done;
        return { cursor: prior.committedCursor, applied: false, ledger: prior };
      }
      const meta = await requestValue<StoreMetaRecord>(metaStore.get('canonical'));
      if (session.state !== 'COMMITTING' || session.privacyEpoch !== meta.privacyEpoch || meta.observationMode !== 'ACTIVE' || meta.recoveryMode !== 'NORMAL') throw new M1bError('ERR_IMPORT_SESSION_STATE');
      const staged = (await requestValue<StoredRecord<{ sessionId: string; record: StoredRecord }>[] >(system.getAll()))
        .filter((record) => record.recordType === 'import_staging' && record.payload?.sessionId === sessionId);
      if (staged.length !== session.committedEventCount) throw new M1bError('ERR_IMPORT_COUNT_MISMATCH');
       assertStoredRecordCollection(staged, 'ERR_RECORD_HASH_INVALID');
      const nextCursor = incrementCursor(meta.cursor);
      const affectedRefs: { recordType: string; recordId: string }[] = [];
      let reclaimed = 0;
      staged.sort((a, b) => a.recordId.localeCompare(b.recordId));
      for (const stagedRecord of staged) {
        const record = stagedRecord.payload.record;
         assertCanonicalHash(record, 'ERR_RECORD_HASH_INVALID');
        tx.objectStore('business').add(record);
        system.delete(stagedRecord.recordId);
        reclaimed += estimateBytes(stagedRecord);
        affectedRefs.push({ recordType: record.recordType, recordId: record.recordId });
      }
      const publishedBase = { ...session, state: 'PUBLISHED' as const, publishedCursor: nextCursor, writtenAt: new Date().toISOString() };
      const published: ImportSessionRecord = { ...publishedBase, contentHash: hashCanonical(withoutHash(publishedBase)) };
      system.put(published);
      affectedRefs.forEach((ref, index) => tx.objectStore('changes').add({ id: `${nextCursor}:${index}`, cursor: nextCursor, change: 'put', ...ref }));
      const ledger: CommitLedgerRecord = { idempotencyKey, batchHash, committedCursor: nextCursor, affectedRefs, committedAt: new Date().toISOString() };
      ledgerStore.add(ledger);
      metaStore.put({ ...meta, cursor: nextCursor, logicalBytes: Math.max(0, meta.logicalBytes - reclaimed) });
      await done;
      return { cursor: nextCursor, applied: true, ledger };
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async cancelImportSession(sessionId: string): Promise<void> {
    return this.withRootMutation(async () => {
    const db = await this.database();
    const tx = this.mutationTransaction(db, ['meta', 'system'], 'readwrite');
    const done = transactionDone(tx);
    const system = tx.objectStore('system');
    const metaStore = tx.objectStore('meta');
    try {
      const sessionKey = `import-session:${sessionId}`;
      const session = await requestValue<ImportSessionRecord | undefined>(system.get(sessionKey));
      if (!session || session.state === 'PUBLISHED') throw new M1bError('ERR_IMPORT_SESSION_STATE');
      const all = await requestValue<StoredRecord[]>(system.getAll());
      let reclaimed = 0;
      for (const record of all) {
        if (record.recordType === 'import_staging' && deepContains(record, sessionId)) {
          system.delete(record.recordId);
          reclaimed += estimateBytes(record);
        }
      }
      const cancelledBase = { ...session, state: 'CANCELLED' as const, writtenAt: new Date().toISOString() };
      system.put({ ...cancelledBase, contentHash: hashCanonical(withoutHash(cancelledBase)) });
      const meta = await requestValue<StoreMetaRecord>(metaStore.get('canonical'));
      metaStore.put({ ...meta, logicalBytes: Math.max(0, meta.logicalBytes - reclaimed) });
      await done;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async scanPublishedBusiness(): Promise<StoredRecord[]> {
    const records = await this.getAll<StoredRecord>('business');
    assertStoredRecordCollection(records, 'ERR_BUSINESS_RECORD_HASH_INVALID');
    return records;
  }

  async registerClient(clientId: string, now = Date.now()): Promise<ClientRegistrationRecord> {
    return this.withRootMutation(async () => {
    const db = await this.database();
    const tx = this.mutationTransaction(db, ['system', 'journal'], 'readwrite');
    const done = transactionDone(tx);
    try {
       const current = await requestValue<ClientRegistrationRecord | undefined>(tx.objectStore('system').get(`client:${clientId}`));
       const journals = await requestValue<ActiveDeletionJournalRecord[]>(tx.objectStore('journal').getAll());
      assertJournalCollection(journals);
       const active = journals.find((journal) => journal.recordType === 'active_deletion_journal' && journal.state !== 'FAILED');
       if (active?.purge.sealedAt) throw new M1bError('ERR_PURGE_SEALED_RETRY');
       const failed = journals.some((journal) => journal.recordType === 'active_deletion_journal' && journal.state === 'FAILED');
       if (failed) throw new M1bError('ERR_RECOVERY_FAILED');
       const stickyQuarantine = !active && current?.state === 'QUARANTINED' && Boolean(current.purgeGeneration) && current.purgeAckGeneration !== current.purgeGeneration;
       const state: ClientRegistrationRecord['state'] = active || stickyQuarantine ? 'QUARANTINED' : 'ACTIVE';
      const base = {
        recordId: `client:${clientId}`,
        recordType: 'client_registration' as const,
        writtenAt: new Date(now).toISOString(),
        clientId,
        leaseExpiresAt: new Date(now + LEASE_MS).toISOString(),
        state,
        purgeGeneration: active?.purge.generation ?? (stickyQuarantine ? current?.purgeGeneration : undefined),
         purgeAckGeneration: current?.purgeAckGeneration,
      };
      const record: ClientRegistrationRecord = { ...base, contentHash: hashCanonical(base) };
      tx.objectStore('system').put(record);
      if (active && !active.purge.sealedAt && !active.purge.requiredClientIds.includes(clientId)) {
        const next = updateJournalHash({ ...active, purge: { ...active.purge, requiredClientIds: [...active.purge.requiredClientIds, clientId].sort() }, updatedAt: new Date(now).toISOString() });
        tx.objectStore('journal').put(next);
      }
      await done;
      return record;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async closeClient(clientId: string, now = Date.now()): Promise<void> {
    return this.withRootMutation(async () => {
    const db = await this.database();
    const tx = this.mutationTransaction(db, 'system', 'readwrite');
    const done = transactionDone(tx);
    try {
      const store = tx.objectStore('system');
      const record = await requestValue<ClientRegistrationRecord | undefined>(store.get(`client:${clientId}`));
      if (record?.recordType === 'client_registration') {
        assertClientRegistration(record);
         const next = { ...record, state: 'CLOSING' as const, leaseExpiresAt: new Date(now).toISOString(), writtenAt: new Date(now).toISOString() };
        store.put({ ...next, contentHash: hashCanonical(withoutHash(next)) });
      }
      await done;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async renewClient(clientId: string, now = Date.now()): Promise<ClientRegistrationRecord> {
    return this.withRootMutation(async () => {
    const db = await this.database();
    const tx = this.mutationTransaction(db, ['system', 'journal'], 'readwrite');
    const done = transactionDone(tx);
    try {
      const store = tx.objectStore('system');
      const current = await requestValue<ClientRegistrationRecord | undefined>(store.get(`client:${clientId}`));
      if (!current || current.recordType !== 'client_registration') throw new M1bError('ERR_CLIENT_NOT_REGISTERED');
      if (current.state === 'CLOSING') throw new M1bError('ERR_CLIENT_CLOSING');
       assertClientRegistration(current);
      const journals = await requestValue<ActiveDeletionJournalRecord[]>(tx.objectStore('journal').getAll());
      assertJournalCollection(journals);
       const active = journals.find((item) => item.recordType === 'active_deletion_journal' && item.state !== 'FAILED');
       const failed = journals.some((item) => item.recordType === 'active_deletion_journal' && item.state === 'FAILED');
       if (failed) throw new M1bError('ERR_RECOVERY_FAILED');
       const stickyQuarantine = !active && current.state === 'QUARANTINED' && Boolean(current.purgeGeneration) && current.purgeAckGeneration !== current.purgeGeneration;
       const quarantined = Boolean(active) || stickyQuarantine;
       const next = { ...current, state: quarantined ? 'QUARANTINED' as const : 'ACTIVE' as const, leaseExpiresAt: new Date(now + LEASE_MS).toISOString(), writtenAt: new Date(now).toISOString(), ...(active || stickyQuarantine ? { purgeGeneration: active?.purge.generation ?? current.purgeGeneration } : { purgeGeneration: undefined }) };
      if (active && !active.purge.sealedAt && !active.purge.requiredClientIds.includes(clientId)) {
        tx.objectStore('journal').put(updateJournalHash({ ...active, purge: { ...active.purge, requiredClientIds: [...active.purge.requiredClientIds, clientId].sort() }, updatedAt: new Date(now).toISOString() }));
      }
      const record = { ...next, contentHash: hashCanonical(withoutHash(next)) };
      store.put(record);
      await done;
      return record;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async planDeletion(target: { storeName: StoreName; recordId: string; contentHash: Hash; recordType: string; lineageAnchorDigests?: readonly Hash[] }, cause: DeletionPlanRecord['cause'] = 'user-delete'): Promise<DeletionPlanRecord> {
    return this.withRootMutation(async () => {
      const targetSnapshot = structuredClone(target);
      const db = await this.database();
      const tx = db.transaction([...ROOT_STORES], 'readonly');
      const meta = await requestValue<StoreMetaRecord>(tx.objectStore('meta').get('canonical'));
      const snapshot = await snapshotHash(tx);
      await transactionDone(tx);
      const base = {
        recordId: `deletion-plan:${crypto.randomUUID()}`,
        recordType: 'deletion_plan' as const,
        writtenAt: new Date().toISOString(),
        target: targetSnapshot,
        cause,
        baseCursor: meta.cursor,
        basePrivacyEpoch: meta.privacyEpoch,
        baseSnapshotHash: snapshot,
        closureRulesHash: hashCanonical({ roots: ROOT_STORES, version: 'm1b-root-registry-v1' }),
      };
      const planHash = hashCanonical(base);
      return { ...base, planHash, contentHash: hashCanonical({ ...base, planHash }) };
    });
  }

  async fenceDeletion(plan: DeletionPlanRecord, ownerClientId: string, now = Date.now()): Promise<{ journal: ActiveDeletionJournalRecord; lease: RecoveryLeaseRecord }> {
    return this.withRootMutation(async () => {
    const planSnapshot = structuredClone(plan);
    const db = await this.database();
    const tx = this.mutationTransaction(db, [...ROOT_STORES], 'readwrite');
    const done = transactionDone(tx);
    try {
      const metaStore = tx.objectStore('meta');
      const meta = await requestValue<StoreMetaRecord>(metaStore.get('canonical'));
      if (!meta) throw new M1bError('ERR_STORAGE_CORRUPT');
      assertMetaWatermarks(meta);
      assertCanonicalHash(planSnapshot, 'ERR_DELETION_PLAN_HASH_INVALID');
      if (planSnapshot.target.lineageAnchorDigests?.some((digest: unknown) => typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest))) throw new M1bError('ERR_DELETION_PLAN_HASH_INVALID');
      const currentSnapshotHash = await snapshotHash(tx);
      const recomputedPlanHash = hashCanonical({
        recordId: planSnapshot.recordId,
        recordType: planSnapshot.recordType,
        writtenAt: planSnapshot.writtenAt,
        target: planSnapshot.target,
        cause: planSnapshot.cause,
        baseCursor: planSnapshot.baseCursor,
        basePrivacyEpoch: planSnapshot.basePrivacyEpoch,
        baseSnapshotHash: planSnapshot.baseSnapshotHash,
        closureRulesHash: planSnapshot.closureRulesHash,
      });
      if (meta.cursor !== planSnapshot.baseCursor || meta.privacyEpoch !== planSnapshot.basePrivacyEpoch || meta.recoveryMode !== 'NORMAL' || currentSnapshotHash !== planSnapshot.baseSnapshotHash || recomputedPlanHash !== planSnapshot.planHash) throw new M1bError('ERR_CURSOR_CONFLICT');
      const generation = crypto.randomUUID();
      const registrations = (await requestValue<Array<ClientRegistrationRecord | StoredRecord>>(tx.objectStore('system').getAll())).filter((record): record is ClientRegistrationRecord => record.recordType === 'client_registration');
       registrations.forEach((record) => assertClientRegistration(record));
       const requiredClientIds = registrations
        .filter((record) => record.state === 'ACTIVE' && Date.parse(record.leaseExpiresAt) > now)
        .map((record) => record.clientId)
        .sort();
      const systemStore = tx.objectStore('system');
       for (const registration of registrations) {
         if (!requiredClientIds.includes(registration.clientId)) continue;
         const quarantined = { ...registration, state: 'QUARANTINED' as const, purgeGeneration: generation, writtenAt: new Date(now).toISOString() };
         systemStore.put({ ...quarantined, contentHash: hashCanonical(withoutHash(quarantined)) });
       }
       const journalBase: ActiveDeletionJournalRecord = {
        id: `active-deletion:${crypto.randomUUID()}`,
        recordType: 'active_deletion_journal',
        state: 'FENCED',
        planId: planSnapshot.recordId,
        planHash: planSnapshot.planHash,
        targetId: planSnapshot.target.recordId,
        targetHash: planSnapshot.target.contentHash,
        targetType: planSnapshot.target.recordType,
        targetAnchors: [...new Set([sha256(planSnapshot.target.recordId), sha256(planSnapshot.target.contentHash), ...(planSnapshot.target.lineageAnchorDigests ?? [])])].sort(),
        baseCursor: planSnapshot.baseCursor,
        basePrivacyEpoch: planSnapshot.basePrivacyEpoch,
        enumeration: { registryIndex: 0, pageOffset: 0, complete: false, enumeratedCount: 0 },
        progress: { nextOrdinal: '0', completedCount: 0, totalCount: 0 },
        purge: { generation, cutoff: new Date(now).toISOString(), requiredClientIds },
        finalizing: { complete: false, removedControlCount: 0 },
        updatedAt: new Date(now).toISOString(),
        contentHash: 'sha256:' as Hash,
      };
      const journal = updateJournalHash(journalBase);
      const lease = makeLease(ownerClientId, 1, now);
      const recoveryDelta = estimateBytes(plan) + estimateBytes(journal) + estimateBytes(lease);
      if (recoveryDelta > RECOVERY_RESERVE) {
        metaStore.put({ ...meta, recoveryMode: 'CLEAR_ONLY' });
        await done;
        throw new M1bError('ERR_RECOVERY_RESERVE_EXHAUSTED');
      }
      tx.objectStore('system').add(plan);
      tx.objectStore('system').add(lease);
      tx.objectStore('journal').add(journal);
      metaStore.put({ ...meta, cursor: incrementCursor(meta.cursor), recoveryMode: 'RECOVERY_ONLY', recoveryBytes: meta.recoveryBytes + recoveryDelta });
      await done;
      return { journal, lease };
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async enumerateDeletionPage(deletionId: string, ownerClientId: string, fencingToken: string, limit = 500, now = Date.now()): Promise<ActiveDeletionJournalRecord> {
    assertPageLimit(limit);
    return this.withRootMutation(async () => {
    const db = await this.database();
    const descriptorTx = db.transaction(['journal', 'system'], 'readonly');
    const descriptorDone = transactionDone(descriptorTx);
    try {
      await assertLease(descriptorTx, ownerClientId, fencingToken, now);
      const descriptor = await requestValue<ActiveDeletionJournalRecord | undefined>(descriptorTx.objectStore('journal').get(deletionId));
      if (!descriptor || descriptor.state !== 'FENCED') throw new M1bError('ERR_DELETION_STATE');
      assertDeletionJournal(descriptor);
      const root = ROOT_STORES[descriptor.enumeration.registryIndex];
      await descriptorDone;
      const stores = [...new Set<PhysicalStoreName>(['meta', 'journal', 'system', ...(root ? [root] : [])])];
      const tx = this.mutationTransaction(db, stores, 'readwrite');
      const done = transactionDone(tx);
      try {
        await assertLease(tx, ownerClientId, fencingToken, now);
        const journalStore = tx.objectStore('journal');
        const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(journalStore.get(deletionId));
        if (!journal || journal.state !== 'FENCED') throw new M1bError('ERR_DELETION_STATE');
        assertDeletionJournal(journal);
        const currentRoot = ROOT_STORES[journal.enumeration.registryIndex];
        if (currentRoot !== root) throw new M1bError('ERR_CURSOR_CONFLICT');
      if (!root) {
        const completed = updateJournalHash({ ...journal, state: 'DELETING', enumeration: { ...journal.enumeration, complete: true }, updatedAt: new Date(now).toISOString() });
        journalStore.put(completed);
        await done;
        return completed;
      }
      assertPageLimit(limit);
      const page = await cursorPage(tx.objectStore(root), journal.enumeration.continuationKey, journal.enumeration.pageOffset, limit);
      let nextOrdinal = BigInt(journal.progress.nextOrdinal);
      let added = 0;
      let recoveryDelta = 0;
      for (const { key, value } of page.entries) {
        if (isOwnDeletionControl(root, key, value, journal) || root === 'meta') continue;
        if (!matchesDeletionTarget(value, journal)) continue;
        const work: DeletionWorkItemRecord = {
          id: `work:${deletionId}:${root}:${String(key)}`,
          deletionId,
          ordinal: nextOrdinal.toString(),
          storeName: root,
          recordId: String(key),
          expectedContentHash: recordHash(value),
          estimatedBytes: estimateBytes(value),
        };
        journalStore.put(work);
        recoveryDelta += estimateBytes(work);
        nextOrdinal += 1n;
        added += 1;
      }
      const rootDone = page.complete;
      const nextRootIndex = rootDone ? journal.enumeration.registryIndex + 1 : journal.enumeration.registryIndex;
      const enumerationComplete = nextRootIndex >= ROOT_STORES.length;
      const next = updateJournalHash({
        ...journal,
        state: enumerationComplete ? 'DELETING' : 'FENCED',
        enumeration: {
          registryIndex: nextRootIndex,
          pageOffset: 0,
          ...(rootDone ? {} : { continuationKey: page.lastKey }),
          complete: enumerationComplete,
          enumeratedCount: journal.enumeration.enumeratedCount + page.count,
        },
        progress: { ...journal.progress, nextOrdinal: nextOrdinal.toString(), totalCount: journal.progress.totalCount + added },
        updatedAt: new Date(now).toISOString(),
      });
      journalStore.put(next);
      await bumpRecoveryCursor(tx, 0, recoveryDelta);
      await done;
      return next;
      } catch (error) {
        safeAbort(tx);
        await done.catch(() => undefined);
        throw normalizeIdbError(error);
      }
    } catch (error) {
      safeAbort(descriptorTx);
      await descriptorDone.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async deleteChunk(deletionId: string, ownerClientId: string, fencingToken: string, limit = 500, now = Date.now()): Promise<ActiveDeletionJournalRecord> {
    assertPageLimit(limit);
    return this.withRootMutation(async () => {
      const db = await this.database();
      const tx = this.mutationTransaction(db, [...ROOT_STORES], 'readwrite');
      const done = transactionDone(tx);
      try {
        await assertLease(tx, ownerClientId, fencingToken, now);
        const journalStore = tx.objectStore('journal');
        const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(journalStore.get(deletionId));
        if (!journal || journal.state !== 'DELETING') throw new M1bError('ERR_DELETION_STATE');
        assertDeletionJournal(journal);
        // Selection and deletion share one readwrite transaction. IDB serializes
        // same-database transactions, so a concurrent same-token chunk cannot
        // count an advisory page that another chunk has already consumed.
        const selectedPage = await deletionWorkPage(journalStore, deletionId, limit);
        let reclaimed = 0;
        const currentValues = await Promise.all(selectedPage.items.map((item) => requestValue<unknown>(tx.objectStore(item.storeName).get(item.recordId))));
        selectedPage.items.forEach((item, index) => {
          const current = currentValues[index];
          if (current !== undefined) {
            const currentHash = recordHash(current);
            if (item.expectedContentHash && currentHash && currentHash !== item.expectedContentHash) throw new M1bError('ERR_HASH_MISMATCH');
            tx.objectStore(item.storeName).delete(item.recordId);
            reclaimed += estimateBytes(current);
          }
          journalStore.delete(item.id);
        });
        const next = updateJournalHash({
          ...journal,
          state: selectedPage.complete ? 'PURGE_PENDING' : 'DELETING',
          progress: { ...journal.progress, completedCount: journal.progress.completedCount + selectedPage.items.length },
          updatedAt: new Date(now).toISOString(),
        });
        journalStore.put(next);
        await bumpRecoveryCursor(tx, reclaimed);
        await done;
        return next;
      } catch (error) {
        safeAbort(tx);
        await done.catch(() => undefined);
        throw normalizeIdbError(error);
      }
    });
  }

  async acknowledgePurge(deletionId: string, generation: string, clientId: string, now = Date.now()): Promise<PurgeAckRecord> {
    return this.withRootMutation(async () => {
    const db = await this.database();
    const tx = this.mutationTransaction(db, ['journal', 'system'], 'readwrite');
    const done = transactionDone(tx);
    try {
      const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(tx.objectStore('journal').get(deletionId));
      if (!journal || journal.purge.generation !== generation) throw new M1bError('ERR_PURGE_GENERATION_STALE');
       assertDeletionJournal(journal);
      if (journal.state !== 'PURGE_PENDING' || journal.purge.sealedAt) throw new M1bError('ERR_PURGE_SEALED');
       if (!journal.purge.requiredClientIds.includes(clientId)) throw new M1bError('ERR_PURGE_CLIENT_UNKNOWN');
      const base = { recordId: `purge-ack:${deletionId}:${generation}:${clientId}`, recordType: 'purge_ack' as const, writtenAt: new Date(now).toISOString(), deletionId, generation, clientId };
      const ack: PurgeAckRecord = { ...base, contentHash: hashCanonical(base) };
      tx.objectStore('system').put(ack);
      await done;
      return ack;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async retryPurge(deletionId: string, ownerClientId: string, fencingToken: string, liveClientIds: readonly string[], now = Date.now()): Promise<ActiveDeletionJournalRecord> {
    return this.withRootMutation(async () => {
    const db = await this.database();
    const tx = this.mutationTransaction(db, ['meta', 'journal', 'system'], 'readwrite');
    const done = transactionDone(tx);
    try {
      await assertLease(tx, ownerClientId, fencingToken, now);
      const journalStore = tx.objectStore('journal');
      const system = tx.objectStore('system');
      const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(journalStore.get(deletionId));
      if (!journal || journal.state !== 'PURGE_PENDING') throw new M1bError('ERR_DELETION_STATE');
      assertDeletionJournal(journal);
       const oldGeneration = journal.purge.generation;
      const records = await requestValue<Array<PurgeAckRecord | ClientRegistrationRecord>>(system.getAll());
      for (const record of records) {
        if (record.recordType === 'purge_ack' && record.deletionId === deletionId && record.generation === oldGeneration) system.delete(record.recordId);
      }
      const generation = crypto.randomUUID();
      const explicitlyLive = new Set(liveClientIds);
       const requiredClientIds = records.filter((record) => record.recordType === 'client_registration' && record.state !== 'CLOSING' && (Date.parse(record.leaseExpiresAt) > now || explicitlyLive.has(record.clientId) || (record.state === 'QUARANTINED' && record.purgeGeneration === oldGeneration))).map((record) => record.clientId).sort();
      for (const record of records) {
        if (record.recordType === 'client_registration' && requiredClientIds.includes(record.clientId)) {
          const nextBase = { ...record, state: 'QUARANTINED' as const, purgeGeneration: generation, writtenAt: new Date(now).toISOString() };
          system.put({ ...nextBase, contentHash: hashCanonical(withoutHash(nextBase)) });
        }
      }
      const next = updateJournalHash({ ...journal, purge: { generation, cutoff: new Date(now).toISOString(), requiredClientIds }, updatedAt: new Date(now).toISOString() });
      journalStore.put(next);
      await bumpRecoveryCursor(tx);
      await done;
      return next;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async sealAndAudit(deletionId: string, ownerClientId: string, fencingToken: string, now = Date.now()): Promise<ReachabilityResult> {
    return this.withRootMutation(async () => {
      const db = await this.database();
      const tx = this.mutationTransaction(db, ['meta', 'journal', 'system'], 'readwrite');
      const done = transactionDone(tx);
      let sealed: ActiveDeletionJournalRecord;
      let lease: RecoveryLeaseRecord;
      try {
        lease = await assertLease(tx, ownerClientId, fencingToken, now);
        const journalStore = tx.objectStore('journal');
        const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(journalStore.get(deletionId));
        if (!journal || (journal.state !== 'PURGE_PENDING' && journal.state !== 'AUDITING')) throw new M1bError('ERR_DELETION_STATE');
        assertDeletionJournal(journal);
        const acks = (await requestValue<Array<PurgeAckRecord | StoredRecord>>(tx.objectStore('system').getAll())).filter((record): record is PurgeAckRecord => {
          if (!isPurgeAck(record) || record.deletionId !== deletionId || record.generation !== journal.purge.generation) return false;
          assertCanonicalHash(record, 'ERR_PURGE_ACK_HASH_INVALID');
          return true;
        });
        const ackIds = new Set(acks.map((ack) => ack.clientId));
        const allPurged = journal.purge.requiredClientIds.every((id) => ackIds.has(id));
        if (!allPurged) {
          await done;
          return {
            deletionId,
            generation: journal.purge.generation,
            receipts: [],
            reachableCount: 0,
            allRequiredClientsPurged: false,
            registryComplete: true,
            outcome: 'CLIENTS_PENDING',
            registryRevision: this.rootCoordinator.revision,
            journalHash: journal.contentHash,
            leaseGeneration: lease.generation,
            leaseFencingTokenHash: sha256(lease.fencingToken),
            coverage: 'single-browser-in-process',
          };
        }
        sealed = updateJournalHash({ ...journal, state: 'AUDITING', purge: { ...journal.purge, sealedAt: new Date(now).toISOString() }, updatedAt: new Date(now).toISOString() });
        journalStore.put(sealed);
        await bumpRecoveryCursor(tx);
        await done;
      } catch (error) {
        safeAbort(tx);
        await done.catch(() => undefined);
        throw normalizeIdbError(error);
      }

      const result = await this.auditRoots(sealed, lease);
      if (result.outcome === 'CLEAN') {
        await this.updateJournalState(deletionId, ownerClientId, fencingToken, 'AUDITING', 'FINALIZING', now);
      }
      return result;
    });
  }

  async finalizeDeletionPage(deletionId: string, ownerClientId: string, fencingToken: string, limit = 500, now = Date.now()): Promise<ActiveDeletionJournalRecord> {
    assertPageLimit(limit);
    return this.withRootMutation(async () => {
    const db = await this.database();
    const tx = this.mutationTransaction(db, ['meta', 'journal', 'system'], 'readwrite');
    const done = transactionDone(tx);
    try {
      await assertLease(tx, ownerClientId, fencingToken, now);
      const journalStore = tx.objectStore('journal');
      const system = tx.objectStore('system');
      const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(journalStore.get(deletionId));
      if (!journal || journal.state !== 'FINALIZING') throw new M1bError('ERR_DELETION_STATE');
       assertDeletionJournal(journal);
      const records = await requestValue<Array<StoredRecord | PurgeAckRecord>>(system.getAll());
      const removable = records.filter((record) =>
        record.recordId === journal.planId,
      ).slice(0, limit);
      let reclaimed = 0;
      removable.forEach((record) => {
        system.delete(record.recordId);
        reclaimed += estimateBytes(record);
      });
      const remaining = records.filter((record) =>
        record.recordId === journal.planId,
      ).length - removable.length;
      const next = updateJournalHash({ ...journal, finalizing: { complete: remaining === 0, removedControlCount: journal.finalizing.removedControlCount + removable.length }, updatedAt: new Date(now).toISOString() });
      journalStore.put(next);
      await bumpRecoveryCursor(tx, reclaimed);
      await done;
      return next;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async verifyDeletion(deletionId: string, ownerClientId: string, fencingToken: string, now = Date.now(), simulateResponseLoss = false): Promise<{ verifiedId: string; tombstoneId: string }> {
    const receipt = await this.readCommittedVerificationReceipt(deletionId);
    if (receipt) return { verifiedId: receipt.verifiedId, tombstoneId: receipt.tombstoneId };
    const before = await this.getRecord<ActiveDeletionJournalRecord>('journal', deletionId);
    if (!before || before.state !== 'FINALIZING' || !before.finalizing.complete) throw new M1bError('ERR_DELETION_STATE');
    const releaseQuiescence = await this.acquireRootQuiescence(deletionId, before.purge.generation);
    try {
      return await this.verifyDeletionUnderQuiescence(deletionId, ownerClientId, fencingToken, now, simulateResponseLoss);
    } finally {
      releaseQuiescence();
    }
  }

  private async readCommittedVerificationReceipt(deletionId: string): Promise<DeletionVerificationReceiptRecord | undefined> {
    const db = await this.database();
    const tx = db.transaction(['meta', 'journal', 'system', 'audit'], 'readonly');
    const done = transactionDone(tx);
    try {
      const receipt = await this.verificationReceiptInTransaction(tx, deletionId);
      await done;
      return receipt;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
  }

  private async verificationReceiptInTransaction(tx: IDBTransaction, deletionId: string): Promise<DeletionVerificationReceiptRecord | undefined> {
    const receipt = await requestValue<DeletionVerificationReceiptRecord | undefined>(tx.objectStore('system').get(`verification:${sha256(deletionId)}`));
    if (!receipt) return undefined;
    assertVerificationReceipt(receipt, deletionId);
    const meta = await requestValue<StoreMetaRecord>(tx.objectStore('meta').get('canonical'));
    const terminal = await requestValue<DeletionTerminalRecord | undefined>(tx.objectStore('journal').get(receipt.verifiedId));
    const tombstone = await requestValue<StoredRecord<{ id: string; deletedType: string; deletedAt: string }> | undefined>(tx.objectStore('system').get(`tombstone:${receipt.tombstoneId}`));
    const auditRecord = await requestValue<StoredRecord<ReachabilityResult> | undefined>(tx.objectStore('audit').get(`audit:${sha256(receipt.deletionId)}`));
    if (!meta) throw new M1bError('ERR_VERIFY_RECEIPT_INVALID');
    assertMetaWatermarks(meta);
    if (auditRecord) assertCanonicalHash(auditRecord, 'ERR_VERIFY_RECEIPT_INVALID');
    if (terminal) assertCanonicalHash(terminal, 'ERR_VERIFY_RECEIPT_INVALID');
    if (tombstone) assertCanonicalHash(tombstone, 'ERR_VERIFY_RECEIPT_INVALID');
    const watermarks = [...(meta.purgeWatermarks ?? []), ...(meta.purgeWatermark && !(meta.purgeWatermarks ?? []).some((item) => item.contentHash === meta.purgeWatermark?.contentHash) ? [meta.purgeWatermark] : [])];
    watermarks.forEach((watermark) => assertCanonicalHash(watermark, 'ERR_VERIFY_RECEIPT_INVALID'));
    const watermark = watermarks.find((item) => item.deletionId === deletionId && item.generation === receipt.generation && item.journalHash === receipt.journalHash && item.leaseGeneration === receipt.leaseGeneration);
    const permanent = new Set(meta.purgedAnchorDigests ?? []);
    const receiptAnchorProof = Array.isArray(receipt.anchorDigests) && receipt.anchorDigests.every((digest) => permanent.has(digest));
    const companionStateValid = terminal?.id === receipt.verifiedId
      && terminal.recordType === 'deletion_terminal'
      && terminal.state === 'VERIFIED'
      && tombstone?.recordId === `tombstone:${receipt.tombstoneId}`
      && tombstone.recordType === 'tombstone'
      && tombstone.payload?.id === receipt.tombstoneId
      && tombstone.payload?.deletedType === terminal.deletedType
      && terminal.contentHash === receipt.terminalHash
      && tombstone.contentHash === receipt.tombstoneHash;
    if (meta.recoveryMode !== 'NORMAL' || !companionStateValid || !auditRecord || auditRecord.recordType !== 'deletion_audit' || hashCanonical(auditRecord.payload) !== receipt.auditHash || (!watermark && !receiptAnchorProof)) throw new M1bError('ERR_VERIFY_RECEIPT_INVALID');
    return receipt;
  }

  private async verifyDeletionUnderQuiescence(deletionId: string, ownerClientId: string, fencingToken: string, now: number, simulateResponseLoss: boolean): Promise<{ verifiedId: string; tombstoneId: string }> {
    const db = await this.database();
    const tx = db.transaction([...ROOT_STORES], 'readwrite');
    const done = transactionDone(tx);
    try {
      const systemStore = tx.objectStore('system');
      const committed = await this.verificationReceiptInTransaction(tx, deletionId);
      if (committed) {
        await done;
        return { verifiedId: committed.verifiedId, tombstoneId: committed.tombstoneId };
      }
      const journalStore = tx.objectStore('journal');
      const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(journalStore.get(deletionId));
      if (!journal || journal.state !== 'FINALIZING' || !journal.finalizing.complete) throw new M1bError('ERR_DELETION_STATE');
      assertDeletionJournal(journal);
      const currentLease = await assertLease(tx, ownerClientId, fencingToken, () => this.clock());
      assertCanonicalHash(currentLease, 'ERR_RECOVERY_LEASE_HASH_INVALID');
      this.assertQuiescenceStable();
       const audit = await this.auditRoots(journal, currentLease, tx);
       this.assertQuiescenceStable();
      if (audit.outcome === 'CLIENTS_PENDING') throw new M1bError('ERR_PURGE_CLIENTS_PENDING');
      if (audit.outcome !== 'CLEAN') throw new M1bError('ERR_DELETE_REACHABLE');
      if (audit.registryRevision !== this.rootCoordinator.revision) throw new M1bError('ERR_DELETE_REGISTRY_INCOMPLETE');
      if (journal.contentHash !== audit.journalHash || journal.purge.generation !== audit.generation || currentLease.generation !== audit.leaseGeneration || sha256(currentLease.fencingToken) !== audit.leaseFencingTokenHash) throw new M1bError('ERR_DELETION_RECEIPT_STALE');
      if (this.clock() >= Date.parse(currentLease.expiresAt)) throw new M1bError('ERR_RECOVERY_LEASE_LOST');
      const verifiedId = crypto.randomUUID();
      const tombstoneId = crypto.randomUUID();
       tx.objectStore('audit').put(toStoredRecord(`audit:${sha256(journal.id)}`, 'deletion_audit', audit));
      const clientRecords = await requestValue<Array<ClientRegistrationRecord | PurgeAckRecord>>(tx.objectStore('system').getAll());
       const acknowledgedClients = new Set<string>();
       for (const client of clientRecords) {
         if (isPurgeAck(client) && client.deletionId === journal.id && client.generation === journal.purge.generation) {
           assertCanonicalHash(client, 'ERR_PURGE_ACK_HASH_INVALID');
           acknowledgedClients.add(client.clientId);
           systemStore.delete(client.recordId);
         }
       }
       for (const client of clientRecords) {
         if (client.recordType !== 'client_registration' || client.purgeGeneration !== journal.purge.generation) continue;
         const acknowledged = acknowledgedClients.has(client.clientId);
         const next = {
           ...client,
           state: acknowledged ? 'ACTIVE' as const : 'QUARANTINED' as const,
           purgeGeneration: acknowledged ? undefined : journal.purge.generation,
           purgeAckGeneration: acknowledged ? journal.purge.generation : client.purgeAckGeneration,
           writtenAt: new Date(now).toISOString(),
         };
         tx.objectStore('system').put({ ...next, contentHash: hashCanonical(withoutHash(next)) });
       }
       journalStore.delete(deletionId);
      const terminalBase = { id: verifiedId, recordType: 'deletion_terminal' as const, state: 'VERIFIED' as const, deletedType: journal.targetType, workItemCount: journal.progress.totalCount, createdAt: new Date(now).toISOString(), verifiedAt: new Date(now).toISOString() };
      const terminal: DeletionTerminalRecord = { ...terminalBase, contentHash: hashCanonical(terminalBase) };
      journalStore.add(terminal);
      tx.objectStore('system').delete('recovery-lease');
      const tombstone = toStoredRecord(`tombstone:${tombstoneId}`, 'tombstone', { id: tombstoneId, deletedType: journal.targetType, deletedAt: new Date(now).toISOString() });
      tx.objectStore('system').add(tombstone);
      const metaStore = tx.objectStore('meta');
      const meta = await requestValue<StoreMetaRecord>(metaStore.get('canonical'));
      if (!meta || meta.recoveryMode !== 'RECOVERY_ONLY') throw new M1bError('ERR_DELETION_RECEIPT_STALE');
       assertMetaWatermarks(meta);
      const nextCursor = incrementCursor(meta.cursor);
      const watermarkBase = {
         anchorDigests: [...journal.targetAnchors].sort(),
        deletionId: journal.id,
        generation: journal.purge.generation,
        cursor: nextCursor,
        journalHash: audit.journalHash,
        leaseGeneration: currentLease.generation,
        verifiedAt: new Date(now).toISOString(),
      };
      const purgeWatermark = { ...watermarkBase, contentHash: hashCanonical(watermarkBase) };
      const priorWatermarks = [...(meta.purgeWatermarks ?? []), ...(meta.purgeWatermark && !(meta.purgeWatermarks ?? []).some((item) => item.contentHash === meta.purgeWatermark?.contentHash) ? [meta.purgeWatermark] : [])];
       const purgeWatermarks = [...priorWatermarks, purgeWatermark].slice(-32);
       const purgedAnchorDigests = [...new Set([...(meta.purgedAnchorDigests ?? []), ...watermarkBase.anchorDigests])].sort();
      metaStore.put({ ...meta, cursor: nextCursor, recoveryMode: 'NORMAL', recoveryBytes: 0, purgeWatermark, purgeWatermarks, lastPurgeCursor: nextCursor, purgedAnchorDigests, purgedAnchorIndexHash: hashCanonical(purgedAnchorDigests) });
      const receiptBase = {
        recordId: `verification:${sha256(journal.id)}`,
        recordType: 'deletion_verification_receipt' as const,
        writtenAt: new Date(now).toISOString(),
        deletionId: journal.id,
        generation: journal.purge.generation,
        verifiedId,
        tombstoneId,
        committedAt: new Date(now).toISOString(),
        registryRevision: audit.registryRevision,
        auditHash: hashCanonical(audit),
        journalHash: audit.journalHash,
        leaseGeneration: currentLease.generation,
        leaseFencingTokenHash: sha256(currentLease.fencingToken),
         terminalHash: terminal.contentHash,
         tombstoneHash: tombstone.contentHash,
        anchorDigests: watermarkBase.anchorDigests,
      };
      const receipt: DeletionVerificationReceiptRecord = { ...receiptBase, contentHash: hashCanonical(receiptBase) };
      systemStore.add(receipt);
      await done;
      if (simulateResponseLoss) throw new CommitResponseLostError(nextCursor);
      return { verifiedId, tombstoneId };
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
  }

  async renewRecoveryLease(ownerClientId: string, fencingToken: string, now = Date.now()): Promise<RecoveryLeaseRecord> {
    return this.withRootMutation(async () => {
    const db = await this.database();
    const tx = this.mutationTransaction(db, 'system', 'readwrite');
    const done = transactionDone(tx);
    try {
      const lease = await assertLease(tx, ownerClientId, fencingToken, now);
      const base = { ...lease, renewedAt: new Date(now).toISOString(), expiresAt: new Date(now + LEASE_MS).toISOString(), writtenAt: new Date(now).toISOString() };
      const next: RecoveryLeaseRecord = { ...base, contentHash: hashCanonical(withoutHash(base)) };
      tx.objectStore('system').put(next);
      await done;
      return next;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async stealRecoveryLease(ownerClientId: string, now = Date.now()): Promise<RecoveryLeaseRecord> {
    return this.withRootMutation(async () => {
    const db = await this.database();
    const tx = this.mutationTransaction(db, 'system', 'readwrite');
    const done = transactionDone(tx);
    try {
      const store = tx.objectStore('system');
      const lease = await requestValue<RecoveryLeaseRecord | undefined>(store.get('recovery-lease'));
      if (lease) assertCanonicalHash(lease, 'ERR_RECOVERY_LEASE_HASH_INVALID');
       if (!lease || !Number.isFinite(now) || Date.parse(lease.expiresAt) > now) throw new M1bError('ERR_RECOVERY_LEASE_HELD');
      const next = makeLease(ownerClientId, lease.generation + 1, now);
      store.put(next);
      await done;
      return next;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    });
  }

  async clearAll(options: { simulateBlocked?: boolean; cachesCleared?: boolean; deleteTimeoutMs?: number; quiescenceTimeoutMs?: number } = {}): Promise<ClearAllResult> {
    const releaseQuiescence = await this.acquireRootQuiescence(`clear:${crypto.randomUUID()}`, `clear:${Date.now()}`, options.quiescenceTimeoutMs);
    let retainQuiescence = false;
    try {
      const db = await this.database();
      const tx = db.transaction('meta', 'readwrite');
      const done = transactionDone(tx);
      const meta = await requestValue<StoreMetaRecord | undefined>(tx.objectStore('meta').get('canonical'));
      assertMeta(meta, meta?.cursor ?? '0', meta?.privacyEpoch ?? -1, false);
      tx.objectStore('meta').put({ ...meta, recoveryMode: 'CLEAR_ONLY' });
      await done;
      for (const adapter of this.rootCoordinator.adapters) adapter.previewBuffers.clear();
      const cachesCleared = options.cachesCleared === true;
      if (!cachesCleared) {
        return { state: 'BLOCKED', databaseDeleted: false, cachesCleared: false, emptyReopenVerified: false, errorCode: 'ERR_STORAGE_BLOCKED', coverage: 'single-browser-in-process' };
      }
      if (options.simulateBlocked) {
        return { state: 'BLOCKED', databaseDeleted: false, cachesCleared, emptyReopenVerified: false, errorCode: 'ERR_STORAGE_BLOCKED', coverage: 'single-browser-in-process' };
      }
      // Quiescence drains admitted mutations, so close every in-process handle
      // before asking IndexedDB to delete the database. A sibling adapter may
      // otherwise keep the delete request blocked indefinitely.
      for (const adapter of this.rootCoordinator.adapters) {
        await adapter.opening?.catch(() => undefined);
        adapter.close();
      }
      const deletionPromise = deleteDatabaseResult(this.databaseName, options.deleteTimeoutMs);
      const settlement = deletionPromise.then(({ settled }) => settled).then((value) => value, () => false);
      this.rootCoordinator.databaseDeletionPending = settlement;
      const deletion = await deletionPromise;
      if (deletion.pending) {
        retainQuiescence = true;
        this.pendingDatabaseDeletion = settlement;
        void settlement.then(() => {
          if (this.pendingDatabaseDeletion === settlement) this.pendingDatabaseDeletion = undefined;
          if (this.rootCoordinator.databaseDeletionPending === settlement) this.rootCoordinator.databaseDeletionPending = undefined;
          try { releaseQuiescence(); } catch { /* barrier state is already cleared; no old handle is reopened */ }
        });
        return { state: 'BLOCKED', databaseDeleted: false, cachesCleared, emptyReopenVerified: false, pendingDeletion: true, errorCode: 'ERR_STORAGE_BLOCKED', coverage: 'single-browser-in-process' };
      }
      this.rootCoordinator.databaseDeletionPending = undefined;
      if (!deletion.deleted) {
        return { state: 'BLOCKED', databaseDeleted: false, cachesCleared, emptyReopenVerified: false, errorCode: 'ERR_STORAGE_BLOCKED', coverage: 'single-browser-in-process' };
      }
      await this.open();
      const reopened = await this.getMeta();
      const empty = (await this.getAll('business')).length === 0 && reopened.cursor === '0';
      return { state: empty ? 'SUCCEEDED' : 'BLOCKED', databaseDeleted: true, cachesCleared, emptyReopenVerified: empty, ...(empty ? {} : { errorCode: 'ERR_STORAGE_BLOCKED' as const }), coverage: 'single-browser-in-process' };
    } finally {
      if (!retainQuiescence) releaseQuiescence();
    }
  }

  private sweepExpiredPreviewBuffers(now: number): void {
    for (const [tokenHash, buffer] of this.previewBuffers) {
      if (Date.parse(buffer.expiresAt) <= now) this.previewBuffers.delete(tokenHash);
    }
  }

  private async commitInternal(batch: AtomicMutationBatch, options: CommitOptions): Promise<CommitResult> {
    batch = snapshotBatch(batch);
     if (Boolean(batch.requiresPreview) !== Boolean(options.preview)) throw new M1bError(options.preview ? 'ERR_PREVIEW_BATCH_MISMATCH' : 'ERR_PREVIEW_REQUIRED');
    const releaseMutation = this.beginInProcessRootMutation();
    try {
      const db = await this.database();
    const stores = [...new Set<PhysicalStoreName>(['meta', 'ledger', 'changes', ...batch.storeNames, ...(options.preview ? ['system' as const] : [])])];
    const tx = this.mutationTransaction(db, stores, 'readwrite');
    const done = transactionDone(tx);
    try {
      if (options.preview) {
        const systemStore = tx.objectStore('system');
        const existingPreviewRecords = await requestValue<Array<Partial<PreviewCommitGuardRecord> & { recordId?: string; receiptId?: string; writtenAt?: string }>>(systemStore.getAll());
        sweepConsumedPreviewRecords(systemStore, existingPreviewRecords, this.clock());
      }
      const metaStore = tx.objectStore('meta');
      const ledgerStore = tx.objectStore('ledger');
      const prior = await requestValue<CommitLedgerRecord | undefined>(ledgerStore.get(batch.idempotencyKey));
      if (prior) {
        if (prior.batchHash !== batch.batchHash) throw new M1bError('ERR_IDEMPOTENCY_CONFLICT');
        if (options.preview) {
          const tokenHash = sha256(options.preview.token);
          const guard = await requestValue<PreviewCommitGuardRecord | undefined>(tx.objectStore('system').get(`preview-guard:${tokenHash}`));
          if (!guard) throw new M1bError('ERR_PREVIEW_INVALID');
          assertCanonicalHash(guard, 'ERR_PREVIEW_INVALID');
          if (guard.state !== 'CONSUMED' || guard.callerId !== options.preview.callerId || guard.idempotencyKey !== batch.idempotencyKey || guard.batchHash !== batch.batchHash || !guard.receiptId) throw new M1bError('ERR_PREVIEW_RETRY_INVALID');
          const receipt = await requestValue<PreviewCommitReceipt | undefined>(tx.objectStore('system').get(`preview-receipt:${guard.receiptId}`));
          if (!receipt) throw new M1bError('ERR_PREVIEW_RETRY_INVALID');
          assertPreviewReceipt(receipt, guard, batch, prior);
        }
        await done;
        this.releasePreviewAfterCommit(options.preview);
        return { cursor: prior.committedCursor, applied: false, ledger: prior };
      }
      const meta = await requestValue<StoreMetaRecord>(metaStore.get('canonical'));
      assertMeta(meta, batch.expectedCursor, batch.expectedPrivacyEpoch, batch.requiresActiveObservation === true);
      let guard: PreviewCommitGuardRecord | undefined;
      if (options.preview) {
        const tokenHash = sha256(options.preview.token);
        guard = await requestValue<PreviewCommitGuardRecord | undefined>(tx.objectStore('system').get(`preview-guard:${tokenHash}`));
         if (guard) assertCanonicalHash(guard, 'ERR_PREVIEW_INVALID');
        const buffer = this.previewBuffers.get(tokenHash);
        if (!guard) throw new M1bError('ERR_PREVIEW_INVALID');
        if (guard.idempotencyKey !== batch.idempotencyKey || guard.callerId !== options.preview.callerId || guard.privacyEpoch !== meta.privacyEpoch) throw new M1bError('ERR_PREVIEW_STALE');
         if (guard.batchHash !== batch.batchHash) throw new M1bError('ERR_PREVIEW_BATCH_MISMATCH');
        if (guard.state !== 'READY') throw new M1bError('ERR_PREVIEW_CONSUMED');
        if (Date.parse(guard.expiresAt) <= this.clock()) throw new M1bError('ERR_PREVIEW_EXPIRED');
        if (!buffer) throw new M1bError('ERR_PREVIEW_BUFFER_MISSING');
        if (buffer.bufferHandleHash !== guard.bufferHandleHash || hashBytes(buffer.bytes) !== guard.bufferHandleHash) throw new M1bError('ERR_PREVIEW_STALE');
      }
      const nextCursor = incrementCursor(meta.cursor);
      const affectedRefs: { recordType: string; recordId: string }[] = [];
      let byteDelta = 0;
      let changeIndex = 0;
      for (const mutation of batch.mutations) {
        assertMutationControlBoundary(mutation);
        assertNoPurgedReference(mutation, meta);
        if (mutation.kind === 'casProjectionHead'
          && (BigInt(mutation.next.sourceCursor) < BigInt(mutation.expectedSourceCursor)
            || BigInt(mutation.next.sourceCursor) > BigInt(meta.cursor))) {
          throw new M1bError('ERR_PROJECTION_STALE');
        }
        const outcome = await applyMutation(tx, mutation);
        byteDelta += outcome.byteDelta;
        if (outcome.affected) {
          affectedRefs.push(outcome.affected);
          tx.objectStore('changes').add({ id: `${nextCursor}:${changeIndex}`, cursor: nextCursor, ...outcome.change });
          changeIndex += 1;
        }
      }
      if (meta.logicalBytes + byteDelta < 0 || meta.logicalBytes + byteDelta > NORMAL_WRITE_LIMIT) throw new M1bError('ERR_QUOTA_LOGICAL');
      const ledger: CommitLedgerRecord = { idempotencyKey: batch.idempotencyKey, batchHash: batch.batchHash, committedCursor: nextCursor, affectedRefs, committedAt: new Date().toISOString() };
      ledgerStore.add(ledger);
      if (guard && options.preview) {
        const receiptId = crypto.randomUUID();
        const consumedBase = { ...guard, state: 'CONSUMED' as const, receiptId, writtenAt: new Date().toISOString() };
        tx.objectStore('system').put({ ...consumedBase, contentHash: hashCanonical(withoutHash(consumedBase)) });
        const receiptBase = { recordId: `preview-receipt:${receiptId}`, recordType: 'observation_commit_receipt' as const, writtenAt: new Date().toISOString(), guardId: guard.recordId, idempotencyKey: batch.idempotencyKey, cursor: nextCursor, batchHash: batch.batchHash };
        const receipt: PreviewCommitReceipt = { ...receiptBase, contentHash: hashCanonical(receiptBase) };
        tx.objectStore('system').add(receipt);
      }
      metaStore.put({ ...meta, cursor: nextCursor, logicalBytes: meta.logicalBytes + byteDelta });
      await done;
      this.releasePreviewAfterCommit(options.preview);
      if (options.simulateResponseLoss) throw new CommitResponseLostError(nextCursor);
      return { cursor: nextCursor, applied: true, ledger };
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
    } finally {
      releaseMutation();
    }
  }

  private releasePreviewAfterCommit(preview: CommitOptions['preview']): void {
    if (preview) this.previewBuffers.delete(sha256(preview.token));
  }

  private async auditRoots(journal: ActiveDeletionJournalRecord, lease: RecoveryLeaseRecord, existingTx?: IDBTransaction): Promise<ReachabilityResult> {
    assertDeletionJournal(journal);
    assertCanonicalHash(lease, 'ERR_RECOVERY_LEASE_HASH_INVALID');
    const db = existingTx ? undefined : await this.database();
    const tx = existingTx ?? db!.transaction([...ROOT_STORES], 'readonly');
    const receipts: { rootId: string; scannedItemCount: number; forbiddenReferenceCount: number }[] = [];
    const registryBefore = [...this.rootCoordinator.roots.keys()].sort();
    const registryBeforeRevision = this.rootCoordinator.revision;
    const purgeAckClientIds = new Set<string>();
    let reachableCount = 0;
    for (const root of ROOT_STORES) {
      let forbiddenReferenceCount = 0;
      const scannedItemCount = await scanStore(tx.objectStore(root), (key, value) => {
        if (root === 'system' && value && typeof value === 'object' && isPurgeAck(value as StoredRecord | PurgeAckRecord) && (value as PurgeAckRecord).deletionId === journal.id && (value as PurgeAckRecord).generation === journal.purge.generation) {
          const ack = value as PurgeAckRecord;
          assertCanonicalHash(ack, 'ERR_PURGE_ACK_HASH_INVALID');
          purgeAckClientIds.add(ack.clientId);
        }
        if (isOwnDeletionControl(root, key, value, journal)) return;
        if (matchesDeletionTarget(value, journal)) forbiddenReferenceCount += 1;
      });
      receipts.push({ rootId: `idb.${root}`, scannedItemCount, forbiddenReferenceCount });
      reachableCount += forbiddenReferenceCount;
    }
    if (!existingTx) await transactionDone(tx);
    for (const root of [...this.rootCoordinator.roots.values()].sort((a, b) => a.rootId.localeCompare(b.rootId))) {
      const values = root.read();
      if (!Array.isArray(values)) throw new M1bError('ERR_ROOT_READER_ASYNC');
      const forbiddenReferenceCount = values.filter((value) => matchesDeletionTarget(value, journal)).length;
      receipts.push({ rootId: root.rootId, scannedItemCount: values.length, forbiddenReferenceCount });
      reachableCount += forbiddenReferenceCount;
    }
    for (const adapter of [...this.rootCoordinator.adapters].sort((left, right) => left.adapterId.localeCompare(right.adapterId))) {
      for (const [tokenHash, buffer] of adapter.previewBuffers) {
        const source = new TextDecoder().decode(buffer.bytes);
        const forbiddenReferenceCount = containsDeletionAnchorDigest(source, journal) ? 1 : 0;
        receipts.push({ rootId: `adapter.${adapter.adapterId}.preview.${tokenHash}`, scannedItemCount: 1, forbiddenReferenceCount });
        reachableCount += forbiddenReferenceCount;
      }
    }
    const registryAfter = [...this.rootCoordinator.roots.keys()].sort();
    const registryComplete = registryBeforeRevision === this.rootCoordinator.revision && registryBefore.length === registryAfter.length && registryBefore.every((rootId, index) => rootId === registryAfter[index]);
    return {
      deletionId: journal.id,
      generation: journal.purge.generation,
      journalHash: journal.contentHash,
       leaseGeneration: lease.generation,
       leaseFencingTokenHash: sha256(lease.fencingToken),
       receipts,
      reachableCount,
      allRequiredClientsPurged: journal.purge.requiredClientIds.every((clientId) => purgeAckClientIds.has(clientId)),
      registryComplete,
       registryRevision: registryBeforeRevision,
      outcome: !journal.purge.requiredClientIds.every((clientId) => purgeAckClientIds.has(clientId)) ? 'CLIENTS_PENDING' : !registryComplete ? 'REGISTRY_INCOMPLETE' : reachableCount === 0 ? 'CLEAN' : 'REACHABLE',
      coverage: 'single-browser-in-process',
    };
  }

  private async updateJournalState(deletionId: string, ownerClientId: string, fencingToken: string, expected: ActiveDeletionJournalRecord['state'], nextState: ActiveDeletionJournalRecord['state'], now: number): Promise<void> {
    const db = await this.database();
    const tx = this.mutationTransaction(db, ['meta', 'journal', 'system'], 'readwrite');
    const done = transactionDone(tx);
    try {
      await assertLease(tx, ownerClientId, fencingToken, now);
      const store = tx.objectStore('journal');
      const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(store.get(deletionId));
      if (!journal || journal.state !== expected) throw new M1bError('ERR_DELETION_STATE');
       assertDeletionJournal(journal);
      store.put(updateJournalHash({ ...journal, state: nextState, updatedAt: new Date(now).toISOString() }));
      await bumpRecoveryCursor(tx);
      await done;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
  }

  private async withRootMutation<T>(operation: () => Promise<T>): Promise<T> {
    const releaseMutation = this.beginInProcessRootMutation();
    try {
      return await operation();
    } finally {
      releaseMutation();
    }
  }

  private mutationTransaction(db: IDBDatabase, stores: PhysicalStoreName | readonly PhysicalStoreName[], mode: 'readwrite'): IDBTransaction {
    const releaseMutation = this.beginInProcessRootMutation();
    try {
      const tx = db.transaction(stores, mode);
      const done = transactionDone(tx);
      void done.then(releaseMutation, releaseMutation);
      return tx;
    } catch (error) {
      releaseMutation();
      throw error;
    }
  }

  private async database(): Promise<IDBDatabase> {
    if (this.disposed) throw new M1bError('ERR_STORAGE_UNAVAILABLE');
    await this.open();
    if (!this.db) throw new M1bError('ERR_STORAGE_UNAVAILABLE');
    return this.db;
  }
}

function immutablePayloadHash(record: StoredRecord): Hash {
  return hashCanonical({ recordType: record.recordType, payload: record.payload });
}

function snapshotBatch(batch: AtomicMutationBatch): AtomicMutationBatch {
  try {
    const snapshot = structuredClone(batch) as AtomicMutationBatch;
    validateBatch(snapshot);
    return snapshot;
  } catch (error) {
    if (error instanceof M1bError) throw error;
    throw new M1bError('ERR_BATCH_INVALID');
  }
}

function assertProjectionHead(head: ProjectionHeadRecord, code: string): void {
  if (!head || typeof head.projectionId !== 'string' || typeof head.sourceCursor !== 'string' || !/^\d+$/.test(head.sourceCursor)
    || !Number.isSafeInteger(head.revision) || head.revision < 0 || !/^sha256:[0-9a-f]{64}$/.test(head.projectionHash)) throw new M1bError(code);
}

function validateBatch(batch: AtomicMutationBatch): void {
  if (batch.mutations.length > 500) throw new M1bError('ERR_BATCH_LIMIT');
  const actualStores = [...new Set(batch.mutations.map((mutation) => mutation.storeName))].sort();
  const declaredStores = [...batch.storeNames];
  if (declaredStores.join('|') !== [...new Set(declaredStores)].sort().join('|') || actualStores.join('|') !== declaredStores.join('|')) throw new M1bError('ERR_STORE_SET_MISMATCH');
  for (const mutation of batch.mutations) {
    if (mutation.kind === 'insertImmutable' || mutation.kind === 'casSingleton') assertCanonicalHash(mutation.record, 'ERR_RECORD_HASH_INVALID');
    if (mutation.kind === 'deleteIfHash' && !/^sha256:[0-9a-f]{64}$/.test(mutation.expectedContentHash)) throw new M1bError('ERR_RECORD_HASH_INVALID');
    if (mutation.kind === 'casProjectionHead') assertProjectionHead(mutation.next, 'ERR_PROJECTION_HASH_INVALID');
  }
  const expectedHash = hashCanonical({ expectedCursor: batch.expectedCursor, expectedPrivacyEpoch: batch.expectedPrivacyEpoch, requiresActiveObservation: batch.requiresActiveObservation === true, requiresPreview: batch.requiresPreview === true, storeNames: batch.storeNames, mutations: batch.mutations });
  if (batch.batchHash !== expectedHash) throw new M1bError('ERR_BATCH_HASH_MISMATCH');
  if (estimateBytes(batch.mutations) > 4 * 1024 * 1024) throw new M1bError('ERR_BATCH_LIMIT');
}

function assertMutationControlBoundary(mutation: CanonicalMutation): void {
  if (mutation.storeName !== 'system') return;
  const recordType = mutation.kind === 'deleteIfHash' ? '' : mutation.record.recordType;
  const recordId = mutation.kind === 'deleteIfHash' ? mutation.recordId : mutation.record.recordId;
  const reservedTypes = new Set(['client_registration', 'recovery_lease', 'purge_ack', 'preview_commit_guard', 'observation_commit_receipt', 'deletion_verification_receipt', 'tombstone', 'import_session', 'import_staging']);
  const reservedPrefixes = ['client:', 'recovery-lease', 'purge-ack:', 'preview-guard:', 'preview-receipt:', 'verification:', 'tombstone:', 'import-session:', 'import-stage:'];
  if (reservedTypes.has(recordType) || reservedPrefixes.some((prefix) => recordId.startsWith(prefix))) throw new M1bError('ERR_RESERVED_CONTROL_KEY');
}

function assertNoPurgedReference(mutation: CanonicalMutation, meta: StoreMetaRecord): void {
  const values: string[] = [];
  const collect = (value: unknown, depth = 0): void => {
    if (depth > 256) throw new M1bError('ERR_MUTATION_DEPTH');
    if (value === null || value === undefined) return;
    if (typeof value === 'string') { values.push(value); return; }
    if (Array.isArray(value)) { value.forEach((item) => collect(item, depth + 1)); return; }
    if (typeof value === 'object') Object.values(value).forEach((item) => collect(item, depth + 1));
  };
  if (mutation.kind === 'deleteIfHash') collect({ recordId: mutation.recordId, expectedContentHash: mutation.expectedContentHash });
  else if (mutation.kind === 'casProjectionHead') collect(mutation.next);
  else collect(mutation.record);
  assertNoPurgedValues(values, meta);
}

function assertNoPurgedPreviewReference(bytes: Uint8Array, meta: StoreMetaRecord): void {
  const text = new TextDecoder().decode(bytes);
  const values: string[] = [text];
  try {
    const parsed: unknown = JSON.parse(text);
    const collect = (value: unknown, depth = 0): void => {
      if (depth > 256) throw new M1bError('ERR_MUTATION_DEPTH');
      if (value === null || value === undefined) return;
      if (typeof value === 'string') { values.push(value); return; }
      if (Array.isArray(value)) { value.forEach((item) => collect(item, depth + 1)); return; }
      if (typeof value === 'object') Object.values(value).forEach((item) => collect(item, depth + 1));
    };
    collect(parsed);
  } catch (error) {
    if (error instanceof M1bError) throw error;
  }
  assertNoPurgedValues(values, meta);
}

function assertNoPurgedValues(values: readonly string[], meta: StoreMetaRecord): void {
  const watermarks = [...(meta.purgeWatermarks ?? []), ...(meta.purgeWatermark ? [meta.purgeWatermark] : [])];
  const permanentDigests = new Set(meta.purgedAnchorDigests ?? []);
  const legacyGenerations = new Set(watermarks.map((watermark) => watermark.generation));
  for (const watermark of watermarks) {
    for (const digest of watermark.anchorDigests ?? []) permanentDigests.add(digest);
  }
  if (values.some((value) => permanentDigests.has(sha256(value)) || [...legacyGenerations].some((generation) => permanentDigests.has(sha256(`${generation}:${value}`))))) {
    throw new M1bError('ERR_PURGED_REFERENCE');
  }
}

async function applyMutation(tx: IDBTransaction, mutation: CanonicalMutation): Promise<{ byteDelta: number; affected?: { recordType: string; recordId: string }; change: { recordType: string; recordId: string; change: 'put' | 'delete'; contentHash?: Hash } }> {
  const store = tx.objectStore(mutation.storeName);
  if (mutation.kind === 'insertImmutable') {
    const payload = mutation.record.payload;
    if (mutation.storeName === 'business' && payload && typeof payload === 'object' && 'dedupeKey' in payload && typeof payload.dedupeKey === 'string') {
      const existing = await requestValue<StoredRecord | undefined>(store.index('byDedupeKey').get(payload.dedupeKey));
      if (existing) {
        const sameFact = immutablePayloadHash(existing) === immutablePayloadHash(mutation.record);
        if (sameFact) return { byteDelta: 0, change: { recordType: existing.recordType, recordId: existing.recordId, change: 'put', contentHash: existing.contentHash } };
        throw new M1bError('ERR_DUPLICATE_CONFLICT');
      }
    }
    store.add(mutation.record);
    return { byteDelta: estimateBytes(mutation.record), affected: { recordType: mutation.record.recordType, recordId: mutation.record.recordId }, change: { recordType: mutation.record.recordType, recordId: mutation.record.recordId, change: 'put', contentHash: mutation.record.contentHash } };
  }
  if (mutation.kind === 'casSingleton') {
    const current = await requestValue<StoredRecord | undefined>(store.get(mutation.record.recordId));
    if (current) assertCanonicalHash(current, 'ERR_RECORD_HASH_INVALID');
    const currentHash = current?.contentHash ?? null;
    if (currentHash !== mutation.expectedContentHash) throw new M1bError('ERR_REVISION_CONFLICT');
    store.put(mutation.record);
    return { byteDelta: estimateBytes(mutation.record) - estimateBytes(current), affected: { recordType: mutation.record.recordType, recordId: mutation.record.recordId }, change: { recordType: mutation.record.recordType, recordId: mutation.record.recordId, change: 'put', contentHash: mutation.record.contentHash } };
  }
  if (mutation.kind === 'deleteIfHash') {
    const current = await requestValue<StoredRecord | ProjectionHeadRecord | undefined>(store.get(mutation.recordId));
    if (current && 'contentHash' in current) assertCanonicalHash(current, 'ERR_RECORD_HASH_INVALID');
    if (!current) return { byteDelta: 0, change: { recordType: 'unknown', recordId: mutation.recordId, change: 'delete' } };
    const currentHash = recordHash(current);
    if (currentHash !== mutation.expectedContentHash) throw new M1bError('ERR_HASH_MISMATCH');
    store.delete(mutation.recordId);
    const recordType = 'recordType' in current ? current.recordType : 'projection_head';
    return { byteDelta: -estimateBytes(current), affected: { recordType, recordId: mutation.recordId }, change: { recordType, recordId: mutation.recordId, change: 'delete' } };
  }
  const current = await requestValue<ProjectionHeadRecord | undefined>(store.get(mutation.next.projectionId));
  if (current) assertProjectionHead(current, 'ERR_PROJECTION_HASH_INVALID');
  if ((current?.sourceCursor ?? '0') !== mutation.expectedSourceCursor) throw new M1bError('ERR_PROJECTION_STALE');
  store.put(mutation.next);
  return { byteDelta: estimateBytes(mutation.next) - estimateBytes(current), affected: { recordType: 'projection_head', recordId: mutation.next.projectionId }, change: { recordType: 'projection_head', recordId: mutation.next.projectionId, change: 'put', contentHash: mutation.next.projectionHash } };
}

async function assertLease(tx: IDBTransaction, ownerClientId: string, fencingToken: string, now: number | (() => number)): Promise<RecoveryLeaseRecord> {
  const lease = await requestValue<RecoveryLeaseRecord | undefined>(tx.objectStore('system').get('recovery-lease'));
  const currentNow = typeof now === 'function' ? now() : now;
  if (!Number.isFinite(currentNow)) throw new M1bError('ERR_CLOCK_UNAVAILABLE');
  if (!lease || lease.ownerClientId !== ownerClientId || lease.fencingToken !== fencingToken || Date.parse(lease.expiresAt) <= currentNow) throw new M1bError('ERR_RECOVERY_LEASE_LOST');
  assertCanonicalHash(lease, 'ERR_RECOVERY_LEASE_HASH_INVALID');
  if (lease.recordId !== 'recovery-lease' || lease.recordType !== 'recovery_lease' || !Number.isSafeInteger(lease.generation)) throw new M1bError('ERR_RECOVERY_LEASE_HASH_INVALID');
  return lease;
}

async function bumpRecoveryCursor(tx: IDBTransaction, reclaimedBytes = 0, recoveryDelta = 0): Promise<void> {
  const store = tx.objectStore('meta');
  const meta = await requestValue<StoreMetaRecord>(store.get('canonical'));
  if (!meta) throw new M1bError('ERR_STORAGE_CORRUPT');
  assertMetaWatermarks(meta);
  const recoveryBytes = meta.recoveryBytes + recoveryDelta;
  if (recoveryBytes < 0 || recoveryBytes > RECOVERY_RESERVE) throw new M1bError('ERR_RECOVERY_RESERVE_EXHAUSTED');
  store.put({ ...meta, cursor: incrementCursor(meta.cursor), logicalBytes: Math.max(0, meta.logicalBytes - reclaimedBytes), recoveryBytes });
}

function makeLease(ownerClientId: string, generation: number, now: number): RecoveryLeaseRecord {
  if (!Number.isFinite(now)) throw new M1bError('ERR_CLOCK_UNAVAILABLE');
  const base = {
    recordId: 'recovery-lease' as const,
    recordType: 'recovery_lease' as const,
    writtenAt: new Date(now).toISOString(),
    ownerClientId,
    generation,
    fencingToken: crypto.randomUUID(),
    acquiredAt: new Date(now).toISOString(),
    renewedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LEASE_MS).toISOString(),
  };
  return { ...base, contentHash: hashCanonical(base) };
}

function updateJournalHash(journal: ActiveDeletionJournalRecord): ActiveDeletionJournalRecord {
  return { ...journal, contentHash: hashCanonical(withoutHash(journal)) };
}

function assertCanonicalHash<T extends { contentHash: Hash }>(record: T, code: string): void {
  if (hashCanonical(withoutHash(record)) !== record.contentHash) throw new M1bError(code);
}

function assertPreviewReceipt(receipt: PreviewCommitReceipt, guard: PreviewCommitGuardRecord, batch: AtomicMutationBatch, ledger: CommitLedgerRecord): void {
  assertCanonicalHash(receipt, 'ERR_PREVIEW_RETRY_INVALID');
  if (receipt.recordType !== 'observation_commit_receipt' || receipt.guardId !== guard.recordId || receipt.idempotencyKey !== batch.idempotencyKey || receipt.batchHash !== batch.batchHash || receipt.cursor !== ledger.committedCursor) throw new M1bError('ERR_PREVIEW_RETRY_INVALID');
}

function assertVerificationReceipt(receipt: DeletionVerificationReceiptRecord, deletionId: string): void {
  assertCanonicalHash(receipt, 'ERR_VERIFY_RECEIPT_INVALID');
  const hashFields = [receipt.auditHash, receipt.journalHash, receipt.leaseFencingTokenHash, receipt.terminalHash, receipt.tombstoneHash];
  if (receipt.recordId !== `verification:${sha256(deletionId)}` || receipt.recordType !== 'deletion_verification_receipt' || receipt.deletionId !== deletionId || !receipt.generation || !receipt.verifiedId || !receipt.tombstoneId || !Number.isSafeInteger(receipt.registryRevision) || !Number.isSafeInteger(receipt.leaseGeneration) || hashFields.some((value) => !/^sha256:[0-9a-f]{64}$/.test(value)) || (receipt.anchorDigests !== undefined && receipt.anchorDigests.some((value: unknown) => !/^sha256:[0-9a-f]{64}$/.test(String(value))))) throw new M1bError('ERR_VERIFY_RECEIPT_INVALID');
}

function assertDeletionJournal(journal: ActiveDeletionJournalRecord): void {
  const candidate = journal as unknown as Record<string, unknown>;
  const asRecord = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const nonnegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const hashValue = (value: unknown): value is string => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
  const timestampValue = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const enumeration = asRecord(candidate.enumeration);
  const progress = asRecord(candidate.progress);
  const purge = asRecord(candidate.purge);
  const finalizing = asRecord(candidate.finalizing);
  const registryIndex = enumeration?.registryIndex;
  const pageOffset = enumeration?.pageOffset;
  const continuationKey = enumeration?.continuationKey;
  const enumeratedCount = enumeration?.enumeratedCount;
  const nextOrdinal = progress?.nextOrdinal;
  const completedCount = progress?.completedCount;
  const totalCount = progress?.totalCount;
  const requiredClientIds = purge?.requiredClientIds;
  const removedControlCount = finalizing?.removedControlCount;
  if (typeof candidate.id !== 'string' || candidate.recordType !== 'active_deletion_journal' || !['FENCED', 'DELETING', 'PURGE_PENDING', 'AUDITING', 'FINALIZING', 'FAILED'].includes(String(candidate.state))
    || typeof candidate.planId !== 'string' || !hashValue(candidate.planHash) || typeof candidate.targetId !== 'string' || !hashValue(candidate.targetHash) || typeof candidate.targetType !== 'string'
    || !Array.isArray(candidate.targetAnchors) || candidate.targetAnchors.some((anchor: unknown) => !hashValue(anchor)) || typeof candidate.baseCursor !== 'string' || !/^\d+$/.test(candidate.baseCursor)
    || !nonnegativeInteger(candidate.basePrivacyEpoch) || !enumeration || !nonnegativeInteger(registryIndex) || registryIndex > ROOT_STORES.length
    || !nonnegativeInteger(pageOffset) || (continuationKey !== undefined && typeof continuationKey !== 'string')
    || typeof enumeration.complete !== 'boolean' || !nonnegativeInteger(enumeratedCount)
    || !progress || typeof nextOrdinal !== 'string' || !/^\d+$/.test(nextOrdinal) || !nonnegativeInteger(completedCount) || !nonnegativeInteger(totalCount) || completedCount > totalCount
    || !purge || typeof purge.generation !== 'string' || !timestampValue(purge.cutoff) || (purge.sealedAt !== undefined && !timestampValue(purge.sealedAt))
    || !Array.isArray(requiredClientIds) || requiredClientIds.some((clientId: unknown) => typeof clientId !== 'string')
    || !finalizing || typeof finalizing.complete !== 'boolean' || !nonnegativeInteger(removedControlCount)
    || !timestampValue(candidate.updatedAt) || !hashValue(candidate.contentHash)) throw new M1bError('ERR_JOURNAL_HASH_INVALID');
  const orderedClientIds = requiredClientIds as readonly string[];
  if ([...new Set(orderedClientIds)].length !== orderedClientIds.length || orderedClientIds.some((clientId, index) => index > 0 && orderedClientIds[index - 1]! > clientId)) throw new M1bError('ERR_JOURNAL_HASH_INVALID');
  try { assertCanonicalHash(journal, 'ERR_JOURNAL_HASH_INVALID'); } catch (error) { if (error instanceof M1bError) throw error; throw new M1bError('ERR_JOURNAL_HASH_INVALID'); }
}

function assertJournalCollection(records: readonly ActiveDeletionJournalRecord[]): void {
  records.filter((record) => record.recordType === 'active_deletion_journal').forEach((record) => assertDeletionJournal(record));
}

function assertStoredRecordCollection(records: readonly StoredRecord[], code: string): void {
  records.forEach((record) => assertCanonicalHash(record, code));
}

function assertClientRegistration(record: ClientRegistrationRecord): void {
  assertCanonicalHash(record, 'ERR_CLIENT_HASH_INVALID');
  if (record.recordId !== `client:${record.clientId}` || record.recordType !== 'client_registration') throw new M1bError('ERR_CLIENT_HASH_INVALID');
}

function migrateLegacyMeta(tx: IDBTransaction): void {
  const store = tx.objectStore('meta');
  const request = store.get('canonical');
  request.onsuccess = () => {
    try {
      const legacy = request.result as Partial<StoreMetaRecord> | undefined;
      if (!legacy || legacy.key !== 'canonical') throw new M1bError('ERR_STORAGE_CORRUPT');
      const rawWatermarks = legacy.purgeWatermarks;
      if (rawWatermarks !== undefined && !Array.isArray(rawWatermarks)) throw new M1bError('ERR_PURGE_WATERMARK_INVALID');
      const raw = [...(rawWatermarks ?? []), ...(legacy.purgeWatermark ? [legacy.purgeWatermark] : [])];
      const normalized: PurgeWatermark[] = raw.map((value) => migrateLegacyWatermark(value));
      const deduped = normalized.filter((watermark, index) => normalized.findIndex((candidate) => candidate.contentHash === watermark.contentHash) === index);
      const latest = deduped.at(-1);
      const anchorDigests = [...new Set(deduped.flatMap((watermark) => watermark.anchorDigests ?? []))].sort() as Hash[];
      const existingDigests = legacy.purgedAnchorDigests;
      if (existingDigests !== undefined && (!Array.isArray(existingDigests) || existingDigests.some((digest: unknown) => typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)))) throw new M1bError('ERR_PURGE_WATERMARK_INVALID');
      const allDigests = [...new Set([...(existingDigests ?? []), ...anchorDigests])].sort() as Hash[];
      const unrecoverablePurgeHistory = typeof legacy.lastPurgeCursor === 'string' && /^\d+$/.test(legacy.lastPurgeCursor) && BigInt(legacy.lastPurgeCursor) > 0n
        && (raw.length === 0 || raw.some((value) => !hasLegacyWatermarkAnchors(value)));
      const migrated: StoreMetaRecord = {
        ...(legacy as StoreMetaRecord),
        ...(unrecoverablePurgeHistory ? { recoveryMode: 'RECOVERY_ONLY' as const } : {}),
        purgedAnchorDigests: allDigests,
        purgedAnchorIndexHash: hashCanonical(allDigests),
        ...(deduped.length && latest ? { purgeWatermarks: deduped, purgeWatermark: latest, lastPurgeCursor: latest.cursor } : {}),
      };
      store.put(migrated);
      migrateLegacyDeletionControls(tx);
    } catch (error) {
      tx.abort();
      throw error;
    }
  };
}

function migrateLegacyDeletionControls(tx: IDBTransaction): void {
  const systemRequest = tx.objectStore('system').getAll();
  const journalRequest = tx.objectStore('journal').getAll();
  let systemRecords: unknown[] | undefined;
  let journalRecords: unknown[] | undefined;
  const fail = () => { try { tx.abort(); } catch { /* versionchange transaction already aborting */ } };
  const finish = () => {
    if (!systemRecords || !journalRecords) return;
    try {
      const journals = journalRecords.map((value) => {
        if (!value || typeof value !== 'object') return value;
        const candidate = value as Record<string, unknown>;
        if (candidate.recordType !== 'active_deletion_journal') return value;
        assertCanonicalHash(value as { contentHash: Hash }, 'ERR_JOURNAL_HASH_INVALID');
        const anchors = candidate.targetAnchors;
        if (!Array.isArray(anchors) || anchors.some((anchor) => typeof anchor !== 'string')) throw new M1bError('ERR_JOURNAL_HASH_INVALID');
        // v2 targetAnchors were raw lineage identities. Hash every value,
        // including strings that already look like a sha256 digest.
        const digests = anchors.map((anchor) => sha256(anchor));
        const next = { ...candidate, targetAnchors: [...new Set(digests)].sort() };
        const hashable = { ...next } as Record<string, unknown>;
        delete hashable.contentHash;
        const hashed = { ...next, contentHash: hashCanonical(hashable) };
        tx.objectStore('journal').put(hashed);
        return hashed;
      });
      const normalizedSystem = systemRecords.map((value) => {
        if (!value || typeof value !== 'object') return value;
        const candidate = value as Record<string, unknown>;
        if (candidate.recordType === 'deletion_plan') {
          assertCanonicalHash(value as { contentHash: Hash }, 'ERR_DELETION_PLAN_HASH_INVALID');
          const target = candidate.target;
          if (!target || typeof target !== 'object' || Array.isArray(target)) throw new M1bError('ERR_DELETION_PLAN_HASH_INVALID');
          const targetRecord = target as Record<string, unknown>;
          const legacyAnchors = targetRecord.lineageAnchors;
          if (legacyAnchors !== undefined && (!Array.isArray(legacyAnchors) || legacyAnchors.some((anchor) => typeof anchor !== 'string'))) throw new M1bError('ERR_DELETION_PLAN_HASH_INVALID');
          const existing = targetRecord.lineageAnchorDigests;
          if (existing !== undefined && (!Array.isArray(existing) || existing.some((anchor) => typeof anchor !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(anchor)))) throw new M1bError('ERR_DELETION_PLAN_HASH_INVALID');
          const legacyAnchorList = (legacyAnchors ?? []) as string[];
          const existingAnchorList = (existing ?? []) as string[];
          const nextTarget: Record<string, unknown> = { ...targetRecord, lineageAnchorDigests: [...new Set([...existingAnchorList, ...legacyAnchorList.map((anchor) => sha256(anchor))])].sort() };
          delete nextTarget.lineageAnchors;
          const nextBase: Record<string, unknown> = { ...candidate, target: nextTarget };
          const planHash = hashCanonical({
            recordId: nextBase.recordId,
            recordType: nextBase.recordType,
            writtenAt: nextBase.writtenAt,
            target: nextBase.target,
            cause: nextBase.cause,
            baseCursor: nextBase.baseCursor,
            basePrivacyEpoch: nextBase.basePrivacyEpoch,
            baseSnapshotHash: nextBase.baseSnapshotHash,
            closureRulesHash: nextBase.closureRulesHash,
          });
          const next = { ...nextBase, planHash, contentHash: hashCanonical({ ...nextBase, planHash }) };
          tx.objectStore('system').put(next);
          return next;
        }
        if (candidate.state === 'VERIFIED' && typeof candidate.id === 'string' && candidate.recordType === undefined) {
          const base = { ...candidate, recordType: 'deletion_terminal' as const };
          const next = { ...base, contentHash: hashCanonical(base) };
          tx.objectStore('journal').put(next);
          return next;
        }
        return value;
      });
      const terminalById = new Map(journals.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).recordType === 'deletion_terminal')).map((value) => [String(value.id), value]));
      const tombstoneById = new Map(normalizedSystem.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).recordType === 'tombstone' && typeof (value as Record<string, unknown>).recordId === 'string')).map((value) => [String(value.recordId), value]));
      for (const value of normalizedSystem) {
        if (!value || typeof value !== 'object' || (value as Record<string, unknown>).recordType !== 'deletion_verification_receipt') continue;
        const candidate = value as Record<string, unknown>;
        if (candidate.terminalHash !== undefined && candidate.tombstoneHash !== undefined) continue;
        assertCanonicalHash(value as { contentHash: Hash }, 'ERR_VERIFY_RECEIPT_INVALID');
        const terminal = terminalById.get(String(candidate.verifiedId));
        const tombstone = tombstoneById.get(`tombstone:${String(candidate.tombstoneId)}`);
        if (!terminal || !tombstone || typeof terminal.contentHash !== 'string' || typeof tombstone.contentHash !== 'string') throw new M1bError('ERR_VERIFY_RECEIPT_INVALID');
        const nextBase = { ...candidate, terminalHash: terminal.contentHash, tombstoneHash: tombstone.contentHash };
        tx.objectStore('system').put({ ...nextBase, contentHash: hashCanonical(nextBase) });
      }
    } catch {
      fail();
    }
  };
  systemRequest.onsuccess = () => { systemRecords = systemRequest.result as unknown[]; finish(); };
  journalRequest.onsuccess = () => { journalRecords = journalRequest.result as unknown[]; finish(); };
  systemRequest.onerror = fail;
  journalRequest.onerror = fail;
}

function hasLegacyWatermarkAnchors(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const watermark = value as Record<string, unknown>;
  const anchors = watermark.targetAnchors ?? watermark.anchorDigests ?? watermark.lineageAnchors;
  return Array.isArray(anchors) && anchors.every((anchor) => typeof anchor === 'string');
}

function migrateLegacyWatermark(value: unknown): PurgeWatermark {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new M1bError('ERR_PURGE_WATERMARK_INVALID');
  const watermark = value as Record<string, unknown>;
  if (typeof watermark.contentHash !== 'string' || typeof watermark.deletionId !== 'string' || typeof watermark.generation !== 'string'
    || typeof watermark.cursor !== 'string' || !/^\d+$/.test(watermark.cursor) || typeof watermark.journalHash !== 'string'
    || typeof watermark.leaseGeneration !== 'number' || !Number.isSafeInteger(watermark.leaseGeneration) || typeof watermark.verifiedAt !== 'string') {
    throw new M1bError('ERR_PURGE_WATERMARK_INVALID');
  }
  assertCanonicalHash(value as { contentHash: Hash }, 'ERR_PURGE_WATERMARK_INVALID');
  const legacyAnchors = watermark.targetAnchors ?? watermark.anchorDigests ?? watermark.lineageAnchors;
  if (legacyAnchors !== undefined && (!Array.isArray(legacyAnchors) || legacyAnchors.some((anchor: unknown) => typeof anchor !== 'string'))) throw new M1bError('ERR_PURGE_WATERMARK_INVALID');
  // The legacy fields contain raw identities. Never trust a hash-shaped raw
  // identity as an already-hashed anchor: hash every value exactly once.
  const anchorDigests = (legacyAnchors ?? []).map((anchor) => sha256(anchor)).sort() as Hash[];
  const base: Omit<PurgeWatermark, 'contentHash'> = {
    deletionId: watermark.deletionId,
    generation: watermark.generation,
    cursor: watermark.cursor,
    anchorDigests,
    journalHash: watermark.journalHash as Hash,
    leaseGeneration: watermark.leaseGeneration,
    verifiedAt: watermark.verifiedAt,
  };
  return { ...base, contentHash: hashCanonical(base) };
}

function initialMeta(): StoreMetaRecord {
  return {
    key: 'canonical',
    cursor: '0',
    privacyEpoch: 0,
    observationMode: 'ACTIVE',
    recoveryMode: 'NORMAL',
    schemaVersion: '1.0.0',
    logicalBytes: 0,
    recoveryBytes: 0,
    recoveryReserveBytes: 5242880,
    sizeEstimatorVersion: 'storage-size-v1',
    incarnation: crypto.randomUUID(),
    purgedAnchorDigests: [],
    purgedAnchorIndexHash: hashCanonical([]),
  };
}

function assertMetaWatermarks(meta: StoreMetaRecord): void {
  const candidate = meta as unknown as Record<string, unknown>;
  const nonnegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (!candidate || Array.isArray(candidate) || candidate.key !== 'canonical' || typeof candidate.cursor !== 'string' || !/^\d+$/.test(candidate.cursor)
    || !nonnegativeInteger(candidate.privacyEpoch) || !['ACTIVE', 'PRIVATE'].includes(String(candidate.observationMode))
    || !['NORMAL', 'RECOVERY_ONLY', 'CLEAR_ONLY'].includes(String(candidate.recoveryMode))
    || candidate.schemaVersion !== '1.0.0' || !nonnegativeInteger(candidate.logicalBytes) || !nonnegativeInteger(candidate.recoveryBytes)
    || candidate.recoveryBytes > 5242880 || candidate.recoveryReserveBytes !== 5242880 || candidate.sizeEstimatorVersion !== 'storage-size-v1'
    || (candidate.incarnation !== undefined && typeof candidate.incarnation !== 'string')) throw new M1bError('ERR_STORAGE_CORRUPT');
  if (candidate.lastPurgeCursor !== undefined && (typeof candidate.lastPurgeCursor !== 'string' || !/^\d+$/.test(candidate.lastPurgeCursor))) throw new M1bError('ERR_PURGE_WATERMARK_INVALID');
  const purgedAnchorDigests = candidate.purgedAnchorDigests;
  const purgedAnchorIndexHash = candidate.purgedAnchorIndexHash;
  let purgedAnchorIndexMatches = false;
  try { purgedAnchorIndexMatches = Array.isArray(purgedAnchorDigests) && hashCanonical(purgedAnchorDigests) === purgedAnchorIndexHash; } catch { throw new M1bError('ERR_PURGE_WATERMARK_INVALID'); }
  if (!Array.isArray(purgedAnchorDigests) || typeof purgedAnchorIndexHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(purgedAnchorIndexHash)
    || !purgedAnchorIndexMatches
    || purgedAnchorDigests.some((digest) => typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest))
    || [...new Set(purgedAnchorDigests)].length !== purgedAnchorDigests.length
    || purgedAnchorDigests.some((digest, index) => index > 0 && String(purgedAnchorDigests[index - 1]) > String(digest))) throw new M1bError('ERR_PURGE_WATERMARK_INVALID');
  if (candidate.purgeWatermarks !== undefined && !Array.isArray(candidate.purgeWatermarks)) throw new M1bError('ERR_PURGE_WATERMARK_INVALID');
  const permanent = new Set(purgedAnchorDigests as string[]);
  const watermarks = [...(candidate.purgeWatermarks as unknown[] ?? []), ...(candidate.purgeWatermark ? [candidate.purgeWatermark] : [])];
  for (const value of watermarks) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new M1bError('ERR_PURGE_WATERMARK_INVALID');
    const watermark = value as Record<string, unknown>;
    if (typeof watermark.deletionId !== 'string' || typeof watermark.generation !== 'string' || typeof watermark.cursor !== 'string' || !/^\d+$/.test(watermark.cursor)
      || typeof watermark.leaseGeneration !== 'number' || !Number.isSafeInteger(watermark.leaseGeneration) || watermark.leaseGeneration < 0
      || typeof watermark.verifiedAt !== 'string' || !Array.isArray(watermark.anchorDigests) || watermark.anchorDigests.some((digest) => typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest) || !permanent.has(digest))
      || typeof watermark.journalHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(watermark.journalHash) || typeof watermark.contentHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(watermark.contentHash)) throw new M1bError('ERR_PURGE_WATERMARK_INVALID');
    assertCanonicalHash(watermark as { contentHash: Hash }, 'ERR_PURGE_WATERMARK_INVALID');
  }
}

function assertMeta(meta: StoreMetaRecord | undefined, cursor: Cursor, epoch: number, requireActive: boolean): asserts meta is StoreMetaRecord {
  if (!meta) throw new M1bError('ERR_STORAGE_CORRUPT');
  assertMetaWatermarks(meta);
  if (meta.privacyEpoch !== epoch) throw new M1bError('ERR_PRIVACY_EPOCH_STALE');
  if (meta.cursor !== cursor) throw new M1bError('ERR_CURSOR_CONFLICT');
  if (meta.recoveryMode !== 'NORMAL') throw new M1bError('ERR_RECOVERY_REQUIRED');
  if (requireActive && meta.observationMode !== 'ACTIVE') throw new M1bError('ERR_PRIVACY_MODE_ACTIVE');
}

async function snapshotHash(tx: IDBTransaction): Promise<Hash> {
  const roots: Record<string, { readonly count: number; readonly digest: Hash }> = {};
  for (const storeName of ROOT_STORES) {
    let count = 0;
    let digest: Hash = sha256(`proagi-snapshot-root-v2:${storeName}`);
    await scanStore(tx.objectStore(storeName), (key, value) => {
      digest = hashCanonical({ previous: digest, key, value });
      count += 1;
    });
    roots[storeName] = { count, digest };
  }
  return hashCanonical({ schemaVersion: 'snapshot-v2', roots });
}

function scanStore(store: IDBObjectStore, visit: (key: IDBValidKey, value: unknown) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const request = store.openCursor();
    request.onerror = () => reject(request.error ?? new M1bError('ERR_STORAGE'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(count);
        return;
      }
      try {
        visit(cursor.key, cursor.value);
        count += 1;
        cursor.continue();
      } catch (error) {
        reject(error);
      }
    };
  });
}

interface DeletionWorkPage {
  readonly items: readonly DeletionWorkItemRecord[];
  readonly complete: boolean;
}

function deletionWorkPage(store: IDBObjectStore, deletionId: string, limit: number): Promise<DeletionWorkPage> {
  return new Promise((resolve, reject) => {
    const items: DeletionWorkItemRecord[] = [];
    let checkingBoundary = false;
    const request = store.index('byDeletionId').openCursor(IDBKeyRange.only(deletionId));
    request.onerror = () => reject(request.error ?? new M1bError('ERR_STORAGE'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve({ items, complete: true });
        return;
      }
      if (checkingBoundary) {
        resolve({ items, complete: false });
        return;
      }
      const item = cursor.value;
      if (!isDeletionWorkItem(item) || item.deletionId !== deletionId) {
        reject(new M1bError('ERR_STORAGE_CORRUPT'));
        return;
      }
      items.push(item);
      if (items.length >= limit) {
        checkingBoundary = true;
        cursor.continue();
      } else cursor.continue();
    };
  });
}

interface CursorPage {
  readonly entries: readonly { key: IDBValidKey; value: unknown }[];
  readonly count: number;
  readonly complete: boolean;
  readonly lastKey?: string;
}

function assertPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new M1bError('ERR_PAGE_LIMIT_INVALID');
}

function cursorPage(store: IDBObjectStore, continuationKey: string | undefined, legacyOffset: number, limit: number): Promise<CursorPage> {
  return new Promise((resolve, reject) => {
    const page: Array<{ key: IDBValidKey; value: unknown }> = [];
    let skippedLegacyOffset = continuationKey !== undefined || legacyOffset <= 0;
    let lastKey: string | undefined;
    let checkingBoundary = false;
    const request = store.openCursor(continuationKey === undefined ? undefined : IDBKeyRange.lowerBound(continuationKey, true));
    request.onerror = () => reject(request.error ?? new M1bError('ERR_STORAGE'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve({ entries: page, count: page.length, complete: true, ...(lastKey ? { lastKey } : {}) });
        return;
      }
      if (!skippedLegacyOffset) {
        skippedLegacyOffset = true;
        cursor.advance(legacyOffset);
        return;
      }
      if (checkingBoundary) {
        resolve({ entries: page, count: page.length, complete: false, lastKey });
        return;
      }
      if (typeof cursor.key !== 'string') {
        reject(new M1bError('ERR_STORAGE_CORRUPT'));
        return;
      }
      page.push({ key: cursor.key, value: cursor.value });
      lastKey = cursor.key;
      if (page.length >= limit) {
        checkingBoundary = true;
        cursor.continue();
      } else cursor.continue();
    };
  });
}

function isOwnDeletionControl(store: PhysicalStoreName, key: IDBValidKey | undefined, value: unknown, journal: ActiveDeletionJournalRecord): boolean {
  if (store === 'meta') return true;
  if (store === 'journal' && (String(key) === journal.id || String(key).startsWith(`work:${journal.id}:`))) return true;
  if (store === 'system' && (String(key) === journal.planId || String(key) === 'recovery-lease' || String(key).startsWith(`purge-ack:${journal.id}:`))) return true;
  return false;
}

function isDeletionWorkItem(value: unknown): value is DeletionWorkItemRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DeletionWorkItemRecord>;
  return typeof candidate.id === 'string'
    && candidate.id.startsWith('work:')
    && typeof candidate.deletionId === 'string'
    && typeof candidate.ordinal === 'string'
    && /^\d+$/.test(candidate.ordinal)
    && typeof candidate.storeName === 'string'
    && typeof candidate.recordId === 'string'
    && typeof candidate.estimatedBytes === 'number'
    && Number.isSafeInteger(candidate.estimatedBytes)
    && candidate.estimatedBytes >= 0;
}

function isPurgeAck(value: unknown): value is PurgeAckRecord {
  return !!value && typeof value === 'object' && 'recordType' in value && (value as { recordType?: unknown }).recordType === 'purge_ack' && 'deletionId' in value;
}

function recordHash(value: unknown): Hash | undefined {
  if (value && typeof value === 'object') {
    if ('contentHash' in value && typeof (value as { contentHash?: unknown }).contentHash === 'string') return (value as { contentHash: Hash }).contentHash;
    if ('projectionHash' in value && typeof (value as { projectionHash?: unknown }).projectionHash === 'string') return (value as { projectionHash: Hash }).projectionHash;
  }
  return undefined;
}

function matchesDeletionTarget(value: unknown, journal: ActiveDeletionJournalRecord): boolean {
  const anchors = new Set(journal.targetAnchors);
  if (anchors.size === 0) return false;
  const collect = (candidate: unknown, depth = 0): boolean => {
    if (depth > 256) throw new M1bError('ERR_MUTATION_DEPTH');
    if (typeof candidate === 'string') return anchors.has(sha256(candidate));
    if (Array.isArray(candidate)) return candidate.some((item) => collect(item, depth + 1));
    if (candidate && typeof candidate === 'object') return Object.values(candidate as Record<string, unknown>).some((item) => collect(item, depth + 1));
    return false;
  };
  return collect(value);
}

function containsDeletionAnchorDigest(text: string, journal: ActiveDeletionJournalRecord): boolean {
  return matchesDeletionTarget(text, journal);
}

function deepContains(value: unknown, needle: string): boolean {
  if (value === needle) return true;
  if (Array.isArray(value)) return value.some((item) => deepContains(item, needle));
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some((item) => deepContains(item, needle));
  return false;
}

function withoutHash<T extends { contentHash?: unknown }>(value: T): Omit<T, 'contentHash'> {
  const rest = { ...value };
  delete rest.contentHash;
  return rest;
}

function estimateBytes(value: unknown): number {
  if (value === undefined) return 0;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function hashBytes(bytes: Uint8Array): Hash {
  let encoded = '';
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, '0');
  return sha256(encoded);
}

function incrementCursor(cursor: Cursor): Cursor {
  return (BigInt(cursor) + 1n).toString();
}

function openDatabaseRequest(request: IDBOpenDBRequest, timeoutMs: number): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      callback();
    };
    request.onsuccess = () => {
      if (timedOut) {
        request.result.close();
        return;
      }
      finish(() => resolve(request.result));
    };
    request.onerror = () => finish(() => reject(request.error ?? new M1bError('ERR_STORAGE')));
    request.onblocked = () => undefined;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      finish(() => reject(new M1bError('ERR_STORAGE_BLOCKED')));
    }, timeoutMs);
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new M1bError('ERR_STORAGE'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error ?? new M1bError('ERR_STORAGE_ABORT')), { once: true });
  });
}

function safeAbort(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // Already committed/aborted. The original domain error remains authoritative.
  }
}

function normalizeIdbError(error: unknown): Error {
  if (error instanceof M1bError || error instanceof CommitResponseLostError) return error;
  if (error instanceof DOMException && error.name === 'ConstraintError') return new M1bError('ERR_IMMUTABLE_EXISTS');
  return error instanceof Error ? error : new M1bError('ERR_STORAGE');
}

const DELETE_TIMEOUT_MS = 5_000;

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    const timer = setTimeout(() => reject(new M1bError('ERR_STORAGE_BLOCKED')), DELETE_TIMEOUT_MS);
    request.onsuccess = () => { clearTimeout(timer); resolve(); };
    request.onerror = () => { clearTimeout(timer); reject(request.error ?? new M1bError('ERR_STORAGE')); };
    request.onblocked = () => undefined;
  });
}

interface DeleteDatabaseResult {
  readonly deleted: boolean;
  readonly pending: boolean;
  readonly settled: Promise<boolean>;
}

function deleteDatabaseResult(name: string, timeoutMs = DELETE_TIMEOUT_MS): Promise<DeleteDatabaseResult> {
  let settleRequest!: (value: boolean) => void;
  const settled = new Promise<boolean>((resolve) => { settleRequest = resolve; });
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    let timedOut = false;
    let requestSettled = false;
    const settle = (value: boolean) => {
      if (requestSettled) return;
      requestSettled = true;
      clearTimeout(timer);
      settleRequest(value);
      if (!timedOut) resolve({ deleted: value, pending: false, settled });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      resolve({ deleted: false, pending: true, settled });
    }, timeoutMs);
    request.onsuccess = () => settle(true);
    request.onerror = () => settle(false);
    request.onblocked = () => undefined;
  });
}
