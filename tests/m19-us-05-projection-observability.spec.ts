import { describe, expect, test } from 'vitest';
import { InMemoryOutboxStore, OutboxWorker, type OutboxJob } from '@blackcat/api/outbox';
import { InMemoryOperationsStore } from '@blackcat/api/operations';

const now = new Date('2026-08-08T18:00:00.000Z');

function job(overrides: Partial<OutboxJob> = {}): OutboxJob {
  return {
    id: '00000000-0000-0000-0000-000000019005',
    type: 'PANEL_SYNC',
    status: 'PENDING',
    payload: { orderId: '00000000-0000-0000-0000-000000000019' },
    aggregateType: 'order',
    aggregateId: '00000000-0000-0000-0000-000000000019',
    dedupeKey: 'panel-sync:m19:v8',
    attempts: 0,
    maxAttempts: 2,
    runAfter: now.toISOString(),
    lockedAt: null,
    lockedBy: null,
    lastError: null,
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}

describe('M19-US-05 projection convergence observability', () => {
  test('measures the five-second target and emits a redacted alert after thirty seconds', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const metrics: Array<{ name: string; tags: Record<string, string>; value?: number }> = [];
    const delayed = job({ runAfter: new Date(now.getTime() - 31_000).toISOString() });
    const worker = new OutboxWorker({
      store: new InMemoryOutboxStore({ now, jobs: [delayed] }),
      workerId: 'worker-m19',
      now: () => now,
      logger: (entry) => logs.push(entry),
      metric: (name, tags, value) => metrics.push({ name, tags, value })
    });

    await worker.runOnce({ PANEL_SYNC: async () => undefined });

    expect(metrics).toContainEqual({
      name: 'outbox_projection_convergence_seconds',
      tags: { type: 'PANEL_SYNC', consumer: 'DISCORD_ORDER_PROJECTION', target: 'MISSED' },
      value: 31
    });
    expect(logs).toContainEqual(expect.objectContaining({
      event: 'outbox.projection_alert',
      level: 'error',
      reason: 'CONVERGENCE_DELAY',
      request_id: expect.stringMatching(/^req_/u),
      jobId: delayed.id,
      aggregateType: 'order',
      aggregateId: delayed.aggregateId,
      consumer: 'DISCORD_ORDER_PROJECTION',
      convergence_ms: 31_000
    }));
  });

  test('marks a prompt projection within target without raising an alert', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const metrics: Array<{ name: string; tags: Record<string, string>; value?: number }> = [];
    const prompt = job({ runAfter: new Date(now.getTime() - 4_000).toISOString() });
    const worker = new OutboxWorker({ store: new InMemoryOutboxStore({ now, jobs: [prompt] }), workerId: 'worker-m19', now: () => now,
      logger: (entry) => logs.push(entry), metric: (name, tags, value) => metrics.push({ name, tags, value }) });

    await worker.runOnce({ PANEL_SYNC: async () => undefined });

    expect(metrics).toContainEqual(expect.objectContaining({
      name: 'outbox_projection_convergence_seconds',
      tags: expect.objectContaining({ target: 'MET' }),
      value: 4
    }));
    expect(logs.some((entry) => entry.event === 'outbox.projection_alert')).toBe(false);
  });

  test('alerts on terminal projection failure even before the delay threshold', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const terminal = job({ attempts: 1, maxAttempts: 2, runAfter: new Date(now.getTime() - 2_000).toISOString() });
    const worker = new OutboxWorker({ store: new InMemoryOutboxStore({ now, jobs: [terminal] }), workerId: 'worker-m19', now: () => now,
      logger: (entry) => logs.push(entry) });

    await worker.runOnce({ PANEL_SYNC: async () => { throw new Error('Discord unavailable'); } });

    expect(logs).toContainEqual(expect.objectContaining({
      event: 'outbox.projection_alert',
      reason: 'MAX_ATTEMPTS',
      request_id: expect.stringMatching(/^req_/u),
      aggregateId: terminal.aggregateId,
      consumer: 'DISCORD_ORDER_PROJECTION'
    }));
  });

  test('keeps failed recruitment and support projections visible to staff recovery tools', async () => {
    const jobs = [
      job({ id: '00000000-0000-0000-0000-000000019051', type: 'SELECTION_POOL_SYNC', status: 'FAILED' }),
      job({ id: '00000000-0000-0000-0000-000000019052', type: 'SUPPORT_RESPONSE_REMINDER', status: 'FAILED' })
    ];
    const store = new InMemoryOperationsStore({ jobs });
    const page = store.listFailedJobs({
      actorLevel: 'L2_SUPERVISOR',
      cursor: null,
      limit: 10
    });

    expect(page.items.map((item) => item.type)).toEqual(expect.arrayContaining([
      'SELECTION_POOL_SYNC',
      'SUPPORT_RESPONSE_REMINDER'
    ]));
    expect(store.retryJob({ jobId: jobs[0]!.id, expectedVersion: jobs[0]!.version, actorStaffId: 'staff-l2', now }).data)
      .toMatchObject({ status: 'PENDING', type: 'SELECTION_POOL_SYNC' });
  });
});
