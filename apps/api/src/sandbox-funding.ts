import { createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AdapterError,
  type CreateRefundInput,
  type CreateReservationDebitInput,
  type FundingAdapter,
  type Hold,
  type Transaction
} from './payment-adapter.js';
import { insertPostgresAuditRecord, type AuditRecord } from './security.js';
import { registerSecureReadRoute, registerSecureWriteRoute, type SecurityOptions } from './security.js';

export interface SandboxAccount {
  id: string;
  externalUserId: string;
  displayName: string;
  currency: 'CNY';
  status: 'ACTIVE' | 'SUSPENDED';
  version: number;
}

export interface SandboxBalance {
  accountId: string;
  providerBalanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  currency: 'CNY';
  version: number;
  fetchedAt: string;
}

export interface SetSandboxTargetBalanceInput {
  accountId: string;
  currency: 'CNY';
  targetProviderBalanceMinor: number;
  expectedVersion: number;
  reasonCode: 'SANDBOX_TEST_SETUP';
  idempotencyKey: string;
  createdByStaffId: string;
  now: Date;
}

export class SandboxFundingError extends Error {
  constructor(
    readonly code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'PERMISSION_DENIED' | 'ACTIVE_RESERVATION_EXISTS' | 'VERSION_CONFLICT',
    message: string
  ) {
    super(message);
    this.name = 'SandboxFundingError';
  }
}

export interface StagedSandboxBalanceWrite {
  data: SandboxBalance;
  commit(successAudit: AuditRecord): Promise<void>;
}

export interface SandboxFundingStore {
  resolveAccount(externalUserId: string): Promise<SandboxAccount | null>;
  consumeBindingCodeHash(bindingCodeHash: string, now: Date): Promise<SandboxAccount | null>;
  resolveAccountIdForUser(userId: string): Promise<string>;
  getBalance(accountId: string): Promise<SandboxBalance>;
  stageTargetBalance(input: SetSandboxTargetBalanceInput): Promise<StagedSandboxBalanceWrite>;
  createDebit(input: CreateReservationDebitInput): Promise<Transaction>;
  createRefund(input: CreateRefundInput): Promise<Transaction>;
  getTransaction(idempotencyKey: string): Promise<Transaction | null>;
  getTransactionByProviderRef?(providerRef: string): Promise<Transaction | null>;
}

export class PostgresSandboxFundingStore implements SandboxFundingStore {
  constructor(private readonly pool: Pool) {}

  async resolveAccount(externalUserId: string): Promise<SandboxAccount | null> {
    const result = await this.pool.query<AccountRow>(`${accountSelect} WHERE external_user_id=$1 LIMIT 1`, [externalUserId]);
    return result.rows[0] ? mapAccount(result.rows[0]) : null;
  }

  async consumeBindingCodeHash(bindingCodeHash: string, now: Date): Promise<SandboxAccount | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<AccountRow>(`UPDATE sandbox_provider_accounts
        SET binding_code_consumed_at=$2, updated_at=$2
        WHERE binding_code_hash=$1 AND binding_code_consumed_at IS NULL
        RETURNING id,external_user_id,display_name,currency,status,version`, [bindingCodeHash, now]);
      await client.query('COMMIT');
      return result.rows[0] ? mapAccount(result.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveAccountIdForUser(userId: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(`SELECT sandbox.id
      FROM external_accounts external
      JOIN sandbox_provider_accounts sandbox ON sandbox.external_user_id=external.external_user_id
      WHERE external.user_id=$1 AND external.provider='sandbox-provider' AND external.status='ACTIVE'
      LIMIT 1`, [userId]);
    if (!result.rows[0]) throw new SandboxFundingError('NOT_FOUND', 'Sandbox funding account was not found.');
    return result.rows[0].id;
  }

  async getBalance(accountId: string): Promise<SandboxBalance> {
    const client = await this.pool.connect();
    try {
      return await readBalance(client, accountId, new Date());
    } finally {
      client.release();
    }
  }

  async stageTargetBalance(input: SetSandboxTargetBalanceInput): Promise<StagedSandboxBalanceWrite> {
    validateTargetInput(input);
    const client = await this.pool.connect();
    let finalized = false;
    try {
      await client.query('BEGIN');
      const account = await lockAccount(client, input.accountId);
      if (account.version !== input.expectedVersion) throw new SandboxFundingError('VERSION_CONFLICT', 'Sandbox account version is stale.');
      const before = await readBalance(client, input.accountId, input.now);
      if (before.reservedMinor > 0) throw new SandboxFundingError('ACTIVE_RESERVATION_EXISTS', 'Active reservations prevent Sandbox target-balance changes.');
      const delta = input.targetProviderBalanceMinor - before.providerBalanceMinor;
      let version = before.version;
      if (delta !== 0) {
        const direction = delta > 0 ? 'CREDIT' : 'DEBIT';
        await client.query(`INSERT INTO sandbox_provider_balance_adjustments
          (id,account_id,direction,amount_minor,balance_before_minor,balance_after_minor,reason_code,idempotency_key,created_by_staff_id,created_at)
          VALUES ($1,$2,$3::"SandboxProviderAdjustmentDirection",$4,$5,$6,$7,$8,$9,$10)`,
        [randomUUID(), input.accountId, direction, Math.abs(delta), before.providerBalanceMinor,
          input.targetProviderBalanceMinor, input.reasonCode, input.idempotencyKey, input.createdByStaffId, input.now]);
        const updated = await client.query<{ version: number }>(`UPDATE sandbox_provider_accounts
          SET version=version+1,updated_at=$2 WHERE id=$1 RETURNING version`, [input.accountId, input.now]);
        version = updated.rows[0]!.version;
      }
      const data: SandboxBalance = {
        accountId: input.accountId,
        providerBalanceMinor: input.targetProviderBalanceMinor,
        reservedMinor: 0,
        availableMinor: input.targetProviderBalanceMinor,
        currency: 'CNY',
        version,
        fetchedAt: input.now.toISOString()
      };
      return {
        data,
        commit: async (audit) => {
          if (finalized) throw new Error('Sandbox funding write already finalized.');
          try {
            await insertPostgresAuditRecord(client, audit);
            await client.query('COMMIT');
            finalized = true;
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            finalized = true;
            throw error;
          } finally {
            client.release();
          }
        }
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      throw error;
    }
  }

  async createDebit(input: CreateReservationDebitInput): Promise<Transaction> {
    validateMoney(input.amount.amountMinor, input.amount.currency);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await findTransaction(client, 'idempotency_key', input.idempotencyKey);
      if (existing) {
        assertReplay(existing, input.amount.amountMinor, input.businessSource, input.businessReference, 'DEBIT');
        await client.query('COMMIT');
        return existing;
      }
      const accountResult = await client.query<AccountRow>(`${accountSelect} WHERE external_user_id=$1 FOR UPDATE`, [input.externalUserId]);
      const account = accountResult.rows[0];
      if (!account) throw new AdapterError('RESOURCE_NOT_FOUND', 'Sandbox Provider user was not found.');
      if (account.status !== 'ACTIVE') throw new AdapterError('BUSINESS_RULE_VIOLATION', 'Sandbox Provider account is suspended.');
      const reservation = await client.query<{ row_version: number }>('SELECT row_version FROM fund_reservations WHERE id=$1', [input.fundReservationId]);
      if (!reservation.rows[0]) throw new AdapterError('RESOURCE_NOT_FOUND', 'FundReservation was not found.');
      if (reservation.rows[0].row_version !== input.fundReservationVersion) throw new AdapterError('RESERVATION_CONFLICT', 'FundReservation version is stale.');
      const balance = await readBalance(client, account.id, new Date());
      if (balance.providerBalanceMinor < input.amount.amountMinor) throw new AdapterError('INSUFFICIENT_FUNDS', 'Sandbox Provider balance is insufficient.');
      const providerRef = `sandbox_tx_${randomUUID()}`;
      await client.query(`INSERT INTO sandbox_provider_transactions
        (id,account_id,operation,business_source,business_source_id,business_reference,fund_reservation_id,fund_reservation_version,direction,amount_minor,currency,status,provider_reference,original_provider_reference,idempotency_key,created_at)
        VALUES ($1,$2,'DEBIT',$3::"FundReservationSourceType",$4,$5,$6,$7,'DEBIT',$8,'CNY','SUCCEEDED',$9,NULL,$10,now())`,
      [randomUUID(), account.id, input.businessSource, input.businessReference, input.businessReference, input.fundReservationId,
        input.fundReservationVersion, input.amount.amountMinor, providerRef, input.idempotencyKey]);
      await client.query('COMMIT');
      return transactionFromInput(input, providerRef, new Date().toISOString());
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async createRefund(input: CreateRefundInput): Promise<Transaction> {
    validateMoney(input.amount.amountMinor, input.amount.currency);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await findTransaction(client, 'idempotency_key', input.idempotencyKey);
      if (existing) {
        if (existing.kind !== 'REFUND' || existing.amount.amountMinor !== input.amount.amountMinor || existing.originalProviderRef !== input.originalTransactionRef) {
          throw new AdapterError('IDEMPOTENCY_CONFLICT', 'Sandbox refund idempotency key conflicts with the original request.');
        }
        await client.query('COMMIT');
        return existing;
      }
      const originalRow = await client.query<TransactionRow>(`${transactionSelect} WHERE tx.provider_reference=$1 AND tx.operation='DEBIT' FOR UPDATE`, [input.originalTransactionRef]);
      const original = originalRow.rows[0];
      if (!original) throw new AdapterError('RESOURCE_NOT_FOUND', 'Original Sandbox debit was not found.');
      await lockAccount(client, original.account_id);
      const refunded = await client.query<{ amount: string }>(`SELECT COALESCE(SUM(amount_minor),0)::text amount FROM sandbox_provider_transactions
        WHERE original_provider_reference=$1 AND operation='REFUND' AND status='SUCCEEDED'`, [input.originalTransactionRef]);
      if (Number(refunded.rows[0]!.amount) + input.amount.amountMinor > Number(original.amount_minor)) {
        throw new AdapterError('REFUND_AMOUNT_EXCEEDED', 'Refund amount exceeds the original Sandbox debit.');
      }
      const providerRef = `sandbox_refund_${randomUUID()}`;
      await client.query(`INSERT INTO sandbox_provider_transactions
        (id,account_id,operation,business_source,business_source_id,business_reference,fund_reservation_id,fund_reservation_version,direction,amount_minor,currency,status,provider_reference,original_provider_reference,idempotency_key,created_at)
        VALUES ($1,$2,'REFUND',$3::"FundReservationSourceType",$4,$5,NULL,NULL,'CREDIT',$6,'CNY','SUCCEEDED',$7,$8,$9,now())`,
      [randomUUID(), original.account_id, original.business_source, original.business_source_id, input.businessReference, input.amount.amountMinor,
        providerRef, input.originalTransactionRef, input.idempotencyKey]);
      await client.query('COMMIT');
      return mapTransaction({ ...original, id: randomUUID(), operation: 'REFUND', direction: 'CREDIT', amount_minor: String(input.amount.amountMinor),
        provider_reference: providerRef, original_provider_reference: input.originalTransactionRef, idempotency_key: input.idempotencyKey, created_at: new Date() });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getTransaction(idempotencyKey: string): Promise<Transaction | null> {
    const client = await this.pool.connect();
    try { return await findTransaction(client, 'idempotency_key', idempotencyKey); } finally { client.release(); }
  }

  async getTransactionByProviderRef(providerRef: string): Promise<Transaction | null> {
    const client = await this.pool.connect();
    try { return await findTransaction(client, 'provider_reference', providerRef); } finally { client.release(); }
  }
}

export class SandboxFundingAdapter implements FundingAdapter {
  constructor(private readonly options: { store: SandboxFundingStore; bindingSecret: string }) {
    if (options.bindingSecret.length < 32) throw new Error('SANDBOX_BINDING_CODE_SECRET must be at least 32 characters.');
  }

  async discoverCapabilities() {
    return {
      providerKey: 'sandbox-provider', discoveredAt: new Date().toISOString(),
      nativeHold: { supported: false, create: false, capture: false, release: false, get: false, idempotentWrites: false,
        lookupByIdempotencyKey: false, partialCapture: false, partialRelease: false, minimumTtlSeconds: null, maximumTtlSeconds: null },
      fallbackDebit: { supported: true, idempotentWrites: true, lookupByIdempotencyKey: true },
      refund: { full: true, partial: true, idempotentWrites: true, lookupByIdempotencyKey: true },
      webhook: { supported: false, stableEventId: false, eventTypes: [] }
    };
  }

  async resolveUser(input: { credentialType: 'ONE_TIME_CODE' | 'EXTERNAL_USER_ID'; credentialValue: string; expectedCurrency?: string }) {
    const account = input.credentialType === 'ONE_TIME_CODE'
      ? await this.options.store.consumeBindingCodeHash(hmacCode(this.options.bindingSecret, input.credentialValue), new Date())
      : await this.options.store.resolveAccount(input.credentialValue);
    if (!account) throw new AdapterError('RESOURCE_NOT_FOUND', 'Sandbox Provider user was not found.');
    if (input.expectedCurrency && input.expectedCurrency !== 'CNY') throw new AdapterError('VALIDATION_ERROR', 'Sandbox Provider supports CNY only.');
    return { externalUserId: account.externalUserId, displayName: account.displayName, verified: true as const,
      accountStatus: account.status, resolvedAt: new Date().toISOString() };
  }

  async getProviderBalance(input: { externalUserId: string }) {
    const account = await this.options.store.resolveAccount(input.externalUserId);
    if (!account) throw new AdapterError('RESOURCE_NOT_FOUND', 'Sandbox Provider user was not found.');
    const balance = await this.options.store.getBalance(account.id);
    return { externalUserId: account.externalUserId, providerBalanceMinor: balance.providerBalanceMinor, currency: balance.currency,
      fetchedAt: balance.fetchedAt, providerAsOf: balance.fetchedAt, stale: false };
  }

  async createReservationDebit(input: CreateReservationDebitInput) { return this.options.store.createDebit(input); }
  async createRefund(input: CreateRefundInput) { return this.options.store.createRefund(input); }
  async getTransaction(input: { lookupType: 'PROVIDER_REF' | 'IDEMPOTENCY_KEY'; lookupValue: string }) {
    const transaction = input.lookupType === 'PROVIDER_REF'
      ? await this.options.store.getTransactionByProviderRef?.(input.lookupValue) ?? null
      : await this.options.store.getTransaction(input.lookupValue);
    if (!transaction) throw new AdapterError('RESOURCE_NOT_FOUND', 'Sandbox transaction was not found.');
    return transaction;
  }

  async createHold(): Promise<Hold> { throw unsupportedHold(); }
  async getHold(): Promise<Hold> { throw unsupportedHold(); }
  async captureHold(): Promise<Hold> { throw unsupportedHold(); }
  async releaseHold(): Promise<Hold> { throw unsupportedHold(); }
  async verifyWebhook(): Promise<never> { throw new AdapterError('BUSINESS_RULE_VIOLATION', 'Sandbox Provider has no webhook surface.'); }
}

export function registerSandboxFundingRoutes(
  server: FastifyInstance,
  options: { store: SandboxFundingStore; security: SecurityOptions; now?: () => Date }
): void {
  const now = options.now ?? (() => new Date());
  registerSecureReadRoute(server, options.security, {
    method: 'GET',
    url: '/api/v1/admin/sandbox-funding/accounts/:userId',
    permission: 'sandbox_funding.read',
    action: 'GET_SANDBOX_FUNDING_ACCOUNT',
    targetType: 'sandbox_provider_account',
    targetId: userIdParam,
    acceptedSources: ['DASHBOARD'],
    mapError: mapSandboxFundingError,
    handler: async (request, actor) => {
      requireOwner(actor.actorLevel);
      const userId = userIdParam(request);
      const balance = await options.store.getBalance(await options.store.resolveAccountIdForUser(userId));
      return publicBalance(userId, balance);
    }
  });
  registerSecureWriteRoute(server, options.security, {
    method: 'POST',
    url: '/api/v1/admin/sandbox-funding/accounts/:userId/target-balance',
    permission: 'sandbox_funding.manage',
    action: 'SET_SANDBOX_TARGET_BALANCE',
    targetType: 'sandbox_provider_account',
    targetId: userIdParam,
    acceptedSources: ['DASHBOARD'],
    requiresRecentStepUp: true,
    fingerprintBody: (request) => parseTargetBody(request.body),
    mapError: mapSandboxFundingError,
    auditSnapshots: (_request, _actor, payload) => ({ afterSnapshot: payload }),
    handler: async (request, actor) => {
      requireOwner(actor.actorLevel);
      if (!actor.actorStaffId) throw new SandboxFundingError('PERMISSION_DENIED', 'OWNER staff identity is required.');
      const userId = userIdParam(request);
      const body = parseTargetBody(request.body);
      const staged = await options.store.stageTargetBalance({
        accountId: await options.store.resolveAccountIdForUser(userId),
        ...body,
        idempotencyKey: String(request.headers['idempotency-key']),
        createdByStaffId: actor.actorStaffId,
        now: now()
      });
      return { data: publicBalance(userId, staged.data), commit: staged.commit };
    }
  });
}

export function hmacCode(secret: string, plaintextCode: string): string {
  return createHmac('sha256', secret).update(plaintextCode, 'utf8').digest('hex');
}

const accountSelect = 'SELECT id,external_user_id,display_name,currency,status,version FROM sandbox_provider_accounts';
const transactionSelect = `SELECT tx.id,tx.account_id,tx.operation,tx.business_source,tx.business_source_id,tx.direction,
  tx.business_reference,tx.fund_reservation_id,tx.fund_reservation_version,tx.amount_minor,tx.currency,tx.status,tx.provider_reference,tx.original_provider_reference,tx.idempotency_key,tx.created_at
  FROM sandbox_provider_transactions tx`;

interface AccountRow { id: string; external_user_id: string; display_name: string; currency: 'CNY'; status: 'ACTIVE' | 'SUSPENDED'; version: number }
interface TransactionRow { id: string; account_id: string; operation: 'DEBIT' | 'REFUND'; business_source: 'ORDER' | 'GIFT'; business_source_id: string;
  business_reference: string; fund_reservation_id: string | null; fund_reservation_version: number | null;
  direction: 'DEBIT' | 'CREDIT'; amount_minor: string; currency: 'CNY'; status: 'UNKNOWN' | 'PENDING' | 'SUCCEEDED' | 'FAILED';
  provider_reference: string; original_provider_reference: string | null; idempotency_key: string; created_at: Date }

function mapAccount(row: AccountRow): SandboxAccount {
  return { id: row.id, externalUserId: row.external_user_id, displayName: row.display_name, currency: row.currency, status: row.status, version: row.version };
}

async function lockAccount(client: PoolClient, accountId: string): Promise<AccountRow> {
  const result = await client.query<AccountRow>(`${accountSelect} WHERE id=$1 FOR UPDATE`, [accountId]);
  if (!result.rows[0]) throw new SandboxFundingError('NOT_FOUND', 'Sandbox funding account was not found.');
  return result.rows[0];
}

async function readBalance(client: PoolClient, accountId: string, now: Date): Promise<SandboxBalance> {
  const result = await client.query<{ id: string; version: number; provider_balance_minor: string; reserved_minor: string }>(`SELECT account.id,account.version,
    (COALESCE((SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END) FROM sandbox_provider_balance_adjustments WHERE account_id=account.id),0)
     + COALESCE((SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END) FROM sandbox_provider_transactions WHERE account_id=account.id AND status='SUCCEEDED'),0))::text provider_balance_minor,
    COALESCE((SELECT SUM(reservation.amount_minor - COALESCE((SELECT SUM(event.amount_minor)
        FROM fund_reservation_events event WHERE event.fund_reservation_id=reservation.id
          AND event.event_type IN ('CAPTURED','RELEASED','EXPIRED')),0)) FROM external_accounts external
      JOIN fund_reservations reservation ON reservation.user_id=external.user_id AND reservation.currency='CNY'
      WHERE external.provider='sandbox-provider' AND external.external_user_id=account.external_user_id AND external.status='ACTIVE'
        AND reservation.status IN ('PENDING','ACTIVE','DISPUTED','PARTIALLY_SETTLED')),0)::text reserved_minor
    FROM sandbox_provider_accounts account WHERE account.id=$1`, [accountId]);
  const row = result.rows[0];
  if (!row) throw new SandboxFundingError('NOT_FOUND', 'Sandbox funding account was not found.');
  const providerBalanceMinor = Number(row.provider_balance_minor);
  const reservedMinor = Number(row.reserved_minor);
  return { accountId: row.id, providerBalanceMinor, reservedMinor, availableMinor: providerBalanceMinor - reservedMinor,
    currency: 'CNY', version: row.version, fetchedAt: now.toISOString() };
}

async function findTransaction(client: PoolClient, field: 'idempotency_key' | 'provider_reference', value: string): Promise<Transaction | null> {
  const result = await client.query<TransactionRow>(`${transactionSelect} WHERE tx.${field}=$1 LIMIT 1`, [value]);
  return result.rows[0] ? mapTransaction(result.rows[0]) : null;
}

function mapTransaction(row: TransactionRow): Transaction {
  return { kind: row.operation === 'DEBIT' ? 'FALLBACK_DEBIT' : 'REFUND', status: row.status,
    idempotencyKey: row.idempotency_key, fundReservationId: row.fund_reservation_id, fundReservationVersion: row.fund_reservation_version,
    businessSource: row.operation === 'DEBIT' ? row.business_source : null, amount: { amountMinor: Number(row.amount_minor), currency: row.currency },
    businessReference: row.business_reference, providerRef: row.provider_reference, originalProviderRef: row.original_provider_reference,
    providerStatus: row.status, observedAt: row.created_at.toISOString(), providerOccurredAt: row.created_at.toISOString(), failure: null };
}

function transactionFromInput(input: CreateReservationDebitInput, providerRef: string, occurredAt: string): Transaction {
  return { kind: 'FALLBACK_DEBIT', status: 'SUCCEEDED', idempotencyKey: input.idempotencyKey,
    fundReservationId: input.fundReservationId, fundReservationVersion: input.fundReservationVersion, businessSource: input.businessSource,
    amount: input.amount, businessReference: input.businessReference, providerRef, originalProviderRef: null,
    providerStatus: 'SUCCEEDED', observedAt: occurredAt, providerOccurredAt: occurredAt, failure: null };
}

function assertReplay(existing: Transaction, amountMinor: number, source: string, reference: string, operation: 'DEBIT'): void {
  if (existing.kind !== 'FALLBACK_DEBIT' || existing.amount.amountMinor !== amountMinor || existing.businessSource !== source || existing.businessReference !== reference) {
    throw new AdapterError('IDEMPOTENCY_CONFLICT', `Sandbox ${operation.toLowerCase()} idempotency key conflicts with the original request.`);
  }
}

function validateTargetInput(input: SetSandboxTargetBalanceInput): void {
  if (input.currency !== 'CNY' || !Number.isSafeInteger(input.targetProviderBalanceMinor) || input.targetProviderBalanceMinor < 0 || input.reasonCode !== 'SANDBOX_TEST_SETUP') {
    throw new SandboxFundingError('VALIDATION_ERROR', 'Sandbox target balance input is invalid.');
  }
}

function validateMoney(amountMinor: number, currency: string): void {
  if (currency !== 'CNY' || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new AdapterError('VALIDATION_ERROR', 'Sandbox money must be positive CNY minor units.');
}

function unsupportedHold(): AdapterError {
  return new AdapterError('BUSINESS_RULE_VIOLATION', 'Sandbox Provider supports LOCAL_RESERVATION_FALLBACK only.');
}

function userIdParam(request: FastifyRequest): string {
  const userId = (request.params as { userId?: string }).userId;
  if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(userId)) {
    throw new SandboxFundingError('VALIDATION_ERROR', 'userId must be a UUID.');
  }
  return userId;
}

function parseTargetBody(body: unknown): Pick<SetSandboxTargetBalanceInput, 'currency' | 'targetProviderBalanceMinor' | 'expectedVersion' | 'reasonCode'> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SandboxFundingError('VALIDATION_ERROR', 'Request body is required.');
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['currency', 'targetProviderBalanceMinor', 'expectedVersion', 'reasonCode'].includes(key))
    || value.currency !== 'CNY' || value.reasonCode !== 'SANDBOX_TEST_SETUP'
    || !Number.isSafeInteger(value.targetProviderBalanceMinor) || Number(value.targetProviderBalanceMinor) < 0
    || !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1) {
    throw new SandboxFundingError('VALIDATION_ERROR', 'Sandbox target balance input is invalid.');
  }
  return { currency: 'CNY', targetProviderBalanceMinor: Number(value.targetProviderBalanceMinor),
    expectedVersion: Number(value.expectedVersion), reasonCode: 'SANDBOX_TEST_SETUP' };
}

function requireOwner(level: string | null): void {
  if (level !== 'L4_ADMIN_OWNER') throw new SandboxFundingError('PERMISSION_DENIED', 'OWNER access is required.');
}

function publicBalance(userId: string, balance: SandboxBalance) {
  return { userId, providerBalanceMinor: balance.providerBalanceMinor, reservedMinor: balance.reservedMinor,
    availableMinor: balance.availableMinor, currency: balance.currency, fetchedAt: balance.fetchedAt, version: balance.version };
}

function mapSandboxFundingError(error: unknown) {
  if (error instanceof SandboxFundingError) {
    const statusCode = error.code === 'NOT_FOUND' ? 404 : error.code === 'PERMISSION_DENIED' ? 403
      : error.code === 'VALIDATION_ERROR' ? 400 : 409;
    return { statusCode, code: error.code === 'NOT_FOUND' ? 'RESOURCE_NOT_FOUND' : error.code, message: error.message };
  }
  return null;
}
