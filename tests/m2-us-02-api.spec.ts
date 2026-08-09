import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import {
  InMemoryDispatchStore,
  InMemoryDispatchPlayerPool,
  dispatchOrder,
  expireDispatchAttempt,
  registerDispatchRoutes,
  type DispatchCandidateRecord
} from '@blackcat/api/dispatch';
import { InMemoryOrderStore, type OrderRecord } from '@blackcat/api/orders';
import type { PlayerProfileRecord } from '@blackcat/api/players';

const now = new Date('2026-07-18T01:00:00.000Z');
const guildId = '999999999999999999';
const orderId = '00000000-0000-0000-0000-00000000b001';
const eligiblePlayerUserId = '00000000-0000-0000-0000-00000000a201';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};

function pendingDispatchOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: orderId,
    publicId: 'P-2001',
    customerId: '00000000-0000-0000-0000-00000000a101',
    playerId: null,
    status: 'PENDING_DISPATCH',
    version: 3,
    serviceCatalogId: '00000000-0000-0000-0000-00000000c101',
    catalogVersion: 1,
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
    notes: '中文交流',
    channelSpec: {
      channelId: '444444444444444444',
      panelMessageId: '555555555555555555',
      voiceChannelId: '666666666666666666'
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}

function player(overrides: Partial<PlayerProfileRecord> = {}): PlayerProfileRecord {
  return {
    playerId: '00000000-0000-0000-0000-00000000p201'.replace('p', 'a'),
    userId: eligiblePlayerUserId,
    guildId,
    discordUserId: '222222222222222222',
    userStatus: 'ACTIVE',
    reviewStatus: 'ACTIVE',
    availability: 'AVAILABLE',
    discordPresence: 'ONLINE',
    presenceObservedAt: now.toISOString(),
    gameTags: ['VALORANT'],
    serviceTags: ['ENTERTAINMENT'],
    activeOrderId: null,
    approvedByStaffId: '00000000-0000-0000-0000-000000000333',
    approvedAt: now.toISOString(),
    pausedAt: null,
    suspendedAt: null,
    version: 2,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}

describe('M2-US-02 dispatch domain and API', () => {
  test('dispatchOrder creates one active attempt, eligible candidate snapshot, message outbox and timeout job', async () => {
    const orderStore = new InMemoryOrderStore({ orders: [pendingDispatchOrder()] });
    orderStore.getNextOpenRequirement = async () => ({
      id: '00000000-0000-0000-0000-00000000d299',
      serviceCatalogVersionId: '00000000-0000-0000-0000-00000000c101',
      serviceOfferingId: '00000000-0000-0000-0000-00000000c102',
      game: 'VALORANT', gameDisplayName: '瓦洛兰特',
      service: 'ENTERTAINMENT', serviceDisplayName: '娱乐陪玩',
      region: 'NA', regionDisplayName: '北美',
      billingUnitMinutes: 60, unitCount: 2, requestedPlayerCount: 1, filledPlayerCount: 0,
      customerUnitPriceMinor: 6000, linePriceMinorPerPlayer: 12000, defaultPlayerPayoutBps: 7000
    });
    const dispatchStore = new InMemoryDispatchStore();
    const playerPool = new InMemoryDispatchPlayerPool({
      profiles: [
        player(),
        player({ userId: '00000000-0000-0000-0000-00000000a202', discordUserId: '222222222222222223', availability: 'BUSY' }),
        player({ userId: '00000000-0000-0000-0000-00000000a203', discordUserId: '222222222222222224', discordPresence: 'OFFLINE' })
      ]
    });

    const result = await dispatchOrder({
      orderStore,
      dispatchStore,
      playerPool,
      orderId,
      expectedVersion: 3,
      trigger: 'ORDER_SUBMITTED',
      dispatchChannelId: '777777777777777777',
      idempotencyKey: 'system:dispatch:order:P-2001',
      now
    });

    expect(result).toMatchObject({
      orderId,
      status: 'OPEN',
      candidateCount: 1,
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString()
    });
    expect(dispatchStore.attempts).toHaveLength(1);
    expect(dispatchStore.candidates).toEqual<DispatchCandidateRecord[]>([
      expect.objectContaining({
        dispatchAttemptId: result.dispatchAttemptId,
        playerUserId: eligiblePlayerUserId,
        status: 'NOTIFIED',
        notifiedAt: now.toISOString()
      })
    ]);
    expect(dispatchStore.outboxJobs.map((job) => job.type)).toEqual(['DISPATCH_MESSAGE', 'DISPATCH_TIMEOUT']);
    expect(dispatchStore.outboxJobs[0]).toMatchObject({
      type: 'DISPATCH_MESSAGE',
      aggregateType: 'dispatch_attempt',
      aggregateId: result.dispatchAttemptId,
      runAfter: now.toISOString(),
      payload: expect.objectContaining({ game: '瓦洛兰特', service: '娱乐陪玩', region: '北美' })
    });
    expect(dispatchStore.outboxJobs[1]).toMatchObject({
      type: 'DISPATCH_TIMEOUT',
      aggregateType: 'dispatch_attempt',
      aggregateId: result.dispatchAttemptId,
      runAfter: result.expiresAt
    });
  });

  test('dispatchOrder does not publish an actionable offer when no player is eligible', async () => {
    const dispatchStore = new InMemoryDispatchStore();
    const result = await dispatchOrder({
      orderStore: new InMemoryOrderStore({ orders: [pendingDispatchOrder()] }),
      dispatchStore,
      playerPool: new InMemoryDispatchPlayerPool({ profiles: [] }),
      orderId,
      expectedVersion: 3,
      trigger: 'ORDER_SUBMITTED',
      dispatchChannelId: '777777777777777777',
      idempotencyKey: 'system:dispatch:empty:P-2001',
      now
    });

    expect(result.candidateCount).toBe(0);
    expect(dispatchStore.outboxJobs.map((job) => job.type)).toEqual(['DISPATCH_MESSAGE', 'DISPATCH_TIMEOUT']);
    expect(dispatchStore.outboxJobs[0]?.payload).toMatchObject({ candidatePlayerUserIds: [] });
  });

  test('dispatch API accepts only system-job actor and returns candidate count from unified API', async () => {
    const auditSink = new InMemoryAuditSink();
    const server = buildApiServer({
      env,
      security: { auditSink, idempotencyStore: new InMemoryIdempotencyStore() }
    });
    const dispatchStore = new InMemoryDispatchStore();
    registerDispatchRoutes(server, {
      orderStore: new InMemoryOrderStore({ orders: [pendingDispatchOrder()] }),
      dispatchStore,
      playerPool: new InMemoryDispatchPlayerPool({ profiles: [player()] }),
      dispatchChannelId: '777777777777777777',
      now: () => now
    });

    const rejectedBotCall = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/dispatch`,
      headers: {
        authorization: 'Bearer valid-bot-token',
        'x-client-source': 'DISCORD_BOT',
        'x-actor-guild-id': guildId,
        'x-actor-discord-user-id': '222222222222222222',
        'idempotency-key': 'system:dispatch:wrong-source'
      },
      payload: { expectedVersion: 3, trigger: 'ORDER_SUBMITTED' }
    });
    const acceptedSystemCall = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/dispatch`,
      headers: {
        authorization: 'Bearer valid-bot-token',
        'x-client-source': 'SYSTEM_JOB',
        'idempotency-key': 'system:dispatch:order:P-2001'
      },
      payload: { expectedVersion: 3, trigger: 'ORDER_SUBMITTED' }
    });

    expect(rejectedBotCall.statusCode).toBe(403);
    expect(acceptedSystemCall.statusCode).toBe(200);
    expect(acceptedSystemCall.json()).toMatchObject({
      data: { orderId, status: 'OPEN', candidateCount: 1 }
    });
    expect(auditSink.records.at(-1)).toMatchObject({
      actorSource: 'SYSTEM_JOB',
      permissionCode: 'dispatch.execute',
      outcome: 'SUCCEEDED'
    });
  });

  test('runtime leaves legacy dispatch tables as history without wiring stores or first-wins routes', async () => {
    const serverSource = await readFile('apps/api/src/server.ts', 'utf8');
    const entrySource = await readFile('apps/api/src/index.ts', 'utf8');

    expect(serverSource).not.toContain('registerDispatchRoutes(server');
    expect(serverSource).toContain('Legacy first-wins tables remain migration/history facts only');
    expect(serverSource).not.toContain('dispatch?:');
    expect(entrySource).not.toMatch(/PostgresDispatchStore|PostgresDispatchPlayerPool|dispatchStore|dispatchPlayerPool/);
  });

  test('dispatch timeout marks only the current attempt timed out and keeps order pending dispatch', async () => {
    const orderStore = new InMemoryOrderStore({ orders: [pendingDispatchOrder()] });
    const dispatchStore = new InMemoryDispatchStore();
    const created = await dispatchOrder({
      orderStore,
      dispatchStore,
      playerPool: new InMemoryDispatchPlayerPool({ profiles: [player()] }),
      orderId,
      expectedVersion: 3,
      trigger: 'ORDER_SUBMITTED',
      dispatchChannelId: '777777777777777777',
      idempotencyKey: 'system:dispatch:order:P-2001',
      now
    });

    const expired = await expireDispatchAttempt({
      orderStore,
      dispatchStore,
      dispatchAttemptId: created.dispatchAttemptId,
      now: new Date(now.getTime() + 5 * 60_000)
    });

    expect(expired).toMatchObject({
      status: 'DISPATCH_TIMEOUT',
      orderId,
      orderStatus: 'PENDING_DISPATCH'
    });
    expect(dispatchStore.attempts[0]).toMatchObject({ status: 'TIMED_OUT' });
    expect(dispatchStore.candidates[0]).toMatchObject({ status: 'EXPIRED' });
    expect((await orderStore.findById(orderId))?.status).toBe('PENDING_DISPATCH');
  });
});
