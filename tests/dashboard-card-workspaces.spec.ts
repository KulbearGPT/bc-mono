import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { AdminBusinessPage } from '../apps/dashboard/src/AdminBusinessPage.js';
import { buildAdminBusinessPage, type AdminBusinessPageId } from '@blackcat/dashboard/admin-business';

describe('Dashboard card workspaces', () => {
  const cases: Array<{ page: Extract<AdminBusinessPageId, 'players' | 'serviceCatalog' | 'servicePackages'>; item: Record<string, unknown>; title: string }> = [
    { page: 'players', item: { id: 'player-row', playerId: 'player-1', displayName: '奶糖', discordTag: '奶糖#2048', reviewStatus: 'APPROVED', active: true, version: 3 }, title: '奶糖' },
    { page: 'serviceCatalog', item: { id: 'catalog-v1', code: 'LOLNA_RANKED', gameDisplayName: '英雄联盟美服', serviceDisplayName: '技术陪玩', regionDisplayName: '北美', status: 'ACTIVE', customerUnitPriceMinor: 300, currency: 'CAT', version: 1 }, title: '英雄联盟美服 · 技术陪玩' },
    { page: 'servicePackages', item: { id: 'package-v1', code: 'DELTA_ESCORT', displayName: '三角洲护航', description: '双技术席位', status: 'ACTIVE', version: 2, currency: 'CAT', slots: [{ position: 1 }, { position: 2 }] }, title: '三角洲护航' }
  ];

  test.each(cases)('renders $page as a discussion card with an overlay detail entry', ({ page, item, title }) => {
    const model = buildAdminBusinessPage({ page, permissions: ['player.read', 'catalog.read', 'catalog.manage', 'player.approve', 'player.tags.manage'], status: 'READY', items: [item] });
    const html = renderToStaticMarkup(createElement(AdminBusinessPage, { model, onAction: () => undefined, onOpenDetail: () => undefined }));
    expect(html).toContain('business-discussion-grid');
    expect(html).toContain('business-discussion-card');
    expect(html).toContain(title);
    expect(html).toContain('查看详情');
    expect(html).not.toContain('data-table');
  });

  test('renders catalog and package snapshots inside the shared detail overlay', () => {
    const model = buildAdminBusinessPage({ page: 'servicePackages', permissions: ['catalog.read'], status: 'READY', items: [] });
    const html = renderToStaticMarkup(createElement(AdminBusinessPage, {
      model,
      detail: { kind: 'READY', page: 'servicePackages', requestId: 'req-card-detail', data: { displayName: '三角洲护航', status: 'ACTIVE', slots: [{ position: 1 }, { position: 2 }] } },
      onCloseDetail: () => undefined
    }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('业务对象详情');
    expect(html).toContain('三角洲护航');
  });

  test.each([
    {
      page: 'users' as const,
      data: { id: 'user-1', displayName: 'Yumii', discordUserId: '700000000000000001', discordUsername: 'yu_mii', status: 'ACTIVE', activeOrderId: null, externalAccountDisplay: null, riskFlags: [], version: 3, createdAt: '2026-08-04T00:00:00Z', updatedAt: '2026-08-04T01:00:00Z' },
      markers: ['customer-detail', '客户概览', 'Discord 用户编号', '数据版本', '完整客户档案']
    },
    {
      page: 'players' as const,
      data: { playerId: 'player-1', userId: 'user-2', displayName: '奶糖', discordUserId: '700000000000000002', discordUsername: 'milk', reviewStatus: 'ACTIVE', availability: 'AVAILABLE', discordPresence: 'ONLINE', gameTagDetails: [{ code: 'LOLNA', displayName: '英雄联盟' }], serviceTagDetails: [{ code: 'RANKED', displayName: '技术陪玩' }], languageTagDetails: [{ code: 'CN', displayName: '中文' }], version: 4, createdAt: '2026-08-04T00:00:00Z', updatedAt: '2026-08-04T01:00:00Z' },
      markers: ['player-profile-detail', '陪玩档案', '支持范围', '账号与状态', 'Discord 在线状态（参考）']
    },
    {
      page: 'serviceCatalog' as const,
      data: { id: 'catalog-1', code: 'LOLNA_RANKED', game: 'LOLNA', gameDisplayName: '英雄联盟美服', service: 'RANKED', serviceDisplayName: '技术陪玩', region: 'NA', regionDisplayName: '北美', billingUnitMinutes: 60, minimumUnits: 1, customerUnitPriceMinor: 300, defaultPlayerPayoutBps: 5000, currency: 'CAT', status: 'ACTIVE', version: 2 },
      markers: ['catalog-detail', '服务项目', '价格与计费', '目录标识']
    },
    {
      page: 'servicePackages' as const,
      data: { id: 'package-1', code: 'DELTA_ESCORT', gameDisplayName: '三角洲行动', displayName: '双人护航', description: '一位技术猫与一位气氛猫。', defaultCustomerPriceMinor: 600, currency: 'CAT', status: 'ACTIVE', version: 2, slots: [{ id: 'slot-1', position: 1, gameDisplayName: '三角洲行动', serviceDisplayName: '技术护航', regionDisplayName: '北美', billingUnitMinutes: 60, unitCount: 2, customerNoteTemplate: '负责技术护航' }] },
      markers: ['package-detail', '套餐概览', '套餐席位', '1 号位', '负责技术护航']
    },
    {
      page: 'giftCatalog' as const,
      data: { id: 'gift-1', giftCatalogVersionId: 'gift-v1', code: 'ROCKET', name: '超级火箭', priceMinor: 5200, currency: 'CAT', status: 'ACTIVE', enabled: true, version: 2, broadcastTemplate: '{sender} 送出 {gift}', giftCategoryTagDetails: { code: 'PREMIUM', displayName: '高级礼物' }, createdByStaffId: 'staff-1', createdAt: '2026-08-04T00:00:00Z', activatedAt: '2026-08-04T01:00:00Z', retiredAt: null, archivedAt: null },
      markers: ['gift-catalog-detail', '礼物目录版本', '超级火箭', '高级礼物', '版本与审计']
    },
    {
      page: 'giftRequests' as const,
      data: { id: 'request-1', publicId: 'G-1001', orderId: 'order-1', orderPublicId: 'P-1001', orderParticipantId: 'participant-1', giftCatalogVersionId: 'gift-v1', giftCode: 'ROCKET', giftName: '超级火箭', amountMinor: 5200, currency: 'CAT', status: 'PENDING_REVIEW', rowVersion: 4, senderDisplayName: '用户 A', senderDiscordUsername: 'customer_a', receiverDisplayName: '陪玩 B', receiverDiscordUsername: 'player_b', reservationId: 'reservation-1', reservationStatus: 'ACTIVE', reservationExpiresAt: '2026-08-04T02:00:00Z', announcementStatus: 'NOT_QUEUED', createdAt: '2026-08-04T00:00:00Z', updatedAt: '2026-08-04T01:00:00Z' },
      markers: ['gift-request-detail', '送礼审核', '用户与目标陪玩', '审核与资金', '播报与生命周期']
    }
  ])('renders a structured $page detail instead of a raw field dump', ({ page, data, markers }) => {
    const model = buildAdminBusinessPage({ page, permissions: ['user.read', 'player.read', 'catalog.read', 'gift_catalog.read', 'gift_request.read'], status: 'READY', items: [] });
    const html = renderToStaticMarkup(createElement(AdminBusinessPage, { model, detail: { kind: 'READY', page, requestId: 'req-detail-layout', data }, onCloseDetail: () => undefined }));
    for (const marker of markers) expect(html).toContain(marker);
    expect(html).not.toContain('未映射字段：gameDisplayName');
    expect(html).not.toContain('未映射字段：serviceDisplayName');
    expect(html).not.toContain('可参与派单');
  });
});
