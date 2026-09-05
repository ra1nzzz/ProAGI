import type { ReplaySnapshotV1 } from '../domain/replay';
import type { CorrectionAction } from '../domain/types';
import type { CorrectionResult } from './knowledge';
import type { ImportCommit } from './insightService';

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
  evaluateReplay(): ReplaySnapshotV1;
}
