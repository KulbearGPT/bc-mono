import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { AdminBusinessPage } from '../apps/dashboard/src/AdminBusinessPage.js';
import { createLatestRequestSequence } from '../apps/dashboard/src/AdminBusinessRoute.js';
import {
  adminCollectionConfigs,
  buildAdminBusinessPage,
  buildAdminCollectionUrl,
  buildAdminResourceQuery,
  readAdminCollectionState,
  type AdminBusinessPageId
} from '@blackcat/dashboard/admin-business';

const pages: AdminBusinessPageId[] = ['orders','users','players','serviceCatalog','servicePackages','giftCatalog','giftRequests'];
const permissions = ['order.read','user.read','player.read','catalog.read','gift_catalog.read','gift_request.read'];

describe('M13-US-03 reusable Dashboard collection browsing', () => {
  test('defines explicit reusable sort options and table columns for all seven pages', () => {
    expect(Object.keys(adminCollectionConfigs)).toEqual(pages);
    expect(adminCollectionConfigs.orders.sortOptions.map((option) => option.id)).toEqual(['createdAt','updatedAt','amountMinor']);
    for (const page of pages) {
      const config = adminCollectionConfigs[page];
      expect(config.defaultSort).toEqual({ sortBy: 'createdAt', sortDirection: 'desc' });
      expect(config.columns.length).toBeGreaterThanOrEqual(4);
      expect(new Set(config.columns.map((column) => column.key)).size).toBe(config.columns.length);
    }
  });

  test('restores safe URL state, drops illegal values and serializes filters, sort and view', () => {
    expect(readAdminCollectionState('orders','?view=TABLE&sortBy=amountMinor&sortDirection=asc&status=IN_SERVICE&unknown=x')).toEqual({
      view: 'TABLE', sortBy: 'amountMinor', sortDirection: 'asc', filters: { status: 'IN_SERVICE' }
    });
    expect(readAdminCollectionState('users','?view=GRID&sortBy=amountMinor&sortDirection=sideways&query=cat')).toEqual({
      view: 'CARD', sortBy: 'createdAt', sortDirection: 'desc', filters: { query: 'cat' }
    });
    expect(buildAdminCollectionUrl('orders',{ view:'TABLE',sortBy:'amountMinor',sortDirection:'asc',filters:{status:'IN_SERVICE'} }))
      .toBe('/admin/orders?view=TABLE&sortBy=amountMinor&sortDirection=asc&status=IN_SERVICE');
    expect(buildAdminResourceQuery({ limit:25,sortBy:'amountMinor',sortDirection:'asc',status:'IN_SERVICE' }))
      .toBe('?limit=25&status=IN_SERVICE&sortBy=amountMinor&sortDirection=asc');
  });

  test.each(pages)('renders %s with one shared toolbar and CARD/TABLE parity', (page) => {
    const item = { id:`${page}-1`,playerId:`${page}-player`,publicId:'P-1',displayName:'示例对象',name:'示例礼物',giftName:'示例礼物',status:'ACTIVE',reviewStatus:'ACTIVE',amountMinor:100,priceMinor:100,customerUnitPriceMinor:100,defaultCustomerPriceMinor:100,currency:'CAT',createdAt:'2026-08-05T00:00:00.000Z',version:1 };
    const model=buildAdminBusinessPage({page,permissions,status:'READY',items:[item]});
    const card=renderToStaticMarkup(createElement(AdminBusinessPage,{model,view:'CARD',sortBy:'createdAt',sortDirection:'desc',activeFilters:{},onViewChange:()=>undefined,onSortChange:()=>undefined,onOpenDetail:()=>undefined}));
    const table=renderToStaticMarkup(createElement(AdminBusinessPage,{model,view:'TABLE',sortBy:'createdAt',sortDirection:'desc',activeFilters:{},onViewChange:()=>undefined,onSortChange:()=>undefined,onOpenDetail:()=>undefined}));
    expect(card).toContain('collection-toolbar');
    expect(card).toContain('aria-pressed="true"');
    expect(card).toMatch(/(?:order|business)-discussion-card/);
    expect(table).toContain('data-table');
    expect(table).toContain('collection-row-list');
    expect(table).toContain('查看详情');
  });

  test('retires response-shaped dynamic columns and guards URL/request races and responsive list mode', async () => {
    const sequence=createLatestRequestSequence();const first=sequence.begin();const second=sequence.begin();expect(sequence.isCurrent(first)).toBe(false);expect(sequence.isCurrent(second)).toBe(true);
    const [page,route,styles]=await Promise.all([
      readFile('apps/dashboard/src/AdminBusinessPage.tsx','utf8'),
      readFile('apps/dashboard/src/AdminBusinessRoute.tsx','utf8'),
      readFile('apps/dashboard/src/styles.css','utf8')
    ]);
    expect(page).not.toContain('collectColumns(');
    expect(route).toContain('requestSequence');
    expect(route).toContain('window.history.replaceState');
    expect(route).toMatch(/onViewChange[\s\S]*setView/);
    expect(styles).toContain('.collection-row-list');
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*\.collection-desktop-table/);
    expect(styles).toMatch(/\.collection-toolbar\s*\+\s*:is\(\.order-discussion-grid,\s*\.business-discussion-grid\)\s*\{[^}]*margin-top:\s*12px/u);
  });
});
