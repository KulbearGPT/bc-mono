import { expect, test, type Page } from '@playwright/test';

async function loginAs(page: Page, actor: 'l1' | 'l2' = 'l1') {
  await page.goto(`/__e2e/login/${actor}`);
  await page.waitForURL('**/');
  await expect(page.getByRole('heading', { name: '运营控制台' })).toBeVisible();
}

test.describe('Dashboard browser E2E: resilience and accessibility', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/reset');
  });

  test('DE2E-SMK-004 server error states render a diagnostic request_id instead of a blank page', async ({ page, request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/fault/order');
    await loginAs(page, 'l1');
    await page.getByRole('link', { name: '订单', exact: true }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('数据暂时无法载入');
    await expect(alert).toContainText(/request_id:/u);
    await expect(page.getByRole('button', { name: '重试' })).toBeVisible();
  });

  test('DE2E-RES-002 a browser network failure keeps the page usable and exposes retry feedback', async ({ page }) => {
    await loginAs(page, 'l1');
    await page.route('**/api/v1/admin/orders?**', (route) => route.abort('connectionfailed'));
    await page.getByRole('link', { name: '订单', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('数据暂时无法载入');
    await expect(page.getByRole('button', { name: '重试' })).toBeEnabled();
    await expect(page.getByRole('navigation', { name: '管理导航' })).toBeVisible();
  });

  test('DE2E-ACC-001 critical navigation and claim actions are keyboard operable and dialogs receive focus', async ({ page }) => {
    await loginAs(page, 'l2');
    const supportLink = page.getByRole('link', { name: '客服工作台', exact: true });
    await supportLink.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: '客服工作台' })).toBeVisible();
    const claim = page.getByRole('button', { name: '认领', exact: true });
    await claim.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('T-E2E-001 处理备注')).toBeVisible();

    await page.getByRole('link', { name: '订单', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: '取消订单' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: '取消订单操作' });
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('DE2E-ACC-002 required form errors retain accessible labels and focus the invalid field', async ({ page }) => {
    await loginAs(page, 'l2');
    await page.getByRole('link', { name: '订单', exact: true }).click();
    await page.getByRole('button', { name: '取消订单' }).click();
    const evidence = page.getByLabel('核对证据与处理说明');
    await expect(evidence).toHaveAttribute('required', '');
    await page.getByRole('dialog', { name: '取消订单操作' }).getByRole('button', { name: '提交', exact: true }).click();
    await expect(evidence).toBeFocused();
    expect(await evidence.evaluate((element: HTMLTextAreaElement) => element.validity.valueMissing)).toBeTruthy();
  });

  test('DE2E-UI-001 key controls remain inside the viewport at supported desktop sizes', async ({ page }) => {
    for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(viewport);
      await loginAs(page, 'l1');
      const heading = page.getByRole('heading', { name: '运营控制台' });
      const support = page.getByRole('link', { name: '客服工作台', exact: true });
      for (const locator of [heading, support]) {
        const box = await locator.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      }
    }
  });
});
