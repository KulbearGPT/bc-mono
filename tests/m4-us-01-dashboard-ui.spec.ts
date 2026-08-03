import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import {
  DashboardChrome,
  DashboardOverview
} from '../apps/dashboard/src/App.js';

const capabilities = {
  permissions: ['dashboard.view', 'staff_task.read', 'mfa.manage_self'],
  level: 'L2_SUPERVISOR',
  businessEnvironment: 'PRODUCTION' as const,
  displayRole: 'STAFF' as const,
  enabledFeatures: ['M5'] as const
};

const navigation = [
  { id: 'overview', label: '运营概览', href: '/' },
  { id: 'support', label: '客服工作台', href: '/support' },
  { id: 'security', label: '账户安全', href: '/security' }
];

describe('M4-US-01 dashboard visual shell', () => {
  test('renders an accessible branded workspace with active navigation state', () => {
    const html = renderToStaticMarkup(createElement(DashboardChrome, {
      appName: 'Blackcat Companion Dashboard',
      capabilities,
      navigation,
      currentPath: '/support',
      children: createElement('p', null, '工作区内容')
    }));

    expect(html).toContain('href="#dashboard-main"');
    expect(html).toContain('陪玩业务运营中枢');
    expect(html).toContain('生产环境');
    expect(html).toContain('L2 主管');
    expect(html).toMatch(/aria-current="page"[^>]*href="\/support"|href="\/support"[^>]*aria-current="page"/u);
    expect(html).toContain('id="dashboard-main"');
    expect(html).toContain('aria-label="管理导航"');
    expect(html).toContain('指挥中心');
    expect(html).toContain('系统治理');
    expect(html).toContain('class="status-rail"');
    expect(html).toContain('权限已载入');
  });

  test('loads the authorized metric projection for the overview instead of inventing business metrics', () => {
    const html = renderToStaticMarkup(createElement(DashboardOverview, {
      navigation
    }));

    expect(html).toContain('运营控制台');
    expect(html).toContain('正在载入运营指标');
    expect(html).toContain('客服工作台');
    expect(html).not.toContain('今日订单 12');
  });

  test('does not label an unknown runtime environment as production', () => {
    const html = renderToStaticMarkup(createElement(DashboardChrome, {
      appName: 'Blackcat Companion Dashboard',
      capabilities: { permissions: ['dashboard.view'], level: 'L1_SUPPORT' },
      navigation: navigation.slice(0, 1),
      currentPath: '/',
      children: createElement('p', null, '工作区内容')
    }));

    expect(html).toContain('环境待确认');
    expect(html).not.toContain('生产环境');
  });

  test('keeps focus, reduced-motion, touch target and responsive safeguards in the theme', () => {
    const css = readFileSync(new URL('../apps/dashboard/src/styles.css', import.meta.url), 'utf8');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('@media (max-width: 768px)');
    expect(css).toContain('--color-accent');
    expect(css).toContain('--font-display');
    expect(css).toContain('--font-mono');
    expect(css).toMatch(/\.dashboard-nav__group/u);
    expect(css).toMatch(/\.status-rail/u);
  });

  test('keeps sticky overlay headings inside the dialog content edges', () => {
    const css = readFileSync(new URL('../apps/dashboard/src/styles.css', import.meta.url), 'utf8');
    const detailHeading = css.match(/\.dashboard-overlay \.panel-heading\s*\{([^}]*)\}/u)?.[1] ?? '';
    const actionHeading = css.match(/\.dashboard-overlay \.action-panel \.panel-heading\s*\{([^}]*)\}/u)?.[1] ?? '';

    expect(detailHeading).toMatch(/margin:\s*calc\([^;]+\)\s+0\s+18px;/u);
    expect(detailHeading).toMatch(/padding:\s*18px\s+0;/u);
    expect(detailHeading).toMatch(/background:\s*transparent;/u);
    expect(detailHeading).toMatch(/backdrop-filter:\s*none;/u);
    expect(actionHeading).toMatch(/margin:\s*calc\([^;]+\)\s+0\s+22px;/u);
    expect(actionHeading).toMatch(/padding-inline:\s*0;/u);
  });
});
