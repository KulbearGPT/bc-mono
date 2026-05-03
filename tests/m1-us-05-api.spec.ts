import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore, type ActorContext } from '@blackcat/api/security';
import { InMemoryAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';
import { InMemoryServiceCatalogStore, type ServiceCatalogRecord } from '@blackcat/api/catalog';
import { AdapterError, MockFundingAdapter, type CreateHoldInput } from '@blackcat/api/payment-adapter';
import {
  InMemoryOrderStore,
  prepareSubmitOrder,
  registerOrderRoutes,
  type FundReservationRecord,
  type OrderRecord
} from '@blackcat/api/orders';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};

const now = new Date('2026-07-17T20:00:00.000Z');

function buildSubmitServer(input: {
  bindings?: AccountBindingRecord[];
  orders?: OrderRecord[];
  fundingAdapter?: Pick<MockFundingAdapter, 'getProviderBalance' | 'createHold' | 'getHold' | 'releaseHold'>;
} = {}) {
  const auditSink = new InMemoryAuditSink();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const accountStore = new InMemoryAccountStore({
    bindings: input.bindings ?? [boundAccount()],
    reservations: []
  });
  const catalogStore = new InMemoryServiceCatalogStore({ records: [service()] });
  const orderStore = new InMemoryOrderStore({ orders: input.orders ?? [pricedDraftOrder()] });
  const fundingAdapter = input.fundingAdapter ?? new MockFundingAdapter({ now });
  const server = buildApiServer({
    env,
    security: { auditSink, idempotencyStore }
  });

  registerOrderRoutes(server, {
    accountStore,
    catalogStore,
    orderStore,
    fundingAdapter,
    providerKey: 'mock-provider',
    now: () => now
  });

  return { server, accountStore, orderStore, fundingAdapter, auditSink, idempotencyStore };
}

class TimeoutAfterCommitFundingAdapter implements Pick<MockFundingAdapter, 'getProviderBalance' | 'createHold' | 'getHold' | 'releaseHold'> {
  private readonly base = new MockFundingAdapter({ now });

  getProviderBalance(input: Parameters<MockFundingAdapter['getProviderBalance']>[0]) {
    return this.base.getProviderBalance(input);
  }

  createHold(input: CreateHoldInput) {
    return this.base.createHold(input, { scenario: 'HOLD_TIMEOUT_AFTER_COMMIT' });
  }

  getHold(input: Parameters<MockFundingAdapter['getHold']>[0]) {
    return this.base.getHold(input);
  }

  releaseHold(input: Parameters<MockFundingAdapter['releaseHold']>[0]) {
    return this.base.releaseHold(input);
  }
}

class UnresolvedTimeoutFundingAdapter implements Pick<MockFundingAdapter, 'getProviderBalance' | 'createHold' | 'getHold' | 'releaseHold'> {
  private readonly base = new MockFundingAdapter({ now });

  getProviderBalance(input: Parameters<MockFundingAdapter['getProviderBalance']>[0]) {
    return this.base.getProviderBalance(input);
  }

  createHold(_input: CreateHoldInput) {
    throw new AdapterError('PROVIDER_TIMEOUT', 'Provider timed out before the hold could be recovered.', {
      retryable: true,
      providerHttpStatus: 504
    });
  }

  getHold(_input: Parameters<MockFundingAdapter['getHold']>[0]) {
    throw new AdapterError('RESOURCE_NOT_FOUND', 'Hold was not found.');
  }

  releaseHold(input: Parameters<MockFundingAdapter['releaseHold']>[0]) {
    return this.base.releaseHold(input);
  }
}

class CommitRaceFundingAdapter implements Pick<MockFundingAdapter, 'getProviderBalance' | 'createHold' | 'getHold' | 'releaseHold'> {
  private readonly base = new MockFundingAdapter({ now });

  getProviderBalance(input: Parameters<MockFundingAdapter['getProviderBalance']>[0]) {
    const balance = this.base.getProviderBalance(input);
    return { ...balance, providerBalanceMinor: 18000 };
  }

  createHold(input: CreateHoldInput) {
    return this.base.createHold(input);
  }

  getHold(input: Parameters<MockFundingAdapter['getHold']>[0]) {
    return this.base.getHold(input);
  }

  releaseHold(input: Parameters<MockFundingAdapter['releaseHold']>[0]) {
    return this.base.releaseHold(input);
  }
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

function botActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    actorUserId: '00000000-0000-0000-0000-00000000a001',
    actorStaffId: null,
    actorLevel: null,
    actorSource: 'DISCORD_BOT',
    clientId: 'DISCORD_BOT',
    guildId: '999999999999999999',
    discordUserId: '111111111111111111',
    interactionId: '777777777777777777',
    permissionsVersion: null,
    ...overrides
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

function activeGiftReservation(overrides: Partial<FundReservationRecord> = {}): FundReservationRecord {
  return {
    id: '00000000-0000-0000-0000-00000000f050',
    userId: '00000000-0000-0000-0000-00000000a001',
    sourceType: 'GIFT',
    orderId: null,
    mode: 'PROVIDER_NATIVE_HOLD',
    provider: 'mock-provider',
    providerHoldRef: 'mock_hold_gift_race',
    amountMinor: 7000,
    currency: 'CNY',
    status: 'ACTIVE',
    version: 1,
    idempotencyKey: 'discord:gift:race-reservation',
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    activatedAt: now.toISOString(),
    settledAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}

describe('M1-US-05 submit order and fund reservation API contract', () => {
  test('submitOrder creates one active order reservation and moves the draft to pending dispatch without capturing funds', async () => {
    const { server, orderStore, auditSink } = buildSubmitServer();

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001/submit',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:submit:0001' }),
      payload: { expectedVersion: 2 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        orderId: '00000000-0000-0000-0000-00000000b001',
        status: 'PENDING_DISPATCH',
        version: 3,
        reservation: {
          amountMinor: 12000,
          capturedMinor: 0,
          releasedMinor: 0,
          currency: 'CNY',
          status: 'ACTIVE',
          version: 1
        },
        balance: {
          providerBalanceMinor: 1000000,
          reservedMinor: 12000,
          availableMinor: 988000,
          currency: 'CNY'
        }
      }
    });
    expect(response.json().data.order).toBeUndefined();
    expect(response.json().data.fundReservation).toBeUndefined();
    expect(response.json().data.transactions).toBeUndefined();
    expect(orderStore.orders[0]).toMatchObject({ status: 'PENDING_DISPATCH', version: 3 });
    expect(orderStore.reservations).toHaveLength(1);
    expect(orderStore.reservationEvents).toHaveLength(1);
    expect(orderStore.externalTransactions).toHaveLength(0);
    expect(auditSink.records.at(-1)).toMatchObject({ permissionCode: 'order.submit', outcome: 'SUCCEEDED' });
    expect(auditSink.records.at(-1)?.afterSnapshot).toMatchObject({
      orderId: '00000000-0000-0000-0000-00000000b001',
      status: 'PENDING_DISPATCH',
      reservation: {
        reservationId: orderStore.reservations[0]?.id,
        providerHoldRef: orderStore.reservations[0]?.providerHoldRef,
        amountMinor: 12000,
        currency: 'CNY'
      }
    });
  });

  test('submitOrder rejects insufficient available balance and leaves the draft unchanged without reservation or dispatch', async () => {
    const { server, orderStore } = buildSubmitServer({
      bindings: [boundAccount({ externalUserId: 'mock-user-low', externalUserDisplay: 'mock-***-low' })]
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001/submit',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:submit:low-balance' }),
      payload: { expectedVersion: 2 }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: 'INSUFFICIENT_AVAILABLE_BALANCE'
      }
    });
    expect(orderStore.orders[0]).toMatchObject({ status: 'DRAFT', version: 2 });
    expect(orderStore.reservations).toHaveLength(0);
    expect(orderStore.externalTransactions).toHaveLength(0);
  });

  test('submitOrder rechecks the catalog price snapshot before reserving funds', async () => {
    const { server, orderStore } = buildSubmitServer({
      orders: [pricedDraftOrder({ customerUnitPriceMinor: 5000, amountMinor: 10000 })]
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001/submit',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:submit:stale-price' }),
      payload: { expectedVersion: 2 }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: 'CONFLICT'
      }
    });
    expect(orderStore.orders[0]).toMatchObject({ status: 'DRAFT', version: 2 });
    expect(orderStore.reservations).toHaveLength(0);
  });

  test('submitOrder is idempotent for repeated interactions and returns the same reservation result', async () => {
    const { server, orderStore } = buildSubmitServer();
    const request = {
      method: 'POST' as const,
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001/submit',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:submit:replay' }),
      payload: { expectedVersion: 2 }
    };

    const first = await server.inject(request);
    const replay = await server.inject(request);

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(orderStore.reservations).toHaveLength(1);
    expect(orderStore.reservationEvents).toHaveLength(1);
    expect(orderStore.events.filter((event) => event.eventType === 'SUBMITTED')).toHaveLength(1);
  });

  test('submitOrder recovers a provider timeout-after-commit hold by original idempotency key', async () => {
    const { server, orderStore } = buildSubmitServer({
      fundingAdapter: new TimeoutAfterCommitFundingAdapter()
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001/submit',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:submit:timeout-after-commit' }),
      payload: { expectedVersion: 2 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        orderId: '00000000-0000-0000-0000-00000000b001',
        status: 'PENDING_DISPATCH',
        reservation: {
          status: 'ACTIVE',
          amountMinor: 12000,
          capturedMinor: 0,
          releasedMinor: 0
        },
        balance: {
          reservedMinor: 12000,
          availableMinor: 988000
        }
      }
    });
    expect(orderStore.reservations).toHaveLength(1);
    expect(orderStore.reservationEvents).toHaveLength(1);
    expect(orderStore.orders[0]).toMatchObject({ status: 'PENDING_DISPATCH', version: 3 });
  });

  test('prepareSubmitOrder creates the submit event after the existing create event sequence', async () => {
    const accountStore = new InMemoryAccountStore({ bindings: [boundAccount()], reservations: [] });
    const catalogStore = new InMemoryServiceCatalogStore({ records: [service()] });
    const orderStore = new InMemoryOrderStore({
      orders: [pricedDraftOrder()],
      events: [
        {
          id: '00000000-0000-0000-0000-00000000e101',
          orderId: '00000000-0000-0000-0000-00000000b001',
          sequence: 1,
          eventType: 'CREATED',
          fromStatus: null,
          toStatus: 'DRAFT',
          actorUserId: null,
          actorStaffId: null,
          actorSource: 'DISCORD_BOT',
          interactionId: '777777777777777777',
          payload: {},
          createdAt: now.toISOString()
        }
      ]
    });

    const prepared = await prepareSubmitOrder({
      accountStore,
      catalogStore,
      orderStore,
      fundingAdapter: new MockFundingAdapter({ now }),
      providerKey: 'mock-provider',
      actor: botActor(),
      orderId: '00000000-0000-0000-0000-00000000b001',
      input: { expectedVersion: 2 },
      idempotencyKey: 'discord:order:submit:event-sequence',
      now
    });

    expect(prepared.orderEvent).toMatchObject({
      orderId: '00000000-0000-0000-0000-00000000b001',
      eventType: 'SUBMITTED',
      sequence: 2
    });
  });

  test('prepareSubmitOrder uses a stable reservation id so provider hold replay cannot drift from the local reservation', async () => {
    const accountStore = new InMemoryAccountStore({ bindings: [boundAccount()], reservations: [] });
    const catalogStore = new InMemoryServiceCatalogStore({ records: [service()] });
    const orderStore = new InMemoryOrderStore({ orders: [pricedDraftOrder()] });
    const fundingAdapter = new MockFundingAdapter({ now });
    const input = {
      accountStore,
      catalogStore,
      orderStore,
      fundingAdapter,
      providerKey: 'mock-provider',
      actor: botActor(),
      orderId: '00000000-0000-0000-0000-00000000b001',
      input: { expectedVersion: 2 },
      idempotencyKey: 'discord:order:submit:stable-reservation',
      now
    };

    const first = await prepareSubmitOrder(input);
    const replay = await prepareSubmitOrder(input);

    expect(replay.reservation.id).toBe(first.reservation.id);
    expect(replay.reservation.providerHoldRef).toBe(first.reservation.providerHoldRef);
    expect(replay.data.reservation.status).toBe('ACTIVE');
  });

  test('submitOrder returns provider timeout as 504 when timeout recovery cannot find the hold', async () => {
    const { server, orderStore } = buildSubmitServer({
      fundingAdapter: new UnresolvedTimeoutFundingAdapter()
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001/submit',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:submit:unresolved-timeout' }),
      payload: { expectedVersion: 2 }
    });

    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({
      error: {
        code: 'PROVIDER_TIMEOUT'
      }
    });
    expect(orderStore.orders[0]).toMatchObject({ status: 'DRAFT', version: 2 });
    expect(orderStore.reservations).toHaveLength(0);
  });

  test('submitOrder releases provider hold when commit-time reservation recheck rejects the submit', async () => {
    const fundingAdapter = new CommitRaceFundingAdapter();
    const { server, orderStore } = buildSubmitServer({ fundingAdapter });
    orderStore.reservations.push(activeGiftReservation());

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001/submit',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:submit:commit-race' }),
      payload: { expectedVersion: 2 }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'INSUFFICIENT_AVAILABLE_BALANCE' }
    });
    expect(orderStore.orders[0]).toMatchObject({ status: 'DRAFT', version: 2 });
    expect(orderStore.reservations).toHaveLength(1);
    expect(
      fundingAdapter.getHold({ lookupType: 'IDEMPOTENCY_KEY', lookupValue: 'discord:order:submit:commit-race' })
    ).toMatchObject({
      status: 'RELEASED',
      releasedAmount: { amountMinor: 12000, currency: 'CNY' },
      remainingAmount: { amountMinor: 0, currency: 'CNY' }
    });
  });

  test('buildApiServer order registration accepts funding adapter configuration for submitOrder', async () => {
    const auditSink = new InMemoryAuditSink();
    const idempotencyStore = new InMemoryIdempotencyStore();
    const accountStore = new InMemoryAccountStore({ bindings: [boundAccount()], reservations: [] });
    const catalogStore = new InMemoryServiceCatalogStore({ records: [service()] });
    const orderStore = new InMemoryOrderStore({ orders: [pricedDraftOrder()] });
    const server = buildApiServer({
      env,
      security: { auditSink, idempotencyStore },
      order: {
        accountStore,
        catalogStore,
        orderStore,
        fundingAdapter: new MockFundingAdapter({ now }),
        providerKey: 'mock-provider',
        now: () => now
      }
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001/submit',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:submit:server-options' }),
      payload: { expectedVersion: 2 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        orderId: '00000000-0000-0000-0000-00000000b001',
        status: 'PENDING_DISPATCH',
        reservation: { status: 'ACTIVE' },
        balance: { availableMinor: 988000 }
      }
    });
  });
});
