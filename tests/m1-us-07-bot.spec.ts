import { describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  BotApiError,
  HttpBotApiClient,
  buildOrderConfirmationMessage,
  handleOpenOrderConfirmation,
  parseServiceCenterCustomId,
  type BalanceSummary,
  type BotActorContext,
  type BotApiClient,
  type OrderSummary
} from '@blackcat/bot/service-center';

const guildId = '999999999999999999';
const customerDiscordUserId = '111111111111111111';
const interactionId = '777777777777777777';
const orderId = '00000000-0000-0000-0000-00000000b001';

function actor(): BotActorContext {
  return {
    guildId,
    discordUserId: customerDiscordUserId,
    interactionId,
    clientSource: 'DISCORD_BOT'
  };
}

function draftOrder(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: orderId,
    publicId: 'P-1042',
    status: 'DRAFT',
    version: 5,
    game: 'VALORANT',
    service: 'ENTERTAINMENT',
    region: 'NA',
    billingUnitMinutes: 60,
    unitCount: 2,
    amountMinor: 9_999,
    currency: 'CNY',
    notes: '轻松交流，不急着上分',
    channelSpec: {
      channelId: '120000000000000001',
      panelMessageId: '120000000000000002',
      voiceChannelId: null
    },
    ...overrides
  };
}

function estimate(overrides: Record<string, unknown> = {}) {
  return {
    serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
    catalogVersion: 3,
    unitCount: 2,
    billingUnitMinutes: 60,
    amountMinor: 12_000,
    currency: 'CNY',
    validUntil: '2026-07-17T22:05:00.000Z',
    ...overrides
  };
}

function balance(overrides: Partial<BalanceSummary> = {}): BalanceSummary {
  return {
    providerBalanceMinor: 20_000,
    reservedMinor: 2_000,
    availableMinor: 18_000,
    currency: 'CNY',
    fetchedAt: '2026-07-17T22:00:00.000Z',
    ...overrides
  };
}

function api(overrides: Partial<BotApiClient> = {}): BotApiClient {
  return {
    createBinding: vi.fn(),
    createOrder: vi.fn(),
    getOrder: vi.fn().mockResolvedValue(draftOrder()),
    updateOrder: vi.fn(),
    getCurrentUser: vi.fn(),
    getCurrentBalance: vi.fn().mockResolvedValue(balance()),
    listCurrentUserConsumptions: vi.fn(),
    listCurrentUserCommissions: vi.fn(),
    estimateOrder: vi.fn().mockResolvedValue(estimate()),
    ...overrides
  };
}

describe('M1-US-07 order confirmation panel', () => {
  test('renders a complete private confirmation from estimate and balance, not draft amount fields', () => {
    const message = buildOrderConfirmationMessage({
      order: draftOrder({ amountMinor: 1 }),
      estimate: estimate({ amountMinor: 12_000 }),
      balance: balance({ availableMinor: 18_000 })
    });

    expect(message.visibility).toBe('PRIVATE_CHANNEL');
    expect(message.title).toBe('订单 #P-1042 · 最后确认');
    expect(message.body).toContain('游戏：无畏契约');
    expect(message.body).toContain('服务：娱乐陪玩');
    expect(message.body).toContain('区服：北美');
    expect(message.body).toContain('时长：2 小时');
    expect(message.body).toContain('标签：P0 默认匹配');
    expect(message.body).toContain('备注：轻松交流，不急着上分');
    expect(message.body).toContain('预计价格：¥120.00');
    expect(message.body).toContain('可用余额：¥180.00');
    expect(message.body).toContain('取消规则：提交前取消不预留；提交后、服务开始前取消将释放预留，异常由客服处理。');
    expect(message.body).not.toContain('¥0.01');
    expect(message.components.flatMap((row) => row.components)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'BUTTON',
          customId: `bc:order:${orderId}:submit-final:v5`,
          label: '确认提交并预留',
          disabled: false
        })
      ])
    );
    expect(JSON.stringify(message)).not.toMatch(/playerEarning|playerPayout|陪玩结算|playerUnitPayout/i);
  });

  test('disables final submit when API balance says available amount is insufficient', () => {
    const message = buildOrderConfirmationMessage({
      order: draftOrder(),
      estimate: estimate({ amountMinor: 12_000 }),
      balance: balance({ availableMinor: 8_000 })
    });

    expect(message.body).toContain('余额不足：还差 ¥40.00，请充值后刷新确认。');
    expect(message.components.flatMap((row) => row.components)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          customId: `bc:order:${orderId}:submit-final:v5`,
          disabled: true
        }),
        expect.objectContaining({
          customId: 'bc:service-center:recharge',
          label: '前往充值',
          disabled: false
        })
      ])
    );
  });

  test('opens confirmation by calling getOrder, estimateOrder and getCurrentBalance through unified API client', async () => {
    const client = api();

    const result = await handleOpenOrderConfirmation({
      api: client,
      actor: actor(),
      orderId,
      expectedVersion: 5,
      idempotencyKey: 'discord:order:estimate:777777777777777777'
    });

    expect(client.getOrder).toHaveBeenCalledWith(orderId, actor());
    expect(client.estimateOrder).toHaveBeenCalledWith(
      orderId,
      { expectedVersion: 5 },
      actor(),
      'discord:order:estimate:777777777777777777'
    );
    expect(client.getCurrentBalance).toHaveBeenCalledWith(actor());
    expect(result.kind).toBe('EDIT_ORIGINAL_MESSAGE');
    expect(result.message.body).toContain('预计价格：¥120.00');
  });

  test('refreshes the draft panel when expectedVersion is stale instead of submitting stale data', async () => {
    const refreshed = draftOrder({ version: 6, notes: '已刷新' });
    const client = api({
      estimateOrder: vi.fn().mockRejectedValue(
        new BotApiError({
          code: 'CONFLICT',
          message: 'Order version is stale.',
          requestId: 'req-stale',
          statusCode: 409
        })
      ),
      getOrder: vi.fn().mockResolvedValue(refreshed)
    });

    const result = await handleOpenOrderConfirmation({
      api: client,
      actor: actor(),
      orderId,
      expectedVersion: 5,
      idempotencyKey: 'discord:order:estimate:stale'
    });

    expect(result.kind).toBe('EDIT_ORIGINAL_MESSAGE');
    expect(result.message.title).toBe('订单 #P-1042');
    expect(result.message.body).toContain('已刷新');
    expect(result.notice).toBe('订单已被其他操作更新，已刷新最新内容。request_id: req-stale');
  });

  test('routes confirmation custom id with only order id, action and expected version metadata', () => {
    expect(parseServiceCenterCustomId(`bc:order:${orderId}:submit:v5`)).toEqual({
      area: 'order-action',
      orderId,
      action: 'submit',
      expectedVersion: 5
    });
  });
});

describe('M1-US-07 Bot HTTP estimate client', () => {
  test('calls the reusable estimateOrder endpoint with actor and idempotency headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: estimate() })
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBotApiClient({
      apiBaseUrl: 'https://api.example.test/',
      botServiceToken: 'bot-token'
    });

    await client.estimateOrder(
      orderId,
      { expectedVersion: 5 },
      actor(),
      'discord:order:estimate:777777777777777777'
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.example.test/api/v1/orders/${orderId}/estimate`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ expectedVersion: 5 }),
        headers: expect.objectContaining({
          authorization: 'Bearer bot-token',
          'content-type': 'application/json',
          'x-client-source': 'DISCORD_BOT',
          'x-actor-discord-user-id': customerDiscordUserId,
          'x-actor-guild-id': guildId,
          'x-discord-interaction-id': interactionId,
          'idempotency-key': 'discord:order:estimate:777777777777777777'
        })
      })
    );
  });
});

describe('M1-US-07 Sapphire order confirmation wiring', () => {
  test('wires order submit button to confirmation flow instead of treating it as unknown', async () => {
    const source = await readFile('apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts', 'utf8');

    expect(source).toContain('handleOpenOrderConfirmation');
    expect(source).toContain("route.area === 'entry' || route.area === 'order-action'");
    expect(source).toContain('buildDiscordIdempotencyKey');
  });
});
