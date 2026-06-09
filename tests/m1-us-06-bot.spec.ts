import { describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  BotApiError,
  HttpBotApiClient,
  buildServiceCenterMessage,
  handleOpenServiceCenterFromPublicEntry,
  type BotActorContext,
  type BotApiClient,
  type OrderSummary
} from '@blackcat/bot/service-center';

const guildId = '999999999999999999';
const customerDiscordUserId = '111111111111111111';
const interactionId = '777777777777777777';
const activeOrderId = '00000000-0000-0000-0000-00000000b001';

function actor(): BotActorContext {
  return {
    guildId,
    discordUserId: customerDiscordUserId,
    interactionId,
    clientSource: 'DISCORD_BOT'
  };
}

function currentUser(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: '00000000-0000-0000-0000-00000000a001',
      displayName: '用户小林',
      status: 'ACTIVE',
      externalAccountDisplay: 'mock-***-ok',
      activeOrderId,
      riskFlags: [],
      version: 2
    },
    activeOrderId,
    consumptionSummary: { totalMinor: 0, currency: 'CAT' },
    commissionSummary: { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: 'CAT' },
    ...overrides
  };
}

function balance() {
  return {
    ledgerBalanceMinor: 20_000,
    reservedMinor: 12_000,
    availableMinor: 8_000,
    currency: 'CAT',
    calculatedAt: '2026-07-17T22:00:00.000Z',
    version: 1
  };
}

function currentOrder(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: activeOrderId,
    publicId: 'P-1042',
    status: 'PENDING_DISPATCH',
    version: 5,
    game: 'VALORANT',
    service: 'ENTERTAINMENT',
    region: 'NA',
    billingUnitMinutes: 60,
    unitCount: 2,
    amountMinor: 12_000,
    currency: 'CAT',
    notes: null,
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
    createOrder: vi.fn(),
    getOrder: vi.fn().mockResolvedValue(currentOrder()),
    updateOrder: vi.fn(),
    getCurrentUser: vi.fn().mockResolvedValue(currentUser()),
    getCurrentBalance: vi.fn().mockResolvedValue(balance()),
    listCurrentUserConsumptions: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCurrentUserCommissions: vi.fn().mockResolvedValue({
      summary: { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: 'CAT' },
      items: [],
      nextCursor: null
    }),
    ...overrides
  };
}

describe('M1-US-06 private service center Discord flow', () => {
  test('builds an ephemeral personal panel with real-time balance, current order and stable empty summaries', () => {
    const message = buildServiceCenterMessage({
      currentUser: currentUser(),
      balance: balance(),
      activeOrder: currentOrder(),
      consumptions: { items: [], nextCursor: null },
      commissions: {
        summary: { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: 'CAT' },
        items: [],
        nextCursor: null
      }
    });

    expect(message.visibility).toBe('EPHEMERAL');
    expect(message.title).toBe('我的服务中心');
    expect(message.body).toContain('账本余额：2,000.0 CAT');
    expect(message.body).toContain('预留中：1,200.0 CAT');
    expect(message.body).toContain('可用余额：800.0 CAT');
    expect(message.body).toContain('当前订单：#P-1042 · PENDING_DISPATCH');
    expect(message.body).toContain('消费记录：暂无记录');
    expect(message.body).toContain('我的收益：暂无可领取记录');
    expect(message.components.flatMap((row) => row.components).map((component) => component.customId)).toEqual(
      expect.arrayContaining([
        'bc:entry:service-center',
        `bc:order:${activeOrderId}:open`,
        'bc:profile:open',
        'bc:profile:consumptions:first',
        'bc:service-center:commissions'
      ])
    );
    expect(JSON.stringify(message)).not.toMatch(/externalUserId|mock-user-ok|sourceCustomer|beneficiaryId|rateBps|referralAttribution/i);
  });

  test('opens service center by reading reusable API endpoints and active order through the Bot API client', async () => {
    const client = api();

    const result = await handleOpenServiceCenterFromPublicEntry({
      api: client,
      actor: actor()
    });

    expect(client.getCurrentUser).toHaveBeenCalledWith(actor());
    expect(client.getCurrentBalance).toHaveBeenCalledWith(actor());
    expect(client.listCurrentUserConsumptions).toHaveBeenCalledWith(actor());
    expect(client.listCurrentUserCommissions).toHaveBeenCalledWith(actor());
    expect(client.getOrder).toHaveBeenCalledWith(activeOrderId, actor());
    expect(result.kind).toBe('SHOW_SERVICE_CENTER');
    expect(result.message.visibility).toBe('EPHEMERAL');
    expect(result.message.body).toContain('当前订单：#P-1042');
  });

  test('directs an unavailable account to support', async () => {
    const client = api({
      getCurrentUser: vi.fn().mockRejectedValue(
        new BotApiError({
          code: 'ACCOUNT_NOT_BOUND',
          message: 'Current Discord actor is not bound.',
          requestId: 'req-bind',
          statusCode: 403
        })
      )
    });

    const result = await handleOpenServiceCenterFromPublicEntry({
      api: client,
      actor: actor()
    });

    expect(result).toEqual({ kind: 'EPHEMERAL_MESSAGE', message: '账户还没有准备好，请联系猫舍前台协助开通。' });
  });
});

describe('M1-US-06 Bot HTTP client current-user API reuse', () => {
  test('calls /me, /me/balance, /me/consumptions and /me/commissions with trusted Discord actor headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: {} })
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBotApiClient({
      apiBaseUrl: 'https://api.example.test/',
      botServiceToken: 'bot-token'
    });

    await client.getCurrentUser(actor());
    await client.getCurrentBalance(actor());
    await client.listCurrentUserConsumptions(actor());
    await client.listCurrentUserCommissions(actor());

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.example.test/api/v1/me',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.example.test/api/v1/me/balance',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://api.example.test/api/v1/me/consumptions',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'https://api.example.test/api/v1/me/commissions',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer bot-token',
          'x-client-source': 'DISCORD_BOT',
          'x-actor-discord-user-id': customerDiscordUserId,
          'x-actor-guild-id': guildId,
          'x-discord-interaction-id': interactionId
        })
      })
    );
  });
});

describe('M1-US-06 Sapphire button handler wiring', () => {
  test('wires 我的服务中心 button to API-backed service-center flow instead of placeholder text', async () => {
    const source = await readFile('apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts', 'utf8');

    expect(source).toContain('handleOpenServiceCenterFromPublicEntry');
    expect(source).toContain('HttpBotApiClient');
    expect(source).toContain('toDiscordReply(result.message)');
    expect(source).not.toContain('正在打开你的服务中心。');
  });
});
