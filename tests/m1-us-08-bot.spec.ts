import { describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  HttpBotApiClient,
  buildSubmittedOrderMessage,
  handleSubmitFinalOrder,
  type BotActorContext,
  type BotApiClient
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

function reservationResult() {
  return {
    orderId,
    status: 'PENDING_DISPATCH' as const,
    version: 3,
    reservation: {
      reservationId: '00000000-0000-0000-0000-00000000f001',
      amountMinor: 12_000,
      capturedMinor: 0,
      releasedMinor: 0,
      currency: 'CAT',
      status: 'ACTIVE',
      version: 1,
      expiresAt: '2026-07-17T23:30:00.000Z'
    },
    balance: {
      ledgerBalanceMinor: 1_000_000,
      reservedMinor: 12_000,
      availableMinor: 988_000,
      currency: 'CAT',
      calculatedAt: '2026-07-17T23:00:00.000Z'
    }
  };
}

function api(overrides: Partial<BotApiClient> = {}): BotApiClient {
  return {
    createBinding: vi.fn(),
    createOrder: vi.fn(),
    getOrder: vi.fn(),
    updateOrder: vi.fn(),
    getCurrentUser: vi.fn(),
    getCurrentBalance: vi.fn(),
    listCurrentUserConsumptions: vi.fn(),
    listCurrentUserCommissions: vi.fn(),
    estimateOrder: vi.fn(),
    submitOrder: vi.fn().mockResolvedValue(reservationResult()),
    cancelOrder: vi.fn(),
    ...overrides
  };
}

describe('M1-US-08 final submit Bot flow', () => {
  test('renders submitted order state with reservation and post-submit balance from API result', () => {
    const message = buildSubmittedOrderMessage(reservationResult());

    expect(message.visibility).toBe('PRIVATE_CHANNEL');
    expect(message.title).toBe('🔎 订单已提交 · 正在匹配陪玩');
    expect(message.body).toContain('订单状态：PENDING_DISPATCH');
    expect(message.body).toContain('本单预留：1,200.0 CAT');
    expect(message.body).toContain('提交后可用余额：98,800.0 CAT');
    expect(message.body).toContain('目前只是预留本单所需猫条，还没有产生正式消费。');
    expect(message.body).toContain('猫舍正在为你寻找合适的陪玩');
    expect(JSON.stringify(message.components)).toContain(`bc:order:${orderId}:refresh`);
    expect(JSON.stringify(message.components)).not.toContain(`bc:order:${orderId}:submit:v`);
    expect(JSON.stringify(message)).not.toMatch(/playerEarning|playerPayout|陪玩结算/i);
  });

  test('submit-final calls submitOrder through unified API and edits the private order panel', async () => {
    const client = api();

    const result = await handleSubmitFinalOrder({
      api: client,
      actor: actor(),
      orderId,
      expectedVersion: 2,
      idempotencyKey: 'discord:order:submit-final:777777777777777777'
    });

    expect(client.submitOrder).toHaveBeenCalledWith(
      orderId,
      { expectedVersion: 2 },
      actor(),
      'discord:order:submit-final:777777777777777777'
    );
    expect(result.kind).toBe('EDIT_ORIGINAL_MESSAGE');
    expect(result.message.body).toContain('本单预留：1,200.0 CAT');
  });

  test('wires submit-final button to the final submit flow', async () => {
    const source = await readFile('apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts', 'utf8');

    expect(source).toContain('handleSubmitFinalOrder');
    expect(source).toContain("parsedData.action === 'submit-final'");
    expect(source).toContain("buildDiscordIdempotencyKey('order:submit-final', interaction.id)");
  });
});

describe('M1-US-08 Bot HTTP funding clients', () => {
  test('posts submitOrder and cancelOrder to reusable funding endpoints with actor and idempotency headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: reservationResult() })
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBotApiClient({
      apiBaseUrl: 'https://api.example.test/',
      botServiceToken: 'bot-token'
    });

    await client.submitOrder(orderId, { expectedVersion: 2 }, actor(), 'discord:order:submit-final:777');
    await client.cancelOrder(
      orderId,
      {
        expectedVersion: 3,
        previewId: '00000000-0000-0000-0000-00000000c999',
        reasonCode: 'CUSTOMER_REQUEST'
      },
      actor(),
      'discord:order:cancel:777'
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `https://api.example.test/api/v1/orders/${orderId}/submit`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ expectedVersion: 2 }),
        headers: expect.objectContaining({
          authorization: 'Bearer bot-token',
          'x-client-source': 'DISCORD_BOT',
          'x-actor-discord-user-id': customerDiscordUserId,
          'x-actor-guild-id': guildId,
          'x-discord-interaction-id': interactionId,
          'idempotency-key': 'discord:order:submit-final:777'
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.example.test/api/v1/orders/${orderId}/cancel`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: 3,
          previewId: '00000000-0000-0000-0000-00000000c999',
          reasonCode: 'CUSTOMER_REQUEST'
        }),
        headers: expect.objectContaining({
          'idempotency-key': 'discord:order:cancel:777'
        })
      })
    );
  });
});
