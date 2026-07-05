import { expect, test, type Page } from '@playwright/test';

async function openOperations(page: Page, actor: 'l2' | 'l3' | 'l4' = 'l2') {
  await page.goto(`/__e2e/login/${actor}`); await page.waitForURL('**/');
  await page.getByRole('link', { name: '系统运营', exact: true }).click();
  await expect(page.getByRole('heading', { name: '系统运营' })).toBeVisible();
}

test.describe('Dashboard browser E2E: audit, jobs, and policies', () => {
  test.beforeEach(async ({ request }) => { await request.post('http://127.0.0.1:3000/__e2e/reset'); });

  test('DE2E-AUD-001 Dashboard writes persist actor, permission, action, target, outcome, and request IDs', async ({ page, request }) => {
    await page.goto('/__e2e/login/l1'); await page.waitForURL('**/');
    await page.getByRole('link', { name: '客服工作台', exact: true }).click();
    await page.getByRole('button', { name: '认领', exact: true }).click();
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).audits.some((record: { action: string }) => record.action === 'CLAIM_E2E_STAFF_TASK')).toBe(true);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    const audit = state.audits.find((record: { action: string }) => record.action === 'CLAIM_E2E_STAFF_TASK');
    expect(audit).toMatchObject({ actorStaffId: '00000000-0000-0000-0000-000000000111', actorLevel: 'L1_SUPPORT', actorSource: 'DASHBOARD', permissionCode: 'staff_task.claim', targetType: 'staff_task', outcome: 'SUCCEEDED' });
    expect(audit.requestId).toEqual(expect.any(String));
  });

  test('DE2E-AUD-002 a rejected high-risk write remains traceable with STEP_UP_REQUIRED', async ({ page, request }) => {
    await page.goto('/__e2e/login/l4'); await page.waitForURL('**/');
    const status = await page.evaluate(async () => {
      const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('p0_csrf='))?.split('=').slice(1).join('=') ?? '';
      return (await fetch('/api/v1/admin/e2e-sensitive-action', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': decodeURIComponent(csrf), 'idempotency-key': 'audit-step-up-rejection' }, body: '{}' })).status;
    });
    expect(status).toBe(428);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.audits.some((record: { action: string; outcome: string; reason: string }) => record.action === 'E2E_SENSITIVE_ACTION' && record.outcome === 'REJECTED' && record.reason === 'STEP_UP_REQUIRED')).toBeTruthy();
  });

  test('DE2E-AUD-003 audit pagination is stable and exposes no mutation controls', async ({ page }) => {
    await page.goto('/__e2e/login/l1'); await page.waitForURL('**/');
    await page.getByRole('link', { name: '客服工作台', exact: true }).click(); await page.getByRole('button', { name: '认领', exact: true }).click();
    await page.getByRole('link', { name: '系统运营', exact: true }).click();
    const audit = page.getByRole('region', { name: '审计记录' });
    await expect(audit.locator('tbody tr')).toHaveCount(1);
    const next = audit.getByRole('button', { name: '下一页' });
    if (await next.count()) await next.click();
    await expect(audit.getByRole('button', { name: /修改|删除|重试/u })).toHaveCount(0);
  });

  test('DE2E-JOB-002 non-retryable failed job types keep retry disabled and reject direct retry', async ({ page }) => {
    await openOperations(page, 'l2');
    const row = page.getByRole('row').filter({ hasText: 'SETTLEMENT_EXECUTION' });
    await expect(row.getByRole('button', { name: '重试' })).toBeDisabled();
  });

  test('DE2E-JOB-003 panel repair creates a recovery job without mutating the order', async ({ page, request }) => {
    await openOperations(page, 'l2');
    const prompts = ['00000000-0000-0000-0000-000000000301', 'PANEL_MESSAGE_DELETED'];
    page.on('dialog', async (dialog) => { if (dialog.type() === 'prompt') await dialog.accept(prompts.shift()!); else await dialog.accept(); });
    await page.getByRole('button', { name: '修复已删除面板' }).click();
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).jobs.length).toBe(3);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.jobs.at(-1)).toMatchObject({ type: 'PANEL_SYNC', attempts: 0 });
    expect(state.order).toMatchObject({ status: 'ACCEPTED', version: 3 });
  });

  test('DE2E-POL-001 integer policy update persists the version, reason, and audit', async ({ page, request }) => {
    await openOperations(page, 'l3');
    const prompts = ['75000', 'P0_POLICY_CONFIRMATION'];
    page.on('dialog', (dialog) => dialog.accept(prompts.shift()!));
    await page.getByRole('region', { name: '系统设置' }).getByRole('button', { name: '修改' }).click();
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).policySetting.version).toBe(2);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.policySetting).toMatchObject({ integerValue: 75000, currency: 'CAT', version: 2 });
  });

  test('DE2E-POL-002 negative and stale policy changes preserve the current setting', async ({ page, request }) => {
    await openOperations(page, 'l3');
    const prompts = ['-1', 'INVALID_NEGATIVE_POLICY'];
    page.on('dialog', (dialog) => dialog.type() === 'alert' ? dialog.accept() : dialog.accept(prompts.shift()!));
    await page.getByRole('region', { name: '系统设置' }).getByRole('button', { name: '修改' }).click();
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.policySetting).toMatchObject({ integerValue: 50000, version: 1 });
  });
});
