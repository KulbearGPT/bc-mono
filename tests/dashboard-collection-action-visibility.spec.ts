import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { AdminBusinessPage } from '../apps/dashboard/src/AdminBusinessPage.js';
import { buildAdminBusinessPage, type AdminBusinessPageId } from '@blackcat/dashboard/admin-business';

const permissions = [
  'order.read', 'refund.execute', 'order.resolve',
  'user.read', 'user.risk.manage', 'user.status.manage',
  'player.read', 'player.approve', 'player.status.manage', 'player.tags.manage',
  'catalog.read', 'catalog.manage',
  'gift_catalog.read', 'gift_catalog.manage', 'gift_request.read'
];

const cases: Array<{
  page: Extract<AdminBusinessPageId, 'orders' | 'users' | 'players' | 'serviceCatalog' | 'servicePackages' | 'giftCatalog' | 'giftRequests'>;
  items: Array<Record<string, unknown>>;
  collectionActions: string[];
  itemActions: string[];
}> = [
  {
    page: 'orders',
    items: [
      { id: 'order-completed', publicId: 'P-1001', status: 'COMPLETED', amountMinor: 1000, currency: 'CAT' },
      { id: 'order-accepted', publicId: 'P-1002', status: 'ACCEPTED', amountMinor: 1200, currency: 'CAT' }
    ],
    collectionActions: [],
    itemActions: ['查看详情', '独立退款', '取消订单']
  },
  {
    page: 'users',
    items: [{ id: 'user-1', displayName: '老板', status: 'ACTIVE' }],
    collectionActions: [],
    itemActions: ['查看详情', '记录风险事件', '更新运营状态']
  },
  {
    page: 'players',
    items: [
      { id: 'player-pending', playerId: 'player-pending', displayName: '待审核陪玩', reviewStatus: 'PENDING_REVIEW' },
      { id: 'player-active', playerId: 'player-active', displayName: '正式陪玩', reviewStatus: 'ACTIVE' }
    ],
    collectionActions: [],
    itemActions: ['查看详情', '批准陪玩申请', '拒绝陪玩申请', '管理接单资格', '编辑支持范围', '设置项目分成']
  },
  {
    page: 'serviceCatalog',
    items: [{ id: 'service-1', code: 'VALORANT_ESCORT', status: 'ACTIVE', currency: 'CAT' }],
    collectionActions: ['创建服务版本'],
    itemActions: ['查看详情', '编辑服务项目', '归档服务项目']
  },
  {
    page: 'servicePackages',
    items: [{ id: 'package-1', code: 'DUO', displayName: '双人套餐', status: 'ACTIVE', currency: 'CAT' }],
    collectionActions: ['创建套餐版本'],
    itemActions: ['查看详情', '编辑套餐（创建新版本）', '发布或退役']
  },
  {
    page: 'giftCatalog',
    items: [{ id: 'gift-1', code: 'STAR', name: '星光礼物', status: 'ACTIVE', currency: 'CAT' }],
    collectionActions: ['创建礼物'],
    itemActions: ['查看详情', '编辑礼物', '归档礼物']
  },
  {
    page: 'giftRequests',
    items: [{ id: 'gift-request-1', publicId: 'G-1001', giftName: '星光礼物', status: 'PENDING_REVIEW', currency: 'CAT' }],
    collectionActions: [],
    itemActions: ['查看详情']
  }
];

describe('Dashboard collection action visibility', () => {
  test.each(cases)('$page exposes the same allowed operations in card and table views', ({ page, items, collectionActions, itemActions }) => {
    const model = buildAdminBusinessPage({ page, permissions, status: 'READY', items });

    for (const view of ['CARD', 'TABLE'] as const) {
      const html = renderToStaticMarkup(createElement(AdminBusinessPage, {
        model,
        view,
        onAction: () => undefined,
        onOpenDetail: () => undefined
      }));

      for (const label of [...collectionActions, ...itemActions]) expect(html, `${page} ${view} is missing ${label}`).toContain(label);
      expect(html).toContain('aria-label="可用操作"');
    }
  });

  test.each(cases)('$page places card operations before the content summary', ({ page, items }) => {
    const model = buildAdminBusinessPage({ page, permissions, status: 'READY', items });
    const html = renderToStaticMarkup(createElement(AdminBusinessPage, {
      model,
      view: 'CARD',
      onAction: () => undefined,
      onOpenDetail: () => undefined
    }));
    const actionIndex = html.indexOf('collection-item-actions--card');
    const summaryIndex = html.search(/(?:order|business)-discussion-card__summary/u);
    expect(actionIndex).toBeGreaterThan(-1);
    expect(actionIndex).toBeLessThan(summaryIndex);
  });

  test('renders missing-permission actions as disabled guidance instead of hiding the workflow', () => {
    const model = buildAdminBusinessPage({
      page: 'serviceCatalog',
      permissions: ['catalog.read'],
      status: 'READY',
      items: [{ id: 'service-1', status: 'ACTIVE' }]
    });
    const html = renderToStaticMarkup(createElement(AdminBusinessPage, {
      model,
      onAction: () => undefined,
      onOpenDetail: () => undefined
    }));

    expect(html).toContain('创建服务版本');
    expect(html).toContain('归档服务项目');
    expect(html).toContain('disabled=""');
    expect(html).toContain('需要权限 catalog.manage');
  });
});
