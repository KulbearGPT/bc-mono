import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildApiServer } from '@blackcat/api/server';
import { buildCapabilities } from '@blackcat/api/dashboard-auth';
import { canGrantRole, hasStaffPermission, requiredLevelForAmount, resolveStaffPolicy } from '@blackcat/api/authorization-policy';
import { InMemoryAuditSink, InMemoryIdempotencyStore, registerSecureReadRoute, type StaffLevel } from '@blackcat/api/security';

const levels: StaffLevel[] = ['L1_SUPPORT', 'L2_SUPERVISOR', 'L3_OPERATIONS', 'L4_ADMIN_OWNER'];
const guildId = '900000000000007000';

describe('M4-US-07 cumulative authorization policy', () => {
  test('AT-RBAC-010 cumulatively inherits lower-level capabilities from one resolver', async () => {
    const capabilities = await Promise.all(levels.map((level, index) => buildCapabilities(`staff-${index}`, level, 1)));

    for (let index = 1; index < capabilities.length; index += 1) {
      expect(capabilities[index]!.permissions).toEqual(expect.arrayContaining(capabilities[index - 1]!.permissions));
    }
    expect(resolveStaffPolicy('L2_SUPERVISOR')).toMatchObject({ scope: 'TEAM', referralVisibility: 'REDACTED' });
    expect(resolveStaffPolicy('L3_OPERATIONS')).toMatchObject({ scope: 'BUSINESS', referralVisibility: 'CONFIDENTIAL' });
    expect(hasStaffPermission('L4_ADMIN_OWNER', 'staff_task.claim')).toBe(true);
    expect(hasStaffPermission('L1_SUPPORT', 'access.manage')).toBe(false);
  });

  test('uses identical API authorization for Bot and Dashboard actors and audits both denials', async () => {
    const audit = new InMemoryAuditSink();
    const accounts = levels.map((level, index) => ({
      staffId: `00000000-0000-0000-0000-00000000710${index}`,
      userId: `00000000-0000-0000-0000-00000000720${index}`,
      discordUserId: `90000000000000710${index}`,
      level,
      permissionsVersion: 1,
      status: 'ACTIVE' as const
    }));
    const server = buildApiServer({
      env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
      security: {
        auditSink: audit,
        idempotencyStore: new InMemoryIdempotencyStore(),
        staffDirectory: { resolveByDiscord: ({ discordUserId }) => accounts.find((item) => item.discordUserId === discordUserId) ?? null },
        dashboardSessions: {
          resolve: (token) => {
            const found = accounts.find((item) => token === `session-${item.level}`);
            return found ? { ok: true as const, staff: found, csrfToken: 'csrf' } : { ok: false as const, reason: 'AUTH_REQUIRED' as const };
          },
          verifyCsrf: () => true,
          verifyRecentStepUp: () => true
        }
      }
    });
    registerSecureReadRoute(server, server.securityOptions!, {
      method: 'GET', url: '/test/l2-operation', permission: 'refund.execute', action: 'TEST_L2_OPERATION', targetType: 'policy_test',
      acceptedSources: ['DISCORD_BOT', 'DASHBOARD'], handler: (_request, actor) => ({ actorStaffId: actor.actorStaffId })
    });

    const l3 = accounts[2]!;
    const bot = await server.inject({ method: 'GET', url: '/test/l2-operation', headers: {
      authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT', 'x-actor-discord-user-id': l3.discordUserId,
      'x-actor-guild-id': guildId, 'x-discord-interaction-id': '900000000000007999'
    } });
    const dashboard = await server.inject({ method: 'GET', url: '/test/l2-operation', headers: {
      cookie: `p0_session=session-${l3.level}; p0_csrf=csrf`, 'x-client-source': 'DASHBOARD'
    } });
    expect(bot.statusCode).toBe(200);
    expect(dashboard.statusCode).toBe(200);
    expect(bot.json().data).toEqual(dashboard.json().data);

    const l1 = accounts[0]!;
    const deniedBot = await server.inject({ method: 'GET', url: '/test/l2-operation', headers: {
      authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT', 'x-actor-discord-user-id': l1.discordUserId,
      'x-actor-guild-id': guildId, 'x-discord-interaction-id': '900000000000007998'
    } });
    const deniedDashboard = await server.inject({ method: 'GET', url: '/test/l2-operation', headers: {
      cookie: `p0_session=session-${l1.level}; p0_csrf=csrf`, 'x-client-source': 'DASHBOARD'
    } });
    expect([deniedBot.statusCode, deniedDashboard.statusCode]).toEqual([403, 403]);
    expect(audit.records.filter((record) => record.action === 'TEST_L2_OPERATION' && record.outcome === 'REJECTED')).toHaveLength(2);
  });

  test('AT-RBAC-009/011 keeps hard delete absent and allows one stepped-up L4 to execute high-value work', async () => {
    expect(requiredLevelForAmount(499_999, { l2LimitMinor: 50_000, l4FromMinor: 500_000 })).toBe('L3_OPERATIONS');
    expect(requiredLevelForAmount(500_000, { l2LimitMinor: 50_000, l4FromMinor: 500_000 })).toBe('L4_ADMIN_OWNER');
    expect(canGrantRole('L3_OPERATIONS', 'L3_OPERATIONS')).toBe(false);
    expect(canGrantRole('L4_ADMIN_OWNER', 'L4_ADMIN_OWNER')).toBe(true);
    expect(resolveStaffPolicy('L4_ADMIN_OWNER').destructiveActions).toEqual([]);

    const contract = await readFile('docs/P0开发交付包/02-API/openapi.yaml', 'utf8');
    expect(contract).not.toMatch(/deleteAudit|deleteCommission|deleteEarning|deleteRefund|deleteTransaction|deleteGift|deleteOrder/);
  });
});
