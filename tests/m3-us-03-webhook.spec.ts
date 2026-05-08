import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { MockFundingAdapter, signMockWebhook } from '@blackcat/api/payment-adapter';
import { InMemoryPaymentWebhookStore } from '@blackcat/api/webhooks';

const now = new Date('2026-07-18T15:00:00.000Z');

describe('M3-US-03 webhook final consistency', () => {
  test('keeps a refund aggregate when its succeeded callback arrives before the debit callback', async () => {
    const store = new InMemoryPaymentWebhookStore({ transactions: [{ id: 'tx-local-1', providerRef: 'mock_txn_original',
      status: 'PENDING', amountMinor: 500000, currency: 'CNY', refundedMinor: 0 }] });
    const server = buildApiServer({ env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0',
      API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    paymentWebhook: { fundingAdapter: new MockFundingAdapter({ now }), providerKey: 'mock-provider', now: () => now, store } });

    const refund = await send(server, { eventId: 'evt_refund_first', eventType: 'REFUND_UPDATED', providerRef: 'mock_refund_1',
      originalProviderRef: 'mock_txn_original', transactionStatus: 'SUCCEEDED', amount: { amountMinor: 500000, currency: 'CNY' } });
    const debit = await send(server, { eventId: 'evt_debit_late', eventType: 'DEBIT_UPDATED', providerRef: 'mock_txn_original',
      transactionStatus: 'SUCCEEDED', amount: { amountMinor: 500000, currency: 'CNY' } });

    expect(refund.json()).toMatchObject({ data: { applied: true, status: 'SUCCEEDED', transactionId: 'tx-local-1' } });
    expect(debit.json()).toMatchObject({ data: { applied: true, status: 'REFUNDED', transactionId: 'tx-local-1' } });
    expect(store.transactions[0]).toMatchObject({ status: 'REFUNDED', refundedMinor: 500000 });
    expect(store.consumptionAdjustments).toHaveLength(1);
    expect(store.commissionAdjustments).toHaveLength(1);
  });
});

async function send(server: ReturnType<typeof buildApiServer>, event: Record<string, unknown>) {
  const rawBody = JSON.stringify({ resourceType: 'TRANSACTION', occurredAt: now.toISOString(), ...event });
  const signed = signMockWebhook({ rawBody, receivedAt: now });
  return server.inject({ method: 'POST', url: '/api/v1/webhooks/payment/mock-provider',
    headers: { ...signed.headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from(rawBody) });
}
