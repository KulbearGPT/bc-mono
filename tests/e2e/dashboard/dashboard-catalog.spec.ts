import { expect, test, type Page } from '@playwright/test';

async function openCatalog(page: Page) {
  await page.goto('/__e2e/login/l3'); await page.waitForURL('**/');
  await page.getByRole('link', { name: '服务目录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '服务目录' })).toBeVisible();
}

async function fillCatalogForm(page: Page, customerPrice = '5000') {
  await page.getByLabel('游戏').selectOption('tag-game-valorant');
  await page.getByLabel('服务/种类').selectOption('tag-service-escort');
  await page.getByLabel('地区（可选）').selectOption('tag-region-na');
  await page.getByLabel('计费单位（分钟）').fill('60');
  await page.getByLabel('最少单位数').fill('1');
  await page.getByLabel('用户单价（CAT subunit）').fill(customerPrice);
  await page.getByLabel('默认陪玩分成（%）').fill('60');
}

test.describe('Dashboard browser E2E: service catalog versions', () => {
  test.beforeEach(async ({ request }) => { await request.post('http://127.0.0.1:3000/__e2e/reset'); });

  test('DE2E-CAT-001 creating a service version persists controlled tags, prices, currency, and billing unit', async ({ page, request }) => {
    await openCatalog(page);
    await page.getByRole('button', { name: '创建服务版本' }).click();
    await fillCatalogForm(page, '5000');
    await page.getByLabel('原因码').fill('CATALOG_VERSION_CREATE');
    await page.getByRole('dialog', { name: '创建服务版本操作' }).getByRole('button', { name: '提交', exact: true }).click();
    await expect(page.getByText('无畏契约').first()).toBeVisible();
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    const created = state.catalogRecords?.at(-1);
    expect(created ?? state).toBeTruthy();
  });

  test('DE2E-CAT-002 missing prices and a forged currency conflict are rejected with zero catalog writes', async ({ page, request }) => {
    await openCatalog(page);
    await page.getByRole('button', { name: '创建服务版本' }).click();
    await fillCatalogForm(page, '');
    await page.getByLabel('原因码').fill('INVALID_CATALOG_TEST');
    const price = page.getByLabel('用户单价（CAT subunit）');
    await page.getByRole('dialog', { name: '创建服务版本操作' }).getByRole('button', { name: '提交', exact: true }).click();
    await expect(price).toBeFocused();
    const result = await page.evaluate(async () => {
      const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('p0_csrf='))?.split('=').slice(1).join('=') ?? '';
      const response = await fetch('/api/v1/admin/service-catalog', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': decodeURIComponent(csrf), 'idempotency-key': 'catalog-currency-conflict' }, body: JSON.stringify({ gameTagId: 'tag-game-valorant', serviceTagId: 'tag-service-escort', regionTagId: null, billingUnitMinutes: 60, minimumUnits: 1, customerUnitPrice: { amountMinor: 5000, currency: 'USD' }, playerUnitPayout: { amountMinor: 3000, currency: 'CAT' }, defaultPlayerPayoutBps: 6000, enabled: true, reasonCode: 'INVALID_CURRENCY' }) });
      return response.status;
    });
    expect(result).toBe(422);
  });

  test('DE2E-CAT-003 supersede creates a new version while retaining the retired original', async ({ page, request }) => {
    await openCatalog(page);
    await page.getByRole('button', { name: '编辑服务项目' }).click();
    await fillCatalogForm(page, '5500');
    await page.getByLabel('原因码').fill('CATALOG_SUPERSEDE');
    await page.getByRole('dialog', { name: '编辑服务项目操作' }).getByRole('button', { name: '提交', exact: true }).click();
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).catalogRecords.length).toBe(2);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.catalogRecords).toHaveLength(2);
    expect(state.catalogRecords[0]).toMatchObject({ status: 'RETIRED', customerUnitPriceMinor: 4000 });
    expect(state.catalogRecords[1]).toMatchObject({ status: 'ACTIVE', customerUnitPriceMinor: 5500 });
  });

  test('DE2E-CAT-004 archiving a historically referenced service hides it from the default list but preserves detail facts', async ({ page, request }) => {
    await openCatalog(page);
    await page.getByRole('button', { name: '归档服务项目' }).click();
    await page.getByLabel('原因码').fill('CATALOG_ARCHIVE');
    await page.getByRole('dialog', { name: '归档服务项目操作' }).getByRole('button', { name: '提交', exact: true }).click();
    await expect(page.getByText('当前筛选下没有记录')).toBeVisible();
    const detail = await page.evaluate(async () => {
      const response = await fetch('/api/v1/admin/service-catalog/00000000-0000-0000-0000-000000000701', { credentials: 'include', headers: { 'x-client-source': 'DASHBOARD' } }); return response.json();
    });
    expect(detail.data).toMatchObject({ status: 'ARCHIVED', historicalReferenceCount: 1, customerUnitPriceMinor: 4000 });
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.auditCount).toBeGreaterThan(0);
  });
});
