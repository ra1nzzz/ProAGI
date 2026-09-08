import { IndexedDbM1bAdapter } from '../adapters/indexedDbM1b';
import { ReadonlyTestResultsAdapter } from '../adapters/readonlyTestResults';
import { createNdjsonWorker } from '../workers/browserImport';
import { BrowserInsightRuntime, type BrowserInsightRuntimeOptions } from './browserInsightRuntime';
import { InsightLoopService } from './insightService';
import type { InsightServicePort, ReadonlyObservationAdapter } from './ports';
import type { RuntimeStoragePort } from './storagePort';

export const DEFAULT_RUNTIME_DATABASE_NAME = 'proagi-insight-loop-m1-v1';

export function createDefaultRuntimeStorage(): RuntimeStoragePort {
  return new IndexedDbM1bAdapter(DEFAULT_RUNTIME_DATABASE_NAME);
}

export function createDefaultInsightService(): InsightServicePort {
  return new InsightLoopService();
}

export type BrowserRuntimeCompositionOptions = Omit<BrowserInsightRuntimeOptions, 'adapterFactory' | 'serviceFactory' | 'readonlyAdapter'> & {
  readonly adapterFactory?: () => RuntimeStoragePort;
  readonly serviceFactory?: () => InsightServicePort;
  readonly readonlyAdapter?: ReadonlyObservationAdapter;
};

export function createBrowserInsightRuntime(options: BrowserRuntimeCompositionOptions = {}): BrowserInsightRuntime {
  return new BrowserInsightRuntime({
    ...options,
    adapterFactory: options.adapterFactory ?? createDefaultRuntimeStorage,
    serviceFactory: options.serviceFactory ?? createDefaultInsightService,
    readonlyAdapter: options.readonlyAdapter ?? new ReadonlyTestResultsAdapter(),
    workerFactory: options.workerFactory ?? (import.meta.env.VITEST ? null : createNdjsonWorker),
  });
}
