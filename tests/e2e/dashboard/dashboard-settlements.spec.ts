import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const period = { periodStart: '2026-08-01T00:00:00.000Z', periodEnd: '2026-08-08T00:00:00.000Z', cutoffAt: '2026-08-08T01:00:00.000Z', timeZone: 'Asia/Shanghai', currency: 'CAT', source: 'MANUAL', playerUserIds: null };

async function login(page: Page, actor: 'l3' | 'l4' | 'l4b' = 'l3') { await page.goto(`/__e2e/login/${actor}`); await page.waitForURL('**/'); }
async function csrf(page: Page) { return decodeURIComponent((await page.context().cookies()).find((cookie) => cookie.name === 'p0_csrf')?.value ?? ''); }
async function write(page: Page, path: string, body: unknown, key: string) {
  return page.evaluate(async ({ path, body, key, csrf }) => { const response = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': csrf, 'idempotency-key': key }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }, { path, body, key, csrf: await csrf(page) });
}
async function createBatch(page: Page, high = false, suffix = '1') { return write(page, '/api/v1/admin/settlement-batches', { ...period, periodStart: high ? '2026-09-01T00:00:00.000Z' : period.periodStart }, `settlement-create-${suffix}-0001`); }
async function submitBatch(page: Page, id: string, version: number, suffix = '1') { return write(page, `/api/v1/admin/settlement-batches/${id}/submit`, { expectedVersion: version, reasonCode: 'WEEKLY_REVIEW' }, `settlement-submit-${suffix}-0001`); }
async function approveBatch(page: Page, id: string, version: number, suffix = '1') { return write(page, `/api/v1/admin/settlement-batches/${id}/approve`, { expectedVersion: version, reasonCode: 'WEEKLY_REVIEW' }, `settlement-approve-${suffix}-0001`); }
async function stepUp(page: Page, request: APIRequestContext, actor: 'l4' | 'l4b') { await page.getByRole('link', { name: '账户安全', exact: true }).click(); await page.getByRole('button', { name: '进行近期验证' }).click(); const proof = (await (await request.get(`http://127.0.0.1:3000/__e2e/totp/${actor}`)).json()).proof; await page.getByLabel('验证码或恢复码').fill(proof); await page.getByRole('button', { name: '使用验证码确认' }).click(); await expect(page.locator('.status-message')).toContainText('近期验证有效至'); }

test.describe('Dashboard browser E2E: settlements and weekly reports', () => {
  test.beforeEach(async ({ request }) => { await request.post('http://127.0.0.1:3000/__e2e/reset'); });

  test('DE2E-SET-001 an empty-period preview shows an explicit empty state and creates no batch', async ({ page, request }) => {
    await login(page); await page.getByRole('link', { name: '结算', exact: true }).click();
    await page.getByLabel('周期开始').fill('2099-01-01T00:00'); await page.getByLabel('周期结束').fill('2099-01-08T00:00'); await page.getByLabel('截止时间').fill('2099-01-08T01:00'); await page.getByRole('button', { name: '预览' }).click();
    await expect(page.getByText('当前周期没有可结算的已确认收益。')).toBeVisible();
    expect((await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).settlementBatches).toHaveLength(0);
  });

  test('DE2E-SET-002 creating and submitting a normal batch locks its trusted source facts', async ({ page, request }) => {
    await login(page); await page.getByRole('link', { name: '结算', exact: true }).click();
    await page.getByLabel('周期开始').fill('2026-08-01T00:00'); await page.getByLabel('周期结束').fill('2026-08-08T00:00'); await page.getByLabel('截止时间').fill('2026-08-08T01:00'); await page.getByRole('button', { name: '生成' }).click();
    await expect(page.getByText('DRAFT', { exact: true })).toBeVisible(); await page.getByRole('button', { name: '提交复核' }).click(); await expect(page.getByText('PENDING_REVIEW', { exact: true })).toBeVisible();
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json(); expect(state.settlementBatches[0]).toMatchObject({ sourceLocked: true, version: 2, netAmountMinor: 4000 });
  });

  test('DE2E-SET-003 a high-value batch creator cannot self-approve even with inherited L4', async ({ page, request }) => {
    await login(page, 'l4'); const created = await createBatch(page, true, 'self'); const id = created.body.data.id; await submitBatch(page, id, 1, 'self'); const rejected = await approveBatch(page, id, 2, 'self');
    expect(rejected.status).toBe(403); expect(rejected.body.error.code).toBe('SEPARATION_OF_DUTIES'); const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json(); expect(state.settlementBatches[0]).toMatchObject({ status: 'PENDING_REVIEW', approvedByStaffId: null });
  });

  test('DE2E-SET-004 a different L4 can approve the high-value batch and is recorded', async ({ page, request }) => {
    await login(page, 'l4'); const created = await createBatch(page, true, 'dual'); const id = created.body.data.id; await submitBatch(page, id, 1, 'dual'); await login(page, 'l4b'); const approved = await approveBatch(page, id, 2, 'dual-review'); expect(approved.status).toBe(200);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json(); expect(state.settlementBatches[0]).toMatchObject({ status: 'APPROVED', approvedByStaffId: '00000000-0000-0000-0000-000000000116' });
  });

  test('DE2E-SET-005 transfer CSV has a BOM, stable header, item rows, and matching total', async ({ page }) => {
    await login(page, 'l3'); const created = await createBatch(page, false, 'csv'); const id = created.body.data.id; await submitBatch(page, id, 1, 'csv'); await approveBatch(page, id, 2, 'csv');
    const response = await page.request.get(`/api/v1/admin/settlement-batches/${id}/exports/TRANSFER_LIST`, { headers: { 'x-client-source': 'DASHBOARD' } }); expect(response.status()).toBe(200); expect(response.headers()['content-type']).toContain('text/csv'); const text = await response.text(); expect(text.charCodeAt(0)).toBe(0xfeff); expect(text).toContain('settlement_item_id,player,amount_minor,currency'); expect(text).toContain('TOTAL,,4000,CAT');
  });

  test('DE2E-SET-006 selected success/failure results update only selected rows and leave others unregistered', async ({ page, request }) => {
    await login(page); const created = await createBatch(page, false, 'results'); const id = created.body.data.id; await submitBatch(page, id, 1, 'results'); await approveBatch(page, id, 2, 'results'); const result = await write(page, `/api/v1/admin/settlement-batches/${id}/payment-results`, { expectedBatchVersion: 3, results: [{ settlementItemId: 'settlement-item-1-1', expectedVersion: 1, result: 'FAILED', amountMinor: 0, currency: 'CAT', externalBatchReference: null, note: '账号核对失败' }] }, 'settlement-results-0001'); expect(result.status).toBe(200);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json(); expect(state.settlementBatches[0].items).toMatchObject([{ paymentStatus: 'FAILED', paymentNote: '账号核对失败' }, { paymentStatus: 'UNREGISTERED', version: 1 }]);
  });

  test('DE2E-SET-007 repeating a payment-result submission does not change the registered result twice', async ({ page, request }) => {
    await login(page); const created = await createBatch(page, false, 'repeat'); const id = created.body.data.id; await submitBatch(page, id, 1, 'repeat'); await approveBatch(page, id, 2, 'repeat'); const body = { expectedBatchVersion: 3, results: [{ settlementItemId: 'settlement-item-1-1', expectedVersion: 1, result: 'SUCCEEDED', amountMinor: 2500, currency: 'CAT', externalBatchReference: 'transfer-001', note: '' }] }; const first = await write(page, `/api/v1/admin/settlement-batches/${id}/payment-results`, body, 'settlement-repeat-result-0001'); const second = await write(page, `/api/v1/admin/settlement-batches/${id}/payment-results`, body, 'settlement-repeat-result-0001'); expect([first.status, second.status]).toEqual([200, 200]); const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json(); expect(state.settlementBatches[0]).toMatchObject({ version: 4 }); expect(state.settlementBatches[0].items[0]).toMatchObject({ paymentStatus: 'SUCCEEDED', version: 2 });
  });

  test('DE2E-SET-008 voiding an approved batch requires and records a valid replacement batch', async ({ page, request }) => {
    await login(page, 'l4'); await stepUp(page, request, 'l4'); const first = await createBatch(page, false, 'void-a'); const originalId = first.body.data.id; await submitBatch(page, originalId, 1, 'void-a'); await approveBatch(page, originalId, 2, 'void-a'); const replacement = await createBatch(page, false, 'void-b'); const result = await write(page, `/api/v1/admin/settlement-batches/${originalId}/void`, { expectedVersion: 3, reasonCode: 'OPERATIONS_VOID', replacementBatchId: replacement.body.data.id, replacement: { guildId, currency: 'CAT' } }, 'settlement-valid-void-0001'); expect(result.status).toBe(200); const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json(); expect(state.settlementBatches[0]).toMatchObject({ status: 'VOID', replacementBatchId: replacement.body.data.id });
  });

  test('DE2E-SET-009 cross-Guild, cross-currency, and cyclic replacements are rejected with zero void writes', async ({ page, request }) => {
    await login(page, 'l4'); await stepUp(page, request, 'l4'); const first = await createBatch(page, false, 'invalid-a'); const id = first.body.data.id; await submitBatch(page, id, 1, 'invalid-a'); await approveBatch(page, id, 2, 'invalid-a'); const replacement = await createBatch(page, false, 'invalid-b');
    for (const [suffix, replacementBody] of [['guild', { guildId: 'other-guild', currency: 'CAT' }], ['currency', { guildId, currency: 'USD' }], ['cycle', { guildId, currency: 'CAT' }]] as const) { if (suffix === 'cycle') await request.post('http://127.0.0.1:3000/__e2e/set-replacement-cycle'); const result = await write(page, `/api/v1/admin/settlement-batches/${id}/void`, { expectedVersion: 3, reasonCode: 'OPERATIONS_VOID', replacementBatchId: replacement.body.data.id, replacement: replacementBody }, `settlement-invalid-${suffix}-0001`); expect(result.status).toBe(422); }
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json(); expect(state.settlementBatches[0]).toMatchObject({ status: 'APPROVED', replacementBatchId: null, version: 3 });
  });

  test('DE2E-RPT-001 weekly report page and CSV expose identical period and canonical amount facts', async ({ page }) => {
    await login(page); await page.getByRole('link', { name: '周报', exact: true }).click(); await expect(page.getByText('R-E2E-001')).toBeVisible(); await expect(page.getByText('1,150.0 猫条 · USD 115.00')).toBeVisible(); const response = await page.request.get('/api/v1/admin/weekly-reports/weekly-report-e2e-1/export', { headers: { 'x-client-source': 'DASHBOARD' } }); expect(response.status()).toBe(200); const csv = await response.text(); expect(csv).toContain('2026-07-27,2026-08-03,10000,2000,-500,11500,CAT');
  });
});

const guildId = '999999999999999999';
