import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeFundingAdapter } from '@blackcat/api/funding-adapter-runtime';
import {
  SandboxFundingAdapter,
  type SandboxFundingStore
} from '@blackcat/api/sandbox-funding';
import type { Transaction } from '@blackcat/api/payment-adapter';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';

const now = '2026-07-19T12:00:00.000Z';

describe('M5-US-05 SandboxFundingAdapter', () => {
  it('rejects SANDBOX funding in PRODUCTION before using the database', () => {
    expect(() => createRuntimeFundingAdapter({
      BUSINESS_ENV: 'PRODUCTION',
      FUNDING_ADAPTER: 'SANDBOX',
      SANDBOX_BINDING_CODE_SECRET: 'x'.repeat(32)
    }, { pool: {} as never })).toThrow(/forbidden/u);
  });

  it('requires explicit environment selection and a strong binding secret', () => {
    expect(() => createRuntimeFundingAdapter({}, { pool: {} as never })).toThrow(/BUSINESS_ENV/u);
    expect(() => createRuntimeFundingAdapter({ BUSINESS_ENV: 'SANDBOX', FUNDING_ADAPTER: 'SANDBOX', SANDBOX_BINDING_CODE_SECRET: 'short' }, { pool: {} as never }))
      .toThrow(/at least 32/u);
  });

  it('advertises only the approved local-reservation fallback capabilities', async () => {
    const adapter = new SandboxFundingAdapter({ store: fakeStore(), bindingSecret: 'x'.repeat(32) });
    await expect(adapter.discoverCapabilities()).resolves.toMatchObject({
      providerKey: 'sandbox-provider',
      nativeHold: { supported: false },
      fallbackDebit: { supported: true, idempotentWrites: true, lookupByIdempotencyKey: true }
    });
  });

  it('keeps provider idempotency key contracts mode-specific and mirrored', async () => {
    const [
      openapi,
      openapiMirror,
      adapterContract,
      adapterContractMirror,
      providerSpec,
      providerSpecMirror,
      supplierChecklist,
      supplierChecklistMirror,
      mainSpec,
      mainSpecMirror
    ] = await Promise.all([
      readFile('outputs/P0开发交付包/02-API/openapi.yaml', 'utf8'),
      readFile('docs/P0开发交付包/02-API/openapi.yaml', 'utf8'),
      readFile('outputs/P0开发交付包/04-支付集成/adapter-contract.yaml', 'utf8'),
      readFile('docs/P0开发交付包/04-支付集成/adapter-contract.yaml', 'utf8'),
      readFile('outputs/P0开发交付包/04-支付集成/第三方支付与余额适配器规格.html', 'utf8'),
      readFile('docs/P0开发交付包/04-支付集成/第三方支付与余额适配器规格.html', 'utf8'),
      readFile('outputs/P0开发交付包/04-支付集成/供应商接入核对清单.csv', 'utf8'),
      readFile('docs/P0开发交付包/04-支付集成/供应商接入核对清单.csv', 'utf8'),
      readFile('outputs/Discord陪玩业务Bot最小原型设计开发文档.html', 'utf8'),
      readFile('docs/Discord陪玩业务Bot最小原型设计开发文档.html', 'utf8')
    ]);

    expect(openapiMirror).toBe(openapi);
    expect(adapterContractMirror).toBe(adapterContract);
    expect(providerSpecMirror).toBe(providerSpec);
    expect(supplierChecklistMirror).toBe(supplierChecklist);
    expect(mainSpecMirror).toBe(mainSpec);
    expect(openapi).toContain('localFallback: debit:order:{orderId}:v1');
    expect(openapi).toContain('providerNativeHold: capture:hold:{fundReservationId}:v{fundReservationVersion}');
    expect(adapterContract).toContain('fallbackOrderDebit: debit:order:{orderId}:v1');
    expect(adapterContract).toContain('fallbackGiftDebit: debit:gift:{giftRequestId}:v1');
    expect(adapterContract).not.toContain('fallbackDebit: debit:reservation:');
    expect(providerSpec).toContain('debit:order:{orderId}:v1');
    expect(providerSpec).toContain('debit:gift:{giftRequestId}:v1');
    expect(providerSpec).not.toContain('debit:reservation:');
    expect(supplierChecklist).toContain('debit:order/debit:gift');
    expect(supplierChecklist).not.toContain('debit:reservation');
    expect(mainSpec).toContain('debit:gift:{giftRequestId}:v1');
    expect(mainSpec).toContain('capture:hold:{fundReservationId}:v{fundReservationVersion}');
  });

  it('delegates idempotent debit/refund results and never mutates balance for unsupported holds', async () => {
    const store = fakeStore();
    const adapter = new SandboxFundingAdapter({ store, bindingSecret: 'x'.repeat(32) });
    const debitInput = {
      idempotencyKey: 'sandbox-debit-key-0001', fundReservationId: '00000000-0000-0000-0000-000000000101',
      fundReservationVersion: 1, externalUserId: 'sandbox-normal', amount: { amountMinor: 100, currency: 'CNY' as const },
      businessSource: 'ORDER' as const, businessReference: '00000000-0000-0000-0000-000000000201'
    };
    const first = await adapter.createReservationDebit(debitInput);
    const second = await adapter.createReservationDebit(debitInput);
    expect(second.providerRef).toBe(first.providerRef);
    await expect(adapter.createHold({ ...debitInput, expiresAt: now })).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    expect(store.createDebit).toHaveBeenCalledTimes(2);
  });

  it('maps a missing transaction lookup to RESOURCE_NOT_FOUND', async () => {
    const store = fakeStore();
    store.getTransaction.mockResolvedValueOnce(null);
    const adapter = new SandboxFundingAdapter({ store, bindingSecret: 'x'.repeat(32) });
    await expect(adapter.getTransaction({ lookupType: 'IDEMPOTENCY_KEY', lookupValue: 'missing-key-000000' }))
      .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('allows only a recently stepped-up L4 Dashboard actor to append a target-balance change', async () => {
    const store = fakeStore();
    const commit = vi.fn().mockResolvedValue(undefined);
    store.stageTargetBalance.mockResolvedValue({ data: { accountId: '00000000-0000-0000-0000-000000000001', providerBalanceMinor: 2_000,
      reservedMinor: 0, availableMinor: 2_000, currency: 'CNY', version: 2, fetchedAt: now }, commit });
    const audit = new InMemoryAuditSink();
    const server = buildApiServer({
      env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'test-token' },
      security: {
        auditSink: audit,
        idempotencyStore: new InMemoryIdempotencyStore(),
        dashboardSessions: {
          resolve: (token) => ({ ok: true as const, staff: { staffId: '00000000-0000-0000-0000-000000000010', userId: '00000000-0000-0000-0000-000000000011',
            level: token.includes('owner') ? 'L4_ADMIN_OWNER' as const : 'L3_OPERATIONS' as const, permissionsVersion: 1, status: 'ACTIVE' as const }, csrfToken: 'csrf' }),
          verifyCsrf: () => true,
          verifyRecentStepUp: (token) => token.includes('stepped')
        }
      },
      sandboxFunding: { store }
    });
    const body = { currency: 'CNY', targetProviderBalanceMinor: 2_000, expectedVersion: 1, reasonCode: 'SANDBOX_TEST_SETUP' };
    const denied = await server.inject({ method: 'POST', url: '/api/v1/admin/sandbox-funding/accounts/00000000-0000-0000-0000-000000000011/target-balance',
      headers: dashboardHeaders('staff-stepped', 'sandbox-route-denied-0001'), payload: body });
    const missingStepUp = await server.inject({ method: 'POST', url: '/api/v1/admin/sandbox-funding/accounts/00000000-0000-0000-0000-000000000011/target-balance',
      headers: dashboardHeaders('owner', 'sandbox-route-stepup-0001'), payload: body });
    const allowed = await server.inject({ method: 'POST', url: '/api/v1/admin/sandbox-funding/accounts/00000000-0000-0000-0000-000000000011/target-balance',
      headers: dashboardHeaders('owner-stepped', 'sandbox-route-allowed-0001'), payload: body });
    expect([denied.statusCode, missingStepUp.statusCode, allowed.statusCode]).toEqual([403, 428, 200]);
    expect(store.stageTargetBalance).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ action: 'SET_SANDBOX_TARGET_BALANCE', outcome: 'SUCCEEDED' }));
    expect(audit.records.filter((record) => record.action === 'SET_SANDBOX_TARGET_BALANCE' && record.outcome === 'REJECTED')).toHaveLength(2);
  });
});

function fakeStore() {
  const transaction: Transaction = {
    kind: 'FALLBACK_DEBIT', status: 'SUCCEEDED', idempotencyKey: 'sandbox-debit-key-0001',
    fundReservationId: '00000000-0000-0000-0000-000000000101', fundReservationVersion: 1,
    businessSource: 'ORDER', amount: { amountMinor: 100, currency: 'CNY' },
    businessReference: '00000000-0000-0000-0000-000000000201', providerRef: 'sandbox_tx_1',
    originalProviderRef: null, providerStatus: 'SUCCEEDED', observedAt: now, providerOccurredAt: now, failure: null
  };
  return {
    resolveAccount: vi.fn().mockResolvedValue({ id: '00000000-0000-0000-0000-000000000001', externalUserId: 'sandbox-normal', displayName: 'normal', currency: 'CNY', status: 'ACTIVE', version: 1 }),
    consumeBindingCodeHash: vi.fn().mockResolvedValue({ id: '00000000-0000-0000-0000-000000000001', externalUserId: 'sandbox-normal', displayName: 'normal', currency: 'CNY', status: 'ACTIVE', version: 1 }),
    resolveAccountIdForUser: vi.fn().mockResolvedValue('00000000-0000-0000-0000-000000000001'),
    getBalance: vi.fn().mockResolvedValue({ accountId: '00000000-0000-0000-0000-000000000001', providerBalanceMinor: 1_000, reservedMinor: 0, availableMinor: 1_000, currency: 'CNY', version: 1, fetchedAt: now }),
    stageTargetBalance: vi.fn(),
    createDebit: vi.fn().mockResolvedValue(transaction),
    createRefund: vi.fn().mockResolvedValue({ ...transaction, kind: 'REFUND', providerRef: 'sandbox_refund_1' }),
    getTransaction: vi.fn().mockResolvedValue(transaction)
  } satisfies SandboxFundingStore & Record<string, ReturnType<typeof vi.fn>>;
}

function dashboardHeaders(session: string, idempotencyKey: string) {
  return { cookie: `p0_session=${session}; p0_csrf=csrf`, 'x-csrf-token': 'csrf', 'x-client-source': 'DASHBOARD', 'idempotency-key': idempotencyKey };
}
