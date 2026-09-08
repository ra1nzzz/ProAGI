import type { Hash } from '../domain/types';
import type { ChangeRecord, Cursor, ProjectionHeadRecord, StoredRecord, StoreMetaRecord } from './storageContracts';
import type { RuntimeStoragePort } from './storagePort';
import type { TraceRecord } from './trace';

export interface ProjectionChangePage {
  readonly meta: StoreMetaRecord;
  readonly changes: readonly ChangeRecord[];
  readonly records: readonly StoredRecord[];
  readonly fullSnapshotRequired: boolean;
}
export interface ProjectionStoragePort extends Pick<RuntimeStoragePort, 'getMeta' | 'getRecord' | 'readCanonicalSnapshot' | 'beginInProcessRootMutation'> {
  readonly appendTraceEvents?: (events: readonly TraceRecord[]) => Promise<void>;
  loadChangesSince(after: Cursor, limit?: number): Promise<ProjectionChangePage>;
  publishProjection(next: ProjectionHeadRecord, expectedSourceCursor: Cursor, expected?: {
    readonly privacyEpoch: number; readonly incarnation?: string; readonly projectionHash: Hash | null;
  }): Promise<{ applied: boolean; head: ProjectionHeadRecord }>;
}
export interface MarkdownProjection {
  readonly sourceCursor: Cursor;
  readonly privacyEpoch: number;
  readonly incarnation?: string;
  readonly markdown: string;
  readonly documentCount: number;
  readonly mode: 'full' | 'incremental';
  readonly contentHash: Hash;
}
export interface MarkdownExport extends MarkdownProjection {
  readonly filename: 'proagi-knowledge.md';
  readonly mediaType: 'text/markdown';
  readonly highestClassification: 'local-sensitive';
  readonly notice: 'LOCAL_FILE_CANNOT_BE_REMOTELY_REVOKED';
}
export interface ProjectionPort {
  rebuild(options?: { readonly forceFull?: boolean }): Promise<MarkdownProjection>;
  export(confirmation: { readonly capability: 'projection.export'; readonly confirmedHash: Hash; readonly acknowledgeIrrevocable: true }): Promise<MarkdownExport>;
  disable(): void;
}
