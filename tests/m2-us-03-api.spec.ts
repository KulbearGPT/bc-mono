import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import {
  InMemoryDispatchPlayerPool,
  InMemoryDispatchStore,
  acceptOrder,
  declineOrderOffer,
  dispatchOrder,
  registerDispatchRoutes
} from '@blackcat/api/dispatch';
import { InMemoryOrderStore, type OrderRecord } from '@blackcat/api/orders';
import type { PlayerProfileRecord } from '@blackcat/api/players';

const now = new Date('2026-07-18T02:00:00.000Z');
const guildId = '999999999999999999';
const orderId = '00000000-0000-0000-0000-00000000b301';
const playerAUserId = '00000000-0000-0000-0000-00000000a401';
const playerBUserId = '00000000-0000-0000-0000-00000000a402';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: orderId,
    publicId: 'P-3001',
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
    playerId: '00000000-0000-0000-0000-00000000c401',
    userId: playerAUserId,
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

async function buildDispatchFixture(players = [player(), player({
  playerId: '00000000-0000-0000-0000-00000000c402',
  userId: playerBUserId,
  discordUserId: '222222222222222223'
})]) {
  const orderStore = new InMemoryOrderStore({ orders: [order()] });
  const dispatchStore = new InMemoryDispatchStore();
  const playerPool = new InMemoryDispatchPlayerPool({ profiles: players });
  const dispatch = await dispatchOrder({
    orderStore,
    dispatchStore,
    playerPool,
    orderId,
    expectedVersion: 3,
    trigger: 'ORDER_SUBMITTED',
    dispatchChannelId: '777777777777777777',
    idempotencyKey: 'system:dispatch:order:P-3001',
    now
  });
  return { orderStore, dispatchStore, playerPool, dispatch };
}

describe('M2-US-03 accept order domain and API', () => {
  test('acceptOrder atomically assigns the first eligible candidate and emits channel sync outbox', async () => {
    const { orderStore, dispatchStore, playerPool, dispatch } = await buildDispatchFixture();

    const result = await acceptOrder({
      orderStore,
      dispatchStore,
      playerPool,
      orderId,
      expectedVersion: 3,
      dispatchAttemptId: dispatch.dispatchAttemptId,
      actor: { guildId, discordUserId: '222222222222222222' },
      idempotencyKey: 'discord:dispatch:accept:one',
      now
    });

    expect(result).toMatchObject({
      id: orderId,
      status: 'ACCEPTED',
      version: 4,
      playerId: playerAUserId
    });
    expect(await orderStore.findById(orderId)).toMatchObject({
      status: 'ACCEPTED',
      playerId: playerAUserId,
      version: 4
    });
    expect(dispatchStore.attempts[0]).toMatchObject({
      status: 'ACCEPTED',
      acceptedPlayerId: playerAUserId
    });
    expect(dispatchStore.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerUserId: playerAUserId, status: 'ACCEPTED' }),
        expect.objectContaining({ playerUserId: playerBUserId, status: 'LOST_RACE' })
      ])
    );
    expect(dispatchStore.outboxJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'PANEL_SYNC',
          aggregateType: 'order',
          aggregateId: orderId,
          payload: expect.objectContaining({
            kind: 'ORDER_ACCEPTED_CHANNEL_SYNC',
            acceptedPlayerUserId: playerAUserId,
            channelId: '444444444444444444'
          })
        })
      ])
    );
  });

  test('second candidate loses the race and active-order players are not eligible', async () => {
    const { orderStore, dispatchStore, playerPool, dispatch } = await buildDispatchFixture();

    await acceptOrder({
      orderStore,
      dispatchStore,
      playerPool,
      orderId,
      expectedVersion: 3,
      dispatchAttemptId: dispatch.dispatchAttemptId,
      actor: { guildId, discordUserId: '222222222222222222' },
      idempotencyKey: 'discord:dispatch:accept:first',
      now
    });
    await expect(
      acceptOrder({
        orderStore,
        dispatchStore,
        playerPool,
        orderId,
        expectedVersion: 3,
        dispatchAttemptId: dispatch.dispatchAttemptId,
        actor: { guildId, discordUserId: '222222222222222223' },
        idempotencyKey: 'discord:dispatch:accept:second',
        now
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'CONFLICT' }));

    const busyFixture = await buildDispatchFixture([
      player({ activeOrderId: '00000000-0000-0000-0000-00000000b999' })
    ]);
    await expect(
      acceptOrder({
        orderStore: busyFixture.orderStore,
        dispatchStore: busyFixture.dispatchStore,
        playerPool: busyFixture.playerPool,
        orderId,
        expectedVersion: 3,
        dispatchAttemptId: busyFixture.dispatch.dispatchAttemptId,
        actor: { guildId, discordUserId: '222222222222222222' },
        idempotencyKey: 'discord:dispatch:accept:busy-player',
        now
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'PLAYER_NOT_ELIGIBLE' }));
  });

  test('declineOrderOffer marks only the current player candidate and leaves order pending dispatch', async () => {
    const { orderStore, dispatchStore, playerPool, dispatch } = await buildDispatchFixture();

    const result = await declineOrderOffer({
      orderStore,
      dispatchStore,
      playerPool,
      orderId,
      expectedVersion: 3,
      actor: { guildId, discordUserId: '222222222222222222' },
      now
    });

    expect(result).toMatchObject({ id: orderId, status: 'PENDING_DISPATCH', version: 3 });
    expect(dispatchStore.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerUserId: playerAUserId, status: 'DECLINED' }),
        expect.objectContaining({ playerUserId: playerBUserId, status: 'NOTIFIED' })
      ])
    );
  });

  test('accept route derives player from Discord actor and rejects non-candidate actors', async () => {
    const auditSink = new InMemoryAuditSink();
    const { orderStore, dispatchStore, playerPool, dispatch } = await buildDispatchFixture();
    const server = buildApiServer({
      env,
      security: { auditSink, idempotencyStore: new InMemoryIdempotencyStore() }
    });
    registerDispatchRoutes(server, {
      orderStore,
      dispatchStore,
      playerPool,
      dispatchChannelId: '777777777777777777',
      now: () => now
    });

    const rejected = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/accept`,
      headers: botHeaders('222222222222222299', 'discord:dispatch:accept:not-candidate'),
      payload: { expectedVersion: 3, dispatchAttemptId: dispatch.dispatchAttemptId }
    });
    const accepted = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/accept`,
      headers: botHeaders('222222222222222222', 'discord:dispatch:accept:candidate'),
      payload: { expectedVersion: 3, dispatchAttemptId: dispatch.dispatchAttemptId }
    });

    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({ error: { code: 'PLAYER_NOT_ELIGIBLE' } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ data: { id: orderId, status: 'ACCEPTED', playerId: playerAUserId } });
    expect(auditSink.records.at(-1)).toMatchObject({
      permissionCode: 'order.accept',
      outcome: 'SUCCEEDED'
    });
  });
});

function botHeaders(discordUserId: string, idempotencyKey: string) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-guild-id': guildId,
    'x-actor-discord-user-id': discordUserId,
    'x-discord-interaction-id': '888888888888888888',
    'idempotency-key': idempotencyKey
  };
}
