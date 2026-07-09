import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildSupportWorkbench } from '@blackcat/dashboard/support-workbench';

const source = () => readFileSync('apps/dashboard/src/SupportWorkbenchPage.tsx', 'utf8');

describe('M14-US-03 queue-first support dashboard', () => {
  test('places the current task queue before historical summary and operations metrics', () => {
    const page = source();
    const queue = page.indexOf('aria-label="当前任务队列"');
    expect(queue).toBeGreaterThan(-1);
    expect(queue).toBeLessThan(page.indexOf('aria-label="最近 30 天客服记录"'));
    expect(queue).toBeLessThan(page.indexOf('<DashboardMetricSummaryLoader'));
    expect(page).toContain('support-shift-bar');
  });

  test('renders decision context and a read-only preview affordance before claim', () => {
    const page = source();
    for (const field of [
      'task.triage.orderPublicId', 'task.triage.customerDisplayName', 'task.triage.gameDisplayName',
      'task.triage.serviceDisplayName', 'task.triage.reasonLabel', 'task.triage.nextActionLabel',
      'formatTaskPressure(task)', '查看任务上下文'
    ]) expect(page).toContain(field);
    expect(page).toContain('aria-expanded={expandedTaskId === task.id}');
    expect(page).not.toContain("task.claimedBy === capabilities.staffId && <button type=\"button\" onClick={() => void openOrder(task)}>查看订单</button>");
  });

  test('keeps server priority and safe links unchanged in the reusable view model', () => {
    const view = buildSupportWorkbench({ guildId: '', currentStaffId: 'staff-1', permissions: ['staff_task.read', 'staff_task.claim'], tasks: [task()] });
    expect(view.sections.unclaimed[0]).toMatchObject({
      triage: { orderPublicId: 'P-M14-QUEUE', reasonLabel: '客户等待首响超时', nextActionLabel: '立即认领并联系客户' },
      links: { orderChannel: expect.stringContaining('/111111111111111111') }
    });
  });
});

function task() {
  return {
    id: 'task-1', publicId: 'T-M14-QUEUE', type: 'ORDER_ASSIST', status: 'OPEN', version: 1, claimedBy: null, orderId: 'order-1',
    responseStatus: 'OVERDUE' as const, responseDueAt: '2026-08-05T20:00:00Z', firstRespondedAt: null, createdAt: '2026-08-05T19:55:00Z',
    links: { orderChannel: 'https://discord.com/channels/999999999999999999/111111111111111111', voiceChannel: null },
    triage: { orderPublicId: 'P-M14-QUEUE', customerDisplayName: '小猫', gameDisplayName: '无畏契约', serviceDisplayName: '娱乐陪玩', amountMinor: 12000,
      currency: 'CAT', reasonLabel: '客户等待首响超时', waitStartedAt: '2026-08-05T19:55:00Z', nextActionLabel: '立即认领并联系客户' }
  };
}
