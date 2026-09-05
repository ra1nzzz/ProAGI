import type { FixtureInput } from '../../src/domain/types';

export const baseFixture: FixtureInput = {
  schemaVersion: '1.0.0',
  fixtureId: 'daily-alpha',
  adapterId: 'synthetic-fixture',
  adapterVersion: '1.0.0',
  events: [
    {
      sourceItemKey: 'alpha-focus',
      occurredAt: '2026-01-02T09:00:00Z',
      kind: 'app.focus',
      subject: { appId: 'vscode', projectKey: 'alpha' },
      attributes: { appId: 'vscode', projectKey: 'alpha' },
    },
    {
      sourceItemKey: 'alpha-change',
      occurredAt: '2026-01-02T09:05:00Z',
      kind: 'file.changed',
      subject: { appId: 'vscode', projectKey: 'alpha' },
      attributes: { appId: 'vscode', projectKey: 'alpha', fileExt: 'ts', operation: 'modify' },
    },
    {
      sourceItemKey: 'alpha-test',
      occurredAt: '2026-01-02T09:10:00Z',
      kind: 'test.completed',
      subject: { appId: 'terminal', projectKey: 'alpha' },
      attributes: { appId: 'terminal', projectKey: 'alpha', commandClass: 'test', exitCode: 0, testOutcome: 'passed', durationMs: 4000 },
    },
    {
      sourceItemKey: 'beta-change',
      occurredAt: '2026-01-02T10:00:00Z',
      kind: 'file.changed',
      subject: { appId: 'cursor', projectKey: 'beta' },
      attributes: { appId: 'cursor', projectKey: 'beta', fileExt: 'ts', operation: 'modify' },
    },
    {
      sourceItemKey: 'beta-test',
      occurredAt: '2026-01-02T10:06:00Z',
      kind: 'test.completed',
      subject: { appId: 'terminal', projectKey: 'beta' },
      attributes: { appId: 'terminal', projectKey: 'beta', commandClass: 'test', exitCode: 0, testOutcome: 'passed' },
    },
  ],
};

export function fixtureJson(events: readonly unknown[] = baseFixture.events): string {
  return JSON.stringify({ ...baseFixture, events });
}
