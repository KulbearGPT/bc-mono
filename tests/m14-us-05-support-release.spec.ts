import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { DashboardMetricSummary } from '../apps/dashboard/src/SupportWorkbenchPage.js';
import { buildSupportWorkbench } from '@blackcat/dashboard/support-workbench';

describe('M14-US-05 support workbench release gate', () => {
  test('routes the pending-task metric to the real support workspace with its filter intact', () => {
    const html = renderToStaticMarkup(createElement(DashboardMetricSummary, { state: { kind: 'READY', requestId: null, data: {
      windowStart: '2026-08-05T00:00:00Z', windowEnd: '2026-08-06T00:00:00Z', timeZone: 'America/Edmonton', currency: 'CAT',
      metrics: { todayOrderCount: 1, inProgressOrderCount: 2, pendingStaffTaskCount: 3, completedOrderNetConsumptionMinor: 100, giftNetConsumptionMinor: 50, activeReservedMinor: 20, dispatchSuccessRateBps: 5000, exceptionCount: 1 }
    } } }));
    expect(html).toContain('href="/support?taskFilter=ALL"');
    expect(html).not.toContain('href="/admin/support');
    expect(html).not.toContain('taskFilter=UNCLAIMED');
    expect(html).toContain('href="/admin/orders?status=IN_PROGRESS"');
  });

  test('keeps release-critical focus, responsive and accessible-name rules in the dashboard shell', async () => {
    const { readFile } = await import('node:fs/promises');
    const [app, support, styles] = await Promise.all([
      readFile('apps/dashboard/src/App.tsx', 'utf8'), readFile('apps/dashboard/src/SupportWorkbenchPage.tsx', 'utf8'), readFile('apps/dashboard/src/styles.css', 'utf8')
    ]);
    expect(app).toContain('href="#dashboard-main">跳到主要内容</a>');
    expect(app).toContain('id="dashboard-main"');
    expect(app).toContain('tabIndex={-1}');
    expect(support).toContain('aria-pressed={filter === item.id}');
    expect(support).toContain('aria-expanded={expandedTaskId === task.id}');
    expect(styles).toContain('@media (max-width: 768px)');
    expect(styles).toContain('.support-shift-bar { align-items: stretch; flex-direction: column; }');
    expect(styles).toContain('.task-card__summary { grid-template-columns: minmax(0, 1fr); }');
    expect(styles).toContain('.task-card__actions > *');
    expect(styles).toMatch(/\.table-shell\s*\{[^}]*overflow-x:\s*auto/u);
  });

  test('fails closed instead of crashing when a rolling API response lacks new triage links', () => {
    const view = buildSupportWorkbench({ guildId: '', currentStaffId: 'staff-1', permissions: ['staff_task.read'], tasks: [{
      id: 'legacy-task', publicId: 'T-LEGACY', type: 'ORDER_ASSIST', status: 'OPEN', version: 1, claimedBy: null, orderId: 'order-1', createdAt: '2026-08-05T19:55:00Z'
    } as never] });
    expect(view.sections.unclaimed[0]).toMatchObject({ links: { orderChannel: null, voiceChannel: null }, triage: { orderPublicId: null, reasonLabel: '需要客服处理', nextActionLabel: '查看任务并确认下一步' } });
  });

  test('publishes the in-progress drilldown filter in both API contract mirrors', async () => {
    const { readFile } = await import('node:fs/promises');
    const [output, docs] = await Promise.all([readFile('outputs/P0开发交付包/02-API/openapi.yaml','utf8'),readFile('docs/P0开发交付包/02-API/openapi.yaml','utf8')]);
    expect(docs).toBe(output);
    expect(output).toContain('Exact order status or the IN_PROGRESS operational group');
    expect(output).toContain('EXCEPTION, IN_PROGRESS]');
  });
});
