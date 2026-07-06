import { expect, test, type Page } from '@playwright/test';

const userId = '00000000-0000-0000-0000-000000000501';

async function seedDailyCustomerList(request: Parameters<Parameters<typeof test.beforeEach>[0]>[0]['request']) {
  const customers = Array.from({ length: 24 }, (_, index) => ({
    id: index === 17 ? userId : `00000000-0000-0000-0000-${String(700 + index).padStart(12, '0')}`,
    discordUserId: index === 17 ? 'customer-e2e' : `daily-customer-${String(index + 1).padStart(2, '0')}`,
    status: 'ACTIVE', operationalStatus: 'ACTIVE', version: index === 17 ? 2 : 1,
    createdAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
  }));
  const response = await request.post('http://127.0.0.1:3000/__e2e/users/bulk', { data: { customers } });
  expect(response.status()).toBe(201);
}

async function openCustomerFromDailyList(page: Page, actor: 'l2' | 'l3' = 'l2') {
  await page.goto(`/__e2e/login/${actor}`);
  await page.waitForURL('**/');
  await page.getByRole('link', { name: '用户', exact: true }).click();
  await page.getByLabel('Discord ID 或业务用户 ID').fill('customer-e2e');
  await page.getByRole('button', { name: '筛选' }).click();
  const row = page.getByRole('row').filter({ hasText: 'customer-e2e' });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: '查看详情' }).click();
  await page.getByRole('link', { name: /打开完整客户档案/u }).click();
  await expect(page.getByRole('heading', { name: '客户 Profile' })).toBeVisible();
}

async function fillFunding(page: Page, amount: string, transactionId: string, note: string) {
  await page.getByLabel(/实收金额|扣回金额/u).fill(amount);
  await page.getByLabel('收据号 / 渠道交易号').fill(transactionId);
  await page.getByLabel(/付款时间|退款时间/u).fill('2026-08-05T10:00');
  await page.getByLabel('备注').fill(note);
}

test.describe('Dashboard browser E2E: daily customer support operations', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/reset');
    await seedDailyCustomerList(request);
  });

  test('DE2E-USR-004 support searches a busy customer list and opens the exact immutable owner profile', async ({ page, request }) => {
    await openCustomerFromDailyList(page);
    await expect(page.getByText(userId, { exact: true })).toBeVisible();
    await expect(page.getByText('customer-e2e', { exact: true })).toBeVisible();
    await expect(page.locator(`input[value="${userId}"]`)).toHaveCount(0);
    await expect(page.locator('input[value="customer-e2e"]')).toHaveCount(0);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.bulkUsers).toHaveLength(24);
    expect(state.user).toMatchObject({ id: userId, discordUserId: 'customer-e2e', version: 2 });
  });

  test('DE2E-WLT-009 support verifies an offline transfer receipt and credits the owner from the Profile', async ({ page, request }) => {
    await openCustomerFromDailyList(page);
    await fillFunding(page, '25.50', 'bank-transfer-20260805-8841', '已核对银行转账截图、付款人和金额');
    await page.getByLabel('Receipt 图片或 PDF（可选）').setInputFiles({ name: 'bank-transfer.png', mimeType: 'image/png', buffer: Buffer.from('private-bank-receipt') });
    await page.getByRole('button', { name: '确认充值' }).click();
    await expect(page.getByRole('cell', { name: 'MANUAL_TOP_UP' })).toBeVisible();
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.walletBalance).toMatchObject({ ledgerBalanceMinor: 12_550, reservedMinor: 2_500, availableMinor: 10_050, version: 2 });
    expect(state.walletEntries).toHaveLength(1);
    expect(state.receiptAttachments).toEqual([expect.objectContaining({ originalFileName: 'bank-transfer.png', private: true })]);
    expect(JSON.stringify(state)).not.toContain('private-bank-receipt');
  });

  test('DE2E-USR-005 suspicious payment is escalated from an append-only risk note to an L3 service pause', async ({ page, request }) => {
    await page.goto('/__e2e/login/l2'); await page.waitForURL('**/');
    await page.getByRole('link', { name: '用户', exact: true }).click();
    await page.getByLabel('Discord ID 或业务用户 ID').fill('customer-e2e'); await page.getByRole('button', { name: '筛选' }).click();
    await page.getByRole('row').filter({ hasText: 'customer-e2e' }).getByRole('button', { name: '记录风险事件' }).click();
    await page.getByLabel('说明').fill('客服核对发现付款人与老板身份不一致，升级主管复核');
    await page.getByRole('dialog', { name: '记录风险事件操作' }).getByRole('button', { name: '提交', exact: true }).click();

    await page.goto('/__e2e/login/l3'); await page.waitForURL('**/');
    await page.getByRole('link', { name: '用户', exact: true }).click();
    await page.getByLabel('Discord ID 或业务用户 ID').fill('customer-e2e'); await page.getByRole('button', { name: '筛选' }).click();
    await page.getByRole('row').filter({ hasText: 'customer-e2e' }).getByRole('button', { name: '更新运营状态' }).click();
    await page.getByLabel('目标状态').selectOption('PAUSED');
    await page.getByLabel('处理说明').fill('等待老板补充本人付款证明');
    await page.getByLabel('原因码').fill('PAYMENT_IDENTITY_REVIEW');
    await page.getByRole('dialog', { name: '更新运营状态操作' }).getByRole('button', { name: '提交', exact: true }).click();

    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.riskEvents).toEqual([expect.objectContaining({ notes: '客服核对发现付款人与老板身份不一致，升级主管复核' })]);
    expect(state.user).toMatchObject({ operationalStatus: 'PAUSED', version: 3 });
    expect(state.auditCount).toBeGreaterThanOrEqual(2);
  });

  test('DE2E-WLT-010 support records a channel refund without rewriting reservations or another customer', async ({ page, request }) => {
    await openCustomerFromDailyList(page);
    await page.getByRole('button', { name: '渠道退款扣款' }).click();
    await fillFunding(page, '18.00', 'paypal-refund-5531', '客户临时取消，已在 PayPal 人工退款');
    await page.getByRole('button', { name: '确认扣款' }).click();
    await expect(page.getByRole('cell', { name: 'EXTERNAL_REFUND_DEBIT' })).toBeVisible();
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.walletBalance).toMatchObject({ ledgerBalanceMinor: 8_200, reservedMinor: 2_500, availableMinor: 5_700, version: 2 });
    expect(state.walletBalance.availableMinor).toBe(state.walletBalance.ledgerBalanceMinor - state.walletBalance.reservedMinor);
    expect(state.bulkUsers.filter((user: { version: number }) => user.version !== 1 && user.id !== userId)).toEqual([]);
  });
});
