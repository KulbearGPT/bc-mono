import { expect, test, type Page } from '@playwright/test';

async function openTags(page: Page) {
  await page.goto('/__e2e/login/l3'); await page.waitForURL('**/');
  await page.getByRole('link', { name: '业务标签库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '业务标签库' })).toBeVisible();
}

test.describe('Dashboard browser E2E: business tags', () => {
  test.beforeEach(async ({ request }) => { await request.post('http://127.0.0.1:3000/__e2e/reset'); });

  test('DE2E-TAG-001 create normalizes the code and disabling preserves stable id and increments version', async ({ page, request }) => {
    await openTags(page);
    await page.getByLabel('类型').selectOption('GAME');
    await page.getByLabel('稳定代码').fill('delta_force');
    await page.getByLabel('展示名称', { exact: true }).fill('三角洲行动');
    await page.getByRole('button', { name: '创建标签' }).click();
    const createdRow = page.locator('.tag-row').filter({ hasText: 'DELTA_FORCE' });
    await expect(createdRow).toContainText('v1');
    await createdRow.getByRole('button', { name: '停用' }).click();
    await expect(page.locator('.tag-row').filter({ hasText: 'DELTA_FORCE' })).toContainText('v2');
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.businessTags.at(-1)).toMatchObject({ id: 'tag-created-6', code: 'DELTA_FORCE', enabled: false, version: 2 });
  });

  test('DE2E-TAG-002 a disabled category disappears from new selections while historical gift detail keeps its snapshot', async ({ page, request }) => {
    await openTags(page);
    const categoryRow = page.locator('.tag-row').filter({ hasText: 'CELEBRATION' });
    await categoryRow.getByRole('button', { name: '停用' }).click();
    await page.getByRole('link', { name: '礼物目录', exact: true }).click();
    await page.getByRole('button', { name: '创建礼物' }).click();
    await expect(page.getByRole('dialog', { name: '创建礼物操作' }).getByLabel('礼物分类').locator('option')).toHaveCount(1);
    await page.getByRole('button', { name: '关闭' }).click();
    await page.getByRole('group', { name: '视图模式' }).getByRole('button', { name: '表格' }).click();
    await page.getByRole('row').filter({ hasText: 'E2E 星光礼物' }).getByRole('button', { name: '查看详情' }).click();
    const detail = page.getByRole('dialog', { name: '业务对象详情' });
    await expect(detail).toContainText('tag-gift-celebration');
    await expect(detail).toContainText('100.0 猫条');
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.giftRecords[0]).toMatchObject({ giftCategoryTagId: 'tag-gift-celebration', priceMinor: 1000 });
  });

  test('DE2E-TAG-003 a network failure leaves a retryable error state instead of an endless loader', async ({ page }) => {
    await page.route('**/api/v1/admin/business-tags', (route) => route.abort('connectionfailed'));
    await page.goto('/__e2e/login/l3'); await page.waitForURL('**/');
    await page.getByRole('link', { name: '业务标签库', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('业务标签库载入失败');
    await expect(page.getByRole('button', { name: '重试' })).toBeEnabled();
  });
});
