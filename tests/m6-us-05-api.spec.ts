import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';
import { InMemoryCustomerProfileStore, type CustomerProfileOrder } from '@blackcat/api/customer-profiles';
import { AdapterError } from '@blackcat/api/payment-adapter';

const guildId = '900000000000006500';
const otherGuildId = '900000000000006599';
const discordA = '900000000000006501';
const discordB = '900000000000006502';
const userA = '00000000-0000-0000-0000-000000006501';
const userB = '00000000-0000-0000-0000-000000006502';
const now = new Date('2026-07-19T20:00:00.000Z');

function binding(userId: string, discordUserId: string, externalUserId: string, guild = guildId): AccountBindingRecord {
  return { userId, displayName: userId === userA ? '客户甲' : '客户乙', userStatus: 'ACTIVE', userVersion: 1,
    discordAccountId: crypto.randomUUID(), guildId: guild, discordUserId, externalAccountId: crypto.randomUUID(), provider: 'mock',
    externalUserId, externalUserDisplay: 'mock-***', externalAccountStatus: 'ACTIVE', boundAt: now.toISOString() };
}

function order(id: string, customerId: string, createdAt: string, guild = guildId): CustomerProfileOrder {
  return { id, publicId: `P-${id.slice(-4)}`, customerId, guildId: guild, status: 'COMPLETED', gameKey: 'VALORANT',
    serviceKey: 'RANKED', playerUserId: null, playerDisplayName: null, amountMinor: 10_000, currency: 'CNY', createdAt, completedAt: createdAt };
}

async function fixture(input: { providerFails?: boolean; providerStale?: boolean; noSnapshot?: boolean } = {}) {
  const accountStore = new InMemoryAccountStore({ bindings: [binding(userA, discordA, 'provider-a'), binding(userA, discordA, 'provider-a', otherGuildId), binding(userB, discordB, 'provider-b')], consumptions: [
    { id: '00000000-0000-0000-0000-000000006521', userId: userA, type: 'ORDER', sourceId: 'a1', amountMinor: 10_000,
      guildId, currency: 'CNY', status: 'SUCCEEDED', targetDisplay: '订单 P-6511', occurredAt: '2026-07-19T18:01:00.000Z', reversalOf: null },
    { id: '00000000-0000-0000-0000-000000006522', userId: userA, type: 'GIFT', sourceId: 'a2', amountMinor: 2_000,
      guildId, currency: 'CNY', status: 'SUCCEEDED', targetDisplay: '礼物', occurredAt: '2026-07-18T18:01:00.000Z', reversalOf: null },
    { id: '00000000-0000-0000-0000-000000006524', userId: userA, type: 'ORDER', sourceId: 'other-guild', amountMinor: 77_000,
      guildId: otherGuildId, currency: 'CNY', status: 'SUCCEEDED', targetDisplay: '跨 Guild 订单', occurredAt: '2026-07-19T19:30:00.000Z', reversalOf: null },
    { id: '00000000-0000-0000-0000-000000006523', userId: userB, type: 'ORDER', sourceId: 'b1', amountMinor: 99_000,
      guildId, currency: 'CNY', status: 'SUCCEEDED', targetDisplay: '订单 P-6513', occurredAt: '2026-07-19T19:01:00.000Z', reversalOf: null }
  ] });
  const profileStore = new InMemoryCustomerProfileStore({
    users: [
      { id: userA, guildId, discordUserId: discordA, displayName: '客户甲', status: 'ACTIVE', provider: 'mock', externalUserId: 'provider-a' },
      { id: userB, guildId, discordUserId: discordB, displayName: '客户乙', status: 'ACTIVE', provider: 'mock', externalUserId: 'provider-b' }
    ],
    orders: [
      order('00000000-0000-0000-0000-000000006511', userA, '2026-07-19T18:00:00.000Z'),
      order('00000000-0000-0000-0000-000000006512', userA, '2026-07-18T18:00:00.000Z'),
      order('00000000-0000-0000-0000-000000006513', userB, '2026-07-19T19:00:00.000Z'),
      order('00000000-0000-0000-0000-000000006514', userA, '2026-07-19T19:30:00.000Z', otherGuildId)
    ],
    consumptions: [
      { id: '00000000-0000-0000-0000-000000006521', userId: userA, type: 'ORDER', sourceId: 'a1', orderId: '00000000-0000-0000-0000-000000006511', amountMinor: 10_000, currency: 'CNY', occurredAt: '2026-07-19T18:01:00.000Z' },
      { id: '00000000-0000-0000-0000-000000006522', userId: userA, type: 'GIFT', sourceId: 'a2', orderId: '00000000-0000-0000-0000-000000006512', amountMinor: 2_000, currency: 'CNY', occurredAt: '2026-07-18T18:01:00.000Z' },
      { id: '00000000-0000-0000-0000-000000006523', userId: userB, type: 'ORDER', sourceId: 'b1', orderId: '00000000-0000-0000-0000-000000006513', amountMinor: 99_000, currency: 'CNY', occurredAt: '2026-07-19T19:01:00.000Z' }
    ],
    reservations: [
      { userId: userA, currency: 'CNY', remainingMinor: 3_000, guildId },
      { userId: userA, currency: 'CNY', remainingMinor: 2_000, guildId: otherGuildId }
    ],
    notes: [{ id: crypto.randomUUID(), userId: userA, text: 'internal', authorStaffId: crypto.randomUUID(), createdAt: now.toISOString() }],
    riskFlags: [{ userId: userA, value: 'RISK' }],
    balanceSnapshots: input.noSnapshot ? [] : [{ id: crypto.randomUUID(), userId: userA, provider: 'mock', providerBalanceMinor: 8_000,
      currency: 'CNY', fetchedAt: '2026-07-18T10:00:00.000Z' }]
  });
  const fundingAdapter = { resolveUser: async () => { throw new Error('unused'); }, getProviderBalance: async () => {
    if (input.providerFails) throw new AdapterError('PROVIDER_TIMEOUT', 'timeout', { requestId: 'req_profile_timeout', retryable: true });
    return { externalUserId: 'provider-a', providerBalanceMinor: 8_000, currency: 'CNY', fetchedAt: input.providerStale ? '2026-07-18T09:00:00.000Z' : now.toISOString(), providerAsOf: now.toISOString(), stale: input.providerStale === true };
  } };
  const server = buildApiServer({
    env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'bot-token' },
    security: {},
    account: { store: accountStore, fundingAdapter, providerKey: 'mock', profileStore, rechargeUrl: 'https://payments.example.test/recharge', now: () => now }
  });
  const headers = (discordUserId = discordA) => ({ authorization: 'Bearer bot-token', 'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': discordUserId, 'x-actor-guild-id': guildId });
  return { server, profileStore, headers };
}

describe('M6-US-05 current-user profile API', () => {
  test('derives the user only from trusted DISCORD_BOT actor context and scopes all facts to its Guild', async () => {
    const f = await fixture();
    const profile = await f.server.inject({ method: 'GET', url: `/api/v1/me/profile?userId=${userB}`, headers: f.headers() });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().data.user).toMatchObject({ userId: userA, discordUserId: discordA });
    expect(profile.json().data.statistics).toMatchObject({ orderCount: 2, orderSpendMinor: 10_000, giftSpendMinor: 2_000 });
    expect(JSON.stringify(profile.json())).not.toContain(userB);
  });

  test('returns fresh, stale snapshot, and unavailable balance modules without relabeling stale Provider data', async () => {
    const fresh = await fixture();
    expect((await fresh.server.inject({ method: 'GET', url: '/api/v1/me/profile', headers: fresh.headers() })).json().data.balance)
      .toEqual({ providerBalanceMinor: 8_000, reservedMinor: 5_000, availableMinor: 3_000, currency: 'CNY', fetchedAt: now.toISOString(), stale: false, providerError: null });
    const stale = await fixture({ providerFails: true });
    expect((await stale.server.inject({ method: 'GET', url: '/api/v1/me/profile', headers: stale.headers() })).json().data.balance)
      .toMatchObject({ providerBalanceMinor: 8_000, reservedMinor: 5_000, availableMinor: 3_000, fetchedAt: '2026-07-18T10:00:00.000Z', stale: true, providerError: { code: 'PROVIDER_TIMEOUT', requestId: 'req_profile_timeout' } });
    const unavailable = await fixture({ providerFails: true, noSnapshot: true });
    expect((await unavailable.server.inject({ method: 'GET', url: '/api/v1/me/profile', headers: unavailable.headers() })).json().data.balance)
      .toEqual({ providerBalanceMinor: null, reservedMinor: null, availableMinor: null, currency: null, fetchedAt: null, stale: true,
        providerError: { code: 'PROVIDER_TIMEOUT', retryable: true, requestId: 'req_profile_timeout' } });
    const staleSuccess = await fixture({ providerStale: true });
    const before = staleSuccess.profileStore.balanceSnapshots.length;
    expect((await staleSuccess.server.inject({ method: 'GET', url: '/api/v1/me/profile', headers: staleSuccess.headers() })).json().data.balance.stale).toBe(true);
    expect(staleSuccess.profileStore.balanceSnapshots).toHaveLength(before);
  });

  test('paginates only the current user orders and consumptions without accepting target IDs', async () => {
    const f = await fixture();
    const first = await f.server.inject({ method: 'GET', url: `/api/v1/me/orders?limit=1&userId=${userB}`, headers: f.headers() });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.items).toHaveLength(1);
    expect(first.json().data.nextCursor).toEqual(expect.any(String));
    expect(first.json().data.nextCursor).toMatch(/^c1_[A-Za-z0-9_-]+$/u);
    expect(first.json().data.items[0]).toEqual(expect.objectContaining({ publicId: expect.any(String), amountMinor: 10_000 }));
    expect(first.json().data.items[0]).not.toHaveProperty('customerId');
    expect(first.json().data.items[0]).not.toHaveProperty('guildId');
    expect(first.json().data.items[0]).not.toHaveProperty('playerUserId');
    expect(first.json().data.items[0]).not.toHaveProperty('assignedStaffIds');
    expect(JSON.stringify(first.json().data.items[0]).toLowerCase()).not.toMatch(/providertransaction|referral|beneficiary|commission|profit|margin|playerearning|internalnote|risk/u);
    const second = await f.server.inject({ method: 'GET', url: `/api/v1/me/orders?limit=1&cursor=${encodeURIComponent(first.json().data.nextCursor)}`, headers: f.headers() });
    expect(second.json().data.items[0].id).not.toBe(first.json().data.items[0].id);
    const consumptions = await f.server.inject({ method: 'GET', url: `/api/v1/me/consumptions?limit=1&userId=${userB}`, headers: f.headers() });
    expect(consumptions.json().data.items).toHaveLength(1);
    expect(consumptions.json().data.nextCursor).toEqual(expect.any(String));
    expect(consumptions.json().data.items[0].amountMinor).toBe(10_000);
    expect(JSON.stringify(consumptions.json().data)).not.toContain('other-guild');

    const tampered = `${first.json().data.nextCursor.slice(0, -1)}A`;
    const rejected = await f.server.inject({ method: 'GET', url: `/api/v1/me/orders?limit=1&cursor=${encodeURIComponent(tampered)}`, headers: f.headers() });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    const crossResource = await f.server.inject({ method: 'GET',
      url: `/api/v1/me/consumptions?limit=1&cursor=${encodeURIComponent(first.json().data.nextCursor)}`, headers: f.headers() });
    expect(crossResource.statusCode).toBe(400);
    expect(crossResource.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  test('uses a strict self-service whitelist and a non-enumerating 404 for an unbound actor', async () => {
    const f = await fixture();
    const response = await f.server.inject({ method: 'GET', url: '/api/v1/me/profile', headers: f.headers() });
    const serialized = JSON.stringify(response.json().data).toLowerCase();
    expect(response.json().data.rechargeUrl).toBe('https://payments.example.test/recharge');
    expect(serialized).not.toMatch(/referral|beneficiary|commission|ratebps|internalnote|risk|profit|margin|playerearning|externaluserid/u);
    const missing = await f.server.inject({ method: 'GET', url: '/api/v1/me/profile', headers: f.headers('900000000000006599') });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
