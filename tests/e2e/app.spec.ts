import { expect, test, type Page } from '@playwright/test';

async function readStore(page: Page, storeName: string): Promise<unknown[]> {
  return page.evaluate(async (name) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('proagi-insight-loop-m1-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        const request = database.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, storeName);
}

test('renders the canonical AppShell order and eight-part Orb', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('ProAGI Assistant');
  const headings = ['仅处理本地测试事件', 'Today', '我观察了什么', '我学到了什么', '你的纠正改变了什么', 'Insight Inbox', 'Replay'];
  let previous = -1;
  for (const name of headings) {
    const heading = page.getByRole('heading', { name });
    await expect(heading).toBeVisible();
    const top = await heading.evaluate((node) => node.getBoundingClientRect().top + window.scrollY);
    expect(top).toBeGreaterThanOrEqual(previous);
    previous = top;
  }
  await expect(page.locator('[data-orb-part]')).toHaveCount(8);
  await expect(page.locator('.orb')).toHaveAttribute('data-state', 'IDLE');
});

test('privacy mode has visible text and survives narrow reflow', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '暂停观察' }).click();
  await expect(page.getByRole('heading', { name: '隐私模式已开启' })).toBeVisible();
  await expect(page.locator('.orb')).toHaveAttribute('data-state', 'PRIVATE');
  await page.reload();
  await expect(page.getByRole('heading', { name: '隐私模式已开启' })).toBeVisible();
  await expect(page.getByRole('button', { name: '预览本地样例' })).toBeDisabled();
  expect(await readStore(page, 'meta')).toEqual([
    expect.objectContaining({ observationMode: 'PRIVATE', privacyEpoch: 1, cursor: '1' }),
  ]);
  await page.setViewportSize({ width: 320, height: 720 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('keyboard MoveOrb mode supports cancel', async ({ page }) => {
  await page.goto('/');
  const orb = page.locator('.orb');
  await orb.click();
  const before = await orb.boundingBox();
  await page.getByRole('button', { name: '移动球体' }).click();
  await orb.press('ArrowLeft');
  await orb.press('Escape');
  await expect(page.getByRole('status').filter({ hasText: '已取消移动' })).toBeAttached();
  const after = await orb.boundingBox();
  expect(after?.x).toBeCloseTo(before?.x ?? 0, 0);
});

test('runs bundled import, immutable correction, and Replay in the browser', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '预览本地样例' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('尚未提交');
  expect(await readStore(page, 'business')).toEqual([]);
  await page.getByRole('button', { name: '确认导入' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('已持久提交 4 条测试事件');
  await page.getByRole('button', { name: '接受 Insight' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('持久写入不可变 revision');
  await page.reload();
  await expect(page.locator('.domain-loop__status')).toContainText('已从本地 canonical store 恢复');
  const persisted = await readStore(page, 'business') as Array<Record<string, unknown>>;
  expect(persisted).toEqual(expect.arrayContaining([
    expect.objectContaining({ recordType: 'fixture_commit_v1' }),
    expect.objectContaining({ recordType: 'correction_record_v1' }),
    expect.objectContaining({ recordType: 'knowledge_version_v1' }),
  ]));
  expect(persisted.some((record) => record.recordType === 'correction_command_v1')).toBe(false);
  expect(await readStore(page, 'heads')).toEqual([expect.objectContaining({ recordType: 'knowledge_head_v1' })]);
  await expect(page.getByRole('button', { name: '运行 Replay' })).toBeEnabled();
  await page.getByRole('button', { name: '运行 Replay' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('Replay 完成');
});

test('accept and edit then delete closes the full claimKey lineage across reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '预览本地样例' }).click();
  await page.getByRole('button', { name: '确认导入' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('已持久提交 4 条测试事件');
  await page.getByRole('button', { name: '接受 Insight' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('accept 已持久写入不可变 revision');
  await page.getByRole('button', { name: '编辑范围' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('edit 已持久写入不可变 revision');

  const before = await readStore(page, 'business') as Array<Record<string, unknown>>;
  const claimsBefore = before.filter((record) => record.recordType === 'work_model_claim_v1');
  expect(claimsBefore.length).toBeGreaterThan(1);
  const lineageAnchors = before
    .filter((record) => ['work_model_claim_v1', 'knowledge_version_v1', 'correction_record_v1'].includes(String(record.recordType)))
    .flatMap((record) => [record.recordId, record.contentHash])
    .filter((value): value is string => typeof value === 'string');

  await page.getByRole('button', { name: '删除 Insight' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.getByRole('button', { name: '删除 Insight' }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('Insight lineage 已从本地 canonical store 删除');
  await expect(page.getByRole('button', { name: '接受 Insight' })).toBeDisabled();
  const after = await readStore(page, 'business') as Array<Record<string, unknown>>;
  expect(after.length).toBeGreaterThan(0);
  expect(after.some((record) => record.recordType === 'behavior_event_v1')).toBe(true);
  expect(after.some((record) => ['work_model_claim_v1', 'knowledge_version_v1', 'correction_record_v1', 'daily_report_snapshot_v1'].includes(String(record.recordType)))).toBe(false);
  expect(await readStore(page, 'heads')).toEqual([]);
  const serializedAfter = JSON.stringify(after);
  for (const anchor of lineageAnchors) expect(serializedAfter).not.toContain(anchor);

  await page.reload();
  await expect(page.locator('.domain-loop__status')).toContainText('已从本地 canonical store 恢复');
  await expect(page.getByRole('button', { name: '接受 Insight' })).toBeDisabled();
  await expect(page.locator('.claim-card__statement')).not.toContainText('在 demo-project 修改代码后运行测试');
  const reopened = await readStore(page, 'business') as Array<Record<string, unknown>>;
  expect(reopened.some((record) => ['work_model_claim_v1', 'knowledge_version_v1', 'correction_record_v1', 'daily_report_snapshot_v1'].includes(String(record.recordType)))).toBe(false);
  expect(await readStore(page, 'heads')).toEqual([]);
});

test('Shadow preview invokes no browser effect sink', async ({ page }) => {
  await page.addInitScript(() => {
    const effects: string[] = [];
    Object.assign(window, { __shadowEffects: effects });
    window.fetch = (() => { effects.push('fetch'); return Promise.reject(new Error('blocked by test')); }) as typeof window.fetch;
    navigator.sendBeacon = (() => { effects.push('beacon'); return false; }) as typeof navigator.sendBeacon;
    window.open = (() => { effects.push('window-open'); return null; }) as typeof window.open;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { effects.push('clipboard'); } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '预览本地样例' }).click();
  await page.getByRole('button', { name: '确认导入' }).click();
  await page.getByRole('button', { name: '预览建议' }).click();
  expect(await page.evaluate(() => (window as unknown as { __shadowEffects: string[] }).__shadowEffects)).toEqual([]);
});

test('a second tab privacy epoch fences an older preview commit', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '预览本地样例' }).click();
  await expect(page.getByRole('button', { name: '确认导入' })).toBeVisible();

  const secondTab = await context.newPage();
  await secondTab.goto('/');
  await secondTab.getByRole('button', { name: '暂停观察' }).click();
  await expect(secondTab.getByRole('heading', { name: '隐私模式已开启' })).toBeVisible();

  await page.getByRole('button', { name: '确认导入' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('提交失败');
  expect(await readStore(page, 'business')).toEqual([]);
  await secondTab.close();
});

test('a second tab releases deleted lineage before purge audit completes', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '预览本地样例' }).click();
  await page.getByRole('button', { name: '确认导入' }).click();
  await expect(page.getByRole('button', { name: '删除 Insight' })).toBeEnabled();

  const secondTab = await context.newPage();
  await secondTab.goto('/');
  await expect(secondTab.getByRole('button', { name: '删除 Insight' })).toBeEnabled();
  await expect(secondTab.locator('.domain-loop__status')).toContainText('已从本地 canonical store 恢复');

  await page.getByRole('button', { name: '删除 Insight' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.getByRole('button', { name: '删除 Insight' }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('Insight lineage 已从本地 canonical store 删除');
  await expect(secondTab.locator('.domain-loop__status')).toContainText('其他标签页已完成隐私清除');
  await expect(secondTab.getByRole('button', { name: '接受 Insight' })).toBeDisabled();
  await secondTab.close();
});
