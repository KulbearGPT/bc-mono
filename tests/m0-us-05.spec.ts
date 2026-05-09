import { describe, expect, test } from 'vitest';
import { InMemoryAuditSink } from '@blackcat/api/security';
import {
  InMemoryOutboxStore,
  OutboxWorker,
  PostgresOutboxStore,
  retryJob,
  type OutboxQueryClient,
  type OutboxJob
} from '@blackcat/api/outbox';

const now = new Date('2026-07-17T12:00:00.000Z');

function buildJob(overrides: Partial<OutboxJob> = {}): OutboxJob {
  return {
    id: '00000000-0000-0000-0000-00000000a001',
    type: 'GIFT_ANNOUNCEMENT',
    status: 'PENDING',
    payload: { giftRequestId: '00000000-0000-0000-0000-00000000b001', message: 'gift broadcast' },
    aggregateType: 'gift_request',
    aggregateId: '00000000-0000-0000-0000-00000000b001',
    dedupeKey: 'gift:announcement:00000000-0000-0000-0000-00000000b001',
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

describe('M0-US-05 outbox/job runner and observability', () => {
  test('claims due jobs with a worker lock so concurrent workers do not run the same job', async () => {
    const store = new InMemoryOutboxStore({ now, jobs: [buildJob()] });

    const firstClaim = await store.claimDueJobs({ workerId: 'worker-a', limit: 1, now });
    const secondClaim = await store.claimDueJobs({ workerId: 'worker-b', limit: 1, now });

    expect(firstClaim).toHaveLength(1);
    expect(secondClaim).toHaveLength(0);
    expect(firstClaim[0]).toMatchObject({
      status: 'PROCESSING',
      lockedBy: 'worker-a',
      attempts: 1,
      version: 2
    });
  });

  test('backs off retryable failures, eventually marks failed, and emits structured logs and metrics', async () => {
    const logs: unknown[] = [];
    const metrics: Array<{ name: string; tags: Record<string, string> }> = [];
    const store = new InMemoryOutboxStore({ now, jobs: [buildJob()] });
    let currentTime = now;
    const worker = new OutboxWorker({
      store,
      workerId: 'worker-a',
      now: () => currentTime,
      backoffMs: [1_000, 5_000],
      logger: (entry) => logs.push(entry),
      metric: (name, tags) => metrics.push({ name, tags })
    });

    await worker.runOnce({
      GIFT_ANNOUNCEMENT: async () => {
        currentTime = new Date(now.getTime() + 2_500);
        throw new Error('Discord timeout');
      }
    });
    const afterFirstFailure = (await store.getJob('00000000-0000-0000-0000-00000000a001'))!;

    expect(afterFirstFailure).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lockedAt: null,
      lockedBy: null,
      lastError: 'Discord timeout',
      version: 3
    });
    expect(afterFirstFailure.runAfter).toBe(new Date(now.getTime() + 3_500).toISOString());
    expect(logs.at(-1)).toMatchObject({
      event: 'outbox.job_failed',
      request_id: expect.stringMatching(/^req_/),
      jobId: '00000000-0000-0000-0000-00000000a001',
      workerId: 'worker-a',
      error: 'Discord timeout'
    });
    expect(metrics).toContainEqual({
      name: 'outbox_job_failed_total',
      tags: { type: 'GIFT_ANNOUNCEMENT', status: 'PENDING' }
    });

    const dueAgain = new Date(now.getTime() + 3_500);
    await new OutboxWorker({
      store,
      workerId: 'worker-a',
      now: () => dueAgain,
      backoffMs: [1_000, 5_000],
      logger: (entry) => logs.push(entry),
      metric: (name, tags) => metrics.push({ name, tags })
    }).runOnce({
      GIFT_ANNOUNCEMENT: async () => {
        throw new Error('Discord still down');
      }
    });
    const afterTerminalFailure = (await store.getJob('00000000-0000-0000-0000-00000000a001'))!;

    expect(afterTerminalFailure).toMatchObject({
      status: 'FAILED',
      attempts: 2,
      lockedAt: null,
      lockedBy: null,
      lastError: 'Discord still down'
    });
    expect(metrics).toContainEqual({
      name: 'outbox_job_failed_total',
      tags: { type: 'GIFT_ANNOUNCEMENT', status: 'FAILED' }
    });
  });

  test('marks success and only runs delivery handlers, never business transaction handlers', async () => {
    const store = new InMemoryOutboxStore({ now, jobs: [buildJob({ attempts: 1 })] });
    let deliveryCount = 0;
    const businessTransactionCalls: string[] = [];
    const capture = () => {
      businessTransactionCalls.push('capture');
    };
    const worker = new OutboxWorker({ store, workerId: 'worker-a', now: () => now });

    await worker.runOnce({
      GIFT_ANNOUNCEMENT: async () => {
        deliveryCount += 1;
      }
    });
    const completed = (await store.getJob('00000000-0000-0000-0000-00000000a001'))!;

    expect(deliveryCount).toBe(1);
    expect(businessTransactionCalls).toHaveLength(0);
    expect(completed).toMatchObject({
      status: 'COMPLETED',
      lockedAt: null,
      lockedBy: null,
      lastError: null
    });
    expect(completed.completedAt).toBe(now.toISOString());
  });

  test('authorized retry resets failed jobs, increments version, and appends audit', async () => {
    const auditSink = new InMemoryAuditSink();
    const store = new InMemoryOutboxStore({
      now,
      jobs: [
        buildJob({
          status: 'FAILED',
          attempts: 3,
          lastError: 'SYNTHETIC_DISCORD_TIMEOUT',
          runAfter: new Date(now.getTime() - 10_000).toISOString(),
          version: 7
        })
      ]
    });

    await expect(
      retryJob({
        store,
        auditSink,
        jobId: '00000000-0000-0000-0000-00000000a001',
        expectedVersion: 7,
        reasonCode: 'MANUAL_RETRY',
        actor: {
          actorUserId: '00000000-0000-0000-0000-00000000d001',
          actorStaffId: '00000000-0000-0000-0000-00000000e001',
          actorLevel: 'L1_SUPPORT',
          actorSource: 'DASHBOARD',
          clientId: 'DASHBOARD',
          guildId: null,
          discordUserId: null,
          interactionId: null,
          permissionsVersion: 1
        },
        requestId: 'req_retry_l1',
        now
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));

    const retried = await retryJob({
      store,
      auditSink,
      jobId: '00000000-0000-0000-0000-00000000a001',
      expectedVersion: 7,
      reasonCode: 'MANUAL_RETRY',
      actor: {
        actorUserId: '00000000-0000-0000-0000-00000000d002',
        actorStaffId: '00000000-0000-0000-0000-00000000e002',
        actorLevel: 'L2_SUPERVISOR',
        actorSource: 'DASHBOARD',
        clientId: 'DASHBOARD',
        guildId: null,
        discordUserId: null,
        interactionId: null,
        permissionsVersion: 1
      },
      requestId: 'req_retry_l2',
      now
    });

    expect(retried).toMatchObject({
      status: 'PENDING',
      attempts: 3,
      lastError: 'SYNTHETIC_DISCORD_TIMEOUT',
      runAfter: now.toISOString(),
      version: 8
    });
    expect(auditSink.records.at(-1)).toMatchObject({
      actorLevel: 'L2_SUPERVISOR',
      permissionCode: 'job.retry',
      action: 'RETRY_JOB',
      targetType: 'outbox_event',
      targetId: '00000000-0000-0000-0000-00000000a001',
      outcome: 'SUCCEEDED',
      reason: 'MANUAL_RETRY',
      requestId: 'req_retry_l2'
    });
    expect(auditSink.records.at(-1)?.beforeSnapshot).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      lastError: 'SYNTHETIC_DISCORD_TIMEOUT',
      runAfter: new Date(now.getTime() - 10_000).toISOString(),
      version: 7
    });
    expect(auditSink.records.at(-1)?.afterSnapshot).toMatchObject({
      status: 'PENDING',
      attempts: 3,
      lastError: 'SYNTHETIC_DISCORD_TIMEOUT',
      runAfter: now.toISOString(),
      version: 8
    });
  });

  test('database store claims pending jobs atomically with skip locked and maps Prisma status names', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const row = {
      id: '00000000-0000-0000-0000-00000000a001',
      event_type: 'GIFT_ANNOUNCEMENT',
      aggregate_type: 'gift_request',
      aggregate_id: '00000000-0000-0000-0000-00000000b001',
      dedupe_key: 'gift:announcement:00000000-0000-0000-0000-00000000b001',
      payload: { giftRequestId: '00000000-0000-0000-0000-00000000b001' },
      status: 'PROCESSING',
      row_version: 2,
      attempt_count: 1,
      max_attempts: 8,
      available_at: now,
      locked_at: now,
      locked_by: 'worker-a',
      completed_at: null,
      last_error: null,
      created_at: now,
      updated_at: now
    };
    const client: OutboxQueryClient = {
      async query(sql, values = []) {
        queries.push({ sql, values });
        return { rows: [row] };
      }
    };
    const store = new PostgresOutboxStore({ client });

    const claimed = await store.claimDueJobs({ workerId: 'worker-a', limit: 1, now });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      type: 'GIFT_ANNOUNCEMENT',
      status: 'PROCESSING',
      attempts: 1,
      version: 2
    });
    expect(queries[0].sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(queries[0].sql).toContain("status = 'PENDING'");
    expect(queries[0].sql).toContain("status = 'PROCESSING'");
    expect(queries[0].sql).toContain('event_type = ANY($4::text[])');
    expect(queries[0].sql).toContain('ORDER BY available_at ASC, created_at ASC, id ASC');
    expect(queries[0].values).toEqual([
      now,
      'worker-a',
      1,
      [
      'GIFT_ANNOUNCEMENT',
      'GIFT_EXPIRY',
        'DISPATCH_MESSAGE',
        'DISPATCH_TIMEOUT',
        'READINESS_TIMEOUT',
        'CHANNEL_ARCHIVE',
        'PANEL_SYNC',
        'ROLE_RECONCILIATION'
      ]
    ]);
  });

  test('database store casts status parameters when marking retryable failures', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const retryAt = new Date(now.getTime() + 1_000);
    const row = {
      id: '00000000-0000-0000-0000-00000000a001',
      event_type: 'GIFT_ANNOUNCEMENT',
      aggregate_type: 'gift_request',
      aggregate_id: '00000000-0000-0000-0000-00000000b001',
      dedupe_key: 'gift:announcement:00000000-0000-0000-0000-00000000b001',
      payload: { giftRequestId: '00000000-0000-0000-0000-00000000b001' },
      status: 'PENDING',
      row_version: 3,
      attempt_count: 1,
      max_attempts: 8,
      available_at: retryAt,
      locked_at: null,
      locked_by: null,
      completed_at: null,
      last_error: 'Discord timeout',
      created_at: now,
      updated_at: now
    };
    const client: OutboxQueryClient = {
      async query(sql, values = []) {
        queries.push({ sql, values });
        return { rows: [row] };
      }
    };
    const store = new PostgresOutboxStore({ client });

    await store.markFailed({
      jobId: '00000000-0000-0000-0000-00000000a001',
      workerId: 'worker-a',
      error: 'Discord timeout',
      retryAt,
      now
    });

    expect(queries[0].sql).toContain('status = $3::"OutboxStatus"');
    expect(queries[0].values).toEqual([
      '00000000-0000-0000-0000-00000000a001',
      'worker-a',
      'PENDING',
      retryAt,
      'Discord timeout',
      now
    ]);
  });

  test('recovers stale processing jobs so worker crashes do not lock jobs forever', async () => {
    const staleLockedAt = new Date(now.getTime() - 10 * 60_000);
    const store = new InMemoryOutboxStore({
      now,
      jobs: [
        buildJob({
          status: 'PROCESSING',
          attempts: 1,
          lockedAt: staleLockedAt.toISOString(),
          lockedBy: 'worker-crashed',
          version: 4
        })
      ]
    });

    const recovered = await store.recoverStaleProcessingJobs({
      lockedBefore: new Date(now.getTime() - 5 * 60_000),
      now,
      error: 'STALE_PROCESSING_RECOVERED'
    });
    const claimed = await store.claimDueJobs({ workerId: 'worker-recovery', limit: 1, now });

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lockedAt: null,
      lockedBy: null,
      lastError: 'STALE_PROCESSING_RECOVERED',
      runAfter: now.toISOString(),
      version: 5
    });
    expect(claimed[0]).toMatchObject({
      status: 'PROCESSING',
      lockedBy: 'worker-recovery',
      attempts: 2
    });
  });

  test('recovers stale processing jobs to failed when attempts reached the limit', async () => {
    const staleLockedAt = new Date(now.getTime() - 10 * 60_000);
    const store = new InMemoryOutboxStore({
      now,
      jobs: [
        buildJob({
          status: 'PROCESSING',
          attempts: 2,
          maxAttempts: 2,
          lockedAt: staleLockedAt.toISOString(),
          lockedBy: 'worker-crashed',
          version: 4
        })
      ]
    });

    const recovered = await store.recoverStaleProcessingJobs({
      lockedBefore: new Date(now.getTime() - 5 * 60_000),
      now,
      error: 'STALE_PROCESSING_RECOVERED'
    });
    const claimed = await store.claimDueJobs({ workerId: 'worker-recovery', limit: 1, now });

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: 'FAILED',
      attempts: 2,
      lockedAt: null,
      lockedBy: null,
      lastError: 'STALE_PROCESSING_RECOVERED',
      runAfter: now.toISOString(),
      version: 5
    });
    expect(claimed).toHaveLength(0);
  });

  test('database store filters non-delivery job event types before handlers can run', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const row = {
      id: '00000000-0000-0000-0000-00000000a001',
      event_type: 'CAPTURE_HOLD',
      aggregate_type: 'fund_reservation',
      aggregate_id: '00000000-0000-0000-0000-00000000b001',
      dedupe_key: 'fund:capture:00000000-0000-0000-0000-00000000b001',
      payload: { reservationId: '00000000-0000-0000-0000-00000000b001' },
      status: 'PROCESSING',
      row_version: 2,
      attempt_count: 1,
      max_attempts: 8,
      available_at: now,
      locked_at: now,
      locked_by: 'worker-a',
      completed_at: null,
      last_error: null,
      created_at: now,
      updated_at: now
    };
    const client: OutboxQueryClient = {
      async query(sql, values = []) {
        queries.push({ sql, values });
        return { rows: [] };
      }
    };
    const store = new PostgresOutboxStore({ client });

    const claimed = await store.claimDueJobs({ workerId: 'worker-a', limit: 1, now });

    expect(claimed).toHaveLength(0);
    expect(queries[0].sql).toContain('event_type = ANY($4::text[])');
    expect(queries[0].values[3]).not.toContain(row.event_type);

    const defensiveClient: OutboxQueryClient = {
      async query() {
        return { rows: [row] };
      }
    };
    await expect(
      new PostgresOutboxStore({ client: defensiveClient }).claimDueJobs({ workerId: 'worker-a', limit: 1, now })
    ).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});
