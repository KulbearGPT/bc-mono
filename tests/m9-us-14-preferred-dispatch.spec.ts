import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { prioritizeDispatchCandidates } from '@blackcat/api/dispatch';
import type { PlayerProfileRecord } from '@blackcat/api/players';

function player(userId: string, discordUserId: string): PlayerProfileRecord {
  return {
    playerId: `profile-${userId}`,
    userId,
    guildId: '1533309755873955880',
    discordUserId,
    userStatus: 'ACTIVE',
    reviewStatus: 'ACTIVE',
    availability: 'AVAILABLE',
    discordPresence: 'ONLINE',
    presenceObservedAt: '2026-08-03T00:00:00Z',
    gameTags: ['VALORANT'],
    serviceTags: ['FUN'],
    activeOrderId: null,
    approvedByStaffId: null,
    approvedAt: null,
    pausedAt: null,
    suspendedAt: null,
    version: 1,
    createdAt: '2026-08-03T00:00:00Z',
    updatedAt: '2026-08-03T00:00:00Z'
  };
}

describe('M9-US-14 customer preferred dispatch list', () => {
  test('gives up to three eligible preferred players the first-round exclusive window', () => {
    const ordinary = player('00000000-0000-0000-0000-000000000001', '111111111111111111');
    const preferredA = player('00000000-0000-0000-0000-000000000002', '222222222222222222');
    const preferredB = player('00000000-0000-0000-0000-000000000003', '333333333333333333');
    expect(
      prioritizeDispatchCandidates(
        [ordinary, preferredB, preferredA],
        [preferredA.discordUserId, preferredB.discordUserId],
        'ORDER_SUBMITTED'
      )
    ).toEqual([preferredA, preferredB]);
  });

  test('falls back immediately when no preference is eligible and uses the normal pool on retry', () => {
    const ordinary = player('00000000-0000-0000-0000-000000000001', '111111111111111111');
    expect(prioritizeDispatchCandidates([ordinary], ['999999999999999999'], 'ORDER_SUBMITTED')).toEqual([ordinary]);
    expect(prioritizeDispatchCandidates([ordinary], ['999999999999999999'], 'TIMEOUT_RETRY')).toEqual([ordinary]);
  });

  test('API keeps the restart-safe preference snapshot while the prototype-aligned wizard omits the legacy selector', async () => {
    const [orderPanels, orderRequirements, renderer, orders] = await Promise.all([
      readFile('apps/bot/src/service-center-order-panels.ts', 'utf8'),
      readFile('apps/bot/src/service-center-order-requirements.ts', 'utf8'),
      readFile('apps/bot/src/discord-renderer.ts', 'utf8'),
      readFile('apps/api/src/orders.ts', 'utf8')
    ]);
    const currentWizard = orderPanels.slice(
      orderPanels.indexOf('export function buildMultiProjectOrderPanelMessage'),
      orderPanels.indexOf('export function buildGamePickerMessage')
    );
    expect(currentWizard).not.toContain('preferred-players');
    expect(orderRequirements).toMatch(/field\s*===\s*'preferred-players'/u);
    expect(renderer).toContain('UserSelectMenuBuilder');
    expect(orders).toContain('preferredPlayerDiscordUserIds');
    expect(orders).toMatch(/requirement_snapshot = \$[1-9][0-9]*::jsonb/u);
    expect(orders).toContain('preferredPlayerIdsFromSnapshot');
  });
});
