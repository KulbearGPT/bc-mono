import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import { InMemoryAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';
import { InMemoryServiceCatalogStore } from '@blackcat/api/catalog';
import { InMemoryOrderStore, registerOrderRoutes, type FundReservationRecord, type OrderRecord } from '@blackcat/api/orders';
import { InMemoryStaffTaskStore } from '@blackcat/api/staff-tasks';

const now = new Date('2026-07-18T08:00:00.000Z');
const orderId = '00000000-0000-0000-0000-00000000ba10';
const userId = '00000000-0000-0000-0000-00000000aa10';
const guildId = '999999999999999999';

function account(): AccountBindingRecord {
  return {
    userId, displayName: 'Customer', userStatus: 'ACTIVE', userVersion: 1,
    discordAccountId: '00000000-0000-0000-0000-00000000da10', guildId, discordUserId: '111111111111111111',
    externalAccountId: '00000000-0000-0000-0000-00000000ea10', provider: 'mock-provider', externalUserId: 'mock-user',
    externalUserDisplay: 'mock-***', externalAccountStatus: 'ACTIVE', boundAt: now.toISOString()
  };
}

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: orderId, publicId: 'P-A10', customerId: userId, playerId: null, status: 'PENDING_DISPATCH', version: 3,
    serviceCatalogId: null, catalogVersion: null, game: 'VALORANT', service: 'ENTERTAINMENT', region: 'NA',
    billingUnitMinutes: 60, unitCount: 2, customerUnitPriceMinor: 6000, playerUnitPayoutMinor: 4200,
    amountMinor: 12000, playerEarningMinor: 8400, currency: 'CAT', notes: null,
    channelSpec: { channelId: '444444444444444444', panelMessageId: '555555555555555555', voiceChannelId: '666666666666666666' },
    createdAt: now.toISOString(), updatedAt: now.toISOString(), ...overrides
  };
}

function reservation(overrides: Partial<FundReservationRecord> = {}): FundReservationRecord {
  return {
    id: '00000000-0000-0000-0000-00000000fa10', userId, sourceType: 'ORDER', orderId,
    mode: 'LOCAL_RESERVATION', provider: 'mock-provider', providerHoldRef: null,
    amountMinor: 12000, currency: 'CAT', status: 'ACTIVE', version: 1, idempotencyKey: 'submit:P-A10',
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), activatedAt: now.toISOString(), settledAt: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), ...overrides
  };
}

function headers(key: string) {
  return {
    authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': account().discordUserId, 'x-actor-guild-id': guildId,
    'x-discord-interaction-id': '777777777777777777', 'idempotency-key': key
  };
}

function fixture(
  orderRecord = order(),
  options: { reservation?: FundReservationRecord } = {}
) {
  const accountStore = new InMemoryAccountStore({ bindings: [account()] });
  const orderStore = new InMemoryOrderStore({ orders: [orderRecord], reservations: [options.reservation ?? reservation()] });
  const staffTaskStore = new InMemoryStaffTaskStore({ tasks: [] });
  const server = buildApiServer({
    env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    security: { auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() }
  });
  registerOrderRoutes(server, {
    accountStore, orderStore, catalogStore: new InMemoryServiceCatalogStore({ records: [] }),
    staffTaskStore, now: () => now
  });
  return { server, orderStore, staffTaskStore };
}

describe('M2-US-10 cancellation preview and execution', () => {
  test('previews an automatic reservation release without mutating order or funds', async () => {
    const { server, orderStore } = fixture();
    const response = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/cancellation-preview`, headers: headers('preview:P-A10:first'),
      payload: { expectedVersion: 3, reasonCode: 'CUSTOMER_REQUEST' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: {
      orderId, orderVersion: 3, automaticallyProcessable: true, fundAction: 'RELEASE_RESERVATION',
      estimatedAmountMinor: 12000, releaseAmountMinor: 12000, refundAmountMinor: 0,
      currency: 'CAT', handlingTimeCode: 'IMMEDIATE', staffTaskRequired: false
    } });
    expect(orderStore.orders[0]).toMatchObject({ status: 'PENDING_DISPATCH', version: 3 });
    expect(orderStore.reservations[0]).toMatchObject({ status: 'ACTIVE', version: 1 });
  });

  test('executes only a matching unexpired preview and marks it applied', async () => {
    const { server, orderStore } = fixture();
    const previewResponse = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/cancellation-preview`, headers: headers('preview:P-A10:apply'),
      payload: { expectedVersion: 3, reasonCode: 'CUSTOMER_REQUEST' }
    });
    const previewId = previewResponse.json().data.previewId as string;
    const cancelled = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/cancel`, headers: headers('cancel:P-A10:apply'),
      payload: { expectedVersion: 3, previewId, reasonCode: 'CUSTOMER_REQUEST' }
    });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ data: { status: 'CANCELLED', fundAction: 'RELEASE_RESERVATION', amountMinor: 12000 } });
    expect(orderStore.orders[0]).toMatchObject({ status: 'CANCELLED', version: 4 });
    expect(orderStore.reservations[0]).toMatchObject({ status: 'RELEASED', version: 2 });
    expect(orderStore.cancellationPreviews[0]).toMatchObject({ id: previewId, status: 'APPLIED' });
  });

  test('rejects a stale preview after the order changes and leaves reservation untouched', async () => {
    const { server, orderStore } = fixture();
    const previewResponse = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/cancellation-preview`, headers: headers('preview:P-A10:stale'),
      payload: { expectedVersion: 3, reasonCode: 'CUSTOMER_REQUEST' }
    });
    const previewId = previewResponse.json().data.previewId as string;
    orderStore.orders[0] = { ...orderStore.orders[0]!, version: 4, updatedAt: new Date(now.getTime() + 1_000).toISOString() };

    const response = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/cancel`, headers: headers('cancel:P-A10:stale'),
      payload: { expectedVersion: 4, previewId, reasonCode: 'CUSTOMER_REQUEST' }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CANCELLATION_PREVIEW_STALE' } });
    expect(orderStore.orders[0]).toMatchObject({ status: 'PENDING_DISPATCH', version: 4 });
    expect(orderStore.reservations[0]).toMatchObject({ status: 'ACTIVE', version: 1 });
  });

  test('previews accepted-order cancellation as staff review with no automatic fund mutation', async () => {
    const { server } = fixture(order({ status: 'ACCEPTED', playerId: '00000000-0000-0000-0000-00000000aa11' }));
    const response = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/cancellation-preview`, headers: headers('preview:P-A10:staff'),
      payload: { expectedVersion: 3, reasonCode: 'CUSTOMER_REQUEST' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: {
      automaticallyProcessable: false, fundAction: 'NONE', estimatedAmountMinor: 0,
      releaseAmountMinor: 0, refundAmountMinor: 0, handlingTimeCode: 'STAFF_REVIEW_REQUIRED', staffTaskRequired: true
    } });
  });

  test('releases the internal wallet reservation without external funding lookup', async () => {
    const { server, orderStore, staffTaskStore } = fixture(order());
    const previewResponse = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/cancellation-preview`, headers: headers('preview:P-A10:provider-unknown'),
      payload: { expectedVersion: 3, reasonCode: 'CUSTOMER_REQUEST' }
    });
    const response = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/cancel`, headers: headers('cancel:P-A10:provider-unknown'),
      payload: { expectedVersion: 3, previewId: previewResponse.json().data.previewId, reasonCode: 'CUSTOMER_REQUEST' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { status: 'CANCELLED', fundAction: 'RELEASE_RESERVATION', staffTaskId: null } });
    expect(orderStore.orders[0]).toMatchObject({ status: 'CANCELLED', version: 4 });
    expect(orderStore.reservations[0]).toMatchObject({ status: 'RELEASED', version: 2 });
    expect(staffTaskStore.tasks).toEqual([]);
  });

  test('routes a paused pending-dispatch cancellation to staff without releasing funds', async () => {
    const { server, orderStore, staffTaskStore } = fixture(order({
      automationState: 'PAUSED', automationVersion: 2, automationPausedByStaffId: '00000000-0000-0000-0000-000000000611',
      automationStaffTaskId: '00000000-0000-0000-0000-00000000c611', automationReasonCode: 'STAFF_TAKEOVER',
      automationScope: 'ALL', automationPausedAt: now.toISOString()
    }));
    const preview = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/cancellation-preview`, headers: headers('preview:P-A10:paused'),
      payload: { expectedVersion: 3, reasonCode: 'CUSTOMER_REQUEST' }
    });
    const cancelled = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/cancel`, headers: headers('cancel:P-A10:paused'),
      payload: { expectedVersion: 3, previewId: preview.json().data.previewId, reasonCode: 'CUSTOMER_REQUEST' }
    });

    expect(preview.json()).toMatchObject({ data: { automaticallyProcessable: false, staffTaskRequired: true, fundAction: 'NONE' } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ data: { status: 'PENDING_DISPATCH', fundAction: 'NONE', staffTaskId: expect.any(String) } });
    expect(orderStore.orders[0]).toMatchObject({ status: 'PENDING_DISPATCH', automationState: 'PAUSED' });
    expect(orderStore.reservations[0]).toMatchObject({ status: 'ACTIVE', version: 1 });
    expect(staffTaskStore.tasks).toEqual([expect.objectContaining({ type: 'CANCELLATION_ASSIST', reasonCode: 'AUTOMATION_PAUSED' })]);
  });
});
