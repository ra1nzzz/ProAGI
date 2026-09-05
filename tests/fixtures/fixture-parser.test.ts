import { describe, expect, it } from 'vitest';
import { materializeBehaviorEvents, parseFixtureJson } from '../../src/domain/fixture';
import { baseFixture, fixtureJson } from './sample';

describe('strict synthetic fixture allowlist', () => {
  it('accepts only the declared event shape and emits content identities', () => {
    const parsed = parseFixtureJson(fixtureJson());
    const events = materializeBehaviorEvents(parsed);
    expect(parsed.rejected).toEqual([]);
    expect(events).toHaveLength(5);
    expect(events[0]?.dedupeKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(events[0]?.factHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects an unknown field per item without contaminating valid items', () => {
    const invalid = { ...baseFixture.events[0], windowTitle: 'restricted' };
    const parsed = parseFixtureJson(fixtureJson([invalid, baseFixture.events[1]]));
    expect(parsed.accepted).toHaveLength(1);
    expect(parsed.rejected).toEqual([{ itemKey: 'alpha-focus', code: 'ERR_UNKNOWN_FIELD', fieldPath: '$unknown' }]);
    expect(JSON.stringify(parsed)).not.toContain('restricted');
  });

  it('rejects impossible calendar timestamps per item', () => {
    const invalid = { ...baseFixture.events[0], occurredAt: '2025-99-31T25:61:61Z' };
    const parsed = parseFixtureJson(fixtureJson([invalid, baseFixture.events[1]]));
    expect(parsed.accepted).toHaveLength(1);
    expect(parsed.rejected).toEqual([{ itemKey: 'alpha-focus', code: 'ERR_SCHEMA_INVALID', fieldPath: '/occurredAt' }]);
  });

  it('rejects schema drift at the envelope boundary', () => {
    expect(() => parseFixtureJson(JSON.stringify({ ...baseFixture, schemaVersion: '2.0.0' }))).toThrow('ERR_SCHEMA_INVALID');
  });
});
