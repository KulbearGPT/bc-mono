import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import multipart from '@fastify/multipart';
import { Readable } from 'node:stream';
import type { StaffLevel } from './security.js';
import { insertPostgresAuditRecord, registerSecureReadRoute, registerSecureWriteRoute, type ActorContext, type AuditRecord } from './security.js';
import { levelRank } from './authorization-policy.js';
import type { ReceiptMediaType, ReceiptStorage } from './receipt-storage.js';

export type WalletEntryType = 'TOP_UP_CREDIT' | 'ORDER_CAPTURE_DEBIT' | 'GIFT_CAPTURE_DEBIT' |
  'ORDER_REFUND_CREDIT' | 'EXTERNAL_REFUND_DEBIT' | 'ADJUSTMENT_CREDIT' | 'ADJUSTMENT_DEBIT';

export interface WalletBalance {
  ledgerBalanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  currency: 'USD';
  calculatedAt: string;
  version: number;
}

export interface WalletEntry {
  id: string;
  walletAccountId: string;
  entryType: WalletEntryType;
  direction: 'CREDIT' | 'DEBIT';
  amountMinor: number;
  currency: 'USD';
  sourceType: string;
  sourceId: string;
  reversalOfEntryId: string | null;
  occurredAt: string;
}

export interface CreateTopUpInput {
  userId: string;
  amountMinor: number;
  paymentChannel: string;
  externalTransactionId: string;
  paidAt: string;
  note: string;
  idempotencyKey: string;
  actorStaffId: string;
  actorLevel: StaffLevel;
  now: Date;
}

export interface CreateExternalRefundDebitInput {
  userId: string;
  amountMinor: number;
  paymentChannel: string;
  externalTransactionId: string;
  refundedAt: string;
  note: string;
  expectedWalletVersion: number;
  idempotencyKey: string;
  actorStaffId: string;
  actorLevel: StaffLevel;
  now: Date;
}

export interface TopUpResult {
  id: string;
  userId: string;
  amountMinor: number;
  currency: 'USD';
  paymentChannel: string;
  externalTransactionId: string;
  paidAt: string;
  note: string;
  attachmentIds: string[];
  walletEntry: WalletEntry;
  balance: WalletBalance;
  createdAt: string;
}

export interface ExternalRefundDebitResult extends Omit<TopUpResult, 'paidAt'> {
  refundedAt: string;
}

export interface ReceiptAttachmentMetadata {
  id: string; mediaType: ReceiptMediaType; originalFileName: string; byteSize: number; sha256: string; uploadedAt: string;
}
interface StoredReceipt extends ReceiptAttachmentMetadata { userId: string; evidenceType: 'TOP_UP' | 'EXTERNAL_REFUND_DEBIT'; evidenceId: string; storageKey: string }

export interface ReserveInput {
  userId: string;
  sourceType: 'ORDER' | 'GIFT';
  sourceId: string;
  amountMinor: number;
  idempotencyKey: string;
  expiresAt: Date;
  now: Date;
}

export interface CreateWalletAdjustmentInput {
  userId: string;
  entryType: 'ADJUSTMENT_CREDIT' | 'ADJUSTMENT_DEBIT';
  amountMinor: number;
  reversalOfEntryId: string;
  reason: string;
  expectedWalletVersion: number;
  idempotencyKey: string;
  actorStaffId: string;
  actorLevel: StaffLevel;
  now: Date;
}

interface StoredWallet {
  id: string;
  userId: string;
  version: number;
  entries: WalletEntry[];
  reservations: Array<{ id: string; amountMinor: number; active: boolean; idempotencyKey: string }>;
}

export class WalletError extends Error {
  constructor(public readonly code: 'VALIDATION_ERROR' | 'PERMISSION_DENIED' | 'DUPLICATE_EXTERNAL_TRANSACTION' |
    'INSUFFICIENT_AVAILABLE_BALANCE' | 'CONFLICT' | 'RESOURCE_NOT_FOUND', message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

export class InMemoryWalletStore {
  readonly wallets = new Map<string, StoredWallet>();
  readonly topUps = new Map<string, TopUpResult>();
  readonly externalRefundDebits = new Map<string, ExternalRefundDebitResult>();
  readonly externalReferences = new Set<string>();
  readonly idempotentResults = new Map<string, TopUpResult | ExternalRefundDebitResult | WalletEntry | { reservationId: string; balance: WalletBalance }>();
  readonly receipts = new Map<string, StoredReceipt>();

  getOrCreate(userId: string): StoredWallet {
    const existing = this.wallets.get(userId);
    if (existing) return existing;
    const created: StoredWallet = { id: crypto.randomUUID(), userId, version: 1, entries: [], reservations: [] };
    this.wallets.set(userId, created);
    return created;
  }
}

export class WalletService {
  constructor(private readonly store: InMemoryWalletStore) {}

  async getOrCreateWallet(input: { userId: string; now: Date }): Promise<{ walletAccountId: string; version: number }> {
    assertUuid(input.userId, 'userId');
    const wallet = this.store.getOrCreate(input.userId);
    return { walletAccountId: wallet.id, version: wallet.version };
  }

  async getBalance(input: { userId: string; now: Date }): Promise<WalletBalance> {
    assertUuid(input.userId, 'userId');
    return balance(this.store.getOrCreate(input.userId), input.now);
  }

  async createTopUp(input: CreateTopUpInput): Promise<TopUpResult> {
    validateFundingEvidence(input.amountMinor, input.paymentChannel, input.externalTransactionId, input.paidAt, input.note);
    if (input.amountMinor > 500_000 && levelRank(input.actorLevel) < levelRank('L2_SUPERVISOR')) {
      throw new WalletError('PERMISSION_DENIED', 'Top-ups above 500000 USD minor units require L2_SUPERVISOR.');
    }
    const replay = this.store.idempotentResults.get(input.idempotencyKey);
    if (replay) return replay as TopUpResult;
    const reference = referenceKey(input.paymentChannel, input.externalTransactionId);
    if (this.store.externalReferences.has(reference)) {
      throw new WalletError('DUPLICATE_EXTERNAL_TRANSACTION', 'The payment channel transaction is already recorded.');
    }
    const wallet = this.store.getOrCreate(input.userId);
    const id = crypto.randomUUID();
    const entry = makeEntry(wallet.id, 'TOP_UP_CREDIT', input.amountMinor, 'TOP_UP', id, input.idempotencyKey, null, input.now);
    wallet.entries.push(entry);
    wallet.version += 1;
    const result: TopUpResult = {
      id, userId: input.userId, amountMinor: input.amountMinor, currency: 'USD',
      paymentChannel: input.paymentChannel.trim(), externalTransactionId: input.externalTransactionId.trim(),
      paidAt: new Date(input.paidAt).toISOString(), note: input.note.trim(), attachmentIds: [],
      walletEntry: entry, balance: balance(wallet, input.now), createdAt: input.now.toISOString()
    };
    this.store.externalReferences.add(reference);
    this.store.topUps.set(id, structuredClone(result));
    this.store.idempotentResults.set(input.idempotencyKey, structuredClone(result));
    return result;
  }

  async reserve(input: ReserveInput): Promise<{ reservationId: string; balance: WalletBalance }> {
    assertPositiveAmount(input.amountMinor);
    const replay = this.store.idempotentResults.get(input.idempotencyKey);
    if (replay) return replay as { reservationId: string; balance: WalletBalance };
    const wallet = this.store.getOrCreate(input.userId);
    if (balance(wallet, input.now).availableMinor < input.amountMinor) {
      throw new WalletError('INSUFFICIENT_AVAILABLE_BALANCE', 'Available wallet balance is insufficient.');
    }
    const result = { reservationId: crypto.randomUUID(), balance: {} as WalletBalance };
    wallet.reservations.push({ id: result.reservationId, amountMinor: input.amountMinor, active: true, idempotencyKey: input.idempotencyKey });
    wallet.version += 1;
    result.balance = balance(wallet, input.now);
    this.store.idempotentResults.set(input.idempotencyKey, structuredClone(result));
    return result;
  }

  async createExternalRefundDebit(input: CreateExternalRefundDebitInput): Promise<ExternalRefundDebitResult> {
    validateFundingEvidence(input.amountMinor, input.paymentChannel, input.externalTransactionId, input.refundedAt, input.note);
    if (levelRank(input.actorLevel) < levelRank('L2_SUPERVISOR')) throw new WalletError('PERMISSION_DENIED', 'External refund debit requires L2_SUPERVISOR.');
    const replay = this.store.idempotentResults.get(input.idempotencyKey);
    if (replay) return replay as ExternalRefundDebitResult;
    const wallet = this.store.getOrCreate(input.userId);
    if (wallet.version !== input.expectedWalletVersion) throw new WalletError('CONFLICT', 'Wallet version is stale.');
    if (balance(wallet, input.now).availableMinor < input.amountMinor) {
      throw new WalletError('INSUFFICIENT_AVAILABLE_BALANCE', 'External refund debit exceeds available wallet balance.');
    }
    const reference = referenceKey(input.paymentChannel, input.externalTransactionId);
    if (this.store.externalReferences.has(reference)) throw new WalletError('DUPLICATE_EXTERNAL_TRANSACTION', 'The channel transaction is already recorded.');
    const id = crypto.randomUUID();
    const entry = makeEntry(wallet.id, 'EXTERNAL_REFUND_DEBIT', input.amountMinor, 'EXTERNAL_REFUND_DEBIT', id, input.idempotencyKey, null, input.now);
    wallet.entries.push(entry);
    wallet.version += 1;
    const result: ExternalRefundDebitResult = {
      id, userId: input.userId, amountMinor: input.amountMinor, currency: 'USD', paymentChannel: input.paymentChannel.trim(),
      externalTransactionId: input.externalTransactionId.trim(), refundedAt: new Date(input.refundedAt).toISOString(),
      note: input.note.trim(), attachmentIds: [], walletEntry: entry,
      balance: balance(wallet, input.now), createdAt: input.now.toISOString()
    };
    this.store.externalReferences.add(reference);
    this.store.externalRefundDebits.set(id, structuredClone(result));
    this.store.idempotentResults.set(input.idempotencyKey, structuredClone(result));
    return result;
  }

  async createAdjustment(input: CreateWalletAdjustmentInput): Promise<WalletEntry> {
    if (levelRank(input.actorLevel) < levelRank('L3_OPERATIONS')) throw new WalletError('PERMISSION_DENIED', 'Wallet adjustment requires L3_OPERATIONS.');
    assertPositiveAmount(input.amountMinor);
    assertNonEmpty(input.reason, 'reason', 1000);
    assertUuid(input.reversalOfEntryId, 'reversalOfEntryId');
    const replay = this.store.idempotentResults.get(input.idempotencyKey);
    if (replay && 'entryType' in replay) return structuredClone(replay);
    const wallet = this.store.getOrCreate(input.userId);
    if (wallet.version !== input.expectedWalletVersion) throw new WalletError('CONFLICT', 'Wallet version is stale.');
    const original = wallet.entries.find((entry) => entry.id === input.reversalOfEntryId);
    if (!original) throw new WalletError('RESOURCE_NOT_FOUND', 'The reversed wallet entry was not found.');
    if (input.entryType === 'ADJUSTMENT_DEBIT' && balance(wallet, input.now).availableMinor < input.amountMinor) {
      throw new WalletError('INSUFFICIENT_AVAILABLE_BALANCE', 'Adjustment debit exceeds available wallet balance.');
    }
    const entry = makeEntry(wallet.id, input.entryType, input.amountMinor, 'WALLET_ADJUSTMENT', crypto.randomUUID(),
      input.idempotencyKey, input.reversalOfEntryId, input.now);
    wallet.entries.push(entry);
    wallet.version += 1;
    this.store.idempotentResults.set(input.idempotencyKey, structuredClone(entry));
    return entry;
  }

  async listEntries(input: { userId: string }): Promise<WalletEntry[]> {
    return structuredClone(this.store.getOrCreate(input.userId).entries).reverse();
  }

  async createReceiptAttachment(input: { userId: string; evidenceType: 'TOP_UP' | 'EXTERNAL_REFUND_DEBIT'; evidenceId: string;
    stored: { storageKey: string; byteSize: number; sha256: string }; mediaType: ReceiptMediaType; originalFileName: string; actorStaffId: string; now: Date }) {
    const exists = input.evidenceType === 'TOP_UP' ? this.store.topUps.has(input.evidenceId) : this.store.externalRefundDebits.has(input.evidenceId);
    if (!exists) throw new WalletError('RESOURCE_NOT_FOUND', 'Funding evidence was not found.');
    const receipt: StoredReceipt = { id: crypto.randomUUID(), userId: input.userId, evidenceType: input.evidenceType, evidenceId: input.evidenceId,
      storageKey: input.stored.storageKey, mediaType: input.mediaType, originalFileName: input.originalFileName,
      byteSize: input.stored.byteSize, sha256: input.stored.sha256, uploadedAt: input.now.toISOString() };
    this.store.receipts.set(receipt.id, receipt); return publicReceipt(receipt);
  }

  async getReceiptAttachment(input: { attachmentId: string }): Promise<StoredReceipt> {
    const receipt = this.store.receipts.get(input.attachmentId);
    if (!receipt) throw new WalletError('RESOURCE_NOT_FOUND', 'Receipt attachment was not found.');
    return structuredClone(receipt);
  }
}

function validateFundingEvidence(amountMinor: number, channel: string, reference: string, occurredAt: string, note: string): void {
  assertPositiveAmount(amountMinor);
  assertNonEmpty(channel, 'paymentChannel', 50);
  assertNonEmpty(reference, 'externalTransactionId', 200);
  assertNonEmpty(note, 'note', 1000);
  if (!Number.isFinite(Date.parse(occurredAt))) throw new WalletError('VALIDATION_ERROR', 'The receipt timestamp is invalid.');
}

function makeEntry(walletAccountId: string, entryType: WalletEntryType, amountMinor: number, sourceType: string,
  sourceId: string, _idempotencyKey: string, reversalOfEntryId: string | null, now: Date): WalletEntry {
  return { id: crypto.randomUUID(), walletAccountId, entryType, direction: entryType.endsWith('CREDIT') ? 'CREDIT' : 'DEBIT',
    amountMinor, currency: 'USD', sourceType, sourceId, reversalOfEntryId, occurredAt: now.toISOString() };
}

function balance(wallet: StoredWallet, now: Date): WalletBalance {
  const ledgerBalanceMinor = wallet.entries.reduce((sum, entry) => sum + (entry.direction === 'CREDIT' ? entry.amountMinor : -entry.amountMinor), 0);
  const reservedMinor = wallet.reservations.filter((item) => item.active).reduce((sum, item) => sum + item.amountMinor, 0);
  return { ledgerBalanceMinor, reservedMinor, availableMinor: ledgerBalanceMinor - reservedMinor,
    currency: 'USD', calculatedAt: now.toISOString(), version: wallet.version };
}

function referenceKey(channel: string, externalTransactionId: string): string {
  return `${channel.trim()}:${externalTransactionId.trim()}`;
}
function assertPositiveAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new WalletError('VALIDATION_ERROR', 'amountMinor must be a positive safe integer.');
}
function assertNonEmpty(value: string, field: string, maximum: number): void {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw new WalletError('VALIDATION_ERROR', `${field} is required.`);
}
function isUuid(value: string): boolean { return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value); }
function assertUuid(value: string, field: string): void { if (!isUuid(value)) throw new WalletError('VALIDATION_ERROR', `${field} must be a UUID.`); }

export class PostgresWalletStore {
  constructor(readonly options: { pool: Pool }) {}

  async getOrCreateWallet(input: { userId: string; now: Date }) {
    return inWalletTransaction(this.options.pool, async (client) => ensureWallet(client, input.userId, input.now));
  }

  async getBalance(input: { userId: string; now: Date }): Promise<WalletBalance> {
    return inWalletTransaction(this.options.pool, async (client) => {
      const wallet = await ensureWallet(client, input.userId, input.now);
      return readPostgresBalance(client, wallet.walletAccountId, wallet.version, input.now);
    });
  }

  async createTopUp(input: CreateTopUpInput): Promise<TopUpResult> {
    validateFundingEvidence(input.amountMinor, input.paymentChannel, input.externalTransactionId, input.paidAt, input.note);
    if (input.amountMinor > 500_000 && levelRank(input.actorLevel) < 2) throw new WalletError('PERMISSION_DENIED', 'Top-ups above 500000 require L2_SUPERVISOR.');
    return inWalletTransaction(this.options.pool, async (client) => {
      const wallet = await ensureWallet(client, input.userId, input.now, true);
      const replay = await findPostgresTopUpByIdempotency(client, input.idempotencyKey, input.userId, input.now);
      if (replay) return replay;
      const id = crypto.randomUUID();
      const entry = makeEntry(wallet.walletAccountId, 'TOP_UP_CREDIT', input.amountMinor, 'TOP_UP', id, input.idempotencyKey, null, input.now);
      try {
        await insertWalletEntry(client, entry, input.idempotencyKey);
        await client.query(`INSERT INTO top_ups
          (id,wallet_account_id,wallet_entry_id,amount_minor,currency,payment_channel,external_transaction_id,paid_at,note,created_by_staff_id,created_at)
          VALUES ($1,$2,$3,$4,'USD',$5,$6,$7,$8,$9,$10)`,
          [id, wallet.walletAccountId, entry.id, input.amountMinor, input.paymentChannel.trim(), input.externalTransactionId.trim(),
            new Date(input.paidAt), input.note.trim(), input.actorStaffId, input.now]);
      } catch (error) { throw mapPostgresWalletError(error); }
      const version = await incrementWalletVersion(client, wallet.walletAccountId, wallet.version, input.now);
      return { id, userId: input.userId, amountMinor: input.amountMinor, currency: 'USD', paymentChannel: input.paymentChannel.trim(),
        externalTransactionId: input.externalTransactionId.trim(), paidAt: new Date(input.paidAt).toISOString(), note: input.note.trim(),
        attachmentIds: [], walletEntry: entry, balance: await readPostgresBalance(client, wallet.walletAccountId, version, input.now), createdAt: input.now.toISOString() };
    });
  }

  async stageCreateTopUp(input: CreateTopUpInput): Promise<{ data: TopUpResult; commit: (audit: AuditRecord) => Promise<void> }> {
    validateFundingEvidence(input.amountMinor, input.paymentChannel, input.externalTransactionId, input.paidAt, input.note);
    if (input.amountMinor > 500_000 && levelRank(input.actorLevel) < 2) throw new WalletError('PERMISSION_DENIED', 'Top-ups above 500000 require L2_SUPERVISOR.');
    const current = await this.options.pool.query<{ id: string; row_version: number }>('SELECT id,row_version FROM wallet_accounts WHERE user_id=$1', [input.userId]);
    const walletAccountId = current.rows[0]?.id ?? crypto.randomUUID();
    const currentVersion = current.rows[0]?.row_version ?? 1;
    const id = crypto.randomUUID();
    const entry = makeEntry(walletAccountId, 'TOP_UP_CREDIT', input.amountMinor, 'TOP_UP', id, input.idempotencyKey, null, input.now);
    const existingBalance = current.rows[0]
      ? await this.getBalance({ userId: input.userId, now: input.now })
      : { ledgerBalanceMinor: 0, reservedMinor: 0, availableMinor: 0, currency: 'USD' as const, calculatedAt: input.now.toISOString(), version: 1 };
    const data: TopUpResult = { id, userId: input.userId, amountMinor: input.amountMinor, currency: 'USD', paymentChannel: input.paymentChannel.trim(),
      externalTransactionId: input.externalTransactionId.trim(), paidAt: new Date(input.paidAt).toISOString(), note: input.note.trim(), attachmentIds: [],
      walletEntry: entry, balance: { ...existingBalance, ledgerBalanceMinor: existingBalance.ledgerBalanceMinor + input.amountMinor,
        availableMinor: existingBalance.availableMinor + input.amountMinor, version: currentVersion + 1 }, createdAt: input.now.toISOString() };
    return { data, commit: async (audit) => inWalletTransaction(this.options.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.userId]);
      const locked = await client.query<{ id: string; row_version: number }>('SELECT id,row_version FROM wallet_accounts WHERE user_id=$1 FOR UPDATE', [input.userId]);
      if (!locked.rows[0]) {
        await client.query(`INSERT INTO wallet_accounts (id,user_id,currency,status,row_version,created_at,updated_at)
          VALUES ($1,$2,'USD','ACTIVE',1,$3,$3)`, [walletAccountId, input.userId, input.now]);
      } else if (locked.rows[0].id !== walletAccountId || locked.rows[0].row_version !== currentVersion) {
        throw new WalletError('CONFLICT', 'Wallet changed while the top-up was staged.');
      }
      try {
        await insertWalletEntry(client, entry, input.idempotencyKey);
        await client.query(`INSERT INTO top_ups
          (id,wallet_account_id,wallet_entry_id,amount_minor,currency,payment_channel,external_transaction_id,paid_at,note,created_by_staff_id,created_at)
          VALUES ($1,$2,$3,$4,'USD',$5,$6,$7,$8,$9,$10)`, [id,walletAccountId,entry.id,input.amountMinor,input.paymentChannel.trim(),
            input.externalTransactionId.trim(),new Date(input.paidAt),input.note.trim(),input.actorStaffId,input.now]);
        await incrementWalletVersion(client, walletAccountId, currentVersion, input.now);
        await insertPostgresAuditRecord(client, audit);
      } catch (error) { throw mapPostgresWalletError(error); }
    }) };
  }

  async createExternalRefundDebit(input: CreateExternalRefundDebitInput): Promise<ExternalRefundDebitResult> {
    validateFundingEvidence(input.amountMinor, input.paymentChannel, input.externalTransactionId, input.refundedAt, input.note);
    if (levelRank(input.actorLevel) < 2) throw new WalletError('PERMISSION_DENIED', 'External refund debit requires L2_SUPERVISOR.');
    return inWalletTransaction(this.options.pool, async (client) => {
      const wallet = await ensureWallet(client, input.userId, input.now, true);
      if (wallet.version !== input.expectedWalletVersion) throw new WalletError('CONFLICT', 'Wallet version is stale.');
      const before = await readPostgresBalance(client, wallet.walletAccountId, wallet.version, input.now);
      if (before.availableMinor < input.amountMinor) throw new WalletError('INSUFFICIENT_AVAILABLE_BALANCE', 'External refund debit exceeds available balance.');
      const id = crypto.randomUUID();
      const entry = makeEntry(wallet.walletAccountId, 'EXTERNAL_REFUND_DEBIT', input.amountMinor, 'EXTERNAL_REFUND_DEBIT', id, input.idempotencyKey, null, input.now);
      try {
        await insertWalletEntry(client, entry, input.idempotencyKey);
        await client.query(`INSERT INTO external_refund_debits
          (id,wallet_account_id,wallet_entry_id,amount_minor,currency,payment_channel,external_transaction_id,refunded_at,note,created_by_staff_id,created_at)
          VALUES ($1,$2,$3,$4,'USD',$5,$6,$7,$8,$9,$10)`,
          [id, wallet.walletAccountId, entry.id, input.amountMinor, input.paymentChannel.trim(), input.externalTransactionId.trim(),
            new Date(input.refundedAt), input.note.trim(), input.actorStaffId, input.now]);
      } catch (error) { throw mapPostgresWalletError(error); }
      const version = await incrementWalletVersion(client, wallet.walletAccountId, wallet.version, input.now);
      return { id, userId: input.userId, amountMinor: input.amountMinor, currency: 'USD', paymentChannel: input.paymentChannel.trim(),
        externalTransactionId: input.externalTransactionId.trim(), refundedAt: new Date(input.refundedAt).toISOString(), note: input.note.trim(),
        attachmentIds: [], walletEntry: entry, balance: await readPostgresBalance(client, wallet.walletAccountId, version, input.now), createdAt: input.now.toISOString() };
    });
  }

  async stageCreateExternalRefundDebit(input: CreateExternalRefundDebitInput): Promise<{ data: ExternalRefundDebitResult; commit: (audit: AuditRecord) => Promise<void> }> {
    validateFundingEvidence(input.amountMinor, input.paymentChannel, input.externalTransactionId, input.refundedAt, input.note);
    if (levelRank(input.actorLevel) < 2) throw new WalletError('PERMISSION_DENIED', 'External refund debit requires L2_SUPERVISOR.');
    const current = await this.options.pool.query<{ id: string; row_version: number }>('SELECT id,row_version FROM wallet_accounts WHERE user_id=$1', [input.userId]);
    if (!current.rows[0]) throw new WalletError('RESOURCE_NOT_FOUND', 'Wallet was not found.');
    if (current.rows[0].row_version !== input.expectedWalletVersion) throw new WalletError('CONFLICT', 'Wallet version is stale.');
    const before = await this.getBalance({ userId: input.userId, now: input.now });
    if (before.availableMinor < input.amountMinor) throw new WalletError('INSUFFICIENT_AVAILABLE_BALANCE', 'External refund debit exceeds available balance.');
    const walletAccountId = current.rows[0].id; const id = crypto.randomUUID();
    const entry = makeEntry(walletAccountId, 'EXTERNAL_REFUND_DEBIT', input.amountMinor, 'EXTERNAL_REFUND_DEBIT', id, input.idempotencyKey, null, input.now);
    const data: ExternalRefundDebitResult = { id,userId:input.userId,amountMinor:input.amountMinor,currency:'USD',paymentChannel:input.paymentChannel.trim(),
      externalTransactionId:input.externalTransactionId.trim(),refundedAt:new Date(input.refundedAt).toISOString(),note:input.note.trim(),attachmentIds:[],walletEntry:entry,
      balance:{...before,ledgerBalanceMinor:before.ledgerBalanceMinor-input.amountMinor,availableMinor:before.availableMinor-input.amountMinor,version:before.version+1},createdAt:input.now.toISOString() };
    return { data, commit: async (audit) => inWalletTransaction(this.options.pool, async (client) => {
      const locked = await client.query<{ row_version:number }>('SELECT row_version FROM wallet_accounts WHERE id=$1 FOR UPDATE',[walletAccountId]);
      if (locked.rows[0]?.row_version !== input.expectedWalletVersion) throw new WalletError('CONFLICT','Wallet changed while the refund debit was staged.');
      const lockedBalance=await readPostgresBalance(client,walletAccountId,input.expectedWalletVersion,input.now);
      if(lockedBalance.availableMinor<input.amountMinor)throw new WalletError('INSUFFICIENT_AVAILABLE_BALANCE','External refund debit exceeds available balance.');
      try { await insertWalletEntry(client,entry,input.idempotencyKey); await client.query(`INSERT INTO external_refund_debits
        (id,wallet_account_id,wallet_entry_id,amount_minor,currency,payment_channel,external_transaction_id,refunded_at,note,created_by_staff_id,created_at)
        VALUES ($1,$2,$3,$4,'USD',$5,$6,$7,$8,$9,$10)`,[id,walletAccountId,entry.id,input.amountMinor,input.paymentChannel.trim(),input.externalTransactionId.trim(),new Date(input.refundedAt),input.note.trim(),input.actorStaffId,input.now]);
        await incrementWalletVersion(client,walletAccountId,input.expectedWalletVersion,input.now); await insertPostgresAuditRecord(client,audit);
      } catch(error){throw mapPostgresWalletError(error);}
    }) };
  }

  async createAdjustment(input: CreateWalletAdjustmentInput): Promise<WalletEntry> {
    if (levelRank(input.actorLevel) < 3) throw new WalletError('PERMISSION_DENIED', 'Wallet adjustment requires L3_OPERATIONS.');
    assertPositiveAmount(input.amountMinor); assertNonEmpty(input.reason, 'reason', 1000); assertUuid(input.reversalOfEntryId, 'reversalOfEntryId');
    return inWalletTransaction(this.options.pool, async (client) => {
      const wallet = await ensureWallet(client, input.userId, input.now, true);
      if (wallet.version !== input.expectedWalletVersion) throw new WalletError('CONFLICT', 'Wallet version is stale.');
      const original = await client.query('SELECT id FROM wallet_entries WHERE id=$1 AND wallet_account_id=$2', [input.reversalOfEntryId, wallet.walletAccountId]);
      if (!original.rows[0]) throw new WalletError('RESOURCE_NOT_FOUND', 'The reversed wallet entry was not found.');
      const current = await readPostgresBalance(client, wallet.walletAccountId, wallet.version, input.now);
      if (input.entryType === 'ADJUSTMENT_DEBIT' && current.availableMinor < input.amountMinor) throw new WalletError('INSUFFICIENT_AVAILABLE_BALANCE', 'Adjustment exceeds available balance.');
      const sourceId = crypto.randomUUID();
      const entry = makeEntry(wallet.walletAccountId, input.entryType, input.amountMinor, 'WALLET_ADJUSTMENT', sourceId, input.idempotencyKey, input.reversalOfEntryId, input.now);
      await insertWalletEntry(client, entry, input.idempotencyKey);
      await incrementWalletVersion(client, wallet.walletAccountId, wallet.version, input.now);
      return entry;
    });
  }

  async stageCreateAdjustment(input: CreateWalletAdjustmentInput): Promise<{ data: WalletEntry; commit: (audit: AuditRecord) => Promise<void> }> {
    if (levelRank(input.actorLevel) < 3) throw new WalletError('PERMISSION_DENIED', 'Wallet adjustment requires L3_OPERATIONS.');
    assertPositiveAmount(input.amountMinor); assertNonEmpty(input.reason,'reason',1000); assertUuid(input.reversalOfEntryId,'reversalOfEntryId');
    const wallet=await this.options.pool.query<{id:string;row_version:number}>('SELECT id,row_version FROM wallet_accounts WHERE user_id=$1',[input.userId]);
    if(!wallet.rows[0])throw new WalletError('RESOURCE_NOT_FOUND','Wallet was not found.');
    if(wallet.rows[0].row_version!==input.expectedWalletVersion)throw new WalletError('CONFLICT','Wallet version is stale.');
    const original=await this.options.pool.query('SELECT id FROM wallet_entries WHERE id=$1 AND wallet_account_id=$2',[input.reversalOfEntryId,wallet.rows[0].id]);
    if(!original.rows[0])throw new WalletError('RESOURCE_NOT_FOUND','The reversed wallet entry was not found.');
    const before=await this.getBalance({userId:input.userId,now:input.now});
    if(input.entryType==='ADJUSTMENT_DEBIT'&&before.availableMinor<input.amountMinor)throw new WalletError('INSUFFICIENT_AVAILABLE_BALANCE','Adjustment exceeds available balance.');
    const entry=makeEntry(wallet.rows[0].id,input.entryType,input.amountMinor,'WALLET_ADJUSTMENT',crypto.randomUUID(),input.idempotencyKey,input.reversalOfEntryId,input.now);
    return {data:entry,commit:async(audit)=>inWalletTransaction(this.options.pool,async(client)=>{
      const locked=await client.query<{row_version:number}>('SELECT row_version FROM wallet_accounts WHERE id=$1 FOR UPDATE',[entry.walletAccountId]);
      if(locked.rows[0]?.row_version!==input.expectedWalletVersion)throw new WalletError('CONFLICT','Wallet changed while the adjustment was staged.');
      const current=await readPostgresBalance(client,entry.walletAccountId,input.expectedWalletVersion,input.now);
      if(input.entryType==='ADJUSTMENT_DEBIT'&&current.availableMinor<input.amountMinor)throw new WalletError('INSUFFICIENT_AVAILABLE_BALANCE','Adjustment exceeds available balance.');
      await insertWalletEntry(client,entry,input.idempotencyKey);await incrementWalletVersion(client,entry.walletAccountId,input.expectedWalletVersion,input.now);await insertPostgresAuditRecord(client,audit);
    })};
  }

  async listEntries(input: { userId: string }): Promise<WalletEntry[]> {
    const result = await this.options.pool.query<PostgresEntryRow>(`SELECT e.* FROM wallet_entries e JOIN wallet_accounts w ON w.id=e.wallet_account_id
      WHERE w.user_id=$1 ORDER BY e.occurred_at DESC,e.id DESC LIMIT 100`, [input.userId]);
    return result.rows.map(mapPostgresEntry);
  }

  async createReceiptAttachment(input: { userId: string; evidenceType: 'TOP_UP' | 'EXTERNAL_REFUND_DEBIT'; evidenceId: string;
    stored: { storageKey: string; byteSize: number; sha256: string }; mediaType: ReceiptMediaType; originalFileName: string; actorStaffId: string; now: Date }) {
    return inWalletTransaction(this.options.pool, async (client) => {
      const wallet = await ensureWallet(client, input.userId, input.now, true);
      const table = input.evidenceType === 'TOP_UP' ? 'top_ups' : 'external_refund_debits';
      const evidence = await client.query(`SELECT id FROM ${table} WHERE id=$1 AND wallet_account_id=$2`, [input.evidenceId, wallet.walletAccountId]);
      if (!evidence.rows[0]) throw new WalletError('RESOURCE_NOT_FOUND', 'Funding evidence was not found.');
      const receipt: StoredReceipt = { id: crypto.randomUUID(), userId: input.userId, evidenceType: input.evidenceType, evidenceId: input.evidenceId,
        storageKey: input.stored.storageKey, mediaType: input.mediaType, originalFileName: input.originalFileName,
        byteSize: input.stored.byteSize, sha256: input.stored.sha256, uploadedAt: input.now.toISOString() };
      await client.query(`INSERT INTO receipt_attachments
        (id,wallet_account_id,top_up_id,external_refund_debit_id,media_type,original_file_name,byte_size,sha256,storage_key,uploaded_by_staff_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [receipt.id,wallet.walletAccountId,
        input.evidenceType === 'TOP_UP' ? input.evidenceId : null,input.evidenceType === 'EXTERNAL_REFUND_DEBIT' ? input.evidenceId : null,
        input.mediaType,input.originalFileName,input.stored.byteSize,input.stored.sha256,input.stored.storageKey,input.actorStaffId,input.now]);
      return publicReceipt(receipt);
    });
  }

  async stageCreateReceiptAttachment(input: { userId: string; evidenceType: 'TOP_UP' | 'EXTERNAL_REFUND_DEBIT'; evidenceId: string;
    stored: { storageKey: string; byteSize: number; sha256: string }; mediaType: ReceiptMediaType; originalFileName: string; actorStaffId: string; now: Date }) {
    const wallet=await this.options.pool.query<{id:string}>('SELECT id FROM wallet_accounts WHERE user_id=$1',[input.userId]);
    if(!wallet.rows[0])throw new WalletError('RESOURCE_NOT_FOUND','Wallet was not found.');
    const walletId=wallet.rows[0].id; const table=input.evidenceType==='TOP_UP'?'top_ups':'external_refund_debits';
    const evidence=await this.options.pool.query(`SELECT id FROM ${table} WHERE id=$1 AND wallet_account_id=$2`,[input.evidenceId,walletId]);
    if(!evidence.rows[0])throw new WalletError('RESOURCE_NOT_FOUND','Funding evidence was not found.');
    const receipt:StoredReceipt={id:crypto.randomUUID(),userId:input.userId,evidenceType:input.evidenceType,evidenceId:input.evidenceId,storageKey:input.stored.storageKey,
      mediaType:input.mediaType,originalFileName:input.originalFileName,byteSize:input.stored.byteSize,sha256:input.stored.sha256,uploadedAt:input.now.toISOString()};
    return {data:publicReceipt(receipt),commit:async(audit:AuditRecord)=>inWalletTransaction(this.options.pool,async(client)=>{
      const locked=await client.query(`SELECT id FROM ${table} WHERE id=$1 AND wallet_account_id=$2 FOR UPDATE`,[input.evidenceId,walletId]);
      if(!locked.rows[0])throw new WalletError('RESOURCE_NOT_FOUND','Funding evidence was not found.');
      await client.query(`INSERT INTO receipt_attachments
        (id,wallet_account_id,top_up_id,external_refund_debit_id,media_type,original_file_name,byte_size,sha256,storage_key,uploaded_by_staff_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[receipt.id,walletId,input.evidenceType==='TOP_UP'?input.evidenceId:null,input.evidenceType==='EXTERNAL_REFUND_DEBIT'?input.evidenceId:null,
        input.mediaType,input.originalFileName,input.stored.byteSize,input.stored.sha256,input.stored.storageKey,input.actorStaffId,input.now]);
      await insertPostgresAuditRecord(client,audit);
    })};
  }

  async getReceiptAttachment(input: { attachmentId: string }): Promise<StoredReceipt> {
    const result = await this.options.pool.query<Record<string, unknown>>(`SELECT r.*,w.user_id,
      CASE WHEN r.top_up_id IS NOT NULL THEN 'TOP_UP' ELSE 'EXTERNAL_REFUND_DEBIT' END evidence_type,
      COALESCE(r.top_up_id,r.external_refund_debit_id) evidence_id FROM receipt_attachments r JOIN wallet_accounts w ON w.id=r.wallet_account_id WHERE r.id=$1`, [input.attachmentId]);
    const row = result.rows[0]; if (!row) throw new WalletError('RESOURCE_NOT_FOUND', 'Receipt attachment was not found.');
    return { id: String(row.id), userId: String(row.user_id), evidenceType: row.evidence_type as StoredReceipt['evidenceType'], evidenceId: String(row.evidence_id),
      storageKey: String(row.storage_key), mediaType: row.media_type as ReceiptMediaType, originalFileName: String(row.original_file_name),
      byteSize: Number(row.byte_size), sha256: String(row.sha256), uploadedAt: new Date(row.created_at as string).toISOString() };
  }
}

export interface WalletApplicationService {
  getBalance(input: { userId: string; now: Date }): Promise<WalletBalance>;
  createTopUp(input: CreateTopUpInput): Promise<TopUpResult>;
  createExternalRefundDebit(input: CreateExternalRefundDebitInput): Promise<ExternalRefundDebitResult>;
  createAdjustment(input: CreateWalletAdjustmentInput): Promise<WalletEntry>;
  listEntries(input: { userId: string }): Promise<WalletEntry[]>;
  stageCreateTopUp?(input: CreateTopUpInput): Promise<{ data: TopUpResult; commit: (audit: AuditRecord) => Promise<void> }>;
  stageCreateExternalRefundDebit?(input: CreateExternalRefundDebitInput): Promise<{ data: ExternalRefundDebitResult; commit: (audit: AuditRecord) => Promise<void> }>;
  stageCreateAdjustment?(input: CreateWalletAdjustmentInput): Promise<{ data: WalletEntry; commit: (audit: AuditRecord) => Promise<void> }>;
  createReceiptAttachment(input: { userId: string; evidenceType: 'TOP_UP' | 'EXTERNAL_REFUND_DEBIT'; evidenceId: string;
    stored: { storageKey: string; byteSize: number; sha256: string }; mediaType: ReceiptMediaType; originalFileName: string; actorStaffId: string; now: Date }): Promise<ReceiptAttachmentMetadata>;
  getReceiptAttachment(input: { attachmentId: string }): Promise<StoredReceipt>;
  stageCreateReceiptAttachment?(input: Parameters<WalletApplicationService['createReceiptAttachment']>[0]): Promise<{ data: ReceiptAttachmentMetadata; commit: (audit: AuditRecord) => Promise<void> }>;
}

export function registerWalletRoutes(server: FastifyInstance, options: { service: WalletApplicationService; receiptStorage?: ReceiptStorage; now?: () => Date }): void {
  if (!server.securityOptions) throw new Error('Wallet routes require security options.');
  const now = options.now ?? (() => new Date());
  registerSecureReadRoute(server, server.securityOptions, {
    method: 'GET', url: '/api/v1/me/balance', permission: 'balance.self.read', action: 'GET_MY_WALLET_BALANCE',
    targetType: 'wallet_account', acceptedSources: ['DISCORD_BOT', 'DASHBOARD'], allowServiceActor: true,
    handler: (_request, actor) => options.service.getBalance({ userId: requireActorUser(actor), now: now() })
  });
  registerSecureReadRoute(server, server.securityOptions, {
    method: 'GET', url: '/api/v1/admin/users/:userId/wallet', permission: 'wallet.read', action: 'GET_ADMIN_WALLET',
    targetType: 'wallet_account', targetId: userTarget, acceptedSources: ['DASHBOARD'],
    handler: (request) => options.service.getBalance({ userId: userTarget(request), now: now() })
  });
  registerSecureReadRoute(server, server.securityOptions, {
    method: 'GET', url: '/api/v1/admin/users/:userId/wallet/entries', permission: 'wallet.read', action: 'LIST_ADMIN_WALLET_ENTRIES',
    targetType: 'wallet_entry', targetId: userTarget, acceptedSources: ['DASHBOARD'],
    handler: (request) => options.service.listEntries({ userId: userTarget(request) })
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST', url: '/api/v1/admin/users/:userId/top-ups', permission: 'wallet.top_up', action: 'CREATE_ADMIN_TOP_UP',
    targetType: 'top_up', targetId: userTarget, acceptedSources: ['DASHBOARD'], successStatusCode: 201,
    mapError: mapWalletError,
    auditChanges: (_request, _actor, payload) => fundingAuditChanges(payload as TopUpResult, 'top_up'),
    handler: (request, actor) => {
      const input = { ...fundingBody(request, 'paidAt'), userId: userTarget(request), idempotencyKey: requireIdempotencyKey(request),
        actorStaffId: requireActorStaff(actor), actorLevel: requireActorLevel(actor), now: now() };
      return options.service.stageCreateTopUp?.(input) ?? options.service.createTopUp(input);
    }
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST', url: '/api/v1/admin/users/:userId/external-refund-debits', permission: 'wallet.external_refund',
    action: 'CREATE_ADMIN_EXTERNAL_REFUND_DEBIT', targetType: 'external_refund_debit', targetId: userTarget,
    acceptedSources: ['DASHBOARD'], successStatusCode: 201, mapError: mapWalletError,
    auditChanges: (_request, _actor, payload) => fundingAuditChanges(payload as ExternalRefundDebitResult, 'external_refund_debit'),
    handler: (request, actor) => {
      const body = fundingBody(request, 'refundedAt') as ReturnType<typeof fundingBody> & { expectedWalletVersion?: unknown };
      const input = { ...body, expectedWalletVersion: requiredInteger(body.expectedWalletVersion, 'expectedWalletVersion'),
        userId: userTarget(request), idempotencyKey: requireIdempotencyKey(request), actorStaffId: requireActorStaff(actor),
        actorLevel: requireActorLevel(actor), now: now() };
      return options.service.stageCreateExternalRefundDebit?.(input) ?? options.service.createExternalRefundDebit(input);
    }
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST', url: '/api/v1/admin/users/:userId/wallet-adjustments', permission: 'wallet.adjust', action: 'CREATE_WALLET_ADJUSTMENT',
    targetType: 'wallet_entry', targetId: userTarget, acceptedSources: ['DASHBOARD'], successStatusCode: 201, mapError: mapWalletError,
    handler: (request, actor) => {
      const body = request.body as Record<string, unknown>;
      const input = { userId: userTarget(request), entryType: body.entryType as 'ADJUSTMENT_CREDIT' | 'ADJUSTMENT_DEBIT',
        amountMinor: requiredInteger(body.amountMinor, 'amountMinor'), reversalOfEntryId: String(body.reversalOfEntryId ?? ''),
        reason: String(body.reason ?? ''), expectedWalletVersion: requiredInteger(body.expectedWalletVersion, 'expectedWalletVersion'),
        idempotencyKey: requireIdempotencyKey(request), actorStaffId: requireActorStaff(actor), actorLevel: requireActorLevel(actor), now: now() };
      return options.service.stageCreateAdjustment?.(input) ?? options.service.createAdjustment(input);
    }
  });
  if (options.receiptStorage) {
    server.register(multipart, { limits: { fileSize: 10_485_760, files: 1, fields: 2 } });
    registerSecureWriteRoute(server, server.securityOptions, {
      method: 'POST', url: '/api/v1/admin/users/:userId/receipt-attachments', permission: 'wallet.top_up', action: 'CREATE_RECEIPT_ATTACHMENT',
      targetType: 'receipt_attachment', targetId: userTarget, acceptedSources: ['DASHBOARD'], successStatusCode: 201, mapError: mapWalletError,
      auditChanges: (_request, _actor, payload) => [{ targetType: 'receipt_attachment', targetId: (payload as ReceiptAttachmentMetadata).id,
        changeType: 'APPEND', beforeSnapshot: null, afterSnapshot: payload, changedFields: ['byteSize', 'mediaType', 'sha256'] }],
      handler: async (request, actor) => {
        let evidenceType = ''; let evidenceId = ''; let stored: { storageKey: string; byteSize: number; sha256: string } | null = null;
        let mediaType = ''; let originalFileName = '';
        for await (const part of request.parts()) {
          if (part.type === 'field') { if (part.fieldname === 'evidenceType') evidenceType = String(part.value); if (part.fieldname === 'evidenceId') evidenceId = String(part.value); continue; }
          mediaType = part.mimetype; originalFileName = part.filename;
          stored = await options.receiptStorage!.put({ body: part.file, mediaType: mediaType as ReceiptMediaType, originalFileName });
        }
        if ((evidenceType !== 'TOP_UP' && evidenceType !== 'EXTERNAL_REFUND_DEBIT') || !isUuid(evidenceId) || !stored) throw new WalletError('VALIDATION_ERROR', 'evidenceType, evidenceId and file are required.');
        const input = { userId: userTarget(request), evidenceType: evidenceType as 'TOP_UP' | 'EXTERNAL_REFUND_DEBIT', evidenceId, stored, mediaType: mediaType as ReceiptMediaType,
          originalFileName, actorStaffId: requireActorStaff(actor), now: now() };
        return options.service.stageCreateReceiptAttachment?.(input) ?? options.service.createReceiptAttachment(input);
      }
    });
    registerSecureReadRoute(server, server.securityOptions, {
      method: 'GET', url: '/api/v1/admin/receipt-attachments/:attachmentId/content', permission: 'wallet.read', action: 'GET_RECEIPT_ATTACHMENT_CONTENT',
      targetType: 'receipt_attachment', targetId: (request) => String((request.params as { attachmentId?: string }).attachmentId ?? ''), acceptedSources: ['DASHBOARD'], mapError: mapWalletError,
      handler: async (request) => {
        const receipt = await options.service.getReceiptAttachment({ attachmentId: String((request.params as { attachmentId?: string }).attachmentId ?? '') });
        return { receipt, body: await options.receiptStorage!.open(receipt.storageKey) };
      },
      rawResponse: (payload, reply) => {
        const value = payload as { receipt: StoredReceipt; body: AsyncIterable<Uint8Array> };
        reply.type(value.receipt.mediaType).header('content-disposition', `attachment; filename="receipt"`);
        return reply.send(Readable.from(value.body));
      }
    });
  }
}

function fundingBody(request: FastifyRequest, timestamp: 'paidAt' | 'refundedAt') {
  const body = request.body as Record<string, unknown>;
  return { amountMinor: requiredInteger(body.amountMinor, 'amountMinor'), paymentChannel: String(body.paymentChannel ?? ''),
    externalTransactionId: String(body.externalTransactionId ?? ''), [timestamp]: String(body[timestamp] ?? ''), note: String(body.note ?? ''),
    expectedWalletVersion: body.expectedWalletVersion } as { amountMinor: number; paymentChannel: string; externalTransactionId: string;
      paidAt: string; refundedAt: string; note: string; expectedWalletVersion?: unknown };
}
function userTarget(request: FastifyRequest): string { return String((request.params as { userId?: string }).userId ?? ''); }
function requireIdempotencyKey(request: FastifyRequest): string { return String(request.headers['idempotency-key'] ?? ''); }
function requireActorUser(actor: ActorContext): string { if (!actor.actorUserId) throw new WalletError('PERMISSION_DENIED', 'User actor is required.'); return actor.actorUserId; }
function requireActorStaff(actor: ActorContext): string { if (!actor.actorStaffId) throw new WalletError('PERMISSION_DENIED', 'Staff actor is required.'); return actor.actorStaffId; }
function requireActorLevel(actor: ActorContext): StaffLevel { if (!actor.actorLevel) throw new WalletError('PERMISSION_DENIED', 'Staff level is required.'); return actor.actorLevel; }
function requiredInteger(value: unknown, field: string): number { if (!Number.isSafeInteger(value)) throw new WalletError('VALIDATION_ERROR', `${field} must be an integer.`); return Number(value); }
function mapWalletError(error: unknown) {
  if (!(error instanceof WalletError)) return null;
  const statusCode = error.code === 'PERMISSION_DENIED' ? 403 : error.code === 'RESOURCE_NOT_FOUND' ? 404 :
    error.code === 'INSUFFICIENT_AVAILABLE_BALANCE' ? 422 : error.code === 'VALIDATION_ERROR' ? 400 : 409;
  return { statusCode, code: error.code, message: error.message };
}
function fundingAuditChanges(payload: TopUpResult | ExternalRefundDebitResult, evidenceType: string) {
  return [
    { targetType: 'wallet_account', targetId: payload.walletEntry.walletAccountId, changeType: 'UPDATE' as const,
      beforeSnapshot: null, afterSnapshot: payload.balance, changedFields: ['rowVersion'] },
    { targetType: evidenceType, targetId: payload.id, changeType: 'APPEND' as const,
      beforeSnapshot: null, afterSnapshot: { amountMinor: payload.amountMinor, currency: 'USD' }, changedFields: ['amountMinor', 'currency'] },
    { targetType: 'wallet_entry', targetId: payload.walletEntry.id, changeType: 'APPEND' as const,
      beforeSnapshot: null, afterSnapshot: payload.walletEntry, changedFields: ['amountMinor', 'direction', 'entryType'] }
  ];
}

interface PostgresEntryRow {
  id: string; wallet_account_id: string; entry_type: WalletEntryType; direction: 'CREDIT' | 'DEBIT';
  amount_minor: string | number; currency: string; source_type: string; source_id: string;
  reversal_of_entry_id: string | null; occurred_at: Date | string;
}

async function inWalletTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await run(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

async function ensureWallet(client: PoolClient, userId: string, now: Date, lock = false): Promise<{ walletAccountId: string; version: number }> {
  assertUuid(userId, 'userId');
  await client.query(`INSERT INTO wallet_accounts (id,user_id,currency,status,row_version,created_at,updated_at)
    VALUES ($1,$2,'USD','ACTIVE',1,$3,$3) ON CONFLICT (user_id) DO NOTHING`, [crypto.randomUUID(), userId, now]);
  const result = await client.query<{ id: string; row_version: number }>(
    `SELECT id,row_version FROM wallet_accounts WHERE user_id=$1${lock ? ' FOR UPDATE' : ''}`, [userId]);
  if (!result.rows[0]) throw new WalletError('RESOURCE_NOT_FOUND', 'Wallet user was not found.');
  return { walletAccountId: result.rows[0].id, version: result.rows[0].row_version };
}

async function readPostgresBalance(client: PoolClient, walletAccountId: string, version: number, now: Date): Promise<WalletBalance> {
  const result = await client.query<{ ledger: string; reserved: string }>(`
    SELECT
      COALESCE((SELECT sum(CASE WHEN direction='CREDIT' THEN amount_minor ELSE -amount_minor END)
        FROM wallet_entries WHERE wallet_account_id=$1),0)::text AS ledger,
      COALESCE((SELECT sum(GREATEST(fr.amount_minor-COALESCE(ev.settled,0),0))
        FROM fund_reservations fr
        LEFT JOIN LATERAL (SELECT sum(amount_minor) AS settled FROM fund_reservation_events
          WHERE fund_reservation_id=fr.id AND event_type IN ('CAPTURED','RELEASED','EXPIRED')) ev ON true
        JOIN wallet_accounts wa ON wa.user_id=fr.user_id
        WHERE wa.id=$1 AND fr.status IN ('PENDING','ACTIVE','DISPUTED','PARTIALLY_SETTLED')),0)::text AS reserved`, [walletAccountId]);
  const ledgerBalanceMinor = Number(result.rows[0]?.ledger ?? 0);
  const reservedMinor = Number(result.rows[0]?.reserved ?? 0);
  return { ledgerBalanceMinor, reservedMinor, availableMinor: ledgerBalanceMinor - reservedMinor,
    currency: 'USD', calculatedAt: now.toISOString(), version };
}

async function insertWalletEntry(client: PoolClient, entry: WalletEntry, idempotencyKey: string): Promise<void> {
  await client.query(`INSERT INTO wallet_entries
    (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,reversal_of_entry_id,idempotency_key,occurred_at,created_at)
    VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9,$10,$10)`,
    [entry.id, entry.walletAccountId, entry.entryType, entry.direction, entry.amountMinor, entry.sourceType,
      entry.sourceId, entry.reversalOfEntryId, idempotencyKey, new Date(entry.occurredAt)]);
}

async function incrementWalletVersion(client: PoolClient, walletAccountId: string, expected: number, now: Date): Promise<number> {
  const result = await client.query<{ row_version: number }>(`UPDATE wallet_accounts SET row_version=row_version+1,updated_at=$3
    WHERE id=$1 AND row_version=$2 RETURNING row_version`, [walletAccountId, expected, now]);
  if (!result.rows[0]) throw new WalletError('CONFLICT', 'Wallet version is stale.');
  return result.rows[0].row_version;
}

async function findPostgresTopUpByIdempotency(client: PoolClient, key: string, userId: string, now: Date): Promise<TopUpResult | null> {
  const result = await client.query<Record<string, unknown>>(`SELECT t.*,e.id entry_id,e.entry_type,e.direction,e.source_type,e.source_id,
    e.reversal_of_entry_id,e.occurred_at,w.user_id,w.row_version FROM top_ups t JOIN wallet_entries e ON e.id=t.wallet_entry_id
    JOIN wallet_accounts w ON w.id=t.wallet_account_id WHERE e.idempotency_key=$1`, [key]);
  const row = result.rows[0]; if (!row) return null;
  if (row.user_id !== userId) throw new WalletError('CONFLICT', 'Idempotency key belongs to another wallet.');
  const entry = mapPostgresEntry({ id: String(row.entry_id), wallet_account_id: String(row.wallet_account_id), entry_type: row.entry_type as WalletEntryType,
    direction: row.direction as 'CREDIT' | 'DEBIT', amount_minor: row.amount_minor as string, currency: 'USD', source_type: String(row.source_type),
    source_id: String(row.source_id), reversal_of_entry_id: row.reversal_of_entry_id as string | null, occurred_at: row.occurred_at as Date });
  return { id: String(row.id), userId, amountMinor: Number(row.amount_minor), currency: 'USD', paymentChannel: String(row.payment_channel),
    externalTransactionId: String(row.external_transaction_id), paidAt: new Date(row.paid_at as string).toISOString(), note: String(row.note),
    attachmentIds: [], walletEntry: entry, balance: await readPostgresBalance(client, String(row.wallet_account_id), Number(row.row_version), now),
    createdAt: new Date(row.created_at as string).toISOString() };
}

function mapPostgresEntry(row: PostgresEntryRow): WalletEntry {
  return { id: row.id, walletAccountId: row.wallet_account_id, entryType: row.entry_type, direction: row.direction,
    amountMinor: Number(row.amount_minor), currency: 'USD', sourceType: row.source_type, sourceId: row.source_id,
    reversalOfEntryId: row.reversal_of_entry_id, occurredAt: new Date(row.occurred_at).toISOString() };
}

function mapPostgresWalletError(error: unknown): Error {
  if (error instanceof WalletError) return error;
  const constraint = error && typeof error === 'object' ? String((error as { constraint?: unknown }).constraint ?? '') : '';
  if (constraint.includes('payment_channel_external_transaction_id')) return new WalletError('DUPLICATE_EXTERNAL_TRANSACTION', 'The channel transaction is already recorded.');
  if (constraint.includes('idempotency_key')) return new WalletError('CONFLICT', 'Idempotency key conflicts with another wallet operation.');
  return error instanceof Error ? error : new Error(String(error));
}
function publicReceipt(receipt: StoredReceipt): ReceiptAttachmentMetadata {
  return { id: receipt.id, mediaType: receipt.mediaType, originalFileName: receipt.originalFileName,
    byteSize: receipt.byteSize, sha256: receipt.sha256, uploadedAt: receipt.uploadedAt };
}
