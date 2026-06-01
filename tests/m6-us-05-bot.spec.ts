import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import {
  HttpBotApiClient,
  buildCurrentUserProfileMessage,
  buildCurrentUserOrdersMessage,
  buildCurrentUserConsumptionsMessage,
  buildCurrentPlayerWeeklyReportListMessage,
  buildCurrentPlayerWeeklyReportDetailMessage,
  parseServiceCenterCustomId,
  type BotActorContext
} from '@blackcat/bot/service-center';
import { toDiscordReply } from '../apps/bot/src/discord-renderer';

const actor: BotActorContext = { guildId: '900000000000006500', discordUserId: '900000000000006501', interactionId: '900000000000006509', clientSource: 'DISCORD_BOT' };
const balance = { ledgerBalanceMinor: 8_000, reservedMinor: 3_000, availableMinor: 5_000, currency: 'CAT' as const, calculatedAt: '2026-07-19T20:00:00.000Z', version: 1 };

describe('M6-US-05 Sapphire private profiles and reports', () => {
  test('keeps the API client thin and sends only actor context plus cursor/report ID', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { items: [], nextCursor: null } }) });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBotApiClient({ apiBaseUrl: 'https://api.example.test/', botServiceToken: 'bot-token' });
    await client.getCurrentUserProfileSummary(actor);
    await client.listCurrentUserOrders(actor, 'orders-cursor', 5);
    await client.listCurrentUserConsumptions(actor, 'spend-cursor', 5);
    await client.listCurrentPlayerWeeklyReports(actor, 'report-cursor', 5);
    await client.getCurrentPlayerWeeklyReport('00000000-0000-0000-0000-000000006550', actor);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.test/api/v1/me/profile',
      'https://api.example.test/api/v1/me/orders?cursor=orders-cursor&limit=5',
      'https://api.example.test/api/v1/me/consumptions?cursor=spend-cursor&limit=5',
      'https://api.example.test/api/v1/players/me/weekly-reports?cursor=report-cursor&limit=5',
      'https://api.example.test/api/v1/players/me/weekly-reports/00000000-0000-0000-0000-000000006550'
    ]);
    for (const [, init] of fetchMock.mock.calls) expect(init.headers).toMatchObject({ 'x-client-source': 'DISCORD_BOT', 'x-actor-discord-user-id': actor.discordUserId, 'x-actor-guild-id': actor.guildId });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/userId|playerId/u);
  });

  test('renders the internal wallet, refresh, orders and consumptions as ephemeral panels', () => {
    const profile = buildCurrentUserProfileMessage({ user: { userId: 'u', discordUserId: actor.discordUserId, displayName: '客户甲', status: 'ACTIVE' },
      balance, statistics: { orderCount: 2, activeOrderCount: 1, orderSpendMinor: 20_000, giftSpendMinor: 2_000, totalConsumptionMinor: 22_000, currency: 'CAT' },
      activeReservationCount: 1 });
    expect(profile.visibility).toBe('EPHEMERAL');
    expect(profile.body).toMatch(/账本余额.*预留.*可用/su);
    const rendered = toDiscordReply(profile);
    expect(JSON.stringify(rendered.components)).not.toMatch(/https?:\/\/|LINK/u);
    expect(JSON.stringify(profile)).toContain('bc:profile:refresh');
    expect(JSON.stringify(profile)).toContain('bc:profile:orders:first');
    expect(JSON.stringify(profile)).toContain('bc:profile:consumptions:first');

    const signedCursor = `c1_${'A'.repeat(56)}`;
    const orders = buildCurrentUserOrdersMessage({ items: [{ id: 'o1', publicId: 'P-1', status: 'COMPLETED', gameKey: 'VALORANT', serviceKey: 'RANKED',
      playerDisplayName: null, amountMinor: 10_000, currency: 'CAT', createdAt: '2026-07-19T18:00:00.000Z', completedAt: '2026-07-19T19:00:00.000Z' }], nextCursor: signedCursor });
    const spend = buildCurrentUserConsumptionsMessage({ items: [{ id: 'c1', type: 'GIFT', sourceId: 'g1', amountMinor: 2_000, currency: 'CAT', status: 'SUCCEEDED', targetDisplay: '礼物', occurredAt: '2026-07-19T18:00:00.000Z', reversalOf: null }], nextCursor: signedCursor });
    expect(JSON.stringify(orders)).toContain(`bc:profile:orders:${signedCursor}`);
    expect(JSON.stringify(spend)).toContain(`bc:profile:consumptions:${signedCursor}`);
    expect(orders.visibility).toBe('EPHEMERAL');
    expect(spend.visibility).toBe('EPHEMERAL');
    const bounded = buildCurrentUserOrdersMessage({ ...orders, items: [], nextCursor: signedCursor } as any);
    const nextId = (bounded.components[0]!.components[1] as any).customId;
    expect(nextId.length).toBeLessThanOrEqual(100);
    expect(parseServiceCenterCustomId(nextId)).toMatchObject({ area: 'profile', action: 'orders', cursor: signedCursor });
    expect(parseServiceCenterCustomId('bc:profile:orders:t_missingtoken123')).toEqual({ area: 'unknown' });
  });

  test('renders only current-player report list/detail with stable private pagination IDs', () => {
    const report = { id: '00000000-0000-0000-0000-000000006550', reportType: 'PLAYER' as const, periodStart: '2026-07-12T16:00:00.000Z', periodEnd: '2026-07-19T16:00:00.000Z',
      timeZone: 'Asia/Shanghai', currency: 'CAT', status: 'READY', currentRevision: 1, metrics: { completedOrderCount: 3, cancelledOrderCount: 1, serviceMinutes: 180,
        orderEarningMinor: 12_000, giftEarningMinor: 1_000, adjustmentMinor: 0, pendingMinor: 2_000, settlementReadyMinor: 11_000, batchedMinor: 0 }, detailSnapshot: {} };
    const signedCursor = `c1_${'B'.repeat(31)}`;
    const list = buildCurrentPlayerWeeklyReportListMessage({ items: [report], nextCursor: signedCursor });
    const detail = buildCurrentPlayerWeeklyReportDetailMessage(report);
    expect(list.visibility).toBe('EPHEMERAL');
    expect(detail.visibility).toBe('EPHEMERAL');
    expect(JSON.stringify(list)).toContain(`bc:reports:detail:${report.id}`);
    expect(JSON.stringify(list)).toContain(`bc:reports:list:${signedCursor}`);
    expect(detail.body).toMatch(/待确认.*可结算/su);
    expect(JSON.stringify(detail).toLowerCase()).not.toMatch(/referral|beneficiary|commission|profit|margin/u);
  });

  test('parses stable routes and keeps every button-handler response ephemeral with request-id fallback', async () => {
    expect(parseServiceCenterCustomId('bc:profile:refresh')).toEqual({ area: 'profile', action: 'refresh' });
    expect(parseServiceCenterCustomId('bc:reports:list:first')).toEqual({ area: 'reports', action: 'list', cursor: undefined });
    const source = await readFile('apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts', 'utf8');
    const serviceCenter = await readFile('apps/bot/src/service-center.ts', 'utf8');
    expect(source).toContain('getCurrentUserProfileSummary');
    expect(source).toContain('listCurrentPlayerWeeklyReports');
    expect(source).toContain('getCurrentPlayerWeeklyReport');
    expect(source).toMatch(/request_id/u);
    expect(source).not.toMatch(/ephemeral:\s*false|createChannel|guild\.channels\.create/u);
    expect(serviceCenter).not.toMatch(/componentCursorRegistry|new Map<string, string>|createHash\('sha256'\)\.update\(cursor\)/u);
  });
});
