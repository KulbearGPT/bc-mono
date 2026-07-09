import { expect, test, type Page } from '@playwright/test';

async function loginAs(page: Page, actor: 'l1' | 'l2' | 'l3') {
  await page.goto(`/__e2e/login/${actor}`);
  await page.waitForURL('**/');
  await expect(page.getByRole('heading', { name: '运营控制台' })).toBeVisible();
}

async function openWorkspace(page: Page, label: string) {
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: label, exact: true }).click();
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
}

test.describe('Dashboard browser E2E: business read paths', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/reset');
  });

  test('DE2E-ORD-001 order filtering and cursor pagination return stable non-duplicated rows', async ({ page }) => {
    await loginAs(page, 'l1');
    await openWorkspace(page, '订单');
    await expect(page.getByText('P-E2E-001')).toBeVisible();
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(page.getByText('P-E2E-002')).toBeVisible();
    await expect(page.getByText('P-E2E-001')).toHaveCount(0);
    await page.getByLabel('订单号或用户标识').fill('P-E2E-001');
    await page.getByRole('button', { name: '筛选' }).click();
    await expect(page.getByText('P-E2E-001')).toBeVisible();
    await expect(page.getByText('P-E2E-002')).toHaveCount(0);
    await page.getByLabel('订单号或用户标识').fill('');
    await page.getByLabel('订单状态').fill('COMPLETED');
    await page.getByRole('button', { name: '筛选' }).click();
    await expect(page.getByText('P-E2E-002')).toBeVisible();
  });

  test('DE2E-ORD-002 order detail is loaded from its detail endpoints', async ({ page }) => {
    await loginAs(page, 'l1');
    await openWorkspace(page, '订单');
    await page.getByRole('button', { name: '查看详情' }).click();
    const detail = page.getByRole('dialog', { name: '业务对象详情' });
    await expect(detail.getByText('P-E2E-001')).toBeVisible();
    await expect(detail.getByText('ORDER_ACCEPTED')).toBeVisible();
    await expect(detail.getByText('已接单', { exact: true }).first()).toBeVisible();
  });

  test('DE2E-ORD-003 order timeline appends the next cursor in stable event order', async ({ page }) => {
    await loginAs(page, 'l1');
    await openWorkspace(page, '订单');
    await page.getByRole('button', { name: '查看详情' }).click();
    const timeline = page.getByRole('region', { name: '交易时间线' });
    await expect(timeline.getByText('ORDER_ACCEPTED')).toBeVisible();
    await timeline.getByRole('button', { name: '加载更多记录' }).click();
    await expect(timeline.getByText('FUND_RESERVED')).toBeVisible();
    const rows = timeline.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('ORDER_ACCEPTED');
    await expect(rows.nth(1)).toContainText('FUND_RESERVED');
  });

  test('DE2E-USR-001 user search and detail expose business identity without external payment credentials', async ({ page }) => {
    await loginAs(page, 'l2');
    await openWorkspace(page, '用户');
    await page.getByLabel('Discord ID 或业务用户 ID').fill('customer-e2e');
    await page.getByRole('button', { name: '筛选' }).click();
    await expect(page.getByText('customer-e2e')).toBeVisible();
    await page.getByRole('button', { name: '查看详情' }).click();
    const detail = page.getByRole('dialog', { name: '业务对象详情' });
    await expect(detail.getByText('customer-e2e')).toBeVisible();
    const text = await detail.textContent();
    expect(text).not.toMatch(/cardNumber|paymentPassword|paypalSecret/iu);
  });

  test('DE2E-GFT-004 lower-level gift request reads omit reservation and idempotency secrets', async ({ page }) => {
    await loginAs(page, 'l1');
    await openWorkspace(page, '礼物请求');
    await expect(page.getByText('G-E2E-001')).toBeVisible();
    const text = await page.getByRole('main').textContent();
    expect(text).not.toMatch(/reservationId|idempotencyKey|reservedMinor/iu);
  });

  test('DE2E-REF-001 commission list keeps the source customer masked', async ({ page }) => {
    await loginAs(page, 'l3');
    await openWorkspace(page, '返佣');
    await expect(page.getByText('用户 ••••0011').first()).toBeVisible();
    const text = await page.getByRole('main').textContent();
    expect(text).not.toContain('customer-e2e');
    expect(text).not.toContain('customer-second');
  });
});
