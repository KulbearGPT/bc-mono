import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

type BulkOrder = {
  id: string;
  publicId: string;
  status: string;
  version: number;
  amountMinor: number;
  playerEarningMinor: number;
  reservationStatus: string;
  resolutionCount: number;
  refundMinor: number;
  earningMinor: number;
  resolutionReason: string | null;
};

async function seedOrders(request: APIRequestContext) {
  const response = await request.post('http://127.0.0.1:3000/__e2e/orders/bulk', { data: { count: 36 } });
  expect(response.status()).toBe(201);
  const body = await response.json() as { orders: BulkOrder[] };
  expect(body.orders).toHaveLength(36);
  return body.orders;
}

async function login(page: Page) {
  await page.goto('/__e2e/login/l2');
  await page.waitForURL('**/');
}

async function cancelOrder(page: Page, order: BulkOrder, key: string, overrides: Record<string, unknown> = {}) {
  return page.evaluate(async ({ order, key, overrides }) => {
    const csrf = decodeURIComponent(document.cookie.split('; ').find((entry) => entry.startsWith('p0_csrf='))?.split('=').slice(1).join('=') ?? '');
    const response = await fetch(`/api/v1/admin/orders/${order.id}/resolve`, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': csrf, 'idempotency-key': key },
      body: JSON.stringify({ expectedVersion: order.version, targetStatus: 'CANCELLED', reasonCode: 'BULK_EXCEPTION_TEST', refund: { amountMinor: order.amountMinor, currency: 'USD' }, playerEarning: { amountMinor: 0, currency: 'USD' }, evidenceNote: '批量订单异常场景自动化', confirmation: 'EXECUTE_OR_REQUEST_APPROVAL', ...overrides })
    });
    return { status: response.status, body: await response.json() };
  }, { order, key, overrides });
}

async function bulkState(request: APIRequestContext): Promise<BulkOrder[]> {
  const body = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json() as { bulkOrders: BulkOrder[] };
  return body.bulkOrders;
}

test.describe('Dashboard browser E2E: dozens of mixed-state orders', () => {
  test.beforeEach(async ({ request }) => { await request.post('http://127.0.0.1:3000/__e2e/reset'); });

  test('DE2E-ORD-012 36 mixed-state orders paginate without duplicates and filter to exact status facts', async ({ page, request }) => {
    await seedOrders(request);
    await login(page);
    await page.getByRole('link', { name: '订单', exact: true }).click();
    await expect(page.getByText('P-BULK-001')).toBeVisible();
    await expect(page.getByText('P-BULK-025')).toBeVisible();
    await expect(page.getByText('P-BULK-026')).toHaveCount(0);
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(page.getByText('P-BULK-026')).toBeVisible();
    await expect(page.getByText('P-BULK-036')).toBeVisible();
    await expect(page.getByText('P-BULK-025')).toHaveCount(0);
    await page.getByLabel('订单状态').fill('EXCEPTION');
    await page.getByRole('button', { name: '筛选' }).click();
    const cards = page.locator('article');
    await expect(cards).toHaveCount(4);
    for (const card of await cards.all()) await expect(card).toContainText('需要处理');
  });

  test('DE2E-ORD-013 an owner cancellation before service is located and fully resolved without touching 35 surrounding orders', async ({ page, request }) => {
    const orders = await seedOrders(request);
    const target = orders.find((order) => order.publicId === 'P-BULK-001')!;
    const before = structuredClone(await bulkState(request));
    await login(page);
    await page.getByRole('link', { name: '订单', exact: true }).click();
    await page.getByLabel('订单号或用户标识').fill(target.publicId);
    await page.getByRole('button', { name: '筛选' }).click();
    const card = page.locator('article').filter({ hasText: target.publicId });
    await card.getByRole('button', { name: '取消订单' }).click();
    const dialog = page.getByRole('dialog', { name: '取消订单操作' });
    await dialog.getByLabel('核对证据与处理说明').fill('老板在开玩前临时有事，已核对双方尚未开始服务，同意全额取消。');
    await dialog.getByRole('button', { name: '提交', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await bulkState(request)).find((item) => item.id === target.id)?.status).toBe('CANCELLED');
    const state = await bulkState(request);
    expect(state.find((item) => item.id === target.id)).toMatchObject({ status: 'CANCELLED', reservationStatus: 'RELEASED', resolutionCount: 1, refundMinor: target.amountMinor, earningMinor: 0, resolutionReason: 'USER_REQUEST' });
    expect(state.filter((item) => item.id !== target.id)).toEqual(before.filter((item) => item.id !== target.id));
    const fullState = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(fullState.auditCount).toBeGreaterThanOrEqual(1);
  });

  test('DE2E-ORD-014 an in-service help request flows from L1 evidence collection to an L2 partial resolution', async ({ page, request }) => {
    const order = (await seedOrders(request)).find((item) => item.status === 'IN_SERVICE')!;
    await page.goto('/__e2e/login/l1'); await page.waitForURL('**/');
    await page.getByRole('link', { name: '客服工作台', exact: true }).click();
    const task = page.locator('.task-card').filter({ hasText: 'P-BULK-017' });
    await task.getByRole('button', { name: '认领任务' }).click();
    const note = task.getByLabel('T-BULK-INTERRUPT 处理备注');
    await expect(note).toBeVisible();
    await note.fill('老板反馈玩到一半网络中断；已联系双方，核对完成约一半服务，提交主管处理。');
    await task.getByRole('button', { name: '保存备注' }).click();
    await task.getByRole('button', { name: '查看完整订单' }).click();
    await expect(page.getByRole('heading', { name: `订单 ${order.publicId}` })).toBeVisible();
    await expect(page.locator('.order-preview')).toContainText('IN_SERVICE');

    await login(page);
    await page.getByRole('link', { name: '订单', exact: true }).click();
    await page.getByLabel('订单号或用户标识').fill(order.publicId);
    await page.getByRole('button', { name: '筛选' }).click();
    await page.locator('article').filter({ hasText: order.publicId }).getByRole('button', { name: '取消订单' }).click();
    const dialog = page.getByRole('dialog', { name: '取消订单操作' });
    const refundMinor = Math.floor(order.amountMinor / 2);
    const earningMinor = Math.floor(order.playerEarningMinor / 2);
    await dialog.getByLabel('退回客户（minor units）').fill(String(refundMinor));
    await dialog.getByLabel('保留陪玩收益（minor units）').fill(String(earningMinor));
    await dialog.getByLabel('取消原因').selectOption('SERVICE_INTERRUPTED');
    await dialog.getByLabel('核对证据与处理说明').fill('依据客服备注和双方确认，按已完成一半服务进行部分退款并保留对应陪玩收益。');
    await dialog.getByRole('button', { name: '提交', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await bulkState(request)).find((item) => item.id === order.id)?.status).toBe('CANCELLED');
    const current = (await bulkState(request)).find((item) => item.id === order.id);
    expect(current).toMatchObject({ status: 'CANCELLED', reservationStatus: 'RELEASED', resolutionCount: 1, refundMinor, earningMinor, resolutionReason: 'SERVICE_INTERRUPTED' });
    const state = await (await request.get('http://127.0.0.1:3000/__e2e/state')).json();
    expect(state.tasks.find((item: { publicId: string }) => item.publicId === 'T-BULK-INTERRUPT')).toMatchObject({ status: 'CLAIMED', notes: ['老板反馈玩到一半网络中断；已联系双方，核对完成约一半服务，提交主管处理。'] });
  });

  test('DE2E-ORD-015 an owner retry after a network stall returns the same cancellation without double refund', async ({ page, request }) => {
    const order = (await seedOrders(request)).find((item) => item.status === 'ACCEPTED')!;
    await login(page);
    const first = await cancelOrder(page, order, 'bulk-idempotent-cancel');
    const second = await cancelOrder(page, order, 'bulk-idempotent-cancel');
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body).toEqual(first.body);
    const current = (await bulkState(request)).find((item) => item.id === order.id);
    expect(current).toMatchObject({ status: 'CANCELLED', reservationStatus: 'RELEASED', resolutionCount: 1 });
  });

  test('DE2E-ORD-016 terminal, stale, and over-fact resolutions are all rejected with zero writes', async ({ page, request }) => {
    const orders = await seedOrders(request); await login(page);
    const completed = orders.find((item) => item.status === 'COMPLETED')!;
    const [stale, overFact] = orders.filter((item) => item.status === 'ACCEPTED').slice(0, 2);
    const before = structuredClone(await bulkState(request));
    const results = await Promise.all([
      cancelOrder(page, completed, 'bulk-terminal-resolution'),
      cancelOrder(page, stale!, 'bulk-stale-resolution', { expectedVersion: stale!.version - 1 }),
      cancelOrder(page, overFact!, 'bulk-over-fact-resolution', { refund: { amountMinor: overFact!.amountMinor + 1, currency: 'USD' } })
    ]);
    expect(results.map((result) => result.status).sort(), JSON.stringify(results)).toEqual([409, 409, 422]);
    expect(await bulkState(request)).toEqual(before);
  });

  test('DE2E-ORD-018 support grants a post-service partial refund while the completed order remains completed', async ({ page, request }) => {
    const orders = await seedOrders(request);
    const target = orders.find((order) => order.status === 'COMPLETED')!;
    const untouched = structuredClone(orders.filter((order) => order.id !== target.id));
    await login(page);
    await page.getByRole('link', { name: '订单', exact: true }).click();
    await page.getByLabel('订单号或用户标识').fill(target.publicId);
    await page.getByRole('button', { name: '筛选' }).click();
    const card = page.locator('article').filter({ hasText: target.publicId });
    await card.getByRole('button', { name: '独立退款' }).click();
    const dialog = page.getByRole('dialog', { name: '独立退款操作' });
    await expect(dialog).toContainText('不会取消订单');
    await dialog.getByLabel('退款金额（minor units）').fill('625');
    await dialog.getByLabel('退款原因').selectOption('QUALITY_COMPLAINT');
    await dialog.getByLabel('核对证据与处理说明').fill('老板完单后反馈最后半小时频繁掉线；客服核对频道记录并与双方确认，退回 6.25 USD。');
    const response = page.waitForResponse((candidate) => candidate.url().includes(`/orders/${target.id}/refund`) && candidate.request().method() === 'POST');
    await dialog.getByRole('button', { name: '提交', exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(dialog).toBeHidden();
    const current = (await bulkState(request)).find((order) => order.id === target.id)!;
    expect(current).toMatchObject({ status: 'COMPLETED', refundMinor: 625, resolutionCount: 0 });
    expect((await bulkState(request)).filter((order) => order.id !== target.id)).toEqual(untouched);
  });

  test('DE2E-ORD-019 support reads the mid-service Discord context without any Dashboard reply control',async({page,request})=>{
    const target=(await seedOrders(request)).find((order)=>order.status==='IN_SERVICE')!;await login(page);await page.getByRole('link',{name:'订单',exact:true}).click();await page.getByLabel('订单号或用户标识').fill(target.publicId);await page.getByRole('button',{name:'筛选'}).click();await page.locator('article').filter({hasText:target.publicId}).getByRole('button',{name:'查看详情'}).click();
    const transcript=page.getByRole('region',{name:'订单频道记录'});await expect(transcript).toContainText('玩到一半突然掉线');await expect(transcript).toContainText('附件 1 个');await expect(transcript).toContainText('回复消息 1533615770179866746');await expect(transcript.getByRole('button',{name:'发送消息'})).toHaveCount(0);await transcript.getByRole('button',{name:'加载更多频道记录'}).click();await expect(transcript).toContainText('[消息已删除]');
  });
});
