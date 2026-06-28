import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import {
  buildSettlementNavigation,
  buildSettlementPage,
  buildSettlementRequest,
  type SettlementPageModel
} from '@blackcat/dashboard/settlements';
import {
  buildCustomerProfileRequests,
  buildCustomerProfileView,
  type CustomerProfileModules
} from '@blackcat/dashboard/customer-profile';
import { SettlementPage } from '../apps/dashboard/src/SettlementPage.js';
import { CustomerProfilePage } from '../apps/dashboard/src/CustomerProfilePage.js';

describe('M6-US-04 Dashboard settlement and profiles', () => {
  test('derives work navigation from server capabilities', () => {
    expect(buildSettlementNavigation(['settlement.read', 'weekly_report.read', 'customer_profile.read'])).toEqual([
      { id: 'settlements', label: '结算', href: '/settlements' },
      { id: 'reports', label: '周报', href: '/reports' },
      { id: 'profiles', label: '客户 Profile', href: '/admin/users' }
    ]);
    expect(buildSettlementNavigation([])).toEqual([]);
  });

  test('maps preview, create, review, export and payment result commands to unified API', () => {
    const period = { periodStart: '2026-07-13T16:00:00.000Z', periodEnd: '2026-07-19T16:00:00.000Z',
      cutoffAt: '2026-07-19T16:00:00.000Z', timeZone: 'Asia/Shanghai', currency: 'CAT' };
    expect(buildSettlementRequest({ action: 'PREVIEW', fields: period })).toEqual({ method: 'POST', path: '/api/v1/admin/settlement-batches/preview', body: { ...period, source: 'MANUAL', playerUserIds: null } });
    expect(buildSettlementRequest({ action: 'CREATE', fields: period })).toEqual({ method: 'POST', path: '/api/v1/admin/settlement-batches', body: { ...period, source: 'MANUAL', playerUserIds: null } });
    expect(buildSettlementRequest({ action: 'SUBMIT', batchId: 'batch-1', version: 2, fields: { reasonCode: 'WEEKLY_REVIEW' } })).toEqual({
      method: 'POST', path: '/api/v1/admin/settlement-batches/batch-1/submit', body: { expectedVersion: 2, reasonCode: 'WEEKLY_REVIEW' }
    });
    expect(buildSettlementRequest({ action: 'EXPORT', batchId: 'batch-1', fields: { exportType: 'TRANSFER_LIST' } })).toEqual({
      method: 'GET', path: '/api/v1/admin/settlement-batches/batch-1/exports/TRANSFER_LIST', body: null
    });
    expect(buildSettlementRequest({ action: 'PAYMENT_RESULTS', batchId: 'batch-1', version: 3, fields: { results: [{ settlementItemId: 'item-1', expectedVersion: 1,
      result: 'FAILED', amountMinor: 0, currency: 'CAT', externalBatchReference: '', note: 'Provider rejected row' }] } })).toMatchObject({
      method: 'POST', path: '/api/v1/admin/settlement-batches/batch-1/payment-results', body: { expectedBatchVersion: 3,
        results: [{ externalBatchReference: null, note: 'Provider rejected row' }] }
    });
  });

  test('preserves the atomic replacement contract when voiding a finalized settlement batch', () => {
    const replacement = {
      source: 'MANUAL',
      periodStart: '2026-07-13T16:00:00.000Z',
      periodEnd: '2026-07-19T16:00:00.000Z',
      cutoffAt: '2026-07-19T16:00:00.000Z',
      timeZone: 'Asia/Shanghai',
      currency: 'CAT',
      playerUserIds: null
    };
    expect(buildSettlementRequest({
      action: 'VOID',
      batchId: 'batch-1',
      version: 4,
      fields: {
        reasonCode: 'REPLACED_AFTER_REVIEW',
        replacementBatchId: '00000000-0000-0000-0000-000000006901',
        replacement
      }
    })).toEqual({
      method: 'POST',
      path: '/api/v1/admin/settlement-batches/batch-1/void',
      body: {
        expectedVersion: 4,
        reasonCode: 'REPLACED_AFTER_REVIEW',
        replacementBatchId: '00000000-0000-0000-0000-000000006901',
        replacement
      }
    });
    expect(buildSettlementRequest({
      action: 'VOID', batchId: 'batch-2', version: 1, fields: { reasonCode: 'DRAFT_CREATED_IN_ERROR' }
    })).toEqual({
      method: 'POST', path: '/api/v1/admin/settlement-batches/batch-2/void',
      body: { expectedVersion: 1, reasonCode: 'DRAFT_CREATED_IN_ERROR' }
    });
    expect(() => buildSettlementRequest({
      action: 'VOID', batchId: 'batch-3', version: 2,
      fields: { reasonCode: 'INCOMPLETE_REPLACEMENT', replacementBatchId: '00000000-0000-0000-0000-000000006902' }
    })).toThrow(/replacementBatchId and replacement/u);
  });

  test('keeps destructive settlement actions restricted and models partial failures', () => {
    const l3 = buildSettlementPage({ section: 'settlements', permissions: ['settlement.read', 'settlement.manage', 'settlement.approve'],
      status: 'READY', items: [{ id: 'batch-1', status: 'PARTIALLY_PAID', version: 4, netAmountMinor: 30_000, currency: 'CAT',
        items: [{ id: 'item-1', paymentStatus: 'SUCCEEDED' }, { id: 'item-2', paymentStatus: 'FAILED' }] }] });
    expect(l3.actions).toContain('PAYMENT_RESULTS');
    expect(l3.actions).not.toContain('VOID');
    expect(l3.alert).toMatch(/1.*失败/u);
    const l4 = buildSettlementPage({ section: 'settlements', permissions: ['settlement.read', 'settlement.void'], status: 'READY', items: [] });
    expect(l4.actions).toContain('VOID');
  });

  test('renders loading, empty and request-id error states for settlement and report worklists', () => {
    for (const model of [
      buildSettlementPage({ section: 'settlements', permissions: ['settlement.read'], status: 'LOADING', items: [] }),
      buildSettlementPage({ section: 'reports', permissions: ['weekly_report.read'], status: 'READY', items: [] }),
      buildSettlementPage({ section: 'reports', permissions: ['weekly_report.read'], status: 'ERROR', items: [], requestId: 'req-report' })
    ]) {
      const html = renderToStaticMarkup(createElement(SettlementPage, { model, onAction: () => undefined, onRetry: () => undefined }));
      expect(html).toMatch(/正在载入|暂无|req-report/u);
    }
  });

  test('renders the canonical CAT currency in the settlement builder', () => {
    const model = buildSettlementPage({
      section: 'settlements',
      permissions: ['settlement.read', 'settlement.manage'],
      status: 'READY',
      items: []
    });
    const html = renderToStaticMarkup(createElement(SettlementPage, {
      model,
      onAction: () => undefined,
      onRetry: () => undefined
    }));

    expect(html).toContain('<option value="CAT" selected="">CAT</option>');
    expect(html).not.toContain('<option value="USD"');
  });

  test('requires explicit per-item payment outcomes instead of fabricating failed facts', () => {
    const source = readFileSync('apps/dashboard/src/SettlementPage.tsx', 'utf8');
    expect(source).not.toContain('MANUAL_REVIEW_REQUIRED');
    expect(source).not.toMatch(/action === 'PAYMENT_RESULTS'[\s\S]*result: 'FAILED'/u);
    expect(source).toContain('请选择结果');
    expect(source).toContain('第三方批次号');
    expect(source).toContain('确认登记');
  });

  test('builds independent Profile requests and keeps a balance failure from hiding statistics or orders', () => {
    expect(buildCustomerProfileRequests('customer/1', 'DAYS_90')).toEqual({
      summary: '/api/v1/admin/users/customer%2F1/profile-summary?window=DAYS_90',
      orders: '/api/v1/admin/users/customer%2F1/orders?limit=25',
      consumptions: '/api/v1/admin/users/customer%2F1/consumptions?limit=25'
    });
    const modules: CustomerProfileModules = {
      identity: { kind: 'READY', data: { userId: customerId, displayName: '客户甲', discordUserId: '900000000000006410', status: 'ACTIVE', externalAccountDisplay: 'mock:***1234' } },
      balance: { kind: 'ERROR', requestId: 'req_provider_timeout', data: { ledgerBalanceMinor: 8_000, reservedMinor: 12_000, availableMinor: -4_000, currency: 'CAT', calculatedAt: '2026-07-18T10:00:00.000Z', stale: true } },
      statistics: { kind: 'READY', data: { orderCount: 3, completedOrderCount: 2, cancelledOrderCount: 1, refundCount: 1, orderSpendMinor: 30_001,
        giftSpendMinor: 2_500, refundMinor: 1_500, totalConsumptionMinor: 31_001, averageOrderAmountMinor: 15_000, currency: 'CAT' } },
      orders: { kind: 'READY', items: [{ id: 'order-1', publicId: 'P-1', status: 'COMPLETED', serviceKey: 'RANKED', playerDisplayName: '陪玩甲', amountMinor: 10_001, currency: 'CAT', createdAt: '2026-07-18T12:00:00.000Z' }], nextCursor: null },
      consumptions: { kind: 'EMPTY', items: [], nextCursor: null },
      preferences: { kind: 'READY', data: { preferredGameKeys: ['VALORANT'], preferredServiceKeys: ['RANKED'], preferredPlayerUserIds: [playerId] } },
      internal: { kind: 'READY', notes: [{ id: 'note-1', text: '仅供客服跟进', createdAt: '2026-07-18T13:00:00.000Z' }], riskFlags: ['PAYMENT_ANOMALY'] }
    };
    const view = buildCustomerProfileView(modules);
    const html = renderToStaticMarkup(createElement(CustomerProfilePage, { model: view, window: 'DAYS_90', onWindowChange: () => undefined,
      onRetryModule: () => undefined, onNextOrders: () => undefined, onNextConsumptions: () => undefined }));
    expect(html).toContain('req_provider_timeout');
    expect(html).toContain('3');
    expect(html).toContain('P-1');
    expect(html).toContain('-400.0 猫条');
    expect(html.toLowerCase()).not.toMatch(/beneficiary|commission|profitminor|marginminor|referral/u);
  });

  test('renders a balance error with no snapshot without hiding ready Profile modules', () => {
    const modules: CustomerProfileModules = {
      identity: { kind: 'READY', data: { userId: customerId, displayName: '客户甲', status: 'ACTIVE' } },
      balance: { kind: 'ERROR', requestId: 'req_no_snapshot' },
      statistics: { kind: 'READY', data: { orderCount: 2, completedOrderCount: 1, cancelledOrderCount: 0, refundCount: 0,
        orderSpendMinor: 10_000, giftSpendMinor: 0, totalConsumptionMinor: 10_000, averageOrderAmountMinor: 10_000, currency: 'CAT' } },
      orders: { kind: 'READY', items: [{ id: 'order-2', publicId: 'P-NO-SNAPSHOT', status: 'COMPLETED', amountMinor: 10_000, currency: 'CAT' }], nextCursor: null },
      consumptions: { kind: 'EMPTY', items: [], nextCursor: null }, preferences: { kind: 'READY', data: {} },
      internal: { kind: 'READY', notes: [{ id: 'note-2', text: '仍可查看的备注', createdAt: '2026-07-19T10:00:00.000Z' }], riskFlags: [] }
    };
    const html = renderToStaticMarkup(createElement(CustomerProfilePage, { model: buildCustomerProfileView(modules), window: 'DAYS_30',
      onWindowChange: () => undefined, onRetryModule: () => undefined, onNextOrders: () => undefined, onNextConsumptions: () => undefined }));
    expect(html).toContain('req_no_snapshot');
    expect(html).toContain('客户甲');
    expect(html).toContain('P-NO-SNAPSHOT');
    expect(html).toContain('仍可查看的备注');
  });

  test('uses bounded cards, responsive tracks and horizontal table containment', () => {
    for (const path of ['apps/dashboard/src/SettlementPage.tsx', 'apps/dashboard/src/CustomerProfilePage.tsx']) {
      const source = readFileSync(path, 'utf8');
      expect(source).toContain('content-panel');
      expect(source).toContain('table-scroll');
      expect(source).toContain('dashboard-page');
      expect(source).not.toContain('style={{');
      expect(source).not.toMatch(/fontSize:\s*['"`]?[0-9.]+vw/u);
    }
    const styles = readFileSync('apps/dashboard/src/styles.css', 'utf8');
    expect(styles).toContain('220px minmax(0, 1fr)');
    expect(styles).toMatch(/\.content-panel[\s\S]*border-radius:\s*var\(--radius-lg\)/u);
    expect(styles).toMatch(/\.table-scroll[\s\S]*overflow-x:\s*auto/u);
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/u);
  });
});

const customerId = '00000000-0000-0000-0000-000000006410';
const playerId = '00000000-0000-0000-0000-000000006412';
