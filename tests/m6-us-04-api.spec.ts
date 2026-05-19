import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryDashboardAuthStore } from '@blackcat/api/dashboard-auth';
import { InMemoryAdminDirectoryStore } from '@blackcat/api/admin-directory';
import {
  InMemoryCustomerProfileStore,
  type CustomerProfileOrder,
  type CustomerProfileConsumption
} from '@blackcat/api/customer-profiles';
import { AdapterError } from '@blackcat/api/payment-adapter';
import type { StaffAccount } from '@blackcat/api/security';

const contractPaths = [
  'outputs/P0开发交付包/02-API/openapi.yaml',
  'docs/P0开发交付包/02-API/openapi.yaml'
] as const;

describe('M6-US-04 customer profile contract', () => {
  test.each(contractPaths)('%s fixes profile statistics, balance fallback, scope and privacy semantics', (path) => {
    const contract = readFileSync(path, 'utf8');
    const profile = contract.slice(contract.indexOf('CustomerStatistics:'), contract.indexOf('GiftAffordabilityInput:'));
    const balance = contract.slice(contract.indexOf('BalanceSummary:'), contract.indexOf('ReservationSummary:'));

    expect(profile).toMatch(/required: \[[^\]]*refundCount[^\]]*\]/u);
    expect(profile).toMatch(/refundCount: \{type: integer, minimum: 0\}/u);
    expect(profile).toContain('DAYS_30 starts at now minus 30 days; DAYS_90 starts at now minus 90 days; ALL has no lower bound.');
    expect(profile).toContain('averageOrderAmountMinor is floor(orderSpendMinor / completedOrderCount), or 0 when completedOrderCount is zero.');
    expect(profile).toContain('Never exposes referral, beneficiary, rate, commission, margin, profit, or player earning fields.');
    expect(profile).toContain('L1 and L2 receive masked external account identifiers and notes without author identity.');

    expect(balance).toContain('availableMinor is providerBalanceMinor - reservedMinor exactly and may be negative to represent a deficit.');
    expect(balance).toMatch(/required: \[[^\]]*providerError[^\]]*\]/u);
    expect(balance).toContain('A successful Provider response with stale=true remains stale and is not persisted as a successful snapshot.');
    expect(balance).toContain('When no successful snapshot exists, balance amounts, currency, and fetchedAt are null while providerError remains populated.');
    expect(balance).toMatch(/providerBalanceMinor: \{type: \[integer, 'null'\]/u);
    expect(contract).toContain('All profile statistics, orders, refunds, adjustments, and consumption pages are filtered by the trusted Dashboard Guild.');

    expect(contract).toMatch(/operationId: listAdminUserConsumptions[\s\S]*?x-required-permissions: \[customer_profile\.read\]/u);
    expect(contract).toMatch(/operationId: getAdminCustomerProfileSummary[\s\S]*?x-authorization-rules: \[[^\]]*same-customer-scope-predicate[^\]]*\]/u);
    expect(contract).toMatch(/operationId: listAdminCustomerOrders[\s\S]*?x-authorization-rules: \[[^\]]*same-customer-scope-predicate[^\]]*\]/u);
  });
});

const guildId = '900000000000006400';
const otherGuildId = '900000000000006499';
const now = new Date('2026-07-19T18:00:00.000Z');
const l1Id = '00000000-0000-0000-0000-000000006401';
const l2Id = '00000000-0000-0000-0000-000000006402';
const customerA = '00000000-0000-0000-0000-000000006410';
const customerB = '00000000-0000-0000-0000-000000006411';
const playerId = '00000000-0000-0000-0000-000000006412';

function order(input: Partial<CustomerProfileOrder> & Pick<CustomerProfileOrder, 'id' | 'customerId' | 'createdAt'>): CustomerProfileOrder {
  return {
    publicId: input.id, guildId, status: 'COMPLETED', gameKey: 'VALORANT', serviceKey: 'RANKED',
    playerUserId: playerId, playerDisplayName: '陪玩甲', amountMinor: 10_000, currency: 'CNY', completedAt: input.createdAt,
    ...input
  };
}

function consumption(input: Partial<CustomerProfileConsumption> & Pick<CustomerProfileConsumption, 'id' | 'userId' | 'occurredAt'>): CustomerProfileConsumption {
  return { type: 'ORDER', sourceId: input.id, orderId: null, amountMinor: 10_000, currency: 'CNY', ...input };
}

async function fixture(input: { level?: StaffAccount['level']; providerFails?: boolean; providerStale?: boolean; noSnapshot?: boolean; assigned?: boolean } = {}) {
  const level = input.level ?? 'L2_SUPERVISOR';
  const staffId = level === 'L1_SUPPORT' ? l1Id : l2Id;
  const auth = new InMemoryDashboardAuthStore();
  const session = auth.createSession({ staffId, userId: staffId, level, permissionsVersion: 7, status: 'ACTIVE' }, now);
  const orders = [
    order({ id: '00000000-0000-0000-0000-000000006421', customerId: customerA, createdAt: '2026-07-18T12:00:00.000Z', amountMinor: 10_001,
      assignedStaffIds: input.assigned === false ? [] : [l1Id] }),
    order({ id: '00000000-0000-0000-0000-000000006422', customerId: customerA, createdAt: '2026-06-01T12:00:00.000Z', amountMinor: 20_000 }),
    order({ id: '00000000-0000-0000-0000-000000006423', customerId: customerA, createdAt: '2026-03-01T12:00:00.000Z', status: 'CANCELLED', completedAt: null }),
    order({ id: '00000000-0000-0000-0000-000000006424', customerId: customerB, createdAt: '2026-07-18T12:00:00.000Z', assignedStaffIds: [] }),
    order({ id: '00000000-0000-0000-0000-000000006425', customerId: customerA, guildId: otherGuildId,
      createdAt: '2026-07-18T14:00:00.000Z', amountMinor: 90_000 })
  ];
  const consumptions = [
    consumption({ id: '00000000-0000-0000-0000-000000006431', userId: customerA, orderId: orders[0]!.id, occurredAt: '2026-07-18T12:05:00.000Z', amountMinor: 10_001 }),
    consumption({ id: '00000000-0000-0000-0000-000000006432', userId: customerA, orderId: orders[0]!.id, occurredAt: '2026-07-18T12:06:00.000Z', type: 'GIFT', amountMinor: 2_500 }),
    consumption({ id: '00000000-0000-0000-0000-000000006433', userId: customerA, orderId: orders[0]!.id, occurredAt: '2026-07-18T12:07:00.000Z', type: 'REFUND_REVERSAL', amountMinor: -1_500 }),
    consumption({ id: '00000000-0000-0000-0000-000000006434', userId: customerA, orderId: orders[1]!.id, occurredAt: '2026-06-01T12:05:00.000Z', amountMinor: 20_000 }),
    consumption({ id: '00000000-0000-0000-0000-000000006435', userId: customerA, orderId: orders[4]!.id,
      occurredAt: '2026-07-18T14:05:00.000Z', amountMinor: 90_000 })
  ];
  const profileStore = new InMemoryCustomerProfileStore({
    users: [
      { id: customerA, guildId, discordUserId: '900000000000006410', displayName: '客户甲', status: 'ACTIVE', provider: 'mock', externalUserId: 'provider-secret-1234' },
      { id: customerB, guildId, discordUserId: '900000000000006411', displayName: '客户乙', status: 'ACTIVE', provider: 'mock', externalUserId: 'provider-secret-5678' },
      { id: '00000000-0000-0000-0000-000000006419', guildId: otherGuildId, discordUserId: '900000000000006419', displayName: '外部组织', status: 'ACTIVE', provider: 'mock', externalUserId: 'other-secret' }
    ],
    orders, consumptions,
    reservations: [{ userId: customerA, currency: 'CNY', remainingMinor: 12_000 }],
    notes: [{ id: '00000000-0000-0000-0000-000000006441', userId: customerA, guildId, text: '仅供客服跟进', authorStaffId: l2Id, createdAt: '2026-07-18T13:00:00.000Z' }],
    riskFlags: [{ userId: customerA, value: 'PAYMENT_ANOMALY' }],
    balanceSnapshots: input.noSnapshot ? [] : [{ id: '00000000-0000-0000-0000-000000006451', userId: customerA, provider: 'mock', providerBalanceMinor: 8_000,
      currency: 'CNY', fetchedAt: '2026-07-18T10:00:00.000Z' }]
  });
  const adminStore = new InMemoryAdminDirectoryStore({ orders: [], users: [], players: [], gifts: [], giftRequests: [],
    consumptions: consumptions.map((item) => ({ id: item.id, userId: item.userId, type: item.type, sourceId: item.sourceId,
      guildId: orders.find((candidate) => candidate.id === item.orderId)?.guildId,
      amountMinor: item.amountMinor, currency: item.currency, status: item.amountMinor < 0 ? 'REVERSED' : 'SUCCEEDED', occurredAt: item.occurredAt, reversalOf: null })) });
  const fundingAdapter = { getProviderBalance: () => {
    if (input.providerFails) throw new AdapterError('PROVIDER_TIMEOUT', 'Provider timed out.', { requestId: 'req_provider_timeout', retryable: true });
    return { externalUserId: 'provider-secret-1234', providerBalanceMinor: 8_000, currency: 'CNY',
      fetchedAt: input.providerStale ? '2026-07-18T09:00:00.000Z' : now.toISOString(), providerAsOf: now.toISOString(), stale: input.providerStale === true };
  } };
  const server = buildApiServer({
    env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'bot-token' },
    security: { dashboardSessions: auth },
    dashboardAuth: { store: auth, oauth: { getAuthorizationUrl: () => '', exchangeCode: async () => ({ discordUserId: 'unused' }) },
      staffDirectory: { resolveByDiscord: () => null }, guildId, dashboardUrl: 'http://localhost:5173', now: () => now },
    customerProfiles: { store: profileStore, fundingAdapter, now: () => now },
    adminDirectory: { store: adminStore, customerScope: profileStore }
  });
  const headers = { cookie: `p0_session=${session.sessionToken}`, 'x-client-source': 'DASHBOARD', 'x-actor-guild-id': 'attacker-guild' };
  return { server, profileStore, headers };
}

describe('M6-US-04 customer profile API', () => {
  test('computes 30/90/all windows, refundCount and floor average on the server', async () => {
    const f = await fixture();
    const days30 = await f.server.inject({ method: 'GET', url: `/api/v1/admin/users/${customerA}/profile-summary?window=DAYS_30`, headers: f.headers });
    const days90 = await f.server.inject({ method: 'GET', url: `/api/v1/admin/users/${customerA}/profile-summary?window=DAYS_90`, headers: f.headers });
    const all = await f.server.inject({ method: 'GET', url: `/api/v1/admin/users/${customerA}/profile-summary?window=ALL`, headers: f.headers });
    expect(days30.statusCode).toBe(200);
    expect(days30.json().data.statistics).toMatchObject({ orderCount: 1, completedOrderCount: 1, cancelledOrderCount: 0, refundCount: 1,
      orderSpendMinor: 10_001, giftSpendMinor: 2_500, refundMinor: 1_500, totalConsumptionMinor: 11_001, averageOrderAmountMinor: 10_001 });
    expect(days90.json().data.statistics).toMatchObject({ orderCount: 2, completedOrderCount: 2, refundCount: 1, orderSpendMinor: 30_001, averageOrderAmountMinor: 15_000 });
    expect(all.json().data.statistics).toMatchObject({ orderCount: 3, completedOrderCount: 2, cancelledOrderCount: 1, refundCount: 1, averageOrderAmountMinor: 15_000 });
  });

  test('subtracts reserved balance exactly and returns a persistent stale snapshot on Provider failure', async () => {
    const live = await fixture();
    const fresh = await live.server.inject({ method: 'GET', url: `/api/v1/admin/users/${customerA}/profile-summary`, headers: live.headers });
    expect(fresh.json().data.balance).toEqual({ providerBalanceMinor: 8_000, reservedMinor: 12_000, availableMinor: -4_000,
      currency: 'CNY', fetchedAt: now.toISOString(), stale: false, providerError: null });

    const failed = await fixture({ providerFails: true });
    const stale = await failed.server.inject({ method: 'GET', url: `/api/v1/admin/users/${customerA}/profile-summary`, headers: failed.headers });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().data.balance).toEqual({ providerBalanceMinor: 8_000, reservedMinor: 12_000, availableMinor: -4_000,
      currency: 'CNY', fetchedAt: '2026-07-18T10:00:00.000Z', stale: true,
      providerError: { code: 'PROVIDER_TIMEOUT', retryable: true, requestId: 'req_provider_timeout' } });
    expect(stale.json().data.statistics.orderCount).toBe(1);
  });

  test('preserves stale Provider success without persisting it as a fresh snapshot', async () => {
    const f = await fixture({ providerStale: true });
    const before = f.profileStore.balanceSnapshots.length;
    const response = await f.server.inject({ method: 'GET', url: `/api/v1/admin/users/${customerA}/profile-summary`, headers: f.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.balance).toMatchObject({ providerBalanceMinor: 8_000, stale: true, fetchedAt: '2026-07-18T09:00:00.000Z', providerError: null });
    expect(f.profileStore.balanceSnapshots).toHaveLength(before);
  });

  test('returns an unavailable balance module instead of failing the profile when no snapshot exists', async () => {
    const f = await fixture({ providerFails: true, noSnapshot: true });
    const response = await f.server.inject({ method: 'GET', url: `/api/v1/admin/users/${customerA}/profile-summary`, headers: f.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.balance).toEqual({ providerBalanceMinor: null, reservedMinor: null, availableMinor: null,
      currency: null, fetchedAt: null, stale: true, providerError: { code: 'PROVIDER_TIMEOUT', retryable: true, requestId: 'req_provider_timeout' } });
    expect(response.json().data.user.displayName).toBe('客户甲');
    expect(response.json().data.statistics.orderCount).toBe(1);
    expect(response.json().data.preferences.preferredGameKeys).toContain('VALORANT');
    expect(response.json().data.internalNotes).toHaveLength(1);
  });

  test('paginates orders and finances independently', async () => {
    const f = await fixture();
    const first = await f.server.inject({ method: 'GET', url: `/api/v1/admin/users/${customerA}/orders?limit=1`, headers: f.headers });
    expect(first.json().data.items).toHaveLength(1);
    expect(first.json().data.nextCursor).toEqual(expect.any(String));
    const second = await f.server.inject({ method: 'GET', url: `/api/v1/admin/users/${customerA}/orders?limit=1&cursor=${encodeURIComponent(first.json().data.nextCursor)}`, headers: f.headers });
    expect(second.json().data.items[0].id).not.toBe(first.json().data.items[0].id);
    const finance = await f.server.inject({ method: 'GET', url: `/api/v1/admin/users/${customerA}/consumptions?limit=2`, headers: f.headers });
    expect(finance.statusCode).toBe(200);
    expect(finance.json().data.items).toHaveLength(2);
    expect(finance.json().data.nextCursor).toEqual(expect.any(String));
  });

  test('filters summary, orders and finance pagination to the trusted Guild for the same user', async () => {
    const f = await fixture();
    const summary = await f.server.inject({ method: 'GET', url: `/api/v1/admin/users/${customerA}/profile-summary`, headers: f.headers });
    const orders = await f.server.inject({ method: 'GET', url: `/api/v1/admin/users/${customerA}/orders?limit=25`, headers: f.headers });
    const finance = await f.server.inject({ method: 'GET', url: `/api/v1/admin/users/${customerA}/consumptions?limit=25`, headers: f.headers });
    expect(summary.json().data.statistics).toMatchObject({ orderCount: 1, orderSpendMinor: 10_001, totalConsumptionMinor: 11_001 });
    expect(orders.json().data.items.map((item: { id: string }) => item.id)).not.toContain('00000000-0000-0000-0000-000000006425');
    expect(finance.json().data.items.map((item: { id: string }) => item.id)).not.toContain('00000000-0000-0000-0000-000000006435');
  });

  test('uses one L1 assigned-order/task predicate for direct summary, order and finance URLs', async () => {
    const visible = await fixture({ level: 'L1_SUPPORT', assigned: true });
    for (const path of [`/api/v1/admin/users/${customerA}/profile-summary`, `/api/v1/admin/users/${customerA}/orders`, `/api/v1/admin/users/${customerA}/consumptions`]) {
      expect((await visible.server.inject({ method: 'GET', url: path, headers: visible.headers })).statusCode).toBe(200);
    }
    const hidden = await fixture({ level: 'L1_SUPPORT', assigned: false });
    for (const path of [`/api/v1/admin/users/${customerB}/profile-summary`, `/api/v1/admin/users/${customerB}/orders`, `/api/v1/admin/users/${customerB}/consumptions`]) {
      const response = await hidden.server.inject({ method: 'GET', url: path, headers: hidden.headers });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
  });

  test('returns a strict profile whitelist with L2 masking and no confidential economics', async () => {
    const f = await fixture();
    const response = await f.server.inject({ method: 'GET', url: `/api/v1/admin/users/${customerA}/profile-summary`, headers: f.headers });
    const serialized = JSON.stringify(response.json().data).toLowerCase();
    expect(response.json().data.externalAccountDisplay).toBe('mock:***1234');
    expect(response.json().data.internalNotes).toEqual([{ id: '00000000-0000-0000-0000-000000006441', text: '仅供客服跟进', createdAt: '2026-07-18T13:00:00.000Z' }]);
    expect(serialized).not.toMatch(/referral|beneficiary|commission|ratebps|profit|margin|playerearning|authorstaff/u);
  });
});
