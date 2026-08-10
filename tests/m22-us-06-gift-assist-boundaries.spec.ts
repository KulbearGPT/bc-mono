import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';
import { InMemoryGiftStore, registerGiftRoutes, type GiftCatalogRecord,
  type StandaloneGiftRecipientRecord } from '@blackcat/api/gifts';
import { InMemoryOrderStore } from '@blackcat/api/orders';
import { InMemoryAuditSink, InMemoryIdempotencyStore, type StaffAccount } from '@blackcat/api/security';
import { TestWalletFunding } from './support/wallet-fixture';

const initialNow = new Date('2026-08-13T20:00:00.000Z');
const guildId = '900000000000026000';
const staffDiscordId = '900000000000026001';
const customerDiscordId = '900000000000026002';
const staffId = '00000000-0000-0000-0000-000000026001';
const customerId = '00000000-0000-0000-0000-000000026002';
const playerUserId = '00000000-0000-0000-0000-000000026003';
const playerProfileId = '00000000-0000-0000-0000-000000026004';

const gift: GiftCatalogRecord = {
  id: '00000000-0000-0000-0000-000000026005', itemId: '00000000-0000-0000-0000-000000026006',
  code: 'MOON', version: 3, status: 'ACTIVE', name: '月亮礼盒', priceMinor: 5_200,
  currency: 'CAT', broadcastTemplate: '{sender_name} 向 {receiver_name} 送出 {gift_name}'
};

const recipient: StandaloneGiftRecipientRecord = {
  playerProfileId, userId: playerUserId, displayName: '阿月', guildId,
  discordUserId: '900000000000026003', reviewStatus: 'ACTIVE', userStatus: 'ACTIVE'
};

function fixture(input: { authorized?: boolean; customerBound?: boolean } = {}) {
  let clock = new Date(initialNow);
  const actor: StaffAccount = {
    staffId, userId: '00000000-0000-0000-0000-000000026007', level: 'L1_SUPPORT',
    permissionsVersion: 9, status: 'ACTIVE'
  };
  const store = new InMemoryGiftStore({ catalog: [gift], standaloneRecipients: [recipient],
    staffTotpCodes: { [staffId]: '123456' } });
  const binding: AccountBindingRecord = {
    userId: customerId, displayName: '老板测试账号', userStatus: 'ACTIVE', userVersion: 1,
    discordAccountId: '00000000-0000-0000-0000-000000026008', guildId,
    discordUserId: customerDiscordId, boundAt: initialNow.toISOString()
  };
  const audit = new InMemoryAuditSink();
  const server = buildApiServer({
    env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    security: { auditSink: audit, idempotencyStore: new InMemoryIdempotencyStore(),
      staffDirectory: { resolveByDiscord: () => input.authorized === false ? null : actor } }
  });
  registerGiftRoutes(server, { store, orderStore: new InMemoryOrderStore(),
    accountStore: new InMemoryAccountStore({ bindings: input.customerBound === false ? [] : [binding], reservationSource: () => store.reservations }),
    walletFunding: new TestWalletFunding(20_000), broadcastChannelId: '900000000000026099', now: () => clock });
  return { server, store, audit, setNow(value: Date) { clock = value; } };
}

function headers(idempotencyKey?: string) {
  return { authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': staffDiscordId, 'x-actor-guild-id': guildId,
    'x-discord-interaction-id': '900000000000026098',
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) };
}

async function createChallenge(server: ReturnType<typeof buildApiServer>) {
  const response = await server.inject({ method: 'POST', url: '/api/v1/admin/gift-assist/challenges',
    headers: headers('gift:assist:boundary:challenge'), payload: {
      customerDiscordUserId: customerDiscordId,
      authorizationChannelId: '900000000000026010', authorizationMessageId: '900000000000026011'
    } });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().data.id as string;
}

function requestBody(totpCode: string) {
  return { playerProfileId, giftCatalogVersionId: gift.id, expectedCatalogVersion: gift.version,
    expectedPriceMinor: gift.priceMinor, anonymous: false, authorizationReason: '老板明确要求客服辅助送礼', totpCode };
}

function expectNoGiftWrites(store: InMemoryGiftStore) {
  expect({ requests: store.requests.length, reservations: store.reservations.length,
    tasks: store.staffTasks.length, consumptions: store.consumptions.length,
    outbox: store.broadcasts.length + store.expiryJobs.length }).toEqual({
    requests: 0, reservations: 0, tasks: 0, consumptions: 0, outbox: 0
  });
}

describe('M22-US-06 staff-assisted gift boundaries', () => {
  test('GTA-A-003 denies unresolved staff before challenge or fund writes', async () => {
    const { server, store } = fixture({ authorized: false });
    const response = await server.inject({ method: 'POST', url: '/api/v1/admin/gift-assist/challenges',
      headers: headers('gift:assist:boundary:denied'), payload: {
        customerDiscordUserId: customerDiscordId,
        authorizationChannelId: '900000000000026010', authorizationMessageId: '900000000000026011'
      } });
    expect(response.statusCode).toBe(403);
    expect(store.staffGiftAssistChallenges).toHaveLength(0);
    expectNoGiftWrites(store);
  });

  test('GTA-A-004 rejects an unbound customer before challenge or reservation creation', async () => {
    const { server, store } = fixture({ customerBound: false });
    const response = await server.inject({ method: 'POST', url: '/api/v1/admin/gift-assist/challenges',
      headers: headers('gift:assist:boundary:unbound-customer'), payload: {
        customerDiscordUserId: customerDiscordId,
        authorizationChannelId: '900000000000026010', authorizationMessageId: '900000000000026011'
      } });
    expect(response.statusCode).toBe(404);
    expect(store.staffGiftAssistChallenges).toHaveLength(0);
    expectNoGiftWrites(store);
  });

  test('GTA-A-006 locks the challenge after five failed TOTP attempts', async () => {
    const { server, store } = fixture();
    const challengeId = await createChallenge(server);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const denied = await server.inject({ method: 'POST',
        url: `/api/v1/admin/gift-assist/challenges/${challengeId}/gift-requests`,
        headers: headers(`gift:assist:boundary:wrong:${attempt}`), payload: requestBody('000000') });
      expect(denied.statusCode, denied.body).toBe(403);
      expectNoGiftWrites(store);
    }
    expect(store.staffGiftAssistChallenges[0]?.failedAttempts).toBe(5);
    const locked = await server.inject({ method: 'POST',
      url: `/api/v1/admin/gift-assist/challenges/${challengeId}/gift-requests`,
      headers: headers('gift:assist:boundary:locked'), payload: requestBody('123456') });
    expect(locked.statusCode).toBe(409);
    expectNoGiftWrites(store);
  });

  test('GTA-A-007 rejects an expired challenge without business writes', async () => {
    const { server, store, setNow } = fixture();
    const challengeId = await createChallenge(server);
    setNow(new Date(initialNow.getTime() + 10 * 60_000 + 1));
    const expired = await server.inject({ method: 'POST',
      url: `/api/v1/admin/gift-assist/challenges/${challengeId}/gift-requests`,
      headers: headers('gift:assist:boundary:expired'), payload: requestBody('123456') });
    expect(expired.statusCode).toBe(409);
    expectNoGiftWrites(store);
  });

  test('GTA-A-011 never stores or returns the successful TOTP value', async () => {
    const { server, store, audit } = fixture();
    const challengeId = await createChallenge(server);
    const response = await server.inject({ method: 'POST',
      url: `/api/v1/admin/gift-assist/challenges/${challengeId}/gift-requests`,
      headers: headers('gift:assist:boundary:secret'), payload: requestBody('123456') });
    expect(response.statusCode, response.body).toBe(201);
    expect(JSON.stringify({ response: response.json(), audit: audit.records,
      requests: store.requests, reservations: store.reservations, tasks: store.staffTasks,
      challenges: store.staffGiftAssistChallenges, outbox: [...store.broadcasts, ...store.expiryJobs] }))
      .not.toContain('123456');
  });

  test('GTA-A-010 consumes one challenge at most once under concurrent confirmations', async () => {
    const { server, store } = fixture();
    const challengeId = await createChallenge(server);
    const responses = await Promise.all(['a', 'b'].map((suffix) => server.inject({ method: 'POST',
      url: `/api/v1/admin/gift-assist/challenges/${challengeId}/gift-requests`,
      headers: headers(`gift:assist:boundary:concurrent:${suffix}`), payload: requestBody('123456') })));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(store.staffGiftAssistChallenges[0]?.consumedAt).not.toBeNull();
    expect(store.requests).toHaveLength(1);
    expect(store.reservations).toHaveLength(1);
    expect(store.staffTasks).toHaveLength(1);
  });
});
