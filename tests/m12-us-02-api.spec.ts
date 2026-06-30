import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore, type StaffDirectory, type StaffLevel } from '@blackcat/api/security';
import { InMemorySupportOperationsStore } from '@blackcat/api/support-operations';

const now = new Date('2026-08-05T16:00:00.000Z');
const guildId = '999999999999999999';
const otherGuildId = '888888888888888888';
const ids = { l1: '00000000-0000-0000-0000-000000001001', l2: '00000000-0000-0000-0000-000000001002', l3: '00000000-0000-0000-0000-000000001003' };
const discord = { l1: '111111111111111111', l2: '222222222222222222', l3: '333333333333333333' };
const levels: Record<string, StaffLevel> = { [discord.l1]: 'L1_SUPPORT', [discord.l2]: 'L2_SUPERVISOR', [discord.l3]: 'L3_OPERATIONS' };
const directory: StaffDirectory = { resolveByDiscord: ({ discordUserId, guildId: actorGuildId }) => [guildId, otherGuildId].includes(actorGuildId) && levels[discordUserId]
  ? { staffId: discordUserId === discord.l1 ? ids.l1 : discordUserId === discord.l2 ? ids.l2 : ids.l3, userId: crypto.randomUUID(), level: levels[discordUserId]!, permissionsVersion: 1, status: 'ACTIVE' }
  : null };

function fixture() {
  const store = new InMemorySupportOperationsStore({ staff: [
    { staffId: ids.l1, displayName: '小黑', level: 'L1_SUPPORT' },
    { staffId: ids.l2, displayName: '主管', level: 'L2_SUPERVISOR' },
    { staffId: ids.l3, displayName: '运营', level: 'L3_OPERATIONS' }
  ] });
  const server = buildApiServer({
    env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    security: { staffDirectory: directory, auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() },
    supportOperations: { store, now: () => now }
  });
  return { server, store };
}

function headers(who: keyof typeof discord, key?: string, actorGuildId = guildId) {
  return { authorization: 'Bearer valid-bot-token', 'x-client-source': 'DASHBOARD', 'x-actor-discord-user-id': discord[who],
    'x-actor-guild-id': actorGuildId, ...(key ? { 'idempotency-key': key } : {}) };
}

describe('M12-US-02 minimal support shifts and summary', () => {
  test('L1 clock-in is idempotent and current shift is queryable', async () => {
    const { server, store } = fixture();
    const first = await server.inject({ method: 'POST', url: '/api/v1/admin/support-shifts/clock-in', headers: headers('l1', 'support-clock-in-0001'), payload: {} });
    const again = await server.inject({ method: 'POST', url: '/api/v1/admin/support-shifts/clock-in', headers: headers('l1', 'support-clock-in-0002'), payload: {} });
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(again.json().data.id).toBe(first.json().data.id);
    expect(store.shifts).toHaveLength(1);
    const current = await server.inject({ method: 'GET', url: '/api/v1/admin/support-shifts/me', headers: headers('l1') });
    expect(current.json().data).toMatchObject({ staffId: ids.l1, clockedInAt: now.toISOString(), clockedOutAt: null });
  });

  test('only L1/L2 may clock and a claimed order-level task blocks clock-out', async () => {
    const { server, store } = fixture();
    expect((await server.inject({ method: 'POST', url: '/api/v1/admin/support-shifts/clock-in', headers: headers('l3', 'support-l3-clock-in'), payload: {} })).statusCode).toBe(403);
    await server.inject({ method: 'POST', url: '/api/v1/admin/support-shifts/clock-in', headers: headers('l1', 'support-l1-clock-in'), payload: {} });
    store.claimedTaskStaffIds.add(ids.l1);
    const blocked = await server.inject({ method: 'POST', url: '/api/v1/admin/support-shifts/clock-out', headers: headers('l1', 'support-l1-out-blocked'), payload: {} });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('ACTIVE_CLAIMED_TASKS');
    store.claimedTaskStaffIds.delete(ids.l1);
    const ended = await server.inject({ method: 'POST', url: '/api/v1/admin/support-shifts/clock-out', headers: headers('l1', 'support-l1-clock-out'), payload: {} });
    expect(ended.statusCode).toBe(200);
    expect(ended.json().data.clockedOutAt).toBe(now.toISOString());
  });

  test('L1 summary is self-only while L2 sees ACTIVE L1-L4 support actors', async () => {
    const { server, store } = fixture();
    store.metrics.set(ids.l1, { handledTaskCount: 4, overdueTaskCount: 1, ratingCount: 2, averageRating: 4.5 });
    const mine = await server.inject({ method: 'GET', url: '/api/v1/admin/support/summary', headers: headers('l1') });
    expect(mine.json().data.items).toEqual([expect.objectContaining({ staffId: ids.l1, displayName: '小黑', handledTaskCount: 4 })]);
    const team = await server.inject({ method: 'GET', url: '/api/v1/admin/support/summary', headers: headers('l2') });
    expect(team.json().data).toMatchObject({ windowStartedAt: '2026-07-06T16:00:00.000Z', unclaimedOverdueCount: 0,
      items: [{ staffId: ids.l1 }, { staffId: ids.l2 }, { staffId: ids.l3 }] });
  });

  test('the same support account has isolated active shifts per Guild', async () => {
    const { server, store } = fixture();
    await Promise.all([
      server.inject({ method:'POST', url:'/api/v1/admin/support-shifts/clock-in', headers:headers('l1','guild-one-clock-in',guildId), payload:{} }),
      server.inject({ method:'POST', url:'/api/v1/admin/support-shifts/clock-in', headers:headers('l1','guild-two-clock-in',otherGuildId), payload:{} })
    ]);
    expect(store.shifts.map((item) => item.guildId).sort()).toEqual([otherGuildId, guildId].sort());
  });
});
