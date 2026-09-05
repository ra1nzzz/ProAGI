import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('captures the required AppShell and Orb evidence case', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: '预览本地样例' }).click();
  await page.getByRole('button', { name: '确认导入' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('已持久提交 4 条测试事件');
  await page.locator('.orb').click();
  await expect(page.getByRole('button', { name: '移动球体' })).toBeInViewport();
  await mkdir('test-results/visual', { recursive: true });
  await page.screenshot({ path: `test-results/visual/${testInfo.project.name}.png`, fullPage: true, animations: 'disabled' });
});
