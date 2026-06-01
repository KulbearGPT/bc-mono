import { describe, expect, test, vi } from 'vitest';
import {
  buildDiscordIdempotencyKey,
  buildOrderNotesModal,
  buildOrderPanelMessage,
  buildPrivateOrderChannelPlan,
  buildPublicServiceEntryMessage,
  handleCreateOrderFromPublicEntry,
  handleOrderNotesSubmit,
  handleOrderSelectSubmit,
  parseServiceCenterCustomId,
  HttpBotApiClient,
  type BotApiClient,
  type OrderSummary
} from '@blackcat/bot/service-center';
import { discoverSapphirePieces } from '@blackcat/bot/piece-manifest';

const guildId = '999999999999999999';
const customerDiscordUserId = '111111111111111111';
const interactionId = '777777777777777777';
const orderId = '00000000-0000-0000-0000-00000000b001';

function actor() {
  return {
    guildId,
    discordUserId: customerDiscordUserId,
    interactionId,
    clientSource: 'DISCORD_BOT' as const
  };
}

function draftOrder(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: orderId,
    publicId: 'P-1042',
    status: 'DRAFT',
    version: 3,
    game: 'VALORANT',
    service: 'ENTERTAINMENT',
    region: 'NA',
    billingUnitMinutes: 60,
    unitCount: 2,
    amountMinor: 12_000,
    currency: 'CAT',
    notes: '轻松交流，不急着上分',
    channelSpec: {
      channelId: '120000000000000001',
      panelMessageId: '120000000000000002',
      voiceChannelId: null
    },
    ...overrides
  };
}

function api(overrides: Partial<BotApiClient> = {}): BotApiClient {
  return {
    createOrder: vi.fn().mockResolvedValue({ statusCode: 201, order: draftOrder() }),
    reportChannelCreationFailure: vi.fn().mockResolvedValue(undefined),
    updateOrder: vi.fn().mockResolvedValue(draftOrder({ version: 4 })),
    getOrder: vi.fn().mockResolvedValue(draftOrder()),
    ...overrides
  };
}

describe('M1-US-04 Sapphire public entry and Discord component contract', () => {
  test('renders a fixed public service entry with only two simple actions and no balance data', () => {
    const message = buildPublicServiceEntryMessage();

    expect(message.title).toBe('陪玩服务中心');
    expect(message.visibility).toBe('PUBLIC');
    expect(message.components).toEqual([
      {
        type: 'ACTION_ROW',
        components: [
          { type: 'BUTTON', style: 'PRIMARY', customId: 'bc:entry:create-order', label: '创建订单' },
          { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:entry:service-center', label: '我的服务中心' }
        ]
      }
    ]);
    expect(JSON.stringify(message)).not.toMatch(/balance|余额|available|reserved/i);
  });

  test('notes modal is a single optional text field bound to expected order version', () => {
    const modal = buildOrderNotesModal({ orderId, expectedVersion: 3 });

    expect(modal.title).toBe('补充订单备注');
    expect(modal.customId).toBe(`bc:modal:order-notes:${orderId}:v3`);
    expect(modal.components).toEqual([
      {
        type: 'TEXT_INPUT',
        customId: 'notes',
        label: '补充备注（可选）',
        style: 'PARAGRAPH',
        required: false,
        maxLength: 500
      }
    ]);
  });

  test('private order channel plan denies everyone, allows customer bot and staff, excludes players before accept', () => {
    const plan = buildPrivateOrderChannelPlan({
      guildId,
      orderPublicId: 'P-1042',
      customerDiscordUserId,
      botUserId: '999999999999999998',
      staffRoleIds: ['220000000000000001'],
      playerRoleId: '330000000000000001'
    });

    expect(plan.name).toBe('订单-p-1042');
    expect(plan.pinPanel).toBe(true);
    expect(plan.permissionOverwrites).toEqual(
      expect.arrayContaining([
        { id: guildId, kind: 'ROLE', allow: [], deny: ['VIEW_CHANNEL'] },
        { id: customerDiscordUserId, kind: 'MEMBER', allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'], deny: [] },
        { id: '999999999999999998', kind: 'MEMBER', allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'MANAGE_CHANNELS'], deny: [] },
        { id: '220000000000000001', kind: 'ROLE', allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'], deny: [] },
        { id: '330000000000000001', kind: 'ROLE', allow: [], deny: ['VIEW_CHANNEL'] }
      ])
    );
  });

  test('order panel renders structured message selects and current draft summary without leaking player payout', () => {
    const message = buildOrderPanelMessage(draftOrder());

    expect(message.title).toBe('订单 #P-1042');
    expect(message.body).toContain('无畏契约');
    expect(message.body).toContain('娱乐陪玩');
    expect(message.body).toContain('1,200.0 CAT');
    expect(message.components.flatMap((row) => row.components).map((component) => component.customId)).toEqual(
      expect.arrayContaining([
        `bc:select:order:${orderId}:game:v3`,
        `bc:select:order:${orderId}:service:v3`,
        `bc:select:order:${orderId}:region:v3`,
        `bc:select:order:${orderId}:duration:v3`,
        `bc:modal-open:order-notes:${orderId}:v3`
      ])
    );
    expect(JSON.stringify(message)).not.toMatch(/playerEarning|playerPayout|陪玩结算|可用余额|余额/);
  });

  test('custom ids route only safe interaction metadata and idempotency keys are interaction scoped', () => {
    expect(parseServiceCenterCustomId('bc:entry:create-order')).toEqual({ area: 'entry', action: 'create-order' });
    expect(parseServiceCenterCustomId(`bc:select:order:${orderId}:duration:v3`)).toEqual({
      area: 'order-select',
      orderId,
      field: 'duration',
      expectedVersion: 3
    });
    expect(parseServiceCenterCustomId(`bc:modal:order-notes:${orderId}:v3`)).toEqual({
      area: 'order-notes-modal',
      orderId,
      expectedVersion: 3
    });
    expect(parseServiceCenterCustomId('bc:modal:binding:sess-001')).toEqual({ area: 'unknown' });
    expect(parseServiceCenterCustomId('bc:select:order:not-a-uuid:duration:v3')).toEqual({ area: 'unknown' });
    expect(buildDiscordIdempotencyKey('order:update', interactionId)).toBe('discord:order:update:777777777777777777');
  });

  test('Sapphire discovers command and interaction-handler pieces for the service center', async () => {
    const manifest = await discoverSapphirePieces();

    expect(manifest.pieces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'commands', name: 'service-center' }),
        expect.objectContaining({ kind: 'interaction-handlers', name: 'service-center-buttons' }),
        expect.objectContaining({ kind: 'interaction-handlers', name: 'order-selects' }),
        expect.objectContaining({ kind: 'interaction-handlers', name: 'service-center-modals' })
      ])
    );
  });
});

describe('M1-US-04 Sapphire interaction flow calls unified API instead of owning business logic', () => {
  test('create order directs an unavailable account to support', async () => {
    const client = api({
      createOrder: vi.fn().mockRejectedValue({
        code: 'ACCOUNT_NOT_BOUND',
        message: 'Current Discord actor is not bound.',
        requestId: 'req-bind'
      })
    });

    const result = await handleCreateOrderFromPublicEntry({
      api: client,
      actor: actor(),
      provisionalChannel: {
        channelId: '120000000000000001',
        panelMessageId: '120000000000000002',
        voiceChannelId: null
      },
      idempotencyKey: 'discord:create-order:777777777777777777'
    });

    expect(client.createOrder).toHaveBeenCalledWith(
      {
        orderType: 'IMMEDIATE',
        channelSpec: {
          channelId: '120000000000000001',
          panelMessageId: '120000000000000002',
          voiceChannelId: null
        }
      },
      actor(),
      'discord:create-order:777777777777777777'
    );
    expect(result).toEqual({ kind: 'EPHEMERAL_MESSAGE', message: '账户暂不可用，请联系客服协助开通。' });
  });

  test('create order returns existing active channel without planning a second submittable order', async () => {
    const existing = draftOrder({ channelSpec: { channelId: '120000000000000009', panelMessageId: '120000000000000010', voiceChannelId: null } });
    const client = api({
      createOrder: vi.fn().mockResolvedValue({ statusCode: 200, order: existing })
    });

    const result = await handleCreateOrderFromPublicEntry({
      api: client,
      actor: actor(),
      provisionalChannel: {
        channelId: '120000000000000001',
        panelMessageId: '120000000000000002',
        voiceChannelId: null
      },
      idempotencyKey: 'discord:create-order:777777777777777777'
    });

    expect(result).toMatchObject({
      kind: 'OPEN_EXISTING_CHANNEL',
      channelId: '120000000000000009',
      orderId
    });
  });

  test('create order maps channel creation failure to a non-submittable recovery result', async () => {
    const result = await handleCreateOrderFromPublicEntry({
      api: api(),
      actor: actor(),
      provisionalChannel: null,
      idempotencyKey: 'discord:create-order:channel-failed'
    });

    expect(result).toEqual({
      kind: 'CHANNEL_CREATION_FAILED',
      message: expect.stringMatching(/^订单频道创建失败，请稍后重试或联系客服。request_id: req_/)
    });
  });

  test('channel failure reporting retries once and keeps a deterministic support request id', async () => {
    const report = vi.fn().mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce(undefined);
    const input = { api: api({ reportChannelCreationFailure: report }), actor: actor(), provisionalChannel: null,
      idempotencyKey: 'discord:create-order:channel-failed-retry' } as const;

    const first = await handleCreateOrderFromPublicEntry(input);
    const second = await handleCreateOrderFromPublicEntry(input);

    expect(report).toHaveBeenCalledTimes(3);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ kind: 'CHANNEL_CREATION_FAILED', message: expect.not.stringContaining('故障记录上报失败') });
  });

  test('structured select submit calls updateOrder with expectedVersion and edits the original panel', async () => {
    const client = api();

    const result = await handleOrderSelectSubmit({
      api: client,
      actor: actor(),
      orderId,
      expectedVersion: 3,
      field: 'duration',
      value: '2',
      idempotencyKey: 'discord:order:update:duration'
    });

    expect(client.updateOrder).toHaveBeenCalledWith(
      orderId,
      { expectedVersion: 3, unitCount: 2 },
      actor(),
      'discord:order:update:duration'
    );
    expect(result.kind).toBe('EDIT_ORIGINAL_MESSAGE');
    expect(result.message.title).toBe('订单 #P-1042');
  });

  test('notes submit calls updateOrder and stale version conflicts refresh from API', async () => {
    const refreshed = draftOrder({ version: 6, notes: '旧版本已刷新' });
    const client = api({
      updateOrder: vi.fn().mockRejectedValue({ code: 'CONFLICT', requestId: 'req-conflict' }),
      getOrder: vi.fn().mockResolvedValue(refreshed)
    });

    const result = await handleOrderNotesSubmit({
      api: client,
      actor: actor(),
      orderId,
      expectedVersion: 3,
      notes: '新的备注',
      idempotencyKey: 'discord:order:update:notes'
    });

    expect(client.updateOrder).toHaveBeenCalledWith(
      orderId,
      { expectedVersion: 3, notes: '新的备注' },
      actor(),
      'discord:order:update:notes'
    );
    expect(client.getOrder).toHaveBeenCalledWith(orderId, actor());
    expect(result.kind).toBe('EDIT_ORIGINAL_MESSAGE');
    expect(result.message.body).toContain('旧版本已刷新');
    expect(result.notice).toBe('订单已被其他操作更新，已刷新最新内容。request_id: req-conflict');
  });
});

describe('M1-US-04 Bot HTTP API client contract', () => {
  test('sends trusted Discord actor context, bot token and idempotency headers to unified API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ data: draftOrder() })
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBotApiClient({
      apiBaseUrl: 'https://api.example.test',
      botServiceToken: 'bot-token'
    });

    await client.createOrder(
      {
        orderType: 'IMMEDIATE',
        channelSpec: {
          channelId: '120000000000000001',
          panelMessageId: '120000000000000002',
          voiceChannelId: null
        }
      },
      actor(),
      'discord:create-order:777777777777777777'
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/orders',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer bot-token',
          'content-type': 'application/json',
          'x-client-source': 'DISCORD_BOT',
          'x-actor-discord-user-id': customerDiscordUserId,
          'x-actor-guild-id': guildId,
          'x-discord-interaction-id': interactionId,
          'idempotency-key': 'discord:create-order:777777777777777777'
        })
      })
    );
  });

  test('maps unified API error envelopes to Bot flow errors with request id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          requestId: 'req-api-403',
          error: { code: 'ACCOUNT_NOT_BOUND', message: 'Current Discord actor is not bound.' }
        })
      })
    );
    const client = new HttpBotApiClient({
      apiBaseUrl: 'https://api.example.test/',
      botServiceToken: 'bot-token'
    });

    await expect(
      client.createOrder(
        {
          orderType: 'IMMEDIATE',
          channelSpec: {
            channelId: '120000000000000001',
            panelMessageId: '120000000000000002',
            voiceChannelId: null
          }
        },
        actor(),
        'discord:create-order:not-bound'
      )
    ).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_BOUND',
      requestId: 'req-api-403',
      statusCode: 403
    });
  });
});
