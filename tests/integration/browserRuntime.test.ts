import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserInsightRuntime } from '../../src/application/browserInsightRuntime';
import { createBrowserInsightRuntime } from '../../src/application/browserRuntimeComposition';
import { CommitResponseLostError } from '../../src/application/storageContracts';
import { IndexedDbM1bAdapter } from '../../src/adapters/indexedDbM1b';
import type { RuntimeNotificationPort } from '../../src/application/ports';

const runtimes: BrowserInsightRuntime[] = [];

const notificationPort = (errors: unknown[], snapshots: unknown[]): RuntimeNotificationPort => ({
  prepareForPurge: async () => undefined,
  publishSnapshot: (detail) => snapshots.push(detail),
  publishError: (detail) => errors.push(detail),
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe('BrowserInsightRuntime application ports', () => {
  it('reports malformed cross-tab payloads without throwing from the event boundary', async () => {
    const adapter = new IndexedDbM1bAdapter(`runtime-protocol-${crypto.randomUUID()}`);
    const channel = Object.assign(new EventTarget(), { close: () => undefined });
    const errors: unknown[] = [];
    const runtime = createBrowserInsightRuntime({
      adapterFactory: () => adapter,
      channelFactory: () => channel as unknown as BroadcastChannel,
      clientIdFactory: () => 'runtime-protocol-client',
      notificationPort: notificationPort(errors, []),
    });
    runtimes.push(runtime);
    await runtime.start();
    for (const data of [null, 42, 'STATE_CHANGED', { type: 'UNKNOWN', clientId: 'remote' }, { type: 'PURGE_REQUEST', clientId: 'remote' }]) {
      channel.dispatchEvent(new MessageEvent('message', { data }));
    }
    expect(errors).toHaveLength(5);
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'purge-channel-protocol', code: 'ERR_PURGE_PROTOCOL_INVALID', runtimeFaulted: true })]));
  });

  it('retries a transient startup failure on the same still-open runtime', async () => {
    const adapter = new IndexedDbM1bAdapter(`runtime-start-${crypto.randomUUID()}`);
    const originalOpen = adapter.open.bind(adapter);
    let attempts = 0;
    adapter.open = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('ERR_STORAGE_TRANSIENT');
      await originalOpen();
    };
    const runtime = createBrowserInsightRuntime({ adapterFactory: () => adapter, channelFactory: () => null, clientIdFactory: () => 'runtime-start-client' });
    runtimes.push(runtime);
    await expect(runtime.start()).rejects.toMatchObject({ message: 'ERR_STORAGE_TRANSIENT' });
    await expect(runtime.recover()).resolves.toBeUndefined();
    expect((await runtime.snapshot()).runtimeFaulted).toBe(false);
  });

  it.each(['ERR_PREVIEW_INVALID', 'ERR_PREVIEW_RETRY_INVALID', 'ERR_STORAGE_UNAVAILABLE', 'ERR_RESPONSE_LOST_AGAIN'] as const)('latches every ambiguous response-loss reconciliation failure: %s', async (retryCode) => {
    const adapter = new IndexedDbM1bAdapter(`runtime-reconcile-fault-${crypto.randomUUID()}`);
    const originalCommitPreview = adapter.commitPreview.bind(adapter);
    let commitAttempts = 0;
    adapter.commitPreview = async (...args: Parameters<IndexedDbM1bAdapter['commitPreview']>) => {
      commitAttempts += 1;
      if (commitAttempts === 1) {
        const committed = await originalCommitPreview(...args);
        throw new CommitResponseLostError(committed.cursor);
      }
      if (retryCode === 'ERR_RESPONSE_LOST_AGAIN') throw new CommitResponseLostError('1');
      throw new Error(retryCode);
    };
    const runtime = createBrowserInsightRuntime({ adapterFactory: () => adapter, channelFactory: () => null, clientIdFactory: () => `runtime-reconcile-fault-${retryCode}` });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.previewBundled();
    await expect(runtime.commitBundled()).rejects.toMatchObject({ message: 'ERR_COMMIT_RECONCILIATION_INVALID', cause: expect.any(Error) });
    expect((await runtime.snapshot()).runtimeFaulted).toBe(true);
  });

  it('does not latch expected privacy and stale-preview rejections', async () => {
    const runtime = createBrowserInsightRuntime({ channelFactory: () => null, clientIdFactory: () => 'runtime-expected-error-client' });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.pausePrivacy();
    await expect(runtime.preview()).rejects.toMatchObject({ message: 'ERR_PRIVACY_MODE' });
    expect((await runtime.snapshot()).runtimeFaulted).toBe(false);
    await expect(runtime.submit('accept')).rejects.toMatchObject({ message: 'ERR_PRIVACY_MODE_ACTIVE' });
    expect((await runtime.snapshot()).runtimeFaulted).toBe(false);
    await runtime.resumePrivacy();
    await expect(runtime.commit('stale-preview-token')).rejects.toMatchObject({ message: 'ERR_PREVIEW_STALE' });
    expect((await runtime.snapshot()).runtimeFaulted).toBe(false);
  });

  it('latches injected storage failures, rejects later writes, and clears only after verified recovery', async () => {
    const adapter = new IndexedDbM1bAdapter(`runtime-fault-${crypto.randomUUID()}`);
    const errors: unknown[] = [];
    const snapshots: unknown[] = [];
    const runtime = createBrowserInsightRuntime({
      adapterFactory: () => adapter,
      channelFactory: () => null,
      clientIdFactory: () => 'runtime-fault-client',
      notificationPort: notificationPort(errors, snapshots),
    });
    runtimes.push(runtime);
    await runtime.start();
    const originalSetPrivacyMode = adapter.setPrivacyMode.bind(adapter);
    adapter.setPrivacyMode = async () => { throw new Error('ERR_STORAGE_WRITE'); };

    await expect(runtime.pausePrivacy()).rejects.toMatchObject({ message: 'ERR_STORAGE_WRITE' });
    await expect(runtime.preview()).rejects.toMatchObject({ message: 'ERR_RUNTIME_FAULTED' });
    expect((await runtime.snapshot()).runtimeFaulted).toBe(true);
    expect(errors).toHaveLength(0);

    await runtime.recover();
    expect((await runtime.snapshot()).runtimeFaulted).toBe(false);
    adapter.setPrivacyMode = originalSetPrivacyMode;
    await expect(runtime.pausePrivacy()).resolves.toMatchObject({ privacyEpoch: 1 });
    await expect(runtime.resumePrivacy()).resolves.toMatchObject({ privacyEpoch: 2 });
    expect(snapshots).toEqual(expect.arrayContaining([expect.objectContaining({ runtimeFaulted: false })]));
  });
});
