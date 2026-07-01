import { expect, test } from '@playwright/test';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/api/v1/auth/discord');
  await page.waitForURL('**/');
  await expect(page.getByRole('heading', { name: '运营控制台' })).toBeVisible();
}

async function loginAsSupervisor(page: import('@playwright/test').Page) {
  await page.goto('/__e2e/login/l2');
  await page.waitForURL('**/');
  await expect(page.getByRole('heading', { name: '运营控制台' })).toBeVisible();
}

test.describe('Dashboard browser E2E: authentication and support workbench', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/reset');
  });

  test('DE2E-AUTH-001 anonymous visitors receive the signed-out gate', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '登录客服管理后台' })).toBeVisible();
    await expect(page.getByRole('link', { name: /使用 Discord 登录/ })).toBeVisible();
  });

  test('DE2E-SMK-002 authenticated L1 sees server capabilities and metrics without privileged navigation', async ({ page }) => {
    await login(page);
    await expect(page.getByLabel('当前系统状态').getByText('Sandbox 环境')).toBeVisible();
    await expect(page.getByRole('heading', { name: '今日运营数据' })).toBeVisible();
    await expect(page.getByText('今日订单')).toBeVisible();
    await expect(page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '客服工作台', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '权限管理' })).toHaveCount(0);
  });

  test('DE2E-SUP-002 claim, note, and order context run through the CSRF and idempotent Dashboard client', async ({ page }) => {
    await login(page);
    await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '客服工作台', exact: true }).click();
    await expect(page.getByRole('heading', { name: '客服工作台' })).toBeVisible();
    await expect(page.getByText('T-E2E-001')).toBeVisible();
    await page.getByRole('button', { name: '认领', exact: true }).click();
    await expect(page.getByRole('button', { name: '认领', exact: true })).toHaveCount(0);
    await page.getByLabel('T-E2E-001 处理备注').fill('已联系客户并确认服务时间');
    await page.getByRole('button', { name: '保存备注' }).click();
    await expect(page.getByLabel('T-E2E-001 处理备注')).toHaveValue('');
    await page.getByRole('button', { name: '查看订单' }).click();
    await expect(page.getByRole('heading', { name: '订单 P-E2E-001' })).toBeVisible();
    await expect(page.getByText('无畏契约 · 护航')).toBeVisible();
  });

  test('DE2E-AUTH-010 a permissions version change expires the current browser session', async ({ page, request }) => {
    await login(page);
    await request.post('http://127.0.0.1:3000/__e2e/revoke-session');
    await page.reload();
    await expect(page.getByRole('heading', { name: '登录客服管理后台' })).toBeVisible();
  });

  test('DE2E-JOB-001 L2 retries an eligible failed worker job through the Dashboard CSRF and idempotency envelope', async ({ page }) => {
    await loginAsSupervisor(page);
    await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '系统运营', exact: true }).click();
    await expect(page.getByRole('heading', { name: '系统运营' })).toBeVisible();
    await expect(page.getByText('PANEL_SYNC')).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept('MANUAL_DISPLAY_RECOVERY'));
    await page.getByRole('region', { name: '失败任务' }).getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByText('PANEL_SYNC')).toHaveCount(0);
  });
});
