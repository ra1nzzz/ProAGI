import type { GoldAssertion } from './referenceEvaluator';

export const DAILY_GOLD: readonly GoldAssertion[] = Object.freeze([
  { id: 'gold-alpha-statement', kind: 'claim-statement', projectKey: 'alpha', expected: '在 alpha 修改代码后运行测试' },
  { id: 'gold-beta-count', kind: 'scope-claim-count', projectKey: 'beta', expected: 1 },
  { id: 'gold-shadow-only', kind: 'shadow-mode', expected: true },
  { id: 'gold-evidence', kind: 'evidence-complete', expected: true },
]);
