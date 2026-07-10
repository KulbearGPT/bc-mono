import { expect, test, type Page } from '@playwright/test';

async function openCancellation(page: Page) {
  await page.goto('/__e2e/login/l2');
  await page.waitForURL('**/');
  await page.getByRole('link', { name: '订单', exact: true }).click();
  await expect(page.getByText('P-E2E-001')).toBeVisible();
  await page.getByRole('button', { name: '取消订单' }).click();
  await page.getByLabel('核对证据与处理说明').fill('已核对订单频道、服务进度与客户取消请求');
}

async function loginAndOpenDetail(page: Page) {
  await page.goto('/__e2e/login/l2'); await page.waitForURL('**/');
  await page.getByRole('link', { name: '订单', exact: true }).click();
  await page.getByRole('button', { name: '查看详情' }).click();
  await expect(page.getByRole('region', { name: '订单陪玩与项目' })).toBeVisible();
}

async function apiAddParticipant(page: Page, index: number, version: number, catalogId = '00000000-0000-0000-0000-000000000701') {
  return page.evaluate(async ({ index, version, catalogId }) => {
    const csrf = decodeURIComponent(document.cookie.split('; ').find((entry) => entry.startsWith('p0_csrf='))?.split('=').slice(1).join('=') ?? '');
    const response = await fetch('/api/v1/admin/orders/00000000-0000-0000-0000-000000000301/participants', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': csrf, 'idempotency-key': `add-participant-${index}-${crypto.randomUUID()}` }, body: JSON.stringify({ playerId: `player-e2e-${index}`, serviceCatalogVersionId: catalogId, unitCount: 1, linePriceMinor: 1000 + index, expectedOrderVersion: version, reasonCode: 'ADD_ORDER_PLAYER' }) });
    return { status: response.status, body: await response.json() };
  }, { index, version, catalogId });
}

test.describe('Dashboard browser E2E: order mutations', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/reset');
  });

  test('DE2E-ORD-004 a legal cancellation atomically updates status, reservation, and audit facts', async ({ page, request }) => {
    await openCancellation(page);
    await page.getByRole('dialog', { name: '取消订单操作' }).getByRole('button', { name: '提交', exact: true }).click();
    await expect(page.getByText('P-E2E-001')).toBeVisible();
    await expect(page.getByText('已取消').first()).toBeVisible();
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

  test('DE2E-ORD-005 an over-fact resolution is rejected and never appears as executed', async ({ page, request }) => {
    await page.goto('/__e2e/login/l2'); await page.waitForURL('**/');
    const result = await page.evaluate(async () => {
      const csrf = decodeURIComponent(document.cookie.split('; ').find((entry) => entry.startsWith('p0_csrf='))?.split('=').slice(1).join('=') ?? '');
      const response = await fetch('/api/v1/admin/orders/00000000-0000-0000-0000-000000000301/resolve', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': csrf, 'idempotency-key': 'over-limit-resolution' }, body: JSON.stringify({ expectedVersion: 3, targetStatus: 'CANCELLED', reasonCode: 'OVER_LIMIT', refund: { amountMinor: 60_000, currency: 'USD' }, playerEarning: { amountMinor: 0, currency: 'USD' }, evidenceNote: '超出订单事实的处置', confirmation: 'EXECUTE_OR_REQUEST_APPROVAL' }) });
      return { status: response.status, body: await response.json() };
    });
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe('RESOLUTION_REJECTED');
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.order).toMatchObject({ status: 'ACCEPTED', version: 3 });
    expect(state.orderResolutionCount).toBe(0);
  });

  test('DE2E-ORD-008 adding players on different projects lets the API derive order and reservation totals', async ({ page, request }) => {
    await loginAndOpenDetail(page);
    const requests: Array<Record<string, unknown>> = [];
    page.on('request', (value) => { if (value.method() === 'POST' && value.url().endsWith('/participants')) requests.push(value.postDataJSON()); });
    for (const [player, catalog, price] of [['player-e2e-1', '00000000-0000-0000-0000-000000000701', '2400'], ['player-e2e-2', 'catalog-e2e-chat', '1500']] as const) {
      await page.getByText('高级操作：添加陪玩明细').click();
      const form = page.locator('.participant-inline-form').last();
      await form.getByLabel('陪玩').selectOption(player);
      await form.getByLabel('服务项目').selectOption(catalog);
      await form.getByLabel('计费单位数').fill('1');
      await form.getByLabel('明细价格（CAT 最小单位）').fill(price);
      await form.getByRole('button', { name: '添加陪玩' }).click();
      await expect(page.locator('.participant-detail-card')).toHaveCount(requests.length);
    }
    expect(requests).toHaveLength(2);
    expect(requests.every((body) => !Object.hasOwn(body, 'amountMinor'))).toBe(true);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.order).toMatchObject({ amountMinor: 3900, version: 5 });
    expect(state.reservationAmountMinor).toBe(3900);
    expect(state.orderParticipants.map((item: { service: string }) => item.service)).toEqual(['ESCORT', 'CHAT']);
  });

  test('DE2E-ORD-009 project, price, and removal edits keep participant, order, and reservation versions consistent', async ({ page, request }) => {
    await page.goto('/__e2e/login/l2'); await page.waitForURL('**/');
    expect((await apiAddParticipant(page, 1, 3)).status).toBe(201);
    expect((await apiAddParticipant(page, 2, 4)).status).toBe(201);
    await page.getByRole('link', { name: '订单', exact: true }).click(); await page.getByRole('button', { name: '查看详情' }).click();
    const first = page.locator('.participant-detail-card').nth(0); await first.getByRole('button', { name: '编辑明细' }).click();
    await first.getByLabel('操作').selectOption('CHANGE_PROJECT'); await first.getByLabel('服务项目').selectOption('catalog-e2e-chat'); await first.getByLabel('计费单位数').fill('2'); await first.getByLabel('明细价格').fill('2800'); await first.getByRole('button', { name: '保存明细' }).click();
    await expect(page.locator('.participant-detail-card').nth(0)).toContainText('聊天陪伴');
    const second = page.locator('.participant-detail-card').nth(1); await second.getByRole('button', { name: '编辑明细' }).click(); await second.getByLabel('操作').selectOption('REMOVE'); await second.getByRole('button', { name: '保存明细' }).click();
    await expect(page.locator('.participant-detail-card')).toHaveCount(2);
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.order).toMatchObject({ amountMinor: 2800, version: 7 }); expect(state.reservationAmountMinor).toBe(2800);
    expect(state.orderParticipants).toMatchObject([{ service: 'CHAT', linePriceMinor: 2800, version: 2, status: 'ACTIVE' }, { version: 2, status: 'REMOVED' }]);
  });

  test('DE2E-ORD-010 nine different participant rows load completely and remain editable without a UI cap', async ({ page, request }) => {
    await page.goto('/__e2e/login/l2'); await page.waitForURL('**/');
    for (let index = 1; index <= 9; index += 1) expect((await apiAddParticipant(page, index, index + 2, index % 2 ? '00000000-0000-0000-0000-000000000701' : 'catalog-e2e-chat')).status).toBe(201);
    await page.getByRole('link', { name: '订单', exact: true }).click(); await page.getByRole('button', { name: '查看详情' }).click();
    await expect(page.locator('.participant-detail-card')).toHaveCount(9);
    const ninth = page.locator('.participant-detail-card').nth(8); await ninth.getByRole('button', { name: '编辑明细' }).click(); await ninth.getByLabel('明细价格').fill('2222'); await ninth.getByRole('button', { name: '保存明细' }).click();
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3000/__e2e/state')).json()).orderParticipants[8].linePriceMinor).toBe(2222);
  });

  test('DE2E-ORD-011 captured order participant edits are rejected with zero writes', async ({ page, request }) => {
    await page.goto('/__e2e/login/l2'); await page.waitForURL('**/');
    expect((await apiAddParticipant(page, 1, 3)).status).toBe(201);
    await request.post('http://127.0.0.1:3000/__e2e/capture-order');
    const result = await page.evaluate(async () => { const csrf = decodeURIComponent(document.cookie.split('; ').find((entry) => entry.startsWith('p0_csrf='))?.split('=').slice(1).join('=') ?? ''); const response = await fetch('/api/v1/admin/orders/00000000-0000-0000-0000-000000000301/participants/participant-e2e-1', { method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': csrf, 'idempotency-key': 'captured-order-edit-001' }, body: JSON.stringify({ expectedOrderVersion: 4, expectedParticipantVersion: 1, action: 'CHANGE_PRICE', serviceCatalogVersionId: null, unitCount: null, linePriceMinor: 9999, reasonCode: 'CAPTURED_EDIT' }) }); return { status: response.status, body: await response.json() }; });
    expect(result.status, JSON.stringify(result.body)).toBe(409); expect(result.body.error.code).toBe('ORDER_IMMUTABLE');
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.orderParticipants[0]).toMatchObject({ linePriceMinor: 1001, version: 1 }); expect(state.order.version).toBe(4); expect(state.reservationAmountMinor).toBe(1001);
  });

  test('DE2E-ORD-017 support reassigns one player slot without changing the other player, total, or reservation',async({page,request})=>{
    await page.goto('/__e2e/login/l2');await page.waitForURL('**/');
    expect((await apiAddParticipant(page,1,3)).status).toBe(201);expect((await apiAddParticipant(page,2,4,'catalog-e2e-chat')).status).toBe(201);
    await page.getByRole('link',{name:'订单',exact:true}).click();await page.getByRole('button',{name:'查看详情'}).click();
    const first=page.locator('.participant-detail-card').nth(0);await first.getByRole('button',{name:'改派陪玩'}).click();
    await first.getByLabel('新陪玩').selectOption('player-e2e-3');
    const responsePromise=page.waitForResponse((response)=>response.request().method()==='PATCH'&&response.url().includes('/participants/participant-e2e-1'));
    await first.getByRole('button',{name:'保存明细'}).click();expect((await responsePromise).status()).toBe(200);
    await expect(page.locator('.participant-detail-card').nth(0)).toContainText('E2E 陪玩 3');
    const state=await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.orderParticipants).toHaveLength(2);expect(state.orderParticipants[0]).toMatchObject({id:'participant-e2e-1',playerId:'player-e2e-3',service:'ESCORT',linePriceMinor:1001,readiness:'NOT_READY',version:2});expect(state.orderParticipants[1]).toMatchObject({id:'participant-e2e-2',playerId:'player-e2e-2',service:'CHAT',linePriceMinor:1002,version:1});
    expect(state.order).toMatchObject({amountMinor:2003,version:6});expect(state.reservationAmountMinor).toBe(2003);
  });
});
