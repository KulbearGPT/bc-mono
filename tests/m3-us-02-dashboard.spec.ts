import { describe, expect, test } from 'vitest';
import { buildGiftReviewCard } from '@blackcat/dashboard/gift-review';

describe('M3-US-02 support gift review card', () => {
  test('shows reservation and communication links while keeping L1 to verification only', () => {
    const card = buildGiftReviewCard({
      request: { publicId: 'G-3410', status: 'PENDING_REVIEW', version: 1, senderDisplay: '小林', receiverDisplay: '阿岚',
        giftName: '星光礼盒', priceMinor: 200000, currency: 'CNY', expiresAt: '2026-07-18T13:30:00.000Z' },
      reservation: { status: 'ACTIVE', amountMinor: 200000, expiresAt: '2026-07-18T13:30:00.000Z' },
      task: { id: 'task-1', status: 'CLAIMED', claimedByCurrentStaff: true, guildId: '999', channelId: '123', voiceChannelId: '456' },
      staffLevel: 'L1_SUPPORT'
    });
    expect(card).toMatchObject({ reservationLabel: '金额已预留', requiredLevel: 'L2_SUPERVISOR',
      links: { orderChannel: expect.stringContaining('/123'), voiceChannel: expect.stringContaining('/456') } });
    expect(card.actions).toEqual([
      { id: 'VERIFY', enabled: true }, { id: 'APPROVE', enabled: false },
      { id: 'REJECT', enabled: false }, { id: 'ESCALATE', enabled: false }
    ]);
  });

  test('routes a verified 200100 gift to escalation for L2', () => {
    const card = buildGiftReviewCard({
      request: { publicId: 'G-3411', status: 'PENDING_REVIEW', version: 2, senderDisplay: '小林', receiverDisplay: '阿岚',
        giftName: '星光礼盒', priceMinor: 200100, currency: 'CNY', expiresAt: '2026-07-18T13:30:00.000Z' },
      reservation: { status: 'ACTIVE', amountMinor: 200100, expiresAt: '2026-07-18T13:30:00.000Z' },
      task: { id: 'task-2', status: 'VERIFIED', claimedByCurrentStaff: true, guildId: '999', channelId: '123', voiceChannelId: null },
      staffLevel: 'L2_SUPERVISOR'
    });
    expect(card.requiredLevel).toBe('L3_OPERATIONS');
    expect(card.actions.find((action) => action.id === 'ESCALATE')).toEqual({ id: 'ESCALATE', enabled: true });
    expect(card.links.voiceChannel).toBeNull();
  });
});
