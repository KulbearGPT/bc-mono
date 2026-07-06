import { expect, test, type Page } from '@playwright/test';

async function loginAndOpen(page: Page, label: string) {
  await page.goto('/__e2e/login/l3'); await page.waitForURL('**/');
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: label, exact: true }).click();
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
}

async function fillService(page: Page, price: string) {
  await page.getByLabel('游戏').selectOption('tag-game-valorant');
  await page.getByLabel('服务/种类').selectOption('tag-service-escort');
  await page.getByLabel('地区（可选）').selectOption('tag-region-na');
  await page.getByLabel('计费单位（分钟）').fill('60');
  await page.getByLabel('最少单位数').fill('1');
  await page.getByLabel('用户单价（minor units）').fill(price);
  await page.getByLabel('默认陪玩分成（%）').fill('60');
}

async function submit(page: Page, dialogName: string, reason: string) {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await dialog.getByLabel('原因码').fill(reason);
  await dialog.getByRole('button', { name: '提交', exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function fillTwoSeatPackage(page: Page, code: string, name: string) {
  await page.getByLabel('稳定代码').fill(code);
  await page.getByLabel('展示名称').fill(name);
  await page.getByLabel('套餐说明').fill('周末双人开黑，两个陪玩席位');
  await page.getByRole('button', { name: '添加陪玩席位' }).click();
  const selects = page.locator('.package-slot-row select');
  for (let index = 0; index < 2; index += 1) await selects.nth(index).selectOption(await selects.nth(index).locator('option').nth(1).getAttribute('value') ?? '');
}

test.describe('Dashboard browser E2E: daily catalog operations', () => {
  test.beforeEach(async ({ request }) => { await request.post('http://127.0.0.1:3000/__e2e/reset'); });

  test('DE2E-CAT-005 owner requests a price correction through a replacement version without rewriting history', async ({ page, request }) => {
    await loginAndOpen(page, '服务目录');
    await page.getByRole('button', { name: '编辑服务项目' }).click();
    await fillService(page, '4800');
    await submit(page, '编辑服务项目操作', 'OWNER_PRICE_CORRECTION');
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).catalogRecords.length).toBe(2);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.catalogRecords[0]).toMatchObject({ status: 'RETIRED', customerUnitPriceMinor: 4000, historicalReferenceCount: 1 });
    expect(state.catalogRecords[1]).toMatchObject({ status: 'ACTIVE', customerUnitPriceMinor: 4800, version: 2 });
    expect(state.order).toMatchObject({ amountMinor: 4000 });
  });

  test('DE2E-PKG-006 a two-seat weekend package is launched, revised, and published with one active version', async ({ page, request }) => {
    await loginAndOpen(page, '服务套餐');
    await page.getByRole('button', { name: '创建套餐版本' }).click();
    await fillTwoSeatPackage(page, 'WEEKEND_DUO', '周末双人开黑');
    await page.getByLabel('创建后立即发布').check();
    await submit(page, '创建套餐版本操作', 'WEEKEND_DUO_LAUNCH');
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).packageRecords.length).toBe(3);

    const active = page.getByRole('article').filter({ hasText: '周末双人开黑' });
    await active.getByRole('button', { name: '编辑套餐（创建新版本）' }).click();
    await page.getByLabel('展示名称').fill('周末双人开黑 v2');
    await page.getByLabel('原因码').fill('WEEKEND_DUO_COPY_EDIT');
    await page.getByRole('dialog', { name: '编辑套餐（创建新版本）操作' }).getByRole('button', { name: '提交', exact: true }).click();
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).packageRecords.length).toBe(4);

    const draft = page.getByRole('article').filter({ hasText: '周末双人开黑 v2' });
    await draft.getByRole('button', { name: '发布或退役' }).click();
    await submit(page, '发布或退役操作', 'WEEKEND_DUO_V2_RELEASE');
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    const versions = state.packageRecords.filter((item: { code: string }) => item.code === 'WEEKEND_DUO');
    expect(versions).toHaveLength(2);
    expect(versions.filter((item: { status: string }) => item.status === 'ACTIVE')).toHaveLength(1);
    expect(versions.map((item: { status: string }) => item.status)).toEqual(['RETIRED', 'ACTIVE']);
    expect(versions[1].slots).toHaveLength(2);
  });

  test('DE2E-GFT-005 a seasonal gift is created and archived while captured gift history stays unchanged', async ({ page, request }) => {
    await loginAndOpen(page, '礼物目录');
    await page.getByRole('button', { name: '创建礼物' }).click();
    const create = page.getByRole('dialog', { name: '创建礼物操作' });
    await create.getByLabel('礼物名称').fill('七夕限定烟花');
    await create.getByLabel('礼物分类').selectOption('tag-gift-celebration');
    await create.getByLabel('价格（minor units）').fill('2888');
    await create.getByLabel('播报模板').fill('{sender} 送给 {receiver} 七夕限定烟花');
    await submit(page, '创建礼物操作', 'SEASONAL_GIFT_LAUNCH');
    await expect(page.getByRole('cell', { name: '七夕限定烟花', exact: true })).toBeVisible();
    await page.getByRole('row').filter({ hasText: '七夕限定烟花' }).getByRole('button', { name: '删除' }).click();
    await submit(page, '删除操作', 'SEASONAL_GIFT_END');
    await expect(page.getByRole('cell', { name: '七夕限定烟花', exact: true })).toHaveCount(0);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.giftRecords.find((item: { name: string }) => item.name === '七夕限定烟花')).toMatchObject({ status: 'ARCHIVED', priceMinor: 2888 });
    expect(state.giftRequestRecords[0]).toMatchObject({ giftName: 'E2E 星光礼物', amountMinor: 1000, status: 'CAPTURED' });
  });
});
