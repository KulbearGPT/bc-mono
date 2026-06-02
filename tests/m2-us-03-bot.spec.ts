import { describe, expect, test } from 'vitest';
import {
  buildAcceptedDispatchMessage,
  buildAcceptedPlayerChannelPermissionPlan,
  type DispatchOfferSummary
} from '@blackcat/bot/service-center';

const offer: DispatchOfferSummary = {
  dispatchAttemptId: '00000000-0000-0000-0000-00000000d301',
  orderId: '00000000-0000-0000-0000-00000000b301',
  orderPublicId: 'P-3001',
  orderVersion: 3,
  game: 'VALORANT',
  service: 'ENTERTAINMENT',
  region: 'NA',
  durationLabel: '2 小时',
  playerEarningMinor: 8400,
  currency: 'CAT',
  notes: '中文交流',
  expiresAt: '2026-07-18T02:05:00.000Z',
  voiceChannelId: '666666666666666666'
};

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

  test('renders accepted dispatch card with disabled race buttons', () => {
    const message = buildAcceptedDispatchMessage({
      offer,
      acceptedPlayerDisplayName: '陪玩阿岚'
    });

    expect(message.title).toBe('订单 #P-3001 已被接取');
    expect(message.body).toContain('陪玩阿岚');
    expect(message.components[0]?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '已接单', disabled: true }),
        expect.objectContaining({ label: '本轮已结束', disabled: true })
      ])
    );
  });
});
