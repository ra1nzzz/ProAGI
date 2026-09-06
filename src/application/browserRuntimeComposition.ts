import { IndexedDbM1bAdapter } from '../adapters/indexedDbM1b';
import { BrowserInsightRuntime, type BrowserInsightRuntimeOptions } from './browserInsightRuntime';
import { InsightLoopService } from './insightService';
import type { InsightServicePort } from './ports';
import type { RuntimeStoragePort } from './storagePort';

export const DEFAULT_RUNTIME_DATABASE_NAME = 'proagi-insight-loop-m1-v1';

export function createDefaultRuntimeStorage(): RuntimeStoragePort {
  return new IndexedDbM1bAdapter(DEFAULT_RUNTIME_DATABASE_NAME);
}

export function createDefaultInsightService(): InsightServicePort {
  return new InsightLoopService();
}

export type BrowserRuntimeCompositionOptions = Omit<BrowserInsightRuntimeOptions, 'adapterFactory' | 'serviceFactory'> & {
  readonly adapterFactory?: () => RuntimeStoragePort;
  readonly serviceFactory?: () => InsightServicePort;
};

export function createBrowserInsightRuntime(options: BrowserRuntimeCompositionOptions = {}): BrowserInsightRuntime {
  return new BrowserInsightRuntime({
    ...options,
    adapterFactory: options.adapterFactory ?? createDefaultRuntimeStorage,
    serviceFactory: options.serviceFactory ?? createDefaultInsightService,
  });
}
