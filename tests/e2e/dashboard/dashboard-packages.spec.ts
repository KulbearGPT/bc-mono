import { expect, test, type Page } from '@playwright/test';

async function openPackages(page: Page) {
  await page.goto('/__e2e/login/l3'); await page.waitForURL('**/');
  const catalogResponse = page.waitForResponse((response) => response.url().includes('/api/v1/admin/service-catalog?limit=100'));
  await page.getByRole('link', { name: '服务套餐', exact: true }).click();
  const response = await catalogResponse;
  expect((await response.json()).data.items).toHaveLength(1);
  await expect(page.getByRole('heading', { name: '服务套餐' })).toBeVisible();
}

async function fillPackage(page: Page, code: string, name: string, slots = 1) {
  await page.getByLabel('稳定代码').fill(code);
  await page.getByLabel('展示名称').fill(name);
  await page.getByLabel('套餐说明').fill('自动化测试套餐说明');
  const serviceSelects = page.locator('.package-slot-row select');
  while ((await serviceSelects.count()) < slots) await page.getByRole('button', { name: '添加陪玩席位' }).click();
  for (let index = 0; index < slots; index += 1) {
    const select = serviceSelects.nth(index);
    await expect(select.locator('option')).toHaveCount(2);
    await select.selectOption(await select.locator('option').nth(1).getAttribute('value') ?? '');
  }
  await page.getByLabel('原因码').fill('PACKAGE_VERSION_CHANGE');
}

test.describe('Dashboard browser E2E: service package versions', () => {
  test.beforeEach(async ({ request }) => { await request.post('http://127.0.0.1:3000/__e2e/reset'); });

  test('DE2E-PKG-001 ordered package slots are submitted without a client total and the API derives it atomically', async ({ page, request }) => {
    await openPackages(page); await page.getByRole('button', { name: '创建套餐版本' }).click();
    await fillPackage(page, 'E2E_DUO', 'E2E 双人套餐', 2);
    const dialog = page.getByRole('dialog', { name: '创建套餐版本操作' });
    await expect(dialog.getByText('800.0 猫条')).toBeVisible();
    await dialog.getByRole('button', { name: '提交', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => {
      const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
      return state.packageRecords.at(-1)?.code;
    }).toBe('E2E_DUO');
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    const created = state.packageRecords.at(-1);
    expect(created).toMatchObject({ code: 'E2E_DUO', defaultCustomerPriceMinor: 8000, status: 'DRAFT' });
    expect(created.slots.map((slot: { position: number }) => slot.position)).toEqual([1, 2]);
  });

  test('DE2E-PKG-002 a cross-game package is rejected as one transaction with no package append', async ({ page, request }) => {
    await openPackages(page);
    const status = await page.evaluate(async () => {
      const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('p0_csrf='))?.split('=').slice(1).join('=') ?? '';
      return (await fetch('/api/v1/admin/service-packages', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': decodeURIComponent(csrf), 'idempotency-key': 'cross-game-package' }, body: JSON.stringify({ code: 'CROSS_GAME', displayName: '非法跨游戏', description: 'invalid', currency: 'CAT', activate: false, slots: [{ serviceCatalogVersionId: '00000000-0000-0000-0000-000000000701', unitCount: 1 }, { serviceCatalogVersionId: 'catalog-other-game', unitCount: 1 }], reasonCode: 'CROSS_GAME_TEST' }) })).status;
    });
    expect(status).toBe(422);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json(); expect(state.packageRecords).toHaveLength(2);
  });

  test('DE2E-PKG-003 publishing a draft retires the prior ACTIVE version in one transition', async ({ page, request }) => {
    await openPackages(page);
    const card = page.locator('article').filter({ hasText: 'E2E 套餐新版' });
    await card.getByRole('button', { name: '发布或退役' }).click();
    await page.getByLabel('原因码').fill('PACKAGE_RELEASE');
    await page.getByRole('dialog', { name: '发布或退役操作' }).getByRole('button', { name: '提交', exact: true }).click();
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).packageRecords[1].status).toBe('ACTIVE');
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.packageRecords.map((item: { status: string }) => item.status)).toEqual(['RETIRED', 'ACTIVE']);
  });

  test('DE2E-PKG-004 concurrent publishes leave exactly one ACTIVE version', async ({ page, request }) => {
    await openPackages(page);
    const statuses = await page.evaluate(async () => {
      const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('p0_csrf='))?.split('=').slice(1).join('=') ?? '';
      const send = (key: string) => fetch('/api/v1/admin/service-packages/package-draft-v2', { method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': decodeURIComponent(csrf), 'idempotency-key': key }, body: JSON.stringify({ expectedStatus: 'DRAFT', action: 'ACTIVATE', reasonCode: 'CONCURRENT_RELEASE' }) }).then((response) => response.status);
      return Promise.all([send('package-release-a'), send('package-release-b')]);
    });
    expect(statuses.sort()).toEqual([200, 409]);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.packageRecords.filter((item: { status: string }) => item.status === 'ACTIVE')).toHaveLength(1);
  });

  test('DE2E-PKG-005 copy-edit creates a new immutable version and preserves its source', async ({ page, request }) => {
    await openPackages(page);
    const active = page.locator('article').filter({ hasText: '历史启用版本' });
    await active.getByRole('button', { name: '编辑套餐（创建新版本）' }).click();
    await page.getByLabel('展示名称').fill('E2E 套餐复制版');
    await page.getByLabel('原因码').fill('PACKAGE_COPY_EDIT');
    const dialog = page.getByRole('dialog', { name: '编辑套餐（创建新版本）操作' });
    await dialog.getByRole('button', { name: '提交', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => {
      const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
      return state.packageRecords.length;
    }).toBe(3);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.packageRecords).toHaveLength(3);
    expect(state.packageRecords[0]).toMatchObject({ displayName: 'E2E 套餐', status: 'ACTIVE' });
    expect(state.packageRecords[2]).toMatchObject({ displayName: 'E2E 套餐复制版', status: 'DRAFT' });
  });
});
