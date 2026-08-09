import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import {
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
  type StaffDirectory
} from '@blackcat/api/security';
import { InMemoryAccountStore, registerAccountRoutes, type AccountBindingRecord } from '@blackcat/api/accounts';
import { InMemoryServiceCatalogStore, type ServiceCatalogRecord } from '@blackcat/api/catalog';
import { TestWalletFunding } from './support/wallet-fixture';
import { InMemoryOrderStore, registerOrderRoutes, type OrderRecord } from '@blackcat/api/orders';
import { InMemoryRiskEventStore } from '@blackcat/api/risk-events';
import {
  InMemoryStaffTaskStore,
  claimStaffTask,
  createOrderStaffTask,
  registerStaffTaskRoutes
} from '@blackcat/api/staff-tasks';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};
const now = new Date('2026-07-18T05:00:00.000Z');
const guildId = '999999999999999999';
const customerDiscordUserId = '111111111111111111';
const staffADiscordUserId = '222222222222222221';
const staffBDiscordUserId = '222222222222222222';
const customerId = '00000000-0000-0000-0000-00000000a001';
const orderId = '00000000-0000-0000-0000-00000000b001';

const staffDirectory: StaffDirectory = {
  resolveByDiscord({ discordUserId, guildId: inputGuildId }) {
    if (inputGuildId !== guildId) {
      return null;
    }
    if (discordUserId === staffADiscordUserId) {
      return {
        staffId: '00000000-0000-0000-0000-00000000s221',
        userId: '00000000-0000-0000-0000-00000000u221',
        level: 'L1_SUPPORT',
        permissionsVersion: 1,
        status: 'ACTIVE'
      };
    }
    if (discordUserId === staffBDiscordUserId) {
      return {
        staffId: '00000000-0000-0000-0000-00000000s222',
        userId: '00000000-0000-0000-0000-00000000u222',
        level: 'L2_SUPERVISOR',
        permissionsVersion: 1,
        status: 'ACTIVE'
      };
    }
    return null;
  }
};

describe('M2-US-05 staff task and cancellation support API', () => {
  test('createOrderStaffTask idempotently creates one active support task for the same order reason', async () => {
    const store = new InMemoryStaffTaskStore({ tasks: [] });

    const first = await createOrderStaffTask({
      store,
      order: acceptedOrder(),
      type: 'CANCELLATION_ASSIST',
      reasonCode: 'CUSTOMER_CANCEL_AFTER_ACCEPT',
      actor: { actorUserId: customerId, actorStaffId: null, actorSource: 'DISCORD_BOT' },
      note: '用户要求取消，等待客服确认。',
      voiceChannelId: '120000000000000003',
      now
    });
    const replay = await createOrderStaffTask({
      store,
      order: acceptedOrder(),
      type: 'CANCELLATION_ASSIST',
      reasonCode: 'CUSTOMER_CANCEL_AFTER_ACCEPT',
      actor: { actorUserId: customerId, actorStaffId: null, actorSource: 'DISCORD_BOT' },
      note: '重复点击取消',
      voiceChannelId: '120000000000000003',
      now: new Date(now.getTime() + 1_000)
    });

    expect(first).toMatchObject({
      type: 'CANCELLATION_ASSIST',
      reasonCode: 'CUSTOMER_CANCEL_AFTER_ACCEPT',
      status: 'OPEN',
      orderId,
      claimedBy: null,
      requiredLevel: 'L1_SUPPORT'
    });
    expect(replay.id).toBe(first.id);
    expect(store.tasks).toHaveLength(1);
  });

  test('createOrderStaffTask supports exception task types without auto-ruling the incident', async () => {
    const store = new InMemoryStaffTaskStore({ tasks: [] });

    const task = await createOrderStaffTask({
      store,
      order: acceptedOrder({ status: 'IN_SERVICE', version: 6 }),
      type: 'PLAYER_NO_SHOW',
      reasonCode: 'PLAYER_NO_SHOW_REPORTED',
      actor: { actorUserId: customerId, actorStaffId: null, actorSource: 'DISCORD_BOT' },
      note: '用户报告陪玩未出现，等待客服核对。',
      now
    });

    expect(task).toMatchObject({
      type: 'PLAYER_NO_SHOW',
      reasonCode: 'PLAYER_NO_SHOW_REPORTED',
      status: 'OPEN',
      orderId
    });
    expect(task.contextSnapshot).toMatchObject({
      status: 'IN_SERVICE',
      note: '用户报告陪玩未出现，等待客服核对。'
    });
  });

  test('claimStaffTask lets only one L1 support actor claim an open task', async () => {
    const store = new InMemoryStaffTaskStore({ tasks: [] });
    const task = await createOrderStaffTask({
      store,
      order: acceptedOrder(),
      type: 'CANCELLATION_ASSIST',
      reasonCode: 'CUSTOMER_CANCEL_AFTER_ACCEPT',
      actor: { actorUserId: customerId, actorStaffId: null, actorSource: 'DISCORD_BOT' },
      now
    });

    const first = await claimStaffTask({
      store,
      staffTaskId: task.id,
      expectedVersion: 1,
      actorStaffId: '00000000-0000-0000-0000-00000000s221',
      now
    });

    expect(first).toMatchObject({
      id: task.id,
      status: 'CLAIMED',
      version: 2,
      claimedBy: '00000000-0000-0000-0000-00000000s221'
    });
    await expect(
      claimStaffTask({
        store,
        staffTaskId: task.id,
        expectedVersion: 1,
        actorStaffId: '00000000-0000-0000-0000-00000000s222',
        now
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  });

  test('staff task routes create and claim tasks through the shared API permission layer', async () => {
    const { server, staffTaskStore } = buildM2Server({ order: acceptedOrder() });

    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/staff-tasks`,
      headers: botHeaders(customerDiscordUserId, { 'idempotency-key': 'discord:staff-task:create:cancel' }),
      payload: {
        type: 'CANCELLATION_ASSIST',
        reasonCode: 'CUSTOMER_CANCEL_AFTER_ACCEPT',
        note: '用户要求取消',
        voiceChannelId: '120000000000000003'
      }
    });
    const claimed = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/staff-tasks/${created.json().data.id}/claim`,
      headers: dashboardHeaders(staffADiscordUserId, { 'idempotency-key': 'dashboard:staff-task:claim:one' }),
      payload: { expectedVersion: 1 }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      data: {
        type: 'CANCELLATION_ASSIST',
        status: 'OPEN',
        orderId,
        claimedBy: null,
        requiredLevel: 'L1_SUPPORT'
      }
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({
      data: {
        id: created.json().data.id,
        status: 'CLAIMED',
        claimedBy: '00000000-0000-0000-0000-00000000s221'
      }
    });
    expect(staffTaskStore.tasks[0]).toMatchObject({ status: 'CLAIMED' });
  });

  test('risk event route appends a user risk event while leaving user status unchanged', async () => {
    const { server } = buildM2Server({ order: acceptedOrder() });

    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${customerId}/risk-events`,
      headers: dashboardHeaders(staffBDiscordUserId, { 'idempotency-key': 'dashboard:risk:create:no-show' }),
      payload: {
        type: 'PLAYER_NO_SHOW',
        severity: 'MEDIUM',
        source: 'CUSTOMER_REPORT',
        notes: '用户报告陪玩未到，创建风险事件供客服后续复核。',
        orderId
      }
    });
    const currentUser = await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: botHeaders(customerDiscordUserId)
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      data: {
        riskEvent: {
          userId: customerId,
          orderId,
          type: 'PLAYER_NO_SHOW',
          severity: 'MEDIUM',
          source: 'CUSTOMER_REPORT',
          notes: '用户报告陪玩未到，创建风险事件供客服后续复核。',
          createdBy: '00000000-0000-0000-0000-00000000s222'
        },
        userStatusChanged: false
      }
    });
    expect(currentUser.json().data.user.status).toBe('ACTIVE');
  });

  test('buildApiServer wires staff task routes from runtime options', async () => {
    const auditSink = new InMemoryAuditSink();
    const idempotencyStore = new InMemoryIdempotencyStore();
    const orderStore = new InMemoryOrderStore({ orders: [acceptedOrder()] });
    const staffTaskStore = new InMemoryStaffTaskStore({ tasks: [] });
    const server = buildApiServer({
      env,
      security: { auditSink, idempotencyStore, staffDirectory },
      staffTasks: { store: staffTaskStore, orderStore, now: () => now }
    });

    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/staff-tasks`,
      headers: botHeaders(customerDiscordUserId, { 'idempotency-key': 'discord:staff-task:create:runtime' }),
      payload: {
        type: 'CANCELLATION_ASSIST',
        reasonCode: 'CUSTOMER_CANCEL_AFTER_ACCEPT'
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ data: { type: 'CANCELLATION_ASSIST', orderId } });
  });

  test('accepted order cancellation creates CANCELLATION_ASSIST without changing order or releasing reservation', async () => {
    const { server, orderStore, staffTaskStore } = buildM2Server({ order: acceptedOrder() });

    const preview = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/cancellation-preview`,
      headers: botHeaders(customerDiscordUserId, { 'idempotency-key': 'discord:order:cancel-preview:accepted' }),
      payload: { expectedVersion: 4, reasonCode: 'CUSTOMER_REQUEST' }
    });

    const cancelled = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/cancel`,
      headers: botHeaders(customerDiscordUserId, { 'idempotency-key': 'discord:order:cancel:accepted' }),
      payload: {
        expectedVersion: 4,
        previewId: preview.json().data.previewId,
        reasonCode: 'CUSTOMER_REQUEST'
      }
    });

    expect(preview.statusCode).toBe(200);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      data: {
        orderId,
        status: 'ACCEPTED',
        version: 4,
        fundAction: 'NONE',
        amountMinor: 0,
        reservation: null,
        refundTransaction: null,
        staffTaskId: staffTaskStore.tasks[0]?.id
      }
    });
    expect(orderStore.orders[0]).toMatchObject({ status: 'ACCEPTED', version: 4 });
    expect(orderStore.reservations[0]).toMatchObject({ status: 'ACTIVE', version: 1 });
    expect(staffTaskStore.tasks).toEqual([
      expect.objectContaining({
        type: 'CANCELLATION_ASSIST',
        reasonCode: 'CUSTOMER_CANCEL_AFTER_ACCEPT',
        status: 'OPEN',
        orderId
      })
    ]);
  });
});

function buildM2Server(input: { order: OrderRecord }) {
  const auditSink = new InMemoryAuditSink();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const orderStore = new InMemoryOrderStore({
    orders: [input.order],
    reservations: [activeReservation()]
  });
  const accountStore = new InMemoryAccountStore({
    bindings: [boundAccount()],
    reservations: orderStore.reservations
  });
  const catalogStore = new InMemoryServiceCatalogStore({ records: [service()] });
  const staffTaskStore = new InMemoryStaffTaskStore({ tasks: [] });
  const riskEventStore = new InMemoryRiskEventStore({ events: [] });
  const walletFunding = new TestWalletFunding();
  const server = buildApiServer({
    env,
    security: { auditSink, idempotencyStore, staffDirectory },
    riskEvents: { store: riskEventStore, now: () => now }
  });

  registerAccountRoutes(server, {
    store: accountStore,
    walletFunding,
    now: () => now
  });
  registerStaffTaskRoutes(server, { store: staffTaskStore, orderStore, now: () => now });
  registerOrderRoutes(server, {
    accountStore,
    catalogStore,
    orderStore,
    walletFunding,
    staffTaskStore,
    now: () => now
  });

  return { server, orderStore, staffTaskStore };
}

function boundAccount(overrides: Partial<AccountBindingRecord> = {}): AccountBindingRecord {
  return {
    userId: customerId,
    displayName: 'mock-***-ok',
    userStatus: 'ACTIVE',
    userVersion: 1,
    discordAccountId: '00000000-0000-0000-0000-00000000d001',
    guildId,
    discordUserId: customerDiscordUserId,
    externalAccountId: '00000000-0000-0000-0000-00000000e001',
    provider: 'mock-provider',
    externalUserId: 'mock-user-ok',
    externalUserDisplay: 'mock-***-ok',
    externalAccountStatus: 'ACTIVE',
    boundAt: now.toISOString(),
    ...overrides
  };
}

function acceptedOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: orderId,
    publicId: 'P-M2-ORD-5',
    customerId,
    playerId: '00000000-0000-0000-0000-00000000a002',
    status: 'ACCEPTED',
    version: 4,
    guildId,
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
    currency: 'CAT',
    notes: '轻松交流',
    channelSpec: {
      channelId: '120000000000000001',
      panelMessageId: '120000000000000002',
      voiceChannelId: '120000000000000003'
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
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

function activeReservation() {
  return {
    id: '00000000-0000-0000-0000-00000000f001',
    userId: customerId,
    sourceType: 'ORDER' as const,
    orderId,
    mode: 'LOCAL_RESERVATION' as const,
    provider: 'mock-provider',
    providerHoldRef: null,
    amountMinor: 12000,
    currency: 'CAT' as const,
    status: 'ACTIVE' as const,
    version: 1,
    idempotencyKey: 'discord:order:submit:m2-us-05',
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    activatedAt: now.toISOString(),
    settledAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function botHeaders(discordUserId: string, extra: Record<string, string> = {}) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': discordUserId,
    'x-actor-guild-id': guildId,
    'x-discord-interaction-id': '777777777777777777',
    ...extra
  };
}

function dashboardHeaders(discordUserId: string, extra: Record<string, string> = {}) {
  return {
    ...botHeaders(discordUserId, extra),
    'x-client-source': 'DASHBOARD'
  };
}
