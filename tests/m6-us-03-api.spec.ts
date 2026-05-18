import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryDashboardAuthStore } from '@blackcat/api/dashboard-auth';
import {
  InMemoryWeeklyReportStore,
  generateWeeklyReports,
  type PlayerWeeklyReportMetrics,
  type WeeklyReportFact,
  type WeeklyReportGenerationInput
} from '@blackcat/api/weekly-reports';
import type { StaffAccount } from '@blackcat/api/security';

const env = { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'bot-token' };
const guildId = '900000000000006300';
const playerA = '00000000-0000-0000-0000-000000006301';
const playerB = '00000000-0000-0000-0000-000000006302';
const staffId = '00000000-0000-0000-0000-000000006303';
const now = new Date('2026-07-19T18:00:00.000Z');

function generation(): WeeklyReportGenerationInput {
  return { guildId, scheduleKey: 'weekly-cny', periodStart: '2026-07-12T16:00:00.000Z',
    periodEnd: '2026-07-19T16:00:00.000Z', cutoffAt: '2026-07-19T16:00:00.000Z', timeZone: 'Asia/Shanghai', currency: 'CNY' };
}

function fact(playerUserId: string, suffix: string): WeeklyReportFact {
  return { id: `fact-${suffix}`, guildId, playerUserId, orderId: `order-${suffix}`, orderStatus: 'COMPLETED',
    serviceMinutes: 60, orderEarningMinor: suffix === 'a' ? 12_000 : 8_000, giftEarningMinor: 1_000,
    adjustmentMinor: 0, earningStatus: 'CONFIRMED', batchedMinor: 0,
    occurredAt: '2026-07-18T12:00:00.000Z', issues: [] };
}

function headers(actor: string, source: 'DASHBOARD' | 'DISCORD_BOT', key?: string) {
  return { authorization: 'Bearer bot-token', 'x-client-source': source, 'x-actor-discord-user-id': actor,
    'x-actor-guild-id': guildId, ...(key ? { 'idempotency-key': key } : {}) };
}

async function fixture(input: { level?: StaffAccount['level']; stepUp?: boolean } = {}) {
  const store = new InMemoryWeeklyReportStore({ facts: [fact(playerA, 'a'), fact(playerB, 'b')],
    playerBindings: { [`${guildId}:player-a`]: playerA, [`${guildId}:player-b`]: playerB } });
  const generated = await generateWeeklyReports({ store, input: generation() });
  const server = buildApiServer({ env, security: {
    staffDirectory: { resolveByDiscord: ({ discordUserId }) => discordUserId === 'staff'
      ? { staffId, userId: staffId, level: input.level ?? 'L3_OPERATIONS', permissionsVersion: 1, status: 'ACTIVE' } : null },
    stepUpVerifier: { verify: () => input.stepUp ?? true }
  }, weeklyReports: { store, now: () => now } });
  return { store, generated, server };
}

describe('M6-US-03 weekly report shared API', () => {
  test('resolves Dashboard Guild from the trusted session business scope and ignores actor headers', async () => {
    const store = new InMemoryWeeklyReportStore({ facts: [fact(playerA, 'a')] });
    await generateWeeklyReports({ store, input: generation() });
    const authStore = new InMemoryDashboardAuthStore();
    const session = authStore.createSession({ staffId, userId: staffId, level: 'L2_SUPERVISOR',
      permissionsVersion: 1, status: 'ACTIVE' }, now);
    const server = buildApiServer({ env, security: { dashboardSessions: authStore }, dashboardAuth: {
      store: authStore, oauth: { getAuthorizationUrl: () => 'https://discord.test/oauth', exchangeCode: async () => ({ discordUserId: 'staff' }) },
      staffDirectory: { resolveByDiscord: () => null }, guildId, dashboardUrl: 'http://localhost:5173', secureCookies: false, now: () => now
    }, weeklyReports: { store, now: () => now } });
    const response = await server.inject({ method: 'GET', url: '/api/v1/admin/weekly-reports', headers: {
      cookie: `p0_session=${session.sessionToken}`, 'x-client-source': 'DASHBOARD', 'x-actor-guild-id': 'attacker-guild'
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toHaveLength(2);
    expect(response.json().data.items.every((item: { guildId: string }) => item.guildId === guildId)).toBe(true);
  });

  test('allows L2 Dashboard reads and RFC4180 CSV of the current projection', async () => {
    const f = await fixture({ level: 'L2_SUPERVISOR' });
    const report = f.generated.playerReports[0]!;
    const list = await f.server.inject({ method: 'GET', url: '/api/v1/admin/weekly-reports', headers: headers('staff', 'DASHBOARD') });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ data: { items: expect.arrayContaining([expect.objectContaining({ id: report.id })]), nextCursor: null } });

    const csv = await f.server.inject({ method: 'GET', url: `/api/v1/admin/weekly-reports/${report.id}/export`, headers: headers('staff', 'DASHBOARD') });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    expect(csv.body).toContain('\r\n');
    expect(csv.body).toContain('report_type,period_start,period_end,time_zone,currency,status,current_revision');
    expect(csv.body.toLowerCase()).not.toMatch(/bank|account_number|referral|beneficiary/u);
  });

  test('appends a step-up protected L3 revision and replays idempotently', async () => {
    const f = await fixture();
    const report = f.generated.playerReports[0]!;
    const snapshot: PlayerWeeklyReportMetrics = { ...report.metrics, adjustmentMinor: 500, settlementReadyMinor: 12_500 };
    const request = { method: 'POST' as const, url: `/api/v1/admin/weekly-reports/${report.id}/revisions`,
      headers: headers('staff', 'DASHBOARD', 'm6:rpt:revision:1'),
      payload: { reportType: 'PLAYER', expectedRevision: 1, reason: 'MANUAL_CORRECTION', snapshot } };

    const created = await f.server.inject(request);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ data: { currentRevision: 2, metrics: snapshot,
      revisions: [{ revision: 2, reason: 'MANUAL_CORRECTION' }] } });
    const replay = await f.server.inject(request);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['x-idempotency-replayed']).toBe('true');
    expect((await f.store.get(report.id))?.revisions).toHaveLength(1);

    const stale = await f.server.inject({ ...request, headers: headers('staff', 'DASHBOARD', 'm6:rpt:revision:2') });
    expect(stale.statusCode).toBe(409);
    const mismatch = await f.server.inject({ ...request, headers: headers('staff', 'DASHBOARD', 'm6:rpt:revision:3'),
      payload: { reportType: 'SUMMARY', expectedRevision: 2, reason: 'WRONG_TARGET', snapshot: f.generated.summaryReport.metrics } });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ error: { code: 'REPORT_TYPE_MISMATCH' } });
  });

  test('requires weekly_report.manage at L3 and a recent step-up', async () => {
    const l2 = await fixture({ level: 'L2_SUPERVISOR' });
    const report = l2.generated.playerReports[0]!;
    const payload = { reportType: 'PLAYER', expectedRevision: 1, reason: 'CORRECTION', snapshot: report.metrics };
    expect((await l2.server.inject({ method: 'POST', url: `/api/v1/admin/weekly-reports/${report.id}/revisions`,
      headers: headers('staff', 'DASHBOARD', 'm6:rpt:l2:denied:0001'), payload })).statusCode).toBe(403);

    const noStepUp = await fixture({ stepUp: false });
    expect((await noStepUp.server.inject({ method: 'POST', url: `/api/v1/admin/weekly-reports/${noStepUp.generated.playerReports[0]!.id}/revisions`,
      headers: headers('staff', 'DASHBOARD', 'm6:rpt:no-step-up:0001'), payload })).statusCode).toBe(428);
  });

  test('resolves the current Discord player and never reveals another report existence', async () => {
    const f = await fixture();
    const own = f.generated.playerReports.find((report) => report.playerUserId === playerA)!;
    const other = f.generated.playerReports.find((report) => report.playerUserId === playerB)!;
    const list = await f.server.inject({ method: 'GET', url: '/api/v1/players/me/weekly-reports', headers: headers('player-a', 'DISCORD_BOT') });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.items.map((item: { id: string }) => item.id)).toEqual([own.id]);

    const forbidden = await f.server.inject({ method: 'GET', url: `/api/v1/players/me/weekly-reports/${other.id}`, headers: headers('player-a', 'DISCORD_BOT') });
    const missing = await f.server.inject({ method: 'GET', url: '/api/v1/players/me/weekly-reports/00000000-0000-0000-0000-000000009999', headers: headers('player-a', 'DISCORD_BOT') });
    expect(forbidden.statusCode).toBe(404);
    expect(forbidden.json().error).toEqual(missing.json().error);
    expect(JSON.stringify(forbidden.json())).not.toContain(playerB);
  });
});
