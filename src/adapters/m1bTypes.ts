import type { Hash } from '../domain/types';

export type Cursor = string;
export type StoreName =
  | 'business'
  | 'system'
  | 'heads'
  | 'ledger'
  | 'journal'
  | 'audit'
  | 'projection'
  | 'changes';
export type PhysicalStoreName = 'meta' | StoreName;

export const STORE_NAMES: readonly StoreName[] = [
  'business',
  'system',
  'heads',
  'ledger',
  'journal',
  'audit',
  'projection',
  'changes',
];

export interface StoreMetaRecord {
  key: 'canonical';
  cursor: Cursor;
  privacyEpoch: number;
  observationMode: 'ACTIVE' | 'PRIVATE';
  recoveryMode: 'NORMAL' | 'RECOVERY_ONLY' | 'CLEAR_ONLY';
  schemaVersion: '1.0.0';
  logicalBytes: number;
  recoveryBytes: number;
  recoveryReserveBytes: 5242880;
  sizeEstimatorVersion: 'storage-size-v1';
}

export interface StoredRecord<T = unknown> {
  recordId: string;
  recordType: string;
  writtenAt: string;
  payload: T;
  contentHash: Hash;
}

export interface ProjectionHeadRecord {
  projectionId: string;
  sourceCursor: Cursor;
  projectionHash: Hash;
  revision: number;
  payload?: unknown;
}

export type CanonicalMutation =
  | { kind: 'insertImmutable'; storeName: 'business' | 'system' | 'ledger' | 'audit' | 'changes'; record: StoredRecord }
  | { kind: 'casSingleton'; storeName: 'heads' | 'system'; record: StoredRecord; expectedContentHash: Hash | null }
  | { kind: 'deleteIfHash'; storeName: StoreName; recordId: string; expectedContentHash: Hash }
  | { kind: 'casProjectionHead'; storeName: 'projection'; expectedSourceCursor: Cursor; next: ProjectionHeadRecord };

export interface AtomicMutationBatch {
  idempotencyKey: string;
  expectedCursor: Cursor;
  expectedPrivacyEpoch: number;
  storeNames: readonly StoreName[];
  mutations: readonly CanonicalMutation[];
  batchHash: Hash;
  requiresActiveObservation?: boolean;
}

export interface ChangeRecord {
  id: string;
  cursor: Cursor;
  recordType: string;
  recordId: string;
  change: 'put' | 'delete';
  contentHash?: Hash;
}

export interface CommitLedgerRecord {
  idempotencyKey: string;
  batchHash: Hash;
  committedCursor: Cursor;
  affectedRefs: readonly { recordType: string; recordId: string }[];
  committedAt: string;
}

export interface CommitResult {
  cursor: Cursor;
  applied: boolean;
  ledger: CommitLedgerRecord;
}

export interface PreviewCommitGuardRecord {
  recordId: string;
  recordType: 'preview_commit_guard';
  writtenAt: string;
  tokenHash: Hash;
  bufferHandleHash: Hash;
  inputHash: Hash;
  privacyEpoch: number;
  callerId: string;
  expiresAt: string;
  state: 'READY' | 'CONSUMED';
  idempotencyKey: string;
  receiptId?: string;
  contentHash: Hash;
}

export interface PreviewCommitReceipt {
  recordId: string;
  recordType: 'observation_commit_receipt';
  writtenAt: string;
  guardId: string;
  idempotencyKey: string;
  cursor: Cursor;
  batchHash: Hash;
  contentHash: Hash;
}

export interface ImportSessionRecord {
  recordId: string;
  recordType: 'import_session';
  writtenAt: string;
  streamId: string;
  state: 'RECEIVING' | 'VALIDATED' | 'COMMITTING' | 'PUBLISHED' | 'CANCELLED' | 'FAILED';
  baseCursor: Cursor;
  privacyEpoch: number;
  committedBatchHashes: readonly Hash[];
  committedEventCount: number;
  publishedCursor?: Cursor;
  contentHash: Hash;
}

export interface DeletionPlanRecord {
  recordId: string;
  recordType: 'deletion_plan';
  writtenAt: string;
  target: { storeName: StoreName; recordId: string; contentHash: Hash; recordType: string };
  cause: 'user-delete' | 'consent-revoked' | 'retention-expired' | 'clear-all';
  baseCursor: Cursor;
  basePrivacyEpoch: number;
  baseSnapshotHash: Hash;
  closureRulesHash: Hash;
  planHash: Hash;
  contentHash: Hash;
}

export interface DeletionWorkItemRecord {
  id: string;
  deletionId: string;
  ordinal: Cursor;
  storeName: StoreName;
  recordId: string;
  expectedContentHash?: Hash;
  estimatedBytes: number;
}

export interface ActiveDeletionJournalRecord {
  id: string;
  recordType: 'active_deletion_journal';
  state: 'FENCED' | 'DELETING' | 'PURGE_PENDING' | 'AUDITING' | 'FINALIZING' | 'FAILED';
  planId: string;
  planHash: Hash;
  targetId: string;
  targetHash: Hash;
  targetType: string;
  baseCursor: Cursor;
  basePrivacyEpoch: number;
  enumeration: { registryIndex: number; pageOffset: number; complete: boolean; enumeratedCount: number };
  progress: { nextOrdinal: Cursor; completedCount: number; totalCount: number };
  purge: { generation: string; cutoff: string; sealedAt?: string; requiredClientIds: readonly string[] };
  finalizing: { complete: boolean; removedControlCount: number };
  updatedAt: string;
  contentHash: Hash;
}

export interface RecoveryLeaseRecord {
  recordId: 'recovery-lease';
  recordType: 'recovery_lease';
  writtenAt: string;
  ownerClientId: string;
  generation: number;
  fencingToken: string;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  contentHash: Hash;
}

export interface ClientRegistrationRecord {
  recordId: string;
  recordType: 'client_registration';
  writtenAt: string;
  clientId: string;
  leaseExpiresAt: string;
  state: 'ACTIVE' | 'CLOSING' | 'QUARANTINED';
  purgeGeneration?: string;
  contentHash: Hash;
}

export interface PurgeAckRecord {
  recordId: string;
  recordType: 'purge_ack';
  writtenAt: string;
  deletionId: string;
  generation: string;
  clientId: string;
  contentHash: Hash;
}

export interface ReachabilityRootReceipt {
  rootId: string;
  scannedItemCount: number;
  forbiddenReferenceCount: number;
}

export interface ReachabilityResult {
  deletionId: string;
  generation: string;
  receipts: readonly ReachabilityRootReceipt[];
  reachableCount: number;
  allRequiredClientsPurged: boolean;
  registryComplete: boolean;
  outcome: 'CLEAN' | 'REACHABLE' | 'CLIENTS_PENDING' | 'REGISTRY_INCOMPLETE';
  coverage: 'single-browser-in-process';
}

export interface ClearAllResult {
  state: 'SUCCEEDED' | 'BLOCKED';
  databaseDeleted: boolean;
  cachesCleared: boolean;
  emptyReopenVerified: boolean;
  errorCode?: 'ERR_STORAGE_BLOCKED';
  coverage: 'single-browser-in-process';
}

export interface M1bRuntimeContract {
  indexedDb: true;
  crossTabBrowserVerified: false;
  purgeCoverage: 'single-browser-in-process';
  broadcastChannelRequiredForCorrectness: false;
}

export class M1bError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'M1bError';
  }
}

export class CommitResponseLostError extends M1bError {
  constructor(readonly committedCursor: Cursor) {
    super('ERR_TEST_RESPONSE_LOST');
  }
}
