import { describe, expect, test } from 'vitest';
import { buildOrderPanelMessage, buildServiceCenterMessage, type OrderSummary } from '@blackcat/bot/service-center';

describe('M2-US-11 Discord paused automation state', () => {
  test('shows staff takeover and removes controls that advance automation', () => {
    const order = pausedOrder();
    const message = buildOrderPanelMessage(order);
    const controls = message.components.flatMap((row) => row.components);

    expect(message.title).toContain('客服处理中');
    expect(message.body).toContain('自动派单和超时处理已暂停');
    expect(message.body).not.toContain('内部');
    expect(controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'BUTTON', label: '联系客服' }),
      expect.objectContaining({ type: 'BUTTON', label: '查看取消影响' })
    ]));
    expect(controls.some((control) => control.type === 'SELECT')).toBe(false);
    expect(controls.some((control) => control.type === 'BUTTON' && control.label === '确认订单')).toBe(false);
  });

  test('marks the active order as staff-managed in the private service center', () => {
    const message = buildServiceCenterMessage({
      currentUser: {
        user: { id: 'u1', displayName: '用户小林', status: 'ACTIVE', externalAccountDisplay: null, activeOrderId: pausedOrder().id, riskFlags: [], version: 1 },
        activeOrderId: pausedOrder().id,
        consumptionSummary: { totalMinor: 0, currency: 'CAT' },
        commissionSummary: { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: 'CAT' }
      },
      balance: { ledgerBalanceMinor: 20000, reservedMinor: 12000, availableMinor: 8000, currency: 'CAT', calculatedAt: '2026-07-18T09:00:00.000Z' },
      activeOrder: pausedOrder(), consumptions: { items: [], nextCursor: null },
      commissions: { summary: { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: 'CAT' }, items: [], nextCursor: null }
    });
    expect(message.body).toContain('客服处理中');
  });
});

function pausedOrder(): OrderSummary {
  return {
    id: '00000000-0000-0000-0000-00000000b611', publicId: 'P-611', status: 'PENDING_DISPATCH', version: 4,
    game: 'VALORANT', service: 'ENTERTAINMENT', region: 'NA', billingUnitMinutes: 60, unitCount: 2,
    amountMinor: 12000, currency: 'CAT', notes: null,
    channelSpec: { channelId: '444444444444444444', panelMessageId: '555555555555555555', voiceChannelId: null },
    matching: { stage: 'WAITING_FOR_ACCEPTANCE', notifiedCandidateCount: 3, timeoutAt: '2026-07-18T09:05:00.000Z', nextStep: 'WAIT_FOR_PLAYER', playerSummary: null },
    automation: { state: 'PAUSED', reasonCode: 'STAFF_TAKEOVER', expiresAt: '2026-07-18T09:30:00.000Z' }
  };
}
