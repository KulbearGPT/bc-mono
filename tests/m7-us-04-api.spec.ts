import { describe, expect, test } from 'vitest';
import { resolveStaffPolicy } from '@blackcat/api/authorization-policy';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore, type StaffAccount } from '@blackcat/api/security';
import { InMemoryWalletStore, WalletService } from '@blackcat/api/wallet';
import { PrivateFileReceiptStorage } from '@blackcat/api/receipt-storage';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userId = '00000000-0000-0000-0000-000000007411';
const staff: StaffAccount = { staffId: '00000000-0000-0000-0000-000000007412', userId: '00000000-0000-0000-0000-000000007413',
  level: 'L2_SUPERVISOR', permissionsVersion: 1, status: 'ACTIVE' };
const audit = new InMemoryAuditSink();
const env = { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token', PAGINATION_CURSOR_SIGNING_SECRET: 'm7-wallet-test-signing-secret-32-bytes' };
const dashboardSessions = {
  resolve: () => ({ ok: true as const, staff, csrfToken: 'csrf' }),
  verifyCsrf: () => true
};
const headers = { cookie: 'p0_session=session; p0_csrf=csrf', 'x-csrf-token': 'csrf', 'x-client-source': 'DASHBOARD',
  'idempotency-key': 'm7:api:topup:0001' };

describe('M7-US-04 wallet API authorization', () => {
  test('assigns cumulative wallet permissions at their approved minimum levels', () => {
    expect(resolveStaffPolicy('L1_SUPPORT').permissions).toContain('wallet.read');
    expect(resolveStaffPolicy('L2_SUPERVISOR').permissions).toEqual(expect.arrayContaining(['wallet.top_up','wallet.external_refund']));
    expect(resolveStaffPolicy('L3_OPERATIONS').permissions).toContain('wallet.adjust');
  });

  test('credits USD receipt cents immediately for L2 and emits three affected-object audit changes', async () => {
    const service = new WalletService(new InMemoryWalletStore());
    const server = buildApiServer({ env, security: { dashboardSessions, stepUpVerifier:{verify:()=>true}, auditSink: audit, idempotencyStore: new InMemoryIdempotencyStore() },
      wallet: { service, now: () => new Date('2026-07-21T16:30:00Z') } });
    const response = await server.inject({ method: 'POST', url: `/api/v1/admin/users/${userId}/top-ups`, headers,
      payload: { paidAmountUsdCents: 500_000, paymentMethod: 'ZELLE', receiptNumber: 'pi_api_1',
        paidAt: '2026-07-21T16:00:00Z', note: 'receipt verified',reasonCode:'MANUAL_TOP_UP' } });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data.balance).toMatchObject({ availableMinor: 500_000, currency: 'CAT' });
    expect(audit.records.at(-1)).toMatchObject({ outcome: 'SUCCEEDED', changes: [
      { targetType: 'wallet_account' }, { targetType: 'top_up' }, { targetType: 'wallet_entry' }
    ] });
  });

  test('requires recent step-up without crediting the wallet', async () => {
    const service = new WalletService(new InMemoryWalletStore());
    const server = buildApiServer({ env, security: { dashboardSessions, auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() },
      wallet: { service } });
    const response = await server.inject({ method: 'POST', url: `/api/v1/admin/users/${userId}/top-ups`,
      headers: { ...headers, 'idempotency-key': 'm7:api:topup:0002' }, payload: { paidAmountUsdCents: 500_001, paymentMethod: 'PAYPAL',
        receiptNumber: 'pp_api_2', paidAt: '2026-07-21T16:00:00Z', note: 'receipt verified',reasonCode:'MANUAL_TOP_UP' } });
    expect(response.statusCode).toBe(428);
    expect((await service.getBalance({ userId, now: new Date() })).ledgerBalanceMinor).toBe(0);
  });

  test('uploads an optional PDF only after binding it to an existing top-up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm7-api-receipt-'));
    try {
      const service = new WalletService(new InMemoryWalletStore());
      const server = buildApiServer({ env, security: { dashboardSessions, stepUpVerifier:{verify:()=>true}, auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() },
        wallet: { service, receiptStorage: new PrivateFileReceiptStorage(root), now: () => new Date('2026-07-21T16:30:00Z') } });
      const topUp = await server.inject({ method: 'POST', url: `/api/v1/admin/users/${userId}/top-ups`, headers: { ...headers, 'idempotency-key': 'm7:api:receipt:topup' },
        payload: { paidAmountUsdCents: 100, paymentMethod: 'BANK_TRANSFER', receiptNumber: 'card_receipt_1', paidAt: '2026-07-21T16:00:00Z', note: 'checked',reasonCode:'MANUAL_TOP_UP' } });
      const topUpId = topUp.json().data.id as string;
      const boundary = '----m7receiptboundary';
      const body = Buffer.from([`--${boundary}\r\nContent-Disposition: form-data; name="evidenceType"\r\n\r\nTOP_UP\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="evidenceId"\r\n\r\n${topUpId}\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF receipt\r\n`,
        `--${boundary}--\r\n`].join(''));
      const response = await server.inject({ method: 'POST', url: `/api/v1/admin/users/${userId}/receipt-attachments`,
        headers: { ...headers, 'idempotency-key': 'm7:api:receipt:upload', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json().data).toMatchObject({ mediaType: 'application/pdf', originalFileName: 'receipt.pdf', sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
      expect(response.body).not.toContain('storageKey');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
