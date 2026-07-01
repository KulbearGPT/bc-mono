import { expect, test, type Page } from '@playwright/test';

async function loginAs(page: Page, actor: 'l1' | 'l2' | 'l3' | 'l4') {
  await page.goto(`/__e2e/login/${actor}`);
  await page.waitForURL('**/');
  await expect(page.getByRole('heading', { name: '运营控制台' })).toBeVisible();
}

test.describe('Dashboard browser E2E: shell and security boundaries', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/reset');
  });

  test('DE2E-SMK-001 API health and Dashboard shell become ready without browser errors', async ({ page, request }) => {
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    const health = await request.get('http://127.0.0.1:3000/health');
    expect(health.ok()).toBeTruthy();
    await loginAs(page, 'l1');
    await expect(page.getByRole('main')).toBeVisible();
    expect(browserErrors).toEqual([]);
  });

  test('DE2E-SMK-003 browser navigation, back, forward, and refresh preserve the active route', async ({ page }) => {
    await loginAs(page, 'l2');
    await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '系统运营', exact: true }).click();
    await expect(page).toHaveURL(/\/operations$/u);
    await expect(page.getByRole('heading', { name: '系统运营' })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/$/u);
    await page.goForward();
    await expect(page.getByRole('link', { name: '系统运营', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.reload();
    await expect(page.getByRole('heading', { name: '系统运营' })).toBeVisible();
  });

  test('DE2E-AUTH-003 L1-L4 navigation is cumulative and derived from server capabilities', async ({ browser }) => {
    const expectations = {
      l1: { visible: ['客服工作台', '系统运营'], hidden: ['服务目录', '权限管理'] },
      l2: { visible: ['客服工作台', '系统运营', '服务目录'], hidden: ['权限管理'] },
      l3: { visible: ['客服工作台', '系统运营', '服务目录'], hidden: ['权限管理'] },
      l4: { visible: ['客服工作台', '系统运营', '服务目录', '权限管理'], hidden: [] }
    } as const;
    for (const actor of ['l1', 'l2', 'l3', 'l4'] as const) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginAs(page, actor);
      const nav = page.getByRole('navigation', { name: '管理导航' });
      for (const label of expectations[actor].visible) await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
      for (const label of expectations[actor].hidden) await expect(nav.getByRole('link', { name: label, exact: true })).toHaveCount(0);
      await context.close();
    }
  });

  test('DE2E-AUTH-004 forged actor and role headers do not create an authenticated actor', async ({ request }) => {
    const response = await request.get('http://127.0.0.1:3000/api/v1/admin/staff-tasks', {
      headers: {
        'x-actor-level': 'L4_ADMIN_OWNER',
        'x-actor-staff-id': '00000000-0000-0000-0000-000000000114',
        'x-actor-guild-id': '999999999999999999'
      }
    });
    expect(response.status()).toBe(401);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.tasks[0]).toMatchObject({ status: 'OPEN', version: 1 });
  });

  test('DE2E-AUTH-005 a Dashboard write without CSRF is rejected with zero mutation', async ({ page }) => {
    await loginAs(page, 'l1');
    const status = await page.evaluate(async () => {
      const response = await fetch('/api/v1/admin/staff-tasks/00000000-0000-0000-0000-000000000201/claim', {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e-no-csrf', 'x-client-source': 'DASHBOARD' }, body: JSON.stringify({ expectedVersion: 1 })
      });
      return response.status;
    });
    expect(status).toBe(403);
    const state = await (await page.request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.tasks[0]).toMatchObject({ status: 'OPEN', version: 1 });
  });

  test('DE2E-AUTH-006 a permissions-version downgrade invalidates the old session', async ({ page, request }) => {
    await loginAs(page, 'l1');
    await request.post('http://127.0.0.1:3000/__e2e/revoke-session');
    const response = await page.request.get('/api/v1/admin/staff-tasks');
    expect(response.status()).toBe(401);
    await page.reload();
    await expect(page.getByRole('heading', { name: '登录客服管理后台' })).toBeVisible();
  });

  test('DE2E-AUTH-007 client-supplied Guild filters cannot expose another Guild task', async ({ page }) => {
    await loginAs(page, 'l1');
    const result = await page.evaluate(async () => {
      const response = await fetch('/api/v1/admin/staff-tasks?guildId=888888888888888888', { credentials: 'include', headers: { 'x-client-source': 'DASHBOARD' } });
      return { status: response.status, body: await response.json() };
    });
    expect(result.status).toBe(200);
    const body = result.body;
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({ guildId: '999999999999999999', publicId: 'T-E2E-001' });
    expect(JSON.stringify(body)).not.toContain('888888888888888888');
  });
});
