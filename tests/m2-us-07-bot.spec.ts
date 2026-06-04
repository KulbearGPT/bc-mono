import { describe, expect, test } from 'vitest';
import { buildMatchingProgressMessage, buildOrderPanelMessage, type OrderSummary } from '@blackcat/bot/service-center';

describe('M2-US-07 Discord matching progress rendering', () => {
  test('renders notified count, timeout and next step without candidate identities', () => {
    const message = buildMatchingProgressMessage(order({
      matching: {
        stage: 'WAITING_FOR_ACCEPTANCE',
        notifiedCandidateCount: 3,
        timeoutAt: '2026-07-18T08:05:00.000Z',
        nextStep: 'WAIT_FOR_PLAYER',
        playerSummary: null
      }
    }));

    expect(message.title).toContain('正在匹配陪玩');
    expect(message.body).toContain('已通知符合条件的陪玩：3 人');
    expect(message.body).toContain('本轮截止：2026-07-18T08:05:00.000Z');
    expect(message.body).not.toContain('candidate');
  });

  test('renders the accepted player and readiness action', () => {
    const message = buildMatchingProgressMessage(order({
      status: 'ACCEPTED',
      matching: {
        stage: 'ACCEPTED',
        notifiedCandidateCount: 3,
        timeoutAt: null,
        nextStep: 'CONFIRM_READINESS',
        playerSummary: {
          playerId: '00000000-0000-0000-0000-00000000a702',
          displayName: '陪玩小陈'
        }
      }
    }));

    expect(message.body).toContain('接单陪玩：陪玩小陈');
    expect(message.body).toContain('下一步：请确认已准备好开始服务');
  });

  test('the normal order panel routes matching states to the progress view', () => {
    const message = buildOrderPanelMessage(order({
      matching: {
        stage: 'SEARCHING',
        notifiedCandidateCount: 0,
        timeoutAt: null,
        nextStep: 'WAIT_FOR_PLAYER',
        playerSummary: null
      }
    }));
    expect(message.title).toContain('正在匹配陪玩');
    expect(message.components.flatMap((row) => row.components).some((component) => component.type === 'SELECT')).toBe(false);
    expect(message.components.flatMap((row) => row.components)).toEqual(expect.arrayContaining([
      expect.objectContaining({label:'取消订单'}), expect.objectContaining({label:'我要申诉'})
    ]));
  });
});

function order(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: '00000000-0000-0000-0000-00000000b701',
    publicId: 'P-M2-MATCH',
    status: 'PENDING_DISPATCH',
    version: 3,
    game: 'VALORANT',
    service: 'ENTERTAINMENT',
    region: 'NA',
    billingUnitMinutes: 60,
    unitCount: 2,
    amountMinor: 12000,
    currency: 'CAT',
    notes: null,
    channelSpec: { channelId: '120000000000000001', panelMessageId: '120000000000000002', voiceChannelId: null },
    matching: null,
    ...overrides
  };
}
