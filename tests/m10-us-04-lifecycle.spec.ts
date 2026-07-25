import { describe, expect, test } from 'vitest';
import {
  InMemoryServiceLifecycleStore,
  confirmOrder,
  requestOrderCompletion,
  setOrderReadiness,
  type ServiceLifecycleOrderRecord
} from '@blackcat/api/service-lifecycle';

const guildId = '999999999999999999';
const orderId = '00000000-0000-0000-0000-00000010b401';
const customerId = '00000000-0000-0000-0000-00000010a501';
const playerIds = [
  '00000000-0000-0000-0000-00000010a601',
  '00000000-0000-0000-0000-00000010a602',
  '00000000-0000-0000-0000-00000010a603'
];
const discordIds = ['111111111111111111', '222222222222222222', '333333333333333333'];
const now = new Date('2026-08-04T08:00:00.000Z');

describe('M10-US-04 participant lifecycle and earnings', () => {
  test('starts service only after every independently assigned player is ready', async () => {
    const store = buildStore();

    await expect(setOrderReadiness({
      store,
      orderId,
      expectedVersion: 4,
      readiness: 'READY',
      actor: { guildId, discordUserId: '999999999999999991' },
      now
    })).rejects.toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));

    const first = await ready(store, 0, 4, now);
    expect(first).toMatchObject({
      status: 'ACCEPTED',
      readiness: { allActivePlayersReady: false }
    });
    const second = await ready(store, 1, 5, new Date(now.getTime() + 1_000));
    expect(second.status).toBe('ACCEPTED');
    const third = await ready(store, 2, 6, new Date(now.getTime() + 2_000));
    expect(third).toMatchObject({
      status: 'IN_SERVICE',
      readiness: { allActivePlayersReady: true }
    });
    expect(third.readiness.participants.map((participant) => participant.readiness)).toEqual([
      'READY', 'READY', 'READY'
    ]);
  });

  test('creates one immutable earning fact per participant using that assignment snapshot', async () => {
    const store = buildStore({
      status: 'IN_SERVICE',
      version: 7,
      customerReadyAt: now.toISOString(),
      playerReadyAt: now.toISOString(),
      serviceStartedAt: now.toISOString(),
      participants: participants().map((participant) => ({ ...participant, readyAt: now.toISOString() }))
    });
    await requestOrderCompletion({
      store,
      orderId,
      expectedVersion: 7,
      actor: { guildId, discordUserId: discordIds[1]! },
      now
    });
    const completed = await confirmOrder({
      store,
      orderId,
      expectedVersion: 8,
      confirmation: 'CONFIRM_COMPLETED',
      actor: { guildId, discordUserId: '999999999999999991' },
      idempotencyKey: 'm10-us-04:complete',
      now
    });

    expect(completed.playerEarningMinor).toBe(240);
    expect(store.playerEarnings).toEqual([
      expect.objectContaining({ orderParticipantId: '00000000-0000-0000-0000-00000010c701', playerUserId: playerIds[0], amountMinor: 60 }),
      expect.objectContaining({ orderParticipantId: '00000000-0000-0000-0000-00000010c702', playerUserId: playerIds[1], amountMinor: 80 }),
      expect.objectContaining({ orderParticipantId: '00000000-0000-0000-0000-00000010c703', playerUserId: playerIds[2], amountMinor: 100 })
    ]);
  });

  test('blocks final capture when an active unready player is added during service', async () => {
    const readyParticipants = participants().map((participant) => ({ ...participant, readyAt: now.toISOString() }));
    const lateParticipant = {
      ...participants()[0]!,
      id: '00000000-0000-0000-0000-00000010c709',
      playerId: '00000000-0000-0000-0000-00000010a609',
      displayName: '后加猫',
      readyAt: null
    };
    const store = buildStore({
      status: 'PENDING_CONFIRMATION',
      version: 9,
      customerReadyAt: now.toISOString(),
      playerReadyAt: now.toISOString(),
      serviceStartedAt: now.toISOString(),
      completionRequestedAt: now.toISOString(),
      confirmationDueAt: new Date(now.getTime() + 1_800_000).toISOString(),
      participants: [...readyParticipants, lateParticipant]
    });

    await expect(confirmOrder({
      store,
      orderId,
      expectedVersion: 9,
      confirmation: 'CONFIRM_COMPLETED',
      actor: { guildId, discordUserId: '999999999999999991' },
      idempotencyKey: 'm10-us-04:unready-late-player',
      now
    })).rejects.toThrowError(expect.objectContaining({ code: 'CONFLICT' }));

    expect(store.getOrder(orderId)).toMatchObject({ status: 'PENDING_CONFIRMATION', version: 9 });
    expect(store.consumptionEntries).toEqual([]);
    expect(store.playerEarnings).toEqual([]);
  });
});

function ready(store: InMemoryServiceLifecycleStore, index: number, expectedVersion: number, at: Date) {
  return setOrderReadiness({
    store,
    orderId,
    expectedVersion,
    readiness: 'READY',
    actor: { guildId, discordUserId: discordIds[index]! },
    now: at
  });
}

function buildStore(overrides: Partial<ServiceLifecycleOrderRecord> = {}) {
  const order: ServiceLifecycleOrderRecord = {
    id: orderId,
    publicId: 'P-MULTI004',
    customerId,
    playerId: playerIds[0]!,
    status: 'ACCEPTED',
    version: 4,
    currency: 'CAT',
    amountMinor: 600,
    playerEarningMinor: 240,
    channelId: '444444444444444444',
    panelMessageId: '555555555555555555',
    voiceChannelId: null,
    readinessDueAt: new Date(now.getTime() + 300_000).toISOString(),
    customerReadyAt: null,
    playerReadyAt: null,
    serviceStartedAt: null,
    completionRequestedAt: null,
    confirmationDueAt: null,
    updatedAt: now.toISOString(),
    participants: participants(),
    ...overrides
  };
  return new InMemoryServiceLifecycleStore({
    orders: [order],
    discordAccounts: [
      { guildId, discordUserId: '999999999999999991', userId: customerId },
      ...playerIds.map((playerId, index) => ({ guildId, discordUserId: discordIds[index]!, userId: playerId }))
    ]
  });
}

function participants() {
  return playerIds.map((playerId, index) => ({
    id: `00000000-0000-0000-0000-00000010c70${index + 1}`,
    playerId,
    displayName: ['技术猫', '娱乐猫', '陪伴猫'][index]!,
    readyAt: null,
    unitCount: index + 1,
    expectedEarningMinor: [60, 80, 100][index]!,
    customerUnitPriceMinor: [100, 80, 60][index]!,
    linePriceMinor: [100, 160, 180][index]!,
    version: 1
  }));
}
