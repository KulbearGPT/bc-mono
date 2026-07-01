import { expect, test, type Page } from '@playwright/test';

async function openCancellation(page: Page) {
  await page.goto('/__e2e/login/l2');
  await page.waitForURL('**/');
  await page.getByRole('link', { name: '订单', exact: true }).click();
  await expect(page.getByText('P-E2E-001')).toBeVisible();
  await page.getByRole('button', { name: '取消订单' }).click();
  await page.getByLabel('核对证据与处理说明').fill('已核对订单频道、服务进度与客户取消请求');
}

test.describe('Dashboard browser E2E: order mutations', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/reset');
  });

  test('DE2E-ORD-004 a legal cancellation atomically updates status, reservation, and audit facts', async ({ page, request }) => {
    await openCancellation(page);
    await page.getByRole('dialog', { name: '取消订单操作' }).getByRole('button', { name: '提交', exact: true }).click();
    await expect(page.getByText('P-E2E-001')).toBeVisible();
    await expect(page.getByText('已取消')).toBeVisible();
    await expect(page.getByRole('button', { name: '取消订单' })).toHaveCount(0);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.order).toMatchObject({ status: 'CANCELLED', version: 4 });
    expect(state.orderResolutionCount).toBe(1);
    expect(state.auditCount).toBeGreaterThan(0);
  });

  test('DE2E-ORD-006 consecutive submit events reuse one idempotent write', async ({ page, request }) => {
    await openCancellation(page);
    const submit = page.getByRole('dialog', { name: '取消订单操作' }).getByRole('button', { name: '提交', exact: true });
    await submit.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).order.status).toBe('CANCELLED');
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.orderResolutionCount).toBe(1);
    expect(state.order.version).toBe(4);
  });

  test('DE2E-ORD-007 a stale expectedVersion returns 409 and preserves the latest order', async ({ page, request }) => {
    await page.goto('/__e2e/login/l2');
    await page.waitForURL('**/');
    const result = await page.evaluate(async () => {
      const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('p0_csrf='))?.split('=').slice(1).join('=') ?? '';
      const response = await fetch('/api/v1/admin/orders/00000000-0000-0000-0000-000000000301/resolve', {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': decodeURIComponent(csrf), 'idempotency-key': 'stale-order-resolution' },
        body: JSON.stringify({ expectedVersion: 2, targetStatus: 'CANCELLED', reasonCode: 'USER_REQUEST', refund: { amountMinor: 4000, currency: 'USD' }, playerEarning: { amountMinor: 0, currency: 'USD' }, evidenceNote: 'stale browser request', confirmation: 'EXECUTE_OR_REQUEST_APPROVAL' })
      });
      return { status: response.status, body: await response.json() };
    });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('VERSION_CONFLICT');
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.order).toMatchObject({ status: 'ACCEPTED', version: 3 });
    expect(state.orderResolutionCount).toBe(0);
  });
});
