import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { BotApiError } from '@blackcat/bot/service-center-api';
import { formatUserFacingError } from '@blackcat/bot/user-facing-error';

describe('M17-US-10 precise Bot error messages', () => {
  test('explains an order-owner permission denial and gives an actionable next step', () => {
    const message = formatUserFacingError(
      new BotApiError({
        code: 'PERMISSION_DENIED',
        message: 'Only the order owner can manage the selection pool.',
        requestId: 'req-owner-denied',
        statusCode: 403
      }),
      { operation: '继续等待并开启新一轮报名' }
    );

    expect(message).toContain('当前 Discord 账号不是该订单的客户所有者');
    expect(message).toContain('请使用创建该订单的客户账号操作');
    expect(message).toContain('本次操作未生效');
    expect(message).toContain('request_id: req-owner-denied');
    expect(message).not.toMatch(/操作失败|刷新后重试|稍后重试/u);
  });

  test.each([
    ['CONFLICT', 'Order or selection pool version is stale.', 409, '页面中的订单或报名轮次已经过期'],
    ['CONFLICT', 'Selection pool or application is stale.', 409, '报名轮次或报名记录版本已经过期'],
    ['VALIDATION_ERROR', 'waitMinutes must be between 1 and 30.', 400, '提交的等待时间不符合要求'],
    ['BUSINESS_RULE_ERROR', 'Only a pending order can open a selection pool.', 422, '当前订单已不在等待派单状态'],
    ['NOT_FOUND', 'Selection pool was not found.', 404, '报名轮次不存在、已结束，或当前账号无权查看'],
    ['INSUFFICIENT_FUNDS', 'Insufficient available balance.', 422, '可用余额不足']
  ])('translates %s failures without hiding the reason', (code, serverMessage, statusCode, expectedReason) => {
    const message = formatUserFacingError(
      new BotApiError({ code, message: serverMessage, requestId: `req-${code}`, statusCode }),
      { operation: '处理报名轮次' }
    );
    expect(message).toContain(expectedReason);
    expect(message).toContain(`request_id: req-${code}`);
  });

  test.each([
    ['GATEWAY_TIMEOUT', 'bot-api-timeout', '系统在时限内没有响应'],
    ['SERVICE_UNAVAILABLE', 'bot-api-unreachable', '当前服务暂时无法连接'],
    ['INVALID_RESPONSE', 'bot-api-invalid-response', '系统返回了无法确认的结果']
  ])('does not claim that an uncertain transport failure is safe to retry', (code, requestId, reason) => {
    const message = formatUserFacingError(
      { code, requestId, statusCode: 503, message: 'transport failed' },
      { operation: '提交订单' }
    );
    expect(message).toContain(reason);
    expect(message).toContain('写入结果暂时无法确认');
    expect(message).toContain('请先重新打开订单查看最新状态，不要连续提交');
    expect(message).not.toContain('本次操作未生效');
  });

  test('describes local failures honestly and uses the supplied trace id', () => {
    const message = formatUserFacingError(new Error('boom'), {
      operation: '打开个人中心',
      localRequestId: 'discord-interaction-123'
    });
    expect(message).toContain('系统发生未分类异常，当前无法确认详细原因');
    expect(message).toContain('无法确认本次请求是否已送达');
    expect(message).not.toContain('boom');
    expect(message).toContain('request_id: discord-interaction-123');
  });

  test('does not expose an internal server reason when no dedicated translation exists', () => {
    const message = formatUserFacingError(
      new BotApiError({
        code: 'BUSINESS_RULE_ERROR',
        message: 'The selected catalog entry is archived.',
        requestId: 'req-archived',
        statusCode: 422
      }),
      { operation: '选择服务项目' }
    );
    expect(message).toContain('当前业务状态不满足执行条件');
    expect(message).not.toContain('The selected catalog entry is archived.');
    expect(message).toContain('request_id: req-archived');
  });

  test('keeps interaction error branches on the shared precise formatter', async () => {
    const paths = [
      'apps/bot/src/pieces/commands/bot-config.ts',
      'apps/bot/src/pieces/interaction-handlers/bot-config-buttons.ts',
      'apps/bot/src/pieces/interaction-handlers/bot-config-modals.ts',
      'apps/bot/src/pieces/interaction-handlers/bot-config-selects.ts',
      'apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts',
      'apps/bot/src/pieces/interaction-handlers/onboarding-buttons.ts',
      'apps/bot/src/pieces/interaction-handlers/order-selects.ts',
      'apps/bot/src/pieces/interaction-handlers/selection-selects.ts',
      'apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts',
      'apps/bot/src/pieces/interaction-handlers/service-center-modals.ts',
      'apps/bot/src/service-center-profile-interactions.ts',
      'apps/bot/src/service-center-gift-interactions.ts'
    ];
    const source = (await Promise.all(paths.map((path) => readFile(path, 'utf8')))).join('\n');
    expect(source).toContain('formatUserFacingError');
    expect(source).not.toMatch(/操作失败|失败，请稍后重试|操作失败，请刷新|未写入任何部分结果，请刷新/u);
  });
});
