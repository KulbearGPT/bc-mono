import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  DiscordRestWorkerAdapter,
  PostgresOrderPanelProjectionStore,
  WorkerAdapterError
} from '../apps/api/src/worker-adapters.js';
import type { OrderPanelProjection } from '../apps/api/src/worker-runtime.js';

const projection: OrderPanelProjection = {
  orderId: '00000000-0000-0000-0000-000000005301',
  publicId: 'P-5301',
  status: 'IN_SERVICE',
  version: 8,
  channelId: '530000000000000001',
  panelMessageId: '530000000000000002',
  customerDiscordUserId: '530000000000000003',
  playerDiscordUserId: '530000000000000004',
  playerDiscordUserIds: ['530000000000000004'],
  requestedPlayerCount: 1,
  filledPlayerCount: 1,
  coordinationRequirements: [{
    gameDisplayName: '瓦洛兰特',
    serviceDisplayName: '娱乐陪玩',
    regionDisplayName: '北美',
    durationMinutes: 120,
    requestedPlayerCount: 1,
    customerNote: '中文交流，希望轻松一点'
  }],
  submittedAt: '2026-07-18T22:55:00.000Z',
  acceptedAt: '2026-07-18T23:00:00.000Z',
  amountMinor: 12_000,
  currency: 'CAT',
  guildId: '530000000000000000',
  voiceChannelId: null,
  privateOrderCategoryId: '530000000000000010',
  staffTaskChannelId: '530000000000000011',
  staffRoleIds: ['530000000000000012']
};
const notBefore = '2026-07-18T23:00:00.000Z';

describe('M5-US-02 Worker production adapters', () => {
  test('loads an order panel projection through users and Guild-scoped Discord accounts', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      order_id: projection.orderId,
      public_id: projection.publicId,
      status: projection.status,
      row_version: projection.version,
      channel_id: projection.channelId,
      panel_message_id: projection.panelMessageId,
      customer_discord_user_id: projection.customerDiscordUserId,
      player_discord_user_id: projection.playerDiscordUserId,
      player_discord_user_ids: projection.playerDiscordUserIds,
      requested_player_count: projection.requestedPlayerCount,
      filled_player_count: projection.filledPlayerCount,
      coordination_requirements: projection.coordinationRequirements,
      submitted_at: projection.submittedAt,
      accepted_at: projection.acceptedAt,
      amount_minor: '12000',
      currency: projection.currency
      ,guild_id: projection.guildId
      ,voice_channel_id: null
      ,config_json: { private_order_category_id: projection.privateOrderCategoryId, staff_task_channel_id: projection.staffTaskChannelId, staff_l1_role_id: projection.staffRoleIds?.[0] }
    }] });
    const store = new PostgresOrderPanelProjectionStore({ query });

    await expect(store.getOrderPanelProjection(projection.orderId)).resolves.toEqual(projection);

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM orders AS orders/i);
    expect(sql).toMatch(/JOIN users AS customer/i);
    expect(sql).toMatch(/LEFT JOIN users AS player/i);
    expect(sql).toMatch(/JOIN discord_accounts AS customer_discord/i);
    expect(sql).toMatch(/LEFT JOIN discord_accounts AS player_discord/i);
    expect(sql).toMatch(/customer_discord\.guild_id = orders\.guild_id/i);
    expect(sql).toMatch(/player_discord\.guild_id = orders\.guild_id/i);
    expect(sql).toMatch(/FROM selection_pools selection_pool/i);
    expect(values).toEqual([projection.orderId]);
  });

  test('returns null when the order projection does not exist', async () => {
    const store = new PostgresOrderPanelProjectionStore({ query: vi.fn().mockResolvedValue({ rows: [] }) });
    await expect(store.getOrderPanelProjection(projection.orderId)).resolves.toBeNull();
  });

  test('replaces panel message id with an optimistic expected-id condition', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: projection.orderId }] });
    const store = new PostgresOrderPanelProjectionStore({ query });

    await store.replacePanelMessageId({
      orderId: projection.orderId,
      expectedPanelMessageId: projection.panelMessageId,
      panelMessageId: '530000000000000005'
    });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE orders/i);
    expect(sql).toMatch(/panel_message_id = \$3/i);
    expect(sql).toMatch(/id = \$1 AND panel_message_id = \$2/i);
    expect(values).toEqual([projection.orderId, projection.panelMessageId, '530000000000000005']);
  });

  test('distinguishes a missing order from an optimistic panel-id conflict', async () => {
    const missingQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const missing = new PostgresOrderPanelProjectionStore({ query: missingQuery });
    await expect(missing.replacePanelMessageId({
      orderId: projection.orderId,
      expectedPanelMessageId: projection.panelMessageId,
      panelMessageId: '530000000000000005'
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const conflictQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ panel_message_id: 'newer-message' }] });
    const conflict = new PostgresOrderPanelProjectionStore({ query: conflictQuery });
    await expect(conflict.replacePanelMessageId({
      orderId: projection.orderId,
      expectedPanelMessageId: projection.panelMessageId,
      panelMessageId: '530000000000000005'
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('grants the assigned player access and patches the existing panel message', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(200, { id: projection.panelMessageId }));
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await expect(adapter.upsertOrderPanel(projection, notBefore)).resolves.toEqual({
      messageId: projection.panelMessageId,
      recreated: false
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1,
      `https://discord.com/api/v10/channels/${projection.channelId}/permissions/${projection.playerDiscordUserId}`,
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ authorization: 'Bot discord-token', 'content-type': 'application/json' }),
        body: JSON.stringify({ allow: '3072', deny: '0', type: 1 })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      `https://discord.com/api/v10/channels/${projection.channelId}/messages/${projection.panelMessageId}`,
      expect.objectContaining({ method: 'PATCH' })
    );
    const panelBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(panelBody.flags).toBe(32768);
    expect(JSON.stringify(panelBody.components)).toContain('P-5301');
    expect(JSON.stringify(panelBody.components)).toContain('IN_SERVICE');
    expect(JSON.stringify(panelBody.components)).toContain('CAT 1200.0');
    expect(panelBody).not.toHaveProperty('content');
    expect(panelBody).not.toHaveProperty('embeds');
    expect(panelBody.allowed_mentions).toEqual({ parse: [] });
    const actionRow = panelBody.components[0].components.find((component: { type: number }) => component.type === 1);
    expect(actionRow.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ custom_id: `bc:service:request-completion:${projection.orderId}:v8` }),
      expect.objectContaining({ custom_id: `bc:service:support:${projection.orderId}:v8` }),
      expect.objectContaining({ label: '刷新订单', custom_id: `bc:order:${projection.orderId}:refresh` })
    ]));
  });

  test('updates a Components V2 panel with multi-player access and explicit assembly progress', async () => {
    const secondPlayerDiscordUserId = '530000000000000006';
    const assembling = {
      ...projection,
      status: 'PENDING_DISPATCH',
      playerDiscordUserIds: [projection.playerDiscordUserId!, secondPlayerDiscordUserId],
      requestedPlayerCount: 3,
      filledPlayerCount: 2
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(200, { id: projection.panelMessageId }));
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await adapter.upsertOrderPanel(assembling, notBefore);

    expect(fetchMock.mock.calls[0]?.[0]).toContain(`/permissions/${projection.playerDiscordUserId}`);
    expect(fetchMock.mock.calls[1]?.[0]).toContain(`/permissions/${secondPlayerDiscordUserId}`);
    const panelBody = JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string);
    expect(panelBody.flags).toBe(32768);
    expect(panelBody).not.toHaveProperty('content');
    expect(panelBody).not.toHaveProperty('embeds');
    expect(panelBody.components[0]).toMatchObject({ type: 17 });
    expect(JSON.stringify(panelBody.components)).toContain('陪玩到位：2/3');
    expect(JSON.stringify(panelBody.components)).toContain('全部到齐后开放准备确认');
  });

  test('keeps recovery controls when synchronizing a pending-dispatch panel', async () => {
    const pending = { ...projection, status: 'PENDING_DISPATCH', playerDiscordUserId: null, playerDiscordUserIds: [], filledPlayerCount: 0 };
    const fetchMock = vi.fn().mockResolvedValue(response(200, { id: projection.panelMessageId }));
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await adapter.upsertOrderPanel(pending, notBefore);

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    const actionRow = body.components[0].components.find(
      (component: { type: number; components?: Array<{ type?: number }> }) =>
        component.type === 1 && component.components?.some((item) => item.type === 2)
    );
    expect(actionRow.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '刷新订单', custom_id: `bc:order:${projection.orderId}:refresh` }),
      expect.objectContaining({ label: '取消订单', custom_id: `bc:order:${projection.orderId}:cancel:v8` }),
      expect.objectContaining({ label: '联系客服' })
    ]));
  });

  test('renders current collecting facts and the close control when a selection pool panel is synchronized', async () => {
    const pending = {
      ...projection,
      status: 'PENDING_DISPATCH',
      playerDiscordUserId: null,
      playerDiscordUserIds: [],
      filledPlayerCount: 0,
      selectionPool: {
        id: '00000000-0000-0000-0000-000000005399',
        status: 'COLLECTING',
        version: 1,
        round: 2,
        applicationCount: 3,
        closesAt: '2026-07-18T23:05:00.000Z'
      }
    } satisfies OrderPanelProjection;
    const fetchMock = vi.fn().mockResolvedValue(response(200, { id: projection.panelMessageId }));
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await adapter.upsertOrderPanel(pending, notBefore);

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(JSON.stringify(body.components)).toContain('第 2 轮');
    expect(JSON.stringify(body.components)).toContain('当前报名：3 人');
    const actionRows = body.components[0].components.filter((component: { type: number }) => component.type === 1);
    expect(actionRows.flatMap((row: { components: unknown[] }) => row.components)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '提前结束报名', custom_id: expect.stringMatching(/^bc:sp:c:/u) }),
      expect.objectContaining({ label: '刷新订单' }),
      expect.objectContaining({ label: '取消订单' })
    ]));
  });

  test('restores the six-option wait selector after an empty selection round closes', async () => {
    const pending = {
      ...projection,
      status: 'PENDING_DISPATCH',
      playerDiscordUserId: null,
      playerDiscordUserIds: [],
      filledPlayerCount: 0,
      selectionPool: {
        id: '00000000-0000-0000-0000-000000005399',
        status: 'SELECTION',
        version: 2,
        round: 2,
        applicationCount: 0,
        closesAt: '2026-07-18T23:05:00.000Z'
      }
    } satisfies OrderPanelProjection;
    const fetchMock = vi.fn().mockResolvedValue(response(200, { id: projection.panelMessageId }));
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await adapter.upsertOrderPanel(pending, notBefore);

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(JSON.stringify(body.components)).toContain('选择新一轮等待时间');
    const select = body.components[0].components
      .flatMap((component: { components?: unknown[] }) => component.components ?? [])
      .find((component: { type?: number }) => component.type === 3);
    expect(select).toMatchObject({
      placeholder: '选择等待时间',
      options: [
        { label: '等待 1 分钟', value: '1' },
        { label: '等待 3 分钟', value: '3' },
        { label: '等待 5 分钟', value: '5' },
        { label: '等待 10 分钟', value: '10' },
        { label: '等待 15 分钟', value: '15' },
        { label: '等待 30 分钟', value: '30' }
      ]
    });
  });

  test('creates one private voice room and sends idempotent customer and staff coordination notices after acceptance', async () => {
    const accepted = {
      ...projection,
      status: 'ACCEPTED',
      selectionVoiceChannelId: '530000000000000019',
      voiceChannelId: null
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(200, { id: '530000000000000020' }))
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(200, { id: 'customer-notice' }))
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(200, { id: 'staff-notice' }))
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(200, { id: projection.panelMessageId }));
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await expect(adapter.upsertOrderPanel(accepted, notBefore)).resolves.toEqual({
      messageId: projection.panelMessageId, recreated: false, voiceChannelId: '530000000000000020'
    });

    const createVoice = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(createVoice).toMatchObject({ type: 2, parent_id: projection.privateOrderCategoryId, user_limit: 2 });
    expect(createVoice.permission_overwrites).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: projection.guildId, type: 0, deny: String((1 << 10) | (1 << 20)) }),
      expect.objectContaining({ id: projection.customerDiscordUserId, type: 1 }),
      expect.objectContaining({
        id: projection.playerDiscordUserId,
        type: 1,
        deny: String(1 << 20)
      }),
      expect.objectContaining({ id: projection.staffRoleIds?.[0], type: 0 })
    ]));
    const customerNotice = JSON.parse(fetchMock.mock.calls[3]?.[1]?.body as string);
    expect(customerNotice.content).toContain(`<@${projection.customerDiscordUserId}>`);
    expect(customerNotice.content).toContain('/530000000000000020');
    expect(customerNotice.allowed_mentions.users).toEqual([projection.customerDiscordUserId]);
    const staffNotice = JSON.parse(fetchMock.mock.calls[5]?.[1]?.body as string);
    expect(staffNotice.content).toBeNull();
    expect(staffNotice.allowed_mentions).toEqual({ parse: [] });
    expect(staffNotice.embeds).toEqual([expect.objectContaining({
      title: '🛠️ 新订单协调 · P-5301',
      description: expect.stringContaining('已匹配完成'),
      fields: expect.arrayContaining([
        { name: '当前状态', value: '等待双方准备（ACCEPTED）', inline: true },
        { name: '客户', value: `<@${projection.customerDiscordUserId}>`, inline: true },
        { name: '已匹配陪玩', value: `<@${projection.playerDiscordUserId}>`, inline: false },
        { name: '项目需求', value: expect.stringContaining('瓦洛兰特 · 娱乐陪玩 · 北美'), inline: false },
        { name: '关键时间', value: expect.stringContaining('<t:1784415600:F>'), inline: false }
      ])
    })]);
    const staffPayload = JSON.stringify(staffNotice);
    expect(staffPayload).toContain('中文交流，希望轻松一点');
    expect(staffPayload).toContain(`/channels/${projection.guildId}/${projection.channelId}`);
    expect(staffPayload).toContain(`/channels/${projection.guildId}/530000000000000019`);
    expect(staffPayload).toContain(`/channels/${projection.guildId}/530000000000000020`);
    expect(staffPayload).toContain('进入协调语音房');
    expect(staffPayload).toContain('进入服务房间');
    expect(staffPayload).not.toMatch(/金额|余额|支付|内部定价|1200/);
  });

  test.each([
    ['IN_SERVICE', '服务进行中（IN_SERVICE）'],
    ['PENDING_CONFIRMATION', '等待客户确认完成（PENDING_CONFIRMATION）'],
    ['COMPLETED', '订单已完成（COMPLETED）'],
    ['CANCELLED', '订单已取消（CANCELLED）']
  ])('updates the existing staff coordination card when the order becomes %s', async (status, expectedStatus) => {
    const staffNonce = createHash('sha256').update(`accepted-staff:${projection.orderId}`).digest('hex').slice(0, 24);
    const staffMessageId = '530000000000000021';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/channels/${projection.staffTaskChannelId}/messages?`))
        return response(200, [{ id: staffMessageId, nonce: staffNonce, timestamp: notBefore }]);
      if (url.endsWith(`/channels/${projection.staffTaskChannelId}/messages/${staffMessageId}`))
        return response(200, { id: staffMessageId });
      if (url.endsWith(`/channels/${projection.channelId}/messages/${projection.panelMessageId}`))
        return response(200, { id: projection.panelMessageId });
      return response(204);
    });
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await adapter.upsertOrderPanel({
      ...projection,
      status,
      voiceChannelId: '530000000000000020'
    }, notBefore);

    const staffPatch = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith(`/channels/${projection.staffTaskChannelId}/messages/${staffMessageId}`) &&
      init?.method === 'PATCH'
    );
    expect(staffPatch).toBeDefined();
    const payload = JSON.parse(staffPatch?.[1]?.body as string);
    expect(payload.embeds[0].fields).toContainEqual({
      name: '当前状态',
      value: expectedStatus,
      inline: true
    });
    expect(JSON.stringify(payload.components)).toContain('/530000000000000020');
  });

  test('posts a replacement only when the existing panel PATCH returns 404', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(404, { message: 'Unknown Message' }))
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(200, { id: '530000000000000005' }));
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await expect(adapter.upsertOrderPanel({ ...projection, playerDiscordUserId: null, playerDiscordUserIds: [], filledPlayerCount: 0 }, notBefore)).resolves.toEqual({
      messageId: '530000000000000005',
      recreated: true
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(`/messages/${projection.panelMessageId}`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`https://discord.com/api/v10/channels/${projection.channelId}/messages?limit=100`);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`https://discord.com/api/v10/channels/${projection.channelId}/messages`);
    const replacementBody = JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string);
    expect(replacementBody).toMatchObject({ enforce_nonce: true });
    expect(replacementBody.nonce).toMatch(/^[a-f0-9]{24}$/u);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/permissions/'))).toBe(false);
  });

  test('recovers a remotely-created replacement panel by nonce before posting again', async () => {
    const nonce = createHash('sha256').update(`order-panel:${projection.orderId}`).digest('hex').slice(0, 24);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(404, { message: 'Unknown Message' }))
      .mockResolvedValueOnce(response(200, [{ id: '530000000000000005', nonce }]));
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await expect(adapter.upsertOrderPanel({ ...projection, playerDiscordUserId: null, playerDiscordUserIds: [], filledPlayerCount: 0 }, notBefore)).resolves.toEqual({
      messageId: '530000000000000005', recreated: true
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('exposes Discord retry_after when panel delivery is rate limited', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ retry_after: 0.5 }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0.5' }
    }));
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await expect(adapter.upsertOrderPanel({ ...projection, playerDiscordUserId: null, playerDiscordUserIds: [], filledPlayerCount: 0 }, notBefore))
      .rejects.toMatchObject({ retryAfterMs: 500 });
  });

  test('does not create a duplicate panel after a non-404 Discord failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(403, { message: 'Missing Permissions' }));
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await expect(adapter.upsertOrderPanel({ ...projection, playerDiscordUserId: null, playerDiscordUserIds: [], filledPlayerCount: 0 }, notBefore))
      .rejects.toBeInstanceOf(WorkerAdapterError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' }
  });
}
