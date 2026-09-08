import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadonlyTestResultsAdapter } from '../../src/adapters/readonlyTestResults';
import { IndexedDbM1bAdapter } from '../../src/adapters/indexedDbM1b';
import { createBrowserInsightRuntime } from '../../src/application/browserRuntimeComposition';
import type { BrowserInsightRuntime } from '../../src/application/browserInsightRuntime';

const runtimes: BrowserInsightRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

function sourceJson() {
  return JSON.stringify({
    schemaVersion: '1.0.0', capturedAt: '2026-01-02T10:00:00Z', timezone: 'Asia/Shanghai', locale: 'zh-CN', projectAlias: 'proagi',
    events: [
      { sourceItemKey: 'change', occurredAt: '2026-01-02T09:00:00Z', kind: 'file.changed', subject: { appId: 'vscode', projectKey: 'proagi' }, attributes: { appId: 'vscode', projectKey: 'proagi', fileExt: 'ts', operation: 'modify' } },
      { sourceItemKey: 'test', occurredAt: '2026-01-02T09:02:00Z', kind: 'test.completed', subject: { appId: 'terminal', projectKey: 'proagi' }, attributes: { appId: 'terminal', projectKey: 'proagi', commandClass: 'test', testOutcome: 'passed', durationMs: 80 } },
    ],
  });
}

describe('M2 consent and retention', () => {
  it.each(['id', 'version'] as const)('does not transfer persisted consent to a replacement adapter %s', async (field) => {
    const name = `m2-adapter-scope-${crypto.randomUUID()}`;
    const first = createBrowserInsightRuntime({ adapterFactory: () => new IndexedDbM1bAdapter(name), channelFactory: () => null });
    runtimes.push(first);
    await first.grantReadonlyConsent({ sourceItemKey: 'source-a' });
    await first.close();
    const original = new ReadonlyTestResultsAdapter();
    const preview = vi.fn(() => { throw new Error('Raw input reached the replacement'); });
    const replacement = { id: original.id, version: original.version, preview, [field]: 'replacement' };
    const next = createBrowserInsightRuntime({ adapterFactory: () => new IndexedDbM1bAdapter(name), channelFactory: () => null, readonlyAdapter: replacement });
    runtimes.push(next);
    await expect(next.previewReadonly({ utf8: sourceJson(), sourceItemKey: 'source-a' })).rejects.toThrow('ERR_CONSENT_SCOPE');
    expect(preview).not.toHaveBeenCalled();
  });
  it('commits a readonly source with 7/30 day metadata and deletes its lineage on revocation', async () => {
    const clock = () => Date.parse('2026-01-02T10:00:00Z');
    const adapter = new IndexedDbM1bAdapter(`m2-consent-${crypto.randomUUID()}`, clock);
    const runtime = createBrowserInsightRuntime({ adapterFactory: () => adapter, channelFactory: () => null, clientIdFactory: () => 'm2-consent-client', clock });
    runtimes.push(runtime);
    await runtime.start();
    const consent = await runtime.grantReadonlyConsent({ sourceItemKey: 'readonly-source-a' });
    expect(consent.policy).toMatchObject({ eventTtlDays: 7, derivedTtlDays: 30 });
    await expect(runtime.grantReadonlyConsent({ sourceItemKey: 'readonly-source-b' })).rejects.toMatchObject({ message: 'ERR_CONSENT_ALREADY_ACTIVE' });
    const preview = await runtime.previewReadonly({ utf8: sourceJson(), sourceItemKey: 'readonly-source-a' });
    expect(preview.source).toBe('readonly-test-results');
    expect(preview.acceptedCount).toBe(2);
    const committed = await runtime.commit(preview.token);
    expect(committed.output.claims).toHaveLength(1);
    const business = await adapter.scanPublishedBusiness();
    expect(business.filter((record) => record.retentionClass === 'event')).toHaveLength(2);
    expect(business.filter((record) => record.retentionClass === 'derived').length).toBeGreaterThan(0);
    expect(business.every((record) => record.consentId === consent.grant.id && record.retentionPolicyId === consent.policy.id)).toBe(true);

    await runtime.revokeReadonlyConsent(consent.grant.id);
    expect(await adapter.scanPublishedBusiness()).toHaveLength(0);
    const system = await adapter.getAll<{ recordType: string; payload?: { consentId?: string } }>('system');
    expect(system.some((record) => record.recordType === 'consent_grant_v1')).toBe(true);
    expect(system.some((record) => record.recordType === 'consent_revocation_v1' && record.payload?.consentId === consent.grant.id)).toBe(true);
    expect((await adapter.getMeta()).privacyEpoch).toBe(1);
  });

  it('fences a pending readonly preview after consent revocation', async () => {
    const clock = () => Date.parse('2026-01-02T10:00:00Z');
    const runtime = createBrowserInsightRuntime({ adapterFactory: () => new IndexedDbM1bAdapter(`m2-fence-${crypto.randomUUID()}`, clock), channelFactory: () => null, clientIdFactory: () => 'm2-fence-client', clock });
    runtimes.push(runtime);
    await runtime.start();
    const consent = await runtime.grantReadonlyConsent({ sourceItemKey: 'readonly-source-b' });
    const preview = await runtime.previewReadonly({ utf8: sourceJson(), sourceItemKey: 'readonly-source-b' });
    await runtime.revokeReadonlyConsent(consent.grant.id);
    await expect(runtime.commit(preview.token)).rejects.toMatchObject({ message: 'ERR_PREVIEW_STALE' });
  });

  it('expires readonly events through the same deletion lineage in PRIVATE', async () => {
    const base = Date.parse('2026-01-02T10:00:00Z');
    let now = base;
    const clock = () => now;
    const adapter = new IndexedDbM1bAdapter(`m2-expiry-${crypto.randomUUID()}`, clock);
    const runtime = createBrowserInsightRuntime({ adapterFactory: () => adapter, channelFactory: () => null, clientIdFactory: () => 'm2-expiry-client', clock });
    runtimes.push(runtime);
    await runtime.start();
    const consent = await runtime.grantReadonlyConsent({ sourceItemKey: 'readonly-source-c', eventTtlDays: 1, derivedTtlDays: 1 });
    const preview = await runtime.previewReadonly({ utf8: sourceJson(), sourceItemKey: consent.grant.source.sourceItemKey });
    await runtime.commit(preview.token);
    await runtime.pausePrivacy();
    now = base + 86_400_000;
    await expect(runtime.expireReadonlyRetention()).resolves.toBe(2);
    await expect(adapter.scanPublishedBusiness()).resolves.toHaveLength(0);
  });
});
