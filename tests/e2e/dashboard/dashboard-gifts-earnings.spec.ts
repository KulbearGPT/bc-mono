import { expect, test, type Page } from '@playwright/test';

const apiUrl = `http://127.0.0.1:${Number(process.env.DASHBOARD_E2E_API_PORT ?? 3000)}`;

async function loginAndOpen(page: Page, label: string, actor = 'l3') {
  await page.goto(`/__e2e/login/${actor}`);
  await page.waitForURL('**/');
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: label, exact: true }).click();
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
  if (label === '礼物目录') await page.getByRole('group', { name: '视图模式' }).getByRole('button', { name: '表格' }).click();
}

async function submitAction(page: Page, dialogName: string, reason: string) {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await dialog.getByLabel('原因码').fill(reason);
  await dialog.getByRole('button', { name: '提交', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.describe('Dashboard browser E2E: gifts and player earnings', () => {
  test.beforeEach(async ({ request }) => { await request.post(`${apiUrl}/__e2e/reset`); });

  test('DE2E-GFT-001 create and replace preserve the old gift version while the API validates controlled category and price', async ({ page, request }) => {
    await loginAndOpen(page, '礼物目录');
    await page.getByRole('button', { name: '创建礼物' }).click();
    let dialog = page.getByRole('dialog', { name: '创建礼物操作' });
    await dialog.getByLabel('礼物名称').fill('E2E 月光礼物');
    await dialog.getByLabel('礼物分类').selectOption('tag-gift-celebration');
    await dialog.getByLabel('价格（CAT subunit）').fill('1800');
    await dialog.getByLabel('播报模板').fill('{sender} 送给 {receiver} 月光');
    await submitAction(page, '创建礼物操作', 'GIFT_CREATE');
    await expect(page.getByText('E2E 月光礼物').first()).toBeVisible();

    await page.getByRole('row').filter({ hasText: 'E2E 星光礼物' }).getByRole('button', { name: '编辑礼物' }).click();
    dialog = page.getByRole('dialog', { name: '编辑礼物操作' });
    await dialog.getByLabel('礼物名称').fill('E2E 星光礼物 v2');
    await dialog.getByLabel('价格（CAT subunit）').fill('1500');
    await submitAction(page, '编辑礼物操作', 'GIFT_SUPERSEDE');
    await expect.poll(async () => (await (await request.get(`${apiUrl}/__e2e/state`)).json()).giftRecords.length).toBe(3);
    const state = await (await request.get(`${apiUrl}/__e2e/state`)).json();
    expect(state.giftRecords[0]).toMatchObject({ name: 'E2E 星光礼物', priceMinor: 1000, status: 'RETIRED' });
    expect(state.giftRecords[2]).toMatchObject({ name: 'E2E 星光礼物 v2', priceMinor: 1500, status: 'ACTIVE', version: 2 });
  });

  test('DE2E-GFT-002 archiving a historically used gift removes it from new selection without changing request snapshots', async ({ page, request }) => {
    await loginAndOpen(page, '礼物目录');
    await page.getByRole('row').filter({ hasText: 'E2E 星光礼物' }).getByRole('button', { name: '归档礼物' }).click();
    await submitAction(page, '归档礼物操作', 'GIFT_ARCHIVE');
    await expect(page.getByText('E2E 星光礼物')).toHaveCount(0);
    const state = await (await request.get(`${apiUrl}/__e2e/state`)).json();
    expect(state.giftRecords[0]).toMatchObject({ status: 'ARCHIVED', historicalRequestCount: 1 });
    expect(state.giftRequestRecords[0]).toMatchObject({ giftName: 'E2E 星光礼物', amountMinor: 1000 });
  });

  test('DE2E-GFT-003 gift request detail contains order, both parties, review, and capture timeline facts', async ({ page }) => {
    await loginAndOpen(page, '礼物请求');
    await page.getByRole('button', { name: '查看详情' }).click();
    const detail = page.getByRole('dialog', { name: '业务对象详情' });
    await expect(detail).toContainText('P-E2E-001');
    await expect(detail).toContainText('customer-e2e');
    await expect(detail).toContainText('E2E 陪玩');
    await expect(detail).toContainText('staff-l2');
    await expect(detail).toContainText('2026-08-05T01:05:00.000Z');
    await expect(detail).toContainText('2026-08-05T01:06:00.000Z');
  });

  test('DE2E-EAR-001 confirming an earning performs the legal transition with a new version and audit', async ({ page, request }) => {
    await loginAndOpen(page, '陪玩收益');
    await page.getByRole('button', { name: '确认收益' }).click();
    await submitAction(page, '确认收益操作', 'EARNING_CONFIRM');
    await expect(page.getByText('CONFIRMED', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: '确认收益' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '标记已支付' })).toBeVisible();
    const state = await (await request.get(`${apiUrl}/__e2e/state`)).json();
    expect(state.earningRecord).toMatchObject({ status: 'CONFIRMED', version: 2 });
    expect(state.audits.some((entry: { action: string }) => entry.action === 'UPDATE_E2E_EARNING')).toBe(true);
  });

  test('DE2E-EAR-002 marking paid is idempotent and cannot append or alter payment twice', async ({ page, request }) => {
    await loginAndOpen(page, '陪玩收益');
    await page.getByRole('button', { name: '确认收益' }).click();
    await submitAction(page, '确认收益操作', 'EARNING_CONFIRM');
    const result = await page.evaluate(async () => {
      const csrf = decodeURIComponent(document.cookie.split('; ').find((part) => part.startsWith('p0_csrf='))?.split('=').slice(1).join('=') ?? '');
      const send = () => fetch('/api/v1/admin/player-earnings/00000000-0000-0000-0000-000000000706', { method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': csrf, 'idempotency-key': 'earning-paid-repeat' }, body: JSON.stringify({ expectedVersion: 2, action: 'MARK_PAID', reasonCode: 'EARNING_PAID_REPEAT' }) }).then((response) => response.status);
      return [await send(), await send()];
    });
    expect(result).toEqual([200, 200]);
    const state = await (await request.get(`${apiUrl}/__e2e/state`)).json();
    expect(state.earningRecord).toMatchObject({ status: 'PAID', version: 3 });
    expect(state.earningPaymentWrites).toBe(1);
  });

  test('AT-EAR-002 explains the L2 read-only boundary with non-executable action guidance', async ({ page }) => {
    await loginAndOpen(page, '陪玩收益', 'l2');

    const permissionNotice = page.getByRole('status').filter({ hasText: '当前为只读视图' });
    await expect(permissionNotice).toContainText('当前为只读视图');
    await expect(permissionNotice).toContainText('需要 L3+ 的收益管理权限');
    await expect(page.getByRole('button', { name: '确认收益' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '标记已支付' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '确认收益' })).toHaveAttribute('title', /earnings\.manage/u);
    await expect(page.getByRole('columnheader', { name: '操作' })).toBeVisible();
  });
});
