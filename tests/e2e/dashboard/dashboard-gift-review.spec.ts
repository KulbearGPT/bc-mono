import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, actor: 'l1' | 'l2') {
  await page.goto(`/__e2e/login/${actor}`);
  await page.waitForURL('**/');
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '客服工作台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '客服工作台' })).toBeVisible();
}

async function verifyGift(page: Page) {
  await login(page, 'l1');
  await page.getByRole('button', { name: '认领任务', exact: true }).click();
  await page.getByLabel('T-GIFT-E2E-001 礼物核验说明').fill('已在订单频道核对赠送人、接收陪玩、礼物金额和真实赠送意愿。');
  await page.getByRole('button', { name: '确认核验完成' }).click();
  await expect(page.getByLabel('T-GIFT-E2E-001 礼物核验说明')).toHaveCount(0);
}

test.describe('Dashboard browser E2E: gift review workflow', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/reset');
    await request.post('http://127.0.0.1:3000/__e2e/setup/gift-review');
  });

  test('DE2E-GFT-006 L1 verifies and L2 approves one gift using the server snapshot and existing reservation', async ({ page, request }) => {
    await verifyGift(page);
    await login(page, 'l2');
    await page.getByLabel('T-GIFT-E2E-001 礼物决定说明').fill('核验事实完整，批准捕获现有礼物预留。');
    await page.getByRole('button', { name: '批准并捕获预留' }).click();
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).giftRequestRecords[0].status).toBe('CAPTURED');
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.giftRequestRecords[0]).toMatchObject({ status: 'CAPTURED', reservationStatus: 'CAPTURED', rowVersion: 3, approvedByStaffId: '00000000-0000-0000-0000-000000000112' });
    expect(state.tasks[0]).toMatchObject({ status: 'APPROVED', version: 4 });
    expect(state.giftReservationCaptureCount).toBe(1);
    expect(state.giftReservationReleaseCount).toBe(0);
  });

  test('DE2E-GFT-007 L2 rejection releases the existing gift reservation exactly once', async ({ page, request }) => {
    await verifyGift(page);
    await login(page, 'l2');
    await page.getByLabel('T-GIFT-E2E-001 礼物决定说明').fill('客户撤回赠送意愿，拒绝并释放预留。');
    await page.getByRole('button', { name: '拒绝并释放预留' }).click();
    await expect(page.getByText('订单 P-E2E-001')).toHaveCount(0);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.giftRequestRecords[0]).toMatchObject({ status: 'REJECTED', reservationStatus: 'RELEASED', rowVersion: 3, rejectedReason: '客户撤回赠送意愿，拒绝并释放预留。' });
    expect(state.tasks[0]).toMatchObject({ status: 'REJECTED', version: 4, resolvedBy: '00000000-0000-0000-0000-000000000112' });
    expect(state.giftReservationCaptureCount).toBe(0);
    expect(state.giftReservationReleaseCount).toBe(1);
  });
});
