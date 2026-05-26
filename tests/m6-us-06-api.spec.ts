import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import { InMemoryAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';
import { InMemoryOrderStore, type OrderRecord } from '@blackcat/api/orders';
import { InMemoryGiftStore, registerGiftRoutes, type GiftCatalogRecord } from '@blackcat/api/gifts';
import { TestWalletFunding } from './support/wallet-fixture';

const now = new Date('2026-07-19T21:00:00.000Z');
const orderId = '00000000-0000-0000-0000-000000006601';
const customerId = '00000000-0000-0000-0000-000000006602';
const playerId = '00000000-0000-0000-0000-000000006603';
const guildId = '900000000000006600';
const topUpInstructions = '联系客服并提交付款 receipt。';

function catalog(overrides: Partial<GiftCatalogRecord> = {}): GiftCatalogRecord {
  return {
    id: '00000000-0000-0000-0000-000000006610', itemId: '00000000-0000-0000-0000-000000006611',
    code: 'STAR_BOX', version: 4, status: 'ACTIVE', name: '星光礼盒', priceMinor: 8_800,
    currency: 'USD', broadcastTemplate: '{sender_name} 向 {receiver_name} 送出 {gift_name}', ...overrides
  };
}

function fixture(input: { balance?: number; orderGuildId?: string } = {}) {
  const giftStore = new InMemoryGiftStore({ catalog: [catalog()] });
  const balanceReservations = [
    { id: 'r-order', userId: customerId, amountMinor: 500, currency: 'USD', status: 'ACTIVE' as const },
    { id: 'r-other-guild', userId: customerId, amountMinor: 9_000, currency: 'USD', status: 'ACTIVE' as const }
  ];
  const orderStore = new InMemoryOrderStore({ orders: [{
    id: orderId, publicId: 'P-6601', customerId, playerId, guildId: input.orderGuildId ?? guildId, status: 'IN_SERVICE', version: 7,
    serviceCatalogId: null, catalogVersion: null, game: 'VALORANT', service: 'ENTERTAINMENT', region: 'NA',
    billingUnitMinutes: 60, unitCount: 1, customerUnitPriceMinor: 6_000, playerUnitPayoutMinor: 4_200,
    amountMinor: 6_000, playerEarningMinor: 4_200, currency: 'USD', notes: null,
    channelSpec: { channelId: '900000000000006620', panelMessageId: '900000000000006621', voiceChannelId: '900000000000006622' },
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  } satisfies OrderRecord] });
  const binding: AccountBindingRecord = {
    userId: customerId, displayName: '小林', userStatus: 'ACTIVE', userVersion: 1,
    discordAccountId: '00000000-0000-0000-0000-000000006604', guildId,
    discordUserId: '900000000000006601', externalAccountId: '00000000-0000-0000-0000-000000006605',
    provider: 'mock-provider', externalUserId: 'mock-user-ok', externalUserDisplay: 'mock-***',
    externalAccountStatus: 'ACTIVE', boundAt: now.toISOString()
  };
  const accountStore = new InMemoryAccountStore({ bindings: [binding],
    reservationSource: () => [...balanceReservations, ...giftStore.reservations] });
  const walletFunding = new TestWalletFunding(input.balance ?? 5_000);
  walletFunding.addReservation('r-order', 500);
  walletFunding.addReservation('r-other-guild', 9_000);
  const auditSink = new InMemoryAuditSink();
  const server = buildApiServer({
    env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    security: { auditSink, idempotencyStore: new InMemoryIdempotencyStore() }
  });
  registerGiftRoutes(server, { store: giftStore, orderStore, accountStore, walletFunding,
    broadcastChannelId: '900000000000006630', now: () => now });
  return { server, giftStore, walletFunding, setBalance(value: number) { walletFunding.ledgerBalanceMinor = value; } };
}

function headers(idempotencyKey?: string) {
  return { authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': '900000000000006601', 'x-actor-guild-id': guildId,
    'x-discord-interaction-id': '900000000000006609', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) };
}

async function affordability(server: ReturnType<typeof buildApiServer>) {
  return server.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/gift-affordability`, headers: headers(),
    payload: { giftCatalogVersionId: catalog().id } });
}

function expectZeroWrites(store: InMemoryGiftStore, existingReservations = 0) {
  expect({ requests: store.requests.length, reservations: store.reservations.length, tasks: store.staffTasks.length,
    consumptions: store.consumptions.length, outbox: store.broadcasts.length + store.expiryJobs.length }).toEqual({
    requests: 0, reservations: existingReservations, tasks: 0, consumptions: 0, outbox: 0
  });
}

describe('M6-US-06 gift affordability API', () => {
  test('returns an exact unaffordable snapshot and performs zero business writes', async () => {
    const { server, giftStore, walletFunding } = fixture();
    giftStore.reservations.push({ id: 'r-active', userId: customerId, sourceType: 'GIFT', orderId: null,
      giftRequestId: 'g-existing', mode: 'LOCAL_RESERVATION', provider: 'mock-provider', providerHoldRef: null,
      amountMinor: 700, currency: 'USD', status: 'ACTIVE', version: 1, idempotencyKey: 'existing-reservation',
      expiresAt: now.toISOString(), activatedAt: now.toISOString(), settledAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString() });
    walletFunding.addReservation('r-active', 700);
    const response = await affordability(server);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ giftCatalogVersionId: catalog().id, catalogVersion: 4, priceMinor: 8_800,
      ledgerBalanceMinor: 5_000, reservedMinor: 10_200, availableMinor: -5_200, shortfallMinor: 14_000,
      currency: 'USD', calculatedAt: now.toISOString(), stale: false, canAfford: false, topUpInstructions });
    expectZeroWrites(giftStore, 1);
  });

  test('returns a stable support top-up instruction without Guild payment configuration', async () => {
    const state = fixture({ balance: 20_000 });
    const response = await affordability(state.server);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ stale: false, canAfford: true, topUpInstructions });
    expectZeroWrites(state.giftStore);
  });

  test('refreshes the same selection and only creates facts after current-snapshot confirmation', async () => {
    const state = fixture();
    expect((await affordability(state.server)).json().data.canAfford).toBe(false);
    state.setBalance(20_000);
    const refreshed = await affordability(state.server);
    expect(refreshed.json().data).toMatchObject({ canAfford: true, shortfallMinor: 0, catalogVersion: 4, priceMinor: 8_800 });
    expectZeroWrites(state.giftStore);

    const confirmed = await state.server.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/gift-requests`,
      headers: headers('gift:m6-us-06:confirm'), payload: { expectedOrderVersion: 7, giftCatalogVersionId: catalog().id,
        expectedCatalogVersion: 4, expectedPriceMinor: 8_800 } });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().data).toMatchObject({ receiverId: playerId, gift: { priceMinor: 8_800 } });
    expect(state.giftStore.requests).toHaveLength(1);
    expect(state.giftStore.reservations).toHaveLength(1);
    expect(state.giftStore.staffTasks).toHaveLength(1);
  });

  test('requires reconfirmation after price/status/version change and never submits at the old price', async () => {
    const state = fixture({ balance: 20_000 });
    const checked = (await affordability(state.server)).json().data;
    state.giftStore.catalog[0] = { ...state.giftStore.catalog[0]!, version: 5, priceMinor: 9_900 };
    const response = await state.server.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/gift-requests`,
      headers: headers('gift:m6-us-06:changed'), payload: { expectedOrderVersion: 7,
        giftCatalogVersionId: checked.giftCatalogVersionId, expectedCatalogVersion: checked.catalogVersion, expectedPriceMinor: checked.priceMinor } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'GIFT_CATALOG_CHANGED' } });
    expectZeroWrites(state.giftStore);
  });

  test('falls back safely when another active reservation wins the race', async () => {
    const state = fixture({ balance: 10_000 });
    const checked = (await affordability(state.server)).json().data;
    state.giftStore.reservations.push({ id: 'r-racing', userId: customerId, sourceType: 'GIFT', orderId: null,
      giftRequestId: 'g-racing', mode: 'LOCAL_RESERVATION', provider: 'mock-provider', providerHoldRef: null,
      amountMinor: 2_000, currency: 'USD', status: 'ACTIVE', version: 1, idempotencyKey: 'race-reservation',
      expiresAt: now.toISOString(), activatedAt: now.toISOString(), settledAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString() });
    state.walletFunding.addReservation('r-racing', 2_000);
    const response = await state.server.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/gift-requests`,
      headers: headers('gift:m6-us-06:race'), payload: { expectedOrderVersion: 7,
        giftCatalogVersionId: checked.giftCatalogVersionId, expectedCatalogVersion: checked.catalogVersion, expectedPriceMinor: checked.priceMinor } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_AVAILABLE_BALANCE' } });
    expect(state.giftStore.requests).toHaveLength(0);
    expect(state.giftStore.staffTasks).toHaveLength(0);
    expect(state.giftStore.expiryJobs).toHaveLength(0);
  });

  test('rejects receiver input because the receiver is derived only from order.playerId', async () => {
    const state = fixture({ balance: 20_000 });
    const response = await state.server.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/gift-requests`,
      headers: headers('gift:m6-us-06:no-receiver'), payload: { expectedOrderVersion: 7,
        giftCatalogVersionId: catalog().id, expectedCatalogVersion: 4, expectedPriceMinor: 8_800,
        receiverId: '00000000-0000-0000-0000-000000006699' } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expectZeroWrites(state.giftStore);
  });

  test('does not reveal or create gifts for the same customer order in another Guild', async () => {
    const state = fixture({ balance: 20_000, orderGuildId: '900000000000006699' });
    const checked = await affordability(state.server);
    const created = await state.server.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/gift-requests`,
      headers: headers('gift:m6-us-06:cross-guild'), payload: { expectedOrderVersion: 7,
        giftCatalogVersionId: catalog().id, expectedCatalogVersion: 4, expectedPriceMinor: 8_800 } });

    expect(checked.statusCode).toBe(404);
    expect(created.statusCode).toBe(404);
    expect(checked.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(created.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expectZeroWrites(state.giftStore);
  });
});
