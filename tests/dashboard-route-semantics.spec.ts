import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { DashboardChrome, resolveDashboardPathAccess } from '../apps/dashboard/src/App.js';

describe('Dashboard route and business semantics review gate', () => {
  test('distinguishes allowed, forbidden and unknown routes', () => {
    const visiblePaths = ['/', '/support', '/admin/orders'];
    expect(resolveDashboardPathAccess('/', visiblePaths, true)).toBe('ALLOWED');
    expect(resolveDashboardPathAccess('/support', visiblePaths, true)).toBe('ALLOWED');
    expect(resolveDashboardPathAccess('/security', visiblePaths, true)).toBe('FORBIDDEN');
    expect(resolveDashboardPathAccess('/admin/orders', visiblePaths, true)).toBe('ALLOWED');
    expect(resolveDashboardPathAccess('/admin/users', visiblePaths, true)).toBe('FORBIDDEN');
    expect(resolveDashboardPathAccess('/definitely-not-a-route', visiblePaths, false)).toBe('NOT_FOUND');
  });

  test('uses current readiness and append-only archive language', () => {
    const page = readFileSync('apps/dashboard/src/AdminBusinessPage.tsx', 'utf8');
    const definitions = readFileSync('apps/dashboard/src/admin-business.ts', 'utf8');
    expect(page).toContain("ACCEPTED:{blocker:'等待所有有效陪玩就绪',nextAction:'确认各有效陪玩已完成就绪'}");
    expect(page).not.toContain('等待双方就绪');
    expect(page).toContain('确认归档当前版本？');
    expect(definitions).not.toMatch(/label:\s*'删除'/u);
  });

  test('does not present a capability response as a live API health check', () => {
    const source = readFileSync('apps/dashboard/src/App.tsx', 'utf8');
    expect(source).not.toContain('API ONLINE');
    expect(source).toContain('权限已载入');
  });

  test('renders only contract-backed global search scopes and honest approval/account controls', () => {
    const html = renderToStaticMarkup(createElement(DashboardChrome, {
      appName: 'BlackCat',
      capabilities: {
        permissions: ['order.read', 'user.read', 'mfa.manage_self'],
        level: 'L2_SUPERVISOR',
        staffId: 'staff-123',
        displayRole: 'STAFF'
      },
      navigation: [{ id: 'orders', label: '订单', href: '/admin/orders' }],
      currentPath: '/',
      children: createElement('div')
    }));

    expect(html).toContain('aria-label="全局业务检索"');
    expect(html).toContain('<option value="orders">订单</option>');
    expect(html).toContain('<option value="users">用户</option>');
    expect(html).not.toContain('<option value="players">');
    expect(html).toContain('审批接口待接入');
    expect(html).toContain('账户菜单');
    expect(html).toContain('退出登录');
  });
});
