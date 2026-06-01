import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminBusinessPage } from '../apps/dashboard/src/AdminBusinessPage.js';
import { buildAdminBusinessPage, buildAdminOrderTimelineRequest, readAdminOrderTimeline } from '@blackcat/dashboard/admin-business';

const timeline = { items: [
  { id:'a1',type:'CONSUMPTION',status:'SUCCEEDED',direction:'DEBIT',amountMinor:12000,currency:'CAT',occurredAt:'2026-07-18T20:00:00Z' },
  { id:'a2',type:'COMMISSION_ADJUSTMENT',status:'REVERSAL',direction:'DEBIT',amountMinor:120,currency:'CAT',occurredAt:'2026-07-18T21:00:00Z' }
], nextCursor:'signed-next' };

describe('M4-US-08 Dashboard transaction timeline',()=>{
  test('renders a dedicated read-only timeline with direction, adjustments and pagination',()=>{
    const model=buildAdminBusinessPage({page:'orders',permissions:['order.read'],status:'READY',items:[{id:'order-1'}]});
    const html=renderToStaticMarkup(createElement(AdminBusinessPage,{model,detail:{kind:'READY',page:'orders',requestId:'req_detail',data:{order:{id:'order-1',publicId:'P-1',status:'COMPLETED',amountMinor:12000,currency:'CAT',updatedAt:'2026-07-18T21:00:00Z'},timeline}}}));
    expect(html).toContain('交易时间线');
    expect(html).toContain('COMMISSION_ADJUSTMENT');
    expect(html).toContain('加载更多记录');
    expect(html).not.toMatch(/删除|编辑|返佣受益人|推荐用户/);
  });

  test('keeps loaded facts visible when the next page fails and shows the request id',()=>{
    const model=buildAdminBusinessPage({page:'orders',permissions:['order.read'],status:'READY',items:[{id:'order-1'}]});
    const html=renderToStaticMarkup(createElement(AdminBusinessPage,{model,detail:{kind:'READY',page:'orders',requestId:'req_detail',data:{order:{id:'order-1'},timeline},timelinePage:{kind:'ERROR',requestId:'req_timeline_error'}}}));
    expect(html).toContain('CONSUMPTION');
    expect(html).toContain('req_timeline_error');
  });

  test('builds a bounded cursor request and handles empty timeline payloads',()=>{
    expect(buildAdminOrderTimelineRequest('order/1','signed cursor')).toBe('/api/v1/admin/orders/order%2F1?timelineCursor=signed+cursor&timelineLimit=25');
    expect(readAdminOrderTimeline({})).toEqual({items:[],nextCursor:null});
  });
});
