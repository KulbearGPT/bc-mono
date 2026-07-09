import { expect, test } from '@playwright/test';

test.describe('Dashboard browser E2E: compatibility', () => {
  test.beforeEach(async ({ request }) => { await request.post('http://127.0.0.1:3000/__e2e/reset'); });

  test('DE2E-XBR-001 login fixture, navigation, form input, and critical write are consistent', async ({ page, browserName }) => {
    await page.goto('/__e2e/login/l1');
    await page.waitForURL('**/');
    await expect(page.getByRole('heading', { name: '运营控制台' })).toBeVisible();
    await page.getByRole('link', { name: '客服工作台', exact: true }).click();
    await page.getByRole('button', { name: '认领任务', exact: true }).click();
    const note = page.getByLabel('T-E2E-001 处理备注');
    await note.fill(`${browserName} compatibility note`);
    await page.getByRole('button', { name: '保存备注' }).click();
    await expect(note).toHaveValue('');
    await expect(page.getByRole('navigation', { name: '管理导航' })).toBeVisible();
  });
});
