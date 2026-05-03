import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { MockFundingAdapter, signMockWebhook } from '@blackcat/api/payment-adapter';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};

const now = new Date('2026-07-17T21:30:00.000Z');

function transactionWebhookBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    eventId: 'evt_submit_reconcile_001',
    resourceType: 'TRANSACTION',
    eventType: 'DEBIT_UPDATED',
    providerRef: 'mock_tx_order_001',
    transactionStatus: 'SUCCEEDED',
    amount: { amountMinor: 12000, currency: 'CNY' },
    occurredAt: now.toISOString(),
    ...overrides
  });
}

function buildWebhookServer() {
  return buildApiServer({
    env,
    paymentWebhook: {
      fundingAdapter: new MockFundingAdapter({ now }),
      providerKey: 'mock-provider',
      now: () => now
    }
  });
}

describe('M1-US-05 payment webhook API contract', () => {
  test('handlePaymentWebhook verifies exact raw bytes and deduplicates provider events', async () => {
    const server = buildWebhookServer();
    const rawBody = transactionWebhookBody();
    const signed = signMockWebhook({ rawBody, receivedAt: now });
    const request = {
      method: 'POST' as const,
      url: '/api/v1/webhooks/payment/mock-provider',
      headers: {
        ...signed.headers,
        'content-type': 'application/octet-stream',
        'x-request-id': 'req_webhook_m1_submit'
      },
      payload: Buffer.from(rawBody)
    };

    const first = await server.inject(request);
    const replay = await server.inject(request);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      requestId: 'req_webhook_m1_submit',
      data: {
        providerEventId: 'evt_submit_reconcile_001',
        eventType: 'DEBIT_UPDATED',
        status: 'SUCCEEDED',
        duplicate: false,
        applied: false,
        transactionId: null
      }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      data: {
        providerEventId: 'evt_submit_reconcile_001',
        duplicate: true,
        applied: false
      }
    });
  });

  test('handlePaymentWebhook verifies application/json payloads against their original raw bytes', async () => {
    const server = buildWebhookServer();
    const rawBody = JSON.stringify(
      {
        eventId: 'evt_submit_json_signature',
        resourceType: 'TRANSACTION',
        eventType: 'DEBIT_UPDATED',
        providerRef: 'mock_tx_order_json',
        transactionStatus: 'SUCCEEDED',
        amount: { amountMinor: 12000, currency: 'CNY' },
        occurredAt: now.toISOString()
      },
      null,
      2
    );
    const signed = signMockWebhook({ rawBody, receivedAt: now });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/payment/mock-provider',
      headers: {
        ...signed.headers,
        'content-type': 'application/json',
        'x-request-id': 'req_webhook_json_signature'
      },
      payload: rawBody
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requestId: 'req_webhook_json_signature',
      data: {
        providerEventId: 'evt_submit_json_signature',
        status: 'SUCCEEDED',
        duplicate: false
      }
    });
  });

  test('handlePaymentWebhook rejects invalid signatures before acknowledging the provider event', async () => {
    const server = buildWebhookServer();
    const rawBody = transactionWebhookBody({ eventId: 'evt_submit_bad_signature' });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/payment/mock-provider',
      headers: {
        'content-type': 'application/octet-stream',
        'x-mock-timestamp': now.toISOString(),
        'x-mock-signature': 'bad-signature',
        'x-request-id': 'req_webhook_bad_signature'
      },
      payload: Buffer.from(rawBody)
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      requestId: 'req_webhook_bad_signature',
      error: {
        code: 'SIGNATURE_INVALID',
        retryable: false
      }
    });
  });
});
