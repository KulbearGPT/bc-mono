import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { buildPrimaryAuditChange, normalizeAuditChanges, type AuditChangeInput } from './audit-changes.js';
import {
  InMemoryAuditSink,
  insertPostgresAuditRecord,
  registerSecureReadRoute,
  registerSecureWriteRoute,
  type ActorContext,
  type ActorSource,
  type AuditOutcome,
  type AuditRecord,
  type AuditSink,
  type StaffLevel
} from './security.js';
import type { JobStatus, JobType, OutboxJob } from './outbox.js';

export interface OperationsAuditRecord {
  id: string;
  actorId: string | null;
  actorLevel: StaffLevel | null;
  actorSource: ActorSource;
  clientId: string;
  interactionId: string | null;
  permissionCode: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: AuditOutcome;
  reason: string | null;
  requestId: string;
  idempotencyKey: string | null;
  approvalRequestId: string | null;
  jobId: string | null;
  triggerSource: string | null;
  retryAttempt: number | null;
  changes: Array<AuditChangeInput & { sequence: number }>;
  occurredAt: string;
}

export interface OperationsJobRecord {
  id: string;
  type: JobType;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  runAfter: string;
  version: number;
}

export interface PolicySettingRecord {
  key: string;
  integerValue: number;
  currency: string | null;
  version: number;
}

export interface PolicyReader {
  getPolicyInteger(key: string, fallback: number): Promise<number> | number;
}

interface Page<T> { items: T[]; nextCursor: string | null }
interface PageInput { cursor: string | null; limit: number }
interface StagedWrite<T> { data: T; commit(auditRecord: AuditRecord, auditSink: AuditSink): Promise<void> | void }

export interface OperationsStore extends PolicyReader {
  listAuditLogs(input: PageInput & { actorStaffId: string; actorLevel: StaffLevel; guildId: string | null; targetType?: string; targetId?: string }): Promise<Page<OperationsAuditRecord>> | Page<OperationsAuditRecord>;
  getAuditLog(input: { auditLogId: string; actorStaffId: string; actorLevel: StaffLevel; guildId: string | null }): Promise<OperationsAuditRecord> | OperationsAuditRecord;
  listFailedJobs(input: PageInput & { actorLevel: StaffLevel; type?: JobType }): Promise<Page<OperationsJobRecord>> | Page<OperationsJobRecord>;
  retryJob(input: { jobId: string; expectedVersion: number; actorStaffId: string; now: Date }): Promise<StagedWrite<OperationsJobRecord>> | StagedWrite<OperationsJobRecord>;
  getPolicySettings(): Promise<PolicySettingRecord[]> | PolicySettingRecord[];
  updatePolicySetting(input: { key: string; expectedVersion: number; integerValue: number; currency: string | null; actorStaffId: string; now: Date }): Promise<StagedWrite<PolicySettingRecord>> | StagedWrite<PolicySettingRecord>;
  recordChannelCreationFailure(input: { requestId: string; guildId: string; discordUserId: string; interactionId: string; now: Date }): Promise<StagedWrite<OperationsJobRecord>> | StagedWrite<OperationsJobRecord>;
  queuePanelRepair(input: { orderId: string; guildId: string; generation: string; actorStaffId: string; now: Date }): Promise<StagedWrite<OperationsJobRecord>> | StagedWrite<OperationsJobRecord>;
}

const retryableJobTypes = new Set<JobType>([
  'GIFT_ANNOUNCEMENT', 'DISPATCH_START', 'DISPATCH_MESSAGE', 'CHANNEL_ARCHIVE', 'PANEL_SYNC',
  'ROLE_RECONCILIATION', 'SELECTION_POOL_SYNC', 'SUPPORT_RESPONSE_REMINDER', 'WEEKLY_REPORT_NOTIFY'
]);
const listedJobTypes = new Set<JobType>([
  'GIFT_ANNOUNCEMENT', 'GIFT_EXPIRY', 'DISPATCH_START', 'DISPATCH_MESSAGE', 'DISPATCH_TIMEOUT',
  'READINESS_TIMEOUT', 'CHANNEL_ARCHIVE', 'PANEL_SYNC', 'CHANNEL_CREATE_FAILURE', 'ROLE_RECONCILIATION',
  'WEEKLY_REPORT_GENERATE', 'WEEKLY_REPORT_NOTIFY', 'SELECTION_POOL_CLOSE', 'SELECTION_POOL_SYNC',
  'SUPPORT_RESPONSE_REMINDER', 'SUPPORT_RESPONSE_OVERDUE'
]);
const sensitiveAuditPermissionPrefixes = ['access.', 'mfa.', 'step_up.', 'staff.session.'];
const l2VisibleJobTypes = new Set<JobType>([
  'GIFT_ANNOUNCEMENT', 'DISPATCH_START', 'DISPATCH_MESSAGE', 'CHANNEL_ARCHIVE', 'PANEL_SYNC',
  'CHANNEL_CREATE_FAILURE', 'SELECTION_POOL_SYNC', 'SUPPORT_RESPONSE_REMINDER', 'SUPPORT_RESPONSE_OVERDUE'
]);
const l3VisibleJobTypes = new Set<JobType>([
  ...l2VisibleJobTypes, 'GIFT_EXPIRY', 'DISPATCH_TIMEOUT', 'READINESS_TIMEOUT',
  'WEEKLY_REPORT_GENERATE', 'WEEKLY_REPORT_NOTIFY', 'SELECTION_POOL_CLOSE'
]);
const policyKeys = new Set([
  'L2_GIFT_APPROVAL_LIMIT_MINOR', 'L2_REFUND_LIMIT_MINOR', 'L4_DIRECT_EXECUTION_THRESHOLD_MINOR',
  'PLAYER_START_GRACE_MINUTES', 'CUSTOMER_NO_SHOW_REVIEW_MINUTES',
  'ORDER_CONFIRMATION_TIMEOUT_MINUTES', 'GIFT_REVIEW_REMINDER_MINUTES',
  'PROMOTER_FIRST_PURCHASE_FIXED_MINOR', 'PROMOTER_FIRST_PURCHASE_RATE_BPS',
  'PLAYER_LIFETIME_ORDER_RATE_BPS', 'PLAYER_LIFETIME_GIFT_RATE_BPS', 'STEP_UP_VALIDITY_MINUTES'
]);
const cursorKey = process.env.BOT_SERVICE_TOKEN ? Buffer.from(process.env.BOT_SERVICE_TOKEN) : randomBytes(32);

export class OperationsError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION_ERROR' | 'PERMISSION_DENIED', message: string) {
    super(message); this.name = 'OperationsError';
  }
}

export class InMemoryOperationsStore implements OperationsStore, AuditSink {
  readonly audits: AuditRecord[];
  readonly jobs: OutboxJob[];
  readonly settings: PolicySettingRecord[];
  private readonly guildStaffIds: Record<string, string[]>;
  private readonly teamStaffIdsBySupervisorId: Record<string, string[]>;
  private readonly settingHistory = new Map<string, PolicySettingRecord[]>();
  private readonly repairableOrders: Array<{ id: string; guildId: string; panelMessageId: string; version: number }>;

  constructor(input: { audits?: AuditRecord[]; jobs?: OutboxJob[]; settings?: PolicySettingRecord[]; guildStaffIds?: Record<string, string[]>; teamStaffIdsBySupervisorId?: Record<string, string[]>; repairableOrders?: Array<{ id: string; guildId: string; panelMessageId: string; version: number }> } = {}) {
    this.audits = clone(input.audits ?? []);
    this.jobs = clone(input.jobs ?? []);
    this.settings = clone(input.settings ?? []);
    this.guildStaffIds = clone(input.guildStaffIds ?? {});
    this.teamStaffIdsBySupervisorId = clone(input.teamStaffIdsBySupervisorId ?? {});
    this.repairableOrders = clone(input.repairableOrders ?? []);
    for (const setting of this.settings) this.settingHistory.set(setting.key, [clone(setting)]);
  }

  append(record: AuditRecord) { this.audits.push(clone(record)); }
  getJob(jobId: string) { return Promise.resolve(clone(this.jobs.find((job) => job.id === jobId) ?? null)); }
  getPolicyHistory(key: string) { return clone(this.settingHistory.get(key) ?? []); }

  listAuditLogs(input: PageInput & { actorStaffId: string; actorLevel: StaffLevel; guildId: string | null; targetType?: string; targetId?: string }) {
    const visibleStaffIds = input.actorLevel === 'L2_SUPERVISOR'
      ? new Set(this.teamStaffIdsBySupervisorId[input.actorStaffId] ?? (input.guildId ? this.guildStaffIds[input.guildId] : undefined) ?? [input.actorStaffId]) : null;
    const visible = this.audits.filter((record) => {
      const businessVisible = isBusinessAudit(record);
      const withinScope = input.actorLevel === 'L4_ADMIN_OWNER'
        || (input.actorLevel === 'L3_OPERATIONS' && record.actorStaffId !== null && businessVisible)
        || (input.actorLevel === 'L2_SUPERVISOR' && businessVisible && Boolean(record.actorStaffId && visibleStaffIds?.has(record.actorStaffId)))
        || record.actorStaffId === input.actorStaffId;
      return withinScope && (!input.targetType || record.targetType === input.targetType) && (!input.targetId || record.targetId === input.targetId);
    }).map(mapAuditRecord);
    return page(visible, input, 'audit', (item) => [item.occurredAt, item.id]);
  }

  getAuditLog(input: { auditLogId: string; actorStaffId: string; actorLevel: StaffLevel; guildId: string | null }) {
    const record = this.listAuditLogs({ ...input, cursor: null, limit: Math.max(1, this.audits.length) }).items.find((item) => item.id === input.auditLogId);
    if (!record) throw new OperationsError('NOT_FOUND', 'Audit log was not found.');
    return record;
  }

  listFailedJobs(input: PageInput & { actorLevel: StaffLevel; type?: JobType }) {
    assertJobVisible(input.actorLevel, input.type);
    const visibleTypes = visibleJobTypes(input.actorLevel);
    const failed = this.jobs.filter((job) => job.status === 'FAILED' && visibleTypes.has(job.type) && (!input.type || job.type === input.type)).map(mapJob);
    return page(failed, input, 'job', (item) => [item.runAfter, item.id]);
  }

  retryJob(input: { jobId: string; expectedVersion: number; actorStaffId: string; now: Date }): StagedWrite<OperationsJobRecord> {
    const current = this.jobs.find((job) => job.id === input.jobId);
    assertRetryable(current, input.expectedVersion);
    const next = { ...current!, status: 'PENDING' as const, runAfter: input.now.toISOString(), lockedAt: null, lockedBy: null, version: current!.version + 1, updatedAt: input.now.toISOString() };
    return {
      data: mapJob(next),
      commit: async (auditRecord, auditSink) => {
        const index = this.jobs.findIndex((job) => job.id === input.jobId);
        assertRetryable(this.jobs[index], input.expectedVersion);
        const before = clone(this.jobs[index]!);
        this.jobs[index] = clone(next);
        try { await auditSink.append({ ...auditRecord, beforeSnapshot: jobSnapshot(before), afterSnapshot: jobSnapshot(next) }); } catch (error) { this.jobs[index] = before; throw error; }
      }
    };
  }

  getPolicySettings() { return clone(this.settings).filter((setting) => policyKeys.has(setting.key)).sort((left, right) => left.key.localeCompare(right.key)); }

  getPolicyInteger(key: string, fallback: number) { return policyKeys.has(key) ? this.settings.find((setting) => setting.key === key)?.integerValue ?? fallback : fallback; }

  updatePolicySetting(input: { key: string; expectedVersion: number; integerValue: number; currency: string | null; actorStaffId: string; now: Date }): StagedWrite<PolicySettingRecord> {
    assertPolicyKey(input.key);
    assertPolicyValue(input.key, input.integerValue, input.currency);
    const current = this.settings.find((setting) => setting.key === input.key);
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== input.expectedVersion) throw new OperationsError('CONFLICT', 'Policy setting version is stale.');
    const next = { key: input.key, integerValue: input.integerValue, currency: input.currency, version: currentVersion + 1 };
    return {
      data: clone(next),
      commit: async (auditRecord, auditSink) => {
        const index = this.settings.findIndex((setting) => setting.key === input.key);
        const observedVersion = index >= 0 ? this.settings[index]!.version : 0;
        if (observedVersion !== input.expectedVersion) throw new OperationsError('CONFLICT', 'Policy setting version is stale.');
        const before = index >= 0 ? clone(this.settings[index]!) : null;
        if (index >= 0) this.settings[index] = clone(next); else this.settings.push(clone(next));
        try {
          await auditSink.append({ ...auditRecord, beforeSnapshot: before, afterSnapshot: next });
          const history = this.settingHistory.get(input.key) ?? [];
          history.push(clone(next));
          this.settingHistory.set(input.key, history);
        } catch (error) {
          if (index >= 0 && before) this.settings[index] = before; else this.settings.splice(this.settings.findIndex((setting) => setting.key === input.key), 1);
          throw error;
        }
      }
    };
  }

  recordChannelCreationFailure(input: { requestId: string; guildId: string; discordUserId: string; interactionId: string; now: Date }): StagedWrite<OperationsJobRecord> {
    const job = channelFailureJob(input);
    return { data: mapJob(job), commit: async (auditRecord, auditSink) => {
      const existing = this.jobs.find((item) => item.dedupeKey === job.dedupeKey);
      if (existing) return;
      this.jobs.push(clone(job));
      try { await auditSink.append({ ...auditRecord, beforeSnapshot: null, afterSnapshot: jobSnapshot(job) }); }
      catch (error) { this.jobs.splice(this.jobs.findIndex((item) => item.id === job.id), 1); throw error; }
    } };
  }

  queuePanelRepair(input: { orderId: string; guildId: string; generation: string; actorStaffId: string; now: Date }): StagedWrite<OperationsJobRecord> {
    const order = this.repairableOrders.find((item) => item.id === input.orderId && item.guildId === input.guildId);
    if (!order) throw new OperationsError('NOT_FOUND', 'Order was not found.');
    const job = panelRepairJob({ ...input, panelMessageId: order.panelMessageId, orderVersion: order.version });
    return { data: mapJob(job), commit: async (auditRecord, auditSink) => {
      const existing = this.jobs.find((item) => item.dedupeKey === job.dedupeKey);
      if (existing) return;
      this.jobs.push(clone(job));
      try { await auditSink.append({ ...auditRecord, beforeSnapshot: null, afterSnapshot: jobSnapshot(job) }); }
      catch (error) { this.jobs.splice(this.jobs.findIndex((item) => item.id === job.id), 1); throw error; }
    } };
  }
}

export class PostgresOperationsStore implements OperationsStore {
  constructor(private readonly pool: Pool) {}

  async listAuditLogs(input: PageInput & { actorStaffId: string; actorLevel: StaffLevel; guildId: string | null; targetType?: string; targetId?: string }) {
    const keys = decodeCursor(input.cursor, 'audit');
    const rows = await this.pool.query<AuditRow>(`SELECT audit.id, audit.actor_user_id, audit.actor_staff_id, audit.actor_level::text, audit.actor_source::text,
      audit.client_id, audit.interaction_id, audit.permission_code, audit.action, audit.target_type, audit.target_id, audit.outcome::text,
      audit.reason, audit.request_id, audit.idempotency_key, audit.approval_request_id, audit.job_id,
      audit.trigger_source, audit.retry_attempt, audit.created_at, ${auditChangesSelect}
      FROM audit_logs audit
      WHERE ($1::text = 'L4_ADMIN_OWNER'
        OR ($1::text = 'L3_OPERATIONS' AND audit.actor_staff_id IS NOT NULL
          AND NOT (COALESCE(audit.permission_code,'') LIKE ANY($9::text[])))
        OR ($1::text = 'L2_SUPERVISOR' AND audit.actor_staff_id IN (
          SELECT team_staff.id FROM staff_accounts team_staff
          WHERE team_staff.level IN ('L1_SUPPORT','L2_SUPERVISOR') AND team_staff.status = 'ACTIVE'
          AND NOT (COALESCE(audit.permission_code,'') LIKE ANY($9::text[]))
          AND EXISTS (
            SELECT 1 FROM discord_accounts team_discord
            JOIN discord_accounts actor_discord ON actor_discord.guild_id = team_discord.guild_id
            JOIN staff_accounts actor_staff ON actor_staff.user_id = actor_discord.user_id
            WHERE team_discord.user_id = team_staff.user_id AND actor_staff.id = $2::uuid
              AND ($3::text IS NULL OR actor_discord.guild_id = $3)
          )
        ))
        OR audit.actor_staff_id = $2::uuid)
      AND ($4::text IS NULL OR audit.target_type = $4) AND ($5::text IS NULL OR audit.target_id = $5)
      AND ($6::timestamptz IS NULL OR (audit.created_at, audit.id) < ($6::timestamptz, $7::uuid))
      ORDER BY audit.created_at DESC, audit.id DESC LIMIT $8`, [input.actorLevel, input.actorStaffId, input.guildId, input.targetType ?? null, input.targetId ?? null, keys?.[0] ?? null, keys?.[1] ?? null, input.limit + 1, sensitiveAuditPermissionPrefixes.map((prefix) => `${prefix}%`)]);
    return pageFromRows(rows.rows.map(mapAuditRow), input, 'audit', (item) => [item.occurredAt, item.id]);
  }

  async getAuditLog(input: { auditLogId: string; actorStaffId: string; actorLevel: StaffLevel; guildId: string | null }) {
    const rows = await this.pool.query<AuditRow>(`SELECT audit.id, audit.actor_user_id, audit.actor_staff_id, audit.actor_level::text, audit.actor_source::text,
      audit.client_id, audit.interaction_id, audit.permission_code, audit.action, audit.target_type, audit.target_id, audit.outcome::text,
      audit.reason, audit.request_id, audit.idempotency_key, audit.approval_request_id, audit.job_id,
      audit.trigger_source, audit.retry_attempt, audit.created_at, ${auditChangesSelect}
      FROM audit_logs audit
      WHERE audit.id=$1::uuid AND ($2::text = 'L4_ADMIN_OWNER'
        OR ($2::text = 'L3_OPERATIONS' AND audit.actor_staff_id IS NOT NULL
          AND NOT (COALESCE(audit.permission_code,'') LIKE ANY($5::text[])))
        OR ($2::text = 'L2_SUPERVISOR' AND audit.actor_staff_id IN (
          SELECT team_staff.id FROM staff_accounts team_staff
          WHERE team_staff.level IN ('L1_SUPPORT','L2_SUPERVISOR') AND team_staff.status = 'ACTIVE'
          AND NOT (COALESCE(audit.permission_code,'') LIKE ANY($5::text[]))
          AND EXISTS (SELECT 1 FROM discord_accounts team_discord
            JOIN discord_accounts actor_discord ON actor_discord.guild_id=team_discord.guild_id
            JOIN staff_accounts actor_staff ON actor_staff.user_id=actor_discord.user_id
            WHERE team_discord.user_id=team_staff.user_id AND actor_staff.id=$3::uuid
              AND ($4::text IS NULL OR actor_discord.guild_id=$4)))
        OR audit.actor_staff_id=$3::uuid)`, [input.auditLogId,input.actorLevel,input.actorStaffId,input.guildId,sensitiveAuditPermissionPrefixes.map((prefix)=>`${prefix}%`)]);
    if(!rows.rows[0])throw new OperationsError('NOT_FOUND','Audit log was not found.');
    return mapAuditRow(rows.rows[0]);
  }

  async listFailedJobs(input: PageInput & { actorLevel: StaffLevel; type?: JobType }) {
    assertJobVisible(input.actorLevel, input.type);
    const keys = decodeCursor(input.cursor, 'job');
    const rows = await this.pool.query<JobRow>(`SELECT id,event_type,status::text,attempt_count,last_error,available_at,row_version
      FROM outbox_events WHERE status = 'FAILED' AND event_type = ANY($1::text[]) AND ($2::text IS NULL OR event_type = $2)
      AND ($3::timestamptz IS NULL OR (available_at,id) < ($3::timestamptz,$4::uuid))
      ORDER BY available_at DESC,id DESC LIMIT $5`, [Array.from(visibleJobTypes(input.actorLevel)), input.type ?? null, keys?.[0] ?? null, keys?.[1] ?? null, input.limit + 1]);
    return pageFromRows(rows.rows.map(mapJobRow), input, 'job', (item) => [item.runAfter, item.id]);
  }

  async retryJob(input: { jobId: string; expectedVersion: number; actorStaffId: string; now: Date }) {
    const before = await this.getJob(input.jobId);
    assertRetryable(before, input.expectedVersion);
    const data = mapJob({ ...before!, status: 'PENDING', runAfter: input.now.toISOString(), version: before!.version + 1 });
    return { data, commit: (auditRecord: AuditRecord) => this.transactionalRetry(input, before!, auditRecord) };
  }

  async getPolicySettings() {
    const rows = await this.pool.query<PolicyRow>(`SELECT key,version,value,currency FROM policy_setting_versions WHERE active_setting_key IS NOT NULL ORDER BY key`);
    return rows.rows.map(mapPolicyRow).filter((setting) => policyKeys.has(setting.key));
  }

  async getPolicyInteger(key: string, fallback: number) {
    if (!policyKeys.has(key)) return fallback;
    const rows = await this.pool.query<{ value: unknown }>(`SELECT value FROM policy_setting_versions WHERE active_setting_key=$1`, [key]);
    const value = Number(rows.rows[0]?.value);
    return Number.isSafeInteger(value) ? value : fallback;
  }

  async updatePolicySetting(input: { key: string; expectedVersion: number; integerValue: number; currency: string | null; actorStaffId: string; now: Date }) {
    assertPolicyKey(input.key);
    assertPolicyValue(input.key, input.integerValue, input.currency);
    const rows = await this.pool.query<PolicyRow>(`SELECT key,version,value,currency FROM policy_setting_versions WHERE active_setting_key = $1`, [input.key]);
    const currentVersion = rows.rows[0]?.version ?? 0;
    if (currentVersion !== input.expectedVersion) throw new OperationsError('CONFLICT', 'Policy setting version is stale.');
    const before = rows.rows[0] ? mapPolicyRow(rows.rows[0]) : null;
    const data = { key: input.key, integerValue: input.integerValue, currency: input.currency, version: currentVersion + 1 };
    return { data, commit: (auditRecord: AuditRecord) => this.transactionalPolicyUpdate(input, before, data, auditRecord) };
  }

  async recordChannelCreationFailure(input: { requestId: string; guildId: string; discordUserId: string; interactionId: string; now: Date }) {
    const job = channelFailureJob(input);
    return { data: mapJob(job), commit: (auditRecord: AuditRecord) => inTransaction(this.pool, async (client) => {
      const inserted = await client.query(`INSERT INTO outbox_events (id,event_type,aggregate_type,aggregate_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,last_error,created_at,updated_at)
        VALUES ($1,'CHANNEL_CREATE_FAILURE','DISCORD_INTERACTION',$2,$3,$4::jsonb,'FAILED',1,1,1,$5,$6,$5,$5)
        ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [job.id, job.aggregateId, job.dedupeKey, JSON.stringify(job.payload), input.now, job.lastError]);
      if (inserted.rows[0]) await insertPostgresAuditRecord(client, { ...auditRecord, beforeSnapshot: null, afterSnapshot: jobSnapshot(job) });
    }) };
  }

  private async getJob(jobId: string): Promise<OutboxJob | null> {
    const rows = await this.pool.query<FullJobRow>(`SELECT id,event_type,aggregate_type,aggregate_id,dedupe_key,payload,status::text,row_version,attempt_count,max_attempts,
      available_at,locked_at,locked_by,completed_at,last_error,created_at,updated_at FROM outbox_events WHERE id=$1`, [jobId]);
    return rows.rows[0] ? mapFullJobRow(rows.rows[0]) : null;
  }

  private async transactionalRetry(input: { jobId: string; expectedVersion: number; now: Date }, before: OutboxJob, auditRecord: AuditRecord) {
    await inTransaction(this.pool, async (client) => {
      const updated = await client.query(`UPDATE outbox_events SET status='PENDING',available_at=$3,locked_at=NULL,locked_by=NULL,row_version=row_version+1,updated_at=$3
        WHERE id=$1 AND status='FAILED' AND row_version=$2 AND event_type = ANY($4::text[]) RETURNING id`, [input.jobId, input.expectedVersion, input.now, Array.from(retryableJobTypes)]);
      if (!updated.rows[0]) throw new OperationsError('CONFLICT', 'Job is no longer retryable or its version is stale.');
      await insertPostgresAuditRecord(client, { ...auditRecord, beforeSnapshot: jobSnapshot(before), afterSnapshot: { ...jobSnapshot(before), status: 'PENDING', runAfter: input.now.toISOString(), version: input.expectedVersion + 1 } });
    });
  }

  private async transactionalPolicyUpdate(input: { key: string; expectedVersion: number; integerValue: number; currency: string | null; actorStaffId: string; now: Date }, before: PolicySettingRecord | null, data: PolicySettingRecord, auditRecord: AuditRecord) {
    await inTransaction(this.pool, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`policy:${input.key}`]);
      const current = await client.query<{ version: number }>(`SELECT version FROM policy_setting_versions WHERE active_setting_key=$1 FOR UPDATE`, [input.key]);
      if ((current.rows[0]?.version ?? 0) !== input.expectedVersion) throw new OperationsError('CONFLICT', 'Policy setting version is stale.');
      await client.query(`UPDATE policy_setting_versions SET active_setting_key=NULL WHERE active_setting_key=$1`, [input.key]);
      await client.query(`INSERT INTO policy_setting_versions (id,key,version,value,currency,active_setting_key,created_by_staff_id,created_at)
        VALUES ($1,$2,$3,$4::jsonb,$5,$2,$6,$7)`, [crypto.randomUUID(), input.key, data.version, JSON.stringify(input.integerValue), input.currency, input.actorStaffId, input.now]);
      await insertPostgresAuditRecord(client, { ...auditRecord, beforeSnapshot: before, afterSnapshot: data });
    });
  }

  async queuePanelRepair(input: { orderId: string; guildId: string; generation: string; actorStaffId: string; now: Date }): Promise<StagedWrite<OperationsJobRecord>> {
    const result = await this.pool.query<{ panel_message_id: string; row_version: number }>(
      'SELECT panel_message_id, row_version FROM orders WHERE id = $1::uuid AND guild_id = $2', [input.orderId, input.guildId]
    );
    const order = result.rows[0];
    if (!order?.panel_message_id) throw new OperationsError('NOT_FOUND', 'Order was not found or has no panel message.');
    const job = panelRepairJob({ ...input, panelMessageId: order.panel_message_id, orderVersion: order.row_version });
    return { data: mapJob(job), commit: async (auditRecord) => {
      await inTransaction(this.pool, async (client) => {
        const current = await client.query<{ panel_message_id: string; row_version: number }>(
          'SELECT panel_message_id, row_version FROM orders WHERE id = $1::uuid FOR UPDATE', [input.orderId]
        );
        if (!current.rows[0]) throw new OperationsError('NOT_FOUND', 'Order was not found.');
        if (current.rows[0].panel_message_id !== order.panel_message_id || current.rows[0].row_version !== order.row_version) {
          throw new OperationsError('CONFLICT', 'Order panel projection changed before repair was queued.');
        }
        await client.query(
          `INSERT INTO outbox_events
             (id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,row_version,
              attempt_count,max_attempts,available_at,created_at,updated_at)
           VALUES ($1::uuid,'PANEL_SYNC','order',$2::uuid,$2::uuid,$3,$4::jsonb,'PENDING',1,0,8,$5,$5,$5)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [job.id, input.orderId, job.dedupeKey, JSON.stringify(job.payload), input.now]
        );
        await insertPostgresAuditRecord(client, { ...auditRecord, beforeSnapshot: null, afterSnapshot: jobSnapshot(job) });
      });
    } };
  }
}

export function registerOperationsRoutes(server: FastifyInstance, options: { store: OperationsStore; guildId?: string; now?: () => Date }) {
  if (!server.securityOptions) throw new Error('Operations routes require security options.');
  const security = server.securityOptions; const now = options.now ?? (() => new Date());
  const auditSink = security.auditSink ?? new InMemoryAuditSink();
  const requireStaff = (actor: ActorContext) => {
    if (!actor.actorStaffId || !actor.actorLevel) throw new OperationsError('PERMISSION_DENIED', 'An active staff account is required.');
    return { staffId: actor.actorStaffId, level: actor.actorLevel };
  };

  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/admin/audit-logs', permission: 'audit.read', action: 'LIST_AUDIT_LOGS', targetType: 'audit_log', acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], mapError,
    handler: (request, actor) => { const staff = requireStaff(actor); return options.store.listAuditLogs({ ...pageQuery(request), actorStaffId: staff.staffId, actorLevel: staff.level, guildId: actor.guildId, targetType: queryText(request, 'targetType'), targetId: queryText(request, 'targetId') }); } });
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/admin/audit-logs/:auditLogId', permission: 'audit.read', action: 'GET_AUDIT_LOG', targetType: 'audit_log', targetId: (request) => param(request,'auditLogId'), acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], mapError,
    handler: (request, actor) => { const staff=requireStaff(actor);return options.store.getAuditLog({auditLogId:uuidParam(request,'auditLogId'),actorStaffId:staff.staffId,actorLevel:staff.level,guildId:actor.guildId}); } });
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/admin/jobs', permission: 'job.read', action: 'LIST_FAILED_JOBS', targetType: 'outbox_event', acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], mapError,
    handler: (request, actor) => { const staff = requireStaff(actor); return options.store.listFailedJobs({ ...pageQuery(request), actorLevel: staff.level, type: jobTypeQuery(request) }); } });
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/admin/policy-settings', permission: 'policy.read', action: 'GET_POLICY_SETTINGS', targetType: 'policy_setting', acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], mapError,
    handler: async (_request, actor) => { requireStaff(actor); return { items: await options.store.getPolicySettings() }; } });

  registerSecureWriteRoute(server, security, { method: 'POST', url: '/api/v1/admin/jobs/:jobId/retry', permission: 'job.retry', action: 'RETRY_JOB', targetType: 'outbox_event', targetId: (request) => param(request, 'jobId'), acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], mapError,
    successReason: (request) => retryAuditReason(parseRetry(request.body)), handler: async (request, actor) => { const staff = requireStaff(actor); const body = parseRetry(request.body); return bindAudit(await options.store.retryJob({ jobId: uuidParam(request, 'jobId'), expectedVersion: body.expectedVersion, actorStaffId: staff.staffId, now: now() }), auditSink); } });
  registerSecureWriteRoute(server, security, { method: 'POST', url: '/api/v1/admin/orders/:orderId/panel-repair', permission: 'job.retry', action: 'QUEUE_PANEL_REPAIR', targetType: 'order', targetId: (request) => param(request, 'orderId'), acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], mapError,
    successReason: (request) => retryAuditReason(parsePanelRepair(request.body)), handler: async (request, actor) => { const staff = requireStaff(actor); const guildId=actor.guildId??options.guildId;if(!guildId)throw new OperationsError('VALIDATION_ERROR','Guild scope is required.');const write = await options.store.queuePanelRepair({ orderId: uuidParam(request, 'orderId'), guildId, generation: request.id, actorStaffId: staff.staffId, now: now() }); return { data: write.data, statusCode: 202, commit: (record: AuditRecord) => write.commit(record, auditSink) }; } });
  registerSecureWriteRoute(server, security, { method: 'PUT', url: '/api/v1/admin/policy-settings/:policyKey', permission: 'policy.manage', action: 'UPDATE_POLICY_SETTING', targetType: 'policy_setting', targetId: (request) => param(request, 'policyKey'), acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], requiresRecentStepUp: true, mapError,
    successReason: (request) => parsePolicy(request.body).reasonCode, handler: async (request, actor) => { const staff = requireStaff(actor); const body = parsePolicy(request.body); return bindAudit(await options.store.updatePolicySetting({ key: param(request, 'policyKey'), expectedVersion: body.expectedVersion, integerValue: body.integerValue, currency: body.currency, actorStaffId: staff.staffId, now: now() }), auditSink); } });
  registerSecureWriteRoute(server, security, { method: 'POST', url: '/api/v1/internal/discord/channel-failures', permission: 'operations.failure.report', action: 'RECORD_CHANNEL_CREATION_FAILURE', targetType: 'outbox_event',
    targetId: (request) => deterministicUuid(`channel-create-failure:${String((request.body as { requestId?: unknown } | null)?.requestId ?? '')}`), acceptedSources: ['DISCORD_BOT'], mapError,
    successReason: () => 'CHANNEL_CREATE_FAILED', handler: async (request, actor) => { const body=parseChannelFailure(request.body);if(!actor.guildId||!actor.discordUserId||!actor.interactionId)throw new OperationsError('VALIDATION_ERROR','Discord actor context is required.');return bindAudit(await options.store.recordChannelCreationFailure({requestId:body.requestId,guildId:actor.guildId,discordUserId:actor.discordUserId,interactionId:actor.interactionId,now:now()}),auditSink); } });
}

function bindAudit<T>(write: StagedWrite<T>, auditSink: AuditSink) { return { data: write.data, commit: (record: AuditRecord) => write.commit(record, auditSink) }; }
function assertRetryable(job: OutboxJob | undefined | null, expectedVersion: number) {
  if (!job) throw new OperationsError('NOT_FOUND', 'Job was not found.');
  if (!retryableJobTypes.has(job.type)) throw new OperationsError('VALIDATION_ERROR', 'This job type cannot be manually retried.');
  if (job.status !== 'FAILED') throw new OperationsError('VALIDATION_ERROR', 'Only failed jobs can be retried.');
  if (job.version !== expectedVersion) throw new OperationsError('CONFLICT', 'Job version is stale.');
}
function assertPolicyKey(key: string) { if (!policyKeys.has(key)) throw new OperationsError('VALIDATION_ERROR', 'Policy key is not managed by the P0 settings surface.'); }
function mapAuditRecord(record: AuditRecord): OperationsAuditRecord {
  const inputChanges=record.changes?.length?record.changes:[buildPrimaryAuditChange({targetType:record.targetType,targetId:record.targetId,beforeSnapshot:record.beforeSnapshot,afterSnapshot:record.afterSnapshot})];
  return { id: record.id, actorId: record.actorId, actorLevel: record.actorLevel, actorSource: record.actorSource ?? 'UNKNOWN', clientId: record.clientId, interactionId: record.interactionId, permissionCode: record.permissionCode, action: record.action, targetType: record.targetType, targetId: record.targetId, outcome: record.outcome, reason: record.reason, requestId: record.requestId, idempotencyKey:record.idempotencyKey??null,approvalRequestId: record.approvalRequestId,jobId:record.jobId??null,triggerSource:record.triggerSource??null,retryAttempt:record.retryAttempt??null,changes:normalizeAuditChanges(inputChanges).map((change,index)=>({...change,sequence:index+1})),occurredAt: record.occurredAt };
}
function mapJob(job: Pick<OutboxJob, 'id'|'type'|'status'|'attempts'|'lastError'|'runAfter'|'version'>): OperationsJobRecord { return { id: job.id, type: job.type, status: job.status, attempts: job.attempts, lastError: publicFailure(job.lastError), runAfter: job.runAfter, version: job.version }; }
function jobSnapshot(job: Pick<OutboxJob, 'status'|'attempts'|'lastError'|'runAfter'|'version'>) { return { status: job.status, attempts: job.attempts, lastError: job.lastError, runAfter: job.runAfter, version: job.version }; }
function mapAuditRow(row: AuditRow): OperationsAuditRecord { return { id: row.id, actorId: row.actor_user_id, actorLevel: row.actor_level, actorSource: row.actor_source, clientId: row.client_id, interactionId: row.interaction_id, permissionCode: row.permission_code ?? '', action: row.action, targetType: row.target_type, targetId: row.target_id, outcome: row.outcome, reason: row.reason, requestId: row.request_id,idempotencyKey:row.idempotency_key,approvalRequestId: row.approval_request_id,jobId:row.job_id,triggerSource:row.trigger_source,retryAttempt:row.retry_attempt,changes:row.changes,occurredAt: iso(row.created_at) }; }
function mapJobRow(row: JobRow): OperationsJobRecord { assertListedJobType(row.event_type); return { id: row.id, type: row.event_type, status: row.status, attempts: row.attempt_count, lastError: publicFailure(row.last_error), runAfter: iso(row.available_at), version: row.row_version }; }
function mapPolicyRow(row: PolicyRow): PolicySettingRecord { const value = typeof row.value === 'number' ? row.value : Number(row.value); if (!Number.isSafeInteger(value) || value < 0) throw new OperationsError('VALIDATION_ERROR', 'Stored policy value is invalid.'); return { key: row.key, integerValue: value, currency: row.currency, version: row.version }; }
function mapFullJobRow(row: FullJobRow): OutboxJob { assertJobType(row.event_type); return { id: row.id, type: row.event_type, status: row.status, payload: row.payload, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, dedupeKey: row.dedupe_key, attempts: row.attempt_count, maxAttempts: row.max_attempts, runAfter: iso(row.available_at), lockedAt: row.locked_at ? iso(row.locked_at) : null, lockedBy: row.locked_by, completedAt: row.completed_at ? iso(row.completed_at) : null, lastError: row.last_error, version: row.row_version, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }; }

function page<T>(items: T[], input: PageInput, resource: CursorResource, keys: (item: T) => string[]): Page<T> { const cursor = decodeCursor(input.cursor, resource); const sorted = items.slice().sort((a,b) => compare(keys(a),keys(b))); const filtered = cursor ? sorted.filter((item) => compare(keys(item),cursor)>0) : sorted; return pageFromRows(filtered,input,resource,keys); }
function pageFromRows<T>(items: T[], input: PageInput, resource: CursorResource, keys: (item: T) => string[]): Page<T> { const selected=items.slice(0,input.limit); const last=selected.at(-1); return { items:clone(selected), nextCursor:items.length>input.limit&&last?encodeCursor(resource,keys(last)):null }; }
type CursorResource = 'audit'|'job';
function encodeCursor(resource: CursorResource, keys: string[]) { const payload=Buffer.from(JSON.stringify({v:1,resource,keys})).toString('base64url'); return `${payload}.${createHmac('sha256',cursorKey).update(payload).digest('base64url')}`; }
function decodeCursor(cursor: string|null, resource: CursorResource): string[]|null { if(!cursor)return null; const [payload,signature,...rest]=cursor.split('.'); if(!payload||!signature||rest.length||createHmac('sha256',cursorKey).update(payload).digest('base64url')!==signature)throw new OperationsError('VALIDATION_ERROR','Cursor is invalid.'); try { const parsed=JSON.parse(Buffer.from(payload,'base64url').toString()) as {v?:unknown;resource?:unknown;keys?:unknown}; if(parsed.v!==1||parsed.resource!==resource||!Array.isArray(parsed.keys)||parsed.keys.length!==2||parsed.keys.some((key)=>typeof key!=='string'))throw new Error(); return parsed.keys as string[]; } catch { throw new OperationsError('VALIDATION_ERROR','Cursor is invalid.'); } }
function compare(left:string[],right:string[]){for(let index=0;index<left.length;index+=1){const difference=(right[index]??'').localeCompare(left[index]??'');if(difference!==0)return difference;}return 0;}
function pageQuery(request: FastifyRequest): PageInput { const query=request.query as Record<string,unknown>; const limit=Number(query.limit??50); if(!Number.isInteger(limit)||limit<1||limit>100)throw new OperationsError('VALIDATION_ERROR','limit is invalid.'); if(query.cursor!==undefined&&(typeof query.cursor!=='string'||query.cursor.length<1||query.cursor.length>500))throw new OperationsError('VALIDATION_ERROR','cursor is invalid.'); return {cursor:query.cursor as string|undefined??null,limit}; }
function queryText(request: FastifyRequest,key:string){const value=(request.query as Record<string,unknown>)[key];if(value===undefined)return undefined;if(typeof value!=='string'||!value.trim()||value.length>100)throw new OperationsError('VALIDATION_ERROR',`${key} is invalid.`);const result=value.trim();if(key==='targetType'&&!/^[A-Z][A-Z0-9_]{1,63}$/.test(result))throw new OperationsError('VALIDATION_ERROR','targetType is invalid.');return result;}
function jobTypeQuery(request: FastifyRequest): JobType|undefined { const value=queryText(request,'type'); if(!value)return undefined; assertListedJobType(value); return value; }
function parseRetry(body:unknown){const input=exactObject(body,['expectedVersion','reasonCode','note']);return {expectedVersion:positiveInteger(input.expectedVersion,'expectedVersion'),reasonCode:reason(input.reasonCode),note:nullableText(input.note,1000)};}
function parsePanelRepair(body:unknown){const input=exactObject(body,['reasonCode','note']);return {reasonCode:reason(input.reasonCode),note:nullableText(input.note,1000)};}
function parsePolicy(body:unknown){const input=exactObject(body,['expectedVersion','integerValue','currency','reasonCode']);const integerValue=nonNegativeInteger(input.integerValue,'integerValue');if(integerValue>1_000_000_000)throw new OperationsError('VALIDATION_ERROR','integerValue is invalid.');return {expectedVersion:positiveInteger(input.expectedVersion,'expectedVersion'),integerValue,currency:nullableCurrency(input.currency),reasonCode:reason(input.reasonCode)};}
function parseChannelFailure(body:unknown){const input=exactObject(body,['requestId','failureCode']);if(input.failureCode!=='CHANNEL_CREATE_FAILED'||typeof input.requestId!=='string'||!/^req_[A-Za-z0-9_-]{8,120}$/.test(input.requestId))throw new OperationsError('VALIDATION_ERROR','Channel failure payload is invalid.');return {requestId:input.requestId};}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new OperationsError('VALIDATION_ERROR','Object payload is required.');return value as Record<string,unknown>;}
function exactObject(value:unknown,allowed:string[]){const input=object(value);if(Object.keys(input).some((key)=>!allowed.includes(key)))throw new OperationsError('VALIDATION_ERROR','Request contains unsupported fields.');return input;}
function positiveInteger(value:unknown,field:string){const result=nonNegativeInteger(value,field);if(result<1)throw new OperationsError('VALIDATION_ERROR',`${field} is invalid.`);return result;}
function nonNegativeInteger(value:unknown,field:string){if(!Number.isSafeInteger(value)||Number(value)<0)throw new OperationsError('VALIDATION_ERROR',`${field} is invalid.`);return Number(value);}
function reason(value:unknown){if(typeof value!=='string'||!/^[A-Z0-9_]{3,100}$/.test(value))throw new OperationsError('VALIDATION_ERROR','reasonCode is invalid.');return value;}
function nullableCurrency(value:unknown){if(value==null)return null;if(typeof value!=='string'||!/^[A-Z]{3}$/.test(value))throw new OperationsError('VALIDATION_ERROR','currency is invalid.');return value;}
function param(request:FastifyRequest,key:string){return String((request.params as Record<string,unknown>)[key]??'');}
function uuidParam(request:FastifyRequest,key:string){const value=param(request,key);if(!isUuid(value))throw new OperationsError('VALIDATION_ERROR',`${key} is invalid.`);return value;}
function mapError(error:unknown){if(!(error instanceof OperationsError))return null;return {statusCode:error.code==='NOT_FOUND'?404:error.code==='PERMISSION_DENIED'?403:error.code==='CONFLICT'?409:400,code:error.code,message:error.message};}
function assertJobType(value:string):asserts value is JobType{if(!retryableJobTypes.has(value as JobType))throw new OperationsError('VALIDATION_ERROR','Job type is not manually retryable.');}
function assertListedJobType(value:string):asserts value is JobType{if(!listedJobTypes.has(value as JobType))throw new OperationsError('VALIDATION_ERROR','Job type is invalid.');}
function isBusinessAudit(record: AuditRecord) { return !sensitiveAuditPermissionPrefixes.some((prefix) => record.permissionCode.startsWith(prefix)); }
function visibleJobTypes(level: StaffLevel): ReadonlySet<JobType> { return level === 'L4_ADMIN_OWNER' ? listedJobTypes : level === 'L3_OPERATIONS' ? l3VisibleJobTypes : l2VisibleJobTypes; }
function assertJobVisible(level: StaffLevel, type?: JobType) { if (type && !visibleJobTypes(level).has(type)) throw new OperationsError('PERMISSION_DENIED', 'This job type is outside the staff member scope.'); }
function publicFailure(value: string | null): string | null { if (!value) return null; const requestId=value.match(/request[_-]?id\s*[:=]\s*([A-Za-z0-9_-]{3,128})/i)?.[1]; return `DELIVERY_FAILED; requestId=${requestId ?? 'unavailable'}`; }
function nullableText(value:unknown,max:number){if(value==null)return null;if(typeof value!=='string'||value.length>max)throw new OperationsError('VALIDATION_ERROR','note is invalid.');return value.trim()||null;}
function retryAuditReason(input:{reasonCode:string;note:string|null}){return input.note?`${input.reasonCode}: ${input.note}`.slice(0,1000):input.reasonCode;}
function isUuid(value:string){return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);}
function assertPolicyValue(key:string,value:number,currency:string|null){
  const rate=key.endsWith('_RATE_BPS');const amount=key.endsWith('_MINOR');const time=key.endsWith('_MINUTES');
  if(rate&&(value>10_000||currency!==null))throw new OperationsError('VALIDATION_ERROR','Rate policies require 0-10000 basis points and no currency.');
  if(amount&&currency!=='CAT')throw new OperationsError('VALIDATION_ERROR','Amount policies require USD.');
  if(time&&(value<1||value>10_080||currency!==null))throw new OperationsError('VALIDATION_ERROR','Time policies require 1-10080 minutes and no currency.');
}
function channelFailureJob(input:{requestId:string;guildId:string;discordUserId:string;interactionId:string;now:Date}):OutboxJob{const id=deterministicUuid(`channel-create-failure:${input.requestId}`);return{id,type:'CHANNEL_CREATE_FAILURE',status:'FAILED',payload:{guildId:input.guildId,discordUserId:input.discordUserId,interactionId:input.interactionId},aggregateType:'DISCORD_INTERACTION',aggregateId:deterministicUuid(`discord-interaction:${input.guildId}:${input.interactionId}`),dedupeKey:`channel-create-failure:${input.guildId}:${input.interactionId}`,attempts:1,maxAttempts:1,runAfter:input.now.toISOString(),lockedAt:null,lockedBy:null,completedAt:null,lastError:`CHANNEL_CREATE_FAILED; requestId=${input.requestId}`,version:1,createdAt:input.now.toISOString(),updatedAt:input.now.toISOString()};}
function panelRepairJob(input:{orderId:string;panelMessageId:string;orderVersion:number;generation:string;now:Date}):OutboxJob{const dedupeKey=`panel-repair:${input.orderId}:v${input.orderVersion}:${input.panelMessageId}:${input.generation}`;return{id:deterministicUuid(dedupeKey),type:'PANEL_SYNC',status:'PENDING',payload:{orderId:input.orderId,kind:'MANUAL_REPAIR'},aggregateType:'order',aggregateId:input.orderId,dedupeKey,attempts:0,maxAttempts:8,runAfter:input.now.toISOString(),lockedAt:null,lockedBy:null,completedAt:null,lastError:null,version:1,createdAt:input.now.toISOString(),updatedAt:input.now.toISOString()};}
function deterministicUuid(value:string){const hex=createHash('sha256').update(value).digest('hex').slice(0,32);return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}
function iso(value:string|Date){return value instanceof Date?value.toISOString():new Date(value).toISOString();}
function clone<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}
async function inTransaction(pool:Pool,work:(client:PoolClient)=>Promise<void>){const client=await pool.connect();try{await client.query('BEGIN');await work(client);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}}

interface AuditRow { id:string; actor_user_id:string|null; actor_staff_id:string|null; actor_level:StaffLevel|null; actor_source:ActorSource; client_id:string; interaction_id:string|null; permission_code:string|null; action:string; target_type:string; target_id:string; outcome:AuditOutcome; reason:string|null; request_id:string; idempotency_key:string|null;approval_request_id:string|null;job_id:string|null;trigger_source:string|null;retry_attempt:number|null;changes:Array<AuditChangeInput&{sequence:number}>;created_at:string|Date }
const auditChangesSelect=`COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'sequence',change.sequence,'targetType',change.target_type,'targetId',change.target_id,'changeType',change.change_type::text,
  'beforeSnapshot',change.before_snapshot,'afterSnapshot',change.after_snapshot,'changedFields',change.changed_fields) ORDER BY change.sequence)
  FROM audit_log_changes change WHERE change.audit_log_id=audit.id),'[]'::jsonb) AS changes`;
interface JobRow { id:string; event_type:string; status:JobStatus; attempt_count:number; last_error:string|null; available_at:string|Date; row_version:number }
interface PolicyRow { key:string; version:number; value:unknown; currency:string|null }
interface FullJobRow extends JobRow { aggregate_type:string; aggregate_id:string; dedupe_key:string; payload:unknown; max_attempts:number; locked_at:string|Date|null; locked_by:string|null; completed_at:string|Date|null; created_at:string|Date; updated_at:string|Date }
