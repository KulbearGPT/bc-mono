import { expect, test, type Page } from '@playwright/test';

async function openUsers(page: Page, actor: 'l2' | 'l3') {
  await page.goto(`/__e2e/login/${actor}`);
  await page.waitForURL('**/');
  await page.getByRole('link', { name: '用户', exact: true }).click();
  await expect(page.getByText('customer-e2e')).toBeVisible();
}

test.describe('Dashboard browser E2E: user operations', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/reset');
  });

  test('DE2E-USR-002 operational status update sends expectedVersion, reason, and audit data', async ({ page, request }) => {
    await openUsers(page, 'l3');
    await page.getByRole('button', { name: '更新运营状态' }).click();
    await page.getByLabel('目标状态').selectOption('PAUSED');
    await page.getByLabel('处理说明').fill('测试环境暂停客户服务');
    await page.getByLabel('原因码').fill('CUSTOMER_REVIEW');
    await page.getByRole('dialog', { name: '更新运营状态操作' }).getByRole('button', { name: '提交', exact: true }).click();
    await expect(page.getByText('customer-e2e')).toBeVisible();
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.user).toMatchObject({ operationalStatus: 'PAUSED', version: 3 });
    expect(state.auditCount).toBeGreaterThan(0);
  });

  test('DE2E-USR-003 risk events are append-only across repeated browser submissions', async ({ page, request }) => {
    await openUsers(page, 'l2');
    for (const notes of ['首次发现异常支付信号', '复核后追加关联账号信号']) {
      await page.getByRole('button', { name: '记录风险事件' }).click();
      await page.getByLabel('说明').fill(notes);
      await page.getByRole('dialog', { name: '记录风险事件操作' }).getByRole('button', { name: '提交', exact: true }).click();
      await expect(page.getByText('customer-e2e')).toBeVisible();
    }
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.riskEvents).toHaveLength(2);
    expect(state.riskEvents.map((event: { notes: string }) => event.notes)).toEqual(['首次发现异常支付信号', '复核后追加关联账号信号']);
  });
});
