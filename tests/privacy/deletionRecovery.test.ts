import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDbM1bAdapter, makeBatch, toStoredRecord } from '../../src/adapters/indexedDbM1b';
import type { ActiveDeletionJournalRecord, RecoveryLeaseRecord } from '../../src/adapters/m1bTypes';

const adapters: IndexedDbM1bAdapter[] = [];
const now = Date.parse('2025-01-01T00:00:00.000Z');

function createAdapter(): IndexedDbM1bAdapter {
  const adapter = new IndexedDbM1bAdapter();
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

async function enumerateAll(adapter: IndexedDbM1bAdapter, journal: ActiveDeletionJournalRecord, lease: RecoveryLeaseRecord) {
  let current = journal;
  while (current.state === 'FENCED') current = await adapter.enumerateDeletionPage(current.id, lease.ownerClientId, lease.fencingToken, 2, now + 1);
  return current;
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
    expect(audit).toMatchObject({ outcome: 'CLEAN', reachableCount: 0, registryComplete: true, coverage: 'single-browser-in-process' });
    const finalizing = await adapter.finalizeDeletionPage(current.id, 'owner', fenced.lease.fencingToken, 1, now + 4);
    expect(finalizing).toMatchObject({ state: 'FINALIZING', finalizing: { complete: true } });
    const verified = await adapter.verifyDeletion(current.id, 'owner', fenced.lease.fencingToken, now + 5);
    expect(verified.verifiedId).not.toContain(target.recordId);
    expect(verified.tombstoneId).not.toContain(target.recordId);
    expect(await adapter.getMeta()).toMatchObject({ recoveryMode: 'NORMAL', recoveryBytes: 0 });

    for (const store of ['business', 'system', 'heads', 'ledger', 'journal', 'audit', 'projection', 'changes'] as const) {
      const serialized = JSON.stringify(await adapter.getAll(store));
      expect(serialized).not.toContain(target.recordId);
      expect(serialized).not.toContain(target.contentHash);
    }
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
    await expect(adapter.acknowledgePurge(current.id, current.purge.generation, 'client-b', now + 6)).rejects.toMatchObject({ code: 'ERR_PURGE_GENERATION_STALE' });
  });

  it('audits every registered in-process root and blocks finalization until its target reference is purged', async () => {
    const adapter = createAdapter();
    const target = await seedTarget(adapter);
    const heapRoot: unknown[] = [{ selectedId: target.recordId }];
    const unregister = adapter.registerInProcessRoot('client.heap', () => heapRoot);
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

  it('never seals clean when the in-process root registry changes during audit', async () => {
    const adapter = createAdapter();
    const target = await seedTarget(adapter);
    let registered = false;
    adapter.registerInProcessRoot('dynamic-root-trigger', () => {
      if (!registered) {
        registered = true;
        adapter.registerInProcessRoot('late-root', () => [{ selectedId: target.recordId }]);
      }
      return [];
    });
    const plan = await adapter.planDeletion({ storeName: 'business', recordId: target.recordId, contentHash: target.contentHash, recordType: target.recordType });
    const fenced = await adapter.fenceDeletion(plan, 'owner', now);
    let current = await enumerateAll(adapter, fenced.journal, fenced.lease);
    while (current.state === 'DELETING') current = await adapter.deleteChunk(current.id, 'owner', fenced.lease.fencingToken, 500, now + 1);
    const result = await adapter.sealAndAudit(current.id, 'owner', fenced.lease.fencingToken, now + 2);
    expect(result.outcome).toBe('REGISTRY_INCOMPLETE');
    expect(result.registryComplete).toBe(false);
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
