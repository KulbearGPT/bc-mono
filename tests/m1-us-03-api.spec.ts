import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import { InMemoryAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';
import { InMemoryServiceCatalogStore, type ServiceCatalogRecord } from '@blackcat/api/catalog';
import {
  InMemoryOrderStore,
  registerOrderRoutes,
  type OrderRecord
} from '@blackcat/api/orders';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};

const now = new Date('2026-07-17T19:00:00.000Z');

function buildOrderServer(input: {
  bindings?: AccountBindingRecord[];
  services?: ServiceCatalogRecord[];
  orders?: OrderRecord[];
} = {}) {
  const auditSink = new InMemoryAuditSink();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const accountStore = new InMemoryAccountStore({
    bindings: input.bindings ?? [boundAccount()],
    reservations: []
  });
  const catalogStore = new InMemoryServiceCatalogStore({
    records: input.services ?? [service()]
  });
  const orderStore = new InMemoryOrderStore({ orders: input.orders ?? [] });
  const server = buildApiServer({
    env,
    security: {
      auditSink,
      idempotencyStore
    }
  });

  registerOrderRoutes(server, {
    accountStore,
    catalogStore,
    orderStore,
    now: () => now
  });

  return { server, accountStore, catalogStore, orderStore, auditSink, idempotencyStore };
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

function channelSpec(overrides: Partial<OrderRecord['channelSpec']> = {}) {
  return {
    channelId: '120000000000000001',
    panelMessageId: '120000000000000002',
    voiceChannelId: null,
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
    currency: 'CAT',
    status: 'ACTIVE',
    version: 3,
    createdByStaffId: '00000000-0000-0000-0000-000000000333',
    createdAt: now.toISOString(),
    activatedAt: now.toISOString(),
    retiredAt: null,
    ...overrides
  };
}

function draftOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: '00000000-0000-0000-0000-00000000b001',
    publicId: 'P-M1-ORD-1',
    customerId: '00000000-0000-0000-0000-00000000a001',
    playerId: null,
    status: 'DRAFT',
    version: 1,
    serviceCatalogId: null,
    catalogVersion: null,
    game: null,
    service: null,
    region: null,
    billingUnitMinutes: null,
    unitCount: null,
    customerUnitPriceMinor: null,
    playerUnitPayoutMinor: null,
    amountMinor: 0,
    playerEarningMinor: 0,
    currency: 'CAT',
    notes: null,
    channelSpec: channelSpec(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}

describe('M1-US-03 immediate order draft and estimate API contract', () => {
  test('createOrder creates an immediate draft for a bound customer with channel metadata and a CREATED event', async () => {
    const { server, auditSink, orderStore } = buildOrderServer();

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:create:0001' }),
      payload: {
        orderType: 'IMMEDIATE',
        channelSpec: channelSpec()
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: {
        status: 'DRAFT',
        version: 1,
        orderType: 'IMMEDIATE',
        currency: 'CAT',
        amountMinor: 0,
        playerEarningMinor: 0,
        fundReservation: null,
        readiness: {
          customer: 'NOT_READY',
          player: 'NOT_READY',
          bothReady: false,
          readyDeadlineAt: null,
          startedAt: null,
          staffTaskId: null
        },
        automation: {
          state: 'RUNNING',
          pausedByStaffId: null,
          reasonCode: null,
          pausedAt: null,
          resumedAt: null
        },
        channelSpec: channelSpec()
      }
    });
    expect(response.body).not.toContain('externalUserId');
    expect(orderStore.events).toHaveLength(1);
    expect(orderStore.events[0]).toMatchObject({ eventType: 'CREATED', toStatus: 'DRAFT' });
    expect(auditSink.records.at(-1)).toMatchObject({
      permissionCode: 'order.create',
      outcome: 'SUCCEEDED'
    });
  });

  test('createOrder returns the existing active order without creating a second draft', async () => {
    const { server, orderStore } = buildOrderServer({ orders: [draftOrder()] });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:create:existing' }),
      payload: {
        orderType: 'IMMEDIATE',
        channelSpec: channelSpec({ channelId: '120000000000000009' })
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        id: '00000000-0000-0000-0000-00000000b001',
        channelSpec: channelSpec()
      }
    });
    expect(orderStore.orders).toHaveLength(1);
    expect(orderStore.events).toHaveLength(0);
  });

  test('updateOrder snapshots the active service catalog and calculates customer and player minor-unit amounts server-side', async () => {
    const { server, orderStore } = buildOrderServer({ orders: [draftOrder()] });

    const response = await server.inject({
      method: 'PATCH',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:update:0001' }),
      payload: {
        expectedVersion: 1,
        serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
        unitCount: 2,
        region: 'NA',
        notes: '轻松交流，不急着上分',
        voiceChannelId: '120000000000000003'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        id: '00000000-0000-0000-0000-00000000b001',
        status: 'DRAFT',
        version: 2,
        serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
        catalogVersion: 3,
        unitCount: 2,
        billingUnitMinutes: 60,
        customerUnitPriceMinor: 6000,
        playerUnitPayoutMinor: 4200,
        amountMinor: 12000,
        playerEarningMinor: 8400,
        currency: 'CAT',
        region: 'NA',
        notes: '轻松交流，不急着上分',
        channelSpec: {
          channelId: '120000000000000001',
          panelMessageId: '120000000000000002',
          voiceChannelId: '120000000000000003'
        }
      }
    });
    expect(orderStore.events.at(-1)).toMatchObject({
      eventType: 'DETAILS_UPDATED',
      fromStatus: 'DRAFT',
      toStatus: 'DRAFT'
    });
  });

  test('updateOrder rejects stale expectedVersion and inactive catalog versions', async () => {
    const { server } = buildOrderServer({
      orders: [draftOrder({ version: 2 })],
      services: [service({ status: 'RETIRED' })]
    });

    const stale = await server.inject({
      method: 'PATCH',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:update:stale' }),
      payload: {
        expectedVersion: 1,
        serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
        unitCount: 2
      }
    });
    const unavailable = await server.inject({
      method: 'PATCH',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:update:inactive' }),
      payload: {
        expectedVersion: 2,
        serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
        unitCount: 2
      }
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(unavailable.statusCode).toBe(422);
    expect(unavailable.json()).toMatchObject({ error: { code: 'SERVICE_NOT_AVAILABLE' } });
  });

  test('estimateOrder returns the current draft estimate without changing order version or writing an event', async () => {
    const order = draftOrder({
      version: 2,
      serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
      catalogVersion: 3,
      billingUnitMinutes: 60,
      unitCount: 2,
      customerUnitPriceMinor: 6000,
      playerUnitPayoutMinor: 4200,
      amountMinor: 12000,
      playerEarningMinor: 8400,
      currency: 'CAT'
    });
    const { server, orderStore } = buildOrderServer({ orders: [order] });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001/estimate',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:order:estimate:0001' }),
      payload: { expectedVersion: 2 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
        catalogVersion: 3,
        unitCount: 2,
        billingUnitMinutes: 60,
        amountMinor: 12000,
        currency: 'CAT',
        validUntil: new Date(now.getTime() + 5 * 60_000).toISOString()
      }
    });
    expect(response.body).not.toContain('playerEarningMinor');
    expect(orderStore.orders[0]?.version).toBe(2);
    expect(orderStore.events).toHaveLength(0);
  });

  test('getOrder and updateOrder enforce current customer ownership', async () => {
    const { server } = buildOrderServer({
      orders: [draftOrder()],
      bindings: [
        boundAccount(),
        boundAccount({
          userId: '00000000-0000-0000-0000-00000000a002',
          discordAccountId: '00000000-0000-0000-0000-00000000d002',
          discordUserId: '222222222222222222',
          externalAccountId: '00000000-0000-0000-0000-00000000e002',
          externalUserId: 'mock-user-low',
          externalUserDisplay: 'mock-***-low'
        })
      ]
    });

    const readOther = await server.inject({
      method: 'GET',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001',
      headers: botHeaders('222222222222222222')
    });
    const updateOther = await server.inject({
      method: 'PATCH',
      url: '/api/v1/orders/00000000-0000-0000-0000-00000000b001',
      headers: botHeaders('222222222222222222', { 'idempotency-key': 'discord:order:update:other' }),
      payload: {
        expectedVersion: 1,
        serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
        unitCount: 2
      }
    });

    expect(readOther.statusCode).toBe(403);
    expect(updateOther.statusCode).toBe(403);
  });

  test('documents implemented order operationIds on the expected OpenAPI paths', async () => {
    const openapi = await readFile('docs/P0开发交付包/02-API/openapi.yaml', 'utf8');

    expect(readOperationId(openapi, '/api/v1/orders', 'post')).toBe('createOrder');
    expect(readOperationId(openapi, '/api/v1/orders/{orderId}', 'get')).toBe('getOrder');
    expect(readOperationId(openapi, '/api/v1/orders/{orderId}', 'patch')).toBe('updateOrder');
    expect(readOperationId(openapi, '/api/v1/orders/{orderId}/estimate', 'post')).toBe('estimateOrder');
    expect(countOperationId(openapi, 'createOrder')).toBe(1);
    expect(countOperationId(openapi, 'getOrder')).toBe(1);
    expect(countOperationId(openapi, 'updateOrder')).toBe(1);
    expect(countOperationId(openapi, 'estimateOrder')).toBe(1);
  });
});

function readOperationId(openapi: string, path: string, method: string): string | null {
  const pathIndex = openapi.indexOf(`  ${path}:`);
  if (pathIndex === -1) {
    return null;
  }
  const nextPathIndex = openapi.indexOf('\n  /', pathIndex + 1);
  const pathBlock = openapi.slice(pathIndex, nextPathIndex === -1 ? undefined : nextPathIndex);
  const methodIndex = pathBlock.indexOf(`\n    ${method}:`);
  if (methodIndex === -1) {
    return null;
  }
  const nextMethodMatch = pathBlock.slice(methodIndex + 1).match(/\n    [a-z]+:/);
  const methodBlock = pathBlock.slice(methodIndex, nextMethodMatch ? methodIndex + 1 + nextMethodMatch.index! : undefined);
  return methodBlock.match(/\n      operationId: ([A-Za-z0-9_]+)/)?.[1] ?? null;
}

function countOperationId(openapi: string, operationId: string): number {
  return openapi.match(new RegExp(`operationId: ${operationId}\\b`, 'g'))?.length ?? 0;
}
