import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryPlayerEarningStore, registerPlayerEarningRoutes, type PlayerEarningRecord } from '@blackcat/api/player-earnings';
import { InMemoryAuditSink, InMemoryIdempotencyStore, type StaffDirectory } from '@blackcat/api/security';

const now = new Date('2026-07-18T16:00:00.000Z');
const earningId = '00000000-0000-0000-0000-000000003810';
const playerId = '00000000-0000-0000-0000-000000003811';

function earning(): PlayerEarningRecord {
  return { id: earningId, playerId, orderId: '00000000-0000-0000-0000-000000003812', baseUnits: 2,
    unitPayoutMinor: 4200, amountMinor: 8400, currency: 'CAT', status: 'PENDING', version: 1,
    confirmedByStaffId: null, confirmedAt: null, paidAt: null, adjustments: [], netAmountMinor: 8400,
    createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

function staffHeaders(key?: string) {
  return { authorization: 'Bearer valid-bot-token', 'x-client-source': 'DASHBOARD',
    'x-actor-discord-user-id': '900000000000000031', 'x-actor-guild-id': '900000000000000001',
    'x-discord-interaction-id': '900000000000000032', ...(key ? { 'idempotency-key': key } : {}) };
}

function fixture(level: 'L2_SUPERVISOR' | 'L3_OPERATIONS', stepUp = false) {
  const store = new InMemoryPlayerEarningStore({ earnings: [earning()], playerBindings: {
    '900000000000000001:900000000000000041': playerId } });
  const staffDirectory: StaffDirectory = { resolveByDiscord: () => ({ staffId: '00000000-0000-0000-0000-000000003813',
    userId: '00000000-0000-0000-0000-000000003813', level, status: 'ACTIVE', permissionsVersion: 1 }) };
  const server = buildApiServer({ env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    security: { staffDirectory, auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore(), stepUpVerifier: { verify: () => stepUp } } });
  registerPlayerEarningRoutes(server, { store, now: () => now });
  return { server, store };
}

describe('M3-US-04 player earnings API', () => {
  test('returns only the actor-derived player earnings', async () => {
    const { server } = fixture('L2_SUPERVISOR');
    const response = await server.inject({ method: 'GET', url: '/api/v1/players/me/earnings', headers: {
      authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT',
      'x-actor-discord-user-id': '900000000000000041', 'x-actor-guild-id': '900000000000000001' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { items: [{ id: earningId, playerId, netAmountMinor: 8400 }], nextCursor: null } });
  });

  test('allows L2 to list but denies mutation', async () => {
    const { server } = fixture('L2_SUPERVISOR');
    expect((await server.inject({ method: 'GET', url: '/api/v1/admin/player-earnings', headers: staffHeaders() })).statusCode).toBe(200);
    const denied = await server.inject({ method: 'PATCH', url: `/api/v1/admin/player-earnings/${earningId}`,
      headers: staffHeaders('earning:l2:deny:0001'), payload: { expectedVersion: 1, action: 'CONFIRM', reasonCode: 'REVIEWED' } });
    expect(denied.statusCode).toBe(403);
  });

  test('requires L3 step-up and reason for CONFIRM then MARK_PAID', async () => {
    const blocked = fixture('L3_OPERATIONS', false);
    expect((await blocked.server.inject({ method: 'PATCH', url: `/api/v1/admin/player-earnings/${earningId}`,
      headers: staffHeaders('earning:no-step:0001'), payload: { expectedVersion: 1, action: 'CONFIRM', reasonCode: 'REVIEWED' } })).statusCode).toBe(428);

    const { server, store } = fixture('L3_OPERATIONS', true);
    const confirmRequest = { method: 'PATCH' as const, url: `/api/v1/admin/player-earnings/${earningId}`,
      headers: staffHeaders('earning:confirm:0001'), payload: { expectedVersion: 1, action: 'CONFIRM', reasonCode: 'REVIEWED', note: 'Snapshot verified.' } };
    const confirmed = await server.inject(confirmRequest);
    const confirmedReplay = await server.inject(confirmRequest);
    expect(confirmed.json()).toMatchObject({ data: { resultType: 'STATE_UPDATED', playerEarning: { status: 'CONFIRMED', version: 2 }, adjustment: null } });
    expect(confirmedReplay.json()).toEqual(confirmed.json());
    const paidRequest = { method: 'PATCH' as const, url: `/api/v1/admin/player-earnings/${earningId}`,
      headers: staffHeaders('earning:paid:000001'), payload: { expectedVersion: 2, action: 'MARK_PAID', reasonCode: 'MANUAL_PAYMENT_RECORDED' } };
    const paid = await server.inject(paidRequest);
    const paidReplay = await server.inject(paidRequest);
    expect(paid.json()).toMatchObject({ data: { playerEarning: { status: 'PAID', version: 3 } } });
    expect(paidReplay.json()).toEqual(paid.json());
    expect(store.earnings[0]?.amountMinor).toBe(8400);
    expect(store.earnings[0]).toMatchObject({ status: 'PAID', version: 3 });
  });

  test('appends a reversal without replacing the original earning', async () => {
    const { server, store } = fixture('L3_OPERATIONS', true);
    const response = await server.inject({ method: 'PATCH', url: `/api/v1/admin/player-earnings/${earningId}`,
      headers: staffHeaders('earning:reverse:001'), payload: { expectedVersion: 1, action: 'CREATE_REVERSAL',
        reversalAmount: { amountMinor: 2400, currency: 'CAT' }, reasonCode: 'REFUND_ADJUSTMENT' } });
    expect(response.json()).toMatchObject({ data: { resultType: 'ADJUSTMENT_CREATED',
      playerEarning: { amountMinor: 8400, netAmountMinor: 6000, status: 'PENDING', version: 2 },
      adjustment: { type: 'REVERSAL_DEBIT', amountMinor: 2400 } } });
    expect(store.earnings).toHaveLength(1);
  });
});
