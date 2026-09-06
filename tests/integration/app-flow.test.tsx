import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../../src/App';
import { AppShell } from '../../src/ui/AppShell';
import { createBrowserInsightRuntime } from '../../src/application/browserRuntimeComposition';
import { CommitResponseLostError } from '../../src/application/storageContracts';
import { RUNTIME_ERROR_EVENT } from '../../src/application/ports';
import { IndexedDbM1bAdapter, toStoredRecord } from '../../src/adapters/indexedDbM1b';

afterEach(async () => {
  cleanup();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('proagi-insight-loop-m1-v1');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => undefined;
  });
});

describe('runnable Insight Loop UI', () => {
  it('exposes a safe no-op recovery when no active deletion journal exists', async () => {
    const runtime = createBrowserInsightRuntime();
    await expect(runtime.recover()).resolves.toBeUndefined();
    await runtime.close();
  });

  it('surfaces a classified background runtime failure in the recovery UI', async () => {
    render(<App />);
    await screen.findByRole('button', { name: '预览本地样例' });
    window.dispatchEvent(new CustomEvent(RUNTIME_ERROR_EVENT, { detail: { operation: 'client-lease-renewal', code: 'ERR_RECOVERY_LEASE_LOST' } }));
    expect(await screen.findByText(/本地运行时报告 ERR_RECOVERY_LEASE_LOST/)).toBeVisible();
    expect(screen.getByText('本地数据仍在恢复')).toBeVisible();
    expect(screen.getByRole('button', { name: '预览本地样例' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '暂停观察' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '运行 Replay' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '退出恢复演示' })).not.toBeInTheDocument();
  });

  it('latches the UI write fence after an indeterminate privacy transaction failure', async () => {
    const databaseName = `ui-runtime-fault-${crypto.randomUUID()}`;
    const adapter = new IndexedDbM1bAdapter(databaseName);
    const runtime = createBrowserInsightRuntime({ adapterFactory: () => adapter, channelFactory: () => null, clientIdFactory: () => 'ui-runtime-fault-client' });
    const originalSetPrivacyMode = adapter.setPrivacyMode.bind(adapter);
    adapter.setPrivacyMode = async () => { throw new Error('ERR_STORAGE_WRITE'); };
    render(<AppShell runtimeFactory={() => runtime} />);
    try {
      await screen.findByText(/本地 canonical store 已就绪/);
      fireEvent.click(screen.getByRole('button', { name: '暂停观察' }));
      expect(await screen.findByText(/隐私模式事务失败；写操作保持受阻/)).toBeVisible();
      expect(screen.getByRole('button', { name: '预览本地样例' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '暂停观察' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: '退出恢复演示' })).not.toBeInTheDocument();
    } finally {
      adapter.setPrivacyMode = originalSetPrivacyMode;
      cleanup();
      await runtime.close();
      await adapter.destroy();
    }
  });

  it('opens mandatory recovery after an indeterminate fixture commit failure', async () => {
    const databaseName = `ui-commit-fault-${crypto.randomUUID()}`;
    const adapter = new IndexedDbM1bAdapter(databaseName);
    const runtime = createBrowserInsightRuntime({ adapterFactory: () => adapter, channelFactory: () => null, clientIdFactory: () => 'ui-commit-fault-client' });
    const originalCommitPreview = adapter.commitPreview.bind(adapter);
    let commitAttempts = 0;
    adapter.commitPreview = async (...args: Parameters<IndexedDbM1bAdapter['commitPreview']>) => {
      commitAttempts += 1;
      if (commitAttempts === 1) {
        const committed = await originalCommitPreview(...args);
        throw new CommitResponseLostError(committed.cursor);
      }
      throw new Error('ERR_PREVIEW_RETRY_INVALID');
    };
    render(<AppShell runtimeFactory={() => runtime} />);
    try {
      await screen.findByText(/本地 canonical store 已就绪/);
      fireEvent.click(screen.getByRole('button', { name: '预览本地样例' }));
      await screen.findByRole('button', { name: '确认导入' });
      fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
      expect(await screen.findByText(/提交失败；canonical store 未显示成功/)).toBeVisible();
      expect(screen.getByText('本地数据仍在恢复')).toBeVisible();
      expect(screen.getByRole('button', { name: '预览本地样例' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '暂停观察' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: '退出恢复演示' })).not.toBeInTheDocument();
    } finally {
      adapter.commitPreview = originalCommitPreview;
      cleanup();
      await runtime.close();
      await adapter.destroy();
    }
  });

  it('opens mandatory recovery after an indeterminate correction failure', async () => {
    const databaseName = `ui-correction-fault-${crypto.randomUUID()}`;
    const adapter = new IndexedDbM1bAdapter(databaseName);
    const runtime = createBrowserInsightRuntime({ adapterFactory: () => adapter, channelFactory: () => null, clientIdFactory: () => 'ui-correction-fault-client' });
    const originalCommit = adapter.commit.bind(adapter);
    adapter.commit = async () => { throw new Error('ERR_STORAGE_WRITE'); };
    render(<AppShell runtimeFactory={() => runtime} />);
    try {
      await screen.findByText(/本地 canonical store 已就绪/);
      fireEvent.click(screen.getByRole('button', { name: '预览本地样例' }));
      await screen.findByRole('button', { name: '确认导入' });
      adapter.commit = originalCommit;
      fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
      await screen.findByText(/已持久提交 4 条测试事件/);
      adapter.commit = async () => { throw new Error('ERR_STORAGE_WRITE'); };
      fireEvent.click(screen.getByRole('button', { name: '接受 Insight' }));
      expect(await screen.findByText(/纠正事务失败（ERR_STORAGE_WRITE）；未显示成功/)).toBeVisible();
      expect(screen.getByText('本地数据仍在恢复')).toBeVisible();
      expect(screen.getByRole('button', { name: '接受 Insight' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: '退出恢复演示' })).not.toBeInTheDocument();
    } finally {
      adapter.commit = originalCommit;
      cleanup();
      await runtime.close();
      await adapter.destroy();
    }
  });

  it('fails closed when a persisted domain payload is malformed', async () => {
    const seedAdapter = new IndexedDbM1bAdapter('proagi-insight-loop-m1-v1');
    await seedAdapter.open();
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('proagi-insight-loop-m1-v1', 4);
      request.onerror = () => reject(request.error ?? new Error('seed open failed'));
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('business', 'readwrite');
      tx.objectStore('business').put(toStoredRecord('corrupt-event', 'behavior_event_v1', { malformed: true }));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('seed write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('seed write aborted'));
    });
    database.close();
    seedAdapter.dispose();

    const runtime = createBrowserInsightRuntime();
    await expect(runtime.start()).rejects.toThrow('ERR_STORAGE_CORRUPT');
    await runtime.close();
  });

  it('bounds a stalled CacheStorage clear and keeps shutdown finite', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: { keys: () => new Promise<string[]>(() => {}) } });
    const runtime = createBrowserInsightRuntime({ cacheClearTimeoutMs: 10 });
    try {
      await expect(runtime.clear()).rejects.toThrow('ERR_CLEAR_BLOCKED');
    } finally {
      await runtime.close();
      if (original) Object.defineProperty(globalThis, 'caches', original);
      else delete (globalThis as { caches?: unknown }).caches;
    }
  });

  it('previews and commits the bundled fixture, applies a correction, then replays', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '预览本地样例' }));
    expect(await screen.findByText(/预览已准备：4 条 synthetic 事件/)).toBeVisible();
    expect(screen.getByRole('button', { name: '运行 Replay' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    expect(await screen.findByText(/已持久提交 4 条测试事件，生成/)).toBeVisible();

    const accept = screen.getByRole('button', { name: '接受 Insight' });
    expect(accept).toBeEnabled();
    fireEvent.click(accept);
    expect(await screen.findByText(/accept 已持久写入不可变 revision/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '运行 Replay' }));
    await waitFor(() => expect(screen.getByText(/Replay 完成：/)).toBeVisible());
  });

  it('reconciles a lost commit response from the durable idempotency ledger', async () => {
    const runtime = createBrowserInsightRuntime();
    await runtime.previewBundled();
    await expect(runtime.commitBundled({ simulateResponseLoss: true })).resolves.toMatchObject({ acceptedCount: 4 });
    await expect(runtime.snapshot()).resolves.toMatchObject({ cursor: '1', imported: expect.any(Object) });
    await runtime.close();

    const recovered = createBrowserInsightRuntime();
    await expect(recovered.start()).resolves.toMatchObject({ cursor: '1', imported: expect.any(Object) });
    await recovered.close();
  });

  it('invalidates an outstanding preview when PRIVATE advances the epoch', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '预览本地样例' }));
    expect(await screen.findByRole('button', { name: '确认导入' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '暂停观察' }));
    expect(await screen.findByRole('heading', { name: '隐私模式已开启' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '确认导入' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '运行 Replay' })).toBeDisabled();
  });

  it('blocks fixture import while PRIVATE without claiming success', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '暂停观察' }));
    expect(await screen.findByRole('heading', { name: '隐私模式已开启' })).toBeVisible();
    expect(screen.getByRole('button', { name: '预览本地样例' })).toBeDisabled();
    expect(screen.queryByText(/已提交 4 条测试事件/)).not.toBeInTheDocument();
  });
});
