import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { AdminBusinessPage } from '../apps/dashboard/src/AdminBusinessPage.js';
import { DashboardMetricSummary } from '../apps/dashboard/src/SupportWorkbenchPage.js';
import { adminCollectionConfigs, buildAdminBusinessPage } from '@blackcat/dashboard/admin-business';
import { InMemoryAdminDirectoryStore } from '@blackcat/api/admin-directory';

const customerId = '00000000-0000-0000-0000-000000014401';
const playerId = '00000000-0000-0000-0000-000000014402';

describe('M14-US-04 actionable order context', () => {
  test('uses human names, localized status, relative/exact time and next action on order cards', () => {
    const model = buildAdminBusinessPage({ page: 'orders', permissions: ['order.read'], status: 'READY', items: [orderItem()] });
    const html = renderToStaticMarkup(createElement(AdminBusinessPage, { model, onOpenDetail: () => undefined }));
    for (const value of ['测试客户', '陪玩奶糖', '等待陪玩报名', '下一步', '继续等待候选或联系客户', '更新于']) expect(html).toContain(value);
    expect(html).toContain('2026年8月5日');
    expect(html).not.toContain('老板 ID');
    expect(html).not.toContain(customerId);
    expect(html).not.toContain(playerId);
  });

  test('uses humanized explicit order table columns', () => {
    expect(adminCollectionConfigs.orders.columns).toEqual([
      { key: 'publicId', label: '订单号' }, { key: 'status', label: '状态' }, { key: 'customerDisplayName', label: '客户' },
      { key: 'playerDisplayNames', label: '陪玩' }, { key: 'serviceSummary', label: '服务' }, { key: 'amountMinor', label: '订单金额' }, { key: 'updatedAt', label: '最近更新' }
    ]);
  });

  test('projects human-readable order list fields from directory facts', () => {
    const store = new InMemoryAdminDirectoryStore({ orders: [{ ...orderItem(), customerDisplayName: undefined, playerDisplayNames: undefined, serviceSummary: undefined } as never], users: [{ id: customerId, displayName: '测试客户', status: 'ACTIVE', externalAccountDisplay: null, activeOrderId: null, riskFlags: [], version: 1 }], players: [], consumptions: [], gifts: [], giftRequests: [] });
    const page = store.listOrders({ cursor: null, limit: 20, actorStaffId: 'staff-1', actorLevel: 'L2_SUPERVISOR' });
    expect(page.items[0]).toMatchObject({ customerDisplayName: '测试客户', playerDisplayNames: '陪玩奶糖', serviceSummary: '无畏契约 · 娱乐陪玩' });
  });

  test('puts the actionable order overview first and folds identifiers and advanced forms', () => {
    const model = buildAdminBusinessPage({ page: 'orders', permissions: ['order.read'], status: 'READY', items: [orderItem()] });
    const detail = { kind: 'READY' as const, page: 'orders' as const, requestId: 'req-m14', data: { order: orderItem(), timeline: { items: [], nextCursor: null }, requirements: { derivedTotalMinor: 12000, items: [] }, participants: { derivedTotalMinor: 12000, items: [] } } };
    const html = renderToStaticMarkup(createElement(AdminBusinessPage, { model, detail, serviceCatalogOptions: [], participantPlayerOptions: [], onAddOrderParticipant: () => undefined }));
    expect(html).toContain('订单处理概览');
    expect(html).toContain('当前阻塞');
    expect(html).toContain('下一步');
    expect(html).toContain('<details class="order-technical-details"');
    expect(html).toContain('技术详情与审计字段');
    expect(html).toContain('高级操作：添加陪玩明细');
  });

  test('makes pending, exception and in-progress metrics scope-preserving navigation links', () => {
    const html = renderToStaticMarkup(createElement(DashboardMetricSummary, { state: { kind: 'READY', requestId: null, data: {
      windowStart: '2026-08-05T00:00:00Z', windowEnd: '2026-08-06T00:00:00Z', timeZone: 'America/Edmonton', currency: 'CAT',
      metrics: { todayOrderCount: 1, inProgressOrderCount: 2, pendingStaffTaskCount: 3, completedOrderNetConsumptionMinor: 100, giftNetConsumptionMinor: 50, activeReservedMinor: 20, dispatchSuccessRateBps: 5000, exceptionCount: 1 }
    } } }));
    expect(html).toContain('href="/support?taskFilter=ALL"');
    expect(html).toContain('href="/admin/orders?status=EXCEPTION"');
    expect(html).toContain('href="/admin/orders?status=IN_PROGRESS"');
  });
});

function orderItem() {
  return {
    id: '00000000-0000-0000-0000-000000014410', publicId: 'P-M14-ORDER', status: 'PENDING_DISPATCH', version: 3,
    customerId, customerDisplayName: '测试客户', customerDiscordTag: 'customer#1001', playerId: null,
    participants: [{ id: 'participant-1', playerId, displayName: '陪玩奶糖', status: 'ACTIVE', gameDisplayName: '无畏契约', serviceDisplayName: '娱乐陪玩', unitCount: 2 }],
    playerDisplayNames: '陪玩奶糖', serviceSummary: '无畏契约 · 娱乐陪玩', gameDisplayName: '无畏契约', serviceDisplayName: '娱乐陪玩',
    amountMinor: 12000, currency: 'CAT', notes: null, createdAt: '2026-08-05T18:00:00Z', updatedAt: '2026-08-05T19:00:00Z'
  };
}
