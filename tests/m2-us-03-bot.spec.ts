import { describe, expect, test } from 'vitest';
import { buildAcceptedPlayerChannelPermissionPlan, buildDispatchIneligibleReply } from '@blackcat/bot/service-center';

describe('M2-US-03 Bot accepted dispatch channel sync', () => {
  test('builds a minimal permission plan that adds only the accepted player to the private order channel', () => {
    const plan = buildAcceptedPlayerChannelPermissionPlan({
      channelId: '444444444444444444',
      acceptedPlayerDiscordUserId: '222222222222222222',
      rejectedCandidateDiscordUserIds: ['222222222222222223', '222222222222222224']
    });

    expect(plan.channelId).toBe('444444444444444444');
    expect(plan.permissionOverwrites).toEqual([
      {
        id: '222222222222222222',
        kind: 'MEMBER',
        allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
        deny: []
      }
    ]);
    expect(JSON.stringify(plan)).not.toContain('222222222222222223');
    expect(JSON.stringify(plan)).not.toContain('222222222222222224');
  });

  test('explains the trusted workbench eligibility failures instead of returning a generic accept error', () => {
    const message = buildDispatchIneligibleReply(
      {
        profile: {
          playerId: '00000000-0000-0000-0000-00000000a301',
          reviewStatus: 'ACTIVE',
          availability: 'OFFLINE',
          discordPresence: 'UNKNOWN',
          gameTags: ['VALORANT'],
          serviceTags: ['FUN'],
          activeOrderId: null,
          version: 4
        },
        eligibility: {
          eligible: false,
          evaluatedAt: '2026-08-05T03:36:44.809Z',
          checks: [
            { code: 'DISCORD_ONLINE', passed: false, reason: 'discordPresence is UNKNOWN' },
            { code: 'AVAILABLE', passed: false, reason: 'availability is OFFLINE' }
          ]
        },
        currentOrder: null,
        matchingOrders: [],
        earningsSummary: {
          pendingMinor: 0,
          confirmedMinor: 0,
          paidMinor: 0,
          currency: 'CAT',
          calculatedAt: '2026-08-05T03:36:44.809Z'
        },
        nextActions: ['SET_AVAILABLE']
      },
      'req_70759ca4-1bfe-4e58-9c04-3711d74b01b7'
    );

    expect(message).toContain('Discord 当前未在线');
    expect(message).toContain('旧 availability 仅供诊断，不影响报名');
    expect(message).toContain('陪玩工作台');
    expect(message).toContain('req_70759ca4-1bfe-4e58-9c04-3711d74b01b7');
    expect(message).not.toContain('discordPresence is UNKNOWN');
  });
});
