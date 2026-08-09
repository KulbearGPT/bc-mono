import { describe, expect, test } from 'vitest';
import {
  InMemoryServiceLifecycleStore,
  confirmOrder,
  setOrderReadiness,
  type ServiceLifecycleOrderRecord
} from '@blackcat/api/service-lifecycle';

const guildId = '999999999999999999';
const orderId = '00000000-0000-0000-0000-000000420001';
const customerId = '00000000-0000-0000-0000-000000420002';
const playerA = '00000000-0000-0000-0000-000000420003';
const playerB = '00000000-0000-0000-0000-000000420004';
const now = new Date('2026-08-13T08:00:00.000Z');

describe('API review player-only readiness runtime', () => {
  test('starts from participant facts without fabricating a customer readiness timestamp', async () => {
    const store = buildStore();
    await ready(store, playerA, '222222222222222222', 4, now);
    const started = await ready(store, playerB, '333333333333333333', 5, new Date(now.getTime() + 1_000));
    expect(started).toMatchObject({ status: 'IN_SERVICE', readiness: { allActivePlayersReady: true } });
    expect(store.getOrder(orderId)).toMatchObject({
      customerReadyAt: null,
      playerReadyAt: new Date(now.getTime() + 1_000).toISOString()
    });
  });

  test('fails closed when a legacy order has no active participant facts', async () => {
    const order = record({ participants: [] });
    const store = new InMemoryServiceLifecycleStore({ orders: [order], discordAccounts: accounts() });
    await expect(ready(store, playerA, '222222222222222222', 4, now)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    });
    expect(store.getOrder(orderId)).toMatchObject({
      status: 'ACCEPTED',
      version: 4,
      customerReadyAt: null,
      playerReadyAt: null
    });
  });

  test('does not capture money or create earnings when completion has no active participant facts', async () => {
    const store = new InMemoryServiceLifecycleStore({
      orders: [
        record({
          status: 'PENDING_CONFIRMATION',
          version: 8,
          participants: [],
          serviceStartedAt: now.toISOString(),
          completionRequestedAt: now.toISOString(),
          confirmationDueAt: new Date(now.getTime() + 1_800_000).toISOString()
        })
      ],
      discordAccounts: accounts()
    });
    await expect(
      confirmOrder({
        store,
        orderId,
        expectedVersion: 8,
        confirmation: 'CONFIRM_COMPLETED',
        actor: { guildId, discordUserId: '111111111111111111' },
        idempotencyKey: 'readiness:no-participants',
        now
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(store.getOrder(orderId)).toMatchObject({ status: 'PENDING_CONFIRMATION', version: 8 });
    expect(store.consumptionEntries).toEqual([]);
    expect(store.playerEarnings).toEqual([]);
  });
});

function ready(
  store: InMemoryServiceLifecycleStore,
  playerId: string,
  discordUserId: string,
  expectedVersion: number,
  at: Date
) {
  return setOrderReadiness({
    store,
    orderId,
    expectedVersion,
    readiness: 'READY',
    actor: { guildId, discordUserId },
    now: at
  });
}

function buildStore() {
  return new InMemoryServiceLifecycleStore({ orders: [record()], discordAccounts: accounts() });
}
function accounts() {
  return [
    { guildId, discordUserId: '111111111111111111', userId: customerId },
    { guildId, discordUserId: '222222222222222222', userId: playerA },
    { guildId, discordUserId: '333333333333333333', userId: playerB }
  ];
}
function record(overrides: Partial<ServiceLifecycleOrderRecord> = {}): ServiceLifecycleOrderRecord {
  return {
    id: orderId,
    publicId: 'P-READY-RUNTIME',
    customerId,
    guildId,
    playerId: playerA,
    status: 'ACCEPTED',
    version: 4,
    currency: 'CAT',
    amountMinor: 200,
    playerEarningMinor: 120,
    channelId: '444444444444444444',
    panelMessageId: '555555555555555555',
    voiceChannelId: null,
    readinessDueAt: new Date(now.getTime() + 600_000).toISOString(),
    customerReadyAt: null,
    playerReadyAt: null,
    serviceStartedAt: null,
    completionRequestedAt: null,
    confirmationDueAt: null,
    updatedAt: now.toISOString(),
    participants: [
      participant('00000000-0000-0000-0000-000000420011', playerA, '陪玩 A'),
      participant('00000000-0000-0000-0000-000000420012', playerB, '陪玩 B')
    ],
    ...overrides
  };
}
function participant(id: string, playerId: string, displayName: string) {
  return {
    id,
    playerId,
    displayName,
    readyAt: null,
    unitCount: 1,
    expectedEarningMinor: 60,
    customerUnitPriceMinor: 100,
    linePriceMinor: 100,
    version: 1
  };
}
