import { describe, expect, test } from 'vitest';
import { InMemoryOutboxStore, OutboxWorker, type OutboxJob } from '@blackcat/api/outbox';
import { createProductionHandlerMap } from '@blackcat/api/worker-runtime';
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
      dispatchTimeout: noop, readinessTimeout: noop, channelArchive: noop, panelSync: noop, roleReconciliation: noop,
      weeklyReportGenerate: noop, weeklyReportNotify: noop });
    expect(Object.keys(handlers)).toEqual(expect.arrayContaining(['WEEKLY_REPORT_GENERATE', 'WEEKLY_REPORT_NOTIFY']));
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
    const generationJob = job('WEEKLY_REPORT_GENERATE', { payload: { guildId, scheduleKey: 'weekly-cny',
      periodStart: '2026-07-12T16:00:00.000Z', periodEnd: '2026-07-19T16:00:00.000Z',
      cutoffAt: '2026-07-19T16:00:00.000Z', timeZone: 'Asia/Shanghai', currency: 'CNY' } });

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
