import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AdapterError } from '@blackcat/api/payment-adapter';
import { HttpFundingAdapter } from '@blackcat/api/http-payment-adapter';
import { createRuntimeFundingAdapter } from '@blackcat/api/funding-adapter-runtime';

let baseUrl = '';
const requests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined>; body: unknown }> = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: raw ? JSON.parse(raw) : null });
  response.setHeader('content-type', 'application/json');
  if (request.url === '/adapter/v1/fail') {
    response.statusCode = 503;
    response.end(JSON.stringify({ error: { code: 'PROVIDER_TIMEOUT', message: 'safe timeout', retryable: true } }));
    return;
  }
  response.statusCode = 200;
  response.end(JSON.stringify({ data: responseFor(request.method ?? '', request.url ?? '', raw ? JSON.parse(raw) : null) }));
});

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind.');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(() => server.close());

describe('M5-US-02 HTTP Payment Provider adapter', () => {
  test('selects mock locally, HTTP when configured, and fails closed for incomplete production config', () => {
    expect(createRuntimeFundingAdapter({ NODE_ENV: 'development' })).toMatchObject({ providerKey: 'mock-provider' });

    const configured = createRuntimeFundingAdapter({
      NODE_ENV: 'production',
      PAYMENT_PROVIDER_KEY: 'supplier-sandbox',
      PAYMENT_PROVIDER_BASE_URL: baseUrl,
      PAYMENT_PROVIDER_SERVICE_TOKEN: 'supplier-service-token-value-1234567890',
      PAYMENT_PROVIDER_WEBHOOK_SECRET: 'webhook-secret-value-1234567890123456'
    });
    expect(configured.providerKey).toBe('supplier-sandbox');
    expect(configured.adapter).toBeInstanceOf(HttpFundingAdapter);

    expect(() => createRuntimeFundingAdapter({
      NODE_ENV: 'production',
      PAYMENT_PROVIDER_KEY: 'supplier-sandbox',
      PAYMENT_PROVIDER_BASE_URL: baseUrl
    })).toThrow(/PAYMENT_PROVIDER_SERVICE_TOKEN/u);
  });

  test('executes all 11 provider-neutral operations with auth and stable idempotency headers', async () => {
    const adapter = fixture();
    const amount = { amountMinor: 1200, currency: 'CNY' };
    const holdInput = { idempotencyKey: 'order:provider:hold:0001', fundReservationId: 'reservation-1', fundReservationVersion: 2,
      externalUserId: 'external-1', amount, businessSource: 'ORDER' as const, businessReference: 'order-1', expiresAt: '2026-07-19T00:00:00.000Z' };

    expect((await adapter.discoverCapabilities()).providerKey).toBe('supplier-sandbox');
    expect((await adapter.resolveUser({ credentialType: 'ONE_TIME_CODE', credentialValue: 'BIND-OK', expectedCurrency: 'CNY' })).externalUserId).toBe('external-1');
    expect((await adapter.getProviderBalance({ externalUserId: 'external-1' })).providerBalanceMinor).toBe(100000);
    expect((await adapter.createHold(holdInput)).holdRef).toBe('hold-1');
    expect((await adapter.getHold({ lookupType: 'PROVIDER_HOLD_REF', lookupValue: 'hold-1' })).status).toBe('ACTIVE');
    expect((await adapter.captureHold({ holdRef: 'hold-1', idempotencyKey: 'order:provider:capture:0001', fundReservationId: 'reservation-1', fundReservationVersion: 2, amount, businessReference: 'order-1' })).status).toBe('CAPTURED');
    expect((await adapter.releaseHold({ holdRef: 'hold-1', idempotencyKey: 'order:provider:release:0001', fundReservationId: 'reservation-1', fundReservationVersion: 2, reasonCode: 'CANCELLED' })).status).toBe('RELEASED');
    expect((await adapter.createReservationDebit({ ...holdInput, idempotencyKey: 'order:provider:debit:0001' })).providerRef).toBe('txn-1');
    expect((await adapter.createRefund({ idempotencyKey: 'order:provider:refund:0001', originalTransactionRef: 'txn-1', amount, reasonCode: 'REFUND', businessReference: 'order-1' })).kind).toBe('REFUND');
    expect((await adapter.getTransaction({ lookupType: 'PROVIDER_REF', lookupValue: 'txn-1' })).status).toBe('SUCCEEDED');

    const writes = requests.filter((item) => ['POST', 'PATCH'].includes(item.method));
    expect(writes.every((item) => item.headers.authorization === 'Bearer supplier-service-token-value-1234567890')).toBe(true);
    expect(writes.filter((item) => item.url !== '/adapter/v1/users:resolve').every((item) => typeof item.headers['idempotency-key'] === 'string')).toBe(true);
  });

  test('maps safe provider failures without leaking tokens', async () => {
    const adapter = fixture({ capabilitiesPath: '/adapter/v1/fail' });
    await expect(adapter.discoverCapabilities()).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true, providerHttpStatus: 503 });
    await expect(adapter.discoverCapabilities()).rejects.not.toThrow(/supplier-service-token/u);
  });

  test('verifies supplier webhook signatures and rejects replay-window expiry locally', () => {
    const adapter = fixture();
    const receivedAt = '2026-07-18T22:00:00.000Z';
    const rawBody = JSON.stringify({ eventId: 'evt-1', resourceType: 'TRANSACTION', eventType: 'DEBIT_UPDATED', providerRef: 'txn-1', transactionStatus: 'SUCCEEDED', occurredAt: receivedAt });
    const signature = createHmac('sha256', 'webhook-secret-value-1234567890123456').update(`${receivedAt}.${rawBody}`).digest('hex');
    expect(adapter.verifyWebhook({ headers: { 'x-provider-timestamp': receivedAt, 'x-provider-signature': signature }, rawBodyBase64: Buffer.from(rawBody).toString('base64'), receivedAt }).event.eventId).toBe('evt-1');
    expect(() => adapter.verifyWebhook({ headers: { 'x-provider-timestamp': receivedAt, 'x-provider-signature': signature }, rawBodyBase64: Buffer.from(rawBody).toString('base64'), receivedAt: '2026-07-18T22:05:01.000Z' })).toThrowError(expect.objectContaining({ code: 'REPLAY_REJECTED' }));
  });
});

function fixture(overrides: Record<string, unknown> = {}) {
  return new HttpFundingAdapter({ baseUrl, serviceToken: 'supplier-service-token-value-1234567890', providerKey: 'supplier-sandbox',
    webhookSecret: 'webhook-secret-value-1234567890123456', timeoutMs: 2000, ...overrides });
}

function responseFor(method: string, url: string, body: any) {
  const money = body?.amount ?? { amountMinor: 1200, currency: 'CNY' };
  const hold = { status: url.endsWith(':capture') ? 'CAPTURED' : url.endsWith(':release') ? 'RELEASED' : 'ACTIVE', idempotencyKey: body?.idempotencyKey ?? 'hold-key', fundReservationId: body?.fundReservationId ?? 'reservation-1', fundReservationVersion: body?.fundReservationVersion ?? 2, externalUserId: 'external-1', businessSource: 'ORDER', businessReference: 'order-1', holdRef: 'hold-1', captureTransactionRef: 'txn-1', amount: money, capturedAmount: money, releasedAmount: { amountMinor: 0, currency: 'CNY' }, remainingAmount: { amountMinor: 0, currency: 'CNY' }, expiresAt: '2026-07-19T00:00:00.000Z', providerStatus: 'OK', observedAt: '2026-07-18T22:00:00.000Z', failure: null };
  const transaction = { kind: url.includes('refund') ? 'REFUND' : 'FALLBACK_DEBIT', status: 'SUCCEEDED', idempotencyKey: body?.idempotencyKey ?? 'txn-key', fundReservationId: body?.fundReservationId ?? null, fundReservationVersion: body?.fundReservationVersion ?? null, businessSource: body?.businessSource ?? null, amount: money, businessReference: body?.businessReference ?? 'order-1', providerRef: 'txn-1', originalProviderRef: body?.originalTransactionRef ?? null, providerStatus: 'SUCCEEDED', observedAt: '2026-07-18T22:00:00.000Z', providerOccurredAt: '2026-07-18T22:00:00.000Z', failure: null };
  if (url.endsWith('/capabilities')) return { providerKey: 'supplier-sandbox', discoveredAt: '2026-07-18T22:00:00.000Z', nativeHold: { supported: true, create: true, capture: true, release: true, get: true, idempotentWrites: true, lookupByIdempotencyKey: true, partialCapture: true, partialRelease: true, minimumTtlSeconds: 1, maximumTtlSeconds: 86400 }, fallbackDebit: { supported: true, idempotentWrites: true, lookupByIdempotencyKey: true }, refund: { full: true, partial: true, idempotentWrites: true, lookupByIdempotencyKey: true }, webhook: { supported: true, stableEventId: true, eventTypes: [] } };
  if (url.endsWith('/users:resolve')) return { externalUserId: 'external-1', displayName: 'User', verified: true, accountStatus: 'ACTIVE', resolvedAt: '2026-07-18T22:00:00.000Z' };
  if (url.includes('/provider-balance')) return { externalUserId: 'external-1', providerBalanceMinor: 100000, currency: 'CNY', fetchedAt: '2026-07-18T22:00:00.000Z', providerAsOf: '2026-07-18T22:00:00.000Z', stale: false };
  if (url.includes('/holds')) return hold;
  if (url.includes('/transactions') || url.includes('/reservation-debits') || url.includes('/refunds')) return transaction;
  throw new Error(`Unhandled fixture route ${method} ${url}`);
}
