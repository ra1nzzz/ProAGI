import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { CommitResponseLostError, M1bError } from '../../src/adapters/m1bTypes';
import { IndexedDbM1bAdapter, makeBatch, toStoredRecord } from '../../src/adapters/indexedDbM1b';

const adapters: IndexedDbM1bAdapter[] = [];

function createAdapter(): IndexedDbM1bAdapter {
  const adapter = new IndexedDbM1bAdapter();
  adapters.push(adapter);
  return adapter;
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.destroy()));
});

describe('IndexedDbM1bAdapter canonical transactions', () => {
  it('creates the explicit M1b stores and initial meta', async () => {
    const adapter = createAdapter();
    await adapter.open();
    expect(adapter.getRuntimeContract()).toEqual({
      indexedDb: true,
      crossTabBrowserVerified: false,
      purgeCoverage: 'single-browser-in-process',
      broadcastChannelRequiredForCorrectness: false,
    });
    expect(await adapter.getMeta()).toMatchObject({ cursor: '0', privacyEpoch: 0, observationMode: 'ACTIVE', recoveryMode: 'NORMAL' });
  });

  it('deduplicates identical source retries and rejects conflicting facts atomically', async () => {
    const adapter = createAdapter();
    const first = toStoredRecord('event-a', 'behavior_event_v1', { dedupeKey: 'source:item-1', factHash: 'sha256:same', value: 1 });
    await adapter.commit(makeBatch({ idempotencyKey: 'dedupe-a', expectedCursor: '0', expectedPrivacyEpoch: 0, storeNames: ['business'], mutations: [{ kind: 'insertImmutable', storeName: 'business', record: first }] }));
    const retry = toStoredRecord('event-b', 'behavior_event_v1', { dedupeKey: 'source:item-1', factHash: 'sha256:same', value: 1 });
    await adapter.commit(makeBatch({ idempotencyKey: 'dedupe-b', expectedCursor: '1', expectedPrivacyEpoch: 0, storeNames: ['business'], mutations: [{ kind: 'insertImmutable', storeName: 'business', record: retry }] }));
    expect(await adapter.getAll('business')).toHaveLength(1);
    const conflict = toStoredRecord('event-c', 'behavior_event_v1', { dedupeKey: 'source:item-1', factHash: 'sha256:different', value: 2 });
    await expect(adapter.commit(makeBatch({ idempotencyKey: 'dedupe-c', expectedCursor: '2', expectedPrivacyEpoch: 0, storeNames: ['business'], mutations: [{ kind: 'insertImmutable', storeName: 'business', record: conflict }] })))
      .rejects.toMatchObject({ code: 'ERR_DUPLICATE_CONFLICT' });
    expect(await adapter.getAll('business')).toHaveLength(1);
  });

  it('enforces cursor and privacy epoch CAS and recovers a lost response through the ledger', async () => {
    const adapter = createAdapter();
    const record = toStoredRecord('event-1', 'behavior_event', { sourceItemKey: 'one' });
    const batch = makeBatch({
      idempotencyKey: 'idem-1',
      expectedCursor: '0',
      expectedPrivacyEpoch: 0,
      storeNames: ['business'],
      mutations: [{ kind: 'insertImmutable', storeName: 'business', record }],
    });

    await expect(adapter.commit(batch, { simulateResponseLoss: true })).rejects.toBeInstanceOf(CommitResponseLostError);
    const retry = await adapter.commit(batch);
    expect(retry).toMatchObject({ cursor: '1', applied: false });
    expect(await adapter.getAll('business')).toHaveLength(1);
    expect(await adapter.getAll('changes')).toHaveLength(1);
    expect(await adapter.getAll('ledger')).toHaveLength(1);

    const stale = makeBatch({ ...batch, idempotencyKey: 'idem-2', mutations: [] as const, storeNames: [] as const });
    await expect(adapter.commit(stale)).rejects.toMatchObject({ code: 'ERR_CURSOR_CONFLICT' });

    const wrongEpoch = makeBatch({ ...stale, idempotencyKey: 'idem-3', expectedCursor: '1', expectedPrivacyEpoch: 99 });
    await expect(adapter.commit(wrongEpoch)).rejects.toMatchObject({ code: 'ERR_PRIVACY_EPOCH_STALE' });
  });

  it('atomically consumes PreviewCommitGuard with mutations, ledger and receipt', async () => {
    const adapter = createAdapter();
    const staged = await adapter.stagePreview({
      token: 'preview-token-with-more-than-128-bits-of-test-entropy',
      callerId: 'web-client',
      idempotencyKey: 'preview-idem',
      inputHash: 'sha256:input',
      bytes: new TextEncoder().encode('{"fixture":true}'),
      privacyEpoch: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const record = toStoredRecord('event-preview', 'behavior_event', { sourceItemKey: 'preview' });
    const batch = makeBatch({
      idempotencyKey: 'preview-idem',
      expectedCursor: '0',
      expectedPrivacyEpoch: 0,
      requiresActiveObservation: true,
      storeNames: ['business'],
      mutations: [{ kind: 'insertImmutable', storeName: 'business', record }],
    });
    const result = await adapter.commitPreview(staged.token, 'web-client', batch);
    expect(result.applied).toBe(true);
    expect(await adapter.getRecord<{ state: string }>('system', staged.guard.recordId)).toMatchObject({ state: 'CONSUMED' });
    expect((await adapter.getAll<{ recordType: string }>('system')).some((value) => value.recordType === 'observation_commit_receipt')).toBe(true);

    const responseLossRetry = await adapter.commitPreview(staged.token, 'web-client', batch);
    expect(responseLossRetry.applied).toBe(false);
    expect(await adapter.getAll('business')).toHaveLength(1);
  });

  it('fails closed when preview source bytes are gone without consuming the guard', async () => {
    const adapter = createAdapter();
    const staged = await adapter.stagePreview({
      token: 'buffer-loss-token',
      callerId: 'web-client',
      idempotencyKey: 'buffer-loss-idem',
      inputHash: 'sha256:input',
      bytes: new Uint8Array([1, 2, 3]),
      privacyEpoch: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    adapter.releasePreviewBuffer(staged.token);
    const batch = makeBatch({
      idempotencyKey: 'buffer-loss-idem', expectedCursor: '0', expectedPrivacyEpoch: 0, requiresActiveObservation: true,
      storeNames: ['business'], mutations: [{ kind: 'insertImmutable', storeName: 'business', record: toStoredRecord('never', 'behavior_event', {}) }],
    });
    await expect(adapter.commitPreview(staged.token, 'web-client', batch)).rejects.toMatchObject({ code: 'ERR_PREVIEW_BUFFER_MISSING' });
    expect(await adapter.getRecord<{ state: string }>('system', staged.guard.recordId)).toMatchObject({ state: 'READY' });
    expect(await adapter.getAll('business')).toHaveLength(0);
  });

  it('keeps ImportSession staging invisible until atomic publish', async () => {
    const adapter = createAdapter();
    const session = await adapter.createImportSession('stream-1', 'session-1');
    const event = toStoredRecord('event-staged', 'behavior_event', { sourceItemKey: 'staged' });
    await adapter.stageImportBatch('session-1', [event], 'sha256:batch');
    expect(await adapter.scanPublishedBusiness()).toEqual([]);
    expect((await adapter.getAll<{ recordType: string }>('system')).some((value) => value.recordType === 'import_staging')).toBe(true);

    const published = await adapter.publishImportSession('session-1', 'publish-idem');
    expect(published.applied).toBe(true);
    expect(await adapter.scanPublishedBusiness()).toEqual([event]);
    expect(await adapter.getRecord<{ state: string; publishedCursor: string }>('system', session.recordId)).toMatchObject({ state: 'PUBLISHED', publishedCursor: '1' });
    expect((await adapter.getAll<{ recordType: string }>('system')).some((value) => value.recordType === 'import_staging')).toBe(false);
  });

  it('atomically advances privacy epoch and invalidates outstanding preview state', async () => {
    const adapter = createAdapter();
    const staged = await adapter.stagePreview({
      token: 'privacy-preview-token-with-more-than-128-bits', callerId: 'web-client', idempotencyKey: 'privacy-preview',
      inputHash: 'sha256:input', bytes: new TextEncoder().encode('private'), privacyEpoch: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await adapter.setPrivacyMode('0', 0, 'PRIVATE', 'privacy-on');
    expect(await adapter.getMeta()).toMatchObject({ cursor: '1', privacyEpoch: 1, observationMode: 'PRIVATE' });
    expect(await adapter.getRecord('system', staged.guard.recordId)).toBeUndefined();

    const staleBatch = makeBatch({
      idempotencyKey: 'privacy-preview', expectedCursor: '0', expectedPrivacyEpoch: 0, requiresActiveObservation: true,
      storeNames: ['business'], mutations: [{ kind: 'insertImmutable', storeName: 'business', record: toStoredRecord('stale-event', 'behavior_event', {}) }],
    });
    await expect(adapter.commitPreview(staged.token, 'web-client', staleBatch)).rejects.toMatchObject({ code: 'ERR_PRIVACY_EPOCH_STALE' });
    expect(await adapter.getAll('business')).toHaveLength(0);
  });

  it('rejects a generic or undeclared mutation shape through the closed batch validator', async () => {
    const adapter = createAdapter();
    const invalid = makeBatch({
      idempotencyKey: 'bad-store-set', expectedCursor: '0', expectedPrivacyEpoch: 0,
      storeNames: [], mutations: [{ kind: 'insertImmutable', storeName: 'business', record: toStoredRecord('x', 'behavior_event', {}) }],
    });
    await expect(adapter.commit(invalid)).rejects.toBeInstanceOf(M1bError);
  });
});
