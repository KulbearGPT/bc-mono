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

  test('requires real UAT only in the current business Guild while retaining automated Guild-isolation gates', async () => {
    const { readFile } = await import('node:fs/promises');
    const [spec, story, backlog, acceptance, todo] = await Promise.all([
      readFile('outputs/Discord陪玩业务Bot最小原型设计开发文档.html', 'utf8'),
      readFile('outputs/P0开发交付包/06-开发计划/M14-客服任务优先工作台与可行动上下文-Story设计提案.md', 'utf8'),
      readFile('outputs/P0开发交付包/06-开发计划/backlog.csv', 'utf8'),
      readFile('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv', 'utf8'),
      readFile('outputs/Codex-P0开发TODO.md', 'utf8')
    ]);
    expect(spec).toContain('真实员工 UAT 只覆盖当前业务 Guild');
    expect(story).toContain('真实员工 UAT 只覆盖当前业务 Guild');

    const releaseStory = backlog.split('\n').find((line) => line.startsWith('"M14-US-05"')) ?? '';
    expect(releaseStory).toContain('当前业务 Guild');
    expect(releaseStory).toContain('跨 Guild 隔离由 API/数据库自动化回归证明');
    expect(releaseStory).not.toContain('覆盖 L1-L4、已认领与未认领、超时、缺频道、跨 Guild、');

    const automatedSecurityCase = acceptance.split('\n').find((line) => line.startsWith('"AT-SUX-003"')) ?? '';
    const realUatCase = acceptance.split('\n').find((line) => line.startsWith('"AT-SUX-007"')) ?? '';
    expect(automatedSecurityCase).toContain('FX-TWO-GUILDS');
    expect(realUatCase).not.toContain('FX-TWO-GUILDS');
    expect(realUatCase).toContain('Guild 隔离由 API/数据库自动化回归门禁证明');
    expect(todo).not.toContain('无 L3 且只有一个 Guild');
  });
});
