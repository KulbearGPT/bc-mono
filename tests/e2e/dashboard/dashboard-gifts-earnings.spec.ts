import { expect, test, type Page } from '@playwright/test';

async function loginAndOpen(page: Page, label: string) {
  await page.goto('/__e2e/login/l3');
  await page.waitForURL('**/');
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: label, exact: true }).click();
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
}

async function submitAction(page: Page, dialogName: string, reason: string) {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await dialog.getByLabel('原因码').fill(reason);
  await dialog.getByRole('button', { name: '提交', exact: true }).click();
}

test.describe('Dashboard browser E2E: gifts and player earnings', () => {
  test.beforeEach(async ({ request }) => { await request.post('http://127.0.0.1:3000/__e2e/reset'); });

  test('DE2E-GFT-001 create and replace preserve the old gift version while the API validates controlled category and price', async ({ page, request }) => {
    await loginAndOpen(page, '礼物目录');
    await page.getByRole('button', { name: '创建礼物' }).click();
    let dialog = page.getByRole('dialog', { name: '创建礼物操作' });
    await dialog.getByLabel('礼物名称').fill('E2E 月光礼物');
    await dialog.getByLabel('礼物分类').selectOption('tag-gift-celebration');
    await dialog.getByLabel('价格（minor units）').fill('1800');
    await dialog.getByLabel('播报模板').fill('{sender} 送给 {receiver} 月光');
    await submitAction(page, '创建礼物操作', 'GIFT_CREATE');
    await expect(page.getByText('E2E 月光礼物')).toBeVisible();

    await page.getByRole('row').filter({ hasText: 'E2E 星光礼物' }).getByRole('button', { name: '编辑礼物' }).click();
    dialog = page.getByRole('dialog', { name: '编辑礼物操作' });
    await dialog.getByLabel('礼物名称').fill('E2E 星光礼物 v2');
    await dialog.getByLabel('价格（minor units）').fill('1500');
    await submitAction(page, '编辑礼物操作', 'GIFT_SUPERSEDE');
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.giftRecords).toHaveLength(3);
    expect(state.giftRecords[0]).toMatchObject({ name: 'E2E 星光礼物', priceMinor: 1000, status: 'RETIRED' });
    expect(state.giftRecords[2]).toMatchObject({ name: 'E2E 星光礼物 v2', priceMinor: 1500, status: 'ACTIVE', version: 2 });
  });

  test('DE2E-GFT-002 archiving a historically used gift removes it from new selection without changing request snapshots', async ({ page, request }) => {
    await loginAndOpen(page, '礼物目录');
    await page.getByRole('row').filter({ hasText: 'E2E 星光礼物' }).getByRole('button', { name: '删除' }).click();
    await submitAction(page, '删除操作', 'GIFT_ARCHIVE');
    await expect(page.getByText('E2E 星光礼物')).toHaveCount(0);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
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
    await expect(page.getByText('CONFIRMED', { exact: true })).toBeVisible();
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
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
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.earningRecord).toMatchObject({ status: 'PAID', version: 3 });
    expect(state.earningPaymentWrites).toBe(1);
  });
});
