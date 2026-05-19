import { describe, expect, test } from 'vitest';
import { buildGiftPanel, buildGiftRequestConfirmation } from '@blackcat/bot/gifts';

describe('M3-US-01 Discord gift panel', () => {
  test('renders API affordability and recharge action without accepting a receiver input', () => {
    const panel = buildGiftPanel({
      orderId: 'order-1', orderPublicId: 'P-1', receiver: { userId: 'player-1', displayName: '阿岚' },
      balance: { providerBalanceMinor: 5000, reservedMinor: 3000, availableMinor: 2000, currency: 'CNY', fetchedAt: '2026-07-18T12:00:00.000Z' },
      items: [
        { id: 'gift-18', code: 'SMALL', name: '小心意', version: 1, priceMinor: 1800, currency: 'CNY', affordable: true },
        { id: 'gift-88', code: 'BOX', name: '礼盒', version: 1, priceMinor: 8800, currency: 'CNY', affordable: false }
      ]
    });
    expect(panel.targetLabel).toBe('阿岚');
    expect(panel.options).toEqual([
      expect.objectContaining({ value: 'gift-18', disabled: false }),
      expect.objectContaining({ value: 'gift-88', disabled: false })
    ]);
    expect(panel.actions).toContain('RECHARGE');
    expect(panel).not.toHaveProperty('receiverInput');
  });

  test('confirms that funds are reserved and staff review is pending', () => {
    expect(buildGiftRequestConfirmation({
      id: 'request-1', publicId: 'G-1', orderId: 'order-1', senderId: 'user-1', receiverId: 'player-1',
      status: 'PENDING_REVIEW', expiresAt: '2026-07-18T12:30:00.000Z',
      gift: { code: 'SMALL', name: '小心意', priceMinor: 1800, currency: 'CNY' },
      reservation: { id: 'reservation-1', sourceType: 'GIFT', status: 'ACTIVE', amountMinor: 1800, currency: 'CNY', expiresAt: '2026-07-18T12:30:00.000Z' },
      staffTask: { id: 'task-1', publicId: 'T-1', type: 'GIFT_REVIEW', status: 'OPEN' },
      balance: { providerBalanceMinor: 5000, reservedMinor: 4800, availableMinor: 200, currency: 'CNY', fetchedAt: '2026-07-18T12:00:00.000Z' }
    })).toMatchObject({ title: '送礼请求已提交', statusLabel: '等待客服核对', reservedMinor: 1800, capturedMinor: 0 });
  });
});
