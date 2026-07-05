import { expect, test, type Browser, type Page } from '@playwright/test';

const playerId = '00000000-0000-0000-0000-000000000601';

async function openPlayers(page: Page) {
  await page.goto('/__e2e/login/l3');
  await page.waitForURL('**/');
  await page.getByRole('link', { name: '陪玩', exact: true }).click();
  await expect(page.getByText('E2E 陪玩')).toBeVisible();
}

async function approve(page: Page) {
  await page.getByRole('button', { name: '批准陪玩申请' }).click();
  await page.getByLabel(/无畏契约 · VALORANT/u).check();
  await page.getByLabel(/护航 · ESCORT/u).check();
  await page.getByLabel(/中文 · ZH_CN/u).check();
  await page.getByLabel('原因码').fill('ONBOARDING_APPROVED');
  const dialog = page.getByRole('dialog', { name: '批准陪玩申请操作' });
  await dialog.getByRole('button', { name: '提交', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('已批准')).toBeVisible();
}

async function actorPage(browser: Browser) {
  const context = await browser.newContext(); const page = await context.newPage(); await openPlayers(page); return { context, page };
}

test.describe('Dashboard browser E2E: player onboarding and compensation', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/reset');
  });

  test('DE2E-PLY-001 approving a pending player persists controlled tags, version, and audit', async ({ page, request }) => {
    await openPlayers(page); await approve(page);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.player).toMatchObject({ reviewStatus: 'APPROVED', version: 2, gameTagIds: ['tag-game-valorant'], serviceTagIds: ['tag-service-escort'], languageTagIds: ['tag-language-zh'] });
    expect(state.auditCount).toBeGreaterThan(0);
  });

  test('DE2E-PLY-002 rejection requires a note and leaves no approved service scope', async ({ page, request }) => {
    await openPlayers(page);
    await page.getByRole('button', { name: '拒绝陪玩申请' }).click();
    await page.getByLabel('原因码').fill('ONBOARDING_REJECTED');
    const note = page.getByLabel('拒绝说明');
    await page.getByRole('dialog', { name: '拒绝陪玩申请操作' }).getByRole('button', { name: '提交', exact: true }).click();
    await expect(note).toBeFocused();
    await note.fill('身份资料未通过测试复核');
    await page.getByRole('dialog', { name: '拒绝陪玩申请操作' }).getByRole('button', { name: '提交', exact: true }).click();
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.player).toMatchObject({ reviewStatus: 'REJECTED', gameTags: [], serviceTags: [], languageTags: [] });
  });

  test('DE2E-PLY-003 controlled selectors expose only enabled tags under their applicable type', async ({ page }) => {
    await openPlayers(page);
    await page.getByRole('button', { name: '批准陪玩申请' }).click();
    const dialog = page.getByRole('dialog', { name: '批准陪玩申请操作' });
    await expect(dialog.getByLabel(/无畏契约 · VALORANT/u)).toBeVisible();
    await expect(dialog.getByLabel(/护航 · ESCORT/u)).toBeVisible();
    await expect(dialog.getByLabel(/中文 · ZH_CN/u)).toBeVisible();
    await expect(dialog.getByText('已停用游戏')).toHaveCount(0);
  });

  test('DE2E-PLY-004 disabled, wrong-type, and unknown tags are revalidated and rejected by the API', async ({ page, request }) => {
    await openPlayers(page);
    const result = await page.evaluate(async (id) => {
      const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('p0_csrf='))?.split('=').slice(1).join('=') ?? '';
      const response = await fetch(`/api/v1/admin/players/${id}/approve`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': decodeURIComponent(csrf), 'idempotency-key': 'invalid-player-tags' }, body: JSON.stringify({ expectedVersion: 1, gameTagIds: ['tag-game-retired'], serviceTagIds: ['tag-game-valorant'], languageTagIds: ['unknown'], reasonCode: 'INVALID_TAG_TEST' }) });
      return { status: response.status, body: await response.json() };
    }, playerId);
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe('INVALID_TAG_SELECTION');
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.player).toMatchObject({ reviewStatus: 'PENDING_REVIEW', version: 1 });
  });

  test('DE2E-PLY-005 editing support scope replaces the complete controlled-tag set', async ({ page, request }) => {
    await openPlayers(page); await approve(page);
    await page.getByRole('button', { name: '编辑支持范围' }).click();
    await page.getByLabel(/中文 · ZH_CN/u).uncheck();
    await page.getByLabel('原因码').fill('SERVICE_SCOPE_UPDATE');
    const dialog = page.getByRole('dialog', { name: '编辑支持范围操作' });
    await dialog.getByRole('button', { name: '提交', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => {
      const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
      return state.player;
    }).toMatchObject({ version: 3, gameTagIds: ['tag-game-valorant'], serviceTagIds: ['tag-service-escort'], languageTagIds: [] });
  });

  test('DE2E-PLY-006 percentage compensation override is confirmed and persisted per offering', async ({ page, request }) => {
    await openPlayers(page); await approve(page);
    await page.getByRole('button', { name: '设置项目分成' }).click();
    await page.getByLabel('分成比例（%）').fill('75');
    await page.getByLabel('原因码').fill('COMPENSATION_UPDATE');
    await page.getByRole('dialog', { name: '设置项目分成操作' }).getByRole('button', { name: '提交', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '确认项目分成改动' });
    await confirmation.getByRole('button', { name: '确认并保存全部' }).click();
    await expect(confirmation).toBeHidden();
    await expect.poll(async () => {
      const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
      return state.compensationRules;
    }).toEqual([{ serviceOfferingId: 'offering-e2e-valorant', type: 'PERCENT_BPS', value: 7500, currency: null, version: 1 }]);
  });

  test('DE2E-PLY-007 concurrent approve and reject accept only one matching version', async ({ browser, request }) => {
    const approving = await actorPage(browser); const rejecting = await actorPage(browser);
    await approving.page.getByRole('button', { name: '批准陪玩申请' }).click();
    await approving.page.getByLabel(/无畏契约 · VALORANT/u).check(); await approving.page.getByLabel(/护航 · ESCORT/u).check(); await approving.page.getByLabel('原因码').fill('CONCURRENT_APPROVE');
    await rejecting.page.getByRole('button', { name: '拒绝陪玩申请' }).click(); await rejecting.page.getByLabel('拒绝说明').fill('并发拒绝'); await rejecting.page.getByLabel('原因码').fill('CONCURRENT_REJECT');
    await Promise.all([
      approving.page.getByRole('dialog', { name: '批准陪玩申请操作' }).getByRole('button', { name: '提交', exact: true }).click(),
      rejecting.page.getByRole('dialog', { name: '拒绝陪玩申请操作' }).getByRole('button', { name: '提交', exact: true }).click()
    ]);
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).player.version).toBe(2);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(['APPROVED', 'REJECTED']).toContain(state.player.reviewStatus);
    await approving.context.close(); await rejecting.context.close();
  });
});
