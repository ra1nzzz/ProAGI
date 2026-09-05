import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from '../../src/App';

const REQUIRED_ORB_PARTS = [
  'shell',
  'rim',
  'fluid',
  'highlight-primary',
  'highlight-secondary',
  'base-halo',
  'shadow',
  'icon-lock',
] as const;

afterEach(cleanup);

describe('mood-board visual structure', () => {
  it('renders the seven-layer/eight-part liquid glass Orb instead of a flat circle', () => {
    const { container } = render(<App />);
    const orb = screen.getByRole('button', { name: '有一条建议待审阅' });
    const parts = orb.querySelectorAll('[data-orb-part]');

    expect(parts).toHaveLength(8);
    for (const part of REQUIRED_ORB_PARTS) {
      expect(orb.querySelectorAll(`[data-orb-part="${part}"]`)).toHaveLength(1);
    }
    expect(container.querySelector('.orb__shell')).toBeInTheDocument();
    expect(container.querySelector('.orb__fluid')).toBeInTheDocument();
    expect(container.querySelectorAll('.orb__highlight')).toHaveLength(2);
  });

  it('covers all six named states with visible non-color labels and stable state hooks', () => {
    render(<App />);
    const stateCases = [
      ['学习', 'LEARNING', '正在学习本地测试证据'],
      ['本地执行', 'EXECUTING', '正在本地导入或重放'],
      ['空闲', 'IDLE', '本地观察已就绪'],
      ['建议', 'SUGGESTION', '有一条建议待审阅'],
      ['隐私', 'PRIVATE', '隐私模式已开启'],
      ['错误', 'ERROR', '恢复需要你的处理'],
    ] as const;

    for (const [controlName, state, statusText] of stateCases) {
      fireEvent.click(screen.getByRole('button', { name: controlName }));
      const orb = screen.getByRole('button', { name: statusText });
      expect(orb).toHaveAttribute('data-state', state);
      expect(orb).toHaveClass(`orb--${state.toLowerCase()}`);
      expect(screen.getByText(statusText, { selector: '.orb__status-text' })).toBeVisible();
    }
  });

  it('keeps approved visual regions as semantic cards at both Orb profiles', () => {
    const { container } = render(<App />);
    expect(container.querySelector('.app-shell')).toBeInTheDocument();
    expect(container.querySelector('.privacy-strip')).toBeInTheDocument();
    expect(container.querySelector('.today-panel')).toBeInTheDocument();
    expect(container.querySelectorAll('.content-card')).toHaveLength(4);
    expect(container.querySelector('.replay-panel')).toBeInTheDocument();

    const orb = screen.getByRole('button', { name: '有一条建议待审阅' });
    expect(orb).toHaveAttribute('data-profile', 'quiet');
    fireEvent.click(orb);
    expect(orb).toHaveAttribute('data-profile', 'active');
    expect(screen.getByRole('button', { name: '移动球体' })).toBeInTheDocument();
    expect(screen.getByText('来源：测试事件', { selector: '.orb__source' })).toBeInTheDocument();
  });

  it('declares structural reflow, reduced-motion, and forced-colors contracts without pixel golds', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).toContain('@media (max-width: 1023px)');
    expect(css).toContain('@media (max-width: 767px)');
    expect(css).toContain('@media (max-width: 359px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('--orb-size: 26px');
    expect(css).toContain('--orb-size: 96px');
  });

  it('does not reproduce prohibited legacy branding or capability claims', () => {
    const { container } = render(<App />);
    expect(container).not.toHaveTextContent('智图灵助手');
    expect(container).not.toHaveTextContent('ProAGIAgent');
    expect(container).not.toHaveTextContent('已连接真实桌面');
    expect(container).not.toHaveTextContent('自动执行成功');
    expect(screen.getByText(/Shadow-only/)).toBeVisible();
  });
});
