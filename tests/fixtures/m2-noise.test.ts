import { describe, expect, it } from 'vitest';
import { ReadonlyTestResultsAdapter } from '../../src/adapters/readonlyTestResults';
import { M2_READONLY_PURPOSE } from '../../src/application/m2Consent';
import { parseReadonlyInput } from '../../src/domain/readonlySource';

const options = { sourceItemKey: 'readonly-source-a', capturedAt: '2026-01-02T09:00:00Z', projectKey: 'proagi' } as const;

function event(sourceItemKey: string, occurredAt: string, outcome: 'passed' | 'failed' = 'passed') {
  return { sourceItemKey, occurredAt, kind: 'test.completed', subject: { appId: 'terminal' }, attributes: { appId: 'terminal', commandClass: 'test', testOutcome: outcome, durationMs: 100 } };
}

describe('M2 readonly adapter', () => {
  it('observes drop, duplicate, reorder, clock skew and schema drift without retaining raw fields', () => {
    const input = JSON.stringify({
      schemaVersion: '1.0.0', sourceId: 'readonly-source-a', capturedAt: options.capturedAt, timezone: 'Asia/Shanghai', locale: 'zh-CN', projectAlias: 'proagi',
      events: [
        event('second', '2026-01-02T09:02:00Z'),
        event('first', '2026-01-02T09:01:00Z'),
        event('first', '2026-01-02T09:01:00Z'),
        { ...event('future', '2026-01-02T09:10:00Z'), secret: 'must-not-persist' },
      ],
    });
    const parsed = parseReadonlyInput(input, options);
    expect(parsed.accepted.map((item) => item.sourceItemKey)).toEqual(['first', 'second']);
    expect(parsed.accepted[0]?.occurredAt).toBe('2026-01-02T09:01:00.000Z');
    expect(parsed.rejected).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ERR_UNKNOWN_FIELD', fieldPath: '$unknown' })]));
    expect(parsed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate', count: 1 }),
      expect.objectContaining({ code: 'reorder', count: 1 }),
      expect.objectContaining({ code: 'locale-timezone', count: 1 }),
    ]));
  });

  it('maps Playwright JSON reports to minimal test events and pins consent provenance', () => {
    const report = JSON.stringify({
      startedAt: '2026-01-02T09:00:00Z',
      suites: [{ title: 'unit', specs: [{ title: 'works', tests: [{ projectName: 'chromium', results: [{ status: 'passed', duration: 42, startTime: '2026-01-02T09:01:00Z', stdout: ['private'] }] }] }] }],
    });
    const adapter = new ReadonlyTestResultsAdapter();
    const preview = adapter.preview(report, {
      ...options, consentId: 'consent-a', purpose: M2_READONLY_PURPOSE, policyVersion: 'consent-readonly-v1',
    });
    expect(preview.events).toHaveLength(1);
    expect(preview.events[0]?.source).toMatchObject({ kind: 'readonly-adapter', consentId: 'consent-a', purpose: M2_READONLY_PURPOSE });
    expect(preview.events[0]?.privacy).toMatchObject({ policyVersion: 'consent-readonly-v1', redactionCount: 1 });
    expect(preview.events[0]).not.toHaveProperty('stdout');
  });
});
