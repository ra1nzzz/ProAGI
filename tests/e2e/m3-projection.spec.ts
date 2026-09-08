import { expect, test, type Page } from '@playwright/test';
import type { MarkdownProjection } from '../../src/application/projectionPort';

async function projection(page: Page, full = false): Promise<MarkdownProjection> {
  return page.evaluate(async (forceFull) => {
    const hooks = (window as unknown as { __proagiE2e: { runtime: { projectionRebuild: (full: boolean) => Promise<MarkdownProjection> } } }).__proagiE2e;
    return hooks.runtime.projectionRebuild(forceFull);
  }, full);
}

test('M3 Markdown matches full rebuild and follows canonical deletion across reload', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const target = window as unknown as { __proagiE2e: object; runtimeErrors: unknown[] };
    target.__proagiE2e = {};
    target.runtimeErrors = [];
    window.addEventListener('proagi:runtime-error', (event) => { target.runtimeErrors.push((event as CustomEvent).detail); });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '预览本地样例' }).click();
  await page.getByRole('button', { name: '确认导入' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('已持久提交');
  const first = await projection(page);
  expect(first.documentCount).toBeGreaterThan(0);
  await page.getByRole('button', { name: '接受 Insight' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('accept 已持久写入');
  const delta = await projection(page);
  expect(delta.mode).toBe('incremental');
  expect(delta.markdown).toContain('user-confirmed');
  expect((await projection(page, true)).markdown).toBe(delta.markdown);
  await page.getByRole('button', { name: '启用并重建投影' }).click();
  await expect(page.locator('.projection-preview')).toContainText('ProAGI Knowledge');
  await page.getByRole('button', { name: '导出 Markdown' }).click();
  await page.getByRole('checkbox', { name: '我确认这是一次不可逆的本地文件导出。' }).check();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '确认导出' }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('proagi-knowledge.md');
  await page.getByRole('button', { name: '删除 Insight' }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  try {
    await expect(page.locator('.domain-loop__status')).toContainText('Insight lineage 已从本地 canonical store 删除');
  } catch (error) {
    await testInfo.attach('runtime-error-codes', { body: JSON.stringify(await page.evaluate(() => (window as unknown as { runtimeErrors: unknown[] }).runtimeErrors)), contentType: 'application/json' });
    throw error;
  }
  expect((await projection(page)).documentCount).toBe(0);
  await expect(page.getByRole('button', { name: '启用并重建投影' })).toBeVisible();
  await page.getByRole('button', { name: '启用并重建投影' }).click();
  await expect(page.locator('.projection-meta')).toContainText('文档数0');
  expect((await projection(page)).documentCount).toBe(0);
  await page.reload();
  await expect(page.getByRole('button', { name: '运行 Replay' })).toBeEnabled();
  expect((await projection(page, true)).documentCount).toBe(0);
});
