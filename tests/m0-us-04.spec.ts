import { describe, expect, test } from 'vitest';
import {
  AdapterError,
  MockFundingAdapter,
  signMockWebhook,
  type CreateHoldInput
} from '@blackcat/api/payment-adapter';

const now = new Date('2026-07-17T12:00:00.000Z');
const orderId = '00000000-0000-0000-0000-00000000a001';
const giftId = '00000000-0000-0000-0000-00000000b001';
const fundReservationId = '00000000-0000-0000-0000-00000000f001';

function buildAdapter() {
  return new MockFundingAdapter({ now });
}

function holdInput(overrides: Partial<CreateHoldInput> = {}): CreateHoldInput {
  return {
    idempotencyKey: 'hold:order:00000000-0000-0000-0000-00000000a001:v1',
    fundReservationId,
    fundReservationVersion: 1,
    externalUserId: 'mock-user-ok',
    amount: { amountMinor: 12_000, currency: 'CNY' },
    businessSource: 'ORDER',
    businessReference: orderId,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    ...overrides
  };
}

describe('M0-US-04 third-party funding adapter contract mock', () => {
  test('discovers native-hold and local-fallback capability profiles', () => {
    const adapter = buildAdapter();

    expect(adapter.discoverCapabilities({ scenario: 'CAPABILITIES_NATIVE_HOLD' })).toMatchObject({
      providerKey: 'mock-native-hold',
      nativeHold: {
        supported: true,
        create: true,
        capture: true,
        release: true,
        get: true,
        idempotentWrites: true,
        lookupByIdempotencyKey: true,
        maximumTtlSeconds: 86_400
      },
      fallbackDebit: {
        supported: true,
        idempotentWrites: true,
        lookupByIdempotencyKey: true
      },
      webhook: { supported: true, stableEventId: true }
    });
    expect(adapter.discoverCapabilities({ scenario: 'CAPABILITIES_LOCAL_FALLBACK' })).toMatchObject({
      providerKey: 'mock-local-fallback',
      nativeHold: { supported: false },
      fallbackDebit: { supported: true, idempotentWrites: true, lookupByIdempotencyKey: true }
    });
  });

  test('resolves users and returns provider balance without local available balance fields', () => {
    const adapter = buildAdapter();

    const resolved = adapter.resolveUser({
      credentialType: 'ONE_TIME_CODE',
      credentialValue: 'BIND-OK',
      expectedCurrency: 'CNY'
    });
    const balance = adapter.getProviderBalance({ externalUserId: resolved.externalUserId });

    expect(resolved).toMatchObject({
      externalUserId: 'mock-user-ok',
      verified: true,
      accountStatus: 'ACTIVE'
    });
    expect(balance).toMatchObject({
      externalUserId: 'mock-user-ok',
      providerBalanceMinor: 1_000_000,
      currency: 'CNY',
      stale: false
    });
    expect(balance).not.toHaveProperty('availableMinor');
    expect(balance).not.toHaveProperty('reservedMinor');
    expect(() =>
      adapter.resolveUser({ credentialType: 'ONE_TIME_CODE', credentialValue: 'BIND-MISSING' })
    ).toThrowError(AdapterError);
  });

  test('creates provider-native holds idempotently and rejects changed fingerprints', () => {
    const adapter = buildAdapter();
    const first = adapter.createHold(holdInput());
    const replay = adapter.createHold(holdInput());

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: 'ACTIVE',
      idempotencyKey: 'hold:order:00000000-0000-0000-0000-00000000a001:v1',
      fundReservationId,
      fundReservationVersion: 1,
      capturedAmount: { amountMinor: 0, currency: 'CNY' },
      releasedAmount: { amountMinor: 0, currency: 'CNY' },
      remainingAmount: { amountMinor: 12_000, currency: 'CNY' }
    });
    expect(() =>
      adapter.createHold(holdInput({ amount: { amountMinor: 13_000, currency: 'CNY' } }))
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  });

  test('rejects hold expiry outside proven native capability limits before mutation', () => {
    const adapter = buildAdapter();

    expect(() =>
      adapter.createHold(
        holdInput({
          idempotencyKey: 'hold:order:00000000-0000-0000-0000-00000000a002:v1',
          expiresAt: new Date(now.getTime() + 90_000 * 1000).toISOString()
        })
      )
    ).toThrowError(expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }));
    expect(() =>
      adapter.getHold({
        lookupType: 'IDEMPOTENCY_KEY',
        lookupValue: 'hold:order:00000000-0000-0000-0000-00000000a002:v1'
      })
    ).toThrowError(expect.objectContaining({ code: 'RESOURCE_NOT_FOUND' }));
    expect(() =>
      adapter.createHold(
        holdInput({
          idempotencyKey: 'hold:order:00000000-0000-0000-0000-00000000a004:v1',
          businessReference: '00000000-0000-0000-0000-00000000a004',
          expiresAt: 'not-a-date'
        })
      )
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  test('recovers timeout-after-commit holds by original idempotency key', () => {
    const adapter = buildAdapter();
    expect(() =>
      adapter.createHold(
        holdInput({
          idempotencyKey: 'hold:order:00000000-0000-0000-0000-00000000a003:v1',
          businessReference: '00000000-0000-0000-0000-00000000a003'
        }),
        { scenario: 'HOLD_TIMEOUT_AFTER_COMMIT' }
      )
    ).toThrowError(expect.objectContaining({ code: 'PROVIDER_TIMEOUT', retryable: true }));

    expect(
      adapter.getHold({
        lookupType: 'IDEMPOTENCY_KEY',
        lookupValue: 'hold:order:00000000-0000-0000-0000-00000000a003:v1'
      })
    ).toMatchObject({
      status: 'ACTIVE',
      businessReference: '00000000-0000-0000-0000-00000000a003'
    });
  });

  test('captures and releases holds idempotently while preserving amount invariants', () => {
    const adapter = buildAdapter();
    const hold = adapter.createHold(
      holdInput({
        idempotencyKey: 'hold:gift:00000000-0000-0000-0000-00000000b001:v1',
        businessSource: 'GIFT',
        businessReference: giftId
      })
    );
    const captured = adapter.captureHold({
      holdRef: hold.holdRef!,
      idempotencyKey: 'capture:hold:00000000-0000-0000-0000-00000000f001:v1',
      fundReservationId,
      fundReservationVersion: 1,
      amount: { amountMinor: 7_000, currency: 'CNY' },
      businessReference: giftId
    });
    const capturedReplay = adapter.captureHold({
      holdRef: hold.holdRef!,
      idempotencyKey: 'capture:hold:00000000-0000-0000-0000-00000000f001:v1',
      fundReservationId,
      fundReservationVersion: 1,
      amount: { amountMinor: 7_000, currency: 'CNY' },
      businessReference: giftId
    });
    const released = adapter.releaseHold({
      holdRef: hold.holdRef!,
      idempotencyKey: 'release:hold:00000000-0000-0000-0000-00000000f001:v1',
      fundReservationId,
      fundReservationVersion: 1,
      reasonCode: 'CUSTOMER_CANCELLED'
    });

    expect(captured).toEqual(capturedReplay);
    expect(captured.status).toBe('PARTIALLY_CAPTURED');
    expect(released).toMatchObject({
      status: 'RELEASED',
      capturedAmount: { amountMinor: 7_000, currency: 'CNY' },
      releasedAmount: { amountMinor: 5_000, currency: 'CNY' },
      remainingAmount: { amountMinor: 0, currency: 'CNY' }
    });
    expect(() =>
      adapter.captureHold({
        holdRef: hold.holdRef!,
        idempotencyKey: 'capture:hold:00000000-0000-0000-0000-00000000f001:v2',
        fundReservationId,
        fundReservationVersion: 1,
        amount: { amountMinor: 1_000, currency: 'USD' },
        businessReference: giftId
      })
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  test('creates fallback reservation debits only with modeled reservation binding and fresh balance', () => {
    const adapter = new MockFundingAdapter({
      now,
      reservations: [
        { fundReservationId: '00000000-0000-0000-0000-00000000f005', version: 2 }
      ]
    });

    expect(() =>
      adapter.createReservationDebit({
        idempotencyKey: 'debit:reservation:00000000-0000-0000-0000-00000000f001:v1',
        fundReservationId,
        fundReservationVersion: undefined as unknown as number,
        externalUserId: 'mock-user-ok',
        amount: { amountMinor: 1_000, currency: 'CNY' },
        businessSource: 'ORDER',
        businessReference: orderId
      })
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() =>
      adapter.createReservationDebit({
        idempotencyKey: 'debit:reservation:00000000-0000-0000-0000-00000000f001:v2',
        fundReservationId,
        fundReservationVersion: 2,
        externalUserId: 'mock-user-ok',
        amount: { amountMinor: 1_000, currency: 'CNY' },
        businessSource: 'ORDER',
        businessReference: orderId
      })
    ).toThrowError(expect.objectContaining({ code: 'RESERVATION_CONFLICT' }));
    expect(
      adapter.createReservationDebit({
        idempotencyKey: 'debit:reservation:00000000-0000-0000-0000-00000000f005:v2',
        fundReservationId: '00000000-0000-0000-0000-00000000f005',
        fundReservationVersion: 2,
        externalUserId: 'mock-user-ok',
        amount: { amountMinor: 1_000, currency: 'CNY' },
        businessSource: 'ORDER',
        businessReference: orderId
      })
    ).toMatchObject({
      kind: 'FALLBACK_DEBIT',
      status: 'SUCCEEDED',
      fundReservationVersion: 2
    });
    expect(() =>
      adapter.createReservationDebit({
        idempotencyKey: 'debit:reservation:00000000-0000-0000-0000-00000000f006:v1',
        fundReservationId: '00000000-0000-0000-0000-00000000f006',
        fundReservationVersion: 1,
        externalUserId: 'mock-user-ok',
        amount: { amountMinor: 1_000, currency: 'USD' },
        businessSource: 'ORDER',
        businessReference: orderId
      })
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() =>
      adapter.createReservationDebit({
        idempotencyKey: 'debit:reservation:00000000-0000-0000-0000-00000000f002:v1',
        fundReservationId: '00000000-0000-0000-0000-00000000f002',
        fundReservationVersion: 1,
        externalUserId: 'mock-user-low',
        amount: { amountMinor: 10_000, currency: 'CNY' },
        businessSource: 'ORDER',
        businessReference: orderId
      })
    ).toThrowError(expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }));

    const debit = adapter.createReservationDebit({
      idempotencyKey: 'debit:reservation:00000000-0000-0000-0000-00000000f003:v1',
      fundReservationId: '00000000-0000-0000-0000-00000000f003',
      fundReservationVersion: 1,
      externalUserId: 'mock-user-ok',
      amount: { amountMinor: 1_000, currency: 'CNY' },
      businessSource: 'ORDER',
      businessReference: orderId
    });

    expect(debit).toMatchObject({
      kind: 'FALLBACK_DEBIT',
      status: 'SUCCEEDED',
      fundReservationVersion: 1,
      businessSource: 'ORDER'
    });
  });

  test('refunds captured fallback and native hold transactions idempotently and rejects excessive refunds', () => {
    const adapter = buildAdapter();
    const debit = adapter.createReservationDebit({
      idempotencyKey: 'debit:reservation:00000000-0000-0000-0000-00000000f004:v1',
      fundReservationId: '00000000-0000-0000-0000-00000000f004',
      fundReservationVersion: 1,
      externalUserId: 'mock-user-ok',
      amount: { amountMinor: 5_000, currency: 'CNY' },
      businessSource: 'ORDER',
      businessReference: orderId
    });
    const refund = adapter.createRefund({
      idempotencyKey: 'refund:mock_txn_1:00000000-0000-0000-0000-00000000a001:v1',
      originalTransactionRef: debit.providerRef!,
      amount: { amountMinor: 2_000, currency: 'CNY' },
      reasonCode: 'ORDER_CANCELLED',
      businessReference: orderId
    });

    expect(adapter.getTransaction({ lookupType: 'PROVIDER_REF', lookupValue: debit.providerRef! })).toEqual(debit);
    expect(adapter.getTransaction({ lookupType: 'IDEMPOTENCY_KEY', lookupValue: refund.idempotencyKey })).toEqual(refund);
    expect(() =>
      adapter.createRefund({
        idempotencyKey: 'refund:mock_txn_1:00000000-0000-0000-0000-00000000a002:v1',
        originalTransactionRef: debit.providerRef!,
        amount: { amountMinor: 10_000, currency: 'CNY' },
        reasonCode: 'ORDER_CANCELLED',
        businessReference: orderId
      })
    ).toThrowError(expect.objectContaining({ code: 'REFUND_AMOUNT_EXCEEDED' }));

    const nativeHold = adapter.createHold(
      holdInput({
        idempotencyKey: 'hold:order:00000000-0000-0000-0000-00000000a005:v1',
        businessReference: '00000000-0000-0000-0000-00000000a005',
        fundReservationId: '00000000-0000-0000-0000-00000000f007'
      })
    );
    const capturedNativeHold = adapter.captureHold({
      holdRef: nativeHold.holdRef!,
      idempotencyKey: 'capture:hold:00000000-0000-0000-0000-00000000f007:v1',
      fundReservationId: '00000000-0000-0000-0000-00000000f007',
      fundReservationVersion: 1,
      amount: { amountMinor: 12_000, currency: 'CNY' },
      businessReference: '00000000-0000-0000-0000-00000000a005'
    });
    const nativeRefund = adapter.createRefund({
      idempotencyKey: 'refund:native-hold-capture:00000000-0000-0000-0000-00000000a005:v1',
      originalTransactionRef: capturedNativeHold.captureTransactionRef!,
      amount: { amountMinor: 3_000, currency: 'CNY' },
      reasonCode: 'ORDER_CANCELLED',
      businessReference: '00000000-0000-0000-0000-00000000a005'
    });

    expect(capturedNativeHold.captureTransactionRef).toMatch(/^mock_txn_/);
    expect(nativeRefund).toMatchObject({
      kind: 'REFUND',
      originalProviderRef: capturedNativeHold.captureTransactionRef,
      amount: { amountMinor: 3_000, currency: 'CNY' }
    });
  });

  test('verifies webhook signatures, rejects replay windows, and deduplicates events', () => {
    const adapter = buildAdapter();
    const body = {
      eventId: 'evt-hold-created-1',
      resourceType: 'HOLD',
      eventType: 'HOLD_CREATED',
      holdRef: 'mock_hold_webhook_1',
      holdStatus: 'ACTIVE',
      occurredAt: now.toISOString()
    };
    const rawBody = JSON.stringify(body);
    const signed = signMockWebhook({ rawBody, receivedAt: now });

    expect(() =>
      adapter.verifyWebhook({
        headers: { 'x-mock-signature': 'bad', 'x-mock-timestamp': signed.timestamp },
        rawBodyBase64: Buffer.from(rawBody).toString('base64'),
        receivedAt: now.toISOString()
      })
    ).toThrowError(expect.objectContaining({ code: 'SIGNATURE_INVALID' }));
    expect(() =>
      adapter.verifyWebhook({
        headers: signed.headers,
        rawBodyBase64: Buffer.from(rawBody).toString('base64'),
        receivedAt: new Date(now.getTime() + 301_000).toISOString()
      })
    ).toThrowError(expect.objectContaining({ code: 'REPLAY_REJECTED' }));
    const invalidTimestampSigned = signMockWebhook({ rawBody, receivedAt: 'not-a-date' });
    expect(() =>
      adapter.verifyWebhook({
        headers: invalidTimestampSigned.headers,
        rawBodyBase64: Buffer.from(rawBody).toString('base64'),
        receivedAt: now.toISOString()
      })
    ).toThrowError(expect.objectContaining({ code: 'REPLAY_REJECTED' }));
    const malformedRawBody = JSON.stringify({});
    const malformedSigned = signMockWebhook({ rawBody: malformedRawBody, receivedAt: now });
    expect(() =>
      adapter.verifyWebhook({
        headers: malformedSigned.headers,
        rawBodyBase64: Buffer.from(malformedRawBody).toString('base64'),
        receivedAt: now.toISOString()
      })
    ).toThrowError(expect.objectContaining({ code: 'SCHEMA_MISMATCH' }));

    const verified = adapter.verifyWebhook({
      headers: signed.headers,
      rawBodyBase64: Buffer.from(rawBody).toString('base64'),
      receivedAt: now.toISOString()
    });
    const duplicate = adapter.verifyWebhook({
      headers: signed.headers,
      rawBodyBase64: Buffer.from(rawBody).toString('base64'),
      receivedAt: now.toISOString()
    });

    expect(verified).toEqual(duplicate);
    expect(verified).toMatchObject({
      verified: true,
      event: {
        eventId: 'evt-hold-created-1',
        resourceType: 'HOLD',
        eventType: 'HOLD_CREATED',
        holdStatus: 'ACTIVE'
      }
    });
  });
});
