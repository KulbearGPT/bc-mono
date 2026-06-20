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
});
