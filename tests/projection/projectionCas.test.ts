import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDbM1bAdapter, makeBatch } from '../../src/adapters/indexedDbM1b';
import { sha256 } from '../../src/domain/canonical';

const adapters: IndexedDbM1bAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.destroy()));
});

describe('projection sourceCursor CAS', () => {
  it('prevents stale rebuild completion from overwriting a newer projection', async () => {
    const adapter = new IndexedDbM1bAdapter();
    adapters.push(adapter);
    for (let cursor = 0; cursor < 7; cursor += 1) {
      await adapter.commit(makeBatch({
        idempotencyKey: `advance-${cursor}`, expectedCursor: String(cursor), expectedPrivacyEpoch: 0,
        storeNames: [], mutations: [],
      }));
    }

    await adapter.publishProjection({ projectionId: 'today', sourceCursor: '4', projectionHash: sha256('four'), revision: 1, payload: { count: 4 } }, '0');
    await adapter.publishProjection({ projectionId: 'today', sourceCursor: '7', projectionHash: sha256('seven'), revision: 2, payload: { count: 7 } }, '4');

    await expect(adapter.publishProjection({ projectionId: 'today', sourceCursor: '5', projectionHash: sha256('stale'), revision: 2 }, '4')).rejects.toMatchObject({ code: 'ERR_PROJECTION_STALE' });
    await expect(adapter.publishProjection({ projectionId: 'today', sourceCursor: '8', projectionHash: sha256('future'), revision: 3 }, '7')).rejects.toMatchObject({ code: 'ERR_PROJECTION_STALE' });
    expect(await adapter.getRecord('projection', 'today')).toMatchObject({ sourceCursor: '7', projectionHash: sha256('seven'), revision: 2 });
    expect((await adapter.getMeta()).cursor).toBe('7');
  });
});
