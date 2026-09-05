import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import App from '../../src/App';

expect.extend(toHaveNoViolations);

afterEach(async () => {
  cleanup();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('proagi-insight-loop-m1-v1');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

function comesBefore(first: Element, second: Element): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('AppShell accessibility contracts', () => {
  it('has no axe violations in the empty canonical state', async () => {
    const { container } = render(<App />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('keeps the required information order and semantic landmarks', () => {
    render(<App />);

    expect(screen.getByRole('link', { name: '跳到主要内容' })).toHaveAttribute('href', '#main-content');
    const main = screen.getByRole('main');
    const privacy = within(main).getByRole('heading', { name: '仅处理本地测试事件' });
    const today = within(main).getByRole('heading', { name: 'Today' });
    const observed = within(main).getByRole('heading', { name: '我观察了什么' });
    const learned = within(main).getByRole('heading', { name: '我学到了什么' });
    const impact = within(main).getByRole('heading', { name: '你的纠正改变了什么' });
    const inbox = within(main).getByRole('heading', { name: 'Insight Inbox' });
    const replay = within(main).getByRole('heading', { name: 'Replay' });

    expect(comesBefore(privacy, today)).toBe(true);
    expect(comesBefore(today, observed)).toBe(true);
    expect(comesBefore(observed, learned)).toBe(true);
    expect(comesBefore(learned, impact)).toBe(true);
    expect(comesBefore(impact, inbox)).toBe(true);
    expect(comesBefore(inbox, replay)).toBe(true);
  });

  it('keeps approved local-sensitive body copy readable without spreading it into names or live regions', async () => {
    const { container } = render(<App />);
    const approvedBody = '在 demo-project 修改代码后运行测试';
    fireEvent.click(screen.getByRole('button', { name: '预览本地样例' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));

    expect(await screen.findByText(approvedBody, { selector: '.claim-card__statement' })).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
    const orb = screen.getByRole('button', { name: '有一条建议待审阅' });
    expect(orb).toHaveAccessibleName('有一条建议待审阅');

    for (const node of container.querySelectorAll('[aria-label], [title], [aria-live]')) {
      expect(node.getAttribute('aria-label') ?? '').not.toContain(approvedBody);
      expect(node.getAttribute('title') ?? '').not.toContain(approvedBody);
      if (node.hasAttribute('aria-live')) expect(node.textContent ?? '').not.toContain(approvedBody);
    }
  });

  it('moves focus into RecoverySurface and returns it to the invoker', () => {
    render(<App />);
    const invoker = screen.getByRole('button', { name: '查看安全模式' });
    invoker.focus();
    fireEvent.click(invoker);

    const recoveryHeading = screen.getByRole('heading', { name: '本地数据仍在恢复' });
    expect(recoveryHeading).toHaveFocus();
    const recoveryRegion = screen.getByRole('region', { name: '本地数据仍在恢复' });
    expect(recoveryRegion).toBeInTheDocument();
    expect(within(recoveryRegion).getByRole('status')).toHaveTextContent('RECOVERY ONLY');

    fireEvent.click(screen.getByRole('button', { name: '退出恢复演示' }));
    expect(invoker).toHaveFocus();
  });

  it('provides privacy, empty, stale, and blocked states without false success copy', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '暂停观察' }));
    expect(await screen.findByRole('heading', { name: '隐私模式已开启' })).toBeVisible();
    expect(screen.getByRole('button', { name: '隐私模式已开启' })).toHaveAttribute('data-state', 'PRIVATE');

    fireEvent.click(screen.getByRole('button', { name: '空状态' }));
    expect(screen.getAllByText(/测试证据不足，因此没有形成推断/)).toHaveLength(5);

    fireEvent.click(screen.getByRole('button', { name: '投影过期' }));
    expect(screen.getByRole('heading', { name: '当前摘要需要重建' })).toBeVisible();

    const blockedInvoker = screen.getByRole('button', { name: '清除受阻' });
    fireEvent.click(blockedInvoker);
    expect(screen.getByRole('heading', { name: '清除尚未完成' })).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent('数据尚未清除');
    expect(screen.queryByText('清除成功')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '退出恢复演示' }));
    expect(blockedInvoker).toHaveFocus();
  });

  it('traps detail focus, closes on Escape, and returns focus to its invoker', () => {
    render(<App />);
    const invoker = screen.getByRole('button', { name: '查看证据详情' });
    fireEvent.click(invoker);

    const dialog = screen.getByRole('dialog', { name: '证据与版本详情' });
    const close = within(dialog).getByRole('button', { name: '关闭详情' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '证据与版本详情' })).not.toBeInTheDocument();
    expect(invoker).toHaveFocus();
  });

  it('supports Move Orb keyboard mode, cancel, save, and reset', () => {
    render(<App />);
    const orb = screen.getByRole('button', { name: '有一条建议待审阅' });

    fireEvent.click(orb);
    expect(orb).toHaveAttribute('data-profile', 'active');
    fireEvent.click(screen.getByRole('button', { name: '移动球体' }));
    expect(orb).toHaveFocus();

    const startLeft = orb.closest('aside')?.getAttribute('style');
    fireEvent.keyDown(orb, { key: 'ArrowLeft', shiftKey: true });
    expect(orb.closest('aside')?.getAttribute('style')).not.toBe(startLeft);
    fireEvent.keyDown(orb, { key: 'Escape' });
    expect(screen.getByText('已取消移动，位置未更改。', { selector: '[role="status"]' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '移动球体' }));
    fireEvent.keyDown(orb, { key: 'ArrowUp' });
    fireEvent.keyDown(orb, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: '重置位置' }));
    expect(orb).not.toHaveClass('orb--moving');
  });
});
