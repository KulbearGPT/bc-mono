import { describe, expect, test } from 'vitest';
import { BotApiError } from '@blackcat/bot/service-center-api';
import { buildGiftAffordabilityMessage, buildGiftRequestMessage, type GiftRequestResult } from '@blackcat/bot/gifts';
import {
  buildCancellationPreviewMessage,
  buildCancellationResultMessage,
  buildSupportRatingMessage
} from '@blackcat/bot/service-center';
import { formatUserFacingError } from '@blackcat/bot/user-facing-error';

describe('M18-US-07 support and high-risk experience', () => {
  test('celebrates a submitted gift request without claiming that the gift was charged', () => {
    const message = buildGiftRequestMessage(giftRequest());

    expect(message.density).toBe('EPHEMERAL_FEEDBACK');
    expect(message.tone).toBe('WAITING');
    expect(message.fields?.map((field) => field.name)).toEqual([
      '🎁 礼物心意',
      '🐟 资金状态',
      '⏳ 当前进度',
      '👉 下一步'
    ]);
    expect(JSON.stringify(message)).toContain('已预留：20.0 CAT');
    expect(JSON.stringify(message)).toContain('尚未正式扣除');
    expect(JSON.stringify(message)).not.toMatch(/已扣除|已送达陪玩/u);
  });

  test('keeps the final gift confirmation factual and separates reservation from charging', () => {
    const message = buildGiftAffordabilityMessage(
      {
        giftCatalogVersionId: '00000000-0000-0000-0000-000000180713',
        catalogVersion: 2,
        priceMinor: 100,
        recipientCount: 2,
        totalPriceMinor: 200,
        ledgerBalanceMinor: 1000,
        reservedMinor: 0,
        availableMinor: 1000,
        shortfallMinor: 0,
        currency: 'CAT',
        calculatedAt: '2026-08-08T12:00:00.000Z',
        stale: false,
        canAfford: true,
        topUpInstructions: '联系猫舍前台充值。'
      },
      'ctx_m18_gift'
    );

    expect(message.density).toBe('HIGH_RISK');
    expect(message.fields?.map((field) => field.name)).toEqual(['🐟 资金确认', '⏳ 当前进度', '👉 下一步']);
    expect(JSON.stringify(message)).toContain('确认后将预留：20.0 CAT');
    expect(JSON.stringify(message)).toContain('尚未预留或扣除');
    expect(JSON.stringify(message.components)).toContain('确认赠送');
  });

  test('keeps cancellation preview restrained and separates fund impact from the destructive action', () => {
    const message = buildCancellationPreviewMessage({
      previewId: '00000000-0000-0000-0000-000000180701',
      orderId: '00000000-0000-0000-0000-000000180702',
      orderVersion: 7,
      automaticallyProcessable: true,
      fundAction: 'RELEASE_RESERVATION',
      estimatedAmountMinor: 120,
      releaseAmountMinor: 120,
      refundAmountMinor: 0,
      currency: 'CAT',
      handlingTimeCode: 'IMMEDIATE',
      staffTaskRequired: false,
      validUntil: '2026-08-08T13:00:00.000Z'
    });

    expect(message.density).toBe('HIGH_RISK');
    expect(message.tone).toBe('DANGER');
    expect(message.fields?.map((field) => field.name)).toEqual([
      '🐟 资金影响',
      '🛎️ 处理方式',
      '⏳ 当前进度',
      '👉 下一步'
    ]);
    expect(JSON.stringify(message)).toContain('本次预览没有取消订单');
    expect(JSON.stringify(message.components)).toContain('确认取消');
  });

  test('only presents a cancellation as final when the API returned CANCELLED', () => {
    const pending = buildCancellationResultMessage({
      orderId: '00000000-0000-0000-0000-000000180703',
      status: 'IN_SERVICE',
      version: 8,
      fundAction: 'NONE',
      staffTaskId: null
    });
    const cancelled = buildCancellationResultMessage({
      orderId: '00000000-0000-0000-0000-000000180703',
      status: 'CANCELLED',
      version: 9,
      fundAction: 'RELEASE_RESERVATION',
      staffTaskId: null,
      releasedReservation: {
        reservationId: '00000000-0000-0000-0000-000000180704',
        amountMinor: 120,
        capturedMinor: 0,
        releasedMinor: 120,
        currency: 'CAT',
        status: 'RELEASED',
        version: 2,
        expiresAt: '2026-08-08T13:00:00.000Z'
      }
    });

    expect(pending.title).not.toContain('订单已取消');
    expect(pending.tone).toBe('WAITING');
    expect(JSON.stringify(pending)).toContain('写入结果仍以最新订单状态为准');
    expect(cancelled.title).toContain('订单已取消');
    expect(cancelled.density).toBe('HIGH_RISK');
    expect(JSON.stringify(cancelled)).toContain('已释放预留：12.0 CAT');
  });

  test('makes support rating warm but explicitly independent from order money and earnings', () => {
    const message = buildSupportRatingMessage('00000000-0000-0000-0000-000000180705');

    expect(message.density).toBe('EPHEMERAL_FEEDBACK');
    expect(message.fields?.map((field) => field.name)).toEqual(['🛎️ 评价对象', '👉 下一步']);
    expect(JSON.stringify(message)).toContain('不会影响订单扣款或任何陪玩收益');
    expect(message.components[0]?.components).toHaveLength(5);
  });

  test('formats rejected and uncertain failures into the same low-density reading order', () => {
    const rejected = formatUserFacingError(
      new BotApiError({
        code: 'CONFLICT',
        message: 'Order version is stale.',
        requestId: 'req-m18-rejected',
        statusCode: 409
      }),
      { operation: '打开报名项目菜单' }
    );
    const uncertain = formatUserFacingError(
      new BotApiError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'The operation failed before it could be completed.',
        requestId: 'req-m18-uncertain',
        statusCode: 503
      }),
      { operation: '开始新一轮招募' }
    );

    for (const message of [rejected, uncertain]) {
      expect(message).toMatch(/^⚠️ 无法/u);
      expect(message).toContain('\n\n**下一步**\n');
      expect(message).toContain('\n\n**写入结果**\n');
      expect(message).toMatch(/request_id: req-m18-(rejected|uncertain)$/u);
    }
    expect(rejected).toContain('业务 API 已拒绝本次请求，本次操作未生效');
    expect(uncertain).toContain('写入结果暂时无法确认');
    expect(uncertain).not.toContain('本次操作未生效');
  });
});

function giftRequest(): GiftRequestResult {
  return {
    unitPriceMinor: 100,
    recipientCount: 2,
    totalAmountMinor: 200,
    items: [
      {
        id: '00000000-0000-0000-0000-000000180706',
        publicId: 'G-M18-0706',
        orderId: '00000000-0000-0000-0000-000000180707',
        senderId: '00000000-0000-0000-0000-000000180708',
        receiverId: '00000000-0000-0000-0000-000000180709',
        participantId: '00000000-0000-0000-0000-000000180710',
        status: 'PENDING_REVIEW',
        expiresAt: '2026-08-08T13:00:00.000Z',
        gift: { code: 'MILK_TEA', name: '猫猫奶茶', priceMinor: 100, currency: 'CAT' },
        reservation: {
          id: '00000000-0000-0000-0000-000000180711',
          sourceType: 'GIFT',
          status: 'ACTIVE',
          amountMinor: 100,
          currency: 'CAT',
          expiresAt: '2026-08-08T13:00:00.000Z'
        },
        staffTask: {
          id: '00000000-0000-0000-0000-000000180712',
          publicId: 'T-M18-0712',
          type: 'GIFT_REVIEW',
          status: 'OPEN'
        },
        balance: {
          ledgerBalanceMinor: 1000,
          reservedMinor: 200,
          availableMinor: 800,
          currency: 'CAT',
          calculatedAt: '2026-08-08T12:00:00.000Z'
        }
      }
    ]
  };
}
