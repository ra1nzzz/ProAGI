import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { hashCanonical, sha256 } from '../../src/domain/canonical';
import { IndexedDbM1bAdapter, makeBatch, toStoredRecord } from '../../src/adapters/indexedDbM1b';
import type { ActiveDeletionJournalRecord, RecoveryLeaseRecord, StoredRecord } from '../../src/adapters/m1bTypes';

const adapters: IndexedDbM1bAdapter[] = [];
const now = Date.parse('2025-01-01T00:00:00.000Z');
const noopRootHooks = { freeze: () => undefined, unfreeze: () => undefined };

function createAdapter(): IndexedDbM1bAdapter {
  const adapter = new IndexedDbM1bAdapter(undefined, () => now);
  adapters.push(adapter);
  return adapter;
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.destroy()));
});

async function seedTarget(adapter: IndexedDbM1bAdapter) {
  const target = toStoredRecord('claim-target', 'work_model_claim', { statement: 'synthetic', evidence: ['event-1'] }, new Date(now).toISOString());
  const head = toStoredRecord('head-target', 'knowledge_head', { knowledgeKey: 'k', claimRevisionId: target.recordId, claimHash: target.contentHash }, new Date(now).toISOString());
  await adapter.commit(makeBatch({
    idempotencyKey: 'seed-target', expectedCursor: '0', expectedPrivacyEpoch: 0, storeNames: ['business', 'heads'],
    mutations: [
      { kind: 'insertImmutable', storeName: 'business', record: target },
      { kind: 'casSingleton', storeName: 'heads', record: head, expectedContentHash: null },
    ],
  }));
  return target;
}

async function enumerateAll(adapter: IndexedDbM1bAdapter, journal: ActiveDeletionJournalRecord, lease: RecoveryLeaseRecord, at = now + 1) {
  let current = journal;
  while (current.state === 'FENCED') current = await adapter.enumerateDeletionPage(current.id, lease.ownerClientId, lease.fencingToken, 2, at);
  return current;
}

async function purgeFully(adapter: IndexedDbM1bAdapter, target: StoredRecord, owner: string, at: number): Promise<void> {
  const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
  const fenced = await adapter.fenceDeletion(plan, owner, at);
  let current = await enumerateAll(adapter, fenced.journal, fenced.lease, at + 1);
  while (current.state === 'DELETING') current = await adapter.deleteChunk(current.id, owner, fenced.lease.fencingToken, 500, at + 2);
  await adapter.sealAndAudit(current.id, owner, fenced.lease.fencingToken, at + 3);
  current = await adapter.finalizeDeletionPage(current.id, owner, fenced.lease.fencingToken, 500, at + 4);
  await adapter.verifyDeletion(current.id, owner, fenced.lease.fencingToken, at + 5);
}

async function mutateStoredRecord(adapter: IndexedDbM1bAdapter, storeName: string, key: string, mutate: (value: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(adapter.databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => store.put(mutate(request.result as Record<string, unknown>));
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'));
  });
  database.close();
}

describe('M1b deletion and recovery control plane', () => {
  it('rejects a stale T0 baseline with zero journal writes', async () => {
    const adapter = createAdapter();
    const target = await seedTarget(adapter);
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    await adapter.commit(makeBatch({
      idempotencyKey: 'race', expectedCursor: '1', expectedPrivacyEpoch: 0, storeNames: ['business'],
      mutations: [{ kind: 'insertImmutable', storeName: 'business', record: toStoredRecord('race-record', 'behavior_event', {}) }],
    }));
    await expect(adapter.fenceDeletion(plan, 'owner', now)).rejects.toMatchObject({ code: 'ERR_CURSOR_CONFLICT' });
    expect(await adapter.getAll('journal')).toEqual([]);
    expect(await adapter.getRecord('system', plan.recordId)).toBeUndefined();
    expect(await adapter.getMeta()).toMatchObject({ cursor: '2', recoveryMode: 'NORMAL' });
  });

  it('deletes every linked store root, finalizes in pages and leaves only unlinkable random receipts', async () => {
    const adapter = createAdapter();
    const target = await seedTarget(adapter);
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'owner', now);
    expect(fenced.journal.state).toBe('FENCED');
    expect(await adapter.getMeta()).toMatchObject({ recoveryMode: 'RECOVERY_ONLY' });
    expect((await adapter.getMeta()).recoveryBytes).toBeGreaterThan(0);

    const deleting = await enumerateAll(adapter, fenced.journal, fenced.lease);
    expect(deleting.state).toBe('DELETING');
    let current = deleting;
    while (current.state === 'DELETING') current = await adapter.deleteChunk(current.id, 'owner', fenced.lease.fencingToken, 1, now + 2);
    expect(current.state).toBe('PURGE_PENDING');

    const audit = await adapter.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 3);
    expect(audit).toMatchObject({ outcome: 'CLEAN', reachableCount: 0, registryComplete: true, coverage: 'single-browser-in-process', registryRevision: 1, journalHash: expect.any(String), leaseGeneration: fenced.lease.generation, leaseFencingTokenHash: expect.any(String) });
    const finalizing = await adapter.finalizeDeletionPage(current.id, 'owner', fenced.lease.fencingToken, 1, now + 4);
    expect(finalizing).toMatchObject({ state: 'FINALIZING', finalizing: { complete: true } });
    await expect(adapter.verifyDeletion(current.id, 'owner', fenced.lease.fencingToken, now + 5, true)).rejects.toMatchObject({ code: 'ERR_TEST_RESPONSE_LOST' });
    const verified = await adapter.verifyDeletion(current.id, 'owner', 'stale-after-commit', now + 6);
    await expect(adapter.verifyDeletion(current.id, 'owner', 'different-retry-token', now + 7)).resolves.toEqual(verified);
    const verificationReceipt = (await adapter.getAll('system')).find((record) => (record as { recordType?: string }).recordType === 'deletion_verification_receipt') as { registryRevision: number; auditHash: string; journalHash: string; leaseGeneration: number; leaseFencingTokenHash: string };
    expect(verificationReceipt).toMatchObject({ registryRevision: 1, auditHash: expect.any(String), journalHash: finalizing.contentHash, leaseGeneration: fenced.lease.generation, leaseFencingTokenHash: expect.any(String) });
    expect(verified.verifiedId).not.toContain(target.recordId);
    expect(verified.tombstoneId).not.toContain(target.recordId);
    expect(await adapter.getMeta()).toMatchObject({ recoveryMode: 'NORMAL', recoveryBytes: 0 });

    for (const store of ['business', 'system', 'heads', 'ledger', 'journal', 'audit', 'projection', 'changes'] as const) {
      const serialized = JSON.stringify(await adapter.getAll(store));
      expect(serialized).not.toContain(target.recordId);
      expect(serialized).not.toContain(target.contentHash);
    }
  });

  it('serializes concurrent same-token delete chunks without double-counting work', async () => {
    const adapter = createAdapter();
    const target = await seedTarget(adapter);
    const linkedRecords = Array.from({ length: 8 }, (_, index) => toStoredRecord(`linked-${index}`, 'behavior_event', { target: target.recordId, index }, new Date(now).toISOString()));
    await adapter.commit(makeBatch({
      idempotencyKey: 'linked-events', expectedCursor: '1', expectedPrivacyEpoch: 0, storeNames: ['business'],
      mutations: linkedRecords.map((record) => ({ kind: 'insertImmutable' as const, storeName: 'business' as const, record })),
    }));
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'same-owner', now);
    const deleting = await enumerateAll(adapter, fenced.journal, fenced.lease, now + 1);
    const [first, second] = await Promise.all([
      adapter.deleteChunk(deleting.id, 'same-owner', fenced.lease.fencingToken, 2, now + 2),
      adapter.deleteChunk(deleting.id, 'same-owner', fenced.lease.fencingToken, 2, now + 2),
    ]);
    let current = first.progress.completedCount >= second.progress.completedCount ? first : second;
    while (current.state === 'DELETING') current = await adapter.deleteChunk(current.id, 'same-owner', fenced.lease.fencingToken, 2, now + 3);
    expect(current.state).toBe('PURGE_PENDING');
    expect(current.progress.completedCount).toBe(current.progress.totalCount);
  });

  it('keeps a permanent deny digest after more than 32 purge watermarks and restart', async () => {
    const databaseName = 'permanent-purge-index-test';
    const adapter = new IndexedDbM1bAdapter(databaseName, () => now);
    adapters.push(adapter);
    let firstTarget: StoredRecord | undefined;
    for (let index = 0; index < 33; index += 1) {
      const meta = await adapter.getMeta();
      const target = toStoredRecord(`claim-target-${index}`, 'work_model_claim', { statement: `synthetic-${index}` }, new Date(now + index).toISOString());
      if (!firstTarget) firstTarget = target;
      await adapter.commit(makeBatch({
        idempotencyKey: `seed-target-${index}`, expectedCursor: meta.cursor, expectedPrivacyEpoch: meta.privacyEpoch, storeNames: ['business'],
        mutations: [{ kind: 'insertImmutable', storeName: 'business', record: target }],
      }));
      await purgeFully(adapter, target, `owner-${index}`, now + index * 10);
    }
    adapter.close();
    const restarted = new IndexedDbM1bAdapter(databaseName, () => now + 400);
    adapters.push(restarted);
    const meta = await restarted.getMeta();
    const resurrection = toStoredRecord(firstTarget!.recordId, firstTarget!.recordType, { statement: 'resurrection-after-history-eviction' }, new Date(now + 500).toISOString());
    await expect(restarted.commit(makeBatch({
      idempotencyKey: 'post-33-resurrection', expectedCursor: meta.cursor, expectedPrivacyEpoch: meta.privacyEpoch, storeNames: ['business'],
      mutations: [{ kind: 'insertImmutable', storeName: 'business', record: resurrection }],
    }))).rejects.toMatchObject({ code: 'ERR_PURGED_REFERENCE' });
  }, 20_000);

  it('uses bounded cursor continuation for large deletion enumeration pages', async () => {
    const adapter = createAdapter();
    const target = await seedTarget(adapter);
    const linked = Array.from({ length: 150 }, (_, index) => toStoredRecord(`linked-${String(index).padStart(3, '0')}`, 'behavior_event', { linkedRecordId: target.recordId }));
    await adapter.commit(makeBatch({
      idempotencyKey: 'seed-large-linked-set', expectedCursor: '1', expectedPrivacyEpoch: 0, storeNames: ['business'],
      mutations: linked.map((record) => ({ kind: 'insertImmutable' as const, storeName: 'business' as const, record })),
    }));
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'owner', now);
    const first = await adapter.enumerateDeletionPage(fenced.journal.id, fenced.lease.ownerClientId, fenced.lease.fencingToken, 2, now + 1);
    const second = await adapter.enumerateDeletionPage(first.id, fenced.lease.ownerClientId, fenced.lease.fencingToken, 2, now + 1);
    expect(second.enumeration.continuationKey).toBeDefined();
    const deleting = await enumerateAll(adapter, second, fenced.lease, now + 1);
    expect(deleting.state).toBe('DELETING');
    const workItems = (await adapter.getAll('journal')).filter((record) => (record as { id?: string }).id?.startsWith(`work:${fenced.journal.id}:`) === true);
    // business target + links, plus the linked head/ledger/change control records.
    expect(workItems).toHaveLength(linked.length + 4);
    expect(new Set(workItems.map((record) => (record as { id?: string }).id)).size).toBe(workItems.length);
  });

  it('fails closed when core metadata fields are malformed', async () => {
    const adapter = createAdapter();
    const baseline = await adapter.getMeta();
    const cases: Record<string, unknown>[] = [
      { cursor: 'not-a-cursor' },
      { privacyEpoch: -1 },
      { observationMode: 'BROKEN' },
      { recoveryMode: 'BROKEN' },
      { schemaVersion: '0.0.0' },
      { logicalBytes: -1 },
      { recoveryBytes: 5_242_881 },
      { recoveryReserveBytes: 1 },
    ];
    for (const patch of cases) {
      await mutateStoredRecord(adapter, 'meta', 'canonical', (value) => ({ ...value, ...patch }));
      await expect(adapter.getMeta()).rejects.toMatchObject({ code: expect.stringMatching(/^ERR_(STORAGE_CORRUPT|PURGE_WATERMARK_INVALID)$/) });
      await mutateStoredRecord(adapter, 'meta', 'canonical', () => ({ ...baseline }));
    }
  });

  it('rejects a post-verify resurrection that reuses a purged anchor', async () => {
    const adapter = createAdapter();
    const target = await seedTarget(adapter);
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'owner', now);
    let current = await enumerateAll(adapter, fenced.journal, fenced.lease);
    while (current.state === 'DELETING') current = await adapter.deleteChunk(current.id, 'owner', fenced.lease.fencingToken, 500, now + 1);
    await adapter.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 2);
    current = await adapter.finalizeDeletionPage(current.id, 'owner', fenced.lease.fencingToken, 500, now + 3);
    await adapter.verifyDeletion(current.id, 'owner', fenced.lease.fencingToken, now + 4);
    const meta = await adapter.getMeta();
    const resurrection = toStoredRecord(target.recordId, target.recordType, { statement: 'resurrection' }, new Date(now + 5).toISOString());
    await expect(adapter.commit(makeBatch({
      idempotencyKey: 'post-purge-resurrection', expectedCursor: meta.cursor, expectedPrivacyEpoch: meta.privacyEpoch, storeNames: ['business'],
      mutations: [{ kind: 'insertImmutable', storeName: 'business', record: resurrection }],
    }))).rejects.toMatchObject({ code: 'ERR_PURGED_REFERENCE' });
    expect(await adapter.getRecord('business', target.recordId)).toBeUndefined();
    const watermark = (meta.purgeWatermarks ?? [])[0] as unknown as Record<string, unknown> | undefined;
    expect(watermark?.targetAnchors).toBeUndefined();
    expect(JSON.stringify(meta)).not.toContain(target.recordId);
    expect(JSON.stringify(meta)).not.toContain(target.contentHash);
  });

  it('rejects a forged terminal receipt and its companion state', async () => {
    const adapter = createAdapter();
    const target = await seedTarget(adapter);
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'owner', now);
    let current = await enumerateAll(adapter, fenced.journal, fenced.lease);
    while (current.state === 'DELETING') current = await adapter.deleteChunk(current.id, 'owner', fenced.lease.fencingToken, 500, now + 1);
    await adapter.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 2);
    current = await adapter.finalizeDeletionPage(current.id, 'owner', fenced.lease.fencingToken, 500, now + 3);
    const verified = await adapter.verifyDeletion(current.id, 'owner', fenced.lease.fencingToken, now + 4);
    await mutateStoredRecord(adapter, 'system', `verification:${sha256(current.id)}`, (value) => ({ ...value, auditHash: 'sha256:forged' }));
    await expect(adapter.verifyDeletion(current.id, 'owner', 'stale', now + 5)).rejects.toMatchObject({ code: 'ERR_VERIFY_RECEIPT_INVALID' });
    expect(verified.verifiedId).toBeDefined();
  });

  it('keeps a registered client ACK through finalization and removes it in the final Tv', async () => {
    const adapter = createAdapter();
    await adapter.registerClient('registered-client', now);
    const target = await seedTarget(adapter);
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'owner', now);
    let current = await enumerateAll(adapter, fenced.journal, fenced.lease);
    while (current.state === 'DELETING') current = await adapter.deleteChunk(current.id, 'owner', fenced.lease.fencingToken, 500, now + 1);
    await adapter.acknowledgePurge(current.id, current.purge.generation, 'registered-client', now + 2);
    const audit = await adapter.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 3);
    expect(audit).toMatchObject({ outcome: 'CLEAN', allRequiredClientsPurged: true });
    const finalizing = await adapter.finalizeDeletionPage(current.id, 'owner', fenced.lease.fencingToken, 500, now + 4);
    expect(finalizing.finalizing.complete).toBe(true);
    expect((await adapter.getAll('system')).some((record) => (record as { recordType?: string }).recordType === 'purge_ack')).toBe(true);
    await adapter.verifyDeletion(current.id, 'owner', fenced.lease.fencingToken, now + 5);
    expect((await adapter.getAll('system')).some((record) => (record as { recordType?: string }).recordType === 'purge_ack')).toBe(false);
  });

  it('shares the root coordinator across adapters for one database', async () => {
    const first = new IndexedDbM1bAdapter('shared-root-coordinator-test', () => now);
    const second = new IndexedDbM1bAdapter('shared-root-coordinator-test', () => now);
    adapters.push(first, second);
    const target = await seedTarget(first);
    const heapRoot: unknown[] = [{ selectedId: target.recordId }];
    const dispose = second.registerInProcessRoot('second-adapter.heap', () => heapRoot, noopRootHooks);
    const plan = await first.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await first.fenceDeletion(plan, 'owner', now);
    let current = await enumerateAll(first, fenced.journal, fenced.lease);
    while (current.state === 'DELETING') current = await first.deleteChunk(current.id, 'owner', fenced.lease.fencingToken, 500, now + 1);
    const result = await first.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 2);
    expect(result.outcome).toBe('REACHABLE');
    expect(result.receipts.find((receipt) => receipt.rootId === 'second-adapter.heap')).toMatchObject({ forbiddenReferenceCount: 1 });
    dispose();
    const third = new IndexedDbM1bAdapter('shared-root-coordinator-test', () => now);
    adapters.push(third);
    const readded = first.registerInProcessRoot('readded-after-gap', () => heapRoot, noopRootHooks);
    const lateAudit = await third.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 3);
    expect(lateAudit.receipts.find((receipt) => receipt.rootId === 'readded-after-gap')).toMatchObject({ forbiddenReferenceCount: 1 });
    readded();
  });

  it('holds a root quiescence barrier across final verification', async () => {
    const adapter = createAdapter();
    const target = await seedTarget(adapter);
    let armed = false;
    let blocked = false;
    let attempted = false;
    let freezeMutationError: string | undefined;
    const freezeProbeDispose = adapter.registerInProcessRoot('freeze-probe', () => [], {
      freeze: () => { try { adapter.beginInProcessRootMutation(); } catch (error) { freezeMutationError = (error as { code?: string }).code; } },
      unfreeze: () => undefined,
    });
    const dispose = adapter.registerInProcessRoot('quiescence-root', () => {
      if (armed && !attempted) {
        attempted = true;
        try {
          adapter.registerInProcessRoot('late-root', () => [{ selectedId: target.recordId }], noopRootHooks);
        } catch (error) {
          blocked = (error as { code?: string }).code === 'ERR_PURGE_QUIESCED';
        }
      }
      return [];
    }, noopRootHooks);
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'owner', now);
    let current = await enumerateAll(adapter, fenced.journal, fenced.lease);
    while (current.state === 'DELETING') current = await adapter.deleteChunk(current.id, 'owner', fenced.lease.fencingToken, 500, now + 1);
    await adapter.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 2);
    const finalizing = await adapter.finalizeDeletionPage(current.id, 'owner', fenced.lease.fencingToken, 500, now + 3);
    armed = true;
    const releaseMutation = adapter.beginInProcessRootMutation();
    const waitingVerification = adapter.verifyDeletion(current.id, 'owner', fenced.lease.fencingToken, now + 4);
    await Promise.resolve();
    releaseMutation();
    await expect(waitingVerification).resolves.toHaveProperty('verifiedId');
    expect(blocked).toBe(true);
    expect(freezeMutationError).toBe('ERR_PURGE_QUIESCED');
    dispose();
    freezeProbeDispose();
    expect(finalizing.finalizing.complete).toBe(true);
  });

  it('keeps a writer queued behind the atomic final verification transaction', async () => {
    const first = new IndexedDbM1bAdapter('atomic-verify-writer-test', () => now);
    const second = new IndexedDbM1bAdapter('atomic-verify-writer-test', () => now);
    adapters.push(first, second);
    const target = await seedTarget(first);
    const plan = await first.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await first.fenceDeletion(plan, 'owner', now);
    let current = await enumerateAll(first, fenced.journal, fenced.lease);
    while (current.state === 'DELETING') current = await first.deleteChunk(current.id, 'owner', fenced.lease.fencingToken, 500, now + 1);
    await first.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 2);
    await first.finalizeDeletionPage(current.id, 'owner', fenced.lease.fencingToken, 500, now + 3);
    const finalMeta = await first.getMeta();
    const writerBatch = makeBatch({
      idempotencyKey: 'queued-during-verify', expectedCursor: finalMeta.cursor, expectedPrivacyEpoch: finalMeta.privacyEpoch, storeNames: ['business'],
      mutations: [{ kind: 'insertImmutable' as const, storeName: 'business' as const, record: toStoredRecord('queued-writer-record', 'queued-writer', {}) }],
    });
    let armed = false;
    let writerPromise: Promise<unknown> | null = null;
    let writerError: unknown;
    const dispose = second.registerInProcessRoot('queued-writer-root', () => {
      if (armed && !writerPromise) writerPromise = second.commit(writerBatch).catch((error) => { writerError = error; });
      return [];
    }, noopRootHooks);
    armed = true;
    await expect(first.verifyDeletion(current.id, 'owner', fenced.lease.fencingToken, now + 4)).resolves.toHaveProperty('verifiedId');
    expect(writerPromise).not.toBeNull();
    await writerPromise;
    expect(writerError).toMatchObject({ code: 'ERR_PURGE_QUIESCED' });
    expect(await second.getRecord('business', 'queued-writer-record')).toBeUndefined();
    dispose();
  });

  it('fails closed when final verification sees a noncanonical journal or lease', async () => {
    const adapter = createAdapter();
    const target = await seedTarget(adapter);
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'owner', now);
    let current = await enumerateAll(adapter, fenced.journal, fenced.lease);
    while (current.state === 'DELETING') current = await adapter.deleteChunk(current.id, 'owner', fenced.lease.fencingToken, 500, now + 1);
    await adapter.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 2);
    await adapter.finalizeDeletionPage(current.id, 'owner', fenced.lease.fencingToken, 500, now + 3);

    await mutateStoredRecord(adapter, 'journal', current.id, (value) => ({ ...value, contentHash: 'sha256:tampered' }));
    await expect(adapter.verifyDeletion(current.id, 'owner', fenced.lease.fencingToken, now + 4)).rejects.toMatchObject({ code: 'ERR_JOURNAL_HASH_INVALID' });
    expect((await adapter.getRecord<ActiveDeletionJournalRecord>('journal', current.id))?.state).toBe('FINALIZING');

    await mutateStoredRecord(adapter, 'journal', current.id, (value) => {
      const base = { ...value };
      delete base.contentHash;
      return { ...base, contentHash: hashCanonical(base) };
    });
    await mutateStoredRecord(adapter, 'system', 'recovery-lease', (value) => ({ ...value, contentHash: 'sha256:tampered' }));
    await expect(adapter.verifyDeletion(current.id, 'owner', fenced.lease.fencingToken, now + 5)).rejects.toMatchObject({ code: 'ERR_RECOVERY_LEASE_HASH_INVALID' });
    expect((await adapter.getRecord<ActiveDeletionJournalRecord>('journal', current.id))?.state).toBe('FINALIZING');
  });

  it('fences stale recovery owners after expiry and lease steal', async () => {
    const adapter = createAdapter();
    const target = await seedTarget(adapter);
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const { journal, lease } = await adapter.fenceDeletion(plan, 'owner-a', now);
    const stolen = await adapter.stealRecoveryLease('owner-b', now + 7_000);
    expect(stolen.generation).toBe(lease.generation + 1);
    expect(stolen.fencingToken).not.toBe(lease.fencingToken);
    await expect(adapter.enumerateDeletionPage(journal.id, 'owner-a', lease.fencingToken, 10, now + 7_001)).rejects.toMatchObject({ code: 'ERR_RECOVERY_LEASE_LOST' });
    await expect(adapter.enumerateDeletionPage(journal.id, 'owner-b', stolen.fencingToken, 10, now + 7_001)).resolves.toBeDefined();
  });

  it('rejects heartbeat renewal after a client begins closing', async () => {
    const adapter = createAdapter();
    await adapter.registerClient('closing-client', now);
    await adapter.closeClient('closing-client', now + 1);
    await expect(adapter.renewClient('closing-client', now + 2)).rejects.toMatchObject({ code: 'ERR_CLIENT_CLOSING' });
  });

  it('keeps a resumed client quarantined until the sealed journal is verified', async () => {
    const adapter = createAdapter();
    const target = await seedTarget(adapter);
    await adapter.registerClient('resumed', now);
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'owner', now);
    let current = await enumerateAll(adapter, fenced.journal, fenced.lease);
    while (current.state === 'DELETING') current = await adapter.deleteChunk(current.id, 'owner', fenced.lease.fencingToken, 500, now + 1);
    await adapter.acknowledgePurge(current.id, current.purge.generation, 'resumed', now + 2);
    await adapter.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 3);
    expect((await adapter.renewClient('resumed', now + 4)).state).toBe('QUARANTINED');
  });

  it('renews an expired client into the active purge membership atomically', async () => {
    const adapter = createAdapter();
    await adapter.registerClient('client-a', now);
    const target = await seedTarget(adapter);
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'owner', now + 1);
    const renewed = await adapter.renewClient('client-a', now + 7_000);
    expect(renewed.state).toBe('QUARANTINED');
    const current = await adapter.getRecord<ActiveDeletionJournalRecord>('journal', fenced.journal.id);
    expect(current?.purge.requiredClientIds).toContain('client-a');
  });

  it('does not evict a frozen quarantined client on lease expiry alone', async () => {
    const adapter = createAdapter();
    await adapter.registerClient('frozen-client', now);
    const target = await seedTarget(adapter);
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'owner-a', now);
    let current = await enumerateAll(adapter, fenced.journal, fenced.lease);
    while (current.state === 'DELETING') current = await adapter.deleteChunk(current.id, 'owner-a', fenced.lease.fencingToken, 500, now + 1);
    const pending = await adapter.sealAndAudit(current.id, 'owner-a', fenced.lease.fencingToken, now + 2);
    expect(pending.outcome).toBe('CLIENTS_PENDING');
    const takeover = await adapter.stealRecoveryLease('owner-b', now + 7_000);
    const retried = await adapter.retryPurge(current.id, 'owner-b', takeover.fencingToken, [], now + 7_000);
    expect(retried.purge.requiredClientIds).toContain('frozen-client');
  });

  it('quarantines late clients and invalidates old ACKs after retryPurge', async () => {
    const adapter = createAdapter();
    await adapter.registerClient('client-a', now - 1);
    const target = await seedTarget(adapter);
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'owner', now);
    let current = await enumerateAll(adapter, fenced.journal, fenced.lease);
    while (current.state === 'DELETING') current = await adapter.deleteChunk(current.id, 'owner', fenced.lease.fencingToken, 500, now + 1);
    const late = await adapter.registerClient('client-b', now + 2);
    expect(late).toMatchObject({ state: 'QUARANTINED', purgeGeneration: current.purge.generation });
    await adapter.acknowledgePurge(current.id, current.purge.generation, 'client-a', now + 3);
    expect((await adapter.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 4)).outcome).toBe('CLIENTS_PENDING');

    const retried = await adapter.retryPurge(current.id, 'owner', fenced.lease.fencingToken, ['client-a'], now + 5);
    expect(retried.purge.generation).not.toBe(current.purge.generation);
    expect(retried.purge.requiredClientIds).toEqual(['client-a', 'client-b']);
    await expect(adapter.acknowledgePurge(current.id, current.purge.generation, 'client-b', now + 6)).rejects.toMatchObject({ code: 'ERR_PURGE_GENERATION_STALE' });
  });

  it('audits every registered in-process root and blocks finalization until its target reference is purged', async () => {
    const adapter = createAdapter();
    const target = await seedTarget(adapter);
    const heapRoot: unknown[] = [{ selectedId: target.recordId }];
    const unregister = adapter.registerInProcessRoot('client.heap', () => heapRoot, noopRootHooks);
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'owner', now);
    let current = await enumerateAll(adapter, fenced.journal, fenced.lease);
    while (current.state === 'DELETING') current = await adapter.deleteChunk(current.id, 'owner', fenced.lease.fencingToken, 500, now + 1);

    const reachable = await adapter.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 2);
    expect(reachable.outcome).toBe('REACHABLE');
    expect(reachable.receipts.find((receipt) => receipt.rootId === 'client.heap')).toMatchObject({ forbiddenReferenceCount: 1 });

    heapRoot.length = 0;
    const clean = await adapter.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 3);
    expect(clean).toMatchObject({ outcome: 'CLEAN', reachableCount: 0, registryComplete: true });
    unregister();
  });

  it('rejects same-key root replacement during audit as an ABA mutation', async () => {
    const adapter = createAdapter();
    const target = await seedTarget(adapter);
    let replaced = false;
    const dispose = adapter.registerInProcessRoot('aba-root', () => {
      if (!replaced) {
        replaced = true;
        dispose?.();
        adapter.registerInProcessRoot('aba-root', () => [{ selectedId: target.recordId }], noopRootHooks);
      }
      return [];
    }, noopRootHooks);
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'owner', now);
    let current = await enumerateAll(adapter, fenced.journal, fenced.lease);
    while (current.state === 'DELETING') current = await adapter.deleteChunk(current.id, 'owner', fenced.lease.fencingToken, 500, now + 1);
    const result = await adapter.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 2);
    expect(result.outcome).toBe('REGISTRY_INCOMPLETE');
  });

  it('never seals clean when the in-process root registry changes during audit', async () => {
    const adapter = createAdapter();
    const target = await seedTarget(adapter);
    let registered = false;
    adapter.registerInProcessRoot('dynamic-root-trigger', () => {
      if (!registered) {
        registered = true;
        adapter.registerInProcessRoot('late-root', () => [{ selectedId: target.recordId }], noopRootHooks);
      }
      return [];
    }, noopRootHooks);
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'owner', now);
    let current = await enumerateAll(adapter, fenced.journal, fenced.lease);
    while (current.state === 'DELETING') current = await adapter.deleteChunk(current.id, 'owner', fenced.lease.fencingToken, 500, now + 1);
    const result = await adapter.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 2);
    expect(result.outcome).toBe('REGISTRY_INCOMPLETE');
    expect(result.registryComplete).toBe(false);
    expect(result.registryRevision).toBeDefined();
  });

  it('keeps the clear fence until a timed-out delete request settles', async () => {
    const databaseName = `proagi-clear-pending-${crypto.randomUUID()}`;
    const adapter = new IndexedDbM1bAdapter(databaseName, () => now);
    adapters.push(adapter);
    await adapter.open();
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 4);
      request.onerror = () => reject(request.error ?? new Error('raw blocker failed'));
      request.onsuccess = () => resolve(request.result);
    });
    blocker.onversionchange = () => undefined;
    const clearPromise = adapter.clearAll({ cachesCleared: true, deleteTimeoutMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(adapter.getMeta()).rejects.toMatchObject({ code: 'ERR_STORAGE_BLOCKED' });
    const result = await clearPromise;
    expect(result).toMatchObject({ state: 'BLOCKED', databaseDeleted: false, pendingDeletion: true });
    blocker.close();
    let reopened: Awaited<ReturnType<typeof adapter.getMeta>> | undefined;
    for (let attempt = 0; attempt < 20 && !reopened; attempt += 1) {
      try { reopened = await adapter.getMeta(); } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
    }
    expect(reopened).toMatchObject({ cursor: '0' });
    await expect(adapter.getAll('business')).resolves.toEqual([]);
  });

  it('times out a stuck quiescence drain without releasing the fence early', async () => {
    const adapter = createAdapter();
    const releaseMutation = adapter.beginInProcessRootMutation();
    await expect(adapter.clearAll({ cachesCleared: true, simulateBlocked: true, quiescenceTimeoutMs: 10 })).rejects.toMatchObject({ code: 'ERR_PURGE_QUIESCENCE_TIMEOUT' });
    releaseMutation();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(adapter.clearAll({ cachesCleared: true, simulateBlocked: true })).resolves.toMatchObject({ state: 'BLOCKED' });
  });

  it('drains deferred adapters when root freezing fails', async () => {
    const databaseName = `proagi-freeze-failure-${crypto.randomUUID()}`;
    const owner = new IndexedDbM1bAdapter(databaseName, () => now);
    const sibling = new IndexedDbM1bAdapter(databaseName, () => now);
    adapters.push(owner, sibling);
    let throwOnFreeze = true;
    let siblingFreezeCount = 0;
    owner.registerInProcessRoot('owner-root', () => [], {
      freeze: () => sibling.dispose(),
      unfreeze: () => undefined,
    });
    owner.registerInProcessRoot('failing-root', () => [], {
      freeze: () => { if (throwOnFreeze) throw new Error('synthetic freeze failure'); },
      unfreeze: () => undefined,
    });
    sibling.registerInProcessRoot('sibling-root', () => [], {
      freeze: () => { siblingFreezeCount += 1; },
      unfreeze: () => undefined,
    });
    await expect(owner.clearAll({ cachesCleared: true, simulateBlocked: true })).rejects.toThrow('synthetic freeze failure');
    expect(siblingFreezeCount).toBe(0);
    throwOnFreeze = false;
    await expect(owner.clearAll({ cachesCleared: true, simulateBlocked: true })).resolves.toMatchObject({ state: 'BLOCKED' });
    expect(siblingFreezeCount).toBe(0);
  });

  it('reports clear blocking honestly and keeps CLEAR_ONLY', async () => {
    const adapter = createAdapter();
    const result = await adapter.clearAll({ simulateBlocked: true, cachesCleared: true });
    expect(result).toEqual({
      state: 'BLOCKED', databaseDeleted: false, cachesCleared: true, emptyReopenVerified: false,
      errorCode: 'ERR_STORAGE_BLOCKED', coverage: 'single-browser-in-process',
    });
    expect(await adapter.getMeta()).toMatchObject({ recoveryMode: 'CLEAR_ONLY' });
  });
});
