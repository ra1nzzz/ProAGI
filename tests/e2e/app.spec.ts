import { expect, test, type CDPSession, type Page } from '@playwright/test';

async function setLifecycleState(session: CDPSession, state: 'frozen' | 'active'): Promise<void> {
  await session.send('Page.enable');
  await session.send('Page.setWebLifecycleState', { state });
}

async function installE2eHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let armed: string | null = null;
    let reached: Promise<void> = Promise.resolve();
    let signalReached: (() => void) | null = null;
    let release: (() => void) | null = null;
    (window as unknown as { __proagiE2e: Record<string, unknown> }).__proagiE2e = {
      arm(name: string) {
        armed = name;
        reached = new Promise<void>((resolve) => { signalReached = resolve; });
      },
      waitForHit() { return reached; },
      release(name: string) {
        if (armed === name) release?.();
      },
      async hit(name: string) {
        if (armed !== name) return;
        signalReached?.();
        await new Promise<void>((resolve) => { release = resolve; });
        armed = null;
        release = null;
      },
    };
  });
}

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

test('runs the consent-bound readonly flow and records its pilot evidence state', async ({ page }) => {
  await page.goto('/');
  const capturedAt = new Date().toISOString();
  const occurredAt = new Date(Date.now() - 60_000).toISOString();
  const readonlyInput = JSON.stringify({
    schemaVersion: '1.0.0', capturedAt, timezone: 'UTC', locale: 'en-US', projectAlias: 'proagi',
    events: [
      { sourceItemKey: 'change', occurredAt, kind: 'file.changed', subject: { appId: 'vscode', projectKey: 'proagi' }, attributes: { appId: 'vscode', projectKey: 'proagi', fileExt: 'ts', operation: 'modify' } },
      { sourceItemKey: 'test', occurredAt, kind: 'test.completed', subject: { appId: 'terminal', projectKey: 'proagi' }, attributes: { appId: 'terminal', projectKey: 'proagi', commandClass: 'test', testOutcome: 'passed', durationMs: 80 } },
    ],
  });
  await page.locator('[data-testid="readonly-file"]').setInputFiles({ name: 'readonly-test-results.json', mimeType: 'application/json', buffer: Buffer.from(readonlyInput) });
  const consent = page.getByRole('dialog', { name: '允许读取这份真实测试结果？' });
  await expect(consent).toBeVisible();
  await consent.getByRole('checkbox').check();
  await consent.getByRole('button', { name: '授权并预览' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('真实只读来源预览已准备');
  const consentDetails = page.locator('details.consent-details');
  await expect(consentDetails).toBeVisible();
  await consentDetails.locator('summary').click();
  await expect(consentDetails).toContainText('readonly-test-results');
  await expect(consentDetails).toContainText('local-sensitive');
  await expect(consentDetails).toContainText('事件 7 天 · 派生 30 天');
  await expect(consentDetails).toContainText('sourceItemKey');
  expect(await readStore(page, 'business')).toEqual([]);

  await page.getByRole('button', { name: '确认导入' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('真实只读来源已持久提交 2 条事件');
  const committed = await readStore(page, 'business') as Array<Record<string, unknown>>;
  expect(committed.filter((record) => record.recordType === 'behavior_event_v1')).toHaveLength(2);
  expect(committed.every((record) => typeof record.consentId === 'string' && typeof record.retentionPolicyId === 'string')).toBe(true);

  await consentDetails.getByLabel('事件保留（当前）').selectOption('1');
  await consentDetails.getByLabel('派生保留（当前）').selectOption('7');
  await consentDetails.getByRole('button', { name: '应用缩短保留期' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('保留期已缩短：事件 1 天、派生 7 天');
  await expect(consentDetails).toContainText('事件 1 天 · 派生 7 天');

  await page.getByRole('button', { name: '撤回真实来源授权' }).click();
  await expect(page.locator('.domain-loop__status')).toContainText('真实来源授权已撤回');
  expect(await readStore(page, 'business')).toEqual([]);
  expect(await readStore(page, 'system')).toEqual(expect.arrayContaining([expect.objectContaining({ recordType: 'consent_revocation_v1' })]));

  await page.getByRole('button', { name: '查看证据详情' }).click();
  const traceDialog = page.getByRole('dialog', { name: '证据与版本详情' });
  await traceDialog.getByLabel('用例').selectOption('M2.pilot');
  await traceDialog.getByLabel('步骤 token').fill('readonly-consent-revoke');
  await traceDialog.getByLabel('审核人 token').fill('e2e-reviewer');
  await traceDialog.getByLabel('结果').selectOption('NOT_RUN');
  await traceDialog.getByRole('button', { name: '写入 TRACE' }).click();
  const trace = (await readStore(page, 'audit')) as Array<Record<string, unknown>>;
  expect(trace).toEqual(expect.arrayContaining([expect.objectContaining({ recordType: 'trace_event_v1', payload: expect.objectContaining({ eventName: 'runtime.shorten-retention' }) })]));
  expect(trace).toEqual(expect.arrayContaining([expect.objectContaining({ recordType: 'trace_event_v1', payload: expect.objectContaining({ eventName: 'manual.check', manualCheck: expect.objectContaining({ caseId: 'M2.pilot', result: 'NOT_RUN' }) }) })]));

  await traceDialog.getByLabel('用例').selectOption('M4.action-decision');
  await traceDialog.getByLabel('步骤 token').fill('gate-4-decision');
  await traceDialog.getByRole('button', { name: '写入 TRACE' }).click();
  const updatedTrace = (await readStore(page, 'audit')) as Array<Record<string, unknown>>;
  expect(updatedTrace).toEqual(expect.arrayContaining([expect.objectContaining({ recordType: 'trace_event_v1', payload: expect.objectContaining({ eventName: 'manual.check', manualCheck: expect.objectContaining({ caseId: 'M4.action-decision', result: 'NOT_RUN' }) }) })]));
});

test('exports an explicitly confirmed redacted TRACE package', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '查看证据详情' }).click();
  const dialog = page.getByRole('dialog', { name: '证据与版本详情' });
  await dialog.getByLabel('步骤 token').fill('visual-approval');
  await dialog.getByLabel('审核人 token').fill('reviewer-1');
  await dialog.getByRole('button', { name: '写入 TRACE' }).click();
  await dialog.getByRole('button', { name: '准备 TRACE 诊断包' }).click();
  await expect(dialog.getByRole('group', { name: '确认导出 TRACE' })).toBeVisible();
  await dialog.getByText('我确认这是一次不可逆的本地诊断导出。').click();
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '确认导出' }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('proagi-trace.json');
  const audit = await readStore(page, 'audit') as Array<Record<string, unknown>>;
  const trace = audit.filter((record) => record.recordType === 'trace_event_v1');
  expect(trace.length).toBeGreaterThan(0);
  expect(trace).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ eventName: 'manual.check' }) })]));
  expect(JSON.stringify(trace)).not.toContain('sourceItemKey');
  expect(JSON.stringify(trace)).not.toContain('developer-day-bundled-v1');
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
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除 Insight' })).toBeFocused();
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
  await expect(page.locator('.claim-card')).toHaveCount(1);
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

test('operation-scoped response loss reconciles one durable import', async ({ page }) => {
  await installE2eHarness(page);
  await page.goto('/');
  await expect(page.locator('.domain-loop__status')).toContainText('本地 canonical store 已就绪');

  await page.evaluate(async () => {
    const harness = (window as unknown as { __proagiE2e: { runtime?: { importWithResponseLoss: () => Promise<void> } } }).__proagiE2e;
    if (!harness.runtime) throw new Error('E2E runtime bridge unavailable');
    await harness.runtime.importWithResponseLoss();
  });

  const business = await readStore(page, 'business') as Array<Record<string, unknown>>;
  const ledgers = await readStore(page, 'ledger') as Array<Record<string, unknown>>;
  expect(business.filter((record) => record.recordType === 'fixture_commit_v1')).toHaveLength(1);
  expect(ledgers).toEqual([expect.objectContaining({ committedCursor: '1' })]);
  await page.reload();
  await expect(page.locator('.domain-loop__status')).toContainText('已从本地 canonical store 恢复');
  await expect(page.getByRole('button', { name: '接受 Insight' })).toBeEnabled();
});

test('terminal deletion response loss reconciles the committed verification receipt', async ({ page }) => {
  await installE2eHarness(page);
  await page.goto('/');
  await expect(page.locator('.domain-loop__status')).toContainText('本地 canonical store 已就绪');
  await page.evaluate(async () => {
    const harness = (window as unknown as { __proagiE2e: { runtime?: { deleteWithResponseLoss?: () => Promise<void> } } }).__proagiE2e;
    if (!harness.runtime?.deleteWithResponseLoss) throw new Error('E2E deletion response-loss bridge unavailable');
    await harness.runtime.deleteWithResponseLoss();
  });
  const journal = await readStore(page, 'journal') as Array<Record<string, unknown>>;
  const system = await readStore(page, 'system') as Array<Record<string, unknown>>;
  expect(journal.filter((record) => record.recordType === 'active_deletion_journal')).toEqual([]);
  expect(journal.filter((record) => record.recordType === 'deletion_terminal')).toHaveLength(1);
  expect(system.filter((record) => record.recordType === 'deletion_verification_receipt')).toHaveLength(1);
  expect(system.filter((record) => record.recordType === 'tombstone')).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('button', { name: '接受 Insight' })).toBeDisabled();
});

test('commit TOCTOU fails closed when privacy changes after persistence', async ({ page, context }) => {
  await installE2eHarness(page);
  await page.goto('/');
  await page.getByRole('button', { name: '预览本地样例' }).click();
  await page.evaluate(() => {
    (window as unknown as { __proagiE2e: { arm: (name: string) => void } }).__proagiE2e.arm('commit:after-persisted');
  });
  await page.getByRole('button', { name: '确认导入' }).click();
  await page.evaluate(() => (window as unknown as { __proagiE2e: { waitForHit: () => Promise<void> } }).__proagiE2e.waitForHit());

  const privacyTab = await context.newPage();
  await privacyTab.goto('/');
  await privacyTab.getByRole('button', { name: '暂停观察' }).click();
  await expect(privacyTab.getByRole('heading', { name: '隐私模式已开启' })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __proagiE2e: { release: (name: string) => void } }).__proagiE2e.release('commit:after-persisted'));

  await expect(page.locator('.domain-loop__status')).toContainText('提交失败');
  expect((await readStore(page, 'business') as Array<Record<string, unknown>>).filter((record) => record.recordType === 'fixture_commit_v1')).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: '隐私模式已开启' })).toBeVisible();
  await privacyTab.close();
});

test('an in-flight durable commit survives a real Chromium frozen-to-active cycle', async ({ page, context }) => {
  await installE2eHarness(page);
  await page.goto('/');
  await page.getByRole('button', { name: '预览本地样例' }).click();
  await page.evaluate(() => (window as unknown as { __proagiE2e: { arm: (name: string) => void } }).__proagiE2e.arm('commit:after-persisted'));
  await page.getByRole('button', { name: '确认导入' }).click();
  await page.evaluate(() => (window as unknown as { __proagiE2e: { waitForHit: () => Promise<void> } }).__proagiE2e.waitForHit());

  const lifecycle = await context.newCDPSession(page);
  await setLifecycleState(lifecycle, 'frozen');
  await setLifecycleState(lifecycle, 'active');
  await page.evaluate(() => (window as unknown as { __proagiE2e: { release: (name: string) => void } }).__proagiE2e.release('commit:after-persisted'));

  await expect(page.locator('.domain-loop__status')).toContainText('已持久提交 4 条测试事件');
  expect((await readStore(page, 'business') as Array<Record<string, unknown>>).filter((record) => record.recordType === 'fixture_commit_v1')).toHaveLength(1);
});

test('a second tab releases deleted lineage before purge audit completes', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '预览本地样例' }).click();
  await page.getByRole('button', { name: '确认导入' }).click();
  await expect(page.getByRole('button', { name: '删除 Insight' })).toBeEnabled();

  const secondTab = await context.newPage();
  await installE2eHarness(secondTab);
  await secondTab.goto('/');
  await expect(secondTab.getByRole('button', { name: '删除 Insight' })).toBeEnabled();
  await expect(secondTab.locator('.domain-loop__status')).toContainText('已从本地 canonical store 恢复');

  await page.getByRole('button', { name: '删除 Insight' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除 Insight' })).toBeFocused();
  await secondTab.evaluate(() => (window as unknown as { __proagiE2e: { arm: (name: string) => void } }).__proagiE2e.arm('purge:before-release'));
  await page.getByRole('button', { name: '删除 Insight' }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await secondTab.evaluate(() => (window as unknown as { __proagiE2e: { waitForHit: () => Promise<void> } }).__proagiE2e.waitForHit());
  const lifecycle = await context.newCDPSession(secondTab);
  await page.bringToFront();
  await setLifecycleState(lifecycle, 'frozen');
  await new Promise((resolve) => setTimeout(resolve, 7_000));
  await expect.poll(async () => {
    const journals = await readStore(page, 'journal') as Array<Record<string, unknown>>;
    return journals.some((record) => record.recordType === 'active_deletion_journal' && ['PURGE_PENDING', 'AUDITING'].includes(String(record.state)));
  }).toBe(true);
  const frozenJournal = (await readStore(page, 'journal') as Array<Record<string, unknown>>).find((record) => record.recordType === 'active_deletion_journal') as { id: string; purge: { generation: string; requiredClientIds: string[] } };
  expect(frozenJournal.purge.requiredClientIds.length).toBeGreaterThan(1);
  const frozenSystem = await readStore(page, 'system') as Array<Record<string, unknown>>;
  const requiredClient = frozenSystem.find((record) => record.recordType === 'client_registration' && frozenJournal.purge.requiredClientIds.includes(String(record.clientId))) as { clientId?: string; state?: string } | undefined;
  expect(requiredClient).toBeDefined();
  expect(['ACTIVE', 'QUARANTINED']).toContain(requiredClient?.state);
  const purgeAckClientIds = new Set(frozenSystem.filter((record) => record.recordType === 'purge_ack' && record.deletionId === frozenJournal.id && record.generation === frozenJournal.purge.generation).map((record) => String(record.clientId)));
  expect(frozenJournal.purge.requiredClientIds.some((clientId) => !purgeAckClientIds.has(clientId))).toBe(true);
  expect(await page.locator('.domain-loop__status').textContent()).not.toContain('Insight lineage 已从本地 canonical store 删除');
  await setLifecycleState(lifecycle, 'active');
  await secondTab.evaluate(() => (window as unknown as { __proagiE2e: { release: (name: string) => void } }).__proagiE2e.release('purge:before-release'));
  await expect(page.locator('.domain-loop__status')).toContainText('Insight lineage 已从本地 canonical store 删除', { timeout: 15_000 });
  await expect(secondTab.locator('.domain-loop__status')).toContainText('其他标签页已完成隐私清除', { timeout: 15_000 });
  await expect(secondTab.getByRole('button', { name: '接受 Insight' })).toBeDisabled();
  await secondTab.close();
});
