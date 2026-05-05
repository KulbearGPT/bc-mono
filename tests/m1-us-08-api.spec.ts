import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import { InMemoryAccountStore, registerAccountRoutes, type AccountBindingRecord } from '@blackcat/api/accounts';
import { InMemoryServiceCatalogStore, type ServiceCatalogRecord } from '@blackcat/api/catalog';
import { MockFundingAdapter, type CreateHoldInput } from '@blackcat/api/payment-adapter';
import { InMemoryOrderStore, registerOrderRoutes, type OrderRecord } from '@blackcat/api/orders';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};

const now = new Date('2026-07-17T23:00:00.000Z');

class LocalFallbackFundingAdapter extends MockFundingAdapter {
  discoverCapabilities() {
    return super.discoverCapabilities({ scenario: 'CAPABILITIES_LOCAL_FALLBACK' });
  }

  createHold(_input: CreateHoldInput) {
    throw new Error('native hold should not be called when provider reports local fallback only');
  }
}

function buildFundingServer(input: { fundingAdapter?: MockFundingAdapter } = {}) {
  const auditSink = new InMemoryAuditSink();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const orderStore = new InMemoryOrderStore({ orders: [pricedDraftOrder()] });
  const accountStore = new InMemoryAccountStore({
    bindings: [boundAccount()],
    reservations: orderStore.reservations
  });
  const catalogStore = new InMemoryServiceCatalogStore({ records: [service()] });
  const fundingAdapter = input.fundingAdapter ?? new MockFundingAdapter({ now });
  const server = buildApiServer({
    env,
    security: { auditSink, idempotencyStore }
  });

  registerAccountRoutes(server, {
    store: accountStore,
    fundingAdapter,
    providerKey: 'mock-provider',
    now: () => now
  });
  registerOrderRoutes(server, {
    accountStore,
    catalogStore,
    orderStore,
    fundingAdapter,
    providerKey: 'mock-provider',
    now: () => now
  });

  return { server, accountStore, orderStore, fundingAdapter, auditSink };
}

function botHeaders(discordUserId: string, extra: Record<string, string> = {}) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': discordUserId,
    'x-actor-guild-id': '999999999999999999',
    'x-discord-interaction-id': '777777777777777777',
    ...extra
  };
}

function boundAccount(overrides: Partial<AccountBindingRecord> = {}): AccountBindingRecord {
  return {
    userId: '00000000-0000-0000-0000-00000000a001',
    displayName: 'mock-***-ok',
    userStatus: 'ACTIVE',
    userVersion: 1,
    discordAccountId: '00000000-0000-0000-0000-00000000d001',
    guildId: '999999999999999999',
    discordUserId: '111111111111111111',
    externalAccountId: '00000000-0000-0000-0000-00000000e001',
    provider: 'mock-provider',
    externalUserId: 'mock-user-ok',
    externalUserDisplay: 'mock-***-ok',
    externalAccountStatus: 'ACTIVE',
    boundAt: now.toISOString(),
    ...overrides
  };
}

function service(overrides: Partial<ServiceCatalogRecord> = {}): ServiceCatalogRecord {
  return {
    id: '00000000-0000-0000-0000-00000000c001',
    offeringKey: 'VALORANT|ENTERTAINMENT|NA',
    game: 'VALORANT',
    service: 'ENTERTAINMENT',
    region: 'NA',
    billingUnitMinutes: 60,
    minimumUnits: 1,
    customerUnitPriceMinor: 6000,
    playerUnitPayoutMinor: 4200,
    currency: 'CNY',
    status: 'ACTIVE',
    version: 3,
    createdByStaffId: '00000000-0000-0000-0000-000000000333',
    createdAt: now.toISOString(),
    activatedAt: now.toISOString(),
    retiredAt: null,
    ...overrides
  };
}

function pricedDraftOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: '00000000-0000-0000-0000-00000000b001',
    publicId: 'P-M1-ORD-1',
    customerId: '00000000-0000-0000-0000-00000000a001',
    playerId: null,
    status: 'DRAFT',
    version: 2,
    serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
    catalogVersion: 3,
    game: 'VALORANT',
    service: 'ENTERTAINMENT',
    region: 'NA',
    billingUnitMinutes: 60,
    unitCount: 2,
    customerUnitPriceMinor: 6000,
    playerUnitPayoutMinor: 4200,
    amountMinor: 12000,
    playerEarningMinor: 8400,
    currency: 'CNY',
    notes: '轻松交流',
    channelSpec: {
      channelId: '120000000000000001',
      panelMessageId: '120000000000000002',
      voiceChannelId: null
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}

describe('M1-US-08 reusable fund reservation model and API lifecycle', () => {
  test('getCurrentBalance reflects active order reservations created by submitOrder', async () => {
    const { server } = buildFundingServer();

    const submitted = await server.inject({
      method: 'POST',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001/submit',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:submit:m1-us-08-balance' }),
      payload: { expectedVersion: 2 }
    });
    const balance = await server.inject({
      method: 'GET',
      url: '/api/v1/me/balance',
      headers: botHeaders('111111111111111111')
    });

    expect(submitted.statusCode).toBe(200);
    expect(balance.statusCode).toBe(200);
    expect(balance.json()).toMatchObject({
      data: {
        providerBalanceMinor: 1_000_000,
        reservedMinor: 12_000,
        availableMinor: 988_000,
        currency: 'CNY'
      }
    });
  });

  test('submitOrder uses local reservation fallback when the provider has no native hold capability', async () => {
    const { server, orderStore } = buildFundingServer({
      fundingAdapter: new LocalFallbackFundingAdapter({ now })
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001/submit',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:submit:fallback' }),
      payload: { expectedVersion: 2 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        status: 'PENDING_DISPATCH',
        reservation: {
          status: 'ACTIVE',
          amountMinor: 12_000,
          capturedMinor: 0,
          releasedMinor: 0
        },
        balance: {
          reservedMinor: 12_000,
          availableMinor: 988_000
        }
      }
    });
    expect(orderStore.reservations[0]).toMatchObject({
      mode: 'LOCAL_RESERVATION_FALLBACK',
      providerHoldRef: null,
      status: 'ACTIVE'
    });
  });

  test('cancelOrder releases an active pre-capture order reservation and removes it from available-balance pressure', async () => {
    const { server, fundingAdapter, orderStore } = buildFundingServer();

    const submitted = await server.inject({
      method: 'POST',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001/submit',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:submit:before-cancel' }),
      payload: { expectedVersion: 2 }
    });
    const cancelled = await server.inject({
      method: 'POST',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001/cancel',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:cancel:m1-us-08' }),
      payload: {
        expectedVersion: 3,
        previewId: '00000000-0000-0000-0000-00000000c999',
        reasonCode: 'CUSTOMER_REQUEST'
      }
    });
    const balance = await server.inject({
      method: 'GET',
      url: '/api/v1/me/balance',
      headers: botHeaders('111111111111111111')
    });

    expect(submitted.statusCode).toBe(200);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      data: {
        orderId: '00000000-0000-0000-0000-00000000b001',
        status: 'CANCELLED',
        version: 4,
        fundAction: 'RELEASE_RESERVATION',
        amountMinor: 12_000,
        currency: 'CNY',
        reservation: {
          amountMinor: 12_000,
          capturedMinor: 0,
          releasedMinor: 12_000,
          status: 'RELEASED',
          version: 2
        },
        refundTransaction: null,
        staffTaskId: null
      }
    });
    expect(orderStore.orders[0]).toMatchObject({ status: 'CANCELLED', version: 4 });
    expect(orderStore.reservations[0]).toMatchObject({ status: 'RELEASED', version: 2 });
    expect(orderStore.reservationEvents.at(-1)).toMatchObject({ eventType: 'RELEASED', toStatus: 'RELEASED' });
    expect(balance.json()).toMatchObject({
      data: { reservedMinor: 0, availableMinor: 1_000_000 }
    });
    expect(
      fundingAdapter.getHold({
        lookupType: 'PROVIDER_HOLD_REF',
        lookupValue: orderStore.reservations[0]?.providerHoldRef ?? ''
      })
    ).toMatchObject({
      status: 'RELEASED',
      releasedAmount: { amountMinor: 12_000, currency: 'CNY' }
    });
  });
});
