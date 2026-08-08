import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import multipart from '@fastify/multipart';
import { Readable } from 'node:stream';
import type { StaffLevel } from './security.js';
import { insertPostgresAuditRecord, registerSecureReadRoute, registerSecureWriteRoute, type ActorContext, type AuditRecord } from './security.js';
import { levelRank } from './authorization-policy.js';
import type { ReceiptMediaType, ReceiptStorage } from './receipt-storage.js';
import { decodeBoundKeysetCursor, encodeBoundKeysetCursor } from './signed-cursor.js';
import type { CustomerProfileScope } from './customer-profiles.js';
import {
  activeReservationStatuses,
  reservationRemainingMinorSql,
  reservationSettlementLateralSql
} from './reservation-balance.js';
import type { WalletBalanceDto, WalletEntryDto, WalletEntryPageDto, WalletEntryTypeDto } from '@blackcat/platform/api-contracts';

export type WalletEntryType = WalletEntryTypeDto;
export type WalletBalance = WalletBalanceDto;
export type WalletEntry = WalletEntryDto & { walletAccountId: string; entryType: WalletEntryType; reversalOfEntryId: string | null };
export type WalletEntryPage = WalletEntryPageDto & { items: WalletEntry[] };

export interface WalletEntryPageInput {
  userId: string;
  cursor?: string | null;
  limit?: number;
}

export interface CreateTopUpInput {
  userId: string;
  amountMinor: number;
  paymentChannel: string;
  externalTransactionId: string;
  paidAt: string;
  note: string;
  reasonCode?: string;
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
  currency: 'CAT';
  paidAmountUsdCents: number;
  paidCurrency: 'USD';
  rateCatPerUsd: 10;
  creditedCatSubunits: number;
  paymentMethod: string;
  receiptNumber: string;
  reasonCode: string;
  paymentChannel: string;
  externalTransactionId: string;
  paidAt: string;
  note: string;
  attachmentIds: string[];
  walletEntry: WalletEntry;
  balance: WalletBalance;
  createdAt: string;
}

export interface ExternalRefundDebitResult extends Omit<TopUpResult,
  'paidAt' | 'paidAmountUsdCents' | 'paidCurrency' | 'rateCatPerUsd' | 'creditedCatSubunits' |
  'paymentMethod' | 'receiptNumber' | 'reasonCode'> {
  refundedAt: string;
}

export interface ReceiptAttachmentMetadata {
  id: string; mediaType: ReceiptMediaType; originalFileName: string; byteSize: number; sha256: string; uploadedAt: string;
}
interface StoredReceipt extends ReceiptAttachmentMetadata { userId: string; evidenceType: 'TOP_UP' | 'CASH_REFUND_DEBIT'; evidenceId: string; storageKey: string }

export interface ReserveInput {
  userId: string;
  sourceType: 'ORDER' | 'GIFT';
  sourceId: string;
  amountMinor: number;
  idempotencyKey: string;
  expiresAt: Date;
  now: Date;
}

export interface WalletFundingService {
  getBalance(input: { userId: string; now: Date }): Promise<WalletBalance>;
  reserve(input: ReserveInput): Promise<{ reservationId: string; balance: WalletBalance }>;
  capture(input: { reservationId: string; expectedVersion: number; idempotencyKey: string; now: Date }): Promise<{ walletEntryId: string; balance: WalletBalance }>;
  release(input: { reservationId: string; expectedVersion: number; idempotencyKey: string; now: Date }): Promise<{ reservationId: string; balance: WalletBalance }>;
  creditBusinessRefund(input: { userId: string; orderId: string; refundId: string; amountMinor: number; idempotencyKey: string; now: Date }): Promise<{ walletEntryId: string; balance: WalletBalance }>;
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
  reservations: Array<{ id: string; amountMinor: number; active: boolean; idempotencyKey: string; sourceType: 'ORDER'|'GIFT'; sourceId: string; version: number; capturedEntryId: string|null }>;
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
  readonly idempotentResults = new Map<string, TopUpResult | ExternalRefundDebitResult | WalletEntry |
    { reservationId: string; balance: WalletBalance } | { walletEntryId: string; balance: WalletBalance }>();
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
    validateTopUpEvidence(input);
    if (levelRank(input.actorLevel) < levelRank('L2_SUPERVISOR')) throw new WalletError('PERMISSION_DENIED', 'Manual CAT top-up requires L2_SUPERVISOR.');
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
      id, userId: input.userId, amountMinor: input.amountMinor, currency: 'CAT',
      ...topUpEvidenceProjection(input),
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
    wallet.reservations.push({ id: result.reservationId, amountMinor: input.amountMinor, active: true, idempotencyKey: input.idempotencyKey,
      sourceType:input.sourceType,sourceId:input.sourceId,version:1,capturedEntryId:null });
    wallet.version += 1;
    result.balance = balance(wallet, input.now);
    this.store.idempotentResults.set(input.idempotencyKey, structuredClone(result));
    return result;
  }

  async capture(input:{reservationId:string;expectedVersion:number;idempotencyKey:string;now:Date}):Promise<{walletEntryId:string;balance:WalletBalance}>{
    const replay=this.store.idempotentResults.get(input.idempotencyKey);if(replay&&'walletEntryId'in replay)return structuredClone(replay);
    const located=this.findReservation(input.reservationId);if(!located)throw new WalletError('RESOURCE_NOT_FOUND','Reservation was not found.');
    const {wallet,reservation}=located;if(!reservation.active||reservation.version!==input.expectedVersion)throw new WalletError('CONFLICT','Reservation is not active at the expected version.');
    const entry=makeEntry(wallet.id,reservation.sourceType==='ORDER'?'ORDER_CAPTURE_DEBIT':'GIFT_CAPTURE_DEBIT',reservation.amountMinor,
      'FUND_RESERVATION',reservation.id,input.idempotencyKey,null,input.now);
    wallet.entries.push(entry);reservation.active=false;reservation.capturedEntryId=entry.id;reservation.version+=1;wallet.version+=1;
    const result={walletEntryId:entry.id,balance:balance(wallet,input.now)};this.store.idempotentResults.set(input.idempotencyKey,structuredClone(result) as never);return result;
  }

  async release(input:{reservationId:string;expectedVersion:number;idempotencyKey:string;now:Date}):Promise<{reservationId:string;balance:WalletBalance}>{
    const replay=this.store.idempotentResults.get(input.idempotencyKey);if(replay&&'reservationId'in replay)return structuredClone(replay);
    const located=this.findReservation(input.reservationId);if(!located)throw new WalletError('RESOURCE_NOT_FOUND','Reservation was not found.');
    const {wallet,reservation}=located;if(!reservation.active||reservation.version!==input.expectedVersion)throw new WalletError('CONFLICT','Reservation is not active at the expected version.');
    reservation.active=false;reservation.version+=1;wallet.version+=1;const result={reservationId:reservation.id,balance:balance(wallet,input.now)};
    this.store.idempotentResults.set(input.idempotencyKey,structuredClone(result));return result;
  }

  async creditBusinessRefund(input:{userId:string;orderId:string;refundId:string;amountMinor:number;idempotencyKey:string;now:Date}):Promise<{walletEntryId:string;balance:WalletBalance}>{
    assertPositiveAmount(input.amountMinor);const replay=this.store.idempotentResults.get(input.idempotencyKey);if(replay&&'walletEntryId'in replay)return structuredClone(replay);
    const wallet=this.store.getOrCreate(input.userId);const entry=makeEntry(wallet.id,'ORDER_REFUND_CREDIT',input.amountMinor,'ORDER_REFUND',input.refundId,input.idempotencyKey,null,input.now);
    wallet.entries.push(entry);wallet.version+=1;const result={walletEntryId:entry.id,balance:balance(wallet,input.now)};this.store.idempotentResults.set(input.idempotencyKey,structuredClone(result) as never);return result;
  }

  private findReservation(id:string){for(const wallet of this.store.wallets.values()){const reservation=wallet.reservations.find(item=>item.id===id);if(reservation)return{wallet,reservation};}return null;}

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
    const entry = makeEntry(wallet.id, 'CASH_REFUND_DEBIT', input.amountMinor, 'CASH_REFUND_DEBIT', id, input.idempotencyKey, null, input.now);
    wallet.entries.push(entry);
    wallet.version += 1;
    const result: ExternalRefundDebitResult = {
      id, userId: input.userId, amountMinor: input.amountMinor, currency: 'CAT', paymentChannel: input.paymentChannel.trim(),
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

  async listEntries(input: WalletEntryPageInput): Promise<WalletEntryPage> {
    const limit = walletPageLimit(input.limit);
    const cursor = decodeWalletEntryCursor(input.cursor, input.userId);
    const entries = structuredClone(this.store.getOrCreate(input.userId).entries)
      .sort(compareWalletEntries)
      .filter((item) => !cursor || compareWalletEntryToCursor(item, cursor) > 0);
    const items = entries.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: entries.length > limit && last
        ? encodeWalletEntryCursor(last, input.userId)
        : null
    };
  }

  async createReceiptAttachment(input: { userId: string; evidenceType: 'TOP_UP' | 'CASH_REFUND_DEBIT'; evidenceId: string;
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
    amountMinor, currency: 'CAT', sourceType, sourceId, reversalOfEntryId, occurredAt: now.toISOString() };
}

function balance(wallet: StoredWallet, now: Date): WalletBalance {
  const ledgerBalanceMinor = wallet.entries.reduce((sum, entry) => sum + (entry.direction === 'CREDIT' ? entry.amountMinor : -entry.amountMinor), 0);
  const reservedMinor = wallet.reservations.filter((item) => item.active).reduce((sum, item) => sum + item.amountMinor, 0);
  return { ledgerBalanceMinor, reservedMinor, availableMinor: ledgerBalanceMinor - reservedMinor,
    currency: 'CAT', calculatedAt: now.toISOString(), version: wallet.version };
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

  async reserve(input: ReserveInput): Promise<{ reservationId: string; balance: WalletBalance }> {
    assertPositiveAmount(input.amountMinor);
    return inWalletTransaction(this.options.pool, async (client) => {
      const replay = await client.query<{ id: string; user_id: string }>(
        'SELECT id,user_id FROM fund_reservations WHERE idempotency_key=$1', [input.idempotencyKey]);
      if (replay.rows[0]) {
        if (replay.rows[0].user_id !== input.userId) throw new WalletError('CONFLICT', 'Idempotency key belongs to another wallet.');
        const wallet = await ensureWallet(client, input.userId, input.now, true);
        return { reservationId: replay.rows[0].id, balance: await readPostgresBalance(client, wallet.walletAccountId, wallet.version, input.now) };
      }
      const wallet = await ensureWallet(client, input.userId, input.now, true);
      const current = await readPostgresBalance(client, wallet.walletAccountId, wallet.version, input.now);
      if (current.availableMinor < input.amountMinor) throw new WalletError('INSUFFICIENT_AVAILABLE_BALANCE', 'Available wallet balance is insufficient.');
      const reservationId = crypto.randomUUID();
      await client.query(`INSERT INTO fund_reservations
        (id,user_id,source_type,order_id,gift_request_id,mode,provider,provider_hold_ref,amount_minor,currency,status,row_version,idempotency_key,expires_at,activated_at,created_at,updated_at)
        VALUES ($1,$2,$3::"FundReservationSourceType",$4,$5,'LOCAL_RESERVATION',NULL,NULL,$6,'CAT','ACTIVE',1,$7,$8,$9,$9,$9)`,
        [reservationId,input.userId,input.sourceType,input.sourceType==='ORDER'?input.sourceId:null,input.sourceType==='GIFT'?input.sourceId:null,
          input.amountMinor,input.idempotencyKey,input.expiresAt,input.now]);
      await insertWalletReservationEvent(client, { reservationId, sequence: 1, eventType: 'CREATED', fromStatus: null,
        toStatus: 'ACTIVE', amountMinor: input.amountMinor, version: 1, idempotencyKey: `${input.idempotencyKey}:event`, now: input.now });
      const version = await incrementWalletVersion(client, wallet.walletAccountId, wallet.version, input.now);
      return { reservationId, balance: await readPostgresBalance(client, wallet.walletAccountId, version, input.now) };
    });
  }

  async capture(input: { reservationId: string; expectedVersion: number; idempotencyKey: string; now: Date }): Promise<{ walletEntryId: string; balance: WalletBalance }> {
    return inWalletTransaction(this.options.pool, async (client) => {
      const replay = await findWalletLifecycleEntry(client, input.idempotencyKey, input.now);
      if (replay) return replay;
      const reservation = await lockWalletReservation(client, input.reservationId);
      if (reservation.status !== 'ACTIVE' || reservation.row_version !== input.expectedVersion) throw new WalletError('CONFLICT', 'Reservation is not active at the expected version.');
      const wallet = await ensureWallet(client, reservation.user_id, input.now, true);
      const entry = makeEntry(wallet.walletAccountId, reservation.source_type === 'ORDER' ? 'ORDER_CAPTURE_DEBIT' : 'GIFT_CAPTURE_DEBIT',
        Number(reservation.amount_minor), 'FUND_RESERVATION', reservation.id, input.idempotencyKey, null, input.now);
      await insertWalletEntry(client, entry, input.idempotencyKey);
      await insertWalletReservationEvent(client, { reservationId: reservation.id, sequence: await nextWalletReservationSequence(client, reservation.id),
        eventType: 'CAPTURED', fromStatus: 'ACTIVE', toStatus: 'CAPTURED', amountMinor: Number(reservation.amount_minor),
        version: input.expectedVersion + 1, idempotencyKey: `${input.idempotencyKey}:event`, now: input.now });
      const version = await incrementWalletVersion(client, wallet.walletAccountId, wallet.version, input.now);
      return { walletEntryId: entry.id, balance: await readPostgresBalance(client, wallet.walletAccountId, version, input.now) };
    });
  }

  async release(input: { reservationId: string; expectedVersion: number; idempotencyKey: string; now: Date }): Promise<{ reservationId: string; balance: WalletBalance }> {
    return inWalletTransaction(this.options.pool, async (client) => {
      const replay = await client.query<{ fund_reservation_id: string; user_id: string }>(`SELECT e.fund_reservation_id,r.user_id FROM fund_reservation_events e
        JOIN fund_reservations r ON r.id=e.fund_reservation_id WHERE e.idempotency_key=$1`, [`${input.idempotencyKey}:event`]);
      if (replay.rows[0]) {
        const wallet = await ensureWallet(client, replay.rows[0].user_id, input.now, true);
        return { reservationId: replay.rows[0].fund_reservation_id, balance: await readPostgresBalance(client, wallet.walletAccountId, wallet.version, input.now) };
      }
      const reservation = await lockWalletReservation(client, input.reservationId);
      if (reservation.status !== 'ACTIVE' || reservation.row_version !== input.expectedVersion) throw new WalletError('CONFLICT', 'Reservation is not active at the expected version.');
      const wallet = await ensureWallet(client, reservation.user_id, input.now, true);
      await insertWalletReservationEvent(client, { reservationId: reservation.id, sequence: await nextWalletReservationSequence(client, reservation.id),
        eventType: 'RELEASED', fromStatus: 'ACTIVE', toStatus: 'RELEASED', amountMinor: Number(reservation.amount_minor),
        version: input.expectedVersion + 1, idempotencyKey: `${input.idempotencyKey}:event`, now: input.now });
      const version = await incrementWalletVersion(client, wallet.walletAccountId, wallet.version, input.now);
      return { reservationId: reservation.id, balance: await readPostgresBalance(client, wallet.walletAccountId, version, input.now) };
    });
  }

  async creditBusinessRefund(input: { userId: string; orderId: string; refundId: string; amountMinor: number; idempotencyKey: string; now: Date }): Promise<{ walletEntryId: string; balance: WalletBalance }> {
    assertPositiveAmount(input.amountMinor);
    return inWalletTransaction(this.options.pool, async (client) => {
      const replay = await findWalletLifecycleEntry(client, input.idempotencyKey, input.now);
      if (replay) return replay;
      const wallet = await ensureWallet(client, input.userId, input.now, true);
      const entry = makeEntry(wallet.walletAccountId, 'ORDER_REFUND_CREDIT', input.amountMinor, 'ORDER_REFUND', input.refundId,
        input.idempotencyKey, null, input.now);
      await insertWalletEntry(client, entry, input.idempotencyKey);
      const version = await incrementWalletVersion(client, wallet.walletAccountId, wallet.version, input.now);
      return { walletEntryId: entry.id, balance: await readPostgresBalance(client, wallet.walletAccountId, version, input.now) };
    });
  }

  async createTopUp(input: CreateTopUpInput): Promise<TopUpResult> {
    validateTopUpEvidence(input);
    if (levelRank(input.actorLevel) < 2) throw new WalletError('PERMISSION_DENIED', 'Manual CAT top-up requires L2_SUPERVISOR.');
    return inWalletTransaction(this.options.pool, async (client) => {
      const wallet = await ensureWallet(client, input.userId, input.now, true);
      const replay = await findPostgresTopUpByIdempotency(client, input.idempotencyKey, input.userId, input.now);
      if (replay) return replay;
      const id = crypto.randomUUID();
      const entry = makeEntry(wallet.walletAccountId, 'TOP_UP_CREDIT', input.amountMinor, 'TOP_UP', id, input.idempotencyKey, null, input.now);
      try {
        await insertWalletEntry(client, entry, input.idempotencyKey);
        await client.query(`INSERT INTO top_ups
          (id,wallet_account_id,wallet_entry_id,paid_amount_usd_cents,paid_currency,rate_cat_per_usd,credited_cat_subunits,payment_method,receipt_number,paid_at,note,reason_code,created_by_staff_id,created_at)
          VALUES ($1,$2,$3,$4,'USD',10,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, wallet.walletAccountId, entry.id, input.amountMinor, input.paymentChannel.trim(), input.externalTransactionId.trim(),
            new Date(input.paidAt), input.note.trim(), input.reasonCode?.trim() || 'MANUAL_TOP_UP', input.actorStaffId, input.now]);
      } catch (error) { throw mapPostgresWalletError(error); }
      const version = await incrementWalletVersion(client, wallet.walletAccountId, wallet.version, input.now);
      return { id, userId: input.userId, amountMinor: input.amountMinor, currency: 'CAT', ...topUpEvidenceProjection(input), paymentChannel: input.paymentChannel.trim(),
        externalTransactionId: input.externalTransactionId.trim(), paidAt: new Date(input.paidAt).toISOString(), note: input.note.trim(),
        attachmentIds: [], walletEntry: entry, balance: await readPostgresBalance(client, wallet.walletAccountId, version, input.now), createdAt: input.now.toISOString() };
    });
  }

  async stageCreateTopUp(input: CreateTopUpInput): Promise<{ data: TopUpResult; commit: (audit: AuditRecord) => Promise<void> }> {
    validateTopUpEvidence(input);
    if (levelRank(input.actorLevel) < 2) throw new WalletError('PERMISSION_DENIED', 'Manual CAT top-up requires L2_SUPERVISOR.');
    const current = await this.options.pool.query<{ id: string; row_version: number }>('SELECT id,row_version FROM wallet_accounts WHERE user_id=$1', [input.userId]);
    const walletAccountId = current.rows[0]?.id ?? crypto.randomUUID();
    const currentVersion = current.rows[0]?.row_version ?? 1;
    const id = crypto.randomUUID();
    const entry = makeEntry(walletAccountId, 'TOP_UP_CREDIT', input.amountMinor, 'TOP_UP', id, input.idempotencyKey, null, input.now);
    const existingBalance = current.rows[0]
      ? await this.getBalance({ userId: input.userId, now: input.now })
      : { ledgerBalanceMinor: 0, reservedMinor: 0, availableMinor: 0, currency: 'CAT' as const, calculatedAt: input.now.toISOString(), version: 1 };
    const data: TopUpResult = { id, userId: input.userId, amountMinor: input.amountMinor, currency: 'CAT', ...topUpEvidenceProjection(input), paymentChannel: input.paymentChannel.trim(),
      externalTransactionId: input.externalTransactionId.trim(), paidAt: new Date(input.paidAt).toISOString(), note: input.note.trim(), attachmentIds: [],
      walletEntry: entry, balance: { ...existingBalance, ledgerBalanceMinor: existingBalance.ledgerBalanceMinor + input.amountMinor,
        availableMinor: existingBalance.availableMinor + input.amountMinor, version: currentVersion + 1 }, createdAt: input.now.toISOString() };
    return { data, commit: async (audit) => inWalletTransaction(this.options.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.userId]);
      const locked = await client.query<{ id: string; row_version: number }>('SELECT id,row_version FROM wallet_accounts WHERE user_id=$1 FOR UPDATE', [input.userId]);
      if (!locked.rows[0]) {
        await client.query(`INSERT INTO wallet_accounts (id,user_id,currency,status,row_version,created_at,updated_at)
          VALUES ($1,$2,'CAT','ACTIVE',1,$3,$3)`, [walletAccountId, input.userId, input.now]);
      } else if (locked.rows[0].id !== walletAccountId || locked.rows[0].row_version !== currentVersion) {
        throw new WalletError('CONFLICT', 'Wallet changed while the top-up was staged.');
      }
      try {
        await insertWalletEntry(client, entry, input.idempotencyKey);
        await client.query(`INSERT INTO top_ups
          (id,wallet_account_id,wallet_entry_id,paid_amount_usd_cents,paid_currency,rate_cat_per_usd,credited_cat_subunits,payment_method,receipt_number,paid_at,note,reason_code,created_by_staff_id,created_at)
          VALUES ($1,$2,$3,$4,'USD',10,$4,$5,$6,$7,$8,$9,$10,$11)`, [id,walletAccountId,entry.id,input.amountMinor,input.paymentChannel.trim(),
            input.externalTransactionId.trim(),new Date(input.paidAt),input.note.trim(),input.reasonCode?.trim() || 'MANUAL_TOP_UP',input.actorStaffId,input.now]);
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
      const entry = makeEntry(wallet.walletAccountId, 'CASH_REFUND_DEBIT', input.amountMinor, 'CASH_REFUND_DEBIT', id, input.idempotencyKey, null, input.now);
      try {
        await insertWalletEntry(client, entry, input.idempotencyKey);
        await client.query(`INSERT INTO external_refund_debits
          (id,wallet_account_id,wallet_entry_id,amount_minor,currency,payment_channel,external_transaction_id,refunded_at,note,created_by_staff_id,created_at)
          VALUES ($1,$2,$3,$4,'CAT',$5,$6,$7,$8,$9,$10)`,
          [id, wallet.walletAccountId, entry.id, input.amountMinor, input.paymentChannel.trim(), input.externalTransactionId.trim(),
            new Date(input.refundedAt), input.note.trim(), input.actorStaffId, input.now]);
      } catch (error) { throw mapPostgresWalletError(error); }
      const version = await incrementWalletVersion(client, wallet.walletAccountId, wallet.version, input.now);
      return { id, userId: input.userId, amountMinor: input.amountMinor, currency: 'CAT', paymentChannel: input.paymentChannel.trim(),
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
    const entry = makeEntry(walletAccountId, 'CASH_REFUND_DEBIT', input.amountMinor, 'CASH_REFUND_DEBIT', id, input.idempotencyKey, null, input.now);
    const data: ExternalRefundDebitResult = { id,userId:input.userId,amountMinor:input.amountMinor,currency:'CAT',paymentChannel:input.paymentChannel.trim(),
      externalTransactionId:input.externalTransactionId.trim(),refundedAt:new Date(input.refundedAt).toISOString(),note:input.note.trim(),attachmentIds:[],walletEntry:entry,
      balance:{...before,ledgerBalanceMinor:before.ledgerBalanceMinor-input.amountMinor,availableMinor:before.availableMinor-input.amountMinor,version:before.version+1},createdAt:input.now.toISOString() };
    return { data, commit: async (audit) => inWalletTransaction(this.options.pool, async (client) => {
      const locked = await client.query<{ row_version:number }>('SELECT row_version FROM wallet_accounts WHERE id=$1 FOR UPDATE',[walletAccountId]);
      if (locked.rows[0]?.row_version !== input.expectedWalletVersion) throw new WalletError('CONFLICT','Wallet changed while the refund debit was staged.');
      const lockedBalance=await readPostgresBalance(client,walletAccountId,input.expectedWalletVersion,input.now);
      if(lockedBalance.availableMinor<input.amountMinor)throw new WalletError('INSUFFICIENT_AVAILABLE_BALANCE','External refund debit exceeds available balance.');
      try { await insertWalletEntry(client,entry,input.idempotencyKey); await client.query(`INSERT INTO external_refund_debits
        (id,wallet_account_id,wallet_entry_id,amount_minor,currency,payment_channel,external_transaction_id,refunded_at,note,created_by_staff_id,created_at)
        VALUES ($1,$2,$3,$4,'CAT',$5,$6,$7,$8,$9,$10)`,[id,walletAccountId,entry.id,input.amountMinor,input.paymentChannel.trim(),input.externalTransactionId.trim(),new Date(input.refundedAt),input.note.trim(),input.actorStaffId,input.now]);
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

  async listEntries(input: WalletEntryPageInput): Promise<WalletEntryPage> {
    const limit = walletPageLimit(input.limit);
    const cursor = decodeWalletEntryCursor(input.cursor, input.userId);
    const result = await this.options.pool.query<PostgresEntryRow>(`SELECT e.* FROM wallet_entries e JOIN wallet_accounts w ON w.id=e.wallet_account_id
      WHERE w.user_id=$1 AND ($2::timestamptz IS NULL OR e.occurred_at<$2::timestamptz OR (e.occurred_at=$2::timestamptz AND e.id<$3::uuid))
      ORDER BY e.occurred_at DESC,e.id DESC LIMIT $4`, [input.userId, cursor?.occurredAt ?? null, cursor?.id ?? null, limit + 1]);
    const items = result.rows.slice(0, limit).map(mapPostgresEntry);
    const last = items.at(-1);
    return {
      items,
      nextCursor: result.rows.length > limit && last
        ? encodeWalletEntryCursor(last, input.userId)
        : null
    };
  }

  async createReceiptAttachment(input: { userId: string; evidenceType: 'TOP_UP' | 'CASH_REFUND_DEBIT'; evidenceId: string;
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
        input.evidenceType === 'TOP_UP' ? input.evidenceId : null,input.evidenceType === 'CASH_REFUND_DEBIT' ? input.evidenceId : null,
        input.mediaType,input.originalFileName,input.stored.byteSize,input.stored.sha256,input.stored.storageKey,input.actorStaffId,input.now]);
      return publicReceipt(receipt);
    });
  }

  async stageCreateReceiptAttachment(input: { userId: string; evidenceType: 'TOP_UP' | 'CASH_REFUND_DEBIT'; evidenceId: string;
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
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[receipt.id,walletId,input.evidenceType==='TOP_UP'?input.evidenceId:null,input.evidenceType==='CASH_REFUND_DEBIT'?input.evidenceId:null,
        input.mediaType,input.originalFileName,input.stored.byteSize,input.stored.sha256,input.stored.storageKey,input.actorStaffId,input.now]);
      await insertPostgresAuditRecord(client,audit);
    })};
  }

  async getReceiptAttachment(input: { attachmentId: string }): Promise<StoredReceipt> {
    const result = await this.options.pool.query<Record<string, unknown>>(`SELECT r.*,w.user_id,
      CASE WHEN r.top_up_id IS NOT NULL THEN 'TOP_UP' ELSE 'CASH_REFUND_DEBIT' END evidence_type,
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
  listEntries(input: WalletEntryPageInput): Promise<WalletEntryPage>;
  reserve(input: ReserveInput): Promise<{ reservationId: string; balance: WalletBalance }>;
  capture(input: { reservationId: string; expectedVersion: number; idempotencyKey: string; now: Date }): Promise<{ walletEntryId: string; balance: WalletBalance }>;
  release(input: { reservationId: string; expectedVersion: number; idempotencyKey: string; now: Date }): Promise<{ reservationId: string; balance: WalletBalance }>;
  creditBusinessRefund(input: { userId: string; orderId: string; refundId: string; amountMinor: number; idempotencyKey: string; now: Date }): Promise<{ walletEntryId: string; balance: WalletBalance }>;
  stageCreateTopUp?(input: CreateTopUpInput): Promise<{ data: TopUpResult; commit: (audit: AuditRecord) => Promise<void> }>;
  stageCreateExternalRefundDebit?(input: CreateExternalRefundDebitInput): Promise<{ data: ExternalRefundDebitResult; commit: (audit: AuditRecord) => Promise<void> }>;
  stageCreateAdjustment?(input: CreateWalletAdjustmentInput): Promise<{ data: WalletEntry; commit: (audit: AuditRecord) => Promise<void> }>;
  createReceiptAttachment(input: { userId: string; evidenceType: 'TOP_UP' | 'CASH_REFUND_DEBIT'; evidenceId: string;
    stored: { storageKey: string; byteSize: number; sha256: string }; mediaType: ReceiptMediaType; originalFileName: string; actorStaffId: string; now: Date }): Promise<ReceiptAttachmentMetadata>;
  getReceiptAttachment(input: { attachmentId: string }): Promise<StoredReceipt>;
  stageCreateReceiptAttachment?(input: Parameters<WalletApplicationService['createReceiptAttachment']>[0]): Promise<{ data: ReceiptAttachmentMetadata; commit: (audit: AuditRecord) => Promise<void> }>;
}

export interface WalletActorAccountResolver {
  findByDiscord(input: { guildId: string; discordUserId: string }): Promise<{ userId: string } | null>;
}

export async function resolveWalletActorUserId(
  actor: { actorUserId: string | null; guildId: string | null; discordUserId: string | null },
  accounts?: WalletActorAccountResolver
): Promise<string> {
  if (actor.actorUserId) return actor.actorUserId;
  if (actor.guildId && actor.discordUserId && accounts) {
    const binding = await accounts.findByDiscord({ guildId: actor.guildId, discordUserId: actor.discordUserId });
    if (binding) return binding.userId;
  }
  throw new WalletError('PERMISSION_DENIED', 'A bound wallet account is required.');
}

export function registerWalletRoutes(server: FastifyInstance, options: { service: WalletApplicationService; accountStore?: WalletActorAccountResolver;
  customerScope?: CustomerProfileScope; receiptStorage?: ReceiptStorage; now?: () => Date }): void {
  if (!server.securityOptions) throw new Error('Wallet routes require security options.');
  const now = options.now ?? (() => new Date());
  registerSecureReadRoute(server, server.securityOptions, {
    method: 'GET', url: '/api/v1/me/balance', permission: 'balance.self.read', action: 'GET_MY_WALLET_BALANCE',
    targetType: 'wallet_account', acceptedSources: ['DISCORD_BOT', 'DASHBOARD'], allowServiceActor: true,
    handler: async (_request, actor) => options.service.getBalance({ userId: await resolveWalletActorUserId(actor, options.accountStore), now: now() })
  });
  registerSecureReadRoute(server, server.securityOptions, {
    method: 'GET', url: '/api/v1/admin/users/:userId/wallet', permission: 'wallet.read', action: 'GET_ADMIN_WALLET',
    targetType: 'wallet_account', targetId: userTarget, acceptedSources: ['DASHBOARD'], mapError: mapWalletError,
    handler: async (request, actor) => {
      const userId = userTarget(request); await requireWalletCustomerScope(options.customerScope, userId, actor);
      return options.service.getBalance({ userId, now: now() });
    }
  });
  registerSecureReadRoute(server, server.securityOptions, {
    method: 'GET', url: '/api/v1/admin/users/:userId/wallet/entries', permission: 'wallet.read', action: 'LIST_ADMIN_WALLET_ENTRIES',
    targetType: 'wallet_entry', targetId: userTarget, acceptedSources: ['DASHBOARD'], mapError: mapWalletError,
    handler: async (request, actor) => {
      const userId = userTarget(request); await requireWalletCustomerScope(options.customerScope, userId, actor);
      return options.service.listEntries({ userId, ...walletEntryPageQuery(request) });
    }
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST', url: '/api/v1/admin/users/:userId/top-ups', permission: 'wallet.top_up', action: 'CREATE_ADMIN_TOP_UP',
    targetType: 'top_up', targetId: userTarget, acceptedSources: ['DASHBOARD'], successStatusCode: 201,
    mapError: mapWalletError, requiresRecentStepUp: true,
    auditChanges: (_request, _actor, payload) => fundingAuditChanges(payload as TopUpResult, 'top_up'),
    handler: async (request, actor) => {
      const userId = userTarget(request); await requireWalletCustomerScope(options.customerScope, userId, actor);
      const input = { ...fundingBody(request, 'paidAt'), userId, idempotencyKey: requireIdempotencyKey(request),
        actorStaffId: requireActorStaff(actor), actorLevel: requireActorLevel(actor), now: now() };
      return options.service.stageCreateTopUp?.(input) ?? options.service.createTopUp(input);
    }
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST', url: '/api/v1/admin/users/:userId/external-refund-debits', permission: 'wallet.external_refund',
    action: 'CREATE_ADMIN_CASH_REFUND_DEBIT', targetType: 'external_refund_debit', targetId: userTarget,
    acceptedSources: ['DASHBOARD'], successStatusCode: 201, mapError: mapWalletError,
    auditChanges: (_request, _actor, payload) => fundingAuditChanges(payload as ExternalRefundDebitResult, 'external_refund_debit'),
    handler: async (request, actor) => {
      const userId = userTarget(request); await requireWalletCustomerScope(options.customerScope, userId, actor);
      const body = fundingBody(request, 'refundedAt') as ReturnType<typeof fundingBody> & { expectedWalletVersion?: unknown };
      const input = { ...body, expectedWalletVersion: requiredInteger(body.expectedWalletVersion, 'expectedWalletVersion'),
        userId, idempotencyKey: requireIdempotencyKey(request), actorStaffId: requireActorStaff(actor),
        actorLevel: requireActorLevel(actor), now: now() };
      return options.service.stageCreateExternalRefundDebit?.(input) ?? options.service.createExternalRefundDebit(input);
    }
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST', url: '/api/v1/admin/users/:userId/wallet-adjustments', permission: 'wallet.adjust', action: 'CREATE_WALLET_ADJUSTMENT',
    targetType: 'wallet_entry', targetId: userTarget, acceptedSources: ['DASHBOARD'], successStatusCode: 201, mapError: mapWalletError,
    handler: async (request, actor) => {
      const userId = userTarget(request); await requireWalletCustomerScope(options.customerScope, userId, actor);
      const body = request.body as Record<string, unknown>;
      const input = { userId, entryType: body.entryType as 'ADJUSTMENT_CREDIT' | 'ADJUSTMENT_DEBIT',
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
        const userId = userTarget(request); await requireWalletCustomerScope(options.customerScope, userId, actor);
        let evidenceType = ''; let evidenceId = ''; let stored: { storageKey: string; byteSize: number; sha256: string } | null = null;
        let mediaType = ''; let originalFileName = '';
        try {
          for await (const part of request.parts()) {
            if (part.type === 'field') { if (part.fieldname === 'evidenceType') evidenceType = String(part.value); if (part.fieldname === 'evidenceId') evidenceId = String(part.value); continue; }
            mediaType = part.mimetype; originalFileName = part.filename;
            stored = await options.receiptStorage!.put({ body: part.file, mediaType: mediaType as ReceiptMediaType, originalFileName });
          }
          if ((evidenceType !== 'TOP_UP' && evidenceType !== 'CASH_REFUND_DEBIT') || !isUuid(evidenceId) || !stored) throw new WalletError('VALIDATION_ERROR', 'evidenceType, evidenceId and file are required.');
          const input = { userId, evidenceType: evidenceType as 'TOP_UP' | 'CASH_REFUND_DEBIT', evidenceId, stored, mediaType: mediaType as ReceiptMediaType,
            originalFileName, actorStaffId: requireActorStaff(actor), now: now() };
          const result = await (options.service.stageCreateReceiptAttachment?.(input) ?? options.service.createReceiptAttachment(input));
          if (isStagedReceiptWrite(result)) {
            return { ...result, abort: () => options.receiptStorage!.remove(stored!.storageKey) };
          }
          return result;
        } catch (error) {
          if (stored) await options.receiptStorage!.remove(stored.storageKey);
          throw error;
        }
      }
    });
    registerSecureReadRoute(server, server.securityOptions, {
      method: 'GET', url: '/api/v1/admin/receipt-attachments/:attachmentId/content', permission: 'wallet.read', action: 'GET_RECEIPT_ATTACHMENT_CONTENT',
      targetType: 'receipt_attachment', targetId: (request) => String((request.params as { attachmentId?: string }).attachmentId ?? ''), acceptedSources: ['DASHBOARD'], mapError: mapWalletError,
      handler: async (request, actor) => {
        const receipt = await options.service.getReceiptAttachment({ attachmentId: String((request.params as { attachmentId?: string }).attachmentId ?? '') });
        await requireWalletCustomerScope(options.customerScope, receipt.userId, actor);
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

function isStagedReceiptWrite(value: unknown): value is { data: ReceiptAttachmentMetadata; commit: (audit: AuditRecord) => Promise<void> } {
  return Boolean(value && typeof value === 'object' && 'data' in value && 'commit' in value
    && typeof (value as { commit?: unknown }).commit === 'function');
}

function fundingBody(request: FastifyRequest, timestamp: 'paidAt' | 'refundedAt') {
  const body = request.body as Record<string, unknown>;
  const topUp = timestamp === 'paidAt';
  if (topUp && body.paidCurrency !== undefined && body.paidCurrency !== 'USD') {
    throw new WalletError('VALIDATION_ERROR', 'paidCurrency must be USD.');
  }
  return { amountMinor: requiredInteger(topUp ? body.paidAmountUsdCents : body.amountMinor, topUp ? 'paidAmountUsdCents' : 'amountMinor'),
    paymentChannel: String(topUp ? body.paymentMethod : body.paymentChannel ?? ''),
    externalTransactionId: String(topUp ? body.receiptNumber : body.externalTransactionId ?? ''), [timestamp]: String(body[timestamp] ?? ''), note: String(body.note ?? ''),
    reasonCode: topUp ? String(body.reasonCode ?? '') : undefined,
    expectedWalletVersion: body.expectedWalletVersion } as { amountMinor: number; paymentChannel: string; externalTransactionId: string;
      paidAt: string; refundedAt: string; note: string; reasonCode?: string; expectedWalletVersion?: unknown };
}
function userTarget(request: FastifyRequest): string {
  const value = String((request.params as { userId?: string }).userId ?? '');
  assertUuid(value, 'userId');
  return value;
}
function walletEntryPageQuery(request: FastifyRequest): { cursor: string | null; limit: number } {
  const query = request.query as { cursor?: unknown; limit?: unknown };
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 500)) {
    throw new WalletError('VALIDATION_ERROR', 'cursor is invalid.');
  }
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  return { cursor: query.cursor as string | undefined ?? null, limit: walletPageLimit(limit) };
}
function walletPageLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new WalletError('VALIDATION_ERROR', 'limit must be between 1 and 100.');
  }
  return limit;
}
function encodeWalletEntryCursor(entry: Pick<WalletEntry, 'id' | 'occurredAt'>, userId: string): string {
  return encodeBoundKeysetCursor('wallet-entries', { id: entry.id, at: entry.occurredAt }, userId);
}
function decodeWalletEntryCursor(value: string | null | undefined, userId: string): { id: string; occurredAt: string } | null {
  if (!value) return null;
  try {
    const cursor = decodeBoundKeysetCursor(value, 'wallet-entries', userId);
    return { id: cursor.id, occurredAt: cursor.at };
  } catch {
    throw new WalletError('VALIDATION_ERROR', 'cursor is invalid.');
  }
}
function compareWalletEntries(
  left: Pick<WalletEntry, 'id' | 'occurredAt'>,
  right: Pick<WalletEntry, 'id' | 'occurredAt'>
): number {
  return right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id);
}
function compareWalletEntryToCursor(item: WalletEntry, cursor: { id: string; occurredAt: string }): number {
  return compareWalletEntries(item, cursor);
}
function requireIdempotencyKey(request: FastifyRequest): string { return String(request.headers['idempotency-key'] ?? ''); }
function requireActorUser(actor: ActorContext): string { if (!actor.actorUserId) throw new WalletError('PERMISSION_DENIED', 'User actor is required.'); return actor.actorUserId; }
function requireActorStaff(actor: ActorContext): string { if (!actor.actorStaffId) throw new WalletError('PERMISSION_DENIED', 'Staff actor is required.'); return actor.actorStaffId; }
function requireActorLevel(actor: ActorContext): StaffLevel { if (!actor.actorLevel) throw new WalletError('PERMISSION_DENIED', 'Staff level is required.'); return actor.actorLevel; }
async function requireWalletCustomerScope(scope: CustomerProfileScope | undefined, userId: string, actor: ActorContext): Promise<void> {
  if (!scope || !actor.actorStaffId || !actor.actorLevel || !actor.guildId
    || !await scope.canReadCustomer({ userId, actorStaffId: actor.actorStaffId, actorLevel: actor.actorLevel, guildId: actor.guildId })) {
    throw new WalletError('RESOURCE_NOT_FOUND', 'Wallet customer was not found.');
  }
}
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
      beforeSnapshot: null, afterSnapshot: 'paidAmountUsdCents' in payload
        ? { paidAmountUsdCents: payload.paidAmountUsdCents, paidCurrency: 'USD', creditedCatSubunits: payload.creditedCatSubunits, currency: 'CAT' }
        : { amountMinor: payload.amountMinor, currency: 'CAT' },
      changedFields: 'paidAmountUsdCents' in payload ? ['paidAmountUsdCents', 'creditedCatSubunits'] : ['amountMinor', 'currency'] },
    { targetType: 'wallet_entry', targetId: payload.walletEntry.id, changeType: 'APPEND' as const,
      beforeSnapshot: null, afterSnapshot: payload.walletEntry, changedFields: ['amountMinor', 'direction', 'entryType'] }
  ];
}

function topUpEvidenceProjection(input: CreateTopUpInput) {
  return {
    paidAmountUsdCents: input.amountMinor,
    paidCurrency: 'USD' as const,
    rateCatPerUsd: 10 as const,
    creditedCatSubunits: input.amountMinor,
    paymentMethod: input.paymentChannel.trim(),
    receiptNumber: input.externalTransactionId.trim(),
    reasonCode: input.reasonCode?.trim() || 'MANUAL_TOP_UP'
  };
}

function validateTopUpEvidence(input: CreateTopUpInput): void {
  validateFundingEvidence(input.amountMinor, input.paymentChannel, input.externalTransactionId, input.paidAt, input.note);
  if (!['ZELLE', 'PAYPAL', 'BANK_TRANSFER', 'CASH', 'OTHER'].includes(input.paymentChannel.trim())) {
    throw new WalletError('VALIDATION_ERROR', 'paymentMethod is invalid.');
  }
  if (input.reasonCode !== undefined) assertNonEmpty(input.reasonCode, 'reasonCode', 80);
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
    VALUES ($1,$2,'CAT','ACTIVE',1,$3,$3) ON CONFLICT (user_id) DO NOTHING`, [crypto.randomUUID(), userId, now]);
  const result = await client.query<{ id: string; row_version: number }>(
    `SELECT id,row_version FROM wallet_accounts WHERE user_id=$1${lock ? ' FOR UPDATE' : ''}`, [userId]);
  if (!result.rows[0]) throw new WalletError('RESOURCE_NOT_FOUND', 'Wallet user was not found.');
  return { walletAccountId: result.rows[0].id, version: result.rows[0].row_version };
}

async function readPostgresBalance(client: PoolClient, walletAccountId: string, version: number, now: Date): Promise<WalletBalance> {
  const settlementJoin = reservationSettlementLateralSql('fr', 'settlement');
  const remainingMinor = reservationRemainingMinorSql('fr', 'settlement');
  const result = await client.query<{ ledger: string; reserved: string }>(`
    SELECT
      COALESCE((SELECT sum(CASE WHEN direction='CREDIT' THEN amount_minor ELSE -amount_minor END)
        FROM wallet_entries WHERE wallet_account_id=$1),0)::text AS ledger,
      COALESCE((SELECT sum(${remainingMinor})
        FROM fund_reservations fr
        ${settlementJoin}
        JOIN wallet_accounts wa ON wa.user_id=fr.user_id
        WHERE wa.id=$1 AND fr.status IN (${activeReservationStatuses.map(status => `'${status}'`).join(',')})),0)::text AS reserved`, [walletAccountId]);
  const ledgerBalanceMinor = Number(result.rows[0]?.ledger ?? 0);
  const reservedMinor = Number(result.rows[0]?.reserved ?? 0);
  return { ledgerBalanceMinor, reservedMinor, availableMinor: ledgerBalanceMinor - reservedMinor,
    currency: 'CAT', calculatedAt: now.toISOString(), version };
}

async function insertWalletEntry(client: PoolClient, entry: WalletEntry, idempotencyKey: string): Promise<void> {
  await client.query(`INSERT INTO wallet_entries
    (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,reversal_of_entry_id,idempotency_key,occurred_at,created_at)
    VALUES ($1,$2,$3,$4,$5,'CAT',$6,$7,$8,$9,$10,$10)`,
    [entry.id, entry.walletAccountId, entry.entryType, entry.direction, entry.amountMinor, entry.sourceType,
      entry.sourceId, entry.reversalOfEntryId, idempotencyKey, new Date(entry.occurredAt)]);
}

async function incrementWalletVersion(client: PoolClient, walletAccountId: string, expected: number, now: Date): Promise<number> {
  const result = await client.query<{ row_version: number }>(`UPDATE wallet_accounts SET row_version=row_version+1,updated_at=$3
    WHERE id=$1 AND row_version=$2 RETURNING row_version`, [walletAccountId, expected, now]);
  if (!result.rows[0]) throw new WalletError('CONFLICT', 'Wallet version is stale.');
  return result.rows[0].row_version;
}

interface WalletReservationRow {
  id: string;
  user_id: string;
  source_type: 'ORDER' | 'GIFT';
  amount_minor: string | number | bigint;
  status: string;
  row_version: number;
}

async function lockWalletReservation(client: PoolClient, reservationId: string): Promise<WalletReservationRow> {
  const result = await client.query<WalletReservationRow>('SELECT id,user_id,source_type,amount_minor,status,row_version FROM fund_reservations WHERE id=$1 FOR UPDATE', [reservationId]);
  if (!result.rows[0]) throw new WalletError('RESOURCE_NOT_FOUND', 'Reservation was not found.');
  return result.rows[0];
}

async function nextWalletReservationSequence(client: PoolClient, reservationId: string): Promise<number> {
  const result = await client.query<{ sequence: number }>('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM fund_reservation_events WHERE fund_reservation_id=$1', [reservationId]);
  return Number(result.rows[0]?.sequence ?? 1);
}

async function insertWalletReservationEvent(client: PoolClient, input: { reservationId: string; sequence: number;
  eventType: 'CREATED' | 'CAPTURED' | 'RELEASED'; fromStatus: 'ACTIVE' | null; toStatus: 'ACTIVE' | 'CAPTURED' | 'RELEASED';
  amountMinor: number; version: number; idempotencyKey: string; now: Date }): Promise<void> {
  await client.query(`INSERT INTO fund_reservation_events
    (id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,idempotency_key,actor_user_id,actor_staff_id,actor_source,reason_code,created_at)
    VALUES ($1,$2,$3,$4::"FundReservationEventType",$5::"FundReservationStatus",$6::"FundReservationStatus",$7,$8,$9,NULL,NULL,'SYSTEM_JOB',NULL,$10)`,
    [crypto.randomUUID(),input.reservationId,input.sequence,input.eventType,input.fromStatus,input.toStatus,input.amountMinor,input.version,input.idempotencyKey,input.now]);
}

async function findWalletLifecycleEntry(client: PoolClient, idempotencyKey: string, now: Date): Promise<{ walletEntryId: string; balance: WalletBalance } | null> {
  const result = await client.query<{ id: string; wallet_account_id: string; row_version: number }>(`SELECT e.id,e.wallet_account_id,w.row_version
    FROM wallet_entries e JOIN wallet_accounts w ON w.id=e.wallet_account_id WHERE e.idempotency_key=$1`, [idempotencyKey]);
  const row = result.rows[0];
  return row ? { walletEntryId: row.id, balance: await readPostgresBalance(client, row.wallet_account_id, row.row_version, now) } : null;
}

async function findPostgresTopUpByIdempotency(client: PoolClient, key: string, userId: string, now: Date): Promise<TopUpResult | null> {
  const result = await client.query<Record<string, unknown>>(`SELECT t.*,e.id entry_id,e.entry_type,e.direction,e.source_type,e.source_id,
    e.reversal_of_entry_id,e.occurred_at,w.user_id,w.row_version FROM top_ups t JOIN wallet_entries e ON e.id=t.wallet_entry_id
    JOIN wallet_accounts w ON w.id=t.wallet_account_id WHERE e.idempotency_key=$1`, [key]);
  const row = result.rows[0]; if (!row) return null;
  if (row.user_id !== userId) throw new WalletError('CONFLICT', 'Idempotency key belongs to another wallet.');
  const entry = mapPostgresEntry({ id: String(row.entry_id), wallet_account_id: String(row.wallet_account_id), entry_type: row.entry_type as WalletEntryType,
    direction: row.direction as 'CREDIT' | 'DEBIT', amount_minor: row.credited_cat_subunits as string, currency: 'CAT', source_type: String(row.source_type),
    source_id: String(row.source_id), reversal_of_entry_id: row.reversal_of_entry_id as string | null, occurred_at: row.occurred_at as Date });
  return { id: String(row.id), userId, amountMinor: Number(row.credited_cat_subunits), currency: 'CAT',
    paidAmountUsdCents: Number(row.paid_amount_usd_cents), paidCurrency: 'USD', rateCatPerUsd: 10,
    creditedCatSubunits: Number(row.credited_cat_subunits), paymentMethod: String(row.payment_method), receiptNumber: String(row.receipt_number),
    reasonCode: String(row.reason_code), paymentChannel: String(row.payment_method),
    externalTransactionId: String(row.receipt_number), paidAt: new Date(row.paid_at as string).toISOString(), note: String(row.note),
    attachmentIds: [], walletEntry: entry, balance: await readPostgresBalance(client, String(row.wallet_account_id), Number(row.row_version), now),
    createdAt: new Date(row.created_at as string).toISOString() };
}

function mapPostgresEntry(row: PostgresEntryRow): WalletEntry {
  return { id: row.id, walletAccountId: row.wallet_account_id, entryType: row.entry_type, direction: row.direction,
    amountMinor: Number(row.amount_minor), currency: 'CAT', sourceType: row.source_type, sourceId: row.source_id,
    reversalOfEntryId: row.reversal_of_entry_id, occurredAt: new Date(row.occurred_at).toISOString() };
}

function mapPostgresWalletError(error: unknown): Error {
  if (error instanceof WalletError) return error;
  const constraint = error && typeof error === 'object' ? String((error as { constraint?: unknown }).constraint ?? '') : '';
  if (constraint.includes('payment_method_receipt_number')) return new WalletError('DUPLICATE_EXTERNAL_TRANSACTION', 'The receipt number is already recorded for this payment method.');
  if (constraint.includes('idempotency_key')) return new WalletError('CONFLICT', 'Idempotency key conflicts with another wallet operation.');
  return error instanceof Error ? error : new Error(String(error));
}
function publicReceipt(receipt: StoredReceipt): ReceiptAttachmentMetadata {
  return { id: receipt.id, mediaType: receipt.mediaType, originalFileName: receipt.originalFileName,
    byteSize: receipt.byteSize, sha256: receipt.sha256, uploadedAt: receipt.uploadedAt };
}
