import { describe, expect, it } from 'vitest';
import { materializeBehaviorEvents, parseFixtureJson } from '../../src/domain/fixture';
import { runInsightLoop } from '../../src/domain/insightLoop';
import type { InsightLoopOutput } from '../../src/domain/types';
import { fixtureJson } from '../fixtures/sample';
import { DAILY_GOLD } from './gold';
import { evaluateAgainstGold } from './referenceEvaluator';

function productionOutput(): InsightLoopOutput {
  const events = materializeBehaviorEvents(parseFixtureJson(fixtureJson()));
  return runInsightLoop(events, { asOf: '2026-01-02T10:06:00Z', timezone: 'UTC' });
}

describe('independent gold evaluator', () => {
  it('accepts the frozen gold state', () => {
    expect(evaluateAgainstGold(productionOutput(), DAILY_GOLD).every((assertion) => assertion.passed)).toBe(true);
  });

  it('rejects false success when production output is mutated', () => {
    const output = productionOutput();
    const mutated: InsightLoopOutput = {
      ...output,
      claims: output.claims.map((claim) => claim.scope.projectKey === 'alpha'
        ? { ...claim, statement: '错误但 UI 显示成功', evidence: [] }
        : claim),
    };
    const result = evaluateAgainstGold(mutated, DAILY_GOLD);
    expect(result.find((assertion) => assertion.id === 'gold-alpha-statement')?.passed).toBe(false);
    expect(result.find((assertion) => assertion.id === 'gold-evidence')?.passed).toBe(false);
    expect(result.find((assertion) => assertion.id === 'gold-beta-count')?.passed).toBe(true);
  });
});
