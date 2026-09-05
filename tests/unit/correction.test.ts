import { describe, expect, it } from 'vitest';
import { InMemoryKnowledgePort } from '../../src/application/knowledge';
import { materializeBehaviorEvents, parseFixtureJson } from '../../src/domain/fixture';
import { runInsightLoop } from '../../src/domain/insightLoop';
import { fixtureJson } from '../fixtures/sample';

function proposedClaims() {
  const events = materializeBehaviorEvents(parseFixtureJson(fixtureJson()));
  return runInsightLoop(events, { asOf: '2026-01-02T10:06:00Z', timezone: 'UTC' }).claims;
}

describe('immutable correction and head CAS', () => {
  it('appends revisions and rejects a stale base without orphan writes', () => {
    const store = new InMemoryKnowledgePort();
    store.registerProposed(proposedClaims());
    const base = store.currentClaim('claim:test-after-change:alpha')!;
    const accepted = store.submitCorrection({
      commandId: 'command-accept', targetClaimKey: base.claimKey, baseRevisionId: base.id, action: 'accept',
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.claim?.revision).toBe(2);
    expect(accepted.claim?.status).toBe('confirmed');
    expect(Object.isFrozen(base)).toBe(true);

    const beforeStale = store.snapshot();
    const stale = store.submitCorrection({
      commandId: 'command-stale', targetClaimKey: base.claimKey, baseRevisionId: base.id,
      action: 'edit', statement: 'stale update',
    });
    expect(stale.ok).toBe(false);
    expect(stale.record.errorCode).toBe('ERR_REVISION_CONFLICT');
    expect(store.snapshot()).toEqual(beforeStale);
  });

  it('restores a live historical revision by creating a new head revision', () => {
    const store = new InMemoryKnowledgePort();
    store.registerProposed(proposedClaims());
    const base = store.currentClaim('claim:test-after-change:alpha')!;
    const edited = store.submitCorrection({
      commandId: 'command-edit', targetClaimKey: base.claimKey, baseRevisionId: base.id,
      action: 'edit', statement: '先运行 alpha 的定向测试',
    });
    const restored = store.submitCorrection({
      commandId: 'command-restore', targetClaimKey: base.claimKey, baseRevisionId: edited.claim!.id,
      action: 'restore', restoreFromRevisionId: base.id,
    });
    expect(restored.ok).toBe(true);
    expect(restored.claim?.revision).toBe(3);
    expect(restored.claim?.statement).toBe(base.statement);
    expect(store.snapshot().versions.map((version) => version.version)).toEqual([1, 2]);
  });
});
