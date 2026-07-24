import { describe, expect, test } from 'vitest';
import {
  buildCancellationResultMessage,
  type CancellationResultSummary
} from '@blackcat/bot/service-center';

describe('M2-US-05 Bot cancellation support states', () => {
  test('renders support takeover when accepted cancellation creates a staff task', () => {
    const result: CancellationResultSummary = {
      orderId: '00000000-0000-0000-0000-00000000b501',
      status: 'ACCEPTED',
      version: 4,
      fundAction: 'NONE',
      releasedReservation: null,
      refundTransaction: null,
      staffTaskId: '00000000-0000-0000-0000-00000000f501'
    };

    const message = buildCancellationResultMessage(result);

    expect(message.title).toBe('🛎️ 取消申请已转客服');
    expect(message.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({name:'📋 当前订单状态',value:'ACCEPTED'}),
      expect.objectContaining({name:'🛎️ 客服任务',value:result.staffTaskId})
    ]));
    expect(JSON.stringify(message)).toContain('不会自动退款或释放预留');
    expect(JSON.stringify(message)).not.toContain('订单已取消');
  });
});
