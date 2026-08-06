import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryCommissionStore, registerCommissionRoutes, type CommissionRecord } from '@blackcat/api/commissions';
import { InMemoryAuditSink, InMemoryIdempotencyStore, type StaffDirectory } from '@blackcat/api/security';

const now = new Date('2026-07-18T18:00:00.000Z');
const commissionId = '00000000-0000-0000-0000-000000004110';

function commission(): CommissionRecord {
  return { id: commissionId, referralAttributionId: '00000000-0000-0000-0000-000000004111',
    sourceCustomerId: '00000000-0000-0000-0000-000000004112', beneficiaryId: '00000000-0000-0000-0000-000000004113',
    programType: 'PLAYER_LIFETIME', rewardMode: 'PERCENT_LIFETIME', sourceType: 'ORDER',
    sourceId: '00000000-0000-0000-0000-000000004114', baseAmountMinor: 10000, rateBps: 200,
    amountMinor: 200, currency: 'CAT', status: 'PENDING', adjustments: [], netAmountMinor: 200,
    version: 1, confirmedAt: null, paidAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

function headers(key?: string, guildId = '900000000000000001') {
  return { authorization: 'Bearer valid-bot-token', 'x-client-source': 'DASHBOARD',
    'x-actor-discord-user-id': '900000000000000051', 'x-actor-guild-id': guildId,
    'x-discord-interaction-id': '900000000000000052', ...(key ? { 'idempotency-key': key } : {}) };
}

function fixture(level: 'L2_SUPERVISOR' | 'L3_OPERATIONS', stepUp = false) {
  const store = new InMemoryCommissionStore({ commissions: [commission()], commissionGuildIds: { [commissionId]: '900000000000000001' } });
  const staffDirectory: StaffDirectory = { resolveByDiscord: () => ({ staffId: '00000000-0000-0000-0000-000000004115',
    userId: '00000000-0000-0000-0000-000000004115', level, status: 'ACTIVE', permissionsVersion: 1 }) };
  const server = buildApiServer({ env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    security: { staffDirectory, auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore(), stepUpVerifier: { verify: () => stepUp } } });
  registerCommissionRoutes(server, { store, now: () => now });
  return { server, store };
}

describe('M3-US-05 confidential commission administration', () => {
  test('does not enumerate or mutate commissions across Guilds', async () => {
    const { server, store } = fixture('L3_OPERATIONS', true);
    const crossGuildHeaders = headers(undefined, '900000000000000099');
    const list = await server.inject({ method: 'GET', url: '/api/v1/admin/commissions', headers: crossGuildHeaders });
    const detail = await server.inject({ method: 'GET', url: `/api/v1/admin/commissions/${commissionId}`, headers: crossGuildHeaders });
    const mutation = await server.inject({ method: 'PATCH', url: `/api/v1/admin/commissions/${commissionId}`,
      headers: headers('commission:cross-guild:0001', '900000000000000099'),
      payload: { expectedVersion: 1, action: 'CONFIRM', reasonCode: 'REVIEWED' } });
    expect(list.json()).toMatchObject({ data: { items: [] } }); expect(detail.statusCode).toBe(404); expect(mutation.statusCode).toBe(404);
    expect(store.commissions[0]).toMatchObject({ status: 'PENDING', version: 1 });
  });

  test('passes the trusted actor Guild into confidential list and mutation stores', async () => {
    const { server, store } = fixture('L3_OPERATIONS', true);
    let listGuild: unknown; let mutationGuild: unknown;
    const listPage = store.listPage.bind(store); const mutate = store.mutate.bind(store);
    store.listPage = ((input) => { listGuild = (input as typeof input & { guildId?: unknown }).guildId; return listPage(input); }) as typeof store.listPage;
    store.mutate = ((input) => { mutationGuild = (input as typeof input & { guildId?: unknown }).guildId; return mutate(input); }) as typeof store.mutate;
    const list = await server.inject({ method: 'GET', url: '/api/v1/admin/commissions', headers: headers() });
    const mutation = await server.inject({ method: 'PATCH', url: `/api/v1/admin/commissions/${commissionId}`,
      headers: headers('commission:guild-scope:0001'), payload: { expectedVersion: 1, action: 'CONFIRM', reasonCode: 'REVIEWED' } });
    expect(list.statusCode).toBe(200); expect(mutation.statusCode).toBe(200);
    expect(listGuild).toBe('900000000000000001'); expect(mutationGuild).toBe('900000000000000001');
  });

  test('denies confidential records to L2 staff', async () => {
    const { server } = fixture('L2_SUPERVISOR');
    expect((await server.inject({ method: 'GET', url: '/api/v1/admin/commissions', headers: headers() })).statusCode).toBe(403);
    expect((await server.inject({ method: 'GET', url: `/api/v1/admin/commissions/${commissionId}`, headers: headers() })).statusCode).toBe(403);
  });

  test('allows L3 reads but requires recent step-up for mutation', async () => {
    const blocked = fixture('L3_OPERATIONS');
    expect((await blocked.server.inject({ method: 'GET', url: '/api/v1/admin/commissions', headers: headers() })).json())
      .toMatchObject({ data: { items: [{ id: commissionId, sourceCustomerId: expect.any(String), rateBps: 200 }] } });
    expect((await blocked.server.inject({ method: 'PATCH', url: `/api/v1/admin/commissions/${commissionId}`,
      headers: headers('commission:no-step:0001'), payload: { expectedVersion: 1, action: 'CONFIRM', reasonCode: 'REVIEWED' } })).statusCode).toBe(428);
  });

  test('confirms, marks paid, and preserves the immutable amount', async () => {
    const { server, store } = fixture('L3_OPERATIONS', true);
    const confirmed = await server.inject({ method: 'PATCH', url: `/api/v1/admin/commissions/${commissionId}`,
      headers: headers('commission:confirm:0001'), payload: { expectedVersion: 1, action: 'CONFIRM', reasonCode: 'REVIEWED' } });
    expect(confirmed.json()).toMatchObject({ data: { commission: { status: 'CONFIRMED', version: 2, amountMinor: 200 } } });
    const paid = await server.inject({ method: 'PATCH', url: `/api/v1/admin/commissions/${commissionId}`,
      headers: headers('commission:paid:000001'), payload: { expectedVersion: 2, action: 'MARK_PAID', reasonCode: 'PAYMENT_RECORDED' } });
    expect(paid.json()).toMatchObject({ data: { commission: { status: 'PAID', version: 3, amountMinor: 200 } } });
    expect(store.commissions[0]?.amountMinor).toBe(200);
  });

  test('appends an idempotent reversal without replacing the commission', async () => {
    const { server, store } = fixture('L3_OPERATIONS', true);
    const request = { method: 'PATCH' as const, url: `/api/v1/admin/commissions/${commissionId}`,
      headers: headers('commission:reverse:001'), payload: { expectedVersion: 1, action: 'CREATE_REVERSAL',
        reversalAmount: { amountMinor: 80, currency: 'CAT' }, reasonCode: 'PARTIAL_REFUND' } };
    const response = await server.inject(request);
    expect(response.json()).toMatchObject({ data: { resultType: 'ADJUSTMENT_CREATED',
      commission: { amountMinor: 200, netAmountMinor: 120, version: 2 },
      adjustment: { type: 'REVERSAL_DEBIT', amountMinor: 80 } } });
    const replay = await server.inject(request);
    expect(replay.statusCode).toBe(200);
    expect(store.commissions).toHaveLength(1);
    expect(store.commissions[0]?.adjustments).toHaveLength(1);
  });
});
