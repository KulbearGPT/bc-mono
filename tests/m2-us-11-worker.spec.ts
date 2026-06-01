import { describe, expect, test } from 'vitest';
import { InMemoryOrderStore, type OrderRecord } from '@blackcat/api/orders';
import { dispatchOrder, expireDispatchAttempt, InMemoryDispatchStore, type DispatchPlayerPool } from '@blackcat/api/dispatch';
import { expireOrderReadiness, InMemoryServiceLifecycleStore, type ServiceLifecycleOrderRecord } from '@blackcat/api/service-lifecycle';

const now = new Date('2026-07-18T09:30:00.000Z');
const orderId = '00000000-0000-0000-0000-00000000b611';

describe('M2-US-11 paused automation worker gates', () => {
  test('skips dispatch creation and timeout mutation while the latest order is paused', async () => {
    const orderStore = new InMemoryOrderStore({ orders: [order()] });
    const dispatchStore = new InMemoryDispatchStore();
    const playerPool: DispatchPlayerPool = { listProfiles: () => [] };

    await expect(dispatchOrder({
      orderStore, dispatchStore, playerPool, orderId, expectedVersion: 4, trigger: 'MANUAL_RETRY',
      dispatchChannelId: '777777777777777777', idempotencyKey: 'dispatch:paused:P-611', now
    })).rejects.toThrowError(expect.objectContaining({ code: 'AUTOMATION_PAUSED' }));
    expect(dispatchStore.attempts).toHaveLength(0);

    dispatchStore.attempts.push({
      id: '00000000-0000-0000-0000-00000000d611', orderId, round: 1, status: 'ACTIVE',
      dispatchChannelId: '777777777777777777', dispatchMessageId: null,
      candidateCriteria: { game: 'VALORANT', service: 'ENTERTAINMENT', guildId: null, trigger: 'ORDER_SUBMITTED' },
      acceptedPlayerId: null, startedAt: '2026-07-18T09:20:00.000Z', expiresAt: '2026-07-18T09:25:00.000Z',
      acceptedAt: null, finishedAt: null, createdAt: '2026-07-18T09:20:00.000Z', updatedAt: '2026-07-18T09:20:00.000Z'
    });
    const timeout = await expireDispatchAttempt({ orderStore, dispatchStore, dispatchAttemptId: dispatchStore.attempts[0]!.id, now });
    expect(timeout).toMatchObject({ status: 'AUTOMATION_PAUSED', orderStatus: 'PENDING_DISPATCH' });
    expect(dispatchStore.attempts[0]).toMatchObject({ status: 'ACTIVE' });
  });

  test('skips readiness timeout escalation while lifecycle automation is paused', async () => {
    const store = new InMemoryServiceLifecycleStore({ orders: [lifecycleOrder()], discordAccounts: [] });
    const result = await expireOrderReadiness({ store, orderId, now });

    expect(result).toMatchObject({ outcome: 'SKIPPED', status: 'ACCEPTED', version: 4, staffTask: null });
    expect(store.staffTasks).toHaveLength(0);
    expect(store.orders[0]).toMatchObject({ version: 4 });
  });

  test('does not block dispatch when only lifecycle automation is paused', async () => {
    const scoped = { ...order(), automationScope: 'LIFECYCLE' as const };
    const orderStore = new InMemoryOrderStore({ orders: [scoped] });
    const dispatchStore = new InMemoryDispatchStore();
    const result = await dispatchOrder({
      orderStore, dispatchStore, playerPool: { listProfiles: () => [] }, orderId, expectedVersion: 4,
      trigger: 'MANUAL_RETRY', dispatchChannelId: '777777777777777777', idempotencyKey: 'dispatch:lifecycle-scope:P-611', now
    });
    expect(result.status).toBe('OPEN');
    expect(dispatchStore.attempts).toHaveLength(1);
  });
});

function order(): OrderRecord {
  return {
    id: orderId, publicId: 'P-611', customerId: '00000000-0000-0000-0000-00000000a611', playerId: null,
    status: 'PENDING_DISPATCH', version: 4, serviceCatalogId: null, catalogVersion: null, game: 'VALORANT', service: 'ENTERTAINMENT',
    region: 'NA', billingUnitMinutes: 60, unitCount: 2, customerUnitPriceMinor: 6000, playerUnitPayoutMinor: 4200,
    amountMinor: 12000, playerEarningMinor: 8400, currency: 'CAT', notes: null,
    channelSpec: { channelId: '444444444444444444', panelMessageId: '555555555555555555', voiceChannelId: null },
    automationState: 'PAUSED', automationVersion: 2, automationPausedByStaffId: '00000000-0000-0000-0000-000000000611',
    automationStaffTaskId: '00000000-0000-0000-0000-00000000c611', automationReasonCode: 'STAFF_TAKEOVER',
    automationScope: 'ALL', automationPausedAt: '2026-07-18T09:00:00.000Z', automationResumedAt: null,
    automationExpiresAt: '2026-07-18T10:00:00.000Z', createdAt: '2026-07-18T08:00:00.000Z', updatedAt: '2026-07-18T09:00:00.000Z'
  };
}

function lifecycleOrder(): ServiceLifecycleOrderRecord {
  return {
    id: orderId, publicId: 'P-611', customerId: '00000000-0000-0000-0000-00000000a611',
    playerId: '00000000-0000-0000-0000-00000000a612', status: 'ACCEPTED', version: 4,
    currency: 'CAT', amountMinor: 12000, playerEarningMinor: 8400,
    channelId: '444444444444444444', panelMessageId: '555555555555555555', voiceChannelId: null,
    readinessDueAt: '2026-07-18T09:10:00.000Z', customerReadyAt: null, playerReadyAt: null,
    serviceStartedAt: null, completionRequestedAt: null, confirmationDueAt: null,
    automationState: 'PAUSED', updatedAt: '2026-07-18T09:00:00.000Z'
  };
}
