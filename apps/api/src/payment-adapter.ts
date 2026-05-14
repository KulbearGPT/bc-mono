import { createHmac, timingSafeEqual } from 'node:crypto';

export type Currency = 'CNY' | (string & {});
export type BusinessSource = 'ORDER' | 'GIFT';
export type MockScenario =
  | 'CAPABILITIES_NATIVE_HOLD'
  | 'CAPABILITIES_LOCAL_FALLBACK'
  | 'SUCCESS'
  | 'USER_NOT_FOUND'
  | 'INSUFFICIENT_FUNDS'
  | 'HOLD_TIMEOUT_AFTER_COMMIT';

export interface Money {
  amountMinor: number;
  currency: Currency;
}

export interface CreateHoldInput {
  idempotencyKey: string;
  fundReservationId: string;
  fundReservationVersion: number;
  externalUserId: string;
  amount: Money;
  businessSource: BusinessSource;
  businessReference: string;
  expiresAt: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface CaptureHoldInput {
  holdRef: string;
  idempotencyKey: string;
  fundReservationId: string;
  fundReservationVersion: number;
  amount: Money;
  businessReference: string;
  reasonCode?: string;
}

export interface ReleaseHoldInput {
  holdRef: string;
  idempotencyKey: string;
  fundReservationId: string;
  fundReservationVersion: number;
  reasonCode: string;
  amount?: Money;
}

export interface CreateReservationDebitInput {
  idempotencyKey: string;
  fundReservationId: string;
  fundReservationVersion: number;
  externalUserId: string;
  amount: Money;
  businessSource: BusinessSource;
  businessReference: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface CreateRefundInput {
  idempotencyKey: string;
  originalTransactionRef: string;
  amount: Money;
  reasonCode: string;
  businessReference: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export type HoldStatus = 'UNKNOWN' | 'PENDING' | 'ACTIVE' | 'PARTIALLY_CAPTURED' | 'CAPTURED' | 'RELEASED' | 'EXPIRED' | 'FAILED';
export type TransactionStatus = 'UNKNOWN' | 'PENDING' | 'SUCCEEDED' | 'FAILED';
export type MaybePromise<T> = T | Promise<T>;

export interface Hold {
  status: HoldStatus;
  idempotencyKey: string;
  fundReservationId: string;
  fundReservationVersion: number;
  externalUserId: string;
  businessSource: BusinessSource;
  businessReference: string;
  holdRef: string | null;
  captureTransactionRef?: string | null;
  amount: Money;
  capturedAmount: Money;
  releasedAmount: Money;
  remainingAmount: Money;
  expiresAt: string;
  providerStatus: string | null;
  observedAt: string;
  failure: OperationFailure | null;
}

export interface Transaction {
  kind: 'FALLBACK_DEBIT' | 'REFUND';
  status: TransactionStatus;
  idempotencyKey: string;
  fundReservationId: string | null;
  fundReservationVersion: number | null;
  businessSource: BusinessSource | null;
  amount: Money;
  businessReference: string;
  providerRef: string | null;
  originalProviderRef: string | null;
  providerStatus: string | null;
  observedAt: string;
  providerOccurredAt: string | null;
  failure: OperationFailure | null;
}

export interface OperationFailure {
  code: AdapterErrorCode;
  retryable: boolean;
  safeMessage: string;
}

export interface FundingAdapter {
  discoverCapabilities(input?: { scenario?: MockScenario }): MaybePromise<ReturnType<MockFundingAdapter['discoverCapabilities']>>;
  resolveUser(input: Parameters<MockFundingAdapter['resolveUser']>[0]): MaybePromise<ReturnType<MockFundingAdapter['resolveUser']>>;
  getProviderBalance(input: Parameters<MockFundingAdapter['getProviderBalance']>[0]): MaybePromise<ReturnType<MockFundingAdapter['getProviderBalance']>>;
  createHold(input: CreateHoldInput, options?: { scenario?: MockScenario }): MaybePromise<Hold>;
  getHold(input: Parameters<MockFundingAdapter['getHold']>[0]): MaybePromise<Hold>;
  captureHold(input: CaptureHoldInput): MaybePromise<Hold>;
  releaseHold(input: ReleaseHoldInput): MaybePromise<Hold>;
  createReservationDebit(input: CreateReservationDebitInput): MaybePromise<Transaction>;
  createRefund(input: CreateRefundInput): MaybePromise<Transaction>;
  getTransaction(input: Parameters<MockFundingAdapter['getTransaction']>[0]): MaybePromise<Transaction>;
  verifyWebhook(input: Parameters<MockFundingAdapter['verifyWebhook']>[0]): MaybePromise<ReturnType<MockFundingAdapter['verifyWebhook']>>;
}

export type AdapterErrorCode =
  | 'VALIDATION_ERROR'
  | 'RESOURCE_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'BUSINESS_RULE_VIOLATION'
  | 'INSUFFICIENT_FUNDS'
  | 'RESERVATION_CONFLICT'
  | 'PROVIDER_TIMEOUT'
  | 'SIGNATURE_INVALID'
  | 'REPLAY_REJECTED'
  | 'SCHEMA_MISMATCH'
  | 'REFUND_AMOUNT_EXCEEDED';

interface MockUser {
  bindingCode: string;
  externalUserId: string;
  providerBalanceMinor: number;
  currency: Currency;
  accountStatus: 'ACTIVE' | 'SUSPENDED';
}

interface IdempotencyEntry<T> {
  fingerprint: string;
  result: T;
}

interface ReservationFixture {
  fundReservationId: string;
  version: number;
}

const webhookSecret = 'mock-webhook-secret-not-for-production';
const replayWindowSeconds = 300;

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly details: Array<{ field: string; reason: string }>;
  readonly providerHttpStatus: number | null;

  constructor(
    code: AdapterErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      requestId?: string;
      details?: Array<{ field: string; reason: string }>;
      providerHttpStatus?: number | null;
    } = {}
  ) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId ?? 'req_mock';
    this.details = options.details ?? [];
    this.providerHttpStatus = options.providerHttpStatus ?? null;
  }
}

export class MockFundingAdapter implements FundingAdapter {
  private readonly now: Date;
  private readonly users = new Map<string, MockUser>();
  private readonly usersByExternalId = new Map<string, MockUser>();
  private readonly holdIdempotency = new Map<string, IdempotencyEntry<Hold>>();
  private readonly holdRefs = new Map<string, Hold>();
  private readonly transactionIdempotency = new Map<string, IdempotencyEntry<Transaction>>();
  private readonly transactionRefs = new Map<string, Transaction>();
  private readonly verifiedEvents = new Map<string, { verified: true; event: ProviderEvent }>();
  private readonly reservationVersions = new Map<string, number>();
  private holdSequence = 1;
  private transactionSequence = 1;

  constructor(options: { now?: Date; reservations?: ReservationFixture[] } = {}) {
    this.now = options.now ?? new Date();
    for (const reservation of options.reservations ?? []) {
      this.reservationVersions.set(reservation.fundReservationId, reservation.version);
    }
    this.seedUser({ bindingCode: 'BIND-OK', externalUserId: 'mock-user-ok', providerBalanceMinor: 1_000_000, currency: 'CNY', accountStatus: 'ACTIVE' });
    this.seedUser({ bindingCode: 'BIND-LOW', externalUserId: 'mock-user-low', providerBalanceMinor: 100, currency: 'CNY', accountStatus: 'ACTIVE' });
    this.seedUser({ bindingCode: 'BIND-DEFICIT', externalUserId: 'mock-user-deficit', providerBalanceMinor: 3_000, currency: 'CNY', accountStatus: 'ACTIVE' });
    this.seedUser({ bindingCode: 'BIND-SUSPENDED', externalUserId: 'mock-user-suspended', providerBalanceMinor: 1_000_000, currency: 'CNY', accountStatus: 'SUSPENDED' });
  }

  discoverCapabilities(input: { scenario?: MockScenario } = {}) {
    const fallbackOnly = input.scenario === 'CAPABILITIES_LOCAL_FALLBACK';
    return {
      providerKey: fallbackOnly ? 'mock-local-fallback' : 'mock-native-hold',
      discoveredAt: this.timestamp(),
      nativeHold: {
        supported: !fallbackOnly,
        create: !fallbackOnly,
        capture: !fallbackOnly,
        release: !fallbackOnly,
        get: !fallbackOnly,
        idempotentWrites: !fallbackOnly,
        lookupByIdempotencyKey: !fallbackOnly,
        partialCapture: !fallbackOnly,
        partialRelease: !fallbackOnly,
        minimumTtlSeconds: fallbackOnly ? null : 1,
        maximumTtlSeconds: fallbackOnly ? null : 86_400
      },
      fallbackDebit: {
        supported: true,
        idempotentWrites: true,
        lookupByIdempotencyKey: true
      },
      refund: {
        full: true,
        partial: true,
        idempotentWrites: true,
        lookupByIdempotencyKey: true
      },
      webhook: {
        supported: true,
        stableEventId: true,
        eventTypes: ['HOLD_CREATED', 'HOLD_UPDATED', 'HOLD_CAPTURED', 'HOLD_RELEASED', 'HOLD_EXPIRED', 'DEBIT_UPDATED', 'REFUND_UPDATED']
      }
    };
  }

  resolveUser(input: { credentialType: 'ONE_TIME_CODE' | 'EXTERNAL_USER_ID'; credentialValue: string; expectedCurrency?: Currency }) {
    const user =
      input.credentialType === 'ONE_TIME_CODE'
        ? this.users.get(input.credentialValue)
        : this.usersByExternalId.get(input.credentialValue);
    if (!user) {
      throw new AdapterError('RESOURCE_NOT_FOUND', 'Provider user was not found.');
    }
    if (input.expectedCurrency && input.expectedCurrency !== user.currency) {
      throw new AdapterError('VALIDATION_ERROR', 'Currency does not match provider account.', {
        details: [{ field: 'expectedCurrency', reason: 'currency mismatch' }]
      });
    }
    return {
      externalUserId: user.externalUserId,
      displayName: user.externalUserId,
      verified: true as const,
      accountStatus: user.accountStatus,
      resolvedAt: this.timestamp()
    };
  }

  getProviderBalance(input: { externalUserId: string }) {
    const user = this.requireUser(input.externalUserId);
    return {
      externalUserId: user.externalUserId,
      providerBalanceMinor: user.providerBalanceMinor,
      currency: user.currency,
      fetchedAt: this.timestamp(),
      providerAsOf: this.timestamp(),
      stale: false
    };
  }

  createHold(input: CreateHoldInput, options: { scenario?: MockScenario } = {}): Hold {
    this.validateIdempotencyKey(input.idempotencyKey);
    const user = this.requireUser(input.externalUserId);
    this.validatePositiveMoney(input.amount);
    this.assertCurrency(input.amount, user.currency, 'amount.currency');
    const expiresAtMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      throw new AdapterError('VALIDATION_ERROR', 'expiresAt must be a valid date-time.', {
        details: [{ field: 'expiresAt', reason: 'invalid date-time' }]
      });
    }
    const ttlSeconds = (expiresAtMs - this.now.getTime()) / 1000;
    if (ttlSeconds < 1 || ttlSeconds > 86_400) {
      throw new AdapterError('BUSINESS_RULE_VIOLATION', 'Hold expiry is outside proven provider TTL limits.');
    }
    const fingerprint = stableFingerprint({
      fundReservationId: input.fundReservationId,
      fundReservationVersion: input.fundReservationVersion,
      externalUserId: input.externalUserId,
      amount: input.amount,
      businessSource: input.businessSource,
      businessReference: input.businessReference,
      expiresAt: input.expiresAt
    });
    const existing = this.replayOrConflict(this.holdIdempotency, input.idempotencyKey, fingerprint);
    if (existing) {
      return clone(existing);
    }
    const holdRef = `mock_hold_${this.holdSequence++}`;
    const hold: Hold = {
      status: 'ACTIVE',
      idempotencyKey: input.idempotencyKey,
      fundReservationId: input.fundReservationId,
      fundReservationVersion: input.fundReservationVersion,
      externalUserId: input.externalUserId,
      businessSource: input.businessSource,
      businessReference: input.businessReference,
      holdRef,
      captureTransactionRef: null,
      amount: clone(input.amount),
      capturedAmount: money(0, input.amount.currency),
      releasedAmount: money(0, input.amount.currency),
      remainingAmount: clone(input.amount),
      expiresAt: input.expiresAt,
      providerStatus: 'ACTIVE',
      observedAt: this.timestamp(),
      failure: null
    };
    this.holdIdempotency.set(input.idempotencyKey, { fingerprint, result: clone(hold) });
    this.holdRefs.set(holdRef, clone(hold));
    if (options.scenario === 'HOLD_TIMEOUT_AFTER_COMMIT') {
      throw new AdapterError('PROVIDER_TIMEOUT', 'Provider timed out after committing the hold.', {
        retryable: true,
        providerHttpStatus: 504
      });
    }
    return clone(hold);
  }

  getHold(input: { lookupType: 'PROVIDER_HOLD_REF' | 'IDEMPOTENCY_KEY'; lookupValue: string }): Hold {
    const hold =
      input.lookupType === 'PROVIDER_HOLD_REF'
        ? this.holdRefs.get(input.lookupValue)
        : this.holdIdempotency.get(input.lookupValue)?.result;
    if (!hold) {
      throw new AdapterError('RESOURCE_NOT_FOUND', 'Hold was not found.');
    }
    return clone(hold);
  }

  captureHold(input: CaptureHoldInput): Hold {
    this.validateIdempotencyKey(input.idempotencyKey);
    this.validatePositiveMoney(input.amount);
    const hold = this.requireHold(input.holdRef);
    this.validateHoldBinding(hold, input.fundReservationId, input.fundReservationVersion);
    this.assertCurrency(input.amount, hold.amount.currency, 'amount.currency');
    const fingerprint = stableFingerprint({
      holdRef: input.holdRef,
      fundReservationId: input.fundReservationId,
      fundReservationVersion: input.fundReservationVersion,
      amount: input.amount,
      businessReference: input.businessReference
    });
    const existing = this.replayOrConflict(this.holdIdempotency, input.idempotencyKey, fingerprint);
    if (existing) {
      return clone(existing);
    }
    if (!['ACTIVE', 'PARTIALLY_CAPTURED'].includes(hold.status)) {
      throw new AdapterError('BUSINESS_RULE_VIOLATION', 'Hold is not capturable.');
    }
    if (input.amount.amountMinor > hold.remainingAmount.amountMinor) {
      throw new AdapterError('BUSINESS_RULE_VIOLATION', 'Capture amount exceeds remaining hold amount.');
    }
    hold.capturedAmount = money(hold.capturedAmount.amountMinor + input.amount.amountMinor, hold.amount.currency);
    hold.remainingAmount = money(hold.amount.amountMinor - hold.capturedAmount.amountMinor - hold.releasedAmount.amountMinor, hold.amount.currency);
    hold.status = hold.remainingAmount.amountMinor === 0 ? 'CAPTURED' : 'PARTIALLY_CAPTURED';
    hold.providerStatus = hold.status;
    hold.observedAt = this.timestamp();
    const captureMirror = this.createTransaction({
      kind: 'FALLBACK_DEBIT',
      idempotencyKey: input.idempotencyKey,
      amount: input.amount,
      businessReference: input.businessReference,
      businessSource: hold.businessSource,
      fundReservationId: input.fundReservationId,
      fundReservationVersion: input.fundReservationVersion,
      originalProviderRef: null
    });
    hold.captureTransactionRef = captureMirror.providerRef;
    this.saveHold(hold);
    this.holdIdempotency.set(input.idempotencyKey, { fingerprint, result: clone(hold) });
    return clone(hold);
  }

  releaseHold(input: ReleaseHoldInput): Hold {
    this.validateIdempotencyKey(input.idempotencyKey);
    const hold = this.requireHold(input.holdRef);
    this.validateHoldBinding(hold, input.fundReservationId, input.fundReservationVersion);
    const releaseAmount = input.amount ?? clone(hold.remainingAmount);
    this.validatePositiveMoney(releaseAmount);
    this.assertCurrency(releaseAmount, hold.amount.currency, 'amount.currency');
    const fingerprint = stableFingerprint({
      holdRef: input.holdRef,
      fundReservationId: input.fundReservationId,
      fundReservationVersion: input.fundReservationVersion,
      reasonCode: input.reasonCode,
      amount: releaseAmount
    });
    const existing = this.replayOrConflict(this.holdIdempotency, input.idempotencyKey, fingerprint);
    if (existing) {
      return clone(existing);
    }
    if (!['ACTIVE', 'PARTIALLY_CAPTURED'].includes(hold.status)) {
      throw new AdapterError('BUSINESS_RULE_VIOLATION', 'Hold is not releasable.');
    }
    if (releaseAmount.amountMinor > hold.remainingAmount.amountMinor) {
      throw new AdapterError('BUSINESS_RULE_VIOLATION', 'Release amount exceeds remaining hold amount.');
    }
    hold.releasedAmount = money(hold.releasedAmount.amountMinor + releaseAmount.amountMinor, hold.amount.currency);
    hold.remainingAmount = money(hold.amount.amountMinor - hold.capturedAmount.amountMinor - hold.releasedAmount.amountMinor, hold.amount.currency);
    hold.status = hold.remainingAmount.amountMinor === 0 ? 'RELEASED' : hold.status;
    hold.providerStatus = hold.status;
    hold.observedAt = this.timestamp();
    this.saveHold(hold);
    this.holdIdempotency.set(input.idempotencyKey, { fingerprint, result: clone(hold) });
    return clone(hold);
  }

  createReservationDebit(input: CreateReservationDebitInput): Transaction {
    this.validateIdempotencyKey(input.idempotencyKey);
    if (!input.fundReservationId || !input.fundReservationVersion) {
      throw new AdapterError('VALIDATION_ERROR', 'fundReservationId and fundReservationVersion are required.');
    }
    const expectedVersion = this.reservationVersions.get(input.fundReservationId) ?? 1;
    if (input.fundReservationVersion !== expectedVersion) {
      throw new AdapterError('RESERVATION_CONFLICT', 'FundReservation version is stale.');
    }
    this.validatePositiveMoney(input.amount);
    const user = this.requireUser(input.externalUserId);
    this.assertCurrency(input.amount, user.currency, 'amount.currency');
    const fingerprint = stableFingerprint({
      fundReservationId: input.fundReservationId,
      fundReservationVersion: input.fundReservationVersion,
      externalUserId: input.externalUserId,
      amount: input.amount,
      businessSource: input.businessSource,
      businessReference: input.businessReference
    });
    const existing = this.replayOrConflict(this.transactionIdempotency, input.idempotencyKey, fingerprint);
    if (existing) {
      return clone(existing);
    }
    if (user.providerBalanceMinor < input.amount.amountMinor) {
      throw new AdapterError('INSUFFICIENT_FUNDS', 'Provider balance is insufficient.');
    }
    user.providerBalanceMinor -= input.amount.amountMinor;
    const transaction = this.createTransaction({
      kind: 'FALLBACK_DEBIT',
      idempotencyKey: input.idempotencyKey,
      amount: input.amount,
      businessReference: input.businessReference,
      businessSource: input.businessSource,
      fundReservationId: input.fundReservationId,
      fundReservationVersion: input.fundReservationVersion,
      originalProviderRef: null
    });
    this.transactionIdempotency.set(input.idempotencyKey, { fingerprint, result: clone(transaction) });
    return transaction;
  }

  createRefund(input: CreateRefundInput): Transaction {
    this.validateIdempotencyKey(input.idempotencyKey);
    this.validatePositiveMoney(input.amount);
    const original = this.transactionRefs.get(input.originalTransactionRef);
    if (!original || original.status !== 'SUCCEEDED') {
      throw new AdapterError('RESOURCE_NOT_FOUND', 'Original transaction was not found.');
    }
    this.assertCurrency(input.amount, original.amount.currency, 'amount.currency');
    const fingerprint = stableFingerprint({
      originalTransactionRef: input.originalTransactionRef,
      amount: input.amount,
      reasonCode: input.reasonCode,
      businessReference: input.businessReference
    });
    const existing = this.replayOrConflict(this.transactionIdempotency, input.idempotencyKey, fingerprint);
    if (existing) {
      return clone(existing);
    }
    const existingRefundMinor = Array.from(this.transactionRefs.values())
      .filter((transaction) => transaction.kind === 'REFUND' && transaction.originalProviderRef === original.providerRef)
      .reduce((sum, transaction) => sum + transaction.amount.amountMinor, 0);
    if (existingRefundMinor + input.amount.amountMinor > original.amount.amountMinor) {
      throw new AdapterError('REFUND_AMOUNT_EXCEEDED', 'Refund amount exceeds captured transaction amount.');
    }
    const refund = this.createTransaction({
      kind: 'REFUND',
      idempotencyKey: input.idempotencyKey,
      amount: input.amount,
      businessReference: input.businessReference,
      businessSource: null,
      fundReservationId: null,
      fundReservationVersion: null,
      originalProviderRef: input.originalTransactionRef
    });
    this.transactionIdempotency.set(input.idempotencyKey, { fingerprint, result: clone(refund) });
    return refund;
  }

  getTransaction(input: { lookupType: 'PROVIDER_REF' | 'IDEMPOTENCY_KEY'; lookupValue: string }): Transaction {
    const transaction =
      input.lookupType === 'PROVIDER_REF'
        ? this.transactionRefs.get(input.lookupValue)
        : this.transactionIdempotency.get(input.lookupValue)?.result;
    if (!transaction) {
      throw new AdapterError('RESOURCE_NOT_FOUND', 'Transaction was not found.');
    }
    return clone(transaction);
  }

  verifyWebhook(input: { headers: Record<string, string>; rawBodyBase64: string; receivedAt: string }) {
    const rawBody = Buffer.from(input.rawBodyBase64, 'base64').toString('utf8');
    const timestamp = input.headers['x-mock-timestamp'];
    const signature = input.headers['x-mock-signature'];
    if (!timestamp || !signature || !verifySignature(rawBody, timestamp, signature)) {
      throw new AdapterError('SIGNATURE_INVALID', 'Webhook signature is invalid.');
    }
    const receivedAtMs = Date.parse(input.receivedAt);
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(receivedAtMs) || !Number.isFinite(timestampMs)) {
      throw new AdapterError('REPLAY_REJECTED', 'Webhook timestamp is invalid.');
    }
    const ageSeconds = Math.abs((receivedAtMs - timestampMs) / 1000);
    if (ageSeconds > replayWindowSeconds) {
      throw new AdapterError('REPLAY_REJECTED', 'Webhook timestamp is outside replay window.');
    }
    const event = parseProviderEvent(rawBody);
    const existing = this.verifiedEvents.get(event.eventId);
    if (existing) {
      return clone(existing);
    }
    const verified = { verified: true as const, event };
    this.verifiedEvents.set(event.eventId, clone(verified));
    return verified;
  }

  private seedUser(user: MockUser): void {
    this.users.set(user.bindingCode, user);
    this.usersByExternalId.set(user.externalUserId, user);
  }

  private timestamp(): string {
    return this.now.toISOString();
  }

  private requireUser(externalUserId: string): MockUser {
    const user = this.usersByExternalId.get(externalUserId);
    if (!user) {
      throw new AdapterError('RESOURCE_NOT_FOUND', 'Provider user was not found.');
    }
    return user;
  }

  private requireHold(holdRef: string): Hold {
    const hold = this.holdRefs.get(holdRef);
    if (!hold) {
      throw new AdapterError('RESOURCE_NOT_FOUND', 'Hold was not found.');
    }
    return clone(hold);
  }

  private saveHold(hold: Hold): void {
    if (!hold.holdRef) {
      return;
    }
    this.holdRefs.set(hold.holdRef, clone(hold));
    this.holdIdempotency.set(hold.idempotencyKey, {
      fingerprint: this.holdIdempotency.get(hold.idempotencyKey)?.fingerprint ?? '',
      result: clone(hold)
    });
  }

  private validateHoldBinding(hold: Hold, fundReservationId: string, fundReservationVersion: number): void {
    if (hold.fundReservationId !== fundReservationId || hold.fundReservationVersion !== fundReservationVersion) {
      throw new AdapterError('RESERVATION_CONFLICT', 'Hold reservation binding does not match.');
    }
  }

  private replayOrConflict<T>(store: Map<string, IdempotencyEntry<T>>, key: string, fingerprint: string): T | null {
    const existing = store.get(key);
    if (!existing) {
      return null;
    }
    if (existing.fingerprint !== fingerprint) {
      throw new AdapterError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was reused with a different request fingerprint.');
    }
    return existing.result;
  }

  private validatePositiveMoney(value: Money): void {
    if (!Number.isInteger(value.amountMinor) || value.amountMinor < 1 || !/^[A-Z]{3}$/.test(value.currency)) {
      throw new AdapterError('VALIDATION_ERROR', 'Money must be positive minor units with ISO currency.');
    }
  }

  private assertCurrency(value: Money, expectedCurrency: Currency, field: string): void {
    if (value.currency !== expectedCurrency) {
      throw new AdapterError('VALIDATION_ERROR', 'Money currency does not match the provider resource.', {
        details: [{ field, reason: `expected ${expectedCurrency}` }]
      });
    }
  }

  private validateIdempotencyKey(value: string): void {
    if (!value || value.length < 16 || value.length > 200 || !/^[A-Za-z0-9:_-]+$/.test(value)) {
      throw new AdapterError('VALIDATION_ERROR', 'Idempotency-Key is invalid.');
    }
  }

  private createTransaction(input: {
    kind: 'FALLBACK_DEBIT' | 'REFUND';
    idempotencyKey: string;
    amount: Money;
    businessReference: string;
    businessSource: BusinessSource | null;
    fundReservationId: string | null;
    fundReservationVersion: number | null;
    originalProviderRef: string | null;
  }): Transaction {
    const providerRef = `mock_txn_${this.transactionSequence++}`;
    const transaction: Transaction = {
      kind: input.kind,
      status: 'SUCCEEDED',
      idempotencyKey: input.idempotencyKey,
      fundReservationId: input.fundReservationId,
      fundReservationVersion: input.fundReservationVersion,
      businessSource: input.businessSource,
      amount: clone(input.amount),
      businessReference: input.businessReference,
      providerRef,
      originalProviderRef: input.originalProviderRef,
      providerStatus: 'SUCCEEDED',
      observedAt: this.timestamp(),
      providerOccurredAt: this.timestamp(),
      failure: null
    };
    this.transactionRefs.set(providerRef, clone(transaction));
    return clone(transaction);
  }
}

type ProviderEvent = HoldProviderEvent | TransactionProviderEvent;

interface HoldProviderEvent {
  eventId: string;
  resourceType: 'HOLD';
  eventType: 'HOLD_CREATED' | 'HOLD_UPDATED' | 'HOLD_CAPTURED' | 'HOLD_RELEASED' | 'HOLD_EXPIRED';
  holdRef: string;
  idempotencyKey?: string | null;
  holdStatus: HoldStatus;
  amount?: Money | null;
  expiresAt?: string | null;
  occurredAt: string;
  providerSequence?: number | null;
  providerStatus?: string | null;
}

interface TransactionProviderEvent {
  eventId: string;
  resourceType: 'TRANSACTION';
  eventType: 'DEBIT_UPDATED' | 'REFUND_UPDATED';
  providerRef: string;
  idempotencyKey?: string | null;
  transactionStatus: TransactionStatus;
  amount?: Money | null;
  occurredAt: string;
  providerSequence?: number | null;
  providerStatus?: string | null;
}

function parseProviderEvent(rawBody: string): ProviderEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new AdapterError('SCHEMA_MISMATCH', 'Webhook body is not valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new AdapterError('SCHEMA_MISMATCH', 'Webhook event is not an object.');
  }
  const event = parsed as Record<string, unknown>;
  if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
    throw new AdapterError('SCHEMA_MISMATCH', 'Webhook eventId is required.');
  }
  if (typeof event.occurredAt !== 'string' || !Number.isFinite(Date.parse(event.occurredAt))) {
    throw new AdapterError('SCHEMA_MISMATCH', 'Webhook occurredAt is invalid.');
  }

  if (event.resourceType === 'HOLD') {
    const validEventTypes = ['HOLD_CREATED', 'HOLD_UPDATED', 'HOLD_CAPTURED', 'HOLD_RELEASED', 'HOLD_EXPIRED'];
    const validStatuses: HoldStatus[] = ['UNKNOWN', 'PENDING', 'ACTIVE', 'PARTIALLY_CAPTURED', 'CAPTURED', 'RELEASED', 'EXPIRED', 'FAILED'];
    if (
      typeof event.holdRef !== 'string' ||
      !validEventTypes.includes(String(event.eventType)) ||
      !validStatuses.includes(event.holdStatus as HoldStatus)
    ) {
      throw new AdapterError('SCHEMA_MISMATCH', 'Webhook hold event shape is invalid.');
    }
    return event as unknown as HoldProviderEvent;
  }

  if (event.resourceType === 'TRANSACTION') {
    const validEventTypes = ['DEBIT_UPDATED', 'REFUND_UPDATED'];
    const validStatuses: TransactionStatus[] = ['UNKNOWN', 'PENDING', 'SUCCEEDED', 'FAILED'];
    if (
      typeof event.providerRef !== 'string' ||
      !validEventTypes.includes(String(event.eventType)) ||
      !validStatuses.includes(event.transactionStatus as TransactionStatus)
    ) {
      throw new AdapterError('SCHEMA_MISMATCH', 'Webhook transaction event shape is invalid.');
    }
    return event as unknown as TransactionProviderEvent;
  }

  throw new AdapterError('SCHEMA_MISMATCH', 'Webhook resourceType is invalid.');
}

export function signMockWebhook(input: { rawBody: string; receivedAt: Date | string }) {
  const timestamp = input.receivedAt instanceof Date ? input.receivedAt.toISOString() : input.receivedAt;
  const signature = signPayload(input.rawBody, timestamp);
  return {
    timestamp,
    signature,
    headers: {
      'x-mock-timestamp': timestamp,
      'x-mock-signature': signature
    }
  };
}

function signPayload(rawBody: string, timestamp: string): string {
  return createHmac('sha256', webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function verifySignature(rawBody: string, timestamp: string, signature: string): boolean {
  const expected = Buffer.from(signPayload(rawBody, timestamp), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function money(amountMinor: number, currency: Currency): Money {
  return { amountMinor, currency };
}

function stableFingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
