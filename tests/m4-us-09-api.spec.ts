import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryDashboardAuthStore } from '@blackcat/api/dashboard-auth';
import {
  InMemoryDashboardMetricsStore,
  calculateBusinessDayWindow,
  type DashboardMetricFacts
} from '@blackcat/api/dashboard-metrics';

const now = new Date('2026-07-18T16:30:00.000Z');
const facts: DashboardMetricFacts = {
  todayOrderCount: 12,
  inProgressOrderCount: 4,
  pendingStaffTaskCount: 3,
  completedOrderNetConsumptionMinor: 84_200,
  giftNetConsumptionMinor: 19_360,
  activeReservedMinor: 21_640,
  dispatchAcceptedCount: 11,
  dispatchStartedCount: 12,
  exceptionCount: 2
};

describe('M4-US-09 dashboard operating metrics', () => {
  test('freezes timezone, L1 nullable money, and basis points in both OpenAPI mirrors',()=>{
    const docs=readFileSync('docs/P0开发交付包/02-API/openapi.yaml','utf8');const output=readFileSync('outputs/P0开发交付包/02-API/openapi.yaml','utf8');
    expect(output).toBe(docs);expect(docs).toMatch(/DashboardSummaryEnvelope:[\s\S]*?required: \[windowStart, windowEnd, timeZone, currency, metrics\]/);
    expect(docs).toContain('dispatchSuccessRateBps: {type: integer, minimum: 0, maximum: 10000}');
    expect(docs).toMatch(/completedOrderNetConsumptionMinor: \{type: \[integer, 'null'\]/);
    expect(docs).not.toMatch(/DashboardSummaryEnvelope:[\s\S]*?dispatchSuccessRate: \{type: number/);
  });

  test('AT-MET-002 uses the Asia/Shanghai half-open business day', () => {
    expect(calculateBusinessDayWindow(now, 'Asia/Shanghai')).toEqual({
      windowStart: '2026-07-18T16:00:00.000Z',
      windowEnd: '2026-07-19T16:00:00.000Z'
    });
  });

  test('AT-MET-001 returns exactly eight metrics and integer basis points', async () => {
    const store = new InMemoryDashboardMetricsStore({ facts });
    const result = await store.getSummary({ actorStaffId: 'staff-l3', actorLevel: 'L3_OPERATIONS', guildId: 'guild-1', now, timeZone: 'Asia/Shanghai', currency: 'CNY' });
    expect(result).toMatchObject({ timeZone: 'Asia/Shanghai', currency: 'CNY', metrics: {
      todayOrderCount: 12, inProgressOrderCount: 4, pendingStaffTaskCount: 3,
      completedOrderNetConsumptionMinor: 84_200, giftNetConsumptionMinor: 19_360,
      activeReservedMinor: 21_640, dispatchSuccessRateBps: 9166, exceptionCount: 2
    }});
    expect(Object.keys(result.metrics)).toHaveLength(8);
  });

  test('returns zero success for no valid dispatch round and hides money from L1', async () => {
    const store = new InMemoryDashboardMetricsStore({ facts: { ...facts, dispatchAcceptedCount: 0, dispatchStartedCount: 0 } });
    const result = await store.getSummary({ actorStaffId: 'staff-l1', actorLevel: 'L1_SUPPORT', guildId: 'guild-1', now, timeZone: 'Asia/Shanghai', currency: 'CNY' });
    expect(result.metrics).toMatchObject({ dispatchSuccessRateBps: 0, completedOrderNetConsumptionMinor: null, giftNetConsumptionMinor: null, activeReservedMinor: null });
  });

  test('serves the same scoped summary to Dashboard and Sapphire Bot clients', async()=>{
    const account={staffId:'00000000-0000-0000-0000-000000009201',userId:'00000000-0000-0000-0000-000000009202',discordUserId:'900000000000009201',level:'L2_SUPERVISOR' as const,permissionsVersion:1,status:'ACTIVE' as const};
    const auth=new InMemoryDashboardAuthStore();const session=auth.createSession(account,now);
    const directory={resolveByDiscord:({discordUserId}:{discordUserId:string})=>discordUserId===account.discordUserId?account:null};
    const metricsStore=new InMemoryDashboardMetricsStore({facts});
    const server=buildApiServer({env:{NODE_ENV:'test',DATABASE_URL:'',API_PORT:'0',API_BASE_URL:'http://localhost:3000',BOT_SERVICE_TOKEN:'valid-bot-token'},security:{staffDirectory:directory,dashboardSessions:auth},dashboardAuth:{store:auth,oauth:{getAuthorizationUrl:()=>'',exchangeCode:async()=>({discordUserId:account.discordUserId})},staffDirectory:directory,guildId:'900000000000009000',dashboardUrl:'http://localhost:5173',now:()=>now},dashboardMetrics:{store:metricsStore,timeZone:'Asia/Shanghai',currency:'CNY'}});
    const [dashboard,bot]=await Promise.all([
      server.inject({method:'GET',url:'/api/v1/admin/dashboard/summary',headers:{cookie:`p0_session=${session.sessionToken}`,'x-client-source':'DASHBOARD'}}),
      server.inject({method:'GET',url:'/api/v1/admin/dashboard/summary',headers:{authorization:'Bearer valid-bot-token','x-client-source':'DISCORD_BOT','x-actor-discord-user-id':account.discordUserId,'x-actor-guild-id':'900000000000009000','x-discord-interaction-id':'900000000000009999'}})
    ]);
    expect(dashboard.statusCode).toBe(200);expect(bot.statusCode).toBe(200);
    expect(bot.json().data).toEqual(dashboard.json().data);
    expect(bot.json().data.metrics.dispatchSuccessRateBps).toBe(9166);
  });
});
