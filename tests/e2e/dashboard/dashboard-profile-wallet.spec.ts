import { expect, test, type Page } from '@playwright/test';

const userId = '00000000-0000-0000-0000-000000000501';

async function openProfile(page: Page) {
  await page.goto('/__e2e/login/l2');
  await page.waitForURL('**/');
  await page.goto(`/admin/users/${userId}/profile`);
  await expect(page.getByRole('heading', { name: '客户 Profile' })).toBeVisible();
  await expect(page.getByRole('region', { name: '客户钱包' })).toBeVisible();
}

async function fillFunding(page: Page, amount: string, transactionId: string) {
  await page.getByLabel(/实收金额|扣回金额/u).fill(amount);
  await page.getByLabel('收据号 / 渠道交易号').fill(transactionId);
  await page.getByLabel(/付款时间|退款时间/u).fill('2026-08-05T10:00');
  await page.getByLabel('备注').fill('E2E 测试资金凭证已人工核对');
}

test.describe('Dashboard browser E2E: customer profile and wallet', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/reset');
  });

  test('DE2E-PRF-001 statistics window buttons request 30-day, 90-day, and all-time facts', async ({ page }) => {
    await openProfile(page);
    for (const [label, value] of [['90 天', 'DAYS_90'], ['全部', 'ALL'], ['30 天', 'DAYS_30']] as const) {
      const requestPromise = page.waitForRequest((request) => request.url().includes(`/profile-summary?window=${value}`));
      await page.getByRole('group', { name: '统计窗口' }).getByRole('button', { name: label }).click();
      await requestPromise;
      await expect(page.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
    }
  });

  test('DE2E-WLT-001 wallet summary keeps ledger, reserved, and available in one response boundary', async ({ page }) => {
    await openProfile(page);
    const wallet = page.getByRole('region', { name: '客户钱包' });
    await expect(wallet.getByText('USD 100.00')).toBeVisible();
    await expect(wallet.getByText('USD 25.00')).toBeVisible();
    await expect(wallet.getByText('USD 75.00')).toBeVisible();
  });

  test('DE2E-WLT-002 a legal USD top-up appends one entry and refreshes all balance facts', async ({ page, request }) => {
    await openProfile(page);
    await fillFunding(page, '25.50', 'receipt-e2e-001');
    await page.getByRole('button', { name: '确认充值' }).click();
    await expect(page.getByRole('cell', { name: 'MANUAL_TOP_UP' })).toBeVisible();
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.walletBalance).toMatchObject({ ledgerBalanceMinor: 12_550, reservedMinor: 2_500, availableMinor: 10_050, version: 2 });
    expect(state.walletEntries).toHaveLength(1);
    expect(state.walletEntries[0]).toMatchObject({ direction: 'CREDIT', amountMinor: 2550, sourceId: 'receipt-e2e-001' });
  });

  test('DE2E-WLT-003 invalid amounts are stopped by the browser form with zero wallet writes', async ({ page, request }) => {
    await openProfile(page);
    await fillFunding(page, '-1', 'receipt-invalid');
    const amount = page.getByLabel('实收金额（USD）');
    await page.getByRole('button', { name: '确认充值' }).click();
    await expect(amount).toBeFocused();
    expect(await amount.evaluate((element: HTMLInputElement) => element.validity.rangeUnderflow)).toBeTruthy();
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.walletEntries).toHaveLength(0);
  });

  test('DE2E-WLT-004 double-submit reuses the same idempotency key and creates one WalletEntry', async ({ page, request }) => {
    await openProfile(page);
    await fillFunding(page, '10.00', 'receipt-double');
    const submit = page.getByRole('button', { name: '确认充值' });
    await submit.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).walletEntries.length).toBe(1);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.walletBalance.ledgerBalanceMinor).toBe(11_000);
  });

  test('DE2E-WLT-006 an external cash refund appends a debit without rewriting the prior balance fact', async ({ page, request }) => {
    await openProfile(page);
    await page.getByRole('button', { name: '渠道退款扣款' }).click();
    await fillFunding(page, '10.0', 'refund-e2e-001');
    const invalidFields = await page.locator('.wallet-form').evaluate((form: HTMLFormElement) => Array.from(form.elements).filter((element) => element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement).filter((element) => !(element as HTMLInputElement).checkValidity()).map((element) => (element as HTMLInputElement).name));
    expect(invalidFields).toEqual([]);
    const responsePromise = page.waitForResponse((response) => response.url().includes('/external-refund-debits'));
    await page.getByRole('button', { name: '确认扣款' }).click();
    const response = await responsePromise;
    expect(response.status(), await response.text()).toBe(200);
    await expect(page.getByRole('cell', { name: 'EXTERNAL_REFUND_DEBIT' })).toBeVisible();
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.walletBalance).toMatchObject({ ledgerBalanceMinor: 9000, reservedMinor: 2500, availableMinor: 6500, version: 2 });
    expect(state.walletEntries[0]).toMatchObject({ direction: 'DEBIT', amountMinor: 1000 });
  });

  test('DE2E-PRF-002 order and consumption cursors paginate independently without resetting the other module', async ({ page }) => {
    await openProfile(page);
    const orders = page.locator('.profile-table').filter({ has: page.getByRole('heading', { name: '订单', exact: true }) });
    const consumptions = page.locator('.profile-table').filter({ has: page.getByRole('heading', { name: '资金明细', exact: true }) });
    await orders.getByRole('button', { name: '下一页' }).click();
    await expect(orders.getByText('P-PROFILE-002')).toBeVisible();
    await expect(consumptions.locator('tbody tr')).toHaveCount(1);
    await consumptions.getByRole('button', { name: '下一页' }).click();
    await expect(consumptions.getByText('gift-2')).toBeVisible();
    await expect(orders.locator('tbody tr')).toHaveCount(2);
  });

  test('DE2E-PRF-003 wallet failure is isolated and reports request_id while other Profile modules remain visible', async ({ page, request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/fault/wallet');
    await page.goto('/__e2e/login/l2'); await page.waitForURL('**/'); await page.goto(`/admin/users/${userId}/profile`);
    const wallet = page.getByRole('region', { name: '客户钱包' });
    await expect(wallet).toContainText('钱包模块载入失败'); await expect(wallet).toContainText(/request_id: req_/u);
    await expect(page.getByRole('heading', { name: '消费统计' })).toBeVisible();
    await expect(page.getByText('P-E2E-001')).toBeVisible();
  });

  test('DE2E-WLT-005 top-up succeeds with or without a receipt and uploaded evidence remains private metadata', async ({ page, request }) => {
    await openProfile(page); await fillFunding(page, '5.00', 'receipt-none'); await page.getByRole('button', { name: '确认充值' }).click(); await expect(page.getByRole('cell', { name: 'MANUAL_TOP_UP' })).toBeVisible();
    await fillFunding(page, '6.00', 'receipt-file');
    await page.getByLabel('Receipt 图片或 PDF（可选）').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from('private-e2e-receipt') });
    await page.getByRole('button', { name: '确认充值' }).click();
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).receiptAttachments.length).toBe(1);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json(); expect(state.walletEntries).toHaveLength(2); expect(state.receiptAttachments[0]).toMatchObject({ originalFileName: 'receipt.png', mediaType: 'image/png', private: true }); expect(JSON.stringify(state)).not.toContain('private-e2e-receipt');
  });

  test('DE2E-WLT-007 concurrent wallet-version debits allow exactly one write and never overdraw available funds', async ({ page, request }) => {
    await openProfile(page);
    const statuses = await page.evaluate(async () => { const csrf = decodeURIComponent(document.cookie.split('; ').find((entry) => entry.startsWith('p0_csrf='))?.split('=').slice(1).join('=') ?? ''); const send = (key: string) => fetch('/api/v1/admin/users/00000000-0000-0000-0000-000000000501/external-refund-debits', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': csrf, 'idempotency-key': key }, body: JSON.stringify({ amountMinor: 7000, paymentChannel: 'CASH', externalTransactionId: key, refundedAt: '2026-08-05T10:00:00.000Z', expectedWalletVersion: 1, note: '并发退款测试' }) }).then((response) => response.status); return Promise.all([send('wallet-concurrent-debit-a'), send('wallet-concurrent-debit-b')]); });
    expect(statuses.sort()).toEqual([200, 409]); const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json(); expect(state.walletEntries).toHaveLength(1); expect(state.walletBalance).toMatchObject({ ledgerBalanceMinor: 3000, availableMinor: 500, version: 2 });
  });

  test('DE2E-WLT-008 staff wallet amounts use canonical USD formatting and never customer-token formatting', async ({ page }) => {
    await openProfile(page); const wallet = page.getByRole('region', { name: '客户钱包' }); const text = await wallet.textContent(); expect(text).toContain('USD'); expect(text).not.toContain('猫条'); expect(text).not.toContain('CAT'); await expect(wallet.getByLabel('实收金额（USD）')).toBeVisible(); await page.getByRole('button', { name: '渠道退款扣款' }).click(); await expect(wallet.getByLabel('扣回金额（USD）')).toBeVisible();
  });
});
