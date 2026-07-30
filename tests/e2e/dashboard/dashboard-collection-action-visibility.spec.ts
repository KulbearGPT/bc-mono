import { expect, test } from '@playwright/test';

const apiUrl = `http://127.0.0.1:${Number(process.env.DASHBOARD_E2E_API_PORT ?? 3000)}`;

const pages = [
  { slug: 'orders', label: '订单', cardActions: ['查看详情', '取消订单'] },
  { slug: 'users', label: '用户', cardActions: ['查看详情', '记录风险事件', '更新运营状态'] },
  { slug: 'players', label: '陪玩', cardActions: ['查看详情', '批准陪玩申请', '拒绝陪玩申请', '设置项目分成'] },
  { slug: 'service-catalog', label: '服务目录', cardActions: ['查看详情', '编辑服务项目', '删除'] },
  { slug: 'service-packages', label: '服务套餐', cardActions: ['查看详情', '编辑套餐（创建新版本）', '发布或退役'] },
  { slug: 'gift-catalog', label: '礼物目录', cardActions: ['查看详情', '编辑礼物', '删除'] },
  { slug: 'gift-requests', label: '礼物请求', cardActions: ['查看详情'] }
] as const;

test.describe('Dashboard browser E2E: collection action visibility', () => {
  test.beforeEach(async ({ request, page }) => {
    await request.post(`${apiUrl}/__e2e/reset`);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/__e2e/login/l4');
    await page.waitForURL('**/');
  });

  for (const entry of pages) {
    test(`AT-LST-004 ${entry.label} keeps allowed operations discoverable in both views`, async ({ page }) => {
      await page.goto(`/admin/${entry.slug}?view=CARD`);
      await expect(page.getByRole('heading', { name: entry.label, exact: true })).toBeVisible();

      const card = page.locator('.order-discussion-card,.business-discussion-card').first();
      const cardActions = card.getByRole('group', { name: '可用操作' });
      await expect(cardActions).toBeInViewport();
      for (const label of entry.cardActions) await expect(cardActions.getByRole('button', { name: label, exact: true })).toBeVisible();

      await page.getByRole('group', { name: '视图模式' }).getByRole('button', { name: '表格' }).click();
      const firstRow = page.locator('.collection-desktop-table tbody tr').first();
      for (const label of entry.cardActions) await expect(firstRow.getByRole('button', { name: label, exact: true })).toBeVisible();

      await page.setViewportSize({ width: 375, height: 844 });
      await page.goto(`/admin/${entry.slug}?view=CARD`);
      const mobileActions = page.locator('.collection-item-actions--card').first();
      for (const label of entry.cardActions) await expect(mobileActions.getByRole('button', { name: label, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
    });
  }
});
