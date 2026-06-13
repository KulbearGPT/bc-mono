import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminBusinessPage } from '../apps/dashboard/src/AdminBusinessPage.js';
import {
  buildAdminActionRequest,
  buildAdminBusinessNavigation,
  buildAdminBusinessPage,
  buildAdminDetailRequest,
  buildAdminResourceQuery,
  buildAdminUserConsumptionRequest,
  formatMinorCurrency
} from '@blackcat/dashboard/admin-business';

describe('M4-US-03 Dashboard business object pages', () => {
  test('hides pages that are absent from server capabilities', () => {
    const navigation = buildAdminBusinessNavigation([
      'order.read',
      'user.read',
      'player.read',
      'catalog.read',
      'gift_catalog.read',
      'earnings.read'
    ]);

    expect(navigation.map((item) => item.id)).toEqual([
      'orders',
      'users',
      'players',
      'serviceCatalog',
      'giftCatalog',
      'playerEarnings'
    ]);
    expect(navigation.map((item) => item.id)).not.toContain('commissions');
  });

  test('exposes gift requests only to staff with gift_request.read and maps its detail endpoint', async () => {
    const navigation = buildAdminBusinessNavigation(['gift_request.read']);

    expect(navigation).toEqual([{ id: 'giftRequests', label: '礼物请求', href: '/admin/gift-requests' }]);
    expect(buildAdminDetailRequest('giftRequests' as never, { id: 'gift-request-1' }))
      .toBe('/api/v1/admin/gift-requests/gift-request-1');
    const module = await import('@blackcat/dashboard/admin-business') as Record<string, unknown>;
    expect(module.resolveAdminBusinessPage).toBeTypeOf('function');
    if (typeof module.resolveAdminBusinessPage === 'function') {
      expect((module.resolveAdminBusinessPage as (path: string) => string | null)('/admin/gift-requests')).toBe('giftRequests');
    }
  });

  test('preserves filters while advancing cursor pagination', () => {
    expect(buildAdminResourceQuery({
      cursor: 'created_at:id',
      limit: 25,
      query: 'discord-123',
      status: 'IN_SERVICE'
    })).toBe('?cursor=created_at%3Aid&limit=25&query=discord-123&status=IN_SERVICE');

    expect(buildAdminResourceQuery({ limit: 500, query: '  ' })).toBe('?limit=100');
  });

  test('keeps L2 catalog and earning views read-only', () => {
    const catalog = buildAdminBusinessPage({
      page: 'serviceCatalog',
      permissions: ['catalog.read'],
      status: 'READY',
      items: [],
      nextCursor: 'next'
    });
    const earnings = buildAdminBusinessPage({
      page: 'playerEarnings',
      permissions: ['earnings.read'],
      status: 'READY',
      items: [],
      nextCursor: null
    });

    expect(catalog.actions).toEqual([]);
    expect(catalog.pagination).toEqual({ hasNext: true, nextCursor: 'next' });
    expect(earnings.actions).toEqual([]);
  });

  test('only exposes write actions backed by complete forms and API mappings', () => {
    const catalog = buildAdminBusinessPage({
      page: 'serviceCatalog',
      permissions: ['catalog.read', 'catalog.manage'],
      status: 'READY',
      items: [{ id: 'service-v1' }],
      nextCursor: null
    });
    const earnings = buildAdminBusinessPage({
      page: 'playerEarnings',
      permissions: ['earnings.read', 'earnings.manage'],
      status: 'READY',
      items: [{ id: 'earning-1' }],
      nextCursor: null
    });

    expect(catalog.actions.map((action) => action.id)).toEqual(['CREATE_SERVICE_VERSION', 'UPDATE_VERSION', 'ARCHIVE_SERVICE']);
    expect(catalog.actions.every((action) => action.requiresReason)).toBe(true);
    expect(earnings.actions.map((action) => action.id)).toEqual(['CONFIRM', 'MARK_PAID']);
    expect(earnings.actions.every((action) => action.requiresReason)).toBe(true);
    expect([...catalog.actions, ...earnings.actions].some((action) => action.id.includes('DELETE'))).toBe(false);
  });

  test('formats integer minor units with their currency without client-side arithmetic', () => {
    expect(formatMinorCurrency(123456, 'CAT', 'zh-CN')).toBe('12,345.6 猫条');
    expect(formatMinorCurrency(-500, 'CAT', 'en-US')).toBe('-50.0 猫条');
    expect(() => formatMinorCurrency(1.5, 'CAT')).toThrow(/integer minor units/i);
  });

  test('models loading, empty, error and forbidden states without exposing rows', () => {
    const base = { page: 'orders' as const, permissions: ['order.read'], items: [{ id: 'order-1' }], nextCursor: null };
    expect(buildAdminBusinessPage({ ...base, status: 'LOADING' }).kind).toBe('LOADING');
    expect(buildAdminBusinessPage({ ...base, status: 'READY', items: [] }).kind).toBe('EMPTY');
    expect(buildAdminBusinessPage({ ...base, status: 'ERROR', requestId: 'req-1' })).toMatchObject({ kind: 'ERROR', requestId: 'req-1', items: [] });
    expect(buildAdminBusinessPage({ ...base, permissions: [], status: 'READY' })).toMatchObject({ kind: 'FORBIDDEN', items: [] });
  });

  test('renders orders as approachable discussion cards with essential facts', () => {
    const model = buildAdminBusinessPage({
      page: 'orders',
      permissions: ['order.read'],
      status: 'READY',
      items: [{
        id: 'order-uuid-1', publicId: 'P-CAT001', status: 'PENDING_DISPATCH',
        game: 'VALORANT', gameDisplayName: '瓦洛兰特', service: 'FUN', serviceDisplayName: '娱乐陪玩',
        region: 'NA', regionDisplayName: '北美', billingUnitMinutes: 60, unitCount: 2,
        customerId: 'customer-uuid-1', playerId: null, amountMinor: 200, currency: 'CAT',
        createdAt: '2026-08-03T12:00:00.000Z'
      }]
    });
    const html = renderToStaticMarkup(createElement(AdminBusinessPage, { model, onOpenDetail: () => undefined }));

    expect(html).toContain('class="order-discussion-grid"');
    expect(html).toContain('订单 P-CAT001');
    expect(html).toContain('瓦洛兰特');
    expect(html).toContain('娱乐陪玩');
    expect(html).toContain('老板 ID');
    expect(html).toContain('customer-uuid-1');
    expect(html).toContain('陪玩 ID');
    expect(html).toContain('待接单');
    expect(html).toContain('20.0 猫条');
    expect(html).not.toContain('<table');
  });

  test('renders a clear action panel with mandatory reasonCode', () => {
    const item = { id: 'user-1', version: 3, displayName: 'Customer A' };
    const model = buildAdminBusinessPage({
      page: 'users',
      permissions: ['user.read', 'user.status.manage'],
      status: 'READY',
      items: [item]
    });
    const action = model.actions.find((candidate) => candidate.id === 'SET_OPERATIONAL_STATUS')!;
    const html = renderToStaticMarkup(createElement(AdminBusinessPage, {
      model,
      activeAction: { action, item },
      onAction: () => undefined,
      onCancelAction: () => undefined,
      onSubmitAction: () => undefined
    }));

    expect(html).toContain('更新运营状态操作表单');
    expect(html).toContain('class="dashboard-overlay"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('name="reasonCode"');
    expect(html).toContain('required=""');
    expect(html).toContain('name="status"');
  });

  test('maps user status and gift catalog forms to unified API writes', () => {
    expect(buildAdminActionRequest({
      actionId: 'SET_OPERATIONAL_STATUS',
      item: { id: 'user-1', version: 3 },
      fields: { status: 'PAUSED', reasonCode: 'MANUAL_REVIEW', note: '' }
    })).toEqual({
      method: 'PUT',
      path: '/api/v1/admin/users/user-1/operational-status',
      body: { expectedVersion: 3, status: 'PAUSED', reasonCode: 'MANUAL_REVIEW', note: null }
    });
    expect(buildAdminActionRequest({
      actionId: 'CREATE_GIFT',
      fields: { name: 'Super Rocket', giftCategoryTagId: 'gift-category-1', amountMinor: '52000', currency: 'CAT', enabled: true, broadcastTemplate: '{sender} sent {gift}', reasonCode: 'INITIAL_GIFT_VERSION' }
    })).toEqual({
      method: 'POST',
      path: '/api/v1/admin/gift-catalog',
      body: { name: 'Super Rocket', giftCategoryTagId: 'gift-category-1', price: { amountMinor: 52000, currency: 'CAT' }, enabled: true, broadcastTemplate: '{sender} sent {gift}', reasonCode: 'INITIAL_GIFT_VERSION' }
    });
    expect(buildAdminActionRequest({
      actionId: 'UPDATE_GIFT_VERSION',
      item: { id: 'gift-1', version: 2 },
      fields: { action: 'DISABLE', reasonCode: 'OPERATIONS_DECISION' }
    })).toEqual({
      method: 'PATCH',
      path: '/api/v1/admin/gift-catalog/gift-1',
      body: { expectedVersion: 2, action: 'DISABLE', reasonCode: 'OPERATIONS_DECISION', replacement: null }
    });
  });

  test('maps service versions, gift replacements and append-only user risk events to unified API writes', () => {
    const serviceFields = {
      gameTagId: 'game-1', serviceTagId: 'service-1', regionTagId: 'region-1', billingUnitMinutes: '60', minimumUnits: '2',
      customerAmountMinor: '6000', defaultPlayerPayoutPercent: '66.67', currency: 'CAT', enabled: true, reasonCode: 'INITIAL_VERSION'
    };

    expect(buildAdminActionRequest({ actionId: 'CREATE_SERVICE_VERSION', fields: serviceFields })).toEqual({
      method: 'POST',
      path: '/api/v1/admin/service-catalog',
      body: {
        gameTagId: 'game-1', serviceTagId: 'service-1', regionTagId: 'region-1', billingUnitMinutes: 60, minimumUnits: 2,
        customerUnitPrice: { amountMinor: 6000, currency: 'CAT' }, playerUnitPayout: { amountMinor: 4000, currency: 'CAT' }, defaultPlayerPayoutBps: 6667,
        enabled: true, reasonCode: 'INITIAL_VERSION'
      }
    });
    expect(buildAdminActionRequest({
      actionId: 'UPDATE_VERSION', item: { id: 'service-v1', version: 2 }, fields: { ...serviceFields, action: 'SUPERSEDE', reasonCode: 'PRICE_REFRESH' }
    })).toEqual({
      method: 'PATCH', path: '/api/v1/admin/service-catalog/service-v1',
      body: {
        expectedVersion: 2, action: 'SUPERSEDE', reasonCode: 'PRICE_REFRESH',
        replacement: {
          gameTagId: 'game-1', serviceTagId: 'service-1', regionTagId: 'region-1', billingUnitMinutes: 60, minimumUnits: 2,
          customerUnitPrice: { amountMinor: 6000, currency: 'CAT' }, playerUnitPayout: { amountMinor: 4000, currency: 'CAT' }, defaultPlayerPayoutBps: 6667,
          enabled: true, reasonCode: 'PRICE_REFRESH'
        }
      }
    });
    expect(buildAdminActionRequest({
      actionId: 'UPDATE_GIFT_VERSION', item: { id: 'gift-1', version: 2 },
      fields: { action: 'CREATE_REPLACEMENT_VERSION', name: 'Super Rocket', giftCategoryTagId: 'gift-category-1', amountMinor: '52000', currency: 'CAT', enabled: true, broadcastTemplate: '{sender} sent {gift}', reasonCode: 'PRICE_REFRESH' }
    })).toEqual({
      method: 'PATCH', path: '/api/v1/admin/gift-catalog/gift-1',
      body: {
        expectedVersion: 2, action: 'CREATE_REPLACEMENT_VERSION', reasonCode: 'PRICE_REFRESH',
        replacement: { name: 'Super Rocket', giftCategoryTagId: 'gift-category-1', price: { amountMinor: 52000, currency: 'CAT' }, enabled: true, broadcastTemplate: '{sender} sent {gift}', reasonCode: 'PRICE_REFRESH' }
      }
    });
    expect(buildAdminActionRequest({
      actionId: 'CREATE_RISK_EVENT', item: { id: 'user-1', version: 3 },
      fields: { type: 'PAYMENT_ANOMALY', severity: 'HIGH', source: 'STAFF_REVIEW', notes: 'Provider verification mismatch.', orderId: '' }
    })).toEqual({
      method: 'POST', path: '/api/v1/admin/users/user-1/risk-events',
      body: { type: 'PAYMENT_ANOMALY', severity: 'HIGH', source: 'STAFF_REVIEW', notes: 'Provider verification mismatch.', orderId: null }
    });
  });

  test('maps visible delete actions to audited archive writes instead of hard deletes', () => {
    expect(buildAdminActionRequest({ actionId: 'ARCHIVE_SERVICE', item: { id: 'service-v1', version: 2 }, fields: { reasonCode: 'NO_LONGER_SOLD' } })).toEqual({
      method: 'PATCH', path: '/api/v1/admin/service-catalog/service-v1', body: { expectedVersion: 2, action: 'ARCHIVE', reasonCode: 'NO_LONGER_SOLD', replacement: null }
    });
    expect(buildAdminActionRequest({ actionId: 'ARCHIVE_GIFT', item: { id: 'gift-1', version: 3 }, fields: { reasonCode: 'NO_LONGER_SOLD' } })).toEqual({
      method: 'PATCH', path: '/api/v1/admin/gift-catalog/gift-1', body: { expectedVersion: 3, action: 'ARCHIVE', reasonCode: 'NO_LONGER_SOLD', replacement: null }
    });
  });

  test('rejects action requests without a valid reasonCode', () => {
    expect(() => buildAdminActionRequest({
      actionId: 'SET_OPERATIONAL_STATUS',
      item: { id: 'user-1', version: 3 },
      fields: { status: 'ACTIVE', reasonCode: '' }
    })).toThrow(/reasonCode/);
  });

  test('maps order, user and player rows to their detail endpoints', () => {
    expect(buildAdminDetailRequest('orders', { id: 'order-1' })).toBe('/api/v1/admin/orders/order-1');
    expect(buildAdminDetailRequest('users', { id: 'user-1' })).toBe('/api/v1/admin/users/user-1');
    expect(buildAdminDetailRequest('players', { playerId: 'player-1' })).toBe('/api/v1/admin/players/player-1');
    expect(() => buildAdminDetailRequest('giftCatalog', { id: 'gift-1' })).toThrow(/detail/i);
    expect(buildAdminUserConsumptionRequest('user-1')).toBe('/api/v1/admin/users/user-1/consumptions?limit=25');
  });

  test('renders detail entry points and an explicit order scope denial', () => {
    const model = buildAdminBusinessPage({
      page: 'orders', permissions: ['order.read'], status: 'READY', items: [{ id: 'order-1', publicId: 'O-1' }]
    });
    const listHtml = renderToStaticMarkup(createElement(AdminBusinessPage, {
      model,
      onOpenDetail: () => undefined
    }));
    const deniedHtml = renderToStaticMarkup(createElement(AdminBusinessPage, {
      model,
      onOpenDetail: () => undefined,
      detail: { kind: 'FORBIDDEN', page: 'orders', requestId: 'req-scope', data: null }
    }));

    expect(listHtml).toContain('查看详情');
    expect(deniedHtml).toContain('当前订单不在你的任务权限范围内');
    expect(deniedHtml).toContain('req-scope');
    expect(deniedHtml).not.toContain('订单详情数据');
  });

  test('renders user consumption mirrors alongside the user detail without exposing unrelated data', () => {
    const model = buildAdminBusinessPage({ page: 'users', permissions: ['user.read'], status: 'READY', items: [] });
    const html = renderToStaticMarkup(createElement(AdminBusinessPage, {
      model,
      detail: {
        kind: 'READY', page: 'users', requestId: 'req-user', data: { id: 'user-1', displayName: 'Customer A', currency: 'CAT' },
        consumptions: {
          kind: 'READY', requestId: 'req-consumptions', items: [
            { id: 'consumption-1', type: 'ORDER', amountMinor: 12000, currency: 'CAT', status: 'SUCCEEDED' }
          ], nextCursor: 'next-consumption-page'
        }
      }
    }));

    expect(html).toContain('消费记录');
    expect(html).toContain('1,200.0 猫条');
    expect(html).toContain('加载更多消费记录');
    expect(html).not.toContain('beneficiaryId');
  });

  test('renders service, replacement-version and risk-event form controls for permitted actions', () => {
    const serviceModel = buildAdminBusinessPage({ page: 'serviceCatalog', permissions: ['catalog.read', 'catalog.manage'], status: 'READY', items: [{ id: 'service-1', version: 1 }] });
    const giftModel = buildAdminBusinessPage({ page: 'giftCatalog', permissions: ['gift_catalog.read', 'gift_catalog.manage'], status: 'READY', items: [{ id: 'gift-1', version: 1 }] });
    const userModel = buildAdminBusinessPage({ page: 'users', permissions: ['user.read', 'user.risk.manage'], status: 'READY', items: [{ id: 'user-1', version: 1 }] });
    const serviceHtml = renderToStaticMarkup(createElement(AdminBusinessPage, {
      model: serviceModel, activeAction: { action: serviceModel.actions[0] }, onSubmitAction: () => undefined
    }));
    const giftHtml = renderToStaticMarkup(createElement(AdminBusinessPage, {
      model: giftModel, activeAction: { action: giftModel.actions.find((action) => action.id === 'UPDATE_GIFT_VERSION')!, item: { id: 'gift-1', version: 1 } }, onSubmitAction: () => undefined
    }));
    const riskHtml = renderToStaticMarkup(createElement(AdminBusinessPage, {
      model: userModel, activeAction: { action: userModel.actions[0], item: { id: 'user-1', version: 1 } }, onSubmitAction: () => undefined
    }));

    expect(serviceHtml).toContain('name="customerAmountMinor"');
    expect(serviceHtml).toContain('name="defaultPlayerPayoutPercent"');
    expect(giftHtml).toContain('value="CREATE_REPLACEMENT_VERSION"');
    expect(giftHtml).toContain('保存修改（创建新版本）');
    expect(riskHtml).toContain('name="severity"');
    expect(riskHtml).toContain('name="notes"');
    expect(riskHtml).not.toContain('name="reasonCode"');
  });

  test('renders the operations column before business data columns', () => {
    const model = buildAdminBusinessPage({ page: 'serviceCatalog', permissions: ['catalog.read', 'catalog.manage'], status: 'READY', items: [{ id: 'service-1', version: 1, game: 'VALORANT' }] });
    const html = renderToStaticMarkup(createElement(AdminBusinessPage, { model, onAction: () => undefined }));
    expect(html.indexOf('>操作</th>')).toBeLessThan(html.indexOf('>编号</th>'));
    expect(html.indexOf('class="table-actions"')).toBeLessThan(html.indexOf('>service-1</td>'));
  });

  test('reuses a generated idempotency key for retries of one logical write', async () => {
    const module = await import('../apps/dashboard/src/AdminBusinessRoute.js') as Record<string, unknown>;
    expect(typeof module.createRetriableDashboardWrite).toBe('function');
    if (typeof module.createRetriableDashboardWrite !== 'function') return;

    const seen: string[] = [];
    const retry = (module.createRetriableDashboardWrite as (input: {
      createKey: () => string;
      send: (idempotencyKey: string) => Promise<void>;
    }) => () => Promise<void>)({
      createKey: () => 'dashboard:stable-operation-key',
      send: async (idempotencyKey) => { seen.push(idempotencyKey); }
    });
    await retry();
    await retry();

    expect(seen).toEqual(['dashboard:stable-operation-key', 'dashboard:stable-operation-key']);
  });
});
