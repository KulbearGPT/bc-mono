import { describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryWalletStore,
  WalletError,
  WalletService
} from '@blackcat/api/wallet';
import { PrivateFileReceiptStorage } from '@blackcat/api/receipt-storage';

const now = new Date('2026-07-21T16:00:00.000Z');
const userId = '00000000-0000-0000-0000-000000007401';
const staffId = '00000000-0000-0000-0000-000000007402';

function service() {
  return new WalletService(new InMemoryWalletStore());
}

describe('M7-US-04 internal USD wallet domain', () => {
  test('creates one USD wallet automatically and credits a required receipt reference immediately', async () => {
    const wallet = service();
    const result = await wallet.createTopUp({
      userId, amountMinor: 500_000, paymentChannel: 'ZELLE', externalTransactionId: 'pi_m7_001',
      paidAt: now.toISOString(), note: 'receipt checked', idempotencyKey: 'm7:topup:1',
      actorStaffId: staffId, actorLevel: 'L2_SUPERVISOR', now
    });
    expect(result).toMatchObject({ amountMinor: 500_000, currency: 'CAT', balance: {
      ledgerBalanceMinor: 500_000, reservedMinor: 0, availableMinor: 500_000, currency: 'CAT', version: 2
    }});
    expect(await wallet.getBalance({ userId, now })).toMatchObject({ availableMinor: 500_000 });
    await expect(wallet.createTopUp({
      userId, amountMinor: 1, paymentChannel: 'ZELLE', externalTransactionId: 'pi_m7_001',
      paidAt: now.toISOString(), note: 'duplicate', idempotencyKey: 'm7:topup:2',
      actorStaffId: staffId, actorLevel: 'L2_SUPERVISOR', now
    })).rejects.toMatchObject({ code: 'DUPLICATE_EXTERNAL_TRANSACTION' });
  });

  test('requires L2 for every manual top-up and validates every mandatory field', async () => {
    const wallet = service();
    await expect(wallet.createTopUp({
      userId, amountMinor: 500_001, paymentChannel: 'PAYPAL', externalTransactionId: 'pp_m7_001',
      paidAt: now.toISOString(), note: 'checked', idempotencyKey: 'm7:topup:3',
      actorStaffId: staffId, actorLevel: 'L1_SUPPORT', now
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(wallet.createTopUp({
      userId, amountMinor: 500_001, paymentChannel: 'PAYPAL', externalTransactionId: 'pp_m7_001',
      paidAt: now.toISOString(), note: 'checked', idempotencyKey: 'm7:topup:4',
      actorStaffId: staffId, actorLevel: 'L2_SUPERVISOR', now
    })).resolves.toMatchObject({ balance: { availableMinor: 500_001 } });
    for (const field of ['paymentChannel', 'externalTransactionId', 'note'] as const) {
      await expect(wallet.createTopUp({
        userId, amountMinor: 1, paymentChannel: 'BANK_TRANSFER', externalTransactionId: 'card_m7', paidAt: now.toISOString(),
        note: 'checked', idempotencyKey: `m7:required:${field}`, actorStaffId: staffId,
        actorLevel: 'L2_SUPERVISOR', now, [field]: ''
      })).rejects.toBeInstanceOf(WalletError);
    }
  });

  test('replays idempotently and external refund debit cannot spend reserved or make available negative', async () => {
    const wallet = service();
    const input = {
      userId, amountMinor: 1_000, paymentChannel: 'BANK_TRANSFER', externalTransactionId: 'card_m7_002',
      paidAt: now.toISOString(), note: 'checked', idempotencyKey: 'm7:topup:5',
      actorStaffId: staffId, actorLevel: 'L2_SUPERVISOR' as const, now
    };
    const first = await wallet.createTopUp(input);
    expect(await wallet.createTopUp(input)).toEqual(first);
    await wallet.reserve({ userId, sourceType: 'ORDER', sourceId: '00000000-0000-0000-0000-000000007403',
      amountMinor: 800, idempotencyKey: 'm7:reserve:1', expiresAt: new Date(now.getTime() + 60_000), now });
    await expect(wallet.createExternalRefundDebit({
      userId, amountMinor: 201, paymentChannel: 'BANK_TRANSFER', externalTransactionId: 'refund_m7_001',
      refundedAt: now.toISOString(), note: 'offline refund complete',
      expectedWalletVersion: 3, idempotencyKey: 'm7:external-refund:1', actorStaffId: staffId,
      actorLevel: 'L2_SUPERVISOR', now
    })).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE_BALANCE' });
    const debit = await wallet.createExternalRefundDebit({
      userId, amountMinor: 200, paymentChannel: 'BANK_TRANSFER', externalTransactionId: 'refund_m7_002',
      refundedAt: now.toISOString(), note: 'offline refund complete', expectedWalletVersion: 3,
      idempotencyKey: 'm7:external-refund:2', actorStaffId: staffId, actorLevel: 'L2_SUPERVISOR', now
    });
    expect(debit.balance).toMatchObject({ ledgerBalanceMinor: 800, reservedMinor: 800, availableMinor: 0, version: 4 });
  });

  test('requires L3 and an existing reversal link for append-only adjustments', async () => {
    const wallet = service();
    const topUp = await wallet.createTopUp({ userId, amountMinor: 1_000, paymentChannel: 'CASH', externalTransactionId: 'cash_m7_1',
      paidAt: now.toISOString(), note: 'checked', idempotencyKey: 'm7:adjust:topup', actorStaffId: staffId, actorLevel: 'L2_SUPERVISOR', now });
    await expect(wallet.createAdjustment({ userId, entryType: 'ADJUSTMENT_DEBIT', amountMinor: 100, reversalOfEntryId: topUp.walletEntry.id,
      reason: 'correction', expectedWalletVersion: 2, idempotencyKey: 'm7:adjust:1', actorStaffId: staffId, actorLevel: 'L2_SUPERVISOR', now }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const adjustment = await wallet.createAdjustment({ userId, entryType: 'ADJUSTMENT_DEBIT', amountMinor: 100, reversalOfEntryId: topUp.walletEntry.id,
      reason: 'correction', expectedWalletVersion: 2, idempotencyKey: 'm7:adjust:2', actorStaffId: staffId, actorLevel: 'L3_OPERATIONS', now });
    expect(adjustment).toMatchObject({ entryType: 'ADJUSTMENT_DEBIT', reversalOfEntryId: topUp.walletEntry.id });
    expect((await wallet.getBalance({ userId, now })).availableMinor).toBe(900);
  });

  test('stores only supported private receipt bytes with opaque key, hash, and 10 MiB cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm7-receipt-'));
    try {
      const storage = new PrivateFileReceiptStorage(root);
      const body = Buffer.from('%PDF receipt');
      const stored = await storage.put({ body: (async function* () { yield body; })(), mediaType: 'application/pdf', originalFileName: 'receipt.pdf' });
      expect(stored).toMatchObject({ byteSize: body.length, storageKey: expect.stringMatching(/^[0-9a-f-]{36}$/u), sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
      const chunks: Buffer[] = [];
      for await (const chunk of await storage.open(stored.storageKey)) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(body);
      await expect(storage.put({ body: (async function* () { yield Buffer.from('x'); })(), mediaType: 'text/plain' as 'application/pdf', originalFileName: 'bad.txt' })).rejects.toThrow(/Unsupported/u);
      await expect(storage.put({ body: (async function* () { yield Buffer.alloc(10_485_761); })(), mediaType: 'image/png', originalFileName: 'large.png' })).rejects.toThrow(/10485760/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
