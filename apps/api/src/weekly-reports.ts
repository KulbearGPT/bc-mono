import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { OutboxJob } from './outbox.js';
import { decodeOffsetCursor, encodeOffsetCursor } from './signed-cursor.js';
import {
  InMemoryAuditSink,
  insertPostgresAuditRecord,
  registerSecureReadRoute,
  registerSecureWriteRoute,
  type ActorContext,
  type AuditRecord,
  type AuditSink,
  type StaffLevel
} from './security.js';

export type WeeklyReportStatus = 'READY' | 'NEEDS_REVIEW';
export type WeeklyReportType = 'PLAYER' | 'SUMMARY';
export type WeeklyReportEarningStatus = 'PENDING' | 'CONFIRMED' | 'PAID' | 'REVERSED';

export interface WeeklyReportGenerationInput {
  guildId: string;
  scheduleKey: string;
  periodStart: string;
  periodEnd: string;
  cutoffAt: string;
  timeZone: string;
  currency: string;
}

export interface WeeklyReportFact {
  id: string;
  guildId: string;
  playerUserId: string;
  orderId: string;
  orderStatus: 'COMPLETED' | 'CANCELLED' | 'EXCEPTION';
  serviceMinutes: number;
  orderEarningMinor: number;
  giftEarningMinor: number;
  adjustmentMinor: number;
  earningStatus: WeeklyReportEarningStatus;
  batchedMinor: number;
  settlementBatched?: boolean;
  includeOrderActivity?: boolean;
  occurredAt: string;
  issues: string[];
}

export interface PlayerWeeklyReportMetrics {
  completedOrderCount: number;
  cancelledOrderCount: number;
  serviceMinutes: number;
  orderEarningMinor: number;
  giftEarningMinor: number;
  adjustmentMinor: number;
  pendingMinor: number;
  settlementReadyMinor: number;
  batchedMinor: number;
}

export interface SummaryWeeklyReportMetrics {
  activePlayerCount: number;
  completedOrderCount: number;
  cancelledOrderCount: number;
  exceptionCount: number;
  serviceMinutes: number;
  grossAmountMinor: number;
  adjustmentMinor: number;
  pendingMinor: number;
  netPayableMinor: number;
}

export type WeeklyReportMetrics = PlayerWeeklyReportMetrics | SummaryWeeklyReportMetrics;

export interface WeeklyReportRevision {
  id: string;
  reportType: WeeklyReportType;
  revision: number;
  snapshot: WeeklyReportMetrics;
  reason: string;
  createdByStaffId: string;
  createdAt: string;
}

interface WeeklyReportBase {
  id: string;
  reportType: WeeklyReportType;
  guildId: string;
  scheduleKey: string;
  periodStart: string;
  periodEnd: string;
  cutoffAt: string;
  timeZone: string;
  currency: string;
  status: WeeklyReportStatus;
  metrics: WeeklyReportMetrics;
  detailSnapshot: Record<string, unknown>;
  currentRevision: number;
  revisions: WeeklyReportRevision[];
  createdAt: string;
  updatedAt: string;
}

export interface PlayerWeeklyReport extends WeeklyReportBase {
  reportType: 'PLAYER';
  playerUserId: string;
  metrics: PlayerWeeklyReportMetrics;
}

export interface SummaryWeeklyReport extends WeeklyReportBase {
  reportType: 'SUMMARY';
  playerUserId: null;
  metrics: SummaryWeeklyReportMetrics;
}

export type WeeklyReport = PlayerWeeklyReport | SummaryWeeklyReport;

export interface CurrentPlayerWeeklyReportDto {
  id: string;
  reportType: 'PLAYER';
  periodStart: string;
  periodEnd: string;
  timeZone: string;
  currency: string;
  status: WeeklyReportStatus;
  currentRevision: number;
  metrics: PlayerWeeklyReportMetrics;
}

export interface WeeklyReportGenerationResult {
  playerReports: PlayerWeeklyReport[];
  summaryReport: SummaryWeeklyReport;
}

export interface WeeklyReportRevisionInput {
  reportType: WeeklyReportType;
  expectedRevision: number;
  reason: string;
  snapshot: WeeklyReportMetrics;
  actorStaffId: string;
  idempotencyKey: string;
  now: Date;
}

export interface WeeklyReportStore {
  generate(input: WeeklyReportGenerationInput): Promise<WeeklyReportGenerationResult> | WeeklyReportGenerationResult;
  list(input: { guildId: string; playerUserId?: string; limit: number }): Promise<WeeklyReport[]> | WeeklyReport[];
  get(reportId: string): Promise<WeeklyReport | null> | WeeklyReport | null;
  getInGuild(reportId: string, guildId: string): Promise<WeeklyReport | null> | WeeklyReport | null;
  appendRevision(reportId: string, input: WeeklyReportRevisionInput): Promise<WeeklyReport> | WeeklyReport;
  stageRevision(reportId: string, input: WeeklyReportRevisionInput): Promise<StagedWeeklyReportRevision> | StagedWeeklyReportRevision;
  resolvePlayerUserId(input: { guildId: string; discordUserId: string }): Promise<string | null> | string | null;
  getNotificationTarget(reportId: string): Promise<{ discordUserId: string; report: PlayerWeeklyReport } | null> |
    { discordUserId: string; report: PlayerWeeklyReport } | null;
}

export interface StagedWeeklyReportRevision {
  data: WeeklyReport;
  commit(auditRecord: AuditRecord): Promise<void> | void;
}

export class WeeklyReportError extends Error {
  constructor(readonly code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'REPORT_TYPE_MISMATCH' | 'PERMISSION_DENIED', message: string) {
    super(message);
    this.name = 'WeeklyReportError';
  }
}

export class InMemoryWeeklyReportStore implements WeeklyReportStore {
  readonly facts: WeeklyReportFact[];
  readonly reports: WeeklyReport[] = [];
  readonly notificationJobs: OutboxJob[] = [];
  private readonly playerBindings: Record<string, string>;
  private readonly notificationTargets: Record<string, string>;
  private readonly revisionIdempotency = new Map<string, { reportId: string; fingerprint: string }>();

  constructor(input: { facts?: WeeklyReportFact[]; playerBindings?: Record<string, string>; notificationTargets?: Record<string, string> } = {}) {
    this.facts = clone(input.facts ?? []);
    this.playerBindings = { ...(input.playerBindings ?? {}) };
    this.notificationTargets = { ...(input.notificationTargets ?? {}) };
  }

  generate(input: WeeklyReportGenerationInput): WeeklyReportGenerationResult {
    validateGenerationInput(input);
    const existingSummary = this.reports.find((report): report is SummaryWeeklyReport =>
      report.reportType === 'SUMMARY' && report.guildId === input.guildId && report.scheduleKey === input.scheduleKey &&
      report.periodStart === input.periodStart && report.periodEnd === input.periodEnd && report.currency === input.currency);
    if (existingSummary) return this.group(existingSummary);

    const generated = buildWeeklyReports(this.facts, input);
    this.reports.push(...clone(generated.playerReports), clone(generated.summaryReport));
    for (const report of generated.playerReports) {
      this.notificationJobs.push(notificationJob(report));
    }
    return clone(generated);
  }

  list(input: { guildId: string; playerUserId?: string; limit: number }): WeeklyReport[] {
    return clone(this.reports.filter((report) => report.guildId === input.guildId &&
      (!input.playerUserId || (report.reportType === 'PLAYER' && report.playerUserId === input.playerUserId)))
      .sort((left, right) => right.periodEnd.localeCompare(left.periodEnd) || left.id.localeCompare(right.id)).slice(0, input.limit));
  }

  get(reportId: string): WeeklyReport | null {
    const report = this.reports.find((candidate) => candidate.id === reportId);
    return report ? clone(report) : null;
  }

  getInGuild(reportId: string, guildId: string): WeeklyReport | null {
    const report = this.reports.find((candidate) => candidate.id === reportId && candidate.guildId === guildId);
    return report ? clone(report) : null;
  }

  appendRevision(reportId: string, input: WeeklyReportRevisionInput): WeeklyReport {
    const fingerprint = revisionFingerprint(reportId, input);
    const replay = this.revisionIdempotency.get(input.idempotencyKey);
    if (replay) {
      if (replay.reportId !== reportId || replay.fingerprint !== fingerprint) {
        throw new WeeklyReportError('CONFLICT', 'Revision idempotency key was reused with a different request fingerprint.');
      }
      return this.get(reportId)!;
    }
    const report = this.reports.find((candidate) => candidate.id === reportId);
    if (!report) throw new WeeklyReportError('NOT_FOUND', 'Weekly report was not found.');
    if (report.reportType !== input.reportType) throw new WeeklyReportError('REPORT_TYPE_MISMATCH', 'Report type does not match the stored report.');
    if (report.currentRevision !== input.expectedRevision) throw new WeeklyReportError('CONFLICT', 'Weekly report revision is stale.');
    validateMetrics(input.reportType, input.snapshot);
    const revision: WeeklyReportRevision = {
      id: deterministicUuid(`weekly-report-revision:${report.id}:${input.expectedRevision + 1}`),
      reportType: report.reportType, revision: input.expectedRevision + 1, snapshot: clone(input.snapshot),
      reason: input.reason, createdByStaffId: input.actorStaffId, createdAt: input.now.toISOString()
    };
    report.revisions.push(revision);
    report.currentRevision = revision.revision;
    report.metrics = clone(input.snapshot) as never;
    report.updatedAt = input.now.toISOString();
    this.revisionIdempotency.set(input.idempotencyKey, { reportId: report.id, fingerprint });
    return clone(report);
  }

  stageRevision(reportId: string, input: WeeklyReportRevisionInput): StagedWeeklyReportRevision {
    const simulator = new InMemoryWeeklyReportStore();
    const current = this.get(reportId);
    if (!current) throw new WeeklyReportError('NOT_FOUND', 'Weekly report was not found.');
    simulator.reports.push(clone(current));
    const data = simulator.appendRevision(reportId, input);
    return { data, commit: () => { this.appendRevision(reportId, input); } };
  }

  resolvePlayerUserId(input: { guildId: string; discordUserId: string }): string | null {
    return this.playerBindings[`${input.guildId}:${input.discordUserId}`] ?? null;
  }

  getNotificationTarget(reportId: string): { discordUserId: string; report: PlayerWeeklyReport } | null {
    const report = this.reports.find((candidate): candidate is PlayerWeeklyReport => candidate.id === reportId && candidate.reportType === 'PLAYER');
    if (!report) return null;
    const discordUserId = this.notificationTargets[report.playerUserId];
    return discordUserId ? { discordUserId, report: clone(report) } : null;
  }

  private group(summary: SummaryWeeklyReport): WeeklyReportGenerationResult {
    return { playerReports: this.reports.filter((report): report is PlayerWeeklyReport => report.reportType === 'PLAYER' &&
      report.guildId === summary.guildId && report.scheduleKey === summary.scheduleKey && report.periodStart === summary.periodStart &&
      report.periodEnd === summary.periodEnd && report.currency === summary.currency).map(clone), summaryReport: clone(summary) };
  }
}

export class PostgresWeeklyReportStore implements WeeklyReportStore {
  constructor(private readonly pool: Pool) {}

  async generate(input: WeeklyReportGenerationInput): Promise<WeeklyReportGenerationResult> {
    validateGenerationInput(input);
    const client = await this.pool.connect();
    let summaryId: string | null = null;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [generationKey(input)]);
      const existing = await client.query<{ id: string }>(`SELECT id FROM weekly_report_summaries
        WHERE guild_id=$1 AND schedule_key=$2 AND period_start=$3 AND period_end=$4 AND currency=$5`,
      [input.guildId, input.scheduleKey, input.periodStart, input.periodEnd, input.currency]);
      if (existing.rows[0]) {
        summaryId = existing.rows[0].id;
        await client.query('COMMIT');
        return this.loadGeneration(summaryId);
      }
      const facts = await loadPostgresWeeklyFacts(client, input);
      const generated = buildWeeklyReports(facts, input);
      for (const report of generated.playerReports) {
        await insertPlayerReport(client, report);
        await insertWeeklyNotification(client, report);
      }
      await insertSummaryReport(client, generated.summaryReport);
      summaryId = generated.summaryReport.id;
      await client.query('COMMIT');
      return generated;
    } catch (error) {
      await client.query('ROLLBACK');
      throw mapPostgresError(error);
    } finally {
      client.release();
    }
  }

  async enqueueScheduledGeneration(input: { guildId: string; scheduleKey: string; timeZone: string; now: Date; weekStartsOn?: number }): Promise<void> {
    const period = resolveWeeklyReportPeriod({ now: input.now, timeZone: input.timeZone, weekStartsOn: input.weekStartsOn });
    const payload: WeeklyReportGenerationInput = { guildId: input.guildId, scheduleKey: input.scheduleKey,
      ...period, timeZone: input.timeZone, currency: 'CAT' };
    const id = deterministicUuid(`weekly-report-generate-job:${generationKey(payload)}`);
    await this.pool.query(`INSERT INTO outbox_events
      (id,event_type,aggregate_type,aggregate_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,created_at,updated_at)
      VALUES ($1,'WEEKLY_REPORT_GENERATE','weekly_report_schedule',$1,$2,$3::jsonb,'PENDING',1,0,8,$4,$4,$4)
      ON CONFLICT (dedupe_key) DO NOTHING`, [id, `weekly-report:generate:${generationKey(payload)}`, JSON.stringify(payload), input.now]);
  }

  async list(input: { guildId: string; playerUserId?: string; limit: number }): Promise<WeeklyReport[]> {
    const rows = await this.pool.query<{ id: string; report_type: WeeklyReportType; period_end: Date }>(`
      SELECT id,'PLAYER'::text report_type,period_end FROM player_weekly_reports
      WHERE guild_id=$1 AND ($2::uuid IS NULL OR player_user_id=$2)
      UNION ALL
      SELECT id,'SUMMARY'::text report_type,period_end FROM weekly_report_summaries
      WHERE guild_id=$1 AND $2::uuid IS NULL
      ORDER BY period_end DESC,id ASC LIMIT $3`, [input.guildId, input.playerUserId ?? null, input.limit]);
    return Promise.all(rows.rows.map((row) => this.loadTyped(row.id, row.report_type)));
  }

  async get(reportId: string): Promise<WeeklyReport | null> {
    const type = await this.findType(reportId);
    return type ? this.loadTyped(reportId, type) : null;
  }

  async getInGuild(reportId: string, guildId: string): Promise<WeeklyReport | null> {
    const report = await this.get(reportId);
    return report?.guildId === guildId ? report : null;
  }

  async appendRevision(reportId: string, input: WeeklyReportRevisionInput): Promise<WeeklyReport> {
    await this.commitRevision(reportId, input);
    return requireReport(await this.get(reportId));
  }

  async stageRevision(reportId: string, input: WeeklyReportRevisionInput): Promise<StagedWeeklyReportRevision> {
    const replay = await this.findRevisionReplay(input.idempotencyKey);
    if (replay) {
      if (replay.reportId !== reportId || replay.fingerprint !== revisionFingerprint(reportId, input)) {
        throw new WeeklyReportError('CONFLICT', 'Revision idempotency key was reused with a different request fingerprint.');
      }
      return { data: requireReport(await this.get(reportId)), commit: () => undefined };
    }
    const current = requireReport(await this.get(reportId));
    const simulator = new InMemoryWeeklyReportStore();
    simulator.reports.push(clone(current));
    const data = simulator.appendRevision(reportId, input);
    return { data, commit: (auditRecord) => this.commitRevision(reportId, input, auditRecord) };
  }

  async resolvePlayerUserId(input: { guildId: string; discordUserId: string }): Promise<string | null> {
    const result = await this.pool.query<{ user_id: string }>(`SELECT da.user_id FROM discord_accounts da
      WHERE da.guild_id=$1 AND da.discord_user_id=$2
      AND EXISTS (SELECT 1 FROM player_weekly_reports report WHERE report.guild_id=da.guild_id AND report.player_user_id=da.user_id)`,
    [input.guildId, input.discordUserId]);
    return result.rows[0]?.user_id ?? null;
  }

  async getNotificationTarget(reportId: string): Promise<{ discordUserId: string; report: PlayerWeeklyReport } | null> {
    const result = await this.pool.query<{ discord_user_id: string }>(`SELECT da.discord_user_id
      FROM player_weekly_reports report JOIN discord_accounts da ON da.user_id=report.player_user_id AND da.guild_id=report.guild_id
      WHERE report.id=$1 ORDER BY da.last_seen_at DESC NULLS LAST,da.id LIMIT 1`, [reportId]);
    if (!result.rows[0]) return null;
    const report = await this.get(reportId);
    return report?.reportType === 'PLAYER' ? { discordUserId: result.rows[0].discord_user_id, report } : null;
  }

  private async loadGeneration(summaryId: string): Promise<WeeklyReportGenerationResult> {
    const summary = await this.loadTyped(summaryId, 'SUMMARY') as SummaryWeeklyReport;
    const rows = await this.pool.query<{ id: string }>(`SELECT id FROM player_weekly_reports
      WHERE guild_id=$1 AND schedule_key=$2 AND period_start=$3 AND period_end=$4 AND currency=$5
      ORDER BY player_user_id`, [summary.guildId, summary.scheduleKey, summary.periodStart, summary.periodEnd, summary.currency]);
    const playerReports = await Promise.all(rows.rows.map((row) => this.loadTyped(row.id, 'PLAYER') as Promise<PlayerWeeklyReport>));
    return { playerReports, summaryReport: summary };
  }

  private async findRevisionReplay(idempotencyKey: string): Promise<{ reportId: string; fingerprint: string } | null> {
    const result = await this.pool.query<{ player_weekly_report_id: string | null; weekly_report_summary_id: string | null; request_fingerprint: string }>(
      'SELECT player_weekly_report_id,weekly_report_summary_id,request_fingerprint FROM weekly_report_revisions WHERE idempotency_key=$1',
      [idempotencyKey]
    );
    const row = result.rows[0];
    return row ? { reportId: row.player_weekly_report_id ?? row.weekly_report_summary_id!, fingerprint: row.request_fingerprint } : null;
  }

  private async findType(reportId: string): Promise<WeeklyReportType | null> {
    const result = await this.pool.query<{ report_type: WeeklyReportType }>(`SELECT 'PLAYER'::text report_type
      FROM player_weekly_reports WHERE id=$1 UNION ALL SELECT 'SUMMARY'::text FROM weekly_report_summaries WHERE id=$1`, [reportId]);
    return result.rows[0]?.report_type ?? null;
  }

  private async loadTyped(reportId: string, type: WeeklyReportType): Promise<WeeklyReport> {
    const table = type === 'PLAYER' ? 'player_weekly_reports' : 'weekly_report_summaries';
    const result = await this.pool.query<WeeklyReportRow>(`SELECT * FROM ${table} WHERE id=$1`, [reportId]);
    const row = result.rows[0];
    if (!row) throw new WeeklyReportError('NOT_FOUND', 'Weekly report was not found.');
    const revisions = await loadPostgresRevisions(this.pool, reportId, type);
    return mapWeeklyReportRow(row, type, revisions);
  }

  private async commitRevision(reportId: string, input: WeeklyReportRevisionInput, auditRecord?: AuditRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const fingerprint = revisionFingerprint(reportId, input);
      const replay = await client.query<{ player_weekly_report_id: string | null; weekly_report_summary_id: string | null; request_fingerprint: string }>(
        'SELECT player_weekly_report_id,weekly_report_summary_id,request_fingerprint FROM weekly_report_revisions WHERE idempotency_key=$1', [input.idempotencyKey]);
      if (replay.rows[0]) {
        const target = replay.rows[0].player_weekly_report_id ?? replay.rows[0].weekly_report_summary_id;
        if (target !== reportId || replay.rows[0].request_fingerprint !== fingerprint) {
          throw new WeeklyReportError('CONFLICT', 'Revision idempotency key was reused with a different request fingerprint.');
        }
        await client.query('COMMIT');
        return;
      }
      const actualType = await findPostgresReportType(client, reportId);
      if (!actualType) throw new WeeklyReportError('NOT_FOUND', 'Weekly report was not found.');
      if (actualType !== input.reportType) throw new WeeklyReportError('REPORT_TYPE_MISMATCH', 'Report type does not match the stored report.');
      const table = actualType === 'PLAYER' ? 'player_weekly_reports' : 'weekly_report_summaries';
      const current = await client.query<{ current_revision: number }>(`SELECT current_revision FROM ${table} WHERE id=$1 FOR UPDATE`, [reportId]);
      if (current.rows[0]?.current_revision !== input.expectedRevision) throw new WeeklyReportError('CONFLICT', 'Weekly report revision is stale.');
      validateMetrics(actualType, input.snapshot);
      const nextRevision = input.expectedRevision + 1;
      await client.query(`INSERT INTO weekly_report_revisions
        (id,revision_type,player_weekly_report_id,weekly_report_summary_id,revision,snapshot,reason,idempotency_key,request_fingerprint,created_by_staff_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`, [
        deterministicUuid(`weekly-report-revision:${reportId}:${nextRevision}`), actualType,
        actualType === 'PLAYER' ? reportId : null, actualType === 'SUMMARY' ? reportId : null, nextRevision,
        JSON.stringify(input.snapshot), input.reason, input.idempotencyKey, fingerprint, input.actorStaffId, input.now
      ]);
      await client.query(`UPDATE ${table} SET current_revision=$2,updated_at=$3 WHERE id=$1`, [reportId, nextRevision, input.now]);
      if (auditRecord) await insertPostgresAuditRecord(client, auditRecord);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw mapPostgresError(error);
    } finally { client.release(); }
  }
}

export async function generateWeeklyReports(input: { store: WeeklyReportStore; input: WeeklyReportGenerationInput }): Promise<WeeklyReportGenerationResult> {
  validateGenerationInput(input.input);
  return input.store.generate(input.input);
}

export function buildWeeklyReports(facts: WeeklyReportFact[], input: WeeklyReportGenerationInput): WeeklyReportGenerationResult {
  validateGenerationInput(input);
  const start = Date.parse(input.periodStart);
  const end = Date.parse(input.periodEnd);
  const scoped = facts.filter((fact) => fact.guildId === input.guildId && Date.parse(fact.occurredAt) >= start && Date.parse(fact.occurredAt) < end);
  const byPlayer = new Map<string, WeeklyReportFact[]>();
  for (const fact of scoped) byPlayer.set(fact.playerUserId, [...(byPlayer.get(fact.playerUserId) ?? []), fact]);
  const now = input.cutoffAt;
  const playerReports = Array.from(byPlayer.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([playerUserId, playerFacts]) => {
    const issues = [...new Set(playerFacts.flatMap((fact) => fact.issues))].sort();
    const metrics: PlayerWeeklyReportMetrics = {
      completedOrderCount: playerFacts.filter((fact) => fact.includeOrderActivity !== false && fact.orderStatus === 'COMPLETED').length,
      cancelledOrderCount: playerFacts.filter((fact) => fact.includeOrderActivity !== false && fact.orderStatus === 'CANCELLED').length,
      serviceMinutes: sum(playerFacts.filter((fact) => fact.includeOrderActivity !== false).map((fact) => fact.serviceMinutes)),
      orderEarningMinor: sum(playerFacts.map((fact) => fact.orderEarningMinor)),
      giftEarningMinor: sum(playerFacts.map((fact) => fact.giftEarningMinor)),
      adjustmentMinor: sum(playerFacts.map((fact) => fact.adjustmentMinor)),
      pendingMinor: sum(playerFacts.map((fact) => fact.earningStatus === 'PENDING'
        ? fact.orderEarningMinor + fact.adjustmentMinor
        : fact.includeOrderActivity === false && fact.adjustmentMinor < 0 && !(fact.settlementBatched ?? fact.batchedMinor !== 0)
          ? -fact.adjustmentMinor : 0)),
      settlementReadyMinor: sum(playerFacts.filter((fact) => fact.earningStatus === 'CONFIRMED' &&
        !(fact.settlementBatched ?? fact.batchedMinor !== 0)).map((fact) => fact.orderEarningMinor + fact.adjustmentMinor)),
      batchedMinor: sum(playerFacts.map((fact) => fact.batchedMinor))
    };
    const reportKey = `${input.guildId}:${input.scheduleKey}:${input.periodStart}:${input.periodEnd}:${input.currency}:PLAYER:${playerUserId}`;
    return { id: deterministicUuid(reportKey), reportType: 'PLAYER' as const, guildId: input.guildId, scheduleKey: input.scheduleKey,
      playerUserId, periodStart: input.periodStart, periodEnd: input.periodEnd, cutoffAt: input.cutoffAt, timeZone: input.timeZone,
      currency: input.currency, status: issues.length ? 'NEEDS_REVIEW' as const : 'READY' as const, metrics,
      detailSnapshot: { issues, facts: clone(playerFacts) }, currentRevision: 1, revisions: [], createdAt: now, updatedAt: now };
  });
  const summaryMetrics: SummaryWeeklyReportMetrics = {
    activePlayerCount: playerReports.length,
    completedOrderCount: sum(playerReports.map((report) => report.metrics.completedOrderCount)),
    cancelledOrderCount: sum(playerReports.map((report) => report.metrics.cancelledOrderCount)),
    exceptionCount: scoped.filter((fact) => fact.orderStatus === 'EXCEPTION').length + playerReports.filter((report) => report.status === 'NEEDS_REVIEW').length,
    serviceMinutes: sum(playerReports.map((report) => report.metrics.serviceMinutes)),
    grossAmountMinor: sum(playerReports.map((report) => report.metrics.orderEarningMinor + report.metrics.giftEarningMinor)),
    adjustmentMinor: sum(playerReports.map((report) => report.metrics.adjustmentMinor)),
    pendingMinor: sum(playerReports.map((report) => report.metrics.pendingMinor)),
    netPayableMinor: sum(playerReports.map((report) => report.metrics.settlementReadyMinor))
  };
  const summaryKey = `${input.guildId}:${input.scheduleKey}:${input.periodStart}:${input.periodEnd}:${input.currency}:SUMMARY`;
  const summaryReport: SummaryWeeklyReport = {
    id: deterministicUuid(summaryKey), reportType: 'SUMMARY', guildId: input.guildId, scheduleKey: input.scheduleKey, playerUserId: null,
    periodStart: input.periodStart, periodEnd: input.periodEnd, cutoffAt: input.cutoffAt, timeZone: input.timeZone, currency: input.currency,
    status: playerReports.some((report) => report.status === 'NEEDS_REVIEW') ? 'NEEDS_REVIEW' : 'READY', metrics: summaryMetrics,
    detailSnapshot: { playerReports: playerReports.map((report) => ({ id: report.id, playerUserId: report.playerUserId, status: report.status, metrics: report.metrics })) },
    currentRevision: 1, revisions: [], createdAt: now, updatedAt: now
  };
  return { playerReports, summaryReport };
}

export function resolveWeeklyReportPeriod(input: { now: Date; timeZone: string; weekStartsOn?: number }): Pick<WeeklyReportGenerationInput, 'periodStart' | 'periodEnd' | 'cutoffAt'> {
  assertTimeZone(input.timeZone);
  const weekStartsOn = input.weekStartsOn ?? 1;
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) throw new WeeklyReportError('VALIDATION_ERROR', 'weekStartsOn is invalid.');
  const local = localDateParts(input.now, input.timeZone);
  const pseudo = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const daysSinceStart = (pseudo.getUTCDay() - weekStartsOn + 7) % 7;
  pseudo.setUTCDate(pseudo.getUTCDate() - daysSinceStart);
  const periodEnd = localMidnightToInstant({ year: pseudo.getUTCFullYear(), month: pseudo.getUTCMonth() + 1, day: pseudo.getUTCDate() }, input.timeZone);
  pseudo.setUTCDate(pseudo.getUTCDate() - 7);
  const periodStart = localMidnightToInstant({ year: pseudo.getUTCFullYear(), month: pseudo.getUTCMonth() + 1, day: pseudo.getUTCDate() }, input.timeZone);
  return { periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), cutoffAt: periodEnd.toISOString() };
}

export function registerWeeklyReportRoutes(server: FastifyInstance, options: { store: WeeklyReportStore; now?: () => Date }): void {
  if (!server.securityOptions) throw new Error('Weekly report routes require security options.');
  const security = server.securityOptions;
  const now = options.now ?? (() => new Date());
  const auditSink = security.auditSink ?? new InMemoryAuditSink();
  security.auditSink = auditSink;
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/admin/weekly-reports', permission: 'weekly_report.read', requiredFeature: 'M6',
    action: 'LIST_ADMIN_WEEKLY_REPORTS', targetType: 'weekly_report', acceptedSources: ['DASHBOARD'], mapError: mapWeeklyReportError,
    handler: async (request, actor) => weeklyReportPage(request, (limit) => options.store.list({ guildId: requireGuild(actor), limit })) });
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/admin/weekly-reports/:weeklyReportId', permission: 'weekly_report.read', requiredFeature: 'M6',
    action: 'GET_ADMIN_WEEKLY_REPORT', targetType: 'weekly_report', targetId: reportIdParam, acceptedSources: ['DASHBOARD'], mapError: mapWeeklyReportError,
    handler: async (request, actor) => requireReport(await options.store.getInGuild(reportIdParam(request), requireGuild(actor))) });
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/admin/weekly-reports/:weeklyReportId/export', permission: 'weekly_report.read', requiredFeature: 'M6',
    action: 'EXPORT_WEEKLY_REPORT', targetType: 'weekly_report', targetId: reportIdParam, acceptedSources: ['DASHBOARD'], mapError: mapWeeklyReportError,
    handler: async (request, actor) => exportWeeklyReport(requireReport(await options.store.getInGuild(reportIdParam(request), requireGuild(actor)))),
    rawResponse: (payload, reply) => { const csv = payload as string; reply.type('text/csv; charset=utf-8'); return reply.send(csv); } });
  registerSecureWriteRoute(server, security, { method: 'POST', url: '/api/v1/admin/weekly-reports/:weeklyReportId/revisions',
    permission: 'weekly_report.manage', requiredFeature: 'M6', action: 'CREATE_WEEKLY_REPORT_REVISION', targetType: 'weekly_report', targetId: reportIdParam,
    acceptedSources: ['DASHBOARD'], requiresRecentStepUp: true, successStatusCode: 201,
    fingerprintBody: (request) => parseRevision(request.body), successReason: (request) => parseRevision(request.body).reason,
    retryCommitFailures: true, mapError: mapWeeklyReportError, handler: async (request, actor) => {
      if (!actor.actorStaffId) throw new WeeklyReportError('PERMISSION_DENIED', 'A staff actor is required.');
      const guildId = requireGuild(actor);
      requireReport(await options.store.getInGuild(reportIdParam(request), guildId));
      const staged = await options.store.stageRevision(reportIdParam(request), { ...parseRevision(request.body), actorStaffId: actor.actorStaffId,
        idempotencyKey: String(request.headers['idempotency-key']), now: now() });
      return { data: staged.data, commit: async (record: AuditRecord) => {
        if (options.store instanceof PostgresWeeklyReportStore) await staged.commit(record);
        else { await auditSink.append(record); await staged.commit(record); }
      } };
    } });
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/players/me/weekly-reports', permission: 'player.workspace.read', requiredFeature: 'M6',
    action: 'LIST_MY_WEEKLY_REPORTS', targetType: 'weekly_report', acceptedSources: ['DISCORD_BOT'], mapError: mapWeeklyReportError,
    handler: async (request, actor) => {
      const playerUserId = await resolveCurrentPlayer(options.store, actor);
      const page = await weeklyReportPage(request, (limit) => options.store.list({ guildId: requireGuild(actor), playerUserId, limit }));
      return { items: page.items.map(mapCurrentPlayerWeeklyReport), nextCursor: page.nextCursor };
    } });
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/players/me/weekly-reports/:weeklyReportId', permission: 'player.workspace.read', requiredFeature: 'M6',
    action: 'GET_MY_WEEKLY_REPORT', targetType: 'weekly_report', targetId: reportIdParam, acceptedSources: ['DISCORD_BOT'], mapError: mapWeeklyReportError,
    handler: async (request, actor) => {
      const report = await options.store.getInGuild(reportIdParam(request), requireGuild(actor));
      const playerUserId = await resolveCurrentPlayer(options.store, actor);
      if (!report || report.reportType !== 'PLAYER' || report.playerUserId !== playerUserId) throw new WeeklyReportError('NOT_FOUND', 'Weekly report was not found.');
      return mapCurrentPlayerWeeklyReport(report);
    } });
}

export function exportWeeklyReport(report: WeeklyReport): string {
  const metricEntries = Object.entries(report.metrics);
  const header = ['report_type', 'period_start', 'period_end', 'time_zone', 'currency', 'status', 'current_revision', ...metricEntries.map(([key]) => snakeCase(key))];
  const values = [report.reportType, report.periodStart, report.periodEnd, report.timeZone, report.currency, report.status,
    report.currentRevision, ...metricEntries.map(([, value]) => value)];
  return `\uFEFF${header.map(csvCell).join(',')}\r\n${values.map(csvCell).join(',')}\r\n`;
}

export function createWeeklyReportGenerationHandler(input: { store: WeeklyReportStore; onGenerated?: (result: WeeklyReportGenerationResult) => void }) {
  return async (job: OutboxJob): Promise<void> => {
    if (job.type !== 'WEEKLY_REPORT_GENERATE') throw new Error('Expected a WEEKLY_REPORT_GENERATE job.');
    const payload = parseGenerationPayload(job.payload);
    const result = await generateWeeklyReports({ store: input.store, input: payload });
    input.onGenerated?.(result);
  };
}

export function createWeeklyReportNotificationHandler(input: {
  store: WeeklyReportStore;
  sendDirectMessage: (message: { discordUserId: string; content: string; dedupeKey: string; notBefore: string }) => Promise<unknown>;
}) {
  return async (job: OutboxJob): Promise<void> => {
    if (job.type !== 'WEEKLY_REPORT_NOTIFY') throw new Error('Expected a WEEKLY_REPORT_NOTIFY job.');
    const payload = job.payload as { reportId?: unknown } | null;
    if (!payload || typeof payload.reportId !== 'string' || payload.reportId !== job.aggregateId) throw new Error('Weekly report notification payload is invalid.');
    const target = await input.store.getNotificationTarget(payload.reportId);
    if (!target) throw new Error('Weekly report notification target was not found.');
    await input.sendDirectMessage({ discordUserId: target.discordUserId,
      content: `周报已生成：${target.report.periodStart} 至 ${target.report.periodEnd}，状态 ${target.report.status}。`,
      dedupeKey: job.dedupeKey, notBefore: job.createdAt });
  };
}

async function loadPostgresWeeklyFacts(client: PoolClient, input: WeeklyReportGenerationInput): Promise<WeeklyReportFact[]> {
  const result = await client.query<WeeklyFactRow>(`
    WITH current_adjustments AS (
      SELECT pea.player_earning_id,
        COALESCE(sum(CASE WHEN pea.type='CORRECTION_CREDIT' THEN pea.amount_minor ELSE -pea.amount_minor END),0) adjustment_minor,
        max(pea.created_at) occurred_at
      FROM player_earning_adjustments pea
      WHERE pea.created_at >= $2 AND pea.created_at < $3 AND pea.currency=$5
      GROUP BY pea.player_earning_id
    ), gifts AS (
      SELECT gift.order_id,gift.receiver_id,COALESCE(sum(gift.price_minor),0) gift_minor
      FROM gift_requests gift
      WHERE gift.captured_at >= $2 AND gift.captured_at < $3 AND gift.currency=$5
      GROUP BY gift.order_id,gift.receiver_id
    ), batched AS (
      SELECT pe.id player_earning_id,COALESCE(sum(entry.amount_minor),0) batched_minor,
        bool_or(entry.player_earning_id=pe.id) earning_batched
      FROM player_earnings pe
      JOIN settlement_item_entries entry ON entry.player_earning_id=pe.id
        OR entry.player_earning_adjustment_id IN (
          SELECT adjustment.id FROM player_earning_adjustments adjustment WHERE adjustment.player_earning_id=pe.id
        )
      JOIN settlement_items item ON item.id=entry.settlement_item_id
      JOIN settlement_batches batch ON batch.id=item.settlement_batch_id AND batch.status<>'VOIDED'
      GROUP BY pe.id
    ), current_adjustment_batched AS (
      SELECT adjustment.player_earning_id,COALESCE(sum(entry.amount_minor),0) batched_minor,true adjustment_batched
      FROM player_earning_adjustments adjustment
      JOIN settlement_item_entries entry ON entry.player_earning_adjustment_id=adjustment.id
      JOIN settlement_items item ON item.id=entry.settlement_item_id
      JOIN settlement_batches batch ON batch.id=item.settlement_batch_id AND batch.status<>'VOIDED'
      WHERE adjustment.created_at >= $2 AND adjustment.created_at < $3 AND adjustment.currency=$5
      GROUP BY adjustment.player_earning_id
    ), report_facts AS (
      SELECT o.id order_id,o.player_id,o.status::text order_status,o.service_started_at,o.completed_at,o.cancelled_at,
        COALESCE(o.completed_at,o.cancelled_at,o.updated_at) occurred_at,
        pe.id earning_id,COALESCE(pe.amount_minor,0) order_earning_minor,COALESCE(pe.status::text,'REVERSED') earning_status,
        COALESCE(current_adjustments.adjustment_minor,0) adjustment_minor,COALESCE(gifts.gift_minor,0) gift_earning_minor,
        COALESCE(batched.batched_minor,0) batched_minor,COALESCE(batched.earning_batched,false) settlement_batched,
        true include_order_activity
      FROM orders o
      LEFT JOIN player_earnings pe ON pe.order_id=o.id
      LEFT JOIN current_adjustments ON current_adjustments.player_earning_id=pe.id
      LEFT JOIN gifts ON gifts.order_id=o.id AND gifts.receiver_id=o.player_id
      LEFT JOIN batched ON batched.player_earning_id=pe.id
      WHERE o.guild_id=$1 AND o.currency=$5 AND o.player_id IS NOT NULL
        AND o.status IN ('COMPLETED','CANCELLED','EXCEPTION')
        AND COALESCE(o.completed_at,o.cancelled_at,o.updated_at) >= $2
        AND COALESCE(o.completed_at,o.cancelled_at,o.updated_at) < $3
        AND COALESCE(o.completed_at,o.cancelled_at,o.updated_at) <= $4

      UNION ALL

      SELECT o.id order_id,pe.player_user_id player_id,o.status::text order_status,NULL,NULL,NULL,
        current_adjustments.occurred_at,pe.id earning_id,0 order_earning_minor,pe.status::text earning_status,
        current_adjustments.adjustment_minor,0 gift_earning_minor,
        COALESCE(current_adjustment_batched.batched_minor,0) batched_minor,
        COALESCE(current_adjustment_batched.adjustment_batched,false) settlement_batched,false include_order_activity
      FROM current_adjustments
      JOIN player_earnings pe ON pe.id=current_adjustments.player_earning_id
      JOIN orders o ON o.id=pe.order_id
      LEFT JOIN current_adjustment_batched ON current_adjustment_batched.player_earning_id=pe.id
      WHERE o.guild_id=$1 AND pe.currency=$5
        AND current_adjustments.occurred_at <= $4
        AND NOT (COALESCE(o.completed_at,o.cancelled_at,o.updated_at) >= $2
          AND COALESCE(o.completed_at,o.cancelled_at,o.updated_at) < $3)
    )
    SELECT * FROM report_facts ORDER BY player_id,occurred_at,order_id`,
  [input.guildId, input.periodStart, input.periodEnd, input.cutoffAt, input.currency]);
  return result.rows.map((row) => {
    const issues: string[] = [];
    if (row.include_order_activity && row.order_status === 'COMPLETED' && !row.earning_id) issues.push('MISSING_PLAYER_EARNING');
    if (row.include_order_activity && row.order_status === 'COMPLETED' && (!row.service_started_at || !row.completed_at)) issues.push('MISSING_SERVICE_BOUNDARY');
    const serviceDelta = row.service_started_at && row.completed_at
      ? new Date(row.completed_at).getTime() - new Date(row.service_started_at).getTime() : 0;
    if (row.include_order_activity && row.service_started_at && row.completed_at && serviceDelta < 0) issues.push('INVALID_SERVICE_BOUNDARY_ORDER');
    const serviceMinutes = serviceDelta >= 0 ? Math.floor(serviceDelta / 60_000) : 0;
    return { id: row.order_id, guildId: input.guildId, playerUserId: row.player_id, orderId: row.order_id,
      orderStatus: row.order_status, serviceMinutes, orderEarningMinor: safeDbInteger(row.order_earning_minor),
      giftEarningMinor: safeDbInteger(row.gift_earning_minor), adjustmentMinor: safeDbInteger(row.adjustment_minor),
      earningStatus: row.earning_status, batchedMinor: safeDbInteger(row.batched_minor), settlementBatched: row.settlement_batched,
      includeOrderActivity: row.include_order_activity, occurredAt: toIso(row.occurred_at), issues };
  });
}

async function insertPlayerReport(client: PoolClient, report: PlayerWeeklyReport): Promise<void> {
  const metrics = report.metrics;
  await client.query(`INSERT INTO player_weekly_reports
    (id,report_key,guild_id,schedule_key,player_user_id,period_start,period_end,cutoff_at,time_zone,currency,status,
     completed_order_count,cancelled_order_count,service_minutes,order_earning_minor,gift_earning_minor,
     adjustment_minor,pending_minor,settlement_ready_minor,batched_minor,detail_snapshot,current_revision,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,1,$22,$22)`, [
    report.id, reportKey(report), report.guildId, report.scheduleKey, report.playerUserId, report.periodStart, report.periodEnd,
    report.cutoffAt, report.timeZone, report.currency, report.status, metrics.completedOrderCount, metrics.cancelledOrderCount,
    metrics.serviceMinutes, metrics.orderEarningMinor, metrics.giftEarningMinor, metrics.adjustmentMinor, metrics.pendingMinor,
    metrics.settlementReadyMinor, metrics.batchedMinor, JSON.stringify(report.detailSnapshot), report.createdAt
  ]);
}

async function insertSummaryReport(client: PoolClient, report: SummaryWeeklyReport): Promise<void> {
  const metrics = report.metrics;
  await client.query(`INSERT INTO weekly_report_summaries
    (id,report_key,guild_id,schedule_key,period_start,period_end,cutoff_at,time_zone,currency,status,
     active_player_count,completed_order_count,cancelled_order_count,exception_count,service_minutes,gross_amount_minor,
     adjustment_minor,pending_minor,net_payable_minor,detail_snapshot,current_revision,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,1,$21,$21)`, [
    report.id, reportKey(report), report.guildId, report.scheduleKey, report.periodStart, report.periodEnd, report.cutoffAt,
    report.timeZone, report.currency, report.status, metrics.activePlayerCount, metrics.completedOrderCount,
    metrics.cancelledOrderCount, metrics.exceptionCount, metrics.serviceMinutes, metrics.grossAmountMinor,
    metrics.adjustmentMinor, metrics.pendingMinor, metrics.netPayableMinor, JSON.stringify(report.detailSnapshot), report.createdAt
  ]);
}

async function insertWeeklyNotification(client: PoolClient, report: PlayerWeeklyReport): Promise<void> {
  const job = notificationJob(report);
  await client.query(`INSERT INTO outbox_events
    (id,event_type,aggregate_type,aggregate_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,'PENDING',1,0,$7,$8,$8,$8) ON CONFLICT (dedupe_key) DO NOTHING`, [
    job.id, job.type, job.aggregateType, job.aggregateId, job.dedupeKey, JSON.stringify(job.payload), job.maxAttempts, job.runAfter
  ]);
}

async function loadPostgresRevisions(client: Pick<Pool, 'query'> | PoolClient, reportId: string, type: WeeklyReportType): Promise<WeeklyReportRevision[]> {
  const column = type === 'PLAYER' ? 'player_weekly_report_id' : 'weekly_report_summary_id';
  const result = await client.query<WeeklyRevisionRow>(`SELECT id,revision_type,revision,snapshot,reason,created_by_staff_id,created_at
    FROM weekly_report_revisions WHERE ${column}=$1 ORDER BY revision`, [reportId]);
  return result.rows.map((row) => ({ id: row.id, reportType: row.revision_type, revision: row.revision,
    snapshot: row.snapshot, reason: row.reason, createdByStaffId: row.created_by_staff_id, createdAt: toIso(row.created_at) }));
}

function mapWeeklyReportRow(row: WeeklyReportRow, type: WeeklyReportType, revisions: WeeklyReportRevision[]): WeeklyReport {
  const base = { id: row.id, reportType: type, guildId: row.guild_id, scheduleKey: row.schedule_key,
    periodStart: toIso(row.period_start), periodEnd: toIso(row.period_end), cutoffAt: toIso(row.cutoff_at),
    timeZone: row.time_zone, currency: row.currency, status: row.status, detailSnapshot: row.detail_snapshot,
    currentRevision: row.current_revision, revisions, createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at) };
  const metrics: WeeklyReportMetrics = revisions.at(-1)?.snapshot ?? (type === 'PLAYER' ? {
    completedOrderCount: row.completed_order_count!, cancelledOrderCount: row.cancelled_order_count!, serviceMinutes: row.service_minutes,
    orderEarningMinor: safeDbInteger(row.order_earning_minor!), giftEarningMinor: safeDbInteger(row.gift_earning_minor!),
    adjustmentMinor: safeDbInteger(row.adjustment_minor), pendingMinor: safeDbInteger(row.pending_minor),
    settlementReadyMinor: safeDbInteger(row.settlement_ready_minor!), batchedMinor: safeDbInteger(row.batched_minor!)
  } : {
    activePlayerCount: row.active_player_count!, completedOrderCount: row.completed_order_count!,
    cancelledOrderCount: row.cancelled_order_count!, exceptionCount: row.exception_count!, serviceMinutes: row.service_minutes,
    grossAmountMinor: safeDbInteger(row.gross_amount_minor!), adjustmentMinor: safeDbInteger(row.adjustment_minor),
    pendingMinor: safeDbInteger(row.pending_minor), netPayableMinor: safeDbInteger(row.net_payable_minor!)
  });
  return type === 'PLAYER' ? { ...base, reportType: 'PLAYER', playerUserId: row.player_user_id!, metrics: metrics as PlayerWeeklyReportMetrics }
    : { ...base, reportType: 'SUMMARY', playerUserId: null, metrics: metrics as SummaryWeeklyReportMetrics };
}

async function findPostgresReportType(client: PoolClient, reportId: string): Promise<WeeklyReportType | null> {
  const result = await client.query<{ report_type: WeeklyReportType }>(`SELECT 'PLAYER'::text report_type FROM player_weekly_reports WHERE id=$1
    UNION ALL SELECT 'SUMMARY'::text FROM weekly_report_summaries WHERE id=$1`, [reportId]);
  return result.rows[0]?.report_type ?? null;
}

function generationKey(input: WeeklyReportGenerationInput): string {
  return `${input.guildId}:${input.scheduleKey}:${input.periodStart}:${input.periodEnd}:${input.currency}`;
}

function reportKey(report: WeeklyReport): string {
  return `${generationKey(report)}:${report.reportType}${report.reportType === 'PLAYER' ? `:${report.playerUserId}` : ''}`;
}

function revisionFingerprint(reportId: string, input: WeeklyReportRevisionInput): string {
  return createHash('sha256').update(stableJson({ reportId, reportType: input.reportType,
    expectedRevision: input.expectedRevision, reason: input.reason.trim(), snapshot: input.snapshot,
    actorStaffId: input.actorStaffId })).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function mapPostgresError(error: unknown): Error {
  if (error instanceof WeeklyReportError) return error;
  const code = error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : '';
  if (code === '23505' || code === '40001' || code === '40P01') return new WeeklyReportError('CONFLICT', 'Weekly report write conflicted with another request.');
  if (code === '23514' || code === '23503') return new WeeklyReportError('VALIDATION_ERROR', 'Weekly report data violates a database constraint.');
  return error instanceof Error ? error : new Error(String(error));
}

function safeDbInteger(value: string | number | bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new WeeklyReportError('VALIDATION_ERROR', 'Weekly report amount exceeds the safe integer range.');
  return number;
}

function toIso(value: string | Date): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }

interface WeeklyFactRow {
  order_id: string; player_id: string; order_status: WeeklyReportFact['orderStatus']; service_started_at: Date | null;
  completed_at: Date | null; cancelled_at: Date | null; occurred_at: Date; earning_id: string | null;
  order_earning_minor: string | number | bigint; earning_status: WeeklyReportEarningStatus;
  adjustment_minor: string | number | bigint; gift_earning_minor: string | number | bigint; batched_minor: string | number | bigint;
  settlement_batched: boolean; include_order_activity: boolean;
}

interface WeeklyRevisionRow {
  id: string; revision_type: WeeklyReportType; revision: number; snapshot: WeeklyReportMetrics;
  reason: string; created_by_staff_id: string; created_at: string | Date;
}

interface WeeklyReportRow {
  id: string; guild_id: string; schedule_key: string; player_user_id: string | null; period_start: string | Date;
  period_end: string | Date; cutoff_at: string | Date; time_zone: string; currency: string; status: WeeklyReportStatus;
  completed_order_count: number | null; cancelled_order_count: number | null; service_minutes: number;
  order_earning_minor: string | number | bigint | null; gift_earning_minor: string | number | bigint | null;
  adjustment_minor: string | number | bigint; pending_minor: string | number | bigint;
  settlement_ready_minor: string | number | bigint | null; batched_minor: string | number | bigint | null;
  active_player_count: number | null; exception_count: number | null; gross_amount_minor: string | number | bigint | null;
  net_payable_minor: string | number | bigint | null; detail_snapshot: Record<string, unknown>; current_revision: number;
  created_at: string | Date; updated_at: string | Date;
}

function notificationJob(report: PlayerWeeklyReport): OutboxJob {
  return { id: deterministicUuid(`weekly-report-notify-job:${report.id}`), type: 'WEEKLY_REPORT_NOTIFY', status: 'PENDING',
    payload: { reportId: report.id, guildId: report.guildId }, aggregateType: 'player_weekly_report', aggregateId: report.id,
    dedupeKey: `weekly-report:notify:${report.id}:v${report.currentRevision}`, attempts: 0, maxAttempts: 8,
    runAfter: report.createdAt, lockedAt: null, lockedBy: null, completedAt: null, lastError: null, version: 1,
    createdAt: report.createdAt, updatedAt: report.createdAt };
}

function parseGenerationPayload(value: unknown): WeeklyReportGenerationInput {
  const body = value as Record<string, unknown> | null;
  const result = { guildId: body?.guildId, scheduleKey: body?.scheduleKey, periodStart: body?.periodStart, periodEnd: body?.periodEnd,
    cutoffAt: body?.cutoffAt, timeZone: body?.timeZone, currency: body?.currency };
  if (Object.values(result).some((item) => typeof item !== 'string')) throw new WeeklyReportError('VALIDATION_ERROR', 'Weekly report generation payload is invalid.');
  return result as WeeklyReportGenerationInput;
}

function parseRevision(value: unknown): Pick<WeeklyReportRevisionInput, 'reportType' | 'expectedRevision' | 'reason' | 'snapshot'> {
  const body = value as Record<string, unknown> | null;
  if (!body || !['PLAYER', 'SUMMARY'].includes(String(body.reportType)) || !Number.isInteger(body.expectedRevision) ||
    typeof body.reason !== 'string' || body.reason.trim().length < 2 || body.reason.length > 1000 || !body.snapshot || typeof body.snapshot !== 'object') {
    throw new WeeklyReportError('VALIDATION_ERROR', 'reportType, expectedRevision, reason, and snapshot are required.');
  }
  validateMetrics(body.reportType as WeeklyReportType, body.snapshot as WeeklyReportMetrics);
  return { reportType: body.reportType as WeeklyReportType, expectedRevision: body.expectedRevision as number,
    reason: body.reason.trim(), snapshot: clone(body.snapshot as WeeklyReportMetrics) };
}

function validateMetrics(type: WeeklyReportType, metrics: WeeklyReportMetrics): void {
  const keys = type === 'PLAYER'
    ? ['completedOrderCount', 'cancelledOrderCount', 'serviceMinutes', 'orderEarningMinor', 'giftEarningMinor', 'adjustmentMinor', 'pendingMinor', 'settlementReadyMinor', 'batchedMinor']
    : ['activePlayerCount', 'completedOrderCount', 'cancelledOrderCount', 'exceptionCount', 'serviceMinutes', 'grossAmountMinor', 'adjustmentMinor', 'pendingMinor', 'netPayableMinor'];
  if (Object.keys(metrics).length !== keys.length || keys.some((key) => !Number.isSafeInteger((metrics as unknown as Record<string, unknown>)[key]))) {
    throw new WeeklyReportError('VALIDATION_ERROR', 'Weekly report metric snapshot is invalid.');
  }
  for (const key of keys.filter((key) => !key.toLowerCase().includes('adjustment') && !key.toLowerCase().includes('earning'))) {
    if (Number((metrics as unknown as Record<string, unknown>)[key]) < 0) throw new WeeklyReportError('VALIDATION_ERROR', 'Weekly report metric snapshot is invalid.');
  }
}

function validateGenerationInput(input: WeeklyReportGenerationInput): void {
  const start = Date.parse(input.periodStart); const end = Date.parse(input.periodEnd); const cutoff = Date.parse(input.cutoffAt);
  if (!input.guildId.trim() || !input.scheduleKey.trim() || !Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(cutoff) ||
    start >= end || cutoff < end || input.currency !== 'CAT') throw new WeeklyReportError('VALIDATION_ERROR', 'Weekly report generation input is invalid.');
  assertTimeZone(input.timeZone);
}

function assertTimeZone(timeZone: string): void {
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date()); }
  catch { throw new WeeklyReportError('VALIDATION_ERROR', 'timeZone is invalid.'); }
}

function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return { year: values.year!, month: values.month!, day: values.day! };
}

function localMidnightToInstant(parts: { year: number; month: number; day: number }, timeZone: string): Date {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day);
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
    const values = Object.fromEntries(rendered.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    const represented = Date.UTC(values.year!, values.month! - 1, values.day!, values.hour!, values.minute!, values.second!);
    guess += desired - represented;
  }
  return new Date(guess);
}

function requireGuild(actor: ActorContext): string {
  if (!actor.guildId) throw new WeeklyReportError('PERMISSION_DENIED', 'A Guild-scoped actor is required.');
  return actor.guildId;
}

async function resolveCurrentPlayer(store: WeeklyReportStore, actor: ActorContext): Promise<string> {
  if (!actor.guildId || !actor.discordUserId) throw new WeeklyReportError('PERMISSION_DENIED', 'A player account is required.');
  const player = await store.resolvePlayerUserId({ guildId: actor.guildId, discordUserId: actor.discordUserId });
  if (!player) throw new WeeklyReportError('PERMISSION_DENIED', 'A player account is required.');
  return player;
}

function requireReport(report: WeeklyReport | null): WeeklyReport {
  if (!report) throw new WeeklyReportError('NOT_FOUND', 'Weekly report was not found.');
  return report;
}

function reportIdParam(request: FastifyRequest): string {
  const id = (request.params as { weeklyReportId?: unknown }).weeklyReportId;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(id)) throw new WeeklyReportError('VALIDATION_ERROR', 'weeklyReportId is invalid.');
  return id;
}

function pageLimit(request: FastifyRequest): number {
  const raw = (request.query as { limit?: unknown }).limit;
  if (raw === undefined) return 50;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new WeeklyReportError('VALIDATION_ERROR', 'limit must be between 1 and 100.');
  return value;
}

async function weeklyReportPage(request: FastifyRequest, load: (limit: number) => Promise<WeeklyReport[]> | WeeklyReport[]) {
  const limit = pageLimit(request);
  const rawCursor = (request.query as { cursor?: unknown }).cursor;
  let offset = 0;
  if (rawCursor !== undefined) {
    try { offset = decodeOffsetCursor(String(rawCursor), 'weekly-reports'); }
    catch { throw new WeeklyReportError('VALIDATION_ERROR', 'cursor is invalid.'); }
  }
  const loaded = await load(offset + limit + 1);
  const items = loaded.slice(offset, offset + limit);
  const nextCursor = loaded.length > offset + limit
    ? encodeOffsetCursor('weekly-reports', offset + limit) : null;
  return { items, nextCursor };
}

function mapCurrentPlayerWeeklyReport(report: WeeklyReport): CurrentPlayerWeeklyReportDto {
  if (report.reportType !== 'PLAYER') throw new WeeklyReportError('NOT_FOUND', 'Weekly report was not found.');
  const metrics = report.metrics;
  return {
    id: report.id, reportType: 'PLAYER', periodStart: report.periodStart, periodEnd: report.periodEnd,
    timeZone: report.timeZone, currency: report.currency, status: report.status, currentRevision: report.currentRevision,
    metrics: {
      completedOrderCount: metrics.completedOrderCount, cancelledOrderCount: metrics.cancelledOrderCount,
      serviceMinutes: metrics.serviceMinutes, orderEarningMinor: metrics.orderEarningMinor,
      giftEarningMinor: metrics.giftEarningMinor, adjustmentMinor: metrics.adjustmentMinor,
      pendingMinor: metrics.pendingMinor, settlementReadyMinor: metrics.settlementReadyMinor, batchedMinor: metrics.batchedMinor
    }
  };
}

function mapWeeklyReportError(error: unknown) {
  if (!(error instanceof WeeklyReportError)) return null;
  const statusCode = error.code === 'NOT_FOUND' ? 404 : error.code === 'PERMISSION_DENIED' ? 403 :
    ['CONFLICT', 'REPORT_TYPE_MISMATCH'].includes(error.code) ? 409 : 400;
  return { statusCode, code: error.code, message: error.message };
}

function deterministicUuid(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function sum(values: number[]): number {
  const total = values.reduce((result, value) => result + value, 0);
  if (!Number.isSafeInteger(total)) throw new WeeklyReportError('VALIDATION_ERROR', 'Weekly report amount exceeds the safe integer range.');
  return total;
}

function csvCell(value: unknown): string {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function snakeCase(value: string): string { return value.replace(/[A-Z]/gu, (char) => `_${char.toLowerCase()}`); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
