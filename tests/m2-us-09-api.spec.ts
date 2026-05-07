import { describe, expect, test } from 'vitest';
import { InMemoryDispatchPlayerPool, InMemoryDispatchStore, acceptOrder, dispatchOrder } from '@blackcat/api/dispatch';
import { InMemoryOrderStore, type OrderRecord } from '@blackcat/api/orders';
import type { PlayerProfileRecord } from '@blackcat/api/players';
import {
  InMemoryServiceLifecycleStore,
  expireOrderReadiness,
  handleReadinessTimeoutJob,
  rejectLegacyStartService,
  type ServiceLifecycleOrderRecord
} from '@blackcat/api/service-lifecycle';
import { InMemoryOutboxStore, OutboxWorker } from '@blackcat/api/outbox';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import { InMemoryAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';
import { InMemoryStaffTaskStore, registerStaffTaskRoutes } from '@blackcat/api/staff-tasks';

const now = new Date('2026-07-18T06:00:00.000Z');
const orderId = '00000000-0000-0000-0000-00000000b901';
const customerId = '00000000-0000-0000-0000-00000000a901';
const playerId = '00000000-0000-0000-0000-00000000a902';
const guildId = '999999999999999999';

function dispatchOrderRecord(): OrderRecord {
  return {
    id: orderId, publicId: 'P-9001', customerId, playerId: null, status: 'PENDING_DISPATCH', version: 3,
    serviceCatalogId: '00000000-0000-0000-0000-00000000c901', catalogVersion: 1,
    game: 'VALORANT', service: 'ENTERTAINMENT', region: 'NA', billingUnitMinutes: 60, unitCount: 2,
    customerUnitPriceMinor: 6000, playerUnitPayoutMinor: 4200, amountMinor: 12000, playerEarningMinor: 8400,
    currency: 'CNY', notes: null,
    channelSpec: { channelId: '444444444444444444', panelMessageId: '555555555555555555', voiceChannelId: '666666666666666666' },
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
}

function player(): PlayerProfileRecord {
  return {
    playerId: '00000000-0000-0000-0000-00000000c902', userId: playerId, guildId,
    discordUserId: '222222222222222222', userStatus: 'ACTIVE', reviewStatus: 'ACTIVE', availability: 'AVAILABLE',
    discordPresence: 'ONLINE', presenceObservedAt: now.toISOString(), gameTags: ['VALORANT'], serviceTags: ['ENTERTAINMENT'],
    activeOrderId: null, approvedByStaffId: null, approvedAt: now.toISOString(), pausedAt: null, suspendedAt: null,
    version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
}

function lifecycleOrder(): ServiceLifecycleOrderRecord {
  return {
    id: orderId, publicId: 'P-9001', customerId, playerId, status: 'ACCEPTED', version: 4,
    currency: 'CNY', amountMinor: 12000, playerEarningMinor: 8400,
    channelId: '444444444444444444', panelMessageId: '555555555555555555', voiceChannelId: '666666666666666666',
    readinessDueAt: new Date(now.getTime() + 10 * 60_000).toISOString(), customerReadyAt: now.toISOString(),
    playerReadyAt: null, serviceStartedAt: null, completionRequestedAt: null, confirmationDueAt: null, updatedAt: now.toISOString()
  };
}

function lifecycleStore() {
  return new InMemoryServiceLifecycleStore({
    orders: [lifecycleOrder()],
    discordAccounts: [
      { guildId, discordUserId: '111111111111111111', userId: customerId },
      { guildId, discordUserId: '222222222222222222', userId: playerId }
    ]
  });
}

describe('M2-US-09 readiness timeout lifecycle', () => {
  test('accepting an order schedules a readiness timeout alongside panel synchronization', async () => {
    const orderStore = new InMemoryOrderStore({ orders: [dispatchOrderRecord()] });
    const dispatchStore = new InMemoryDispatchStore();
    const playerPool = new InMemoryDispatchPlayerPool({ profiles: [player()] });
    const dispatched = await dispatchOrder({
      orderStore, dispatchStore, playerPool, orderId, expectedVersion: 3, trigger: 'ORDER_SUBMITTED',
      dispatchChannelId: '777777777777777777', idempotencyKey: 'system:dispatch:P-9001', now
    });

    await acceptOrder({
      orderStore, dispatchStore, playerPool, orderId, expectedVersion: 3, dispatchAttemptId: dispatched.dispatchAttemptId,
      actor: { guildId, discordUserId: player().discordUserId }, idempotencyKey: 'discord:accept:P-9001', now
    });

    expect(dispatchStore.outboxJobs.filter((job) => job.aggregateId === orderId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'PANEL_SYNC' }),
      expect.objectContaining({
        type: 'READINESS_TIMEOUT',
        runAfter: new Date(now.getTime() + 10 * 60_000).toISOString(),
        payload: { orderId, readinessDueAt: new Date(now.getTime() + 10 * 60_000).toISOString() }
      })
    ]));
  });

  test('rejects early execution, then creates one support task on timeout without starting or settling', async () => {
    const store = lifecycleStore();
    await expect(expireOrderReadiness({ store, orderId, now })).rejects.toThrowError(expect.objectContaining({ code: 'CONFLICT' }));

    const overdue = new Date(now.getTime() + 10 * 60_000);
    const first = await expireOrderReadiness({ store, orderId, now: overdue });
    const replay = await expireOrderReadiness({ store, orderId, now: new Date(overdue.getTime() + 1_000) });

    expect(first).toMatchObject({ orderId, status: 'ACCEPTED', readiness: { customer: 'READY', player: 'NOT_READY' } });
    expect(replay.staffTask.id).toBe(first.staffTask.id);
    expect(store.staffTasks).toHaveLength(1);
    expect(store.orders[0]).toMatchObject({ status: 'ACCEPTED', serviceStartedAt: null });
    expect(store.consumptionEntries).toEqual([]);
    expect(store.playerEarnings).toEqual([]);
  });

  test('Outbox worker can replay the timeout handler idempotently', async () => {
    const store = lifecycleStore();
    const dueAt = new Date(now.getTime() + 10 * 60_000);
    const outbox = new InMemoryOutboxStore({ now: dueAt, jobs: [{
      id: '00000000-0000-0000-0000-00000000e901', type: 'READINESS_TIMEOUT', status: 'PENDING',
      payload: { orderId, readinessDueAt: dueAt.toISOString() }, aggregateType: 'order', aggregateId: orderId,
      dedupeKey: `readiness-timeout:${orderId}`, attempts: 0, maxAttempts: 3, runAfter: dueAt.toISOString(),
      lockedAt: null, lockedBy: null, completedAt: null, lastError: null, version: 1,
      createdAt: now.toISOString(), updatedAt: now.toISOString()
    }] });
    const worker = new OutboxWorker({ store: outbox, workerId: 'readiness-worker', now: () => dueAt });

    const result = await worker.runOnce({
      READINESS_TIMEOUT: (job) => handleReadinessTimeoutJob({ job, store, now: dueAt })
    });

    expect(result[0]).toMatchObject({ status: 'COMPLETED' });
    expect(store.staffTasks).toHaveLength(1);
  });

  test('legacy unilateral start remains forbidden for the assigned player', async () => {
    await expect(rejectLegacyStartService({
      store: lifecycleStore(), orderId, actor: { guildId, discordUserId: '222222222222222222' }
    })).rejects.toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
  });

  test('current customer can list only redacted progress for support tasks on their own orders', async () => {
    const account: AccountBindingRecord = {
      userId: customerId, displayName: 'Customer', userStatus: 'ACTIVE', userVersion: 1,
      discordAccountId: '00000000-0000-0000-0000-00000000d901', guildId, discordUserId: '111111111111111111',
      externalAccountId: '00000000-0000-0000-0000-00000000e902', provider: 'mock-provider', externalUserId: 'secret-id',
      externalUserDisplay: 'masked', externalAccountStatus: 'ACTIVE', boundAt: now.toISOString()
    };
    const accountStore = new InMemoryAccountStore({ bindings: [account] });
    const staffStore = new InMemoryStaffTaskStore({ tasks: [{
      id: '00000000-0000-0000-0000-00000000f901', publicId: 'TASK-P-9001-READY', type: 'ORDER_ASSIST',
      reasonCode: 'READINESS_TIMEOUT', status: 'OPEN', version: 1, orderId, giftRequestId: null, claimedBy: null,
      requiredLevel: 'L1_SUPPORT', voiceChannelId: '666666666666666666',
      contextSnapshot: { customerId, internalNote: 'staff-only', evidence: 'private' },
      createdAt: now.toISOString(), updatedAt: now.toISOString()
    }] });
    const server = buildApiServer({
      env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
      security: { auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() }
    });
    registerStaffTaskRoutes(server, {
      store: staffStore,
      orderStore: new InMemoryOrderStore({ orders: [dispatchOrderRecord()] }),
      accountStore,
      now: () => now
    });

    const response = await server.inject({
      method: 'GET', url: '/api/v1/me/staff-tasks',
      headers: {
        authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT',
        'x-actor-discord-user-id': account.discordUserId, 'x-actor-guild-id': guildId,
        'x-discord-interaction-id': '777777777777777777'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { items: [{ publicId: 'TASK-P-9001-READY', status: 'OPEN', orderId }], nextCursor: null } });
    expect(JSON.stringify(response.json())).not.toMatch(/internalNote|evidence|secret-id|claimedBy|contextSnapshot/i);
  });
});
