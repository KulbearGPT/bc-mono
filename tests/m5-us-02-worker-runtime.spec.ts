import { describe, expect, test } from 'vitest';
import { InMemoryOutboxStore, OutboxWorker, type JobType, type OutboxJob } from '@blackcat/api/outbox';
import {
  ProductionOutboxRuntime,
  createPanelSyncHandler,
  createProductionHandlerMap,
  productionJobTypes
} from '@blackcat/api/worker-runtime';
import {
  createChannelArchiveHandler,
  createDispatchMessageHandler,
  createDispatchTimeoutHandler,
  createReadinessTimeoutHandler,
  createRoleReconciliationHandler
} from '@blackcat/api/worker-handlers';

const now = new Date('2026-07-18T23:00:00.000Z');

describe('M5-US-02 production Worker runtime', () => {
  test('registers every production delivery job type', () => {
    const handler = async () => undefined;
    const handlers = createProductionHandlerMap({
      giftAnnouncement: handler,
      giftExpiry: handler,
      dispatchMessage: handler,
      dispatchTimeout: handler,
      readinessTimeout: handler,
      channelArchive: handler,
      panelSync: handler,
      roleReconciliation: handler
    });

    expect(Object.keys(handlers).sort()).toEqual([...productionJobTypes].sort());
  });

  test('recovers a stale processing job on startup and preserves its dedupe key', async () => {
    const job = fixtureJob({ status: 'PROCESSING', attempts: 1, lockedAt: new Date(now.getTime() - 120_000).toISOString(), lockedBy: 'dead-worker' });
    const store = new InMemoryOutboxStore({ now, jobs: [job] });
    const observed: string[] = [];
    const worker = new OutboxWorker({ store, workerId: 'worker-live', now: () => now });
    const runtime = new ProductionOutboxRuntime({
      store,
      worker,
      handlers: { GIFT_ANNOUNCEMENT: async (claimed) => observed.push(claimed.dedupeKey) },
      now: () => now,
      staleLockMs: 60_000
    });

    const recovered = await runtime.initialize();
    const completed = await runtime.runOnce();

    expect(recovered).toHaveLength(1);
    expect(observed).toEqual([job.dedupeKey]);
    expect(completed).toEqual([expect.objectContaining({ status: 'COMPLETED', attempts: 2, dedupeKey: job.dedupeKey })]);
  });

  test('renews the processing lease while a long-running handler is active', async () => {
    const baseStore = new InMemoryOutboxStore({ now, jobs: [fixtureJob()] });
    let renewals = 0;
    const store = Object.assign(baseStore, {
      renewProcessingJob: async () => { renewals += 1; }
    });
    const worker = new OutboxWorker({ store, workerId: 'worker-live', now: () => now, heartbeatMs: 5 });

    await worker.runOnce({ GIFT_ANNOUNCEMENT: async () => { await new Promise((resolve) => setTimeout(resolve, 18)); } });

    expect(renewals).toBeGreaterThan(0);
  });

  test('uses an external retry-after delay instead of the default backoff', async () => {
    const store = new InMemoryOutboxStore({ now, jobs: [fixtureJob()] });
    const worker = new OutboxWorker({ store, workerId: 'worker-live', now: () => now, backoffMs: [1_000] });
    const retryAfter = Object.assign(new Error('Discord rate limited.'), { retryAfterMs: 120_000 });

    const [failed] = await worker.runOnce({ GIFT_ANNOUNCEMENT: async () => { throw retryAfter; } });

    expect(failed).toMatchObject({ status: 'PENDING', runAfter: new Date(now.getTime() + 120_000).toISOString() });
  });

  test('rebuilds a deleted order panel from the database projection and persists the replacement message id', async () => {
    const writes: Array<{ orderId: string; expectedPanelMessageId: string; panelMessageId: string }> = [];
    const handler = createPanelSyncHandler({
      store: {
        getOrderPanelProjection: async () => ({
          orderId: 'order-1', publicId: 'P-1001', status: 'IN_SERVICE', version: 8,
          channelId: 'channel-1', panelMessageId: 'deleted-message', customerDiscordUserId: 'customer-1',
          playerDiscordUserId: 'player-1', amountMinor: 12_000, currency: 'CAT'
        }),
        replacePanelMessageId: async (input) => writes.push(input)
      },
      discord: {
        upsertOrderPanel: async (projection) => {
          expect(projection.status).toBe('IN_SERVICE');
          return { messageId: 'replacement-message', recreated: true };
        }
      }
    });

    await handler(fixtureJob({ type: 'PANEL_SYNC', aggregateType: 'order', aggregateId: 'order-1', payload: { orderId: 'order-1', kind: 'RECOVERY' } }));

    expect(writes).toEqual([{ orderId: 'order-1', expectedPanelMessageId: 'deleted-message', panelMessageId: 'replacement-message' }]);
  });

  test('reuses a persisted dispatch message id after a retry instead of creating another offer', async () => {
    let persistedMessageId: string | null = null;
    const calls: Array<string | null> = [];
    const handler = createDispatchMessageHandler({
      store: {
        getDispatchMessageId: async () => persistedMessageId,
        recordDispatchMessageId: async ({ messageId }) => { persistedMessageId = messageId; },
        replaceDispatchMessageId: async ({ messageId }) => { persistedMessageId = messageId; }
      },
      discord: {
        upsertDispatchOffer: async (_payload, existingMessageId) => {
          calls.push(existingMessageId);
          return { messageId: existingMessageId ?? 'dispatch-message-1', recreated: existingMessageId === null };
        }
      }
    });
    const job = fixtureJob({
      type: 'DISPATCH_MESSAGE', aggregateType: 'dispatch_attempt', aggregateId: 'attempt-1',
      payload: { dispatchAttemptId: 'attempt-1', dispatchChannelId: 'dispatch-channel-1', orderId: 'order-1', orderPublicId: 'P-1001', orderVersion: 3 }
    });

    await handler(job);
    await handler(job);

    expect(calls).toEqual([null, 'dispatch-message-1']);
    expect(persistedMessageId).toBe('dispatch-message-1');
  });

  test('persists a replacement id when a previously recorded dispatch message was deleted', async () => {
    const replacements: Array<{ dispatchAttemptId: string; expectedMessageId: string; messageId: string }> = [];
    const handler = createDispatchMessageHandler({
      store: {
        getDispatchMessageId: async () => 'deleted-message',
        recordDispatchMessageId: async () => undefined,
        replaceDispatchMessageId: async (input) => { replacements.push(input); }
      },
      discord: { upsertDispatchOffer: async () => ({ messageId: 'replacement-message', recreated: true }) }
    });

    await handler(fixtureJob({
      type: 'DISPATCH_MESSAGE', aggregateType: 'dispatch_attempt', aggregateId: 'attempt-1',
      payload: { dispatchAttemptId: 'attempt-1', dispatchChannelId: 'dispatch-channel-1', orderId: 'order-1', orderPublicId: 'P-1001', orderVersion: 3 }
    }));

    expect(replacements).toEqual([{
      dispatchAttemptId: 'attempt-1', expectedMessageId: 'deleted-message', messageId: 'replacement-message'
    }]);
  });

  test('routes timeout, archive, and role reconciliation jobs only from validated payloads', async () => {
    const calls: string[] = [];
    await createDispatchTimeoutHandler({ expire: async (id) => { calls.push(`dispatch:${id}`); } })(
      fixtureJob({ type: 'DISPATCH_TIMEOUT', aggregateId: 'attempt-2', payload: { dispatchAttemptId: 'attempt-2', orderId: 'order-2' } })
    );
    await createReadinessTimeoutHandler({ expire: async (job) => { calls.push(`readiness:${job.aggregateId}`); } })(
      fixtureJob({ type: 'READINESS_TIMEOUT', aggregateType: 'order', aggregateId: 'order-2', payload: { orderId: 'order-2', readinessDueAt: now.toISOString() } })
    );
    await createChannelArchiveHandler({ archive: async (channelId) => { calls.push(`archive:${channelId}`); } })(
      fixtureJob({ type: 'CHANNEL_ARCHIVE', aggregateType: 'order', aggregateId: 'order-2', payload: { orderId: 'order-2', channelId: 'channel-2' } })
    );
    await createRoleReconciliationHandler({ reconcile: async (guildId, mappingVersion, observedAt) => { calls.push(`roles:${guildId}:v${mappingVersion}:${observedAt}`); } })(
      fixtureJob({ type: 'ROLE_RECONCILIATION', aggregateType: 'discord_role_mapping', aggregateId: 'mapping-2', payload: { guildId: 'guild-2', mappingVersion: 4, targetLevel: 'L2_SUPERVISOR' } })
    );

    expect(calls).toEqual(['dispatch:attempt-2', 'readiness:order-2', 'archive:channel-2', `roles:guild-2:v4:${now.toISOString()}`]);
  });
});

function fixtureJob(overrides: Partial<OutboxJob> = {}): OutboxJob {
  return {
    id: '00000000-0000-0000-0000-000000005201', type: 'GIFT_ANNOUNCEMENT', status: 'PENDING',
    payload: {}, aggregateType: 'gift_request', aggregateId: '00000000-0000-0000-0000-000000005202',
    dedupeKey: 'gift:announcement:5202:v1', attempts: 0, maxAttempts: 8, runAfter: now.toISOString(),
    lockedAt: null, lockedBy: null, completedAt: null, lastError: null, version: 1,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), ...overrides
  };
}
