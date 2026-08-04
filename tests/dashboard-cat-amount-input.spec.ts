import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { AdminBusinessPage } from '../apps/dashboard/src/AdminBusinessPage.js';
import {
  buildAddOrderParticipantRequest,
  buildAdminActionRequest,
  buildAdminBusinessPage,
  catInputToMinor,
  minorToCatInput
} from '../apps/dashboard/src/admin-business.js';

describe('Dashboard CAT amount input', () => {
  test('converts one-decimal CAT input to the canonical integer API amount', () => {
    expect(catInputToMinor('0.1')).toBe(1);
    expect(catInputToMinor('12.3')).toBe(123);
    expect(catInputToMinor('5200')).toBe(52_000);
    expect(minorToCatInput(123)).toBe('12.3');
    expect(minorToCatInput(52_000)).toBe('5200');
    expect(() => catInputToMinor('12.34')).toThrow(/一位小数/u);
  });

  test('converts every employee CAT form back to the API amount contract', () => {
    expect(buildAdminActionRequest({
      actionId: 'REFUND_ORDER',
      item: { id: 'order-1', version: 2, status: 'COMPLETED' },
      fields: { amountCat: '360.5', currency: 'CAT', reasonCode: 'PARTIAL_SERVICE_REFUND', evidenceNote: '双方确认部分退款。' }
    }).body).toMatchObject({ amount: { amountMinor: 3605, currency: 'CAT' } });

    expect(buildAdminActionRequest({
      actionId: 'CANCEL_ORDER_RESOLUTION',
      item: { id: 'order-1', version: 3, status: 'IN_SERVICE' },
      fields: { refundAmountCat: '5000', playerEarningCat: '2000.5', currency: 'CAT', reasonCode: 'SERVICE_INTERRUPTED', evidenceNote: '已核对服务记录。' }
    }).body).toMatchObject({ refund: { amountMinor: 50_000 }, playerEarning: { amountMinor: 20_005 } });

    expect(buildAdminActionRequest({
      actionId: 'CREATE_GIFT',
      fields: { name: '火箭', giftCategoryTagId: 'gift-1', amountCat: '5200', currency: 'CAT', enabled: true, broadcastTemplate: '{sender} 送出 {gift}', reasonCode: 'INITIAL_GIFT_VERSION' }
    }).body).toMatchObject({ price: { amountMinor: 52_000, currency: 'CAT' } });

    expect(buildAdminActionRequest({
      actionId: 'CREATE_SERVICE_VERSION',
      fields: { gameTagId: 'game-1', serviceTagId: 'service-1', regionTagId: '', billingUnitMinutes: '60', minimumUnits: '1', customerAmountCat: '600', defaultPlayerPayoutPercent: '66.67', currency: 'CAT', enabled: true, reasonCode: 'INITIAL_VERSION' }
    }).body).toMatchObject({ customerUnitPrice: { amountMinor: 6000 }, playerUnitPayout: { amountMinor: 4000 } });

    expect(buildAddOrderParticipantRequest('order-1', {
      playerId: 'player-1', serviceCatalogVersionId: 'catalog-1', unitCount: '2', linePriceCat: '24.5', expectedOrderVersion: '1', reasonCode: 'ADD_PLAYER'
    }).body).toMatchObject({ linePriceMinor: 245 });
  });

  test('renders CAT values and never asks employees to enter implementation units', () => {
    const order = { id: 'order-1', version: 2, status: 'COMPLETED', amountMinor: 12_000, refundableAmountMinor: 3605, currency: 'CAT' };
    const model = buildAdminBusinessPage({ page: 'orders', permissions: ['order.read', 'refund.execute'], status: 'READY', items: [order] });
    const html = renderToStaticMarkup(createElement(AdminBusinessPage, {
      model,
      activeAction: { action: model.actions.find((action) => action.id === 'REFUND_ORDER')!, item: order }
    }));
    const source = readFileSync('apps/dashboard/src/AdminBusinessPage.tsx', 'utf8');

    expect(html).toContain('退款金额（猫条）');
    expect(html).toContain('name="amountCat"');
    expect(html).toContain('max="360.5"');
    expect(html).toContain('最多可提交 360.5 猫条');
    expect(source).not.toMatch(/CAT subunit|CAT 最小单位/u);
  });
});
