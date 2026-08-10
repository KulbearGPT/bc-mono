import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore, type StaffAccount } from '@blackcat/api/security';
import { InMemoryAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';
import { InMemoryOrderStore } from '@blackcat/api/orders';
import {
  InMemoryGiftStore,
  registerGiftRoutes,
  type GiftCatalogRecord,
  type StandaloneGiftRecipientRecord
} from '@blackcat/api/gifts';
import { TestWalletFunding } from './support/wallet-fixture';

const now = new Date('2026-08-13T20:00:00.000Z');
const guildId = '900000000000024000';
const staffDiscordId = '900000000000024001';
const customerDiscordId = '900000000000024002';
const staffId = '00000000-0000-0000-0000-000000024001';
const staffUserId = '00000000-0000-0000-0000-000000024002';
const customerId = '00000000-0000-0000-0000-000000024003';
const playerUserId = '00000000-0000-0000-0000-000000024004';
const playerProfileId = '00000000-0000-0000-0000-000000024005';
const channelId = '900000000000024003';
const messageId = '900000000000024004';

const gift: GiftCatalogRecord = {
  id: '00000000-0000-0000-0000-000000024006', itemId: '00000000-0000-0000-0000-000000024007',
  code: 'STAR', version: 2, status: 'ACTIVE', name: '星星礼盒', priceMinor: 6_600,
  currency: 'CAT', broadcastTemplate: '{sender_name} 向 {receiver_name} 送出 {gift_name}'
};

const recipient: StandaloneGiftRecipientRecord = {
  playerProfileId, userId: playerUserId, displayName: '阿岚', guildId,
  discordUserId: '900000000000024005', reviewStatus: 'ACTIVE', userStatus: 'ACTIVE'
};

function customerBinding(overrides: Partial<AccountBindingRecord> = {}): AccountBindingRecord {
  return {
    userId: customerId, displayName: '老板小林', userStatus: 'ACTIVE', userVersion: 1,
    discordAccountId: '00000000-0000-0000-0000-000000024008', guildId,
    discordUserId: customerDiscordId, boundAt: now.toISOString(), ...overrides
  };
}

function fixture(input: { balance?: number; staffLevel?: StaffAccount['level']; totpCode?: string } = {}) {
  const audit = new InMemoryAuditSink();
  const actor: StaffAccount = {
    staffId, userId: staffUserId, level: input.staffLevel ?? 'L1_SUPPORT', permissionsVersion: 7, status: 'ACTIVE'
  };
  const store = new InMemoryGiftStore({
    catalog: [gift], standaloneRecipients: [recipient], staffTotpCodes: { [staffId]: input.totpCode ?? '123456' }
  });
  const accountStore = new InMemoryAccountStore({
    bindings: [customerBinding()], reservationSource: () => store.reservations
  });
  const server = buildApiServer({
    env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    security: {
      auditSink: audit, idempotencyStore: new InMemoryIdempotencyStore(),
      staffDirectory: { resolveByDiscord: () => actor }
    }
  });
  registerGiftRoutes(server, {
    store, orderStore: new InMemoryOrderStore(), accountStore,
    walletFunding: new TestWalletFunding(input.balance ?? 20_000),
    broadcastChannelId: '900000000000024099', now: () => now
  });
  return { server, store, audit, actor };
}

function headers(idempotencyKey?: string) {
  return {
    authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': staffDiscordId, 'x-actor-guild-id': guildId,
    'x-discord-interaction-id': '900000000000024098',
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
  };
}

async function createChallenge(server: ReturnType<typeof buildApiServer>) {
  const response = await server.inject({
    method: 'POST', url: '/api/v1/admin/gift-assist/challenges', headers: headers('gift:assist:challenge:1'),
    payload: { customerDiscordUserId: customerDiscordId, authorizationChannelId: channelId, authorizationMessageId: messageId }
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().data as { id: string };
}

describe('M22-US-04 mode-B staff-assisted gift API', () => {
  test('creates an owner-bound challenge and reads the customer balance privately', async () => {
    const { server, store } = fixture();
    const challenge = await createChallenge(server);
    expect(store.staffGiftAssistChallenges[0]).toMatchObject({
      id: challenge.id, guildId, staffAccountId: staffId, staffDiscordUserId: staffDiscordId,
      permissionsVersion: 7, customerUserId: customerId, customerDiscordUserId: customerDiscordId,
      authorizationChannelId: channelId, authorizationMessageId: messageId, failedAttempts: 0, consumedAt: null
    });
    expect((await server.inject({ method: 'GET', url: `/api/v1/admin/gift-assist/challenges/${challenge.id}`, headers: headers() })).json().data)
      .toMatchObject({ customer: { displayName: '老板小林' }, recipients: [{ playerProfileId }], balance: { availableMinor: 20_000 } });
  });

  test('keeps affordability read-only and rejects arbitrary payer or receiver fields', async () => {
    const { server, store } = fixture({ balance: 5_000 });
    const challenge = await createChallenge(server);
    const affordability = await server.inject({
      method: 'POST', url: `/api/v1/admin/gift-assist/challenges/${challenge.id}/affordability`, headers: headers(),
      payload: { playerProfileId, giftCatalogVersionId: gift.id }
    });
    expect(affordability.statusCode, affordability.body).toBe(200);
    expect(affordability.json().data).toMatchObject({ canAfford: false, shortfallMinor: 1_600 });
    expect(store.requests).toHaveLength(0);

    const forged = await server.inject({
      method: 'POST', url: `/api/v1/admin/gift-assist/challenges/${challenge.id}/gift-requests`, headers: headers('gift:assist:forged:1'),
      payload: { playerProfileId, giftCatalogVersionId: gift.id, expectedCatalogVersion: 2, expectedPriceMinor: 6_600,
        anonymous: false, authorizationReason: '老板在消息中请求送礼', totpCode: '123456', senderId: customerId, receiverId: playerUserId }
    });
    expect(forged.statusCode).toBe(400);
    expect(store.requests).toHaveLength(0);

    const forgedEvidence = await server.inject({
      method: 'POST', url: '/api/v1/admin/gift-assist/challenges', headers: headers('gift:assist:forged-evidence:1'),
      payload: { customerDiscordUserId: customerDiscordId, authorizationChannelId: 'not-a-channel', authorizationMessageId: messageId }
    });
    expect(forgedEvidence.statusCode).toBe(400);
    expect(store.staffGiftAssistChallenges).toHaveLength(1);
  });

  test('persists failed TOTP attempts without fund writes, then creates an attributed anonymous reservation', async () => {
    const { server, store, audit } = fixture();
    const challenge = await createChallenge(server);
    const body = { playerProfileId, giftCatalogVersionId: gift.id, expectedCatalogVersion: 2, expectedPriceMinor: 6_600,
      anonymous: true, authorizationReason: '老板在授权消息中要求匿名送出星星礼盒', totpCode: '000000' };
    const denied = await server.inject({
      method: 'POST', url: `/api/v1/admin/gift-assist/challenges/${challenge.id}/gift-requests`, headers: headers('gift:assist:wrong-proof:1'), payload: body
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(store.staffGiftAssistChallenges[0]?.failedAttempts).toBe(1);
    expect(store.requests).toHaveLength(0);

    const created = await server.inject({
      method: 'POST', url: `/api/v1/admin/gift-assist/challenges/${challenge.id}/gift-requests`, headers: headers('gift:assist:correct-proof:1'),
      payload: { ...body, totpCode: '123456' }
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().data).toMatchObject({ initiatorMode: 'STAFF_ASSISTED', senderVisibility: 'ANONYMOUS', giftAssistChallengeId: challenge.id });
    expect(store.requests[0]).toMatchObject({ senderId: customerId, receiverId: playerUserId, initiatorMode: 'STAFF_ASSISTED', assistedByStaffId: staffId, giftAssistChallengeId: challenge.id });
    expect(store.reservations[0]).toMatchObject({ userId: customerId, status: 'ACTIVE', amountMinor: 6_600 });
    expect(store.staffTasks[0]).toMatchObject({ contextSnapshot: { source: 'STANDALONE', initiatorMode: 'STAFF_ASSISTED', assistedByStaffId: staffId } });
    expect(store.staffGiftAssistChallenges[0]).toMatchObject({ authorizationReason: body.authorizationReason, consumedAt: now.toISOString() });
    expect(JSON.stringify({ audit: audit.records, requests: store.requests, tasks: store.staffTasks,
      challenges: store.staffGiftAssistChallenges })).not.toContain('123456');
  });

  test('rejects consumed challenge replay without a second reservation', async () => {
    const { server, store } = fixture();
    const challenge = await createChallenge(server);
    const body = { playerProfileId, giftCatalogVersionId: gift.id, expectedCatalogVersion: 2, expectedPriceMinor: 6_600,
      anonymous: false, authorizationReason: '老板明确要求客服辅助送礼', totpCode: '123456' };
    expect((await server.inject({ method: 'POST', url: `/api/v1/admin/gift-assist/challenges/${challenge.id}/gift-requests`, headers: headers('gift:assist:first:1'), payload: body })).statusCode).toBe(201);
    expect((await server.inject({ method: 'POST', url: `/api/v1/admin/gift-assist/challenges/${challenge.id}/gift-requests`, headers: headers('gift:assist:replay:2'), payload: body })).statusCode).toBe(409);
    expect(store.requests).toHaveLength(1);
    expect(store.reservations).toHaveLength(1);
  });

  test('fails closed when the staff permission version changes after challenge creation', async () => {
    const { server, store, actor } = fixture();
    const challenge = await createChallenge(server);
    actor.permissionsVersion = 8;
    const response = await server.inject({ method: 'GET', url: `/api/v1/admin/gift-assist/challenges/${challenge.id}`, headers: headers() });
    expect(response.statusCode).toBe(409);
    expect(store.requests).toHaveLength(0);
  });
});
