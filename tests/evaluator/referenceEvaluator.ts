import type { InsightLoopOutput } from '../../src/domain/types';

export interface GoldAssertion {
  readonly id: string;
  readonly kind: 'claim-statement' | 'scope-claim-count' | 'shadow-mode' | 'evidence-complete';
  readonly projectKey?: string;
  readonly expected: string | number | boolean;
}

export interface AssertionResult {
  readonly id: string;
  readonly passed: boolean;
  readonly actual: string | number | boolean;
}

// This oracle intentionally imports types only: no production inference, replay, segmenter or canonicalizer.
export function evaluateAgainstGold(output: Readonly<InsightLoopOutput>, gold: readonly GoldAssertion[]): readonly AssertionResult[] {
  return gold.map((assertion) => {
    let actual: string | number | boolean;
    switch (assertion.kind) {
      case 'claim-statement':
        actual = output.claims.find((claim) => claim.scope.projectKey === assertion.projectKey)?.statement ?? '';
        break;
      case 'scope-claim-count':
        actual = output.claims.filter((claim) => claim.scope.projectKey === assertion.projectKey).length;
        break;
      case 'shadow-mode':
        actual = output.actionIntents.every((intent) => intent.mode === 'shadow');
        break;
      case 'evidence-complete':
        actual = output.claims.every((claim) => claim.evidence.length > 0
          && claim.evidence.every((evidence) => output.episodes.some((episode) => episode.id === evidence.entityId)));
        break;
    }
    return { id: assertion.id, passed: actual === assertion.expected, actual };
  });
}
