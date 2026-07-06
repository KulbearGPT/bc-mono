import { expect, test, type Page } from '@playwright/test';

async function seedApplicants(request: Parameters<Parameters<typeof test.beforeEach>[0]>[0]['request']) {
  const response = await request.post('http://127.0.0.1:3000/__e2e/players/bulk', { data: { count: 12 } });
  expect(response.status()).toBe(201);
}

async function openPendingPlayers(page: Page) {
  await page.goto('/__e2e/login/l3'); await page.waitForURL('**/');
  await page.getByRole('link', { name: '陪玩', exact: true }).click();
  await page.getByLabel('准入状态').fill('PENDING_REVIEW');
  await page.getByRole('button', { name: '筛选' }).click();
  await expect(page.getByText('E2E 陪玩')).toBeVisible();
}

test.describe('Dashboard browser E2E: daily player business operations', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/reset');
    await seedApplicants(request);
  });

  test('DE2E-PLY-008 owner reviews an applicant, opens service scope, and sets the project compensation', async ({ page, request }) => {
    await openPendingPlayers(page);
    await expect(page.getByRole('article')).toHaveCount(12);
    const row = page.getByRole('article').filter({ hasText: 'E2E 陪玩' });
    await row.getByRole('button', { name: '查看详情' }).click();
    const detail = page.getByRole('dialog', { name: '业务对象详情' });
    await expect(detail.getByText('00000000-0000-0000-0000-000000000601', { exact: true })).toBeVisible();
    await detail.getByRole('button', { name: '关闭' }).click();
    await row.getByRole('button', { name: '批准陪玩申请' }).click();
    await page.getByLabel(/无畏契约 · VALORANT/u).check();
    await page.getByLabel(/护航 · ESCORT/u).check();
    await page.getByLabel(/中文 · ZH_CN/u).check();
    await page.getByLabel('原因码').fill('DAILY_ONBOARDING_APPROVED');
    const approval = page.getByRole('dialog', { name: '批准陪玩申请操作' });
    await approval.getByRole('button', { name: '提交', exact: true }).click();
    await expect(approval).toBeHidden();
    await page.getByRole('button', { name: '清除' }).click();
    await expect(page.getByRole('article').filter({ hasText: 'E2E 陪玩' })).toBeVisible();

    await page.getByRole('button', { name: '编辑支持范围' }).click();
    await page.getByLabel(/中文 · ZH_CN/u).uncheck();
    await page.getByLabel('原因码').fill('PLAYER_REQUEST_LANGUAGE_CHANGE');
    const scope = page.getByRole('dialog', { name: '编辑支持范围操作' });
    await scope.getByRole('button', { name: '提交', exact: true }).click();
    await expect(scope).toBeHidden();

    await row.getByRole('button', { name: '设置项目分成' }).click();
    await page.getByLabel('分成比例（%）').fill('68');
    await page.getByLabel('原因码').fill('NEW_PLAYER_TRIAL_RATE');
    await page.getByRole('dialog', { name: '设置项目分成操作' }).getByRole('button', { name: '提交', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '确认项目分成改动' });
    await confirmation.getByRole('button', { name: '确认并保存全部' }).click();
    await expect(confirmation).toBeHidden();

    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).compensationRules).toHaveLength(1);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.player).toMatchObject({ reviewStatus: 'APPROVED', version: 3, gameTagIds: ['tag-game-valorant'], serviceTagIds: ['tag-service-escort'], languageTagIds: [] });
    expect(state.compensationRules).toEqual([{ serviceOfferingId: 'offering-e2e-valorant', type: 'PERCENT_BPS', value: 6800, currency: null, version: 1 }]);
    expect(state.bulkPlayers.filter((player: { playerId: string; reviewStatus: string }) => player.playerId !== state.player.playerId && player.reviewStatus !== 'PENDING_REVIEW')).toEqual([]);
  });

  test('DE2E-PLY-009 incomplete identity evidence is rejected with a reason and creates no business scope', async ({ page, request }) => {
    await openPendingPlayers(page);
    const row = page.getByRole('article').filter({ hasText: 'E2E 陪玩' });
    await row.getByRole('button', { name: '拒绝陪玩申请' }).click();
    await page.getByLabel('原因码').fill('IDENTITY_EVIDENCE_MISSING');
    await page.getByLabel('拒绝说明').fill('自拍与证件姓名不一致，请补齐后重新申请');
    const dialog = page.getByRole('dialog', { name: '拒绝陪玩申请操作' });
    await dialog.getByRole('button', { name: '提交', exact: true }).click();
    await expect(dialog).toBeHidden();
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.player).toMatchObject({ reviewStatus: 'REJECTED', gameTagIds: [], serviceTagIds: [], languageTagIds: [] });
    expect(state.compensationRules).toEqual([]);
  });
});
