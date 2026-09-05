import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../../src/App';
import { BrowserInsightRuntime } from '../../src/application/browserInsightRuntime';

afterEach(async () => {
  cleanup();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('proagi-insight-loop-m1-v1');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('test database delete blocked'));
  });
});

describe('runnable Insight Loop UI', () => {
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
    expect(screen.getByText(/Replay 完成：/)).toBeVisible();
  });

  it('reconciles a lost commit response from the durable idempotency ledger', async () => {
    const runtime = new BrowserInsightRuntime();
    await runtime.previewBundled();
    await expect(runtime.commitBundled({ simulateResponseLoss: true })).resolves.toMatchObject({ acceptedCount: 4 });
    await expect(runtime.snapshot()).resolves.toMatchObject({ cursor: '1', imported: expect.any(Object) });
    runtime.close();
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
