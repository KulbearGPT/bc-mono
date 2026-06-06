import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { selectManualDispatchCandidates } from '@blackcat/api/dispatch';
import { buildAdminActionRequest, buildAdminBusinessPage } from '@blackcat/dashboard/admin-business';
import type { PlayerProfileRecord } from '@blackcat/api/players';
import { hasStaffPermission } from '@blackcat/api/authorization-policy';

function player(userId: string, discordUserId: string): PlayerProfileRecord {
  return {
    playerId: `profile-${userId}`, userId, guildId: '1533309755873955880', discordUserId,
    userStatus: 'ACTIVE', reviewStatus: 'ACTIVE', availability: 'AVAILABLE', discordPresence: 'ONLINE',
    presenceObservedAt: '2026-08-03T00:00:00Z', gameTags: ['VALORANT'], serviceTags: ['FUN'],
    activeOrderId: null, approvedByStaffId: null, approvedAt: null, pausedAt: null, suspendedAt: null,
    version: 1, createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z'
  };
}

describe('M9-US-16 staff targeted dispatch', () => {
  test('selects only requested eligible players and never falls back for an invalid explicit selection', () => {
    const first = player('00000000-0000-0000-0000-000000000001', '111111111111111111');
    const second = player('00000000-0000-0000-0000-000000000002', '222222222222222222');
    expect(selectManualDispatchCandidates([first, second], [second.discordUserId])).toEqual([second]);
    expect(() => selectManualDispatchCandidates([first], ['999999999999999999'])).toThrow('selected player');
    expect(() => selectManualDispatchCandidates([first], [first.discordUserId, first.discordUserId])).toThrow('duplicate');
    expect(() => selectManualDispatchCandidates([first], ['1', '2', '3', '4'])).toThrow('three');
    expect(selectManualDispatchCandidates([], [])).toEqual([]);
  });

  test('exposes staff dispatch to L2+ and maps selected targets into the dashboard request', () => {
    expect(hasStaffPermission('L1_SUPPORT', 'dispatch.manual')).toBe(false);
    expect(hasStaffPermission('L2_SUPERVISOR', 'dispatch.manual')).toBe(true);
    expect(hasStaffPermission('L3_OPERATIONS', 'dispatch.manual')).toBe(true);
    expect(hasStaffPermission('L4_ADMIN_OWNER', 'dispatch.manual')).toBe(true);
    expect(hasStaffPermission('L2_SUPERVISOR', 'dispatch.execute')).toBe(false);
    const page = buildAdminBusinessPage({ page: 'orders', permissions: ['order.read', 'dispatch.manual'], status: 'READY', items: [] });
    expect(page.actions).toContainEqual(expect.objectContaining({ id: 'MANUAL_DISPATCH' }));
    expect(buildAdminActionRequest({ actionId: 'MANUAL_DISPATCH', item: { id: 'order-1', version: 7 }, fields: { targetDiscordUserIds: '111111111111111111,222222222222222222' } })).toEqual({
      method: 'POST', path: '/api/v1/admin/orders/order-1/manual-dispatch',
      body: { expectedVersion: 7, trigger: 'MANUAL_RETRY', targetDiscordUserIds: ['111111111111111111', '222222222222222222'] }
    });
  });

  test('keeps automatic dispatch privileged separately and provides a dashboard candidate endpoint', async () => {
    const [policy, route, dashboard] = await Promise.all([
      readFile('apps/api/src/authorization-policy.ts', 'utf8'),
      readFile('apps/api/src/dispatch.ts', 'utf8'),
      readFile('apps/dashboard/src/AdminBusinessRoute.tsx', 'utf8')
    ]);
    expect(policy).toContain("L2_SUPERVISOR: ['staff_task.resolve', 'dispatch.manual'");
    expect(route).toContain("url: '/api/v1/orders/:orderId/dispatch-candidates'");
    expect(route).toContain("permission: 'dispatch.manual'");
    expect(dashboard).toContain('dispatch-candidates');
  });
});
