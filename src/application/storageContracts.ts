import { hashCanonical } from '../domain/canonical';
import type { Hash } from '../domain/types';

export type Cursor = string;
export type StorageKey = string;
export type StoreName =
  | 'business'
  | 'system'
  | 'heads'
  | 'ledger'
  | 'journal'
  | 'audit'
  | 'projection'
  | 'changes';

export interface PurgeWatermark {
  readonly deletionId: string;
  readonly generation: string;
  readonly cursor: Cursor;
  readonly anchorDigests?: readonly Hash[];
  readonly journalHash: Hash;
  readonly leaseGeneration: number;
  readonly verifiedAt: string;
  readonly contentHash: Hash;
}

export interface StoreMetaRecord {
  readonly key: 'canonical';
  readonly cursor: Cursor;
  readonly privacyEpoch: number;
  readonly observationMode: 'ACTIVE' | 'PRIVATE';
  readonly recoveryMode: 'NORMAL' | 'RECOVERY_ONLY' | 'CLEAR_ONLY';
  readonly schemaVersion: '1.0.0';
  readonly logicalBytes: number;
  readonly recoveryBytes: number;
  readonly recoveryReserveBytes: 5242880;
  readonly sizeEstimatorVersion: 'storage-size-v1';
  readonly incarnation?: string;
  readonly purgeWatermark?: PurgeWatermark;
  readonly lastPurgeCursor?: Cursor;
  readonly purgeWatermarks?: readonly PurgeWatermark[];
  readonly purgedAnchorDigests: readonly Hash[];
  readonly purgedAnchorIndexHash: Hash;
}

export interface StoredRecord<T = unknown> {
  readonly recordId: string;
  readonly recordType: string;
  readonly writtenAt: string;
  readonly payload: T;
  readonly contentHash: Hash;
}

export interface ProjectionHeadRecord {
  readonly projectionId: string;
  readonly sourceCursor: Cursor;
  readonly projectionHash: Hash;
  readonly revision: number;
  readonly payload?: unknown;
}

export type CanonicalMutation =
  | { readonly kind: 'insertImmutable'; readonly storeName: 'business' | 'system' | 'ledger' | 'audit' | 'changes'; readonly record: StoredRecord }
  | { readonly kind: 'casSingleton'; readonly storeName: 'heads' | 'system'; readonly record: StoredRecord; readonly expectedContentHash: Hash | null }
  | { readonly kind: 'deleteIfHash'; readonly storeName: StoreName; readonly recordId: string; readonly expectedContentHash: Hash }
  | { readonly kind: 'casProjectionHead'; readonly storeName: 'projection'; readonly expectedSourceCursor: Cursor; readonly next: ProjectionHeadRecord };

export interface AtomicMutationBatch {
  readonly idempotencyKey: string;
  readonly expectedCursor: Cursor;
  readonly expectedPrivacyEpoch: number;
  readonly storeNames: readonly StoreName[];
  readonly mutations: readonly CanonicalMutation[];
  readonly batchHash: Hash;
  readonly requiresActiveObservation?: boolean;
  readonly requiresPreview?: boolean;
}

export interface CommitResult {
  readonly cursor: Cursor;
  readonly applied: boolean;
  readonly ledger: CommitLedgerRecord;
}

export interface CommitLedgerRecord {
  readonly idempotencyKey: string;
  readonly batchHash: Hash;
  readonly committedCursor: Cursor;
  readonly affectedRefs: readonly { readonly recordType: string; readonly recordId: string }[];
  readonly committedAt: string;
}

export interface PreviewCommitGuardRecord {
  readonly recordId: string;
  readonly recordType: 'preview_commit_guard';
  readonly writtenAt: string;
  readonly tokenHash: Hash;
  readonly bufferHandleHash: Hash;
  readonly inputHash: Hash;
  readonly privacyEpoch: number;
  readonly callerId: string;
  readonly expiresAt: string;
  readonly state: 'READY' | 'CONSUMED';
  readonly idempotencyKey: string;
  readonly batchHash?: Hash;
  readonly receiptId?: string;
  readonly contentHash: Hash;
}

export interface DeletionPlanRecord {
  readonly recordId: string;
  readonly recordType: 'deletion_plan';
  readonly writtenAt: string;
  readonly target: { readonly storeName: StoreName; readonly recordId: string; readonly contentHash: Hash; readonly recordType: string; readonly lineageAnchorDigests?: readonly Hash[] };
  readonly cause: 'user-delete' | 'consent-revoked' | 'retention-expired' | 'clear-all';
  readonly baseCursor: Cursor;
  readonly basePrivacyEpoch: number;
  readonly baseSnapshotHash: Hash;
  readonly closureRulesHash: Hash;
  readonly planHash: Hash;
  readonly contentHash: Hash;
}

export interface ActiveDeletionJournalRecord {
  readonly id: string;
  readonly recordType: 'active_deletion_journal';
  readonly state: 'FENCED' | 'DELETING' | 'PURGE_PENDING' | 'AUDITING' | 'FINALIZING' | 'FAILED';
  readonly planId: string;
  readonly planHash: Hash;
  readonly targetId: string;
  readonly targetHash: Hash;
  readonly targetType: string;
  readonly targetAnchors: readonly Hash[];
  readonly baseCursor: Cursor;
  readonly basePrivacyEpoch: number;
  readonly enumeration: { readonly registryIndex: number; readonly pageOffset: number; readonly continuationKey?: string; readonly complete: boolean; readonly enumeratedCount: number };
  readonly progress: { readonly nextOrdinal: Cursor; readonly completedCount: number; readonly totalCount: number };
  readonly purge: { readonly generation: string; readonly cutoff: string; readonly sealedAt?: string; readonly requiredClientIds: readonly string[] };
  readonly finalizing: { readonly complete: boolean; readonly removedControlCount: number };
  readonly updatedAt: string;
  readonly contentHash: Hash;
}

export interface RecoveryLeaseRecord {
  readonly recordId: 'recovery-lease';
  readonly recordType: 'recovery_lease';
  readonly writtenAt: string;
  readonly ownerClientId: string;
  readonly generation: number;
  readonly fencingToken: string;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
  readonly contentHash: Hash;
}

export interface ClientRegistrationRecord {
  readonly recordId: string;
  readonly recordType: 'client_registration';
  readonly writtenAt: string;
  readonly clientId: string;
  readonly leaseExpiresAt: string;
  readonly state: 'ACTIVE' | 'CLOSING' | 'QUARANTINED';
  readonly purgeGeneration?: string;
  readonly purgeAckGeneration?: string;
  readonly contentHash: Hash;
}

export interface PurgeAckRecord {
  readonly recordId: string;
  readonly recordType: 'purge_ack';
  readonly writtenAt: string;
  readonly deletionId: string;
  readonly generation: string;
  readonly clientId: string;
  readonly contentHash: Hash;
}

export interface ReachabilityRootReceipt {
  readonly rootId: string;
  readonly scannedItemCount: number;
  readonly forbiddenReferenceCount: number;
}

export interface ReachabilityResult {
  readonly deletionId: string;
  readonly generation: string;
  readonly receipts: readonly ReachabilityRootReceipt[];
  readonly reachableCount: number;
  readonly allRequiredClientsPurged: boolean;
  readonly registryComplete: boolean;
  readonly outcome: 'CLEAN' | 'REACHABLE' | 'CLIENTS_PENDING' | 'REGISTRY_INCOMPLETE';
  readonly coverage: 'single-browser-in-process';
  readonly registryRevision: number;
  readonly journalHash: Hash;
  readonly leaseGeneration: number;
  readonly leaseFencingTokenHash: Hash;
}

export interface ClearAllResult {
  readonly state: 'SUCCEEDED' | 'BLOCKED';
  readonly databaseDeleted: boolean;
  readonly cachesCleared: boolean;
  readonly emptyReopenVerified: boolean;
  readonly errorCode?: 'ERR_STORAGE_BLOCKED';
  readonly pendingDeletion?: boolean;
  readonly coverage: 'single-browser-in-process';
}

export interface ChangeRecord {
  readonly id: string;
  readonly cursor: Cursor;
  readonly recordType: string;
  readonly recordId: string;
  readonly change: 'put' | 'delete';
  readonly contentHash?: Hash;
}

export function makeBatch(input: Omit<AtomicMutationBatch, 'batchHash'>): AtomicMutationBatch {
  const normalized = { ...input, storeNames: [...input.storeNames].sort() };
  return {
    ...normalized,
    batchHash: hashCanonical({
      expectedCursor: normalized.expectedCursor,
      expectedPrivacyEpoch: normalized.expectedPrivacyEpoch,
      requiresActiveObservation: normalized.requiresActiveObservation === true,
      requiresPreview: normalized.requiresPreview === true,
      storeNames: normalized.storeNames,
      mutations: normalized.mutations,
    }),
  };
}

export function toStoredRecord<T>(recordId: string, recordType: string, payload: T, writtenAt = new Date().toISOString()): StoredRecord<T> {
  const base = { recordId, recordType, writtenAt, payload };
  return { ...base, contentHash: hashCanonical(base) };
}

export class CommitResponseLostError extends Error {
  readonly code = 'ERR_TEST_RESPONSE_LOST';

  constructor(readonly committedCursor: Cursor) {
    super('ERR_TEST_RESPONSE_LOST');
    this.name = 'CommitResponseLostError';
  }
}
