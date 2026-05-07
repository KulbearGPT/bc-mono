import { describe, expect, test } from 'vitest';
import { buildAutomationControlView } from '@blackcat/dashboard/automation-control';

describe('M2-US-11 dashboard automation control state', () => {
  test('enables only scoped pause for L1 with a claimed task', () => {
    const view = buildAutomationControlView({
      orderId: 'order-1', orderVersion: 3, orderStatus: 'PENDING_DISPATCH', automationState: 'RUNNING',
      automationExpiresAt: null, staffLevel: 'L1_SUPPORT', hasClaimedOrderTask: true
    });
    expect(view.statusLabel).toBe('自动处理中');
    expect(view.actions).toEqual([
      expect.objectContaining({ id: 'PAUSE', enabled: true, operationId: 'pauseOrderAutomation' }),
      expect.objectContaining({ id: 'RESUME', enabled: false, operationId: 'resumeOrderAutomation' })
    ]);
  });

  test('lets L2 resume a paused order and gives an explicit resume action', () => {
    const view = buildAutomationControlView({
      orderId: 'order-1', orderVersion: 4, orderStatus: 'PENDING_DISPATCH', automationState: 'PAUSED',
      automationExpiresAt: '2026-07-18T09:30:00.000Z', staffLevel: 'L2_SUPERVISOR', hasClaimedOrderTask: false
    });
    expect(view.statusLabel).toBe('客服处理中');
    expect(view.resumeAction).toBe('REDISPATCH');
    expect(view.actions).toEqual([
      expect.objectContaining({ id: 'PAUSE', enabled: false }),
      expect.objectContaining({ id: 'RESUME', enabled: true })
    ]);
    expect(view.actions.some((action) => action.id === 'REFUND' || action.id === 'FORCE_STATUS')).toBe(false);
  });
});
