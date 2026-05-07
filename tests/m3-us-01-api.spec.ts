import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import { InMemoryAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';
import { InMemoryOrderStore, type OrderRecord } from '@blackcat/api/orders';
import { MockFundingAdapter } from '@blackcat/api/payment-adapter';
import {
  InMemoryGiftStore,
  type GiftCatalogRecord,
  registerGiftRoutes
} from '@blackcat/api/gifts';

const now = new Date('2026-07-18T12:00:00.000Z');
const orderId = '00000000-0000-0000-0000-000000003101';
const customerId = '00000000-0000-0000-0000-000000003102';
const playerId = '00000000-0000-0000-0000-000000003103';
const guildId = '900000000000000001';

function binding(externalUserId = 'mock-user-ok'): AccountBindingRecord {
  return {
    userId: customerId, displayName: '小林', userStatus: 'ACTIVE', userVersion: 1,
    discordAccountId: '00000000-0000-0000-0000-000000003104', guildId,
    discordUserId: '900000000000000002', externalAccountId: '00000000-0000-0000-0000-000000003105',
    provider: 'mock-provider', externalUserId, externalUserDisplay: 'mock-***',
    externalAccountStatus: 'ACTIVE', boundAt: now.toISOString()
  };
}

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: orderId, publicId: 'P-3101', customerId, playerId, status: 'IN_SERVICE', version: 7,
    serviceCatalogId: null, catalogVersion: null, game: 'VALORANT', service: 'ENTERTAINMENT', region: 'NA',
    billingUnitMinutes: 60, unitCount: 2, customerUnitPriceMinor: 6000, playerUnitPayoutMinor: 4200,
    amountMinor: 12000, playerEarningMinor: 8400, currency: 'CNY', notes: null,
    channelSpec: { channelId: '900000000000000003', panelMessageId: '900000000000000004', voiceChannelId: '900000000000000005' },
    createdAt: now.toISOString(), updatedAt: now.toISOString(), ...overrides
  };
}

function gift(overrides: Partial<GiftCatalogRecord> = {}): GiftCatalogRecord {
  return {
    id: '00000000-0000-0000-0000-000000003110', itemId: '00000000-0000-0000-0000-000000003111',
    code: 'STAR_BOX', version: 2, status: 'ACTIVE', name: '星光礼盒', priceMinor: 199900,
    currency: 'CNY', broadcastTemplate: '{sender_name} 向 {receiver_name} 送出 {gift_name}',
    ...overrides
  };
}

function headers(key?: string) {
  return {
    authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': binding().discordUserId, 'x-actor-guild-id': guildId,
    'x-discord-interaction-id': '900000000000000006', ...(key ? { 'idempotency-key': key } : {})
  };
}

function fixture(input: { order?: OrderRecord; gifts?: GiftCatalogRecord[]; externalUserId?: string } = {}) {
  const orders = new InMemoryOrderStore({ orders: [input.order ?? order()] });
  const gifts = new InMemoryGiftStore({ catalog: input.gifts ?? [gift()] });
  const accounts = new InMemoryAccountStore({
    bindings: [binding(input.externalUserId)],
    reservationSource: () => gifts.reservations
  });
  const server = buildApiServer({
    env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    security: { auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() }
  });
  registerGiftRoutes(server, {
    store: gifts, orderStore: orders, accountStore: accounts,
    fundingAdapter: new MockFundingAdapter({ now }), providerKey: 'mock-provider', now: () => now
  });
  return { server, gifts };
}

describe('M3-US-01 gift catalog and order gift request', () => {
  test('lists only active gifts with affordability derived from the current balance', async () => {
    const { server } = fixture({ gifts: [gift(), gift({ id: '00000000-0000-0000-0000-000000003112', status: 'RETIRED', code: 'OLD' })] });
    const response = await server.inject({ method: 'GET', url: `/api/v1/gifts?orderId=${orderId}`, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: {
      orderId, receiver: { userId: playerId }, balance: { availableMinor: 1_000_000, currency: 'CNY' },
      items: [{ code: 'STAR_BOX', priceMinor: 199900, affordable: true }]
    } });
    expect(response.json().data.items).toHaveLength(1);
  });

  test.each(['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION'] as const)('creates a pending request, reservation, and review task for %s', async (status) => {
    const { server, gifts } = fixture({ order: order({ status }) });
    const response = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/gift-requests`, headers: headers(`gift:P-3101:${status}`),
      payload: { expectedOrderVersion: 7, giftCatalogVersionId: gift().id, receiverId: '00000000-0000-0000-0000-00000000ffff' }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ data: {
      orderId, senderId: customerId, receiverId: playerId, status: 'PENDING_REVIEW',
      gift: { code: 'STAR_BOX', name: '星光礼盒', priceMinor: 199900, currency: 'CNY' },
      reservation: { sourceType: 'GIFT', status: 'ACTIVE', amountMinor: 199900 },
      staffTask: { type: 'GIFT_REVIEW', status: 'OPEN' }
    } });
    expect(gifts.requests).toHaveLength(1);
    expect(gifts.reservations).toHaveLength(1);
    expect(gifts.staffTasks).toHaveLength(1);
    expect(gifts.captures).toHaveLength(0);
    expect(gifts.broadcasts).toHaveLength(0);
  });

  test('allows COMPLETED exactly through 24 hours and rejects it one millisecond later', async () => {
    const boundary = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    const allowed = fixture({ order: order({ status: 'COMPLETED', completedAt: boundary }) });
    const ok = await allowed.server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/gift-requests`, headers: headers('gift:P-3101:boundary'),
      payload: { expectedOrderVersion: 7, giftCatalogVersionId: gift().id }
    });
    expect(ok.statusCode).toBe(201);

    const expired = fixture({ order: order({ status: 'COMPLETED', completedAt: new Date(Date.parse(boundary) - 1).toISOString() }) });
    const rejected = await expired.server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/gift-requests`, headers: headers('gift:P-3101:expired'),
      payload: { expectedOrderVersion: 7, giftCatalogVersionId: gift().id }
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ error: { code: 'GIFT_WINDOW_CLOSED' } });
  });

  test('rejects insufficient available balance without creating any business records', async () => {
    const { server, gifts } = fixture({ externalUserId: 'mock-user-low' });
    const response = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/gift-requests`, headers: headers('gift:P-3101:insufficient'),
      payload: { expectedOrderVersion: 7, giftCatalogVersionId: gift().id }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_AVAILABLE_BALANCE' } });
    expect(gifts.requests).toHaveLength(0);
    expect(gifts.reservations).toHaveLength(0);
    expect(gifts.staffTasks).toHaveLength(0);
  });

  test('replays the same idempotent response without duplicating request, reservation, or task', async () => {
    const { server, gifts } = fixture();
    const request = {
      method: 'POST' as const, url: `/api/v1/orders/${orderId}/gift-requests`, headers: headers('gift:P-3101:retry'),
      payload: { expectedOrderVersion: 7, giftCatalogVersionId: gift().id }
    };
    const first = await server.inject(request);
    const second = await server.inject(request);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().data.id).toBe(first.json().data.id);
    expect(gifts.requests).toHaveLength(1);
    expect(gifts.reservations).toHaveLength(1);
    expect(gifts.staffTasks).toHaveLength(1);
  });
});
