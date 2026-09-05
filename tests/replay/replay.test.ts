import { describe, expect, it } from 'vitest';
import { InMemoryKnowledgePort } from '../../src/application/knowledge';
import { materializeBehaviorEvents, parseFixtureJson } from '../../src/domain/fixture';
import { runInsightLoop } from '../../src/domain/insightLoop';
import { replayV1, type ReplayInputV1 } from '../../src/domain/replay';
import type { BehaviorEvent } from '../../src/domain/types';
import { baseFixture, fixtureJson } from '../fixtures/sample';

const ZERO_HASH = `sha256:${'0'.repeat(64)}` as const;

function events(input = fixtureJson()): readonly BehaviorEvent[] {
  return materializeBehaviorEvents(parseFixtureJson(input));
}

function replayInput(inputEvents: readonly BehaviorEvent[], store = new InMemoryKnowledgePort()): ReplayInputV1 {
  return {
    replayInputVersion: '1', events: inputEvents, knowledge: store.snapshot(),
    asOf: '2026-01-02T10:06:00Z', timezone: 'UTC', locale: 'zh-CN', clockSeed: ZERO_HASH,
    pins: { schema: '1.0.0', segmentation: 'segment-v1', inference: 'insight-v1', canonicalization: 'canonical-json-v1' },
  };
}

describe('ReplayV1 determinism', () => {
  it('does not infer test-after-change when the causal event order is reversed', () => {
    const reversed = events().map((event) => event.kind === 'file.changed'
      ? { ...event, occurredAt: '2026-01-02T10:07:00Z' }
      : event.kind === 'test.completed'
        ? { ...event, occurredAt: '2026-01-02T10:06:00Z' }
        : event);
    expect(runInsightLoop(reversed, { asOf: '2026-01-02T10:08:00Z', timezone: 'UTC' }).claims).toHaveLength(0);
  });

  it('is invariant to input order, exact retries, and random ingress IDs', () => {
    const normal = events();
    const disturbed = events(fixtureJson([...baseFixture.events].reverse().concat(baseFixture.events[0]!)))
      .map((event, index) => ({ ...event, id: `random-ingress-${index}` }));
    const first = replayV1(replayInput(normal));
    const second = replayV1(replayInput(disturbed));
    expect(second.replayKey).toBe(first.replayKey);
    expect(second.snapshotHash).toBe(first.snapshotHash);
    expect(second.output.snapshotHash).toBe(first.output.snapshotHash);
  });

  it('keeps equivalent facts from distinct source-stable keys', () => {
    const duplicateFact = { ...baseFixture.events[0]!, sourceItemKey: 'second-observation' };
    const output = replayV1(replayInput(events(fixtureJson([...baseFixture.events, duplicateFact]))));
    expect(output.output.events.filter((event) => event.factHash === output.output.events[0]?.factHash)).toHaveLength(2);
  });
});

describe('correction absorption, locality and suppression', () => {
  it('absorbs an edit only in its target scope', () => {
    const observed = events();
    const initial = runInsightLoop(observed, { asOf: '2026-01-02T10:06:00Z', timezone: 'UTC' });
    const store = new InMemoryKnowledgePort();
    store.registerProposed(initial.claims);
    const alpha = store.currentClaim('claim:test-after-change:alpha')!;
    const result = store.submitCorrection({
      commandId: 'edit-alpha', targetClaimKey: alpha.claimKey, baseRevisionId: alpha.id,
      action: 'edit', statement: '在 alpha 修改后仅运行定向测试',
    });
    expect(result.ok).toBe(true);
    const before = replayV1(replayInput(observed)).output;
    const after = replayV1(replayInput(observed, store)).output;
    expect(after.claims.find((claim) => claim.scope.projectKey === 'alpha')?.statement)
      .toBe('在 alpha 修改后仅运行定向测试');
    expect(after.claims.find((claim) => claim.scope.projectKey === 'beta')?.contentHash)
      .toBe(before.claims.find((claim) => claim.scope.projectKey === 'beta')?.contentHash);
  });

  it('does not resurrect rejected or deleted claim lineages', () => {
    const observed = events();
    const initial = runInsightLoop(observed, { asOf: '2026-01-02T10:06:00Z', timezone: 'UTC' });
    const rejected = new InMemoryKnowledgePort();
    rejected.registerProposed(initial.claims);
    const alpha = rejected.currentClaim('claim:test-after-change:alpha')!;
    rejected.submitCorrection({ commandId: 'reject-alpha', targetClaimKey: alpha.claimKey, baseRevisionId: alpha.id, action: 'reject' });
    expect(replayV1(replayInput(observed, rejected)).output.claims.map((claim) => claim.scope.projectKey)).toEqual(['beta']);

    const deleted = new InMemoryKnowledgePort();
    deleted.registerProposed(initial.claims);
    const doomed = deleted.currentClaim('claim:test-after-change:alpha')!;
    deleted.submitCorrection({ commandId: 'delete-alpha', targetClaimKey: doomed.claimKey, baseRevisionId: doomed.id, action: 'delete' });
    expect(replayV1(replayInput(observed, deleted)).output.claims.map((claim) => claim.scope.projectKey)).toEqual(['beta']);
    expect(deleted.submitCorrection({
      commandId: 'restore-deleted', targetClaimKey: doomed.claimKey, baseRevisionId: doomed.id,
      action: 'restore', restoreFromRevisionId: doomed.id,
    }).record.errorCode).toBe('ERR_DELETED_RESTORE_FORBIDDEN');
    const deletedSnapshot = deleted.snapshot();
    expect(JSON.stringify(deletedSnapshot)).not.toContain(doomed.statement);
    expect(deletedSnapshot.corrections).toHaveLength(0);
    expect(deletedSnapshot.versions).toHaveLength(0);
    expect(deletedSnapshot.heads).toHaveLength(0);
  });
});
