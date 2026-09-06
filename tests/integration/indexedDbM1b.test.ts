import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { CommitResponseLostError, M1bError } from '../../src/adapters/m1bTypes';
import { IndexedDbM1bAdapter, makeBatch, toStoredRecord } from '../../src/adapters/indexedDbM1b';
import { hashCanonical, sha256 } from '../../src/domain/canonical';

const adapters: IndexedDbM1bAdapter[] = [];

function createAdapter(): IndexedDbM1bAdapter {
  const adapter = new IndexedDbM1bAdapter();
  adapters.push(adapter);
  return adapter;
}

async function seedLegacyV2(databaseName: string, meta: Record<string, unknown>, system: unknown[] = [], journal: unknown[] = []): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      const business = db.objectStoreNames.contains('business') ? request.transaction!.objectStore('business') : db.createObjectStore('business', { keyPath: 'recordId' });
      if (!business.indexNames.contains('byDedupeKey')) business.createIndex('byDedupeKey', 'payload.dedupeKey', { unique: true });
      for (const name of ['system', 'heads', 'ledger', 'journal', 'audit', 'projection'] as const) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: name === 'projection' ? 'projectionId' : name === 'ledger' || name === 'journal' ? (name === 'ledger' ? 'idempotencyKey' : 'id') : 'recordId' });
      if (!db.objectStoreNames.contains('changes')) { const changes = db.createObjectStore('changes', { keyPath: 'id' }); changes.createIndex('byCursor', 'cursor', { unique: false }); }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['meta', 'system', 'journal'], 'readwrite');
    tx.objectStore('meta').put(meta);
    system.forEach((record) => tx.objectStore('system').put(record));
    journal.forEach((record) => tx.objectStore('journal').put(record));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  database.close();
}

function legacyMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'canonical', cursor: '0', privacyEpoch: 0, observationMode: 'ACTIVE', recoveryMode: 'NORMAL', schemaVersion: '1.0.0',
    logicalBytes: 0, recoveryBytes: 0, recoveryReserveBytes: 5 * 1024 * 1024, sizeEstimatorVersion: 'storage-size-v1',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.destroy()));
});

describe('IndexedDbM1bAdapter canonical transactions', () => {
  it('classifies a blocked schema upgrade within the configured deadline and retries after the holder closes', async () => {
    const databaseName = `blocked-open-${crypto.randomUUID()}`;
    await seedLegacyV2(databaseName, legacyMeta());
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const adapter = new IndexedDbM1bAdapter(databaseName, Date.now, 20);
    adapters.push(adapter);
    await expect(adapter.open()).rejects.toMatchObject({ code: 'ERR_STORAGE_BLOCKED' });
    holder.close();
    await adapter.open();
    expect(await adapter.getMeta()).toMatchObject({ schemaVersion: '1.0.0' });
  });

  it('creates the explicit M1b stores and initial meta', async () => {
    const adapter = createAdapter();
    await adapter.open();
    const contract = adapter.getRuntimeContract();
    expect(contract).toEqual({
      indexedDb: true,
      crossTabBrowserVerified: false,
      purgeCoverage: 'single-browser-in-process',
      broadcastChannelRequiredForCorrectness: false,
    });
    expect(Object.isFrozen(contract)).toBe(true);
    expect(() => { (contract as { crossTabBrowserVerified: boolean }).crossTabBrowserVerified = true; }).toThrow();
    expect(adapter.getRuntimeContract().crossTabBrowserVerified).toBe(false);
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
      inputHash: sha256('{"fixture":true}'),
      bytes: new TextEncoder().encode('{"fixture":true}'),
      privacyEpoch: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const record = toStoredRecord('event-preview', 'behavior_event', { sourceItemKey: 'preview' });
    const batch = makeBatch({
      idempotencyKey: 'preview-idem',
      expectedCursor: '0',
      expectedPrivacyEpoch: 0,
      requiresActiveObservation: true, requiresPreview: true,
      storeNames: ['business'],
      mutations: [{ kind: 'insertImmutable', storeName: 'business', record }],
    });
    await adapter.bindPreviewBatch(staged.token, batch.batchHash);
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
      inputHash: sha256(new TextDecoder().decode(new Uint8Array([1, 2, 3]))),
      bytes: new Uint8Array([1, 2, 3]),
      privacyEpoch: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    adapter.releasePreviewBuffer(staged.token);
    const batch = makeBatch({
      idempotencyKey: 'buffer-loss-idem', expectedCursor: '0', expectedPrivacyEpoch: 0, requiresActiveObservation: true, requiresPreview: true,
      storeNames: ['business'], mutations: [{ kind: 'insertImmutable', storeName: 'business', record: toStoredRecord('never', 'behavior_event', {}) }],
    });
    await adapter.bindPreviewBatch(staged.token, batch.batchHash);
    await expect(adapter.commitPreview(staged.token, 'web-client', batch)).rejects.toMatchObject({ code: 'ERR_PREVIEW_BUFFER_MISSING' });
    expect(await adapter.getRecord<{ state: string }>('system', staged.guard.recordId)).toMatchObject({ state: 'READY' });
    expect(await adapter.getAll('business')).toHaveLength(0);
  });

  it('keeps consumed preview tokens non-reusable after receipt retention', async () => {
    let now = Date.now();
    const adapter = new IndexedDbM1bAdapter(`preview-retention-${crypto.randomUUID()}`, () => now);
    adapters.push(adapter);
    const token = 'consumed-preview-token-with-stable-entropy';
    const bytes = new TextEncoder().encode('{"fixture":true}');
    const staged = await adapter.stagePreview({ token, callerId: 'web-client', idempotencyKey: 'retention-idem', inputHash: sha256(new TextDecoder().decode(bytes)), bytes, privacyEpoch: 0, expiresAt: new Date(now + 60_000).toISOString() });
    const batch = makeBatch({
      idempotencyKey: 'retention-idem', expectedCursor: '0', expectedPrivacyEpoch: 0, requiresActiveObservation: true, requiresPreview: true,
      storeNames: ['business'], mutations: [{ kind: 'insertImmutable', storeName: 'business', record: toStoredRecord('retention-event', 'behavior_event', { sourceItemKey: 'retention' }) }],
    });
    await adapter.bindPreviewBatch(staged.token, batch.batchHash);
    await adapter.commitPreview(token, 'web-client', batch);
    now += 10 * 60 * 1000 + 60_000;
    await expect(adapter.stagePreview({ token, callerId: 'web-client', idempotencyKey: 'retention-reuse', inputHash: sha256(new TextDecoder().decode(bytes)), bytes, privacyEpoch: 0, expiresAt: new Date(now + 60_000).toISOString() })).rejects.toMatchObject({ code: 'ERR_PREVIEW_CONSUMED' });
    const tombstones = await adapter.getAll<{ recordType: string; tokenHash: string }>('system');
    expect(tombstones).toEqual(expect.arrayContaining([expect.objectContaining({ recordType: 'preview_token_tombstone', tokenHash: sha256(token) })]));
  });

  it('retains response-loss token denial after preview receipt retention', async () => {
    let now = Date.now();
    const adapter = new IndexedDbM1bAdapter(`preview-loss-retention-${crypto.randomUUID()}`, () => now);
    adapters.push(adapter);
    const token = 'response-loss-preview-token-with-stable-entropy';
    const bytes = new TextEncoder().encode('response-loss');
    const staged = await adapter.stagePreview({ token, callerId: 'web-client', idempotencyKey: 'loss-retention-idem', inputHash: sha256('response-loss'), bytes, privacyEpoch: 0, expiresAt: new Date(now + 60_000).toISOString() });
    const batch = makeBatch({
      idempotencyKey: 'loss-retention-idem', expectedCursor: '0', expectedPrivacyEpoch: 0, requiresActiveObservation: true, requiresPreview: true,
      storeNames: ['business'], mutations: [{ kind: 'insertImmutable', storeName: 'business', record: toStoredRecord('loss-retention-event', 'behavior_event', { sourceItemKey: 'loss-retention' }) }],
    });
    await adapter.bindPreviewBatch(staged.token, batch.batchHash);
    await expect(adapter.commitPreview(token, 'web-client', batch, undefined, true)).rejects.toBeInstanceOf(CommitResponseLostError);
    now += 10 * 60 * 1000 + 60_000;
    await expect(adapter.stagePreview({ token, callerId: 'web-client', idempotencyKey: 'loss-retention-reuse', inputHash: sha256('response-loss'), bytes, privacyEpoch: 0, expiresAt: new Date(now + 60_000).toISOString() })).rejects.toMatchObject({ code: 'ERR_PREVIEW_CONSUMED' });
  });

  it('keeps ImportSession staging invisible until atomic publish', async () => {
    const adapter = createAdapter();
    const session = await adapter.createImportSession('stream-1', 'session-1');
    const event = toStoredRecord('event-staged', 'behavior_event', { sourceItemKey: 'staged' });
    await adapter.stageImportBatch('session-1', [event], hashCanonical([event]));
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
      inputHash: sha256('private'), bytes: new TextEncoder().encode('private'), privacyEpoch: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await adapter.setPrivacyMode('0', 0, 'PRIVATE', 'privacy-on');
    expect(await adapter.getMeta()).toMatchObject({ cursor: '1', privacyEpoch: 1, observationMode: 'PRIVATE' });
    expect(await adapter.getRecord('system', staged.guard.recordId)).toBeUndefined();

    const staleBatch = makeBatch({
      idempotencyKey: 'privacy-preview', expectedCursor: '0', expectedPrivacyEpoch: 0, requiresActiveObservation: true, requiresPreview: true,
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

  it('migrates v2 raw purge anchors and active controls to digest-only v3 records', async () => {
    const databaseName = `migration-${crypto.randomUUID()}`;
    const rawAnchor = `sha256:${'a'.repeat(64)}`;
    const rawWatermarkBase = {
      deletionId: 'legacy-deletion', generation: 'legacy-generation', cursor: '7', targetAnchors: [rawAnchor],
      journalHash: sha256('legacy-journal'), leaseGeneration: 1, verifiedAt: '2025-01-01T00:00:00.000Z',
    };
    const rawWatermark = { ...rawWatermarkBase, contentHash: hashCanonical(rawWatermarkBase) };
    const rawJournalBase = {
      id: 'legacy-journal', recordType: 'active_deletion_journal', state: 'FINALIZING', planId: 'legacy-plan', planHash: sha256('plan'),
      targetId: 'target', targetHash: sha256('target'), targetType: 'work_model_claim_v1', targetAnchors: [rawAnchor], baseCursor: '6', basePrivacyEpoch: 0,
      enumeration: { registryIndex: 0, pageOffset: 0, complete: true, enumeratedCount: 0 }, progress: { nextOrdinal: '0', completedCount: 0, totalCount: 0 },
      purge: { generation: 'legacy-generation', cutoff: '2025-01-01T00:00:00.000Z', requiredClientIds: [] }, finalizing: { complete: true, removedControlCount: 0 },
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    const rawJournal = { ...rawJournalBase, contentHash: hashCanonical(rawJournalBase) };
    const rawPlanBase = {
      recordId: 'legacy-plan', recordType: 'deletion_plan', writtenAt: '2025-01-01T00:00:00.000Z',
      target: { storeName: 'business', recordId: 'target', contentHash: sha256('target'), recordType: 'work_model_claim_v1', lineageAnchors: [rawAnchor] },
      cause: 'user-delete', baseCursor: '6', basePrivacyEpoch: 0, baseSnapshotHash: sha256('snapshot'), closureRulesHash: sha256('rules'),
    };
    const rawPlanWithPlanHash = { ...rawPlanBase, planHash: sha256('legacy-plan-hash') };
    const rawPlan = { ...rawPlanWithPlanHash, contentHash: hashCanonical(rawPlanWithPlanHash) };
    await seedLegacyV2(databaseName, legacyMeta({ cursor: '7', purgeWatermark: rawWatermark, lastPurgeCursor: '7' }), [rawPlan], [rawJournal]);
    const adapter = new IndexedDbM1bAdapter(databaseName);
    adapters.push(adapter);
    await adapter.open();

    const migratedMeta = await adapter.getMeta();
    expect(migratedMeta.recoveryMode).toBe('NORMAL');
    expect(migratedMeta.purgedAnchorDigests).toEqual([sha256(rawAnchor)]);
    expect(migratedMeta.purgedAnchorDigests).not.toContain(rawAnchor);
    expect(migratedMeta.purgeWatermark?.anchorDigests).toEqual([sha256(rawAnchor)]);
    const migratedJournal = await adapter.getRecord<{ targetAnchors: string[] }>('journal', 'legacy-journal');
    expect(migratedJournal?.targetAnchors).toEqual([sha256(rawAnchor)]);
    expect(migratedJournal?.targetAnchors).not.toContain(rawAnchor);
    const migratedPlan = await adapter.getRecord<{ target: { lineageAnchorDigests: string[]; lineageAnchors?: string[] } }>('system', 'legacy-plan');
    expect(migratedPlan?.target.lineageAnchorDigests).toEqual([sha256(rawAnchor)]);
    expect(migratedPlan?.target.lineageAnchors).toBeUndefined();
  });

  it('migrates unrecoverable v2 purge history to fail-closed recovery-only mode', async () => {
    const databaseName = `migration-loss-${crypto.randomUUID()}`;
    await seedLegacyV2(databaseName, legacyMeta({ cursor: '5', lastPurgeCursor: '4' }));
    const adapter = new IndexedDbM1bAdapter(databaseName);
    adapters.push(adapter);
    await adapter.open();
    expect(await adapter.getMeta()).toMatchObject({ recoveryMode: 'RECOVERY_ONLY', cursor: '5', lastPurgeCursor: '4' });
    const batch = makeBatch({
      idempotencyKey: 'blocked-after-history-loss', expectedCursor: '5', expectedPrivacyEpoch: 0,
      storeNames: [], mutations: [],
    });
    await expect(adapter.commit(batch)).rejects.toMatchObject({ code: 'ERR_RECOVERY_REQUIRED' });
  });
});
