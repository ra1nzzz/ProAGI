import type {
  ActiveDeletionJournalRecord,
  AtomicMutationBatch,
  ClearAllResult,
  ClientRegistrationRecord,
  CommitResult,
  Cursor,
  DeletionPlanRecord,
  PreviewCommitGuardRecord,
  PurgeAckRecord,
  ReachabilityResult,
  RecoveryLeaseRecord,
  StoreMetaRecord,
  StoreName,
  StoredRecord,
  StorageKey,
} from './storageContracts';
import type { Hash } from '../domain/types';

export interface RuntimeRootHooks {
  readonly freeze: () => void;
  readonly unfreeze: () => void;
}

export interface RuntimeStoragePort {
  open(): Promise<void>;
  dispose(): void;
  beginInProcessRootMutation(): () => void;
  registerInProcessRoot(rootId: string, read: () => readonly unknown[], hooks: RuntimeRootHooks): () => void;
  getMeta(): Promise<StoreMetaRecord>;
  getRecord<T>(storeName: StoreName, key: StorageKey): Promise<T | undefined>;
  getAll<T>(storeName: StoreName): Promise<T[]>;
  readPurgeFence(): Promise<{ readonly meta: StoreMetaRecord; readonly journals: ActiveDeletionJournalRecord[] }>;
  readCanonicalSnapshot(): Promise<{ readonly meta: StoreMetaRecord; readonly business: StoredRecord[]; readonly heads: StoredRecord[] }>;
  commit(batch: AtomicMutationBatch, options?: { readonly simulateResponseLoss?: boolean }): Promise<CommitResult>;
  setPrivacyMode(expectedCursor: Cursor, expectedPrivacyEpoch: number, mode: 'ACTIVE' | 'PRIVATE', idempotencyKey: string): Promise<CommitResult>;
  stagePreview(input: {
    readonly token?: string;
    readonly callerId: string;
    readonly idempotencyKey: string;
    readonly inputHash: Hash;
    readonly bytes: Uint8Array;
    readonly privacyEpoch: number;
    readonly expiresAt: string;
  }): Promise<{ readonly token: string; readonly guard: PreviewCommitGuardRecord }>;
  bindPreviewBatch(token: string, batchHash: Hash): Promise<PreviewCommitGuardRecord>;
  commitPreview(token: string, callerId: string, batch: AtomicMutationBatch, legacyNow?: string, simulateResponseLoss?: boolean): Promise<CommitResult>;
  cancelPreview(token: string): Promise<void>;
  scanPublishedBusiness(): Promise<StoredRecord[]>;
  registerClient(clientId: string, now?: number): Promise<ClientRegistrationRecord>;
  closeClient(clientId: string, now?: number): Promise<void>;
  renewClient(clientId: string, now?: number): Promise<ClientRegistrationRecord>;
  planDeletion(target: { readonly storeName: StoreName; readonly recordId: string; readonly contentHash: Hash; readonly recordType: string; readonly lineageAnchorDigests?: readonly Hash[] }, cause?: DeletionPlanRecord['cause']): Promise<DeletionPlanRecord>;
  fenceDeletion(plan: DeletionPlanRecord, ownerClientId: string, now?: number): Promise<{ readonly journal: ActiveDeletionJournalRecord; readonly lease: RecoveryLeaseRecord }>;
  enumerateDeletionPage(deletionId: string, ownerClientId: string, fencingToken: string, limit?: number, now?: number): Promise<ActiveDeletionJournalRecord>;
  deleteChunk(deletionId: string, ownerClientId: string, fencingToken: string, limit?: number, now?: number): Promise<ActiveDeletionJournalRecord>;
  acknowledgePurge(deletionId: string, generation: string, clientId: string, now?: number): Promise<PurgeAckRecord>;
  retryPurge(deletionId: string, ownerClientId: string, fencingToken: string, liveClientIds: readonly string[], now?: number): Promise<ActiveDeletionJournalRecord>;
  sealAndAudit(deletionId: string, ownerClientId: string, fencingToken: string, now?: number): Promise<ReachabilityResult>;
  finalizeDeletionPage(deletionId: string, ownerClientId: string, fencingToken: string, limit?: number, now?: number): Promise<ActiveDeletionJournalRecord>;
  verifyDeletion(deletionId: string, ownerClientId: string, fencingToken: string, now?: number, simulateResponseLoss?: boolean): Promise<{ readonly verifiedId: string; readonly tombstoneId: string }>;
  renewRecoveryLease(ownerClientId: string, fencingToken: string, now?: number): Promise<RecoveryLeaseRecord>;
  stealRecoveryLease(ownerClientId: string, now?: number): Promise<RecoveryLeaseRecord>;
  clearAll(options?: { readonly simulateBlocked?: boolean; readonly cachesCleared?: boolean; readonly deleteTimeoutMs?: number; readonly quiescenceTimeoutMs?: number }): Promise<ClearAllResult>;
}
