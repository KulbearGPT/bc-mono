import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, test } from 'vitest';
import { AdminBusinessPage } from '../apps/dashboard/src/AdminBusinessPage.js';
import { buildAdminActionRequest, buildAdminBusinessPage } from '../apps/dashboard/src/admin-business.js';

const order = { id: 'order-completed-1', publicId: 'P-REFUND-001', version: 7, status: 'COMPLETED', amountMinor: 12_000, currency: 'CAT' };

describe('M15-US-02 standalone order refund', () => {
  test('exposes a separate refund action without cancelling the order', () => {
    const model = buildAdminBusinessPage({ page: 'orders', permissions: ['order.read', 'order.resolve', 'refund.execute'], status: 'READY', items: [order] });
    expect(model.actions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'REFUND_ORDER', label: '独立退款' })]));
    const html = renderToStaticMarkup(createElement(AdminBusinessPage, { model, activeAction: { action: model.actions.find((action) => action.id === 'REFUND_ORDER')!, item: order } }));
    expect(html).toContain('独立退款操作表单');
    expect(html).toContain('name="amountCat"');
    expect(html).toContain('不会取消订单');
  });

  test('maps the form to refundOrder with version, canonical currency and evidence', () => {
    expect(buildAdminActionRequest({ actionId: 'REFUND_ORDER', item: order, fields: { amountCat: '360', currency: 'CAT', reasonCode: 'PARTIAL_SERVICE_REFUND', evidenceNote: '客户完成后反馈掉线，双方确认退还三成。' } })).toEqual({
      method: 'POST', path: '/api/v1/admin/orders/order-completed-1/refund', body: {
        expectedVersion: 7, amount: { amountMinor: 3600, currency: 'CAT' }, reasonCode: 'PARTIAL_SERVICE_REFUND', evidenceNote: '客户完成后反馈掉线，双方确认退还三成。'
      }
    });
  });
});
