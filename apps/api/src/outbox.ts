import type { ActorContext, AuditSink, StaffLevel } from './security.js';

export type JobType =
  | 'GIFT_ANNOUNCEMENT'
  | 'GIFT_EXPIRY'
  | 'DISPATCH_MESSAGE'
  | 'DISPATCH_TIMEOUT'
  | 'READINESS_TIMEOUT'
  | 'CHANNEL_ARCHIVE'
  | 'PANEL_SYNC'
  | 'CHANNEL_CREATE_FAILURE'
  | 'ROLE_RECONCILIATION'
  | 'WEEKLY_REPORT_GENERATE'
  | 'WEEKLY_REPORT_NOTIFY';

export type JobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface OutboxJob {
  id: string;
  type: JobType;
  status: JobStatus;
  payload: unknown;
  aggregateType: string;
  aggregateId: string;
  dedupeKey: string;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lockedAt: string | null;
  lockedBy: string | null;
  completedAt?: string | null;
  lastError: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxStore {
  claimDueJobs(input: { workerId: string; limit: number; now: Date }): Promise<OutboxJob[]>;
  markSucceeded(input: { jobId: string; workerId: string; now: Date }): Promise<OutboxJob>;
  markFailed(input: {
    jobId: string;
    workerId: string;
    error: string;
    retryAt: Date | null;
    now: Date;
  }): Promise<OutboxJob>;
  retryFailedJob(input: { jobId: string; expectedVersion: number; now: Date }): Promise<OutboxJob>;
  recoverStaleProcessingJobs(input: { lockedBefore: Date; now: Date; error: string }): Promise<OutboxJob[]>;
  renewProcessingJob?(input: { jobId: string; workerId: string; now: Date }): Promise<void>;
  getJob(jobId: string): Promise<OutboxJob | null>;
}

export interface OutboxQueryClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

export interface OutboxWorkerOptions {
  store: OutboxStore;
  workerId: string;
  now?: () => Date;
  backoffMs?: number[];
  heartbeatMs?: number;
  logger?: (entry: Record<string, unknown>) => void;
  metric?: (name: string, tags: Record<string, string>) => void;
  auditSink?: AuditSink;
}

type HandlerMap = Partial<Record<JobType, (job: OutboxJob) => Promise<void> | void>>;

const levelRank: Record<StaffLevel, number> = {
  L1_SUPPORT: 1,
  L2_SUPERVISOR: 2,
  L3_OPERATIONS: 3,
  L4_ADMIN_OWNER: 4
};

const deliveryJobTypes = new Set<JobType>([
  'GIFT_ANNOUNCEMENT',
  'GIFT_EXPIRY',
  'DISPATCH_MESSAGE',
  'DISPATCH_TIMEOUT',
  'READINESS_TIMEOUT',
  'CHANNEL_ARCHIVE',
  'PANEL_SYNC',
  'ROLE_RECONCILIATION',
  'WEEKLY_REPORT_GENERATE',
  'WEEKLY_REPORT_NOTIFY'
]);

export class OutboxError extends Error {
  readonly code: 'RESOURCE_NOT_FOUND' | 'CONFLICT' | 'PERMISSION_DENIED' | 'VALIDATION_ERROR';

  constructor(code: OutboxError['code'], message: string) {
    super(message);
    this.name = 'OutboxError';
    this.code = code;
  }
}

export class InMemoryOutboxStore implements OutboxStore {
  private readonly jobs = new Map<string, OutboxJob>();

  constructor(options: { now: Date; jobs?: OutboxJob[] }) {
    for (const job of options.jobs ?? []) {
      assertDeliveryJobType(job.type);
      this.jobs.set(job.id, clone(job));
    }
  }

  async claimDueJobs(input: { workerId: string; limit: number; now: Date }): Promise<OutboxJob[]> {
    assertPositiveLimit(input.limit);
    const dueJobs = Array.from(this.jobs.values())
      .filter((job) => job.status === 'PENDING' && Date.parse(job.runAfter) <= input.now.getTime())
      .sort(compareClaimPriority)
      .slice(0, input.limit);

    return dueJobs.map((job) => {
      const claimed = {
        ...job,
        status: 'PROCESSING' as const,
        attempts: job.attempts + 1,
        lockedAt: input.now.toISOString(),
        lockedBy: input.workerId,
        version: job.version + 1,
        updatedAt: input.now.toISOString()
      };
      this.jobs.set(job.id, clone(claimed));
      return clone(claimed);
    });
  }

  async markSucceeded(input: { jobId: string; workerId: string; now: Date }): Promise<OutboxJob> {
    const job = await this.requireProcessingJob(input.jobId, input.workerId);
    const completed = {
      ...job,
      status: 'COMPLETED' as const,
      lockedAt: null,
      lockedBy: null,
      completedAt: input.now.toISOString(),
      lastError: null,
      version: job.version + 1,
      updatedAt: input.now.toISOString()
    };
    this.jobs.set(job.id, clone(completed));
    return clone(completed);
  }

  async markFailed(input: { jobId: string; workerId: string; error: string; retryAt: Date | null; now: Date }): Promise<OutboxJob> {
    const job = await this.requireProcessingJob(input.jobId, input.workerId);
    const failed = {
      ...job,
      status: input.retryAt ? ('PENDING' as const) : ('FAILED' as const),
      runAfter: (input.retryAt ?? input.now).toISOString(),
      lockedAt: null,
      lockedBy: null,
      lastError: input.error,
      version: job.version + 1,
      updatedAt: input.now.toISOString()
    };
    this.jobs.set(job.id, clone(failed));
    return clone(failed);
  }

  async retryFailedJob(input: { jobId: string; expectedVersion: number; now: Date }): Promise<OutboxJob> {
    const job = await this.getJob(input.jobId);
    if (!job) {
      throw new OutboxError('RESOURCE_NOT_FOUND', 'Job was not found.');
    }
    if (job.status !== 'FAILED') {
      throw new OutboxError('VALIDATION_ERROR', 'Only failed jobs can be retried.');
    }
    if (job.version !== input.expectedVersion) {
      throw new OutboxError('CONFLICT', 'Job version is stale.');
    }
    const retried = {
      ...job,
      status: 'PENDING' as const,
      runAfter: input.now.toISOString(),
      lockedAt: null,
      lockedBy: null,
      lastError: job.lastError,
      version: job.version + 1,
      updatedAt: input.now.toISOString()
    };
    this.jobs.set(job.id, clone(retried));
    return clone(retried);
  }

  async recoverStaleProcessingJobs(input: { lockedBefore: Date; now: Date; error: string }): Promise<OutboxJob[]> {
    const recovered: OutboxJob[] = [];
    for (const job of Array.from(this.jobs.values()).sort(compareClaimPriority)) {
      if (
        job.status !== 'PROCESSING' ||
        !job.lockedAt ||
        Date.parse(job.lockedAt) > input.lockedBefore.getTime()
      ) {
        continue;
      }
      const nextJob = {
        ...job,
        status: job.attempts >= job.maxAttempts ? ('FAILED' as const) : ('PENDING' as const),
        runAfter: input.now.toISOString(),
        lockedAt: null,
        lockedBy: null,
        lastError: input.error,
        version: job.version + 1,
        updatedAt: input.now.toISOString()
      };
      this.jobs.set(job.id, clone(nextJob));
      recovered.push(clone(nextJob));
    }
    return recovered;
  }

  async getJob(jobId: string): Promise<OutboxJob | null> {
    const job = this.jobs.get(jobId);
    return job ? clone(job) : null;
  }

  private async requireProcessingJob(jobId: string, workerId: string): Promise<OutboxJob> {
    const job = await this.getJob(jobId);
    if (!job) {
      throw new OutboxError('RESOURCE_NOT_FOUND', 'Job was not found.');
    }
    if (job.status !== 'PROCESSING' || job.lockedBy !== workerId) {
      throw new OutboxError('CONFLICT', 'Job is not locked by this worker.');
    }
    return job;
  }

  async renewProcessingJob(input: { jobId: string; workerId: string; now: Date }): Promise<void> {
    const job = this.jobs.get(input.jobId);
    if (!job || job.status !== 'PROCESSING' || job.lockedBy !== input.workerId) {
      throw new OutboxError('CONFLICT', 'Job processing lease is no longer owned by this worker.');
    }
    job.lockedAt = input.now.toISOString();
    job.updatedAt = input.now.toISOString();
  }
}

export class PostgresOutboxStore implements OutboxStore {
  private readonly client: OutboxQueryClient;

  constructor(options: { client: OutboxQueryClient }) {
    this.client = options.client;
  }

  async claimDueJobs(input: { workerId: string; limit: number; now: Date }): Promise<OutboxJob[]> {
    assertPositiveLimit(input.limit);
    const result = await this.client.query<OutboxRow>(
      `
WITH due AS (
  SELECT id
  FROM outbox_events
  WHERE status = 'PENDING' AND available_at <= $1
    AND event_type = ANY($4::text[])
  ORDER BY available_at ASC, created_at ASC, id ASC
  LIMIT $3
  FOR UPDATE SKIP LOCKED
)
UPDATE outbox_events AS job
SET status = 'PROCESSING',
    attempt_count = job.attempt_count + 1,
    locked_at = $1,
    locked_by = $2,
    row_version = job.row_version + 1,
    updated_at = $1
FROM due
WHERE job.id = due.id
RETURNING job.id, job.event_type, job.aggregate_type, job.aggregate_id, job.dedupe_key,
          job.payload, job.status, job.row_version, job.attempt_count, job.max_attempts,
          job.available_at, job.locked_at, job.locked_by, job.completed_at,
          job.last_error, job.created_at, job.updated_at
      `,
      [input.now, input.workerId, input.limit, Array.from(deliveryJobTypes)]
    );
    return result.rows.map(mapOutboxRow);
  }

  async markSucceeded(input: { jobId: string; workerId: string; now: Date }): Promise<OutboxJob> {
    const result = await this.client.query<OutboxRow>(
      `
UPDATE outbox_events
SET status = 'COMPLETED',
    locked_at = NULL,
    locked_by = NULL,
    completed_at = $3,
    last_error = NULL,
    row_version = row_version + 1,
    updated_at = $3
WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2
RETURNING id, event_type, aggregate_type, aggregate_id, dedupe_key,
          payload, status, row_version, attempt_count, max_attempts,
          available_at, locked_at, locked_by, completed_at,
          last_error, created_at, updated_at
      `,
      [input.jobId, input.workerId, input.now]
    );
    return requireUpdatedJob(result.rows[0]);
  }

  async markFailed(input: { jobId: string; workerId: string; error: string; retryAt: Date | null; now: Date }): Promise<OutboxJob> {
    const result = await this.client.query<OutboxRow>(
      `
UPDATE outbox_events
SET status = $3::"OutboxStatus",
    available_at = $4,
    locked_at = NULL,
    locked_by = NULL,
    last_error = $5,
    row_version = row_version + 1,
    updated_at = $6
WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2
RETURNING id, event_type, aggregate_type, aggregate_id, dedupe_key,
          payload, status, row_version, attempt_count, max_attempts,
          available_at, locked_at, locked_by, completed_at,
          last_error, created_at, updated_at
      `,
      [input.jobId, input.workerId, input.retryAt ? 'PENDING' : 'FAILED', input.retryAt ?? input.now, input.error, input.now]
    );
    return requireUpdatedJob(result.rows[0]);
  }

  async retryFailedJob(input: { jobId: string; expectedVersion: number; now: Date }): Promise<OutboxJob> {
    const result = await this.client.query<OutboxRow>(
      `
UPDATE outbox_events
SET status = 'PENDING',
    available_at = $2,
    locked_at = NULL,
    locked_by = NULL,
    row_version = row_version + 1,
    updated_at = $2
WHERE id = $1 AND status = 'FAILED' AND row_version = $3
RETURNING id, event_type, aggregate_type, aggregate_id, dedupe_key,
          payload, status, row_version, attempt_count, max_attempts,
          available_at, locked_at, locked_by, completed_at,
          last_error, created_at, updated_at
      `,
      [input.jobId, input.now, input.expectedVersion]
    );
    if (result.rows[0]) {
      return mapOutboxRow(result.rows[0]);
    }
    const current = await this.getJob(input.jobId);
    if (!current) {
      throw new OutboxError('RESOURCE_NOT_FOUND', 'Job was not found.');
    }
    if (current.status !== 'FAILED') {
      throw new OutboxError('VALIDATION_ERROR', 'Only failed jobs can be retried.');
    }
    throw new OutboxError('CONFLICT', 'Job version is stale.');
  }

  async recoverStaleProcessingJobs(input: { lockedBefore: Date; now: Date; error: string }): Promise<OutboxJob[]> {
    const result = await this.client.query<OutboxRow>(
      `
UPDATE outbox_events
SET status = CASE
      WHEN attempt_count >= max_attempts THEN 'FAILED'::"OutboxStatus"
      ELSE 'PENDING'::"OutboxStatus"
    END,
    available_at = $2,
    locked_at = NULL,
    locked_by = NULL,
    last_error = $3,
    row_version = row_version + 1,
    updated_at = $2
WHERE status = 'PROCESSING' AND locked_at IS NOT NULL AND locked_at <= $1
RETURNING id, event_type, aggregate_type, aggregate_id, dedupe_key,
          payload, status, row_version, attempt_count, max_attempts,
          available_at, locked_at, locked_by, completed_at,
          last_error, created_at, updated_at
      `,
      [input.lockedBefore, input.now, input.error]
    );
    return result.rows.map(mapOutboxRow);
  }

  async getJob(jobId: string): Promise<OutboxJob | null> {
    const result = await this.client.query<OutboxRow>(
      `
SELECT id, event_type, aggregate_type, aggregate_id, dedupe_key,
       payload, status, row_version, attempt_count, max_attempts,
       available_at, locked_at, locked_by, completed_at,
       last_error, created_at, updated_at
FROM outbox_events
WHERE id = $1
      `,
      [jobId]
    );
    return result.rows[0] ? mapOutboxRow(result.rows[0]) : null;
  }

  async renewProcessingJob(input: { jobId: string; workerId: string; now: Date }): Promise<void> {
    const result = await this.client.query<{ id: string }>(
      `UPDATE outbox_events
       SET locked_at = $3, updated_at = $3
       WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2
       RETURNING id`,
      [input.jobId, input.workerId, input.now]
    );
    if (!result.rows[0]) throw new OutboxError('CONFLICT', 'Job processing lease is no longer owned by this worker.');
  }
}

export class OutboxWorker {
  private readonly store: OutboxStore;
  private readonly workerId: string;
  private readonly now: () => Date;
  private readonly backoffMs: number[];
  private readonly heartbeatMs: number;
  private readonly logger: (entry: Record<string, unknown>) => void;
  private readonly metric: (name: string, tags: Record<string, string>) => void;
  private readonly auditSink: AuditSink;

  constructor(options: OutboxWorkerOptions) {
    this.store = options.store;
    this.workerId = options.workerId;
    this.now = options.now ?? (() => new Date());
    this.backoffMs = options.backoffMs ?? [1_000, 5_000, 30_000];
    this.heartbeatMs = options.heartbeatMs ?? 60_000;
    this.logger = options.logger ?? (() => undefined);
    this.metric = options.metric ?? (() => undefined);
    this.auditSink = options.auditSink ?? { append: () => undefined };
  }

  async runOnce(handlers: HandlerMap): Promise<OutboxJob[]> {
    const now = this.now();
    const claimed = await this.store.claimDueJobs({ workerId: this.workerId, limit: 1, now });
    const results: OutboxJob[] = [];

    for (const job of claimed) {
      const requestId = `req_${crypto.randomUUID()}`;
      this.logger({
        event: 'outbox.job_started',
        request_id: requestId,
        jobId: job.id,
        jobType: job.type,
        aggregateType: job.aggregateType,
        aggregateId: job.aggregateId,
        workerId: this.workerId,
        attempt: job.attempts
      });
      try {
        const handler = handlers[job.type];
        if (!handler) {
          throw new Error(`No handler registered for ${job.type}`);
        }
        await this.runWithHeartbeat(job, handler);
        const completed = await this.store.markSucceeded({ jobId: job.id, workerId: this.workerId, now: this.now() });
        await this.appendJobAudit(job, completed, 'SUCCEEDED', requestId, null);
        this.metric('outbox_job_succeeded_total', { type: job.type, status: completed.status });
        this.logger({
          event: 'outbox.job_succeeded',
          request_id: requestId,
          jobId: job.id,
          jobType: job.type,
          workerId: this.workerId
        });
        results.push(completed);
      } catch (error) {
        const failedAt = this.now();
        const message = error instanceof Error ? error.message : String(error);
        const retryDelayMs = retryAfterMs(error) ?? this.backoffForAttempt(job.attempts);
        const retryAt = job.attempts >= job.maxAttempts ? null : new Date(failedAt.getTime() + retryDelayMs);
        const failed = await this.store.markFailed({
          jobId: job.id,
          workerId: this.workerId,
          error: storedDeliveryFailure(requestId),
          retryAt,
          now: failedAt
        });
        await this.appendJobAudit(job, failed, 'FAILED', requestId, 'DELIVERY_HANDLER_FAILED');
        this.metric('outbox_job_failed_total', { type: job.type, status: failed.status });
        this.logger({
          event: 'outbox.job_failed',
          request_id: requestId,
          jobId: job.id,
          jobType: job.type,
          aggregateType: job.aggregateType,
          aggregateId: job.aggregateId,
          workerId: this.workerId,
          attempt: job.attempts,
          error_code: 'DELIVERY_HANDLER_FAILED'
        });
        results.push(failed);
      }
    }

    return results;
  }

  private async runWithHeartbeat(job: OutboxJob, handler: (job: OutboxJob) => Promise<void> | void): Promise<void> {
    const renew = this.store.renewProcessingJob?.bind(this.store);
    if (!renew) { await handler(job); return; }
    let pending: Promise<void> | null = null;
    let heartbeatError: unknown = null;
    const timer = setInterval(() => {
      if (pending) return;
      pending = renew({ jobId: job.id, workerId: this.workerId, now: this.now() })
        .catch((error) => { heartbeatError = error; })
        .finally(() => { pending = null; });
    }, this.heartbeatMs);
    try {
      await handler(job);
      if (pending) await pending;
      if (heartbeatError) throw heartbeatError;
    } finally {
      clearInterval(timer);
      if (pending) await pending;
    }
  }

  private async appendJobAudit(
    before: OutboxJob,
    after: OutboxJob,
    outcome: 'SUCCEEDED' | 'FAILED',
    requestId: string,
    reason: string | null
  ): Promise<void> {
    await this.auditSink.append({
      id: crypto.randomUUID(),
      actorId: null,
      actorStaffId: null,
      actorLevel: null,
      actorSource: 'SYSTEM_JOB',
      clientId: 'OUTBOX_WORKER',
      interactionId: null,
      permissionCode: 'operations.failure.report',
      action: `PROCESS_${before.type}`,
      targetType: 'outbox_event',
      targetId: before.id,
      outcome,
      reason,
      requestId,
      idempotencyKey: `job:${before.id}:${before.attempts}`,
      approvalRequestId: null,
      jobId: before.id,
      triggerSource: 'OUTBOX',
      retryAttempt: before.attempts,
      occurredAt: after.updatedAt,
      beforeSnapshot: snapshotJob(before),
      afterSnapshot: snapshotJob(after),
      changes: [
        {
          targetType: 'outbox_event',
          targetId: before.id,
          changeType: 'STATE_TRANSITION',
          beforeSnapshot: snapshotJob(before),
          afterSnapshot: snapshotJob(after),
          changedFields: ['status', 'version', 'lockedAt', 'lockedBy', 'lastError', 'runAfter']
        },
        {
          targetType: before.aggregateType,
          targetId: before.aggregateId,
          changeType: 'UPDATE',
          beforeSnapshot: null,
          afterSnapshot: { trigger: before.type, outcome },
          changedFields: ['trigger', 'outcome']
        }
      ]
    });
  }

  private backoffForAttempt(attempt: number): number {
    return this.backoffMs[Math.min(Math.max(attempt - 1, 0), this.backoffMs.length - 1)] ?? 1_000;
  }
}

function storedDeliveryFailure(requestId: string): string {
  return `DELIVERY_FAILED; requestId=${requestId}`;
}

function retryAfterMs(error: unknown): number | null {
  const value = error && typeof error === 'object' ? (error as { retryAfterMs?: unknown }).retryAfterMs : null;
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 86_400_000 ? Number(value) : null;
}

export async function retryJob(input: {
  store: OutboxStore;
  auditSink: AuditSink;
  jobId: string;
  expectedVersion: number;
  reasonCode: string;
  actor: ActorContext;
  requestId: string;
  now: Date;
}): Promise<OutboxJob> {
  if (!input.actor.actorLevel || levelRank[input.actor.actorLevel] < levelRank.L2_SUPERVISOR) {
    throw new OutboxError('PERMISSION_DENIED', 'job.retry requires L2_SUPERVISOR or above.');
  }
  return retryJobWithAudit(input);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function retryJobWithAudit(input: {
  store: OutboxStore;
  auditSink: AuditSink;
  jobId: string;
  expectedVersion: number;
  reasonCode: string;
  actor: ActorContext;
  requestId: string;
  now: Date;
}): Promise<OutboxJob> {
  const before = await input.store.getJob(input.jobId);
  const retried = await input.store.retryFailedJob({
    jobId: input.jobId,
    expectedVersion: input.expectedVersion,
    now: input.now
  });
  await input.auditSink.append({
    id: crypto.randomUUID(),
    actorId: input.actor.actorUserId,
    actorStaffId: input.actor.actorStaffId,
    actorLevel: input.actor.actorLevel,
    actorSource: input.actor.actorSource,
    clientId: input.actor.clientId,
    interactionId: input.actor.interactionId,
    permissionCode: 'job.retry',
    action: 'RETRY_JOB',
    targetType: 'outbox_event',
    targetId: input.jobId,
    outcome: 'SUCCEEDED',
    reason: input.reasonCode,
    requestId: input.requestId,
    idempotencyKey: `job-retry:${input.jobId}:${input.expectedVersion}`,
    approvalRequestId: null,
    jobId: input.jobId,
    triggerSource: 'DASHBOARD',
    retryAttempt: before?.attempts ?? null,
    occurredAt: input.now.toISOString(),
    beforeSnapshot: snapshotJob(before),
    afterSnapshot: snapshotJob(retried),
    changes: [{
      targetType: 'outbox_event',
      targetId: input.jobId,
      changeType: 'STATE_TRANSITION',
      beforeSnapshot: snapshotJob(before),
      afterSnapshot: snapshotJob(retried),
      changedFields: ['status', 'version', 'runAfter']
    }]
  });
  return retried;
}

function assertPositiveLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new OutboxError('VALIDATION_ERROR', 'Outbox claim limit must be a positive integer.');
  }
}

function compareClaimPriority(left: OutboxJob, right: OutboxJob): number {
  const runAfterDiff = Date.parse(left.runAfter) - Date.parse(right.runAfter);
  if (runAfterDiff !== 0) {
    return runAfterDiff;
  }
  const createdDiff = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdDiff !== 0) {
    return createdDiff;
  }
  return left.id.localeCompare(right.id);
}

function requireUpdatedJob(row: OutboxRow | undefined): OutboxJob {
  if (!row) {
    throw new OutboxError('CONFLICT', 'Job is not locked by this worker.');
  }
  return mapOutboxRow(row);
}

function snapshotJob(job: OutboxJob | null): unknown {
  if (!job) {
    return null;
  }
  return {
    status: job.status,
    attempts: job.attempts,
    lastError: job.lastError,
    runAfter: job.runAfter,
    version: job.version
  };
}

interface OutboxRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  dedupe_key: string;
  payload: unknown;
  status: string;
  row_version: number;
  attempt_count: number;
  max_attempts: number;
  available_at: string | Date;
  locked_at: string | Date | null;
  locked_by: string | null;
  completed_at: string | Date | null;
  last_error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function mapOutboxRow(row: OutboxRow): OutboxJob {
  assertDeliveryJobType(row.event_type);
  return {
    id: row.id,
    type: row.event_type as JobType,
    status: row.status as JobStatus,
    payload: row.payload,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    dedupeKey: row.dedupe_key,
    attempts: row.attempt_count,
    maxAttempts: row.max_attempts,
    runAfter: toIso(row.available_at),
    lockedAt: row.locked_at ? toIso(row.locked_at) : null,
    lockedBy: row.locked_by,
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
    lastError: row.last_error,
    version: row.row_version,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertDeliveryJobType(value: string): asserts value is JobType {
  if (!deliveryJobTypes.has(value as JobType)) {
    throw new OutboxError('VALIDATION_ERROR', `Outbox job type ${value} is not a supported delivery job.`);
  }
}
