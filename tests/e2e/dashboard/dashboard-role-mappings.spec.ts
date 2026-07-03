import { expect, test, type Page } from '@playwright/test';

async function stepUpL4(page: Page, request: import('@playwright/test').APIRequestContext) {
  await page.goto('/__e2e/login/l4'); await page.waitForURL('**/');
  await page.getByRole('link', { name: '账户安全', exact: true }).click();
  await page.getByRole('button', { name: '进行近期验证' }).click();
  const proof = (await (await request.get('http://127.0.0.1:3000/__e2e/totp/l4')).json()).proof as string;
  await page.getByLabel('验证码或恢复码').fill(proof);
  await page.getByRole('button', { name: '使用验证码确认' }).click();
  await expect(page.locator('.status-message')).toContainText('近期验证有效至');
}

test.describe('Dashboard browser E2E: Discord Role mappings', () => {
  test.beforeEach(async ({ request }) => { await request.post('http://127.0.0.1:3000/__e2e/reset'); });

  test('DE2E-ROL-001 updating a mapping requires L4 step-up and increments version with reconciliation and audit', async ({ page, request }) => {
    await page.goto('/__e2e/login/l4'); await page.waitForURL('**/');
    await page.getByRole('link', { name: '权限管理', exact: true }).click();
    await expect(page.getByRole('heading', { name: '需要完成二次验证' })).toBeVisible();
    await stepUpL4(page, request);
    await page.getByRole('link', { name: '权限管理', exact: true }).click();
    await expect(page.getByRole('heading', { name: '权限管理' })).toBeVisible();
    await page.getByLabel('Discord Role ID').fill('role-e2e-l4-updated');
    await page.getByRole('button', { name: '更新映射' }).click();
    await expect(page.locator('.status-notice')).toContainText('Role 映射已更新');
    await expect(page.getByText('映射版本 v2')).toBeVisible();
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.roleMapping).toMatchObject({ discordRoleId: 'role-e2e-l4-updated', version: 2, reconciliationQueued: true });
    expect(state.audits.some((entry: { action: string }) => entry.action === 'UPDATE_E2E_ROLE_MAPPING')).toBe(true);
  });

  test('DE2E-ROL-002 a client-reported highest Discord Role never changes the internally approved effective level', async ({ page }) => {
    await page.goto('/__e2e/login/l1'); await page.waitForURL('**/');
    const result = await page.evaluate(async () => {
      const response = await fetch('/api/v1/admin/me/capabilities', { credentials: 'include', headers: { 'x-client-source': 'DASHBOARD', 'x-discord-role-id': 'role-e2e-l4', 'x-actor-level': 'L4_ADMIN_OWNER' } });
      return { status: response.status, body: await response.json() };
    });
    expect(result.status).toBe(200);
    expect(result.body.data.level).toBe('L1_SUPPORT');
    expect(result.body.data.permissions).not.toContain('access.manage');
    await expect(page.getByRole('link', { name: '权限管理', exact: true })).toHaveCount(0);
  });
});
