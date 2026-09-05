import { hashCanonical, sha256 } from '../domain/canonical';
import type { Hash } from '../domain/types';
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
  type DeletionWorkItemRecord,
  type ImportSessionRecord,
  type M1bRuntimeContract,
  type PreviewCommitGuardRecord,
  type PreviewCommitReceipt,
  type ProjectionHeadRecord,
  type PhysicalStoreName,
  type PurgeAckRecord,
  type ReachabilityResult,
  type RecoveryLeaseRecord,
  type StoreMetaRecord,
  type StoreName,
  type StoredRecord,
} from './m1bTypes';

const DB_VERSION = 2;
const NORMAL_WRITE_LIMIT = 100 * 1024 * 1024;
const RECOVERY_RESERVE = 5 * 1024 * 1024;
const LEASE_MS = 6_000;
const ROOT_STORES: readonly PhysicalStoreName[] = ['meta', ...STORE_NAMES];

interface BufferedPreview {
  bytes: Uint8Array;
  bufferHandleHash: Hash;
  expiresAt: string;
}

interface CommitOptions {
  simulateResponseLoss?: boolean;
  preview?: { token: string; callerId: string; now: string };
}

interface RegisteredRoot {
  readonly rootId: string;
  readonly read: () => readonly unknown[];
}

export class IndexedDbM1bAdapter {
  static readonly runtimeContract: M1bRuntimeContract = {
    indexedDb: true,
    crossTabBrowserVerified: false,
    purgeCoverage: 'single-browser-in-process',
    broadcastChannelRequiredForCorrectness: false,
  };

  private db?: IDBDatabase;
  private opening?: Promise<IDBDatabase>;
  private readonly previewBuffers = new Map<Hash, BufferedPreview>();
  private readonly inProcessRoots = new Map<string, RegisteredRoot>();

  constructor(readonly databaseName = `proagi-m1b-${crypto.randomUUID()}`) {}

  async open(): Promise<void> {
    if (this.db) return;
    if (this.opening) {
      await this.opening;
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
      if (!database.objectStoreNames.contains('journal')) database.createObjectStore('journal', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('audit')) database.createObjectStore('audit', { keyPath: 'recordId' });
      if (!database.objectStoreNames.contains('projection')) database.createObjectStore('projection', { keyPath: 'projectionId' });
      if (!database.objectStoreNames.contains('changes')) {
        const changes = database.createObjectStore('changes', { keyPath: 'id' });
        changes.createIndex('byCursor', 'cursor', { unique: false });
      }
      if ((event as IDBVersionChangeEvent).oldVersion === 0) request.transaction?.objectStore('meta').put(initialMeta());
    };
    this.opening = requestValue(request);
    try {
      const opened = await this.opening;
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
    this.close();
    await deleteDatabase(this.databaseName);
    this.previewBuffers.clear();
    this.inProcessRoots.clear();
  }

  registerInProcessRoot(rootId: string, read: () => readonly unknown[]): () => void {
    if (this.inProcessRoots.has(rootId)) throw new M1bError('ERR_DUPLICATE_ROOT');
    this.inProcessRoots.set(rootId, { rootId, read });
    return () => this.inProcessRoots.delete(rootId);
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

  async commit(batch: AtomicMutationBatch, options: Omit<CommitOptions, 'preview'> = {}): Promise<CommitResult> {
    return this.commitInternal(batch, options);
  }

  async setPrivacyMode(expectedCursor: Cursor, expectedPrivacyEpoch: number, mode: 'ACTIVE' | 'PRIVATE', idempotencyKey: string): Promise<CommitResult> {
    const db = await this.database();
    const tx = db.transaction(['meta', 'ledger', 'system'], 'readwrite');
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
    if (input.bytes.byteLength > 262_144) throw new M1bError('ERR_CHUNK_LIMIT');
    if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) throw new M1bError('ERR_PREVIEW_EXPIRED');
    this.sweepExpiredPreviewBuffers(Date.now());
    const retainedBytes = [...this.previewBuffers.values()].reduce((sum, item) => sum + item.bytes.byteLength, 0);
    if (retainedBytes + input.bytes.byteLength > 4_194_304) throw new M1bError('ERR_QUOTA_LOGICAL');
    const db = await this.database();
    const token = input.token ?? `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const tokenHash = sha256(token);
    const bufferHandleHash = hashBytes(input.bytes);
    const recordId = `preview-guard:${tokenHash}`;
    const writtenAt = new Date().toISOString();
    const guardBase = {
      recordId,
      recordType: 'preview_commit_guard' as const,
      writtenAt,
      tokenHash,
      bufferHandleHash,
      inputHash: input.inputHash,
      privacyEpoch: input.privacyEpoch,
      callerId: input.callerId,
      expiresAt: input.expiresAt,
      state: 'READY' as const,
      idempotencyKey: input.idempotencyKey,
    };
    const guard: PreviewCommitGuardRecord = { ...guardBase, contentHash: hashCanonical(guardBase) };
    const tx = db.transaction(['meta', 'system'], 'readwrite');
    const done = transactionDone(tx);
    try {
      const meta = await requestValue<StoreMetaRecord>(tx.objectStore('meta').get('canonical'));
      assertMeta(meta, meta.cursor, input.privacyEpoch, true);
      const system = tx.objectStore('system');
      const existing = await requestValue<Array<Partial<PreviewCommitGuardRecord>>>(system.getAll());
      for (const record of existing) {
        if (record.recordType === 'preview_commit_guard' && record.state === 'READY' && record.recordId && record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) system.delete(record.recordId);
      }
      system.add(guard);
      await done;
      this.previewBuffers.set(tokenHash, { bytes: input.bytes.slice(), bufferHandleHash, expiresAt: input.expiresAt });
      return { token, guard };
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
  }

  async commitPreview(token: string, callerId: string, batch: AtomicMutationBatch, now = new Date().toISOString(), simulateResponseLoss = false): Promise<CommitResult> {
    return this.commitInternal(batch, { preview: { token, callerId, now }, simulateResponseLoss });
  }

  releasePreviewBuffer(token: string): void {
    this.previewBuffers.delete(sha256(token));
  }

  async cancelPreview(token: string): Promise<void> {
    const tokenHash = sha256(token);
    this.previewBuffers.delete(tokenHash);
    const db = await this.database();
    const tx = db.transaction('system', 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('system').delete(`preview-guard:${tokenHash}`);
    await done;
  }

  async publishProjection(next: ProjectionHeadRecord, expectedSourceCursor: Cursor): Promise<{ applied: boolean; head: ProjectionHeadRecord }> {
    const db = await this.database();
    const tx = db.transaction(['meta', 'projection'], 'readwrite');
    const done = transactionDone(tx);
    try {
      const store = tx.objectStore('projection');
      const meta = await requestValue<StoreMetaRecord>(tx.objectStore('meta').get('canonical'));
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
  }

  async createImportSession(streamId: string, sessionId: string = crypto.randomUUID()): Promise<ImportSessionRecord> {
    const db = await this.database();
    const tx = db.transaction(['meta', 'system'], 'readwrite');
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
  }

  async stageImportBatch(sessionId: string, records: readonly StoredRecord[], batchHash: Hash): Promise<ImportSessionRecord> {
    const db = await this.database();
    const tx = db.transaction(['meta', 'system'], 'readwrite');
    const done = transactionDone(tx);
    try {
      const metaStore = tx.objectStore('meta');
      const system = tx.objectStore('system');
      const meta = await requestValue<StoreMetaRecord>(metaStore.get('canonical'));
      const key = `import-session:${sessionId}`;
      const session = await requestValue<ImportSessionRecord | undefined>(system.get(key));
      if (!session || !['RECEIVING', 'VALIDATED', 'COMMITTING'].includes(session.state)) throw new M1bError('ERR_IMPORT_SESSION_STATE');
      if (session.privacyEpoch !== meta.privacyEpoch || meta.observationMode !== 'ACTIVE' || meta.recoveryMode !== 'NORMAL') throw new M1bError('ERR_PRIVACY_EPOCH_STALE');
      let delta = 0;
      for (const record of records) {
        const staged = toStoredRecord(`import-stage:${sessionId}:${record.recordId}`, 'import_staging', { sessionId, record });
        delta += estimateBytes(staged);
        system.add(staged);
      }
      if (meta.logicalBytes + delta > NORMAL_WRITE_LIMIT) throw new M1bError('ERR_QUOTA_LOGICAL');
      const nextBase = {
        ...session,
        state: 'COMMITTING' as const,
        committedBatchHashes: [...session.committedBatchHashes, batchHash],
        committedEventCount: session.committedEventCount + records.length,
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
  }

  async publishImportSession(sessionId: string, idempotencyKey: string): Promise<CommitResult> {
    const db = await this.database();
    const tx = db.transaction(['meta', 'system', 'business', 'ledger', 'changes'], 'readwrite');
    const done = transactionDone(tx);
    try {
      const metaStore = tx.objectStore('meta');
      const system = tx.objectStore('system');
      const ledgerStore = tx.objectStore('ledger');
      const prior = await requestValue<CommitLedgerRecord | undefined>(ledgerStore.get(idempotencyKey));
      const sessionKey = `import-session:${sessionId}`;
      const session = await requestValue<ImportSessionRecord | undefined>(system.get(sessionKey));
      if (!session) throw new M1bError('ERR_IMPORT_SESSION_STATE');
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
      const nextCursor = incrementCursor(meta.cursor);
      const affectedRefs: { recordType: string; recordId: string }[] = [];
      let reclaimed = 0;
      staged.sort((a, b) => a.recordId.localeCompare(b.recordId));
      for (const stagedRecord of staged) {
        const record = stagedRecord.payload.record;
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
  }

  async cancelImportSession(sessionId: string): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(['meta', 'system'], 'readwrite');
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
  }

  async scanPublishedBusiness(): Promise<StoredRecord[]> {
    return this.getAll<StoredRecord>('business');
  }

  async registerClient(clientId: string, now = Date.now()): Promise<ClientRegistrationRecord> {
    const db = await this.database();
    const tx = db.transaction(['system', 'journal'], 'readwrite');
    const done = transactionDone(tx);
    try {
      const journals = await requestValue<ActiveDeletionJournalRecord[]>(tx.objectStore('journal').getAll());
      const active = journals.find((journal) => journal.recordType === 'active_deletion_journal' && journal.state !== 'FAILED');
      const state: ClientRegistrationRecord['state'] = active ? 'QUARANTINED' : 'ACTIVE';
      const base = {
        recordId: `client:${clientId}`,
        recordType: 'client_registration' as const,
        writtenAt: new Date(now).toISOString(),
        clientId,
        leaseExpiresAt: new Date(now + LEASE_MS).toISOString(),
        state,
        purgeGeneration: active?.purge.generation,
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
  }

  async closeClient(clientId: string, now = Date.now()): Promise<void> {
    const db = await this.database();
    const tx = db.transaction('system', 'readwrite');
    const done = transactionDone(tx);
    try {
      const store = tx.objectStore('system');
      const record = await requestValue<ClientRegistrationRecord | undefined>(store.get(`client:${clientId}`));
      if (record?.recordType === 'client_registration') {
        const next = { ...record, state: 'CLOSING' as const, leaseExpiresAt: new Date(now).toISOString(), writtenAt: new Date(now).toISOString() };
        store.put({ ...next, contentHash: hashCanonical(withoutHash(next)) });
      }
      await done;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
  }

  async renewClient(clientId: string, now = Date.now()): Promise<ClientRegistrationRecord> {
    const db = await this.database();
    const tx = db.transaction('system', 'readwrite');
    const done = transactionDone(tx);
    try {
      const store = tx.objectStore('system');
      const current = await requestValue<ClientRegistrationRecord | undefined>(store.get(`client:${clientId}`));
      if (!current || current.recordType !== 'client_registration') throw new M1bError('ERR_CLIENT_NOT_REGISTERED');
      const next = { ...current, leaseExpiresAt: new Date(now + LEASE_MS).toISOString(), writtenAt: new Date(now).toISOString() };
      const record = { ...next, contentHash: hashCanonical(withoutHash(next)) };
      store.put(record);
      await done;
      return record;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
  }

  async planDeletion(target: { storeName: StoreName; recordId: string; contentHash: Hash; recordType: string; lineageAnchors?: readonly string[] },  cause: DeletionPlanRecord['cause'] = 'user-delete'): Promise<DeletionPlanRecord> {
    const db = await this.database();
    const tx = db.transaction([...ROOT_STORES], 'readonly');
    const meta = await requestValue<StoreMetaRecord>(tx.objectStore('meta').get('canonical'));
    const snapshot = await snapshotHash(tx);
    await transactionDone(tx);
    const base = {
      recordId: `deletion-plan:${crypto.randomUUID()}`,
      recordType: 'deletion_plan' as const,
      writtenAt: new Date().toISOString(),
      target,
      cause,
      baseCursor: meta.cursor,
      basePrivacyEpoch: meta.privacyEpoch,
      baseSnapshotHash: snapshot,
      closureRulesHash: hashCanonical({ roots: ROOT_STORES, version: 'm1b-root-registry-v1' }),
    };
    const planHash = hashCanonical(base);
    return { ...base, planHash, contentHash: hashCanonical({ ...base, planHash }) };
  }

  async fenceDeletion(plan: DeletionPlanRecord, ownerClientId: string, now = Date.now()): Promise<{ journal: ActiveDeletionJournalRecord; lease: RecoveryLeaseRecord }> {
    const db = await this.database();
    const tx = db.transaction([...ROOT_STORES], 'readwrite');
    const done = transactionDone(tx);
    try {
      const metaStore = tx.objectStore('meta');
      const meta = await requestValue<StoreMetaRecord>(metaStore.get('canonical'));
      const currentSnapshotHash = await snapshotHash(tx);
      const recomputedPlanHash = hashCanonical({
        recordId: plan.recordId,
        recordType: plan.recordType,
        writtenAt: plan.writtenAt,
        target: plan.target,
        cause: plan.cause,
        baseCursor: plan.baseCursor,
        basePrivacyEpoch: plan.basePrivacyEpoch,
        baseSnapshotHash: plan.baseSnapshotHash,
        closureRulesHash: plan.closureRulesHash,
      });
      if (meta.cursor !== plan.baseCursor || meta.privacyEpoch !== plan.basePrivacyEpoch || meta.recoveryMode !== 'NORMAL' || currentSnapshotHash !== plan.baseSnapshotHash || recomputedPlanHash !== plan.planHash) throw new M1bError('ERR_CURSOR_CONFLICT');
      const generation = crypto.randomUUID();
      const requiredClientIds = (await requestValue<ClientRegistrationRecord[]>(tx.objectStore('system').getAll()))
        .filter((record) => record.recordType === 'client_registration' && record.state === 'ACTIVE' && Date.parse(record.leaseExpiresAt) > now)
        .map((record) => record.clientId)
        .sort();
      const journalBase: ActiveDeletionJournalRecord = {
        id: `active-deletion:${crypto.randomUUID()}`,
        recordType: 'active_deletion_journal',
        state: 'FENCED',
        planId: plan.recordId,
        planHash: plan.planHash,
        targetId: plan.target.recordId,
        targetHash: plan.target.contentHash,
        targetType: plan.target.recordType,
        targetAnchors: [...new Set([plan.target.recordId, plan.target.contentHash, ...(plan.target.lineageAnchors ?? [])])].sort(),
        baseCursor: plan.baseCursor,
        basePrivacyEpoch: plan.basePrivacyEpoch,
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
  }

  async enumerateDeletionPage(deletionId: string, ownerClientId: string, fencingToken: string, limit = 500, now = Date.now()): Promise<ActiveDeletionJournalRecord> {
    const db = await this.database();
    const tx = db.transaction([...ROOT_STORES], 'readwrite');
    const done = transactionDone(tx);
    try {
      await assertLease(tx, ownerClientId, fencingToken, now);
      const journalStore = tx.objectStore('journal');
      const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(journalStore.get(deletionId));
      if (!journal || journal.state !== 'FENCED') throw new M1bError('ERR_DELETION_STATE');
      const root = ROOT_STORES[journal.enumeration.registryIndex];
      if (!root) {
        const completed = updateJournalHash({ ...journal, state: 'DELETING', enumeration: { ...journal.enumeration, complete: true }, updatedAt: new Date(now).toISOString() });
        journalStore.put(completed);
        await done;
        return completed;
      }
      const { keys, values } = await entries(tx.objectStore(root));
      const start = journal.enumeration.pageOffset;
      const end = Math.min(values.length, start + limit);
      let nextOrdinal = BigInt(journal.progress.nextOrdinal);
      let added = 0;
      let recoveryDelta = 0;
      for (let index = start; index < end; index += 1) {
        const value = values[index];
        const key = keys[index];
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
      const rootDone = end >= values.length;
      const nextRootIndex = rootDone ? journal.enumeration.registryIndex + 1 : journal.enumeration.registryIndex;
      const enumerationComplete = nextRootIndex >= ROOT_STORES.length;
      const next = updateJournalHash({
        ...journal,
        state: enumerationComplete ? 'DELETING' : 'FENCED',
        enumeration: {
          registryIndex: nextRootIndex,
          pageOffset: rootDone ? 0 : end,
          complete: enumerationComplete,
          enumeratedCount: journal.enumeration.enumeratedCount + (end - start),
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
  }

  async deleteChunk(deletionId: string, ownerClientId: string, fencingToken: string, limit = 500, now = Date.now()): Promise<ActiveDeletionJournalRecord> {
    const db = await this.database();
    const tx = db.transaction([...ROOT_STORES], 'readwrite');
    const done = transactionDone(tx);
    try {
      await assertLease(tx, ownerClientId, fencingToken, now);
      const journalStore = tx.objectStore('journal');
      const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(journalStore.get(deletionId));
      if (!journal || journal.state !== 'DELETING') throw new M1bError('ERR_DELETION_STATE');
      const all = await requestValue<DeletionWorkItemRecord[]>(journalStore.getAll());
      const work = all.filter((item) => item.deletionId === deletionId && item.id.startsWith('work:')).sort((a, b) => BigInt(a.ordinal) < BigInt(b.ordinal) ? -1 : 1);
      const selected = work.slice(0, limit);
      let reclaimed = 0;
      for (const item of selected) {
        const store = tx.objectStore(item.storeName);
        const current = await requestValue<unknown>(store.get(item.recordId));
        if (current !== undefined) {
          const currentHash = recordHash(current);
          if (item.expectedContentHash && currentHash && currentHash !== item.expectedContentHash) throw new M1bError('ERR_HASH_MISMATCH');
          store.delete(item.recordId);
          reclaimed += estimateBytes(current);
        }
        journalStore.delete(item.id);
      }
      const remaining = work.length - selected.length;
      const next = updateJournalHash({
        ...journal,
        state: remaining === 0 ? 'PURGE_PENDING' : 'DELETING',
        progress: { ...journal.progress, completedCount: journal.progress.completedCount + selected.length },
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
  }

  async acknowledgePurge(deletionId: string, generation: string, clientId: string, now = Date.now()): Promise<PurgeAckRecord> {
    const db = await this.database();
    const tx = db.transaction(['journal', 'system'], 'readwrite');
    const done = transactionDone(tx);
    try {
      const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(tx.objectStore('journal').get(deletionId));
      if (!journal || journal.purge.generation !== generation) throw new M1bError('ERR_PURGE_GENERATION_STALE');
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
  }

  async retryPurge(deletionId: string, ownerClientId: string, fencingToken: string, liveClientIds: readonly string[], now = Date.now()): Promise<ActiveDeletionJournalRecord> {
    const db = await this.database();
    const tx = db.transaction(['meta', 'journal', 'system'], 'readwrite');
    const done = transactionDone(tx);
    try {
      await assertLease(tx, ownerClientId, fencingToken, now);
      const journalStore = tx.objectStore('journal');
      const system = tx.objectStore('system');
      const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(journalStore.get(deletionId));
      if (!journal || journal.state !== 'PURGE_PENDING') throw new M1bError('ERR_DELETION_STATE');
      const oldGeneration = journal.purge.generation;
      const records = await requestValue<Array<PurgeAckRecord | ClientRegistrationRecord>>(system.getAll());
      for (const record of records) {
        if (record.recordType === 'purge_ack' && record.deletionId === deletionId && record.generation === oldGeneration) system.delete(record.recordId);
      }
      const generation = crypto.randomUUID();
      const requiredClientIds = [...new Set(liveClientIds)].sort();
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
  }

  async sealAndAudit(deletionId: string, ownerClientId: string, fencingToken: string, now = Date.now()): Promise<ReachabilityResult> {
    const db = await this.database();
    const tx = db.transaction(['meta', 'journal', 'system'], 'readwrite');
    const done = transactionDone(tx);
    let sealed: ActiveDeletionJournalRecord;
    try {
      await assertLease(tx, ownerClientId, fencingToken, now);
      const journalStore = tx.objectStore('journal');
      const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(journalStore.get(deletionId));
      if (!journal || (journal.state !== 'PURGE_PENDING' && journal.state !== 'AUDITING')) throw new M1bError('ERR_DELETION_STATE');
      const acks = (await requestValue<PurgeAckRecord[]>(tx.objectStore('system').getAll())).filter((record) => record.recordType === 'purge_ack' && record.deletionId === deletionId && record.generation === journal.purge.generation);
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

    const result = await this.auditRoots(sealed);
    if (result.outcome === 'CLEAN') {
      await this.updateJournalState(deletionId, ownerClientId, fencingToken, 'AUDITING', 'FINALIZING', now);
    }
    return result;
  }

  async finalizeDeletionPage(deletionId: string, ownerClientId: string, fencingToken: string, limit = 500, now = Date.now()): Promise<ActiveDeletionJournalRecord> {
    const db = await this.database();
    const tx = db.transaction(['meta', 'journal', 'system'], 'readwrite');
    const done = transactionDone(tx);
    try {
      await assertLease(tx, ownerClientId, fencingToken, now);
      const journalStore = tx.objectStore('journal');
      const system = tx.objectStore('system');
      const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(journalStore.get(deletionId));
      if (!journal || journal.state !== 'FINALIZING') throw new M1bError('ERR_DELETION_STATE');
      const records = await requestValue<Array<StoredRecord | PurgeAckRecord>>(system.getAll());
      const removable = records.filter((record) =>
        (isPurgeAck(record) && record.deletionId === deletionId) || record.recordId === journal.planId,
      ).slice(0, limit);
      let reclaimed = 0;
      removable.forEach((record) => {
        system.delete(record.recordId);
        reclaimed += estimateBytes(record);
      });
      const remaining = records.filter((record) =>
        (isPurgeAck(record) && record.deletionId === deletionId) || record.recordId === journal.planId,
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
  }

  async verifyDeletion(deletionId: string, ownerClientId: string, fencingToken: string, now = Date.now()): Promise<{ verifiedId: string; tombstoneId: string }> {
    const db = await this.database();
    const before = await this.getRecord<ActiveDeletionJournalRecord>('journal', deletionId);
    if (!before || before.state !== 'FINALIZING' || !before.finalizing.complete) throw new M1bError('ERR_DELETION_STATE');
    const audit = await this.auditRoots(before);
    if (audit.outcome !== 'CLEAN') throw new M1bError('ERR_DELETE_REACHABLE');
    const tx = db.transaction(['meta', 'journal', 'system'], 'readwrite');
    const done = transactionDone(tx);
    try {
      await assertLease(tx, ownerClientId, fencingToken, now);
      const journalStore = tx.objectStore('journal');
      const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(journalStore.get(deletionId));
      if (!journal || journal.state !== 'FINALIZING' || !journal.finalizing.complete) throw new M1bError('ERR_DELETION_STATE');
      const verifiedId = crypto.randomUUID();
      const tombstoneId = crypto.randomUUID();
      journalStore.delete(deletionId);
      journalStore.add({ id: verifiedId, state: 'VERIFIED', deletedType: journal.targetType, workItemCount: journal.progress.totalCount, createdAt: new Date(now).toISOString(), verifiedAt: new Date(now).toISOString() });
      tx.objectStore('system').delete('recovery-lease');
      tx.objectStore('system').add(toStoredRecord(`tombstone:${tombstoneId}`, 'tombstone', { id: tombstoneId, deletedType: journal.targetType, deletedAt: new Date(now).toISOString() }));
      const metaStore = tx.objectStore('meta');
      const meta = await requestValue<StoreMetaRecord>(metaStore.get('canonical'));
      metaStore.put({ ...meta, cursor: incrementCursor(meta.cursor), recoveryMode: 'NORMAL', recoveryBytes: 0 });
      await done;
      return { verifiedId, tombstoneId };
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
  }

  async renewRecoveryLease(ownerClientId: string, fencingToken: string, now = Date.now()): Promise<RecoveryLeaseRecord> {
    const db = await this.database();
    const tx = db.transaction('system', 'readwrite');
    const done = transactionDone(tx);
    try {
      const lease = await requestValue<RecoveryLeaseRecord | undefined>(tx.objectStore('system').get('recovery-lease'));
      if (!lease || lease.ownerClientId !== ownerClientId || lease.fencingToken !== fencingToken || Date.parse(lease.expiresAt) <= now) throw new M1bError('ERR_RECOVERY_LEASE_LOST');
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
  }

  async stealRecoveryLease(ownerClientId: string, now = Date.now()): Promise<RecoveryLeaseRecord> {
    const db = await this.database();
    const tx = db.transaction('system', 'readwrite');
    const done = transactionDone(tx);
    try {
      const store = tx.objectStore('system');
      const lease = await requestValue<RecoveryLeaseRecord | undefined>(store.get('recovery-lease'));
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
  }

  async clearAll(options: { simulateBlocked?: boolean; cachesCleared?: boolean } = {}): Promise<ClearAllResult> {
    const db = await this.database();
    const tx = db.transaction('meta', 'readwrite');
    const done = transactionDone(tx);
    const meta = await requestValue<StoreMetaRecord>(tx.objectStore('meta').get('canonical'));
    tx.objectStore('meta').put({ ...meta, recoveryMode: 'CLEAR_ONLY' });
    await done;
    this.previewBuffers.clear();
    const cachesCleared = options.cachesCleared === true;
    if (!cachesCleared) {
      return { state: 'BLOCKED', databaseDeleted: false, cachesCleared: false, emptyReopenVerified: false, errorCode: 'ERR_STORAGE_BLOCKED', coverage: 'single-browser-in-process' };
    }
    if (options.simulateBlocked) {
      return { state: 'BLOCKED', databaseDeleted: false, cachesCleared, emptyReopenVerified: false, errorCode: 'ERR_STORAGE_BLOCKED', coverage: 'single-browser-in-process' };
    }
    this.close();
    const deleted = await deleteDatabaseResult(this.databaseName);
    if (!deleted) {
      return { state: 'BLOCKED', databaseDeleted: false, cachesCleared, emptyReopenVerified: false, errorCode: 'ERR_STORAGE_BLOCKED', coverage: 'single-browser-in-process' };
    }
    await this.open();
    const reopened = await this.getMeta();
    const empty = (await this.getAll('business')).length === 0 && reopened.cursor === '0';
    return { state: empty ? 'SUCCEEDED' : 'BLOCKED', databaseDeleted: true, cachesCleared, emptyReopenVerified: empty, ...(empty ? {} : { errorCode: 'ERR_STORAGE_BLOCKED' as const }), coverage: 'single-browser-in-process' };
  }

  private sweepExpiredPreviewBuffers(now: number): void {
    for (const [tokenHash, buffer] of this.previewBuffers) {
      if (Date.parse(buffer.expiresAt) <= now) this.previewBuffers.delete(tokenHash);
    }
  }

  private async commitInternal(batch: AtomicMutationBatch, options: CommitOptions): Promise<CommitResult> {
    validateBatch(batch);
    const db = await this.database();
    const stores = [...new Set<PhysicalStoreName>(['meta', 'ledger', 'changes', ...batch.storeNames, ...(options.preview ? ['system' as const] : [])])];
    const tx = db.transaction(stores, 'readwrite');
    const done = transactionDone(tx);
    try {
      const metaStore = tx.objectStore('meta');
      const ledgerStore = tx.objectStore('ledger');
      const prior = await requestValue<CommitLedgerRecord | undefined>(ledgerStore.get(batch.idempotencyKey));
      if (prior) {
        if (prior.batchHash !== batch.batchHash) throw new M1bError('ERR_IDEMPOTENCY_CONFLICT');
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
        const buffer = this.previewBuffers.get(tokenHash);
        if (!guard) throw new M1bError('ERR_PREVIEW_INVALID');
        if (guard.idempotencyKey !== batch.idempotencyKey || guard.callerId !== options.preview.callerId || guard.privacyEpoch !== meta.privacyEpoch) throw new M1bError('ERR_PREVIEW_STALE');
        if (guard.state !== 'READY') throw new M1bError('ERR_PREVIEW_CONSUMED');
        if (Date.parse(guard.expiresAt) <= Date.parse(options.preview.now)) throw new M1bError('ERR_PREVIEW_EXPIRED');
        if (!buffer) throw new M1bError('ERR_PREVIEW_BUFFER_MISSING');
        if (buffer.bufferHandleHash !== guard.bufferHandleHash || hashBytes(buffer.bytes) !== guard.bufferHandleHash) throw new M1bError('ERR_PREVIEW_STALE');
      }
      const nextCursor = incrementCursor(meta.cursor);
      const affectedRefs: { recordType: string; recordId: string }[] = [];
      let byteDelta = 0;
      let changeIndex = 0;
      for (const mutation of batch.mutations) {
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
  }

  private releasePreviewAfterCommit(preview: CommitOptions['preview']): void {
    if (preview) this.previewBuffers.delete(sha256(preview.token));
  }

  private async auditRoots(journal: ActiveDeletionJournalRecord): Promise<ReachabilityResult> {
    const db = await this.database();
    const tx = db.transaction([...ROOT_STORES], 'readonly');
    const receipts: { rootId: string; scannedItemCount: number; forbiddenReferenceCount: number }[] = [];
    let reachableCount = 0;
    for (const root of ROOT_STORES) {
      const { keys, values } = await entries(tx.objectStore(root));
      let forbiddenReferenceCount = 0;
      values.forEach((value, index) => {
        if (isOwnDeletionControl(root, keys[index], value, journal)) return;
        if (matchesDeletionTarget(value, journal)) forbiddenReferenceCount += 1;
      });
      receipts.push({ rootId: `idb.${root}`, scannedItemCount: values.length, forbiddenReferenceCount });
      reachableCount += forbiddenReferenceCount;
    }
    await transactionDone(tx);
    for (const root of [...this.inProcessRoots.values()].sort((a, b) => a.rootId.localeCompare(b.rootId))) {
      const values = root.read();
      const forbiddenReferenceCount = values.filter((value) => matchesDeletionTarget(value, journal)).length;
      receipts.push({ rootId: root.rootId, scannedItemCount: values.length, forbiddenReferenceCount });
      reachableCount += forbiddenReferenceCount;
    }
    return {
      deletionId: journal.id,
      generation: journal.purge.generation,
      receipts,
      reachableCount,
      allRequiredClientsPurged: true,
      registryComplete: receipts.length === ROOT_STORES.length + this.inProcessRoots.size,
      outcome: reachableCount === 0 ? 'CLEAN' : 'REACHABLE',
      coverage: 'single-browser-in-process',
    };
  }

  private async updateJournalState(deletionId: string, ownerClientId: string, fencingToken: string, expected: ActiveDeletionJournalRecord['state'], nextState: ActiveDeletionJournalRecord['state'], now: number): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(['meta', 'journal', 'system'], 'readwrite');
    const done = transactionDone(tx);
    try {
      await assertLease(tx, ownerClientId, fencingToken, now);
      const store = tx.objectStore('journal');
      const journal = await requestValue<ActiveDeletionJournalRecord | undefined>(store.get(deletionId));
      if (!journal || journal.state !== expected) throw new M1bError('ERR_DELETION_STATE');
      store.put(updateJournalHash({ ...journal, state: nextState, updatedAt: new Date(now).toISOString() }));
      await bumpRecoveryCursor(tx);
      await done;
    } catch (error) {
      safeAbort(tx);
      await done.catch(() => undefined);
      throw normalizeIdbError(error);
    }
  }

  private async database(): Promise<IDBDatabase> {
    await this.open();
    if (!this.db) throw new M1bError('ERR_STORAGE_UNAVAILABLE');
    return this.db;
  }
}

export function makeBatch(input: Omit<AtomicMutationBatch, 'batchHash'>): AtomicMutationBatch {
  const normalized = { ...input, storeNames: [...input.storeNames].sort() };
  return { ...normalized, batchHash: hashCanonical({ expectedCursor: normalized.expectedCursor, expectedPrivacyEpoch: normalized.expectedPrivacyEpoch, storeNames: normalized.storeNames, mutations: normalized.mutations }) };
}

export function toStoredRecord<T>(recordId: string, recordType: string, payload: T, writtenAt = new Date().toISOString()): StoredRecord<T> {
  const base = { recordId, recordType, writtenAt, payload };
  return { ...base, contentHash: hashCanonical(base) };
}

function immutablePayloadHash(record: StoredRecord): Hash {
  return hashCanonical({ recordType: record.recordType, payload: record.payload });
}

function validateBatch(batch: AtomicMutationBatch): void {
  if (batch.mutations.length > 500) throw new M1bError('ERR_BATCH_LIMIT');
  const actualStores = [...new Set(batch.mutations.map((mutation) => mutation.storeName))].sort();
  const declaredStores = [...batch.storeNames];
  if (declaredStores.join('|') !== [...new Set(declaredStores)].sort().join('|') || actualStores.join('|') !== declaredStores.join('|')) throw new M1bError('ERR_STORE_SET_MISMATCH');
  const expectedHash = hashCanonical({ expectedCursor: batch.expectedCursor, expectedPrivacyEpoch: batch.expectedPrivacyEpoch, storeNames: batch.storeNames, mutations: batch.mutations });
  if (batch.batchHash !== expectedHash) throw new M1bError('ERR_BATCH_HASH_MISMATCH');
  if (estimateBytes(batch.mutations) > 4 * 1024 * 1024) throw new M1bError('ERR_BATCH_LIMIT');
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
    const currentHash = current?.contentHash ?? null;
    if (currentHash !== mutation.expectedContentHash) throw new M1bError('ERR_REVISION_CONFLICT');
    store.put(mutation.record);
    return { byteDelta: estimateBytes(mutation.record) - estimateBytes(current), affected: { recordType: mutation.record.recordType, recordId: mutation.record.recordId }, change: { recordType: mutation.record.recordType, recordId: mutation.record.recordId, change: 'put', contentHash: mutation.record.contentHash } };
  }
  if (mutation.kind === 'deleteIfHash') {
    const current = await requestValue<StoredRecord | ProjectionHeadRecord | undefined>(store.get(mutation.recordId));
    if (!current) return { byteDelta: 0, change: { recordType: 'unknown', recordId: mutation.recordId, change: 'delete' } };
    const currentHash = recordHash(current);
    if (currentHash !== mutation.expectedContentHash) throw new M1bError('ERR_HASH_MISMATCH');
    store.delete(mutation.recordId);
    const recordType = 'recordType' in current ? current.recordType : 'projection_head';
    return { byteDelta: -estimateBytes(current), affected: { recordType, recordId: mutation.recordId }, change: { recordType, recordId: mutation.recordId, change: 'delete' } };
  }
  const current = await requestValue<ProjectionHeadRecord | undefined>(store.get(mutation.next.projectionId));
  if ((current?.sourceCursor ?? '0') !== mutation.expectedSourceCursor) throw new M1bError('ERR_PROJECTION_STALE');
  store.put(mutation.next);
  return { byteDelta: estimateBytes(mutation.next) - estimateBytes(current), affected: { recordType: 'projection_head', recordId: mutation.next.projectionId }, change: { recordType: 'projection_head', recordId: mutation.next.projectionId, change: 'put', contentHash: mutation.next.projectionHash } };
}

async function assertLease(tx: IDBTransaction, ownerClientId: string, fencingToken: string, now: number): Promise<RecoveryLeaseRecord> {
  if (!Number.isFinite(now)) throw new M1bError('ERR_CLOCK_UNAVAILABLE');
  const lease = await requestValue<RecoveryLeaseRecord | undefined>(tx.objectStore('system').get('recovery-lease'));
  if (!lease || lease.ownerClientId !== ownerClientId || lease.fencingToken !== fencingToken || Date.parse(lease.expiresAt) <= now) throw new M1bError('ERR_RECOVERY_LEASE_LOST');
  return lease;
}

async function bumpRecoveryCursor(tx: IDBTransaction, reclaimedBytes = 0, recoveryDelta = 0): Promise<void> {
  const store = tx.objectStore('meta');
  const meta = await requestValue<StoreMetaRecord>(store.get('canonical'));
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
  };
}

function assertMeta(meta: StoreMetaRecord | undefined, cursor: Cursor, epoch: number, requireActive: boolean): asserts meta is StoreMetaRecord {
  if (!meta) throw new M1bError('ERR_STORAGE_CORRUPT');
  if (meta.privacyEpoch !== epoch) throw new M1bError('ERR_PRIVACY_EPOCH_STALE');
  if (meta.cursor !== cursor) throw new M1bError('ERR_CURSOR_CONFLICT');
  if (meta.recoveryMode !== 'NORMAL') throw new M1bError('ERR_RECOVERY_REQUIRED');
  if (requireActive && meta.observationMode !== 'ACTIVE') throw new M1bError('ERR_PRIVACY_MODE_ACTIVE');
}

async function snapshotHash(tx: IDBTransaction): Promise<Hash> {
  const roots: Record<string, unknown[]> = {};
  for (const storeName of ROOT_STORES) {
    roots[storeName] = await requestValue<unknown[]>(tx.objectStore(storeName).getAll());
  }
  return hashCanonical(roots);
}

async function entries(store: IDBObjectStore): Promise<{ keys: IDBValidKey[]; values: unknown[] }> {
  const keys = await requestValue<IDBValidKey[]>(store.getAllKeys());
  const values = await requestValue<unknown[]>(store.getAll());
  return { keys, values };
}

function isOwnDeletionControl(store: PhysicalStoreName, key: IDBValidKey | undefined, value: unknown, journal: ActiveDeletionJournalRecord): boolean {
  if (store === 'meta') return true;
  if (store === 'journal' && (String(key) === journal.id || String(key).startsWith(`work:${journal.id}:`))) return true;
  if (store === 'system' && (String(key) === journal.planId || String(key) === 'recovery-lease' || String(key).startsWith(`purge-ack:${journal.id}:`))) return true;
  return false;
}

function isPurgeAck(value: StoredRecord | PurgeAckRecord): value is PurgeAckRecord {
  return value.recordType === 'purge_ack' && 'deletionId' in value;
}

function recordHash(value: unknown): Hash | undefined {
  if (value && typeof value === 'object') {
    if ('contentHash' in value && typeof (value as { contentHash?: unknown }).contentHash === 'string') return (value as { contentHash: Hash }).contentHash;
    if ('projectionHash' in value && typeof (value as { projectionHash?: unknown }).projectionHash === 'string') return (value as { projectionHash: Hash }).projectionHash;
  }
  return undefined;
}

function matchesDeletionTarget(value: unknown, journal: ActiveDeletionJournalRecord): boolean {
  return (journal.targetAnchors ?? [journal.targetId, journal.targetHash]).some((anchor) => deepContains(value, anchor));
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

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new M1bError('ERR_STORAGE'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new M1bError('ERR_STORAGE_ABORT'));
    transaction.onerror = () => undefined;
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

function deleteDatabaseResult(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    let settled = false;
    const settle = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => settle(false), DELETE_TIMEOUT_MS);
    request.onsuccess = () => { clearTimeout(timer); settle(true); };
    request.onerror = () => { clearTimeout(timer); settle(false); };
    request.onblocked = () => undefined;
  });
}
