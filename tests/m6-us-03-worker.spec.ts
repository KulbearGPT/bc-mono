import { describe, expect, test } from 'vitest';
import { InMemoryOutboxStore, OutboxWorker, type OutboxJob } from '@blackcat/api/outbox';
import {
  ProductionOutboxRuntime,
  createProductionHandlerMap,
  shouldEnqueueWeeklyReport
} from '@blackcat/api/worker-runtime';
import {
  InMemoryWeeklyReportStore,
  createWeeklyReportGenerationHandler,
  createWeeklyReportNotificationHandler,
  type WeeklyReportFact
} from '@blackcat/api/weekly-reports';

const now = new Date('2026-07-19T16:05:00.000Z');
const guildId = '900000000000006300';
const playerId = '00000000-0000-0000-0000-000000006301';

function job(type: OutboxJob['type'], overrides: Partial<OutboxJob> = {}): OutboxJob {
  return { id: crypto.randomUUID(), type, status: 'PENDING', payload: {}, aggregateType: 'weekly_report_schedule',
    aggregateId: '00000000-0000-0000-0000-000000006390', dedupeKey: `${type}:1`, attempts: 0, maxAttempts: 3,
    runAfter: now.toISOString(), lockedAt: null, lockedBy: null, completedAt: null, lastError: null, version: 1,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), ...overrides };
}

function fact(): WeeklyReportFact {
  return { id: 'fact-a', guildId, playerUserId: playerId, orderId: 'order-a', orderStatus: 'COMPLETED',
    serviceMinutes: 60, orderEarningMinor: 10_000, giftEarningMinor: 0, adjustmentMinor: 0,
    earningStatus: 'CONFIRMED', batchedMinor: 0, occurredAt: '2026-07-18T12:00:00.000Z', issues: [] };
}

describe('M6-US-03 weekly report worker', () => {
  test('registers generation and notification as production handlers', () => {
    const noop = async () => undefined;
    const handlers = createProductionHandlerMap({ giftAnnouncement: noop, giftExpiry: noop, dispatchMessage: noop,
      dispatchStart: noop, dispatchTimeout: noop, readinessTimeout: noop, channelArchive: noop, panelSync: noop, roleReconciliation: noop,
      weeklyReportGenerate: noop, weeklyReportNotify: noop });
    expect(Object.keys(handlers)).toEqual(expect.arrayContaining(['WEEKLY_REPORT_GENERATE', 'WEEKLY_REPORT_NOTIFY']));
  });

  test('CORE_ORDER installs no M6 handlers and never schedules weekly generation', () => {
    const noop = async () => undefined;
    const handlers = createProductionHandlerMap({
      giftAnnouncement: noop,
      giftExpiry: noop,
      dispatchMessage: noop,
      dispatchTimeout: noop,
      readinessTimeout: noop,
      dispatchStart: noop, channelArchive: noop,
      panelSync: noop,
      roleReconciliation: noop,
      weeklyReportGenerate: noop,
      weeklyReportNotify: noop
    }, { m6Enabled: false });

    expect(handlers).not.toHaveProperty('WEEKLY_REPORT_GENERATE');
    expect(handlers).not.toHaveProperty('WEEKLY_REPORT_NOTIFY');
    expect(shouldEnqueueWeeklyReport({
      m6Enabled: false,
      reportGuildId: guildId,
      loopNow: now.getTime(),
      nextReportScheduleCheckAt: 0
    })).toBe(false);
  });

  test('CORE_ORDER leaves pre-existing M6 jobs pending without claiming or exhausting them', async () => {
    const pending = job('WEEKLY_REPORT_GENERATE');
    const store = new InMemoryOutboxStore({ now, jobs: [pending] });
    const worker = new OutboxWorker({ store, workerId: 'core-worker', now: () => now });
    const noop = async () => undefined;
    const handlers = createProductionHandlerMap({
      giftAnnouncement: noop,
      giftExpiry: noop,
      dispatchMessage: noop,
      dispatchTimeout: noop,
      readinessTimeout: noop,
      dispatchStart: noop, channelArchive: noop,
      panelSync: noop,
      roleReconciliation: noop
    }, { m6Enabled: false });

    expect(await worker.runOnce(handlers)).toEqual([]);
    expect(await store.getJob(pending.id)).toEqual(pending);
  });

  test('CORE_ORDER startup leaves stale M6 jobs untouched during recovery', async () => {
    const stale = job('WEEKLY_REPORT_GENERATE', {
      status: 'PROCESSING',
      attempts: 3,
      maxAttempts: 3,
      lockedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
      lockedBy: 'old-worker',
      version: 4
    });
    const store = new InMemoryOutboxStore({ now, jobs: [stale] });
    const worker = new OutboxWorker({ store, workerId: 'core-worker', now: () => now });
    const noop = async () => undefined;
    const handlers = createProductionHandlerMap({
      giftAnnouncement: noop,
      giftExpiry: noop,
      dispatchMessage: noop,
      dispatchTimeout: noop,
      readinessTimeout: noop,
      dispatchStart: noop, channelArchive: noop,
      panelSync: noop,
      roleReconciliation: noop
    }, { m6Enabled: false });
    const runtime = new ProductionOutboxRuntime({
      store,
      worker,
      handlers,
      now: () => now,
      staleLockMs: 60_000
    });

    expect(await runtime.initialize()).toEqual([]);
    expect(await store.getJob(stale.id)).toEqual(stale);
  });

  test('notification failure retries without replaying report generation', async () => {
    const reports = new InMemoryWeeklyReportStore({ facts: [fact()], playerBindings: { [`${guildId}:player-discord`]: playerId },
      notificationTargets: { [playerId]: 'player-discord' } });
    let generationCalls = 0;
    let deliveryCalls = 0;
    const generationHandler = createWeeklyReportGenerationHandler({ store: reports, onGenerated: () => { generationCalls += 1; } });
    const notifyHandler = createWeeklyReportNotificationHandler({ store: reports, sendDirectMessage: async () => {
      deliveryCalls += 1;
      if (deliveryCalls === 1) throw new Error('Discord unavailable');
    } });
    const generationJob = job('WEEKLY_REPORT_GENERATE', { payload: { guildId, scheduleKey: 'weekly-cat',
      periodStart: '2026-07-12T16:00:00.000Z', periodEnd: '2026-07-19T16:00:00.000Z',
      cutoffAt: '2026-07-19T16:00:00.000Z', timeZone: 'Asia/Shanghai', currency: 'CAT' } });

    await generationHandler(generationJob);
    expect(generationCalls).toBe(1);
    expect(reports.reports).toHaveLength(2);
    const notification = reports.notificationJobs[0]!;
    const outbox = new InMemoryOutboxStore({ now, jobs: [notification] });
    const worker = new OutboxWorker({ store: outbox, workerId: 'worker-1', now: () => now, backoffMs: [1] });
    expect((await worker.runOnce({ WEEKLY_REPORT_NOTIFY: notifyHandler }))[0]?.status).toBe('PENDING');
    await new Promise((resolve) => setTimeout(resolve, 2));
    const later = new Date(now.getTime() + 2);
    const retryWorker = new OutboxWorker({ store: outbox, workerId: 'worker-1', now: () => later, backoffMs: [1] });
    expect((await retryWorker.runOnce({ WEEKLY_REPORT_NOTIFY: notifyHandler }))[0]?.status).toBe('COMPLETED');
    expect(generationCalls).toBe(1);
    expect(reports.reports).toHaveLength(2);
  });
});
