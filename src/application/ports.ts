import type { ReplaySnapshotV1 } from '../domain/replay';
import type { BehaviorEvent, CorrectionAction, CorrectionCommand, KnowledgeSnapshot, WorkModelClaim } from '../domain/types';
import type { CorrectionResult } from './knowledge';
import type { ImportCommit } from './insightService';
import type { PreviewReceipt } from './previewGuard';

export interface ExternalPurgeNotification {
  readonly deletionId: string;
  readonly generation: string;
  readonly external: boolean;
  readonly requestId: string;
}

export interface PurgeCommittedNotification {
  readonly requestId: string;
}

export interface RuntimeSnapshotNotification {
  readonly imported?: ImportCommit | null;
  readonly observationMode?: 'ACTIVE' | 'PRIVATE';
  readonly purge?: boolean;
  readonly purgeVerified?: boolean;
  readonly externalPurge?: boolean;
  readonly runtimeFaulted?: boolean;
}

export interface RuntimeErrorNotification {
  readonly operation: string;
  readonly code: string;
  readonly runtimeFaulted: boolean;
}

export const EXTERNAL_PURGE_EVENT = 'proagi:external-purge' as const;
export const PURGE_COMMITTED_EVENT = 'proagi:purge-committed' as const;
export const RUNTIME_SNAPSHOT_EVENT = 'proagi:runtime-snapshot' as const;
export const RUNTIME_ERROR_EVENT = 'proagi:runtime-error' as const;

export interface RuntimeNotificationPort {
  prepareForPurge(detail: Omit<ExternalPurgeNotification, 'requestId'>): Promise<void>;
  publishSnapshot(detail: RuntimeSnapshotNotification): void;
  publishError(detail: RuntimeErrorNotification): void;
}

export interface InsightServicePort {
  knowledgeSnapshot(): KnowledgeSnapshot;
  hydrateKnowledge(snapshot: KnowledgeSnapshot): void;
  currentClaim(claimKey: string): WorkModelClaim | undefined;
  fork(): InsightServicePort;
  restoreEvents(events: readonly BehaviorEvent[]): void;
  preview(utf8: string, now: number): { readonly token: string; readonly acceptedCount: number; readonly rejectedCount: number };
  commit(token: string, idempotencyKey: string, now: number, options?: { readonly simulateResponseLoss?: boolean }): Promise<PreviewReceipt<ImportCommit>>;
  correct(command: CorrectionCommand): CorrectionResult;
  replay(): ReplaySnapshotV1;
}

export interface ObservationPreviewDTO {
  readonly token: string;
  readonly acceptedCount: number;
  readonly episodeCount: number;
  readonly insightCount: number;
  readonly source: 'bundled-synthetic-fixture';
}

export interface ObservationPort {
  preview(): Promise<ObservationPreviewDTO>;
  commit(token: string): Promise<ImportCommit>;
}

export interface CorrectionPort {
  submit(action: Exclude<CorrectionAction, 'restore'>): Promise<CorrectionResult>;
}

export interface ControlPort {
  pausePrivacy(): Promise<{ readonly privacyEpoch: number }>;
  resumePrivacy(): Promise<{ readonly privacyEpoch: number }>;
  clear(): Promise<void>;
  recover(): Promise<void>;
  evaluateReplay(): Promise<ReplaySnapshotV1>;
}
