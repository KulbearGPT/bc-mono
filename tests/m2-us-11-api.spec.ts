import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAccountStore } from '@blackcat/api/accounts';
import { InMemoryServiceCatalogStore } from '@blackcat/api/catalog';
import { InMemoryOrderStore, registerOrderRoutes, type FundReservationRecord, type OrderRecord } from '@blackcat/api/orders';
import { InMemoryStaffTaskStore, type StaffTaskRecord } from '@blackcat/api/staff-tasks';
import { InMemoryAuditSink, InMemoryIdempotencyStore, type StaffDirectory } from '@blackcat/api/security';

const now = new Date('2026-07-18T09:00:00.000Z');
const guildId = '999999999999999999';
const orderId = '00000000-0000-0000-0000-00000000b611';
const l1DiscordId = '211111111111111111';
const l2DiscordId = '222222222222222222';
const l1StaffId = '00000000-0000-0000-0000-000000000611';
const l2StaffId = '00000000-0000-0000-0000-000000000622';

const staffDirectory: StaffDirectory = {
  resolveByDiscord({ discordUserId, guildId: inputGuildId }) {
    if (inputGuildId !== guildId) return null;
    if (discordUserId === l1DiscordId) return { staffId: l1StaffId, userId: l1StaffId, level: 'L1_SUPPORT', permissionsVersion: 1, status: 'ACTIVE' };
    if (discordUserId === l2DiscordId) return { staffId: l2StaffId, userId: l2StaffId, level: 'L2_SUPERVISOR', permissionsVersion: 1, status: 'ACTIVE' };
    return null;
  }
};

describe('M2-US-11 automation takeover API', () => {
  test('lets L1 pause only an order task they claimed without changing its reservation', async () => {
    const claimed = fixture({ tasks: [task({ claimedBy: l1StaffId, status: 'CLAIMED' })] });
    const paused = await claimed.server.inject({
      method: 'POST', url: `/api/v1/admin/orders/${orderId}/automation/pause`,
      headers: headers(l1DiscordId, 'dashboard:automation:pause:claimed'),
      payload: { expectedVersion: 3, reasonCode: 'STAFF_TAKEOVER', note: '客服正在核对用户取消请求。', scope: 'ALL', expiresAt: '2026-07-18T09:30:00.000Z' }
    });

    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ data: {
      orderId, orderVersion: 4,
      automation: { state: 'PAUSED', pausedByStaffId: l1StaffId, staffTaskId: task().id, reasonCode: 'STAFF_TAKEOVER', scope: 'ALL' }
    } });
    expect(claimed.orderStore.reservations[0]).toMatchObject({ status: 'ACTIVE', version: 1 });

    const unclaimed = fixture({ tasks: [] });
    const denied = await unclaimed.server.inject({
      method: 'POST', url: `/api/v1/admin/orders/${orderId}/automation/pause`,
      headers: headers(l1DiscordId, 'dashboard:automation:pause:unclaimed'),
      payload: { expectedVersion: 3, reasonCode: 'STAFF_TAKEOVER', scope: 'ALL' }
    });
    expect(denied.statusCode).toBe(403);
    expect(unclaimed.orderStore.orders[0]).toMatchObject({ version: 3, automationState: 'RUNNING' });
  });

  test('requires L2 to resume and revalidates the paused order version', async () => {
    const pausedOrder = order({
      version: 4, automationState: 'PAUSED', automationVersion: 2, automationPausedByStaffId: l1StaffId,
      automationStaffTaskId: task().id, automationReasonCode: 'STAFF_TAKEOVER', automationScope: 'ALL',
      automationPausedAt: now.toISOString(), automationExpiresAt: '2026-07-18T09:30:00.000Z'
    });
    const context = fixture({ order: pausedOrder, tasks: [task({ claimedBy: l1StaffId, status: 'CLAIMED' })] });
    const l1Denied = await context.server.inject({
      method: 'POST', url: `/api/v1/admin/orders/${orderId}/automation/resume`,
      headers: headers(l1DiscordId, 'dashboard:automation:resume:l1'),
      payload: { expectedVersion: 4, reasonCode: 'BLOCKER_RESOLVED', resumeAction: 'REDISPATCH' }
    });
    expect(l1Denied.statusCode).toBe(403);

    const resumed = await context.server.inject({
      method: 'POST', url: `/api/v1/admin/orders/${orderId}/automation/resume`,
      headers: headers(l2DiscordId, 'dashboard:automation:resume:l2'),
      payload: { expectedVersion: 4, reasonCode: 'BLOCKER_RESOLVED', resumeAction: 'REDISPATCH' }
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ data: {
      orderId, orderVersion: 5, resumeAction: 'REDISPATCH',
      automation: { state: 'RUNNING', pausedByStaffId: null, resumedAt: now.toISOString() }
    } });
    expect(context.orderStore.orders[0]).toMatchObject({ version: 5, automationState: 'RUNNING', automationVersion: 3 });
    expect(context.orderStore.reservations[0]).toMatchObject({ status: 'ACTIVE', version: 1 });
  });

  test('lets only L2 resolve a claimed task after automation resumes', async () => {
    const context = fixture({ tasks: [task({ claimedBy: l1StaffId, status: 'CLAIMED', version: 2 })] });
    const denied = await context.server.inject({
      method: 'POST', url: `/api/v1/admin/staff-tasks/${task().id}/resolve`,
      headers: headers(l1DiscordId, 'dashboard:staff-task:resolve:l1'),
      payload: { expectedVersion: 2, resolutionCode: 'AUTOMATION_RESUMED', notes: '核对完成。' }
    });
    expect(denied.statusCode).toBe(403);

    const resolved = await context.server.inject({
      method: 'POST', url: `/api/v1/admin/staff-tasks/${task().id}/resolve`,
      headers: headers(l2DiscordId, 'dashboard:staff-task:resolve:l2'),
      payload: { expectedVersion: 2, resolutionCode: 'AUTOMATION_RESUMED', notes: '主管复核后结清任务。' }
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ data: { id: task().id, status: 'RESOLVED', version: 3, resolvedBy: l2StaffId } });
    expect(context.staffTaskStore.tasks[0]?.contextSnapshot).toMatchObject({ resolutionNote: '主管复核后结清任务。' });
  });
});

function fixture(input: { order?: OrderRecord; tasks?: StaffTaskRecord[] } = {}) {
  const auditSink = new InMemoryAuditSink();
  const orderStore = new InMemoryOrderStore({ orders: [input.order ?? order()], reservations: [reservation()] });
  const staffTaskStore = new InMemoryStaffTaskStore({ tasks: input.tasks ?? [] });
  const server = buildApiServer({
    env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    security: { auditSink, idempotencyStore: new InMemoryIdempotencyStore(), staffDirectory },
    staffTasks: { store: staffTaskStore, orderStore, now: () => now }
  });
  registerOrderRoutes(server, {
    accountStore: new InMemoryAccountStore({}), catalogStore: new InMemoryServiceCatalogStore({ records: [] }),
    orderStore, staffTaskStore, now: () => now
  });
  return { server, orderStore, staffTaskStore, auditSink };
}

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: orderId, publicId: 'P-611', customerId: '00000000-0000-0000-0000-00000000a611', playerId: null,
    status: 'PENDING_DISPATCH', version: 3, serviceCatalogId: null, catalogVersion: null, game: 'VALORANT', service: 'ENTERTAINMENT',
    region: 'NA', billingUnitMinutes: 60, unitCount: 2, customerUnitPriceMinor: 6000, playerUnitPayoutMinor: 4200,
    amountMinor: 12000, playerEarningMinor: 8400, currency: 'CAT', notes: null,
    channelSpec: { channelId: '444444444444444444', panelMessageId: '555555555555555555', voiceChannelId: '666666666666666666' },
    automationState: 'RUNNING', automationVersion: 1, automationPausedByStaffId: null, automationStaffTaskId: null,
    automationReasonCode: null, automationScope: null, automationPausedAt: null, automationResumedAt: null, automationExpiresAt: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), ...overrides
  };
}

function reservation(): FundReservationRecord {
  return {
    id: '00000000-0000-0000-0000-00000000f611', userId: order().customerId, sourceType: 'ORDER', orderId,
    mode: 'LOCAL_RESERVATION', provider: 'mock-provider', providerHoldRef: null, amountMinor: 12000, currency: 'CAT',
    status: 'ACTIVE', version: 1, idempotencyKey: 'submit:P-611', expiresAt: '2026-07-18T10:00:00.000Z',
    activatedAt: now.toISOString(), settledAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
}

function task(overrides: Partial<StaffTaskRecord> = {}): StaffTaskRecord {
  return {
    id: '00000000-0000-0000-0000-00000000c611', publicId: 'T-611', type: 'CANCELLATION_ASSIST', reasonCode: 'CUSTOMER_REQUEST',
    status: 'OPEN', version: 1, orderId, giftRequestId: null, claimedBy: null, requiredLevel: 'L1_SUPPORT', voiceChannelId: null,
    contextSnapshot: { customerId: order().customerId }, createdAt: now.toISOString(), updatedAt: now.toISOString(), ...overrides
  };
}

function headers(discordUserId: string, idempotencyKey: string) {
  return {
    authorization: 'Bearer valid-bot-token', 'x-client-source': 'DASHBOARD', 'x-actor-discord-user-id': discordUserId,
    'x-actor-guild-id': guildId, 'idempotency-key': idempotencyKey
  };
}
