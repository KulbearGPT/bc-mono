import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import { InMemoryAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';
import { InMemoryOrderStore } from '@blackcat/api/orders';
import {
  InMemoryGiftStore,
  captureApprovedGift,
  registerGiftRoutes,
  type GiftCatalogRecord,
  type GiftRequestRecord,
  type GiftReservationRecord,
  type GiftStaffTaskRecord,
  type StandaloneGiftRecipientRecord
} from '@blackcat/api/gifts';
import { TestWalletFunding } from './support/wallet-fixture';

const now = new Date('2026-08-13T18:00:00.000Z');
const guildId = '900000000000022000';
const customerId = '00000000-0000-0000-0000-000000022001';
const playerUserId = '00000000-0000-0000-0000-000000022002';
const playerProfileId = '00000000-0000-0000-0000-000000022003';

function catalog(): GiftCatalogRecord {
  return {
    id: '00000000-0000-0000-0000-000000022004', itemId: '00000000-0000-0000-0000-000000022005',
    code: 'MOON_CAKE', version: 3, status: 'ACTIVE', name: '月亮蛋糕', priceMinor: 5_200,
    currency: 'CAT', broadcastTemplate: '{sender_name} 向 {receiver_name} 送出 {gift_name}'
  };
}

function recipient(overrides: Partial<StandaloneGiftRecipientRecord> = {}): StandaloneGiftRecipientRecord {
  return {
    playerProfileId, userId: playerUserId, displayName: '阿青', guildId,
    discordUserId: '900000000000022002', reviewStatus: 'ACTIVE', userStatus: 'ACTIVE', ...overrides
  };
}

function fixture(input: { balance?: number; recipients?: StandaloneGiftRecipientRecord[] } = {}) {
  const store = new InMemoryGiftStore({
    catalog: [catalog()],
    standaloneRecipients: input.recipients ?? [
      recipient(),
      recipient({ playerProfileId: '00000000-0000-0000-0000-000000022013', userId: '00000000-0000-0000-0000-000000022012', guildId: '900000000000022099' }),
      recipient({ playerProfileId: '00000000-0000-0000-0000-000000022023', userId: '00000000-0000-0000-0000-000000022022', reviewStatus: 'PAUSED' })
    ],
    displayNames: { [customerId]: '小林', [playerUserId]: '阿青' }
  });
  const binding: AccountBindingRecord = {
    userId: customerId, displayName: '小林', userStatus: 'ACTIVE', userVersion: 1,
    discordAccountId: '00000000-0000-0000-0000-000000022006', guildId,
    discordUserId: '900000000000022001', externalAccountId: '00000000-0000-0000-0000-000000022007',
    provider: 'internal', externalUserId: 'customer-22001', externalUserDisplay: 'customer-***',
    externalAccountStatus: 'ACTIVE', boundAt: now.toISOString()
  };
  const accountStore = new InMemoryAccountStore({ bindings: [binding], reservationSource: () => store.reservations });
  const walletFunding = new TestWalletFunding(input.balance ?? 20_000);
  const server = buildApiServer({
    env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    security: { auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() }
  });
  registerGiftRoutes(server, {
    store, orderStore: new InMemoryOrderStore(), accountStore, walletFunding,
    broadcastChannelId: '900000000000022030', now: () => now
  });
  return { server, store, walletFunding };
}

function headers(idempotencyKey?: string) {
  return {
    authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': '900000000000022001', 'x-actor-guild-id': guildId,
    'x-discord-interaction-id': '900000000000022009', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
  };
}

describe('M22-US-02 standalone and anonymous gift API', () => {
  test('lists only same-Guild ACTIVE recipients with catalog and current balance', async () => {
    const { server } = fixture();
    const response = await server.inject({ method: 'GET', url: '/api/v1/gift-center', headers: headers() });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      recipients: [{ playerProfileId, displayName: '阿青' }],
      items: [{ id: catalog().id, priceMinor: 5_200, affordable: true }],
      balance: { ledgerBalanceMinor: 20_000, availableMinor: 20_000, currency: 'CAT' }
    });
  });

  test('checks affordability without writes and rejects receiverId input', async () => {
    const { server, store } = fixture({ balance: 4_000 });
    const checked = await server.inject({
      method: 'POST', url: '/api/v1/gift-center/affordability', headers: headers(),
      payload: { playerProfileId, giftCatalogVersionId: catalog().id }
    });
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json().data).toMatchObject({ playerProfileId, canAfford: false, shortfallMinor: 1_200 });
    expect({ requests: store.requests.length, reservations: store.reservations.length, tasks: store.staffTasks.length }).toEqual({ requests: 0, reservations: 0, tasks: 0 });

    const forged = await server.inject({
      method: 'POST', url: '/api/v1/gift-center/affordability', headers: headers(),
      payload: { playerProfileId, giftCatalogVersionId: catalog().id, receiverId: playerUserId }
    });
    expect(forged.statusCode).toBe(400);
  });

  test('GTA-S-005 refreshes after funding and creates only on final confirmation', async () => {
    const { server, store, walletFunding } = fixture({ balance: 4_000 });
    const check = () => server.inject({ method: 'POST', url: '/api/v1/gift-center/affordability', headers: headers(),
      payload: { playerProfileId, giftCatalogVersionId: catalog().id } });
    expect((await check()).json().data).toMatchObject({ canAfford: false, shortfallMinor: 1_200 });
    expect(store.requests).toHaveLength(0);
    walletFunding.ledgerBalanceMinor = 10_000;
    expect((await check()).json().data).toMatchObject({ canAfford: true, shortfallMinor: 0, availableMinor: 10_000 });
    expect(store.requests).toHaveLength(0);
    const created = await server.inject({ method: 'POST', url: '/api/v1/gift-center/gift-requests',
      headers: headers('gift:m22:funded-confirmation'), payload: { playerProfileId,
        giftCatalogVersionId: catalog().id, expectedCatalogVersion: 3, expectedPriceMinor: 5_200, anonymous: false } });
    expect(created.statusCode, created.body).toBe(201);
    expect(store.requests).toHaveLength(1);
  });

  test('creates one order-independent anonymous request and derives its receiver', async () => {
    const { server, store } = fixture();
    const response = await server.inject({
      method: 'POST', url: '/api/v1/gift-center/gift-requests', headers: headers('gift:m22:anonymous'),
      payload: { playerProfileId, giftCatalogVersionId: catalog().id, expectedCatalogVersion: 3, expectedPriceMinor: 5_200, anonymous: true }
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data).toMatchObject({
      origin: 'STANDALONE', senderVisibility: 'ANONYMOUS', orderId: null,
      playerProfileId, receiverId: playerUserId, gift: { priceMinor: 5_200 }
    });
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0]).toMatchObject({ guildId, origin: 'STANDALONE', senderVisibility: 'ANONYMOUS', orderId: null, participantId: null, senderId: customerId, receiverId: playerUserId });
    expect(store.staffTasks[0]).toMatchObject({ orderId: null, contextSnapshot: { source: 'STANDALONE', orderId: null, senderId: customerId, receiverId: playerUserId } });
    expect(store.reservations).toHaveLength(1);
  });

  test('revalidates the profile and keeps unaffordable or invalid requests at zero writes', async () => {
    const poor = fixture({ balance: 4_000 });
    const unaffordable = await poor.server.inject({
      method: 'POST', url: '/api/v1/gift-center/gift-requests', headers: headers('gift:m22:poor-balance'),
      payload: { playerProfileId, giftCatalogVersionId: catalog().id, expectedCatalogVersion: 3, expectedPriceMinor: 5_200, anonymous: false }
    });
    expect(unaffordable.statusCode, unaffordable.body).toBe(422);
    expect(poor.store.requests).toHaveLength(0);

    const invalid = fixture({ recipients: [recipient({ reviewStatus: 'PAUSED' })] });
    const stale = await invalid.server.inject({
      method: 'POST', url: '/api/v1/gift-center/gift-requests', headers: headers('gift:m22:stale-player'),
      payload: { playerProfileId, giftCatalogVersionId: catalog().id, expectedCatalogVersion: 3, expectedPriceMinor: 5_200, anonymous: false }
    });
    expect(stale.statusCode).toBe(404);
    expect(invalid.store.requests).toHaveLength(0);
  });

  test('renders anonymous sender only in the public announcement payload', async () => {
    const request = {
      id: '00000000-0000-0000-0000-000000022040', publicId: 'G-22040', guildId,
      origin: 'STANDALONE', senderVisibility: 'ANONYMOUS', orderId: null, participantId: null,
      giftCatalogVersionId: catalog().id, senderId: customerId, receiverId: playerUserId,
      status: 'APPROVED', version: 2, giftCodeSnapshot: catalog().code, giftNameSnapshot: catalog().name,
      priceMinor: 5_200, currency: 'CAT', broadcastTemplateSnapshot: catalog().broadcastTemplate,
      approvedByStaffId: '00000000-0000-0000-0000-000000022041', expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      createdAt: now.toISOString(), updatedAt: now.toISOString()
    } satisfies GiftRequestRecord;
    const reservation = {
      id: '00000000-0000-0000-0000-000000022042', userId: customerId, sourceType: 'GIFT', orderId: null,
      giftRequestId: request.id, mode: 'LOCAL_RESERVATION', provider: null, providerHoldRef: null,
      amountMinor: 5_200, currency: 'CAT', status: 'ACTIVE', version: 2, idempotencyKey: 'gift:m22:capture',
      expiresAt: request.expiresAt, activatedAt: now.toISOString(), settledAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString()
    } satisfies GiftReservationRecord;
    const task = {
      id: '00000000-0000-0000-0000-000000022043', publicId: 'T-GIFT-22043', type: 'GIFT_REVIEW', reasonCode: 'GIFT_REQUESTED',
      status: 'APPROVED', version: 2, orderId: null, giftRequestId: request.id, voiceChannelId: null,
      contextSnapshot: { source: 'STANDALONE', orderId: null, orderPublicId: null, channelId: null, voiceChannelId: null,
        senderId: customerId, receiverId: playerUserId, giftCode: catalog().code, giftName: catalog().name,
        priceMinor: 5_200, currency: 'CAT', reservationId: reservation.id },
      createdAt: now.toISOString(), updatedAt: now.toISOString()
    } satisfies GiftStaffTaskRecord;
    const store = new InMemoryGiftStore({ requests: [request], reservations: [reservation], staffTasks: [task], displayNames: { [customerId]: '真实老板名', [playerUserId]: '阿青' } });

    await captureApprovedGift({ store, giftRequestId: request.id, broadcastChannelId: '900000000000022030', now });

    expect(store.broadcasts[0]?.payload).toMatchObject({ content: '匿名老板 向 阿青 送出 月亮蛋糕' });
    expect(JSON.stringify(store.staffTasks[0])).toContain(customerId);
  });
});
