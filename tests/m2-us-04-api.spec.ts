import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import { createPilotFeaturePolicy } from '@blackcat/api/pilot-features';
import {
  InMemoryServiceLifecycleStore,
  ServiceLifecycleError,
  confirmOrder,
  expireOrderCompletionConfirmation,
  registerServiceLifecycleRoutes,
  requestOrderCompletion,
  rejectLegacyStartService,
  setOrderReadiness,
  type ServiceLifecycleOrderRecord
} from '@blackcat/api/service-lifecycle';

const now = new Date('2026-07-18T04:00:00.000Z');
const guildId = '999999999999999999';
const orderId = '00000000-0000-0000-0000-00000000b401';
const customerId = '00000000-0000-0000-0000-00000000a501';
const playerId = '00000000-0000-0000-0000-00000000a502';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};

describe('M2-US-04 service lifecycle API', () => {
  test('setOrderReadiness requires a current participant and starts service only after both sides are ready', async () => {
    const store = buildStore();

    const customerReady = await setOrderReadiness({
      store,
      orderId,
      expectedVersion: 4,
      readiness: 'READY',
      actor: { guildId, discordUserId: '111111111111111111' },
      now
    });

    expect(customerReady).toMatchObject({
      orderId,
      status: 'ACCEPTED',
      version: 5,
      actorRole: 'CUSTOMER',
      readiness: {
        customer: 'READY',
        player: 'NOT_READY',
        bothReady: false,
        startedAt: null
      }
    });

    await expect(
      setOrderReadiness({
        store,
        orderId,
        expectedVersion: 5,
        readiness: 'READY',
        actor: { guildId, discordUserId: '222222222222222299' },
        now
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));

    const playerReady = await setOrderReadiness({
      store,
      orderId,
      expectedVersion: 5,
      readiness: 'READY',
      actor: { guildId, discordUserId: '222222222222222222' },
      now: new Date(now.getTime() + 60_000)
    });

    expect(playerReady).toMatchObject({
      orderId,
      status: 'IN_SERVICE',
      version: 6,
      actorRole: 'PLAYER',
      readiness: {
        customer: 'READY',
        player: 'READY',
        bothReady: true,
        startedAt: new Date(now.getTime() + 60_000).toISOString()
      }
    });
    expect(store.orders[0]).toMatchObject({
      status: 'IN_SERVICE',
      version: 6,
      customerReadyAt: now.toISOString(),
      playerReadyAt: new Date(now.getTime() + 60_000).toISOString(),
      serviceStartedAt: new Date(now.getTime() + 60_000).toISOString()
    });
  });

  test('readiness route derives actor role from Discord context and records denied attempts', async () => {
    const auditSink = new InMemoryAuditSink();
    const store = buildStore();
    const server = buildApiServer({
      env,
      security: {
        auditSink,
        idempotencyStore: new InMemoryIdempotencyStore(),
        pilotFeaturePolicy: createPilotFeaturePolicy('CORE_ORDER')
      }
    });
    registerServiceLifecycleRoutes(server, { store, now: () => now });

    const denied = await server.inject({
      method: 'PUT',
      url: `/api/v1/orders/${orderId}/readiness`,
      headers: botHeaders('222222222222222299', 'discord:order:ready:denied'),
      payload: { expectedVersion: 4, readiness: 'READY' }
    });
    const accepted = await server.inject({
      method: 'PUT',
      url: `/api/v1/orders/${orderId}/readiness`,
      headers: botHeaders('111111111111111111', 'discord:order:ready:customer'),
      payload: { expectedVersion: 4, readiness: 'READY' }
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      data: {
        orderId,
        status: 'ACCEPTED',
        actorRole: 'CUSTOMER',
        enabledFeatures: ['CORE_ORDER'],
        readiness: { customer: 'READY', player: 'NOT_READY', bothReady: false }
      }
    });
    expect(auditSink.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          permissionCode: 'order.readiness.confirm',
          outcome: 'FAILED',
          reason: 'PERMISSION_DENIED'
        }),
        expect.objectContaining({
          permissionCode: 'order.readiness.confirm',
          outcome: 'SUCCEEDED'
        })
      ])
    );
  });

  test('buildApiServer can wire service lifecycle routes from runtime options', async () => {
    const store = buildStore();
    const server = buildApiServer({
      env,
      security: { auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() },
      serviceLifecycle: { store, now: () => now }
    });

    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/orders/${orderId}/readiness`,
      headers: botHeaders('111111111111111111', 'discord:order:ready:runtime'),
      payload: { expectedVersion: 4, readiness: 'READY' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { orderId, actorRole: 'CUSTOMER' } });
  });

  test('assigned player can request completion only after service has started', async () => {
    const store = buildStore({
      status: 'IN_SERVICE',
      version: 6,
      customerReadyAt: now.toISOString(),
      playerReadyAt: now.toISOString(),
      serviceStartedAt: now.toISOString()
    });

    const result = await requestOrderCompletion({
      store,
      orderId,
      expectedVersion: 6,
      actor: { guildId, discordUserId: '222222222222222222' },
      now
    });

    expect(result).toMatchObject({
      orderId,
      status: 'PENDING_CONFIRMATION',
      version: 7,
      actorRole: 'PLAYER',
      confirmationDueAt: new Date(now.getTime() + 30 * 60_000).toISOString()
    });
    expect(store.orders[0]).toMatchObject({
      status: 'PENDING_CONFIRMATION',
      version: 7,
      completionRequestedAt: now.toISOString(),
      confirmationDueAt: new Date(now.getTime() + 30 * 60_000).toISOString()
    });
  });

  test('customer confirm completion records consumption, player earning and eligible referral commission facts', async () => {
    const store = buildStore(
      {
        status: 'PENDING_CONFIRMATION',
        version: 7,
        customerReadyAt: now.toISOString(),
        playerReadyAt: now.toISOString(),
        serviceStartedAt: now.toISOString(),
        completionRequestedAt: now.toISOString(),
        confirmationDueAt: new Date(now.getTime() + 30 * 60_000).toISOString()
      },
      {
        referralAttributions: [
          {
            id: '00000000-0000-0000-0000-00000000r501',
            beneficiaryUserId: '00000000-0000-0000-0000-00000000a503',
            referredUserId: customerId,
            programType: 'PLAYER_LIFETIME',
            programVersion: 1,
            awardMode: 'NET_SPEND_BPS',
            fixedAmountMinor: null,
            rateBps: 200,
            currency: 'CNY',
            eligibleOrderSpend: true
          }
        ]
      }
    );
    const server = buildApiServer({
      env,
      security: { auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() },
      serviceLifecycle: { store, now: () => now }
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/confirm`,
      headers: botHeaders('111111111111111111', 'discord:order:confirm:customer'),
      payload: { expectedVersion: 7, confirmation: 'CONFIRM_COMPLETED' }
    });
    const direct = await confirmOrder({
      store: buildStore({
        status: 'PENDING_CONFIRMATION',
        version: 7,
        customerReadyAt: now.toISOString(),
        playerReadyAt: now.toISOString(),
        serviceStartedAt: now.toISOString(),
        completionRequestedAt: now.toISOString(),
        confirmationDueAt: new Date(now.getTime() + 30 * 60_000).toISOString()
      }),
      orderId,
      expectedVersion: 7,
      confirmation: 'CONFIRM_COMPLETED',
      actor: { guildId, discordUserId: '111111111111111111' },
      idempotencyKey: 'discord:order:confirm:direct',
      now
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { orderId, status: 'COMPLETED', version: 8, capturedMinor: 12000, playerEarningMinor: 8400 }
    });
    expect(store.consumptionEntries).toEqual([expect.objectContaining({ orderId, amountMinor: 12000 })]);
    expect(store.playerEarnings).toEqual([expect.objectContaining({ orderId, playerUserId: playerId, amountMinor: 8400 })]);
    expect(store.commissions).toEqual([
      expect.objectContaining({
        orderId,
        beneficiaryUserId: '00000000-0000-0000-0000-00000000a503',
        amountMinor: 240,
        status: 'PENDING'
      })
    ]);
    expect(direct).toMatchObject({ orderId, status: 'COMPLETED', version: 8 });
  });

  test('CORE_ORDER confirmation creates core settlement facts without referral commission', async () => {
    const store = buildStore(
      {
        status: 'PENDING_CONFIRMATION',
        version: 7,
        customerReadyAt: now.toISOString(),
        playerReadyAt: now.toISOString(),
        serviceStartedAt: now.toISOString(),
        completionRequestedAt: now.toISOString(),
        confirmationDueAt: new Date(now.getTime() + 30 * 60_000).toISOString()
      },
      {
        referralAttributions: [{
          id: '00000000-0000-0000-0000-00000000r502',
          beneficiaryUserId: '00000000-0000-0000-0000-00000000a503',
          referredUserId: customerId,
          programType: 'PLAYER_LIFETIME',
          programVersion: 1,
          awardMode: 'NET_SPEND_BPS',
          fixedAmountMinor: null,
          rateBps: 200,
          currency: 'CNY',
          eligibleOrderSpend: true
        }]
      }
    );
    const server = buildApiServer({
      env,
      security: {
        auditSink: new InMemoryAuditSink(),
        idempotencyStore: new InMemoryIdempotencyStore(),
        pilotFeaturePolicy: createPilotFeaturePolicy('CORE_ORDER')
      },
      serviceLifecycle: { store, now: () => now }
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/confirm`,
      headers: botHeaders('111111111111111111', 'discord:order:confirm:core-no-referral'),
      payload: { expectedVersion: 7, confirmation: 'CONFIRM_COMPLETED' }
    });

    expect(response.statusCode).toBe(200);
    expect(store.consumptionEntries).toHaveLength(1);
    expect(store.playerEarnings).toHaveLength(1);
    expect(store.commissions).toHaveLength(0);
  });

  test('same-key confirmation retries a pending local convergence instead of replaying the cached error', async () => {
    const store = buildStore({
      status: 'PENDING_CONFIRMATION',
      version: 7,
      customerReadyAt: now.toISOString(),
      playerReadyAt: now.toISOString(),
      serviceStartedAt: now.toISOString(),
      completionRequestedAt: now.toISOString(),
      confirmationDueAt: new Date(now.getTime() + 30 * 60_000).toISOString()
    });
    const commit = store.commitOrderConfirmation.bind(store);
    let attempts = 0;
    store.commitOrderConfirmation = (input) => {
      attempts += 1;
      if (attempts === 1) {
        throw new ServiceLifecycleError(
          'PROVIDER_UNAVAILABLE',
          'Provider capture succeeded but local convergence is pending.',
          {
            retryable: true,
            idempotencyFailureCode: 'PROVIDER_CONVERGENCE_PENDING'
          }
        );
      }
      return commit(input);
    };
    const server = buildApiServer({
      env,
      security: { auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() },
      serviceLifecycle: { store, now: () => now }
    });
    const request = {
      method: 'POST' as const,
      url: `/api/v1/orders/${orderId}/confirm`,
      headers: botHeaders('111111111111111111', 'discord:order:confirm:provider-recovery'),
      payload: { expectedVersion: 7, confirmation: 'CONFIRM_COMPLETED' }
    };

    const unresolved = await server.inject(request);
    const recovered = await server.inject(request);

    expect(unresolved.statusCode).toBe(503);
    expect(unresolved.json()).toMatchObject({
      error: { code: 'PROVIDER_UNAVAILABLE', retryable: true }
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ data: { orderId, status: 'COMPLETED' } });
    expect(attempts).toBe(2);
  });

  test('completion confirmation timeout creates exactly one staff review task without settling money', async () => {
    const dueAt = new Date(now.getTime() - 1_000).toISOString();
    const store = buildStore({
      status: 'PENDING_CONFIRMATION',
      version: 7,
      customerReadyAt: now.toISOString(),
      playerReadyAt: now.toISOString(),
      serviceStartedAt: now.toISOString(),
      completionRequestedAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
      confirmationDueAt: dueAt
    });

    const first = await expireOrderCompletionConfirmation({ store, orderId, now });
    const replay = await expireOrderCompletionConfirmation({ store, orderId, now: new Date(now.getTime() + 1_000) });

    expect(first).toMatchObject({
      orderId,
      status: 'PENDING_CONFIRMATION',
      version: 7,
      staffTask: {
        type: 'COMPLETION_REVIEW',
        reasonCode: 'COMPLETION_CONFIRMATION_TIMEOUT',
        status: 'OPEN'
      }
    });
    expect(replay.staffTask.id).toBe(first.staffTask.id);
    expect(store.staffTasks).toHaveLength(1);
    expect(store.consumptionEntries).toHaveLength(0);
    expect(store.playerEarnings).toHaveLength(0);
  });

  test('legacy single-party start endpoint is rejected and audited', async () => {
    const auditSink = new InMemoryAuditSink();
    const store = buildStore();
    const server = buildApiServer({
      env,
      security: { auditSink, idempotencyStore: new InMemoryIdempotencyStore() }
    });
    registerServiceLifecycleRoutes(server, { store, now: () => now });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/start`,
      headers: botHeaders('222222222222222222', 'discord:order:legacy-start:player'),
      payload: { expectedVersion: 4 }
    });

    await expect(
      rejectLegacyStartService({
        store,
        orderId,
        actor: { guildId, discordUserId: '222222222222222222' }
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
    expect(auditSink.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'REJECT_LEGACY_START_SERVICE',
          permissionCode: 'order.legacy_start.reject',
          outcome: 'FAILED',
          reason: 'PERMISSION_DENIED'
        })
      ])
    );
  });
});

function buildStore(
  overrides: Partial<ServiceLifecycleOrderRecord> = {},
  options: {
    referralAttributions?: Array<{
      id: string;
      beneficiaryUserId: string;
      referredUserId: string;
      programType: 'PROMOTER_FIRST_PURCHASE' | 'PLAYER_LIFETIME';
      programVersion: number;
      awardMode: 'FIXED_MINOR' | 'NET_SPEND_BPS';
      fixedAmountMinor: number | null;
      rateBps: number | null;
      currency: string;
      eligibleOrderSpend: boolean;
    }>;
  } = {}
) {
  return new InMemoryServiceLifecycleStore({
    orders: [
      {
        id: orderId,
        publicId: 'P-4401',
        customerId,
        playerId,
        status: 'ACCEPTED',
        version: 4,
        currency: 'CNY',
        amountMinor: 12000,
        playerEarningMinor: 8400,
        channelId: '444444444444444444',
        panelMessageId: '555555555555555555',
        voiceChannelId: '666666666666666666',
        readinessDueAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
        customerReadyAt: null,
        playerReadyAt: null,
        serviceStartedAt: null,
        completionRequestedAt: null,
        confirmationDueAt: null,
        updatedAt: now.toISOString(),
        ...overrides
      }
    ],
    discordAccounts: [
      { guildId, discordUserId: '111111111111111111', userId: customerId },
      { guildId, discordUserId: '222222222222222222', userId: playerId },
      { guildId, discordUserId: '222222222222222299', userId: '00000000-0000-0000-0000-00000000a599' }
    ],
    referralAttributions: options.referralAttributions ?? []
  });
}

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
