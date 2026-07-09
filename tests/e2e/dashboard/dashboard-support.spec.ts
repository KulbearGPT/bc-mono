import { expect, test, type Browser, type Page } from '@playwright/test';

const taskId = '00000000-0000-0000-0000-000000000201';

async function login(page: Page, actor: 'l1' | 'l2' = 'l1') {
  await page.goto(`/__e2e/login/${actor}`);
  await page.waitForURL('**/');
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '客服工作台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '客服工作台' })).toBeVisible();
}

async function loggedInPage(browser: Browser, actor: 'l1' | 'l2' = 'l1') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, actor);
  return { context, page };
}

test.describe('Dashboard browser E2E: support workbench', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/reset');
  });

  test('DE2E-SUP-001 all, mine, and unclaimed filters expose the correct task set', async ({ page }) => {
    await login(page);
    await expect(page.getByText('订单 P-E2E-001')).toBeVisible();
    await page.getByRole('button', { name: '我的任务' }).click();
    await expect(page.getByText('订单 P-E2E-001')).toHaveCount(0);
    await page.getByRole('button', { name: '待认领' }).click();
    await expect(page.getByText('订单 P-E2E-001')).toBeVisible();
    await page.getByRole('button', { name: '认领任务', exact: true }).click();
    await page.getByRole('button', { name: '我的任务' }).click();
    await expect(page.getByText('订单 P-E2E-001')).toBeVisible();
    await page.getByRole('button', { name: '待认领' }).click();
    await expect(page.getByText('订单 P-E2E-001')).toHaveCount(0);
  });

  test('DE2E-SUP-003 two staff sessions cannot both claim the same task version', async ({ browser, request }) => {
    const first = await loggedInPage(browser, 'l1');
    const second = await loggedInPage(browser, 'l2');
    await Promise.all([
      first.page.getByRole('button', { name: '认领任务', exact: true }).click(),
      second.page.getByRole('button', { name: '认领任务', exact: true }).click()
    ]);
    await expect.poll(async () => {
      const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
      return { status: state.tasks[0].status, version: state.tasks[0].version };
    }).toEqual({ status: 'CLAIMED', version: 2 });
    await expect.poll(async () => await first.page.getByRole('alert').count() + await second.page.getByRole('alert').count()).toBe(1);
    await first.context.close();
    await second.context.close();
  });

  test('DE2E-SUP-004 the current claimant appends a note under the authenticated actor', async ({ page, request }) => {
    await login(page);
    await page.getByRole('button', { name: '认领任务', exact: true }).click();
    await page.getByLabel('T-E2E-001 处理备注').fill('客户确认延后十五分钟开始');
    await page.getByRole('button', { name: '保存备注' }).click();
    await expect(page.getByLabel('T-E2E-001 处理备注')).toHaveValue('');
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.tasks[0].notes).toEqual(['客户确认延后十五分钟开始']);
    expect(state.auditCount).toBeGreaterThanOrEqual(2);
  });

  test('DE2E-SUP-005 a non-claimant cannot append a note and no task fact changes', async ({ browser, request }) => {
    const claimant = await loggedInPage(browser, 'l1');
    await claimant.page.getByRole('button', { name: '认领任务', exact: true }).click();
    const outsider = await loggedInPage(browser, 'l2');
    const status = await outsider.page.evaluate(async (id) => {
      const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('p0_csrf='))?.split('=').slice(1).join('=') ?? '';
      const response = await fetch(`/api/v1/admin/staff-tasks/${id}/notes`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': decodeURIComponent(csrf), 'idempotency-key': 'e2e-outsider-note' }, body: JSON.stringify({ body: '越权备注' })
      });
      return response.status;
    }, taskId);
    expect(status).toBeGreaterThanOrEqual(400);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.tasks[0].notes).toEqual([]);
    await claimant.context.close();
    await outsider.context.close();
  });

  test('DE2E-SUP-006 order and channel links retain the server-derived Guild and target IDs', async ({ page }) => {
    await login(page);
    const channel = page.getByRole('link', { name: '进入订单频道' });
    await expect(channel).toHaveAttribute('href', 'https://discord.com/channels/999999999999999999/1200000000000000011');
    await page.getByRole('button', { name: '认领任务', exact: true }).click();
    await page.getByRole('button', { name: '查看完整订单' }).click();
    await expect(page.getByRole('heading', { name: '订单 P-E2E-001' })).toBeVisible();
  });

  test('DE2E-SUP-007 staff takeover preserves the original reservation and resume revalidates current facts', async ({ page, request }) => {
    await login(page, 'l2');
    const control = async (path: 'pause' | 'resume', body: Record<string, unknown>, key: string) => page.evaluate(async ({ path, body, key, taskId }) => { const csrf = decodeURIComponent(document.cookie.split('; ').find((entry) => entry.startsWith('p0_csrf='))?.split('=').slice(1).join('=') ?? ''); const response = await fetch(`/api/v1/admin/orders/00000000-0000-0000-0000-000000000301/automation/${path}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': csrf, 'idempotency-key': key }, body: JSON.stringify({ ...body, taskId, reasonCode: 'STAFF_TAKEOVER' }) }); return { status: response.status, body: await response.json() }; }, { path, body, key, taskId });
    expect((await control('pause', { expectedOrderVersion: 3 }, 'support-takeover-pause-0001')).status).toBe(200);
    const stale = await control('resume', { expectedOrderVersion: 2, expectedAutomationVersion: 2 }, 'support-resume-stale-0001'); expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect((await control('resume', { expectedOrderVersion: 3, expectedAutomationVersion: 2 }, 'support-resume-current-0001')).status).toBe(200);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json(); expect(state.order).toMatchObject({ status: 'ACCEPTED', version: 3 }); expect(state.reservationAmountMinor).toBe(4000); expect(state.reservationCreateCount).toBe(1); expect(state.automationControl).toMatchObject({ state: 'RUNNING', version: 3, resumeValidatedOrderVersion: 3 });
  });

  test('DE2E-SUP-008 a supervisor sees an L1 claimed task and closes it without changing order or reservation facts', async ({ browser, request }) => {
    const claimant = await loggedInPage(browser, 'l1');
    await claimant.page.getByRole('button', { name: '认领任务', exact: true }).click();
    const supervisor = await loggedInPage(browser, 'l2');
    await expect(supervisor.page.getByText('订单 P-E2E-001')).toBeVisible();
    await supervisor.page.getByLabel('T-E2E-001 结案说明').fill('已完成双方沟通，底层订单处理结果已经确认。');
    await supervisor.page.getByRole('button', { name: '确认任务已完成' }).click();
    await expect(supervisor.page.getByText('订单 P-E2E-001')).toHaveCount(0);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.tasks[0]).toMatchObject({ status: 'RESOLVED', version: 3, resolutionCode: 'UNDERLYING_ACTION_COMPLETED', resolutionNote: '已完成双方沟通，底层订单处理结果已经确认。', resolvedBy: '00000000-0000-0000-0000-000000000112' });
    expect(state.order).toMatchObject({ status: 'ACCEPTED', version: 3 });
    expect(state.reservationAmountMinor).toBe(4000);
    await claimant.context.close();
    await supervisor.context.close();
  });
});
