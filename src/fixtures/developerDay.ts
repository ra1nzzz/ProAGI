import type { FixtureInput } from '../domain/types';

export const developerDayFixture: FixtureInput = {
  schemaVersion: '1.0.0',
  fixtureId: 'developer-day-bundled-v1',
  adapterId: 'synthetic-fixture',
  adapterVersion: '1.0.0',
  events: [
    {
      sourceItemKey: 'focus-contracts',
      occurredAt: '2026-01-02T09:12:00Z',
      kind: 'app.focus',
      subject: { appId: 'vscode', projectKey: 'demo-project' },
      attributes: { appId: 'vscode', projectKey: 'demo-project' }
    },
    {
      sourceItemKey: 'change-contracts',
      occurredAt: '2026-01-02T09:20:00Z',
      kind: 'file.changed',
      subject: { appId: 'vscode', projectKey: 'demo-project' },
      attributes: { appId: 'vscode', projectKey: 'demo-project', fileExt: 'ts', operation: 'modify' }
    },
    {
      sourceItemKey: 'targeted-tests',
      occurredAt: '2026-01-02T09:31:00Z',
      kind: 'test.completed',
      subject: { appId: 'terminal', projectKey: 'demo-project' },
      attributes: { appId: 'terminal', projectKey: 'demo-project', commandClass: 'test', exitCode: 0, testOutcome: 'passed', durationMs: 4200 }
    },
    {
      sourceItemKey: 'full-regression',
      occurredAt: '2026-01-02T09:46:00Z',
      kind: 'test.completed',
      subject: { appId: 'terminal', projectKey: 'demo-project' },
      attributes: { appId: 'terminal', projectKey: 'demo-project', commandClass: 'test', exitCode: 0, testOutcome: 'passed', durationMs: 9800 }
    }
  ]
};

export const developerDayFixtureJson = JSON.stringify(developerDayFixture);
