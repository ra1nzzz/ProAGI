import { describe, expect, it } from 'vitest';
import { FORBIDDEN_BROWSER_EFFECT_SINK_REGISTRY, ShadowActionSink } from '../../src/application/action';
import { FORBIDDEN_EFFECTS } from '../../src/domain/types';
import { materializeBehaviorEvents, parseFixtureJson } from '../../src/domain/fixture';
import { runInsightLoop } from '../../src/domain/insightLoop';
import { fixtureJson } from '../fixtures/sample';

describe('Shadow-only action boundary', () => {
  it('emits intents with all forbidden side effects and no executable callback', () => {
    const events = materializeBehaviorEvents(parseFixtureJson(fixtureJson()));
    const output = runInsightLoop(events, { asOf: '2026-01-02T10:06:00Z', timezone: 'UTC' });
    const intent = output.actionIntents[0];
    expect(intent).toBeDefined();
    expect(intent?.mode).toBe('shadow');
    expect(intent?.forbiddenEffects).toEqual(FORBIDDEN_EFFECTS);
    expect(FORBIDDEN_BROWSER_EFFECT_SINK_REGISTRY.sinks).toEqual(
      Object.fromEntries(FORBIDDEN_EFFECTS.map((sink) => [sink, 'deny-from-shadow-root'])),
    );
    expect(JSON.stringify(intent)).not.toMatch(/https?:|callback|execute/i);
    expect(() => new ShadowActionSink().submit(intent!)).not.toThrow();
  });
});
