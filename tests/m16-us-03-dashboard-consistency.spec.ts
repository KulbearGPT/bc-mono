import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { CustomerWalletPanel } from '../apps/dashboard/src/CustomerWalletPanel.js';
import {
  formatWalletMoney,
  parseWalletBalance,
  parseWalletEntryPage,
  walletInputLabel,
  walletInputToSubunits
} from '@blackcat/dashboard/customer-wallet';
import { formatSettlementPayout } from '../apps/dashboard/src/SettlementPage.js';
import { LatestRequestGate, runBusyTask } from '../apps/dashboard/src/request-state.js';
import { RetriableWriteKeys } from '../apps/dashboard/src/request-state.js';
import { SecurityPage } from '../apps/dashboard/src/SecurityPage.js';
import { readFileSync } from 'node:fs';

describe('M16-US-03 Dashboard CAT and request consistency', () => {
  test('uses CAT for wallet facts while keeping only top-up input in USD', () => {
    expect(formatWalletMoney(2_550)).toBe('255.0 猫条');
    expect(walletInputToSubunits('TOP_UP', 25.5)).toBe(2_550);
    expect(walletInputToSubunits('CASH_REFUND_DEBIT', 12.5)).toBe(125);
    expect(walletInputToSubunits('ADJUSTMENT', 12.5)).toBe(125);

    const html = renderToStaticMarkup(createElement(CustomerWalletPanel, {
      userId: '00000000-0000-0000-0000-000000016301',
      balance: { ledgerBalanceMinor: 2_550, reservedMinor: 50, availableMinor: 2_500, currency: 'CAT', calculatedAt: '2026-08-06T12:00:00Z', version: 2 },
      entries: [], busy: false, canTopUp: true, canExternalRefund: true,
      onTopUp: () => undefined, onExternalRefund: () => undefined, canAdjust: true
    }));
    expect(html).toContain('255.0 猫条');
    expect(html).toContain('实收金额（USD）');
    expect(walletInputLabel('CASH_REFUND_DEBIT')).toBe('扣回金额（CAT）');
    expect(walletInputLabel('ADJUSTMENT')).toBe('冲正金额（CAT）');
    expect(html).not.toContain('canonical USD');
  });

  test('validates the wallet balance and page envelope without double assertions', () => {
    expect(parseWalletBalance({ ledgerBalanceMinor: 100, reservedMinor: 20, availableMinor: 80, currency: 'CAT', calculatedAt: '2026-08-06T12:00:00Z', version: 1 }))
      .toMatchObject({ availableMinor: 80, currency: 'CAT' });
    expect(parseWalletBalance({ ledgerBalanceMinor: 100, reservedMinor: 20, availableMinor: 80, currency: 'USD', calculatedAt: '2026-08-06T12:00:00Z', version: 1 })).toBeNull();
    expect(parseWalletEntryPage({ items: [], nextCursor: 'next-page' })).toEqual({ items: [], nextCursor: 'next-page' });
    expect(parseWalletEntryPage([])).toBeNull();
  });

  test('ignores stale object responses and always clears mutation busy state', async () => {
    const gate = new LatestRequestGate();
    const applied: string[] = [];
    let resolveA!: (value: string) => void;
    let resolveB!: (value: string) => void;
    const a = new Promise<string>((resolve) => { resolveA = resolve; });
    const b = new Promise<string>((resolve) => { resolveB = resolve; });
    const load = async (value: Promise<string>) => {
      const request = gate.begin();
      const result = await value;
      if (request.isCurrent()) applied.push(result);
    };
    const pendingA = load(a);
    const pendingB = load(b);
    resolveB('customer-b');
    await pendingB;
    resolveA('customer-a');
    await pendingA;
    expect(applied).toEqual(['customer-b']);

    const busy: boolean[] = [];
    await expect(runBusyTask((value) => busy.push(value), async () => { throw new Error('network failed'); }))
      .rejects.toThrow('network failed');
    expect(busy).toEqual([true, false]);

    const route = readFileSync(new URL('../apps/dashboard/src/CustomerProfileRoute.tsx', import.meta.url), 'utf8');
    expect(route).toContain('LatestRequestGate');
    expect(route).toContain('Promise.allSettled');
    expect(route).not.toContain('as unknown as');
  });

  test('shows player settlement in canonical CAT and payout USD together', () => {
    expect(formatSettlementPayout(4_000)).toBe('400.0 猫条 · USD 40.00');
  });

  test('renders wallet writes from explicit capabilities and keeps read-only access non-actionable', () => {
    const html = renderToStaticMarkup(createElement(CustomerWalletPanel, {
      userId: 'user-l1',
      balance: { ledgerBalanceMinor: 100, reservedMinor: 0, availableMinor: 100, currency: 'CAT', calculatedAt: '2026-08-06T12:00:00Z', version: 1 },
      entries: [], busy: false, canTopUp: false, canExternalRefund: false, canAdjust: false
    }));
    expect(html).toContain('充值需要 L2 及以上权限');
    expect(html).toContain('渠道退款需要 L2 及以上权限');
    expect(html).not.toContain('确认充值');
    expect(html).not.toContain('确认扣款');

    const route = readFileSync(new URL('../apps/dashboard/src/CustomerProfileRoute.tsx', import.meta.url), 'utf8');
    expect(route).toContain("permissions.includes('wallet.top_up')");
    expect(route).toContain("permissions.includes('wallet.external_refund')");
  });

  test('reuses an idempotency key until the exact logical write succeeds', () => {
    const keys = new RetriableWriteKeys();
    let generated = 0;
    const create = () => `key-${++generated}`;
    expect(keys.get('adjust:user-1:entry-1', create)).toBe('key-1');
    expect(keys.get('adjust:user-1:entry-1', create)).toBe('key-1');
    expect(keys.get('adjust:user-1:entry-2', create)).toBe('key-2');
    keys.complete('adjust:user-1:entry-1');
    expect(keys.get('adjust:user-1:entry-1', create)).toBe('key-3');

    const route = readFileSync(new URL('../apps/dashboard/src/CustomerProfileRoute.tsx', import.meta.url), 'utf8');
    expect(route).toContain('RetriableWriteKeys');
    expect(route).toContain('writeKeys.current.get');
  });

  test('formats execution thresholds in the capability currency', () => {
    const html = renderToStaticMarkup(createElement(SecurityPage, { capabilities: {
      permissions: ['mfa.manage_self'],
      thresholds: { giftApprovalLimitMinor: 2_550, refundLimitMinor: 1_000, l4DirectExecutionFromMinor: 5_000, currency: 'CAT' }
    } }));
    expect(html).toContain('255.0 猫条');
    expect(html).toContain('100.0 猫条');
    expect(html).not.toContain('¥');
  });
});
