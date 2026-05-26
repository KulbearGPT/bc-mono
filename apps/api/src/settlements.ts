import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { levelRank } from './authorization-policy.js';
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

export type SettlementBatchStatus =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'EXPORTED'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'VOIDED';
export type SettlementItemPaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';
export type SettlementBatchSource = 'SCHEDULED' | 'MANUAL';
export type SettlementEntryType = 'PLAYER_EARNING' | 'EARNING_ADJUSTMENT';
export type SettlementAdjustmentType = 'REVERSAL_DEBIT' | 'CORRECTION_DEBIT' | 'CORRECTION_CREDIT';
export type SettlementPaymentResultStatus = 'SUCCEEDED' | 'FAILED';
export type SettlementExportType = 'SUMMARY' | 'TRANSFER_LIST' | 'ENTRY_DETAIL';

export interface SettlementCandidateAdjustment {
  id: string;
  playerEarningId: string;
  type: SettlementAdjustmentType;
  amountMinor: number;
  currency: string;
  createdAt: string;
}

export interface SettlementCandidateEarning {
  id: string;
  orderId: string;
  guildId: string;
  playerUserId: string;
  playerDisplayName?: string;
  playerDiscordUserId?: string | null;
  externalAccountDisplay?: string | null;
  amountMinor: number;
  currency: string;
  status: 'PENDING' | 'CONFIRMED' | 'PAID' | 'REVERSED';
  confirmedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  adjustments: SettlementCandidateAdjustment[];
}

export interface SettlementCreateInput {
  guildId: string;
  source: SettlementBatchSource;
  scheduleKey: string | null;
  periodStart: string;
  periodEnd: string;
  cutoffAt: string;
  timeZone: string;
  currency: string;
  playerUserIds: string[] | null;
  createdByStaffId: string | null;
}

export interface SettlementEntryRecord {
  id: string;
  entryType: SettlementEntryType;
  playerEarningId: string | null;
  playerEarningAdjustmentId: string | null;
  amountMinor: number;
  currency: string;
  occurredAt: string;
}

export interface SettlementItemRecord {
  id: string;
  playerUserId: string;
  playerDisplayName: string;
  playerDiscordUserId: string | null;
  externalAccountDisplay: string | null;
  grossAmountMinor: number;
  adjustmentAmountMinor: number;
  netAmountMinor: number;
  currency: string;
  paymentStatus: SettlementItemPaymentStatus;
  version: number;
  entries: SettlementEntryRecord[];
  paymentResults: SettlementPaymentResultRecord[];
}

export interface SettlementPaymentResultRecord {
  id: string;
  settlementItemId: string;
  result: SettlementPaymentResultStatus;
  amountMinor: number;
  currency: string;
  externalBatchReference: string | null;
  note: string | null;
  idempotencyKey: string;
  recordedByStaffId: string;
  recordedAt: string;
}

export interface SettlementPreview {
  periodStart: string;
  periodEnd: string;
  cutoffAt: string;
  timeZone: string;
  currency: string;
  grossAmountMinor: number;
  adjustmentAmountMinor: number;
  netAmountMinor: number;
  deferredAdjustmentMinor: number;
  items: SettlementItemRecord[];
}

export interface SettlementBatchRecord extends Omit<SettlementPreview, 'deferredAdjustmentMinor'> {
  id: string;
  guildId: string;
  publicId: string;
  source: SettlementBatchSource;
  scheduleKey: string | null;
  status: SettlementBatchStatus;
  version: number;
  createdByStaffId: string | null;
  submittedByStaffId: string | null;
  approvedByStaffId: string | null;
  voidedByStaffId: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  exportedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  replacementBatchId: string | null;
  createdAt: string;
}

export interface SettlementMutationInput {
  expectedVersion: number;
  reason: string;
  actorStaffId: string;
  actorLevel: StaffLevel;
  now: Date;
}

export interface SettlementVoidInput extends SettlementMutationInput {
  replacementBatchId: string | null;
  replacement: SettlementCreateInput | null;
}

export interface SettlementPaymentResultInput {
  settlementItemId: string;
  expectedVersion: number;
  result: SettlementPaymentResultStatus;
  amountMinor: number;
  currency: string;
  externalBatchReference: string | null;
  note: string | null;
}

export interface SettlementPaymentResultsInput {
  expectedBatchVersion: number;
  results: SettlementPaymentResultInput[];
  requestIdempotencyKey: string;
  actorStaffId: string;
  now: Date;
}

export interface SettlementReviewThresholds {
  manualDualReviewFromMinor: number;
  l4ReviewFromMinor: number;
}

export interface SettlementStore {
  preview(input: SettlementCreateInput): Promise<SettlementPreview> | SettlementPreview;
  create(input: SettlementCreateInput, auditRecord?: AuditRecord): Promise<SettlementBatchRecord> | SettlementBatchRecord;
  list(guildId: string): Promise<SettlementBatchRecord[]> | SettlementBatchRecord[];
  get(guildId: string, id: string): Promise<SettlementBatchRecord> | SettlementBatchRecord;
  submit(guildId: string, id: string, input: SettlementMutationInput, auditRecord?: AuditRecord): Promise<SettlementBatchRecord> | SettlementBatchRecord;
  approve(guildId: string, id: string, input: SettlementMutationInput, thresholds: SettlementReviewThresholds, auditRecord?: AuditRecord): Promise<SettlementBatchRecord> | SettlementBatchRecord;
  recordPaymentResults(guildId: string, id: string, input: SettlementPaymentResultsInput, auditRecord?: AuditRecord): Promise<SettlementBatchRecord> | SettlementBatchRecord;
  void(guildId: string, id: string, input: SettlementVoidInput, auditRecord?: AuditRecord): Promise<SettlementBatchRecord> | SettlementBatchRecord;
}

export class SettlementError extends Error {
  constructor(
    readonly code: 'UNSUPPORTED_CURRENCY' | 'VALIDATION_ERROR' | 'NO_ELIGIBLE_SOURCES' | 'SOURCE_ALREADY_BATCHED' | 'NOT_FOUND' | 'PERMISSION_DENIED' | 'MAKER_CHECKER_REQUIRED' | 'L4_APPROVAL_REQUIRED' | 'CONFLICT',
    message: string
  ) {
    super(message);
    this.name = 'SettlementError';
  }
}

export async function previewSettlement(input: { store: SettlementStore; input: SettlementCreateInput }): Promise<SettlementPreview> {
  validateInput(input.input);
  return clone(await input.store.preview(input.input));
}

export async function createSettlementBatch(input: { store: SettlementStore; input: SettlementCreateInput }): Promise<SettlementBatchRecord> {
  validateInput(input.input);
  return clone(await input.store.create(input.input));
}

export interface SettlementRouteOptions extends SettlementReviewThresholds {
  store: SettlementStore;
  now?: () => Date;
}

export function registerSettlementRoutes(server: FastifyInstance, options: SettlementRouteOptions): void {
  const security = server.securityOptions;
  if (!security) throw new Error('Settlement routes require security options.');
  const now = options.now ?? (() => new Date());
  const auditSink = security.auditSink ?? new InMemoryAuditSink();
  security.auditSink = auditSink;
  const acceptedSources = ['DASHBOARD'] as const;

  registerSecureReadRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/settlement-batches/preview', permission: 'settlement.manage',
    action: 'PREVIEW_SETTLEMENT_BATCH', targetType: 'settlement_batch', acceptedSources: [...acceptedSources],
    handler: (request, actor) => previewSettlement({ store: options.store, input: parseCreateInput(request.body, actor) }),
    mapError: mapSettlementError
  });
  registerSecureReadRoute(server, security, {
    method: 'GET', url: '/api/v1/admin/settlement-batches', permission: 'settlement.read',
    action: 'LIST_SETTLEMENT_BATCHES', targetType: 'settlement_batch', acceptedSources: [...acceptedSources],
    handler: async (_request, actor) => ({ items: await options.store.list(requireGuild(actor)), nextCursor: null }), mapError: mapSettlementError
  });
  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/settlement-batches', permission: 'settlement.manage',
    action: 'CREATE_SETTLEMENT_BATCH', targetType: 'settlement_batch', acceptedSources: [...acceptedSources],
    successStatusCode: 201, fingerprintBody: (request) => parseCreateInput(request.body, null),
    retryCommitFailures: true,
    handler: (request, actor) => stageSettlementCreate(options.store, auditSink, parseCreateInput(request.body, actor)),
    mapError: mapSettlementError
  });
  registerSecureReadRoute(server, security, {
    method: 'GET', url: '/api/v1/admin/settlement-batches/:settlementBatchId', permission: 'settlement.read',
    action: 'GET_SETTLEMENT_BATCH', targetType: 'settlement_batch', targetId: batchIdParam,
    acceptedSources: [...acceptedSources], handler: (request, actor) => options.store.get(requireGuild(actor), batchIdParam(request)), mapError: mapSettlementError
  });
  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/settlement-batches/:settlementBatchId/submit', permission: 'settlement.manage',
    action: 'SUBMIT_SETTLEMENT_BATCH', targetType: 'settlement_batch', targetId: batchIdParam,
    acceptedSources: [...acceptedSources], requiresRecentStepUp: true, fingerprintBody: (request) => parseMutation(request.body),
    successReason: (request) => parseMutation(request.body).reason, mapError: mapSettlementError,
    retryCommitFailures: true,
    handler: (request, actor) => stageSettlementWrite(options.store, auditSink, 'submit', requireGuild(actor), batchIdParam(request), mutationContext(request, actor, now))
  });
  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/settlement-batches/:settlementBatchId/approve', permission: 'settlement.approve',
    action: 'APPROVE_SETTLEMENT_BATCH', targetType: 'settlement_batch', targetId: batchIdParam,
    acceptedSources: [...acceptedSources], requiresRecentStepUp: true, fingerprintBody: (request) => parseMutation(request.body),
    successReason: (request) => parseMutation(request.body).reason, mapError: mapSettlementError,
    retryCommitFailures: true,
    handler: (request, actor) => stageSettlementWrite(options.store, auditSink, 'approve', requireGuild(actor), batchIdParam(request), mutationContext(request, actor, now), options)
  });
  registerSecureReadRoute(server, security, {
    method: 'GET', url: '/api/v1/admin/settlement-batches/:settlementBatchId/exports/:exportType',
    permission: 'settlement.manage', action: 'EXPORT_SETTLEMENT_BATCH', targetType: 'settlement_batch', targetId: batchIdParam,
    acceptedSources: [...acceptedSources], requiresRecentStepUp: true, mapError: mapSettlementError,
    handler: async (request, actor) => {
      const batch = await options.store.get(requireGuild(actor), batchIdParam(request));
      requireStatus(batch, ['APPROVED', 'EXPORTED', 'PARTIALLY_PAID', 'PAID'], 'exported');
      const exportType = exportTypeParam(request);
      return { body: buildSettlementCsv(batch, exportType), filename: `${batch.publicId}-${exportType.toLowerCase()}.csv` };
    },
    rawResponse: (payload, reply) => {
      const csv = payload as { body: string; filename: string };
      reply.type('text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${csv.filename}"`);
      return reply.send(csv.body);
    }
  });
  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/settlement-batches/:settlementBatchId/payment-results',
    permission: 'settlement.manage', action: 'RECORD_SETTLEMENT_PAYMENT_RESULTS', targetType: 'settlement_batch',
    targetId: batchIdParam, acceptedSources: [...acceptedSources], requiresRecentStepUp: true,
    fingerprintBody: (request) => parsePaymentResults(request.body), mapError: mapSettlementError,
    successReason: () => 'EXTERNAL_PAYMENT_RESULTS_RECORDED',
    retryCommitFailures: true,
    handler: (request, actor) => stageSettlementWrite(options.store, auditSink, 'payment', requireGuild(actor), batchIdParam(request), {
      ...parsePaymentResults(request.body), requestIdempotencyKey: idempotencyKey(request),
      actorStaffId: requireStaff(actor).actorStaffId!, now: now()
    })
  });
  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/settlement-batches/:settlementBatchId/void', permission: 'settlement.void',
    action: 'VOID_SETTLEMENT_BATCH', targetType: 'settlement_batch', targetId: batchIdParam,
    acceptedSources: [...acceptedSources], requiresRecentStepUp: true, fingerprintBody: (request) => parseVoidInput(request.body, null, now),
    successReason: (request) => parseMutation(request.body).reason, mapError: mapSettlementError,
    retryCommitFailures: true,
    handler: (request, actor) => stageSettlementWrite(options.store, auditSink, 'void', requireGuild(actor), batchIdParam(request), parseVoidInput(request.body, actor, now))
  });
}

type SettlementWriteKind = 'submit' | 'approve' | 'payment' | 'void';

async function stageSettlementCreate(store: SettlementStore, auditSink: AuditSink, input: SettlementCreateInput) {
  const data = {} as SettlementBatchRecord;
  return {
    data,
    commit: async (auditRecord: AuditRecord) => {
      const created = store instanceof PostgresSettlementStore
        ? await store.create(input, auditRecord)
        : await (async () => { await auditSink.append(auditRecord); return store.create(input); })();
      Object.assign(data, created);
    }
  };
}

async function stageSettlementWrite(
  store: SettlementStore,
  auditSink: AuditSink,
  kind: SettlementWriteKind,
  guildId: string,
  id: string,
  input: SettlementMutationInput | SettlementPaymentResultsInput | SettlementVoidInput,
  thresholds?: SettlementReviewThresholds
) {
  const current = await store.get(guildId, id);
  const simulator = new InMemorySettlementStore({ batches: [current] });
  const data = kind === 'submit' ? simulator.submit(guildId, id, input as SettlementMutationInput)
    : kind === 'approve' ? simulator.approve(guildId, id, input as SettlementMutationInput, thresholds!)
      : kind === 'payment' ? simulator.recordPaymentResults(guildId, id, input as SettlementPaymentResultsInput)
        : { ...current };
  return {
    data,
    commit: async (auditRecord: AuditRecord) => {
      if (store instanceof PostgresSettlementStore) {
        if (kind === 'submit') await store.submit(guildId, id, input as SettlementMutationInput, auditRecord);
        else if (kind === 'approve') await store.approve(guildId, id, input as SettlementMutationInput, thresholds!, auditRecord);
        else if (kind === 'payment') await store.recordPaymentResults(guildId, id, input as SettlementPaymentResultsInput, auditRecord);
        else Object.assign(data, await store.void(guildId, id, input as SettlementVoidInput, auditRecord));
      } else {
        await auditSink.append(auditRecord);
        if (kind === 'submit') await store.submit(guildId, id, input as SettlementMutationInput);
        else if (kind === 'approve') await store.approve(guildId, id, input as SettlementMutationInput, thresholds!);
        else if (kind === 'payment') await store.recordPaymentResults(guildId, id, input as SettlementPaymentResultsInput);
        else Object.assign(data, await store.void(guildId, id, input as SettlementVoidInput));
      }
    }
  };
}

export class InMemorySettlementStore implements SettlementStore {
  readonly earnings: SettlementCandidateEarning[];
  readonly batches: SettlementBatchRecord[];

  constructor(input: { earnings?: SettlementCandidateEarning[]; batches?: SettlementBatchRecord[] } = {}) {
    this.earnings = clone(input.earnings ?? []);
    this.batches = clone(input.batches ?? []);
  }

  preview(input: SettlementCreateInput): SettlementPreview {
    return buildPreview(input, this.earnings, this.batches);
  }

  create(input: SettlementCreateInput): SettlementBatchRecord {
    return this.createBatch(input);
  }

  private createBatch(input: SettlementCreateInput, forcedId?: string): SettlementBatchRecord {
    const scheduleIdentity = automaticIdentity(input);
    if (scheduleIdentity) {
      const existing = this.batches.find((batch) => automaticIdentity(batch) === scheduleIdentity);
      if (existing) return clone(existing);
    }
    const preview = buildPreview(input, this.earnings, this.batches);
    if (preview.items.length === 0) {
      if (hasBlockedEarning(input, this.earnings, this.batches)) {
        throw new SettlementError('SOURCE_ALREADY_BATCHED', 'An eligible earning is already linked to a non-void settlement batch.');
      }
      throw new SettlementError('NO_ELIGIBLE_SOURCES', 'No eligible settlement sources were found.');
    }

    const identity = scheduleIdentity ?? [input.periodStart, input.periodEnd, input.currency, this.batches.length + 1].join(':');
    const id = forcedId ?? deterministicUuid(`settlement-batch:${identity}`);
    if (this.batches.some((candidate) => candidate.id === id)) {
      throw new SettlementError('CONFLICT', 'Settlement batch ID is already in use.');
    }
    const items = materializeItemIds(preview.items, id);
    const batch: SettlementBatchRecord = {
      periodStart: preview.periodStart,
      periodEnd: preview.periodEnd,
      cutoffAt: preview.cutoffAt,
      timeZone: preview.timeZone,
      currency: preview.currency,
      grossAmountMinor: preview.grossAmountMinor,
      adjustmentAmountMinor: preview.adjustmentAmountMinor,
      netAmountMinor: preview.netAmountMinor,
      items,
      id,
      guildId: input.guildId,
      publicId: `SET-${id.replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      source: input.source,
      scheduleKey: input.scheduleKey,
      status: 'DRAFT',
      version: 1,
      createdByStaffId: input.createdByStaffId,
      submittedByStaffId: null,
      approvedByStaffId: null,
      voidedByStaffId: null,
      submittedAt: null,
      approvedAt: null,
      exportedAt: null,
      voidedAt: null,
      voidReason: null,
      replacementBatchId: null,
      createdAt: new Date().toISOString()
    };
    this.batches.push(clone(batch));
    return clone(batch);
  }

  list(guildId: string): SettlementBatchRecord[] {
    return clone(this.batches.filter((batch) => batch.guildId === guildId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  }

  get(guildId: string, id: string): SettlementBatchRecord {
    return clone(requireBatch(this.batches, id, guildId));
  }

  submit(guildId: string, id: string, input: SettlementMutationInput): SettlementBatchRecord {
    const batch = requireBatch(this.batches, id, guildId);
    requireVersion(batch.version, input.expectedVersion, 'Settlement batch');
    requireStatus(batch, ['DRAFT'], 'submitted');
    Object.assign(batch, {
      status: 'PENDING_REVIEW' as const,
      version: batch.version + 1,
      submittedByStaffId: input.actorStaffId,
      submittedAt: input.now.toISOString()
    });
    return clone(batch);
  }

  approve(guildId: string, id: string, input: SettlementMutationInput, thresholds: SettlementReviewThresholds): SettlementBatchRecord {
    const batch = requireBatch(this.batches, id, guildId);
    requireVersion(batch.version, input.expectedVersion, 'Settlement batch');
    requireStatus(batch, ['PENDING_REVIEW'], 'approved');
    enforceApprovalPolicy(batch, input, thresholds);
    Object.assign(batch, {
      status: 'APPROVED' as const,
      version: batch.version + 1,
      approvedByStaffId: input.actorStaffId,
      approvedAt: input.now.toISOString()
    });
    return clone(batch);
  }

  recordPaymentResults(guildId: string, id: string, input: SettlementPaymentResultsInput): SettlementBatchRecord {
    const batch = requireBatch(this.batches, id, guildId);
    requireVersion(batch.version, input.expectedBatchVersion, 'Settlement batch');
    requireStatus(batch, ['APPROVED', 'EXPORTED', 'PARTIALLY_PAID'], 'record payment results');
    const prepared = preparePaymentResults(batch, input);
    if (batch.status === 'APPROVED') {
      batch.status = 'EXPORTED';
      batch.exportedAt = input.now.toISOString();
      batch.version += 1;
    }
    for (const { item, record } of prepared) {
      item.paymentResults.push(record);
      item.paymentStatus = record.result;
      item.version += 1;
      if (record.result === 'SUCCEEDED') {
        const earningIds = new Set(item.entries.map((entry) => entry.playerEarningId).filter((value): value is string => Boolean(value)));
        for (const earning of this.earnings) {
          if (earningIds.has(earning.id)) {
            earning.status = 'PAID';
            earning.paidAt = input.now.toISOString();
          }
        }
      }
    }
    const allPaid = batch.items.every((item) => item.paymentStatus === 'SUCCEEDED');
    const anyPaid = batch.items.some((item) => item.paymentStatus === 'SUCCEEDED');
    batch.status = allPaid ? 'PAID' : anyPaid ? 'PARTIALLY_PAID' : batch.status;
    batch.version += 1;
    return clone(batch);
  }

  void(guildId: string, id: string, input: SettlementVoidInput): SettlementBatchRecord {
    const batch = requireBatch(this.batches, id, guildId);
    requireVersion(batch.version, input.expectedVersion, 'Settlement batch');
    requireStatus(batch, ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'EXPORTED'], 'voided');
    validateReplacementRequest(batch, input);
    const before = clone(batch);
    const batchCount = this.batches.length;
    Object.assign(batch, {
      status: 'VOIDED' as const,
      version: batch.version + 1,
      voidedByStaffId: input.actorStaffId,
      voidedAt: input.now.toISOString(),
      voidReason: input.reason
    });
    if (input.replacement && input.replacementBatchId) {
      try {
        const replacement = this.createBatch({
          ...input.replacement,
          guildId,
          currency: batch.currency,
          createdByStaffId: input.actorStaffId
        }, input.replacementBatchId);
        batch.replacementBatchId = replacement.id;
      } catch (error) {
        this.batches.splice(batchCount);
        Object.assign(batch, before);
        throw error;
      }
    }
    return clone(batch);
  }
}

export interface SettlementDatabaseClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export class PostgresSettlementStore implements SettlementStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async preview(input: SettlementCreateInput): Promise<SettlementPreview> {
    const earnings = await loadPostgresCandidates(this.pool, input, false);
    const batches = await loadPostgresMemberships(this.pool, input.guildId);
    return buildPreview(input, earnings, batches);
  }

  async create(input: SettlementCreateInput, auditRecord?: AuditRecord): Promise<SettlementBatchRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const replay = await findScheduledBatch(client, input);
      if (replay) {
        if (auditRecord) await insertPostgresAuditRecord(client, auditRecord);
        await client.query('COMMIT');
        return replay;
      }
      await lockSettlementSources(client, input);
      const replayAfterSourceLock = await findScheduledBatch(client, input);
      if (replayAfterSourceLock) {
        if (auditRecord) await insertPostgresAuditRecord(client, auditRecord);
        await client.query('COMMIT');
        return replayAfterSourceLock;
      }
      const earnings = await loadPostgresCandidates(client, input, true);
      const batches = await loadPostgresMemberships(client, input.guildId);
      const preview = buildPreview(input, earnings, batches);
      if (preview.items.length === 0) {
        if (hasBlockedEarning(input, earnings, batches)) {
          throw new SettlementError('SOURCE_ALREADY_BATCHED', 'An eligible earning is already linked to a non-void settlement batch.');
        }
        throw new SettlementError('NO_ELIGIBLE_SOURCES', 'No eligible settlement sources were found.');
      }
      const batch = await insertPostgresBatch(client, input, preview);
      if (auditRecord) await insertPostgresAuditRecord(client, auditRecord);
      await client.query('COMMIT');
      return batch;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isPostgresConflict(error)) throw new SettlementError('SOURCE_ALREADY_BATCHED', 'A settlement source was claimed concurrently.');
      throw error;
    } finally {
      client.release();
    }
  }

  async list(guildId: string): Promise<SettlementBatchRecord[]> {
    const result = await this.pool.query<{ id: string }>(
      'SELECT id FROM settlement_batches WHERE guild_id=$1 ORDER BY created_at DESC,id DESC', [guildId]
    );
    return Promise.all(result.rows.map((row) => loadPostgresBatch(this.pool, row.id, guildId)));
  }

  async get(guildId: string, id: string): Promise<SettlementBatchRecord> {
    return loadPostgresBatch(this.pool, id, guildId);
  }

  async submit(guildId: string, id: string, input: SettlementMutationInput, auditRecord?: AuditRecord): Promise<SettlementBatchRecord> {
    return this.mutateBatch(guildId, id, async (client, batch) => {
      requireVersion(batch.version, input.expectedVersion, 'Settlement batch');
      requireStatus(batch, ['DRAFT'], 'submitted');
      const updated = await client.query(
        `UPDATE settlement_batches SET status='PENDING_REVIEW',submitted_by_staff_id=$1,submitted_at=$2,
           row_version=row_version+1,updated_at=$2 WHERE id=$3 AND row_version=$4 AND status='DRAFT'`,
        [input.actorStaffId, input.now.toISOString(), id, input.expectedVersion]
      );
      if (updated.rowCount !== 1) throw new SettlementError('CONFLICT', 'Settlement batch changed concurrently.');
    }, auditRecord);
  }

  async approve(guildId: string, id: string, input: SettlementMutationInput, thresholds: SettlementReviewThresholds, auditRecord?: AuditRecord): Promise<SettlementBatchRecord> {
    return this.mutateBatch(guildId, id, async (client, batch) => {
      requireVersion(batch.version, input.expectedVersion, 'Settlement batch');
      requireStatus(batch, ['PENDING_REVIEW'], 'approved');
      enforceApprovalPolicy(batch, input, thresholds);
      const updated = await client.query(
        `UPDATE settlement_batches SET status='APPROVED',approved_by_staff_id=$1,approved_at=$2,
           row_version=row_version+1,updated_at=$2 WHERE id=$3 AND row_version=$4 AND status='PENDING_REVIEW'`,
        [input.actorStaffId, input.now.toISOString(), id, input.expectedVersion]
      );
      if (updated.rowCount !== 1) throw new SettlementError('CONFLICT', 'Settlement batch changed concurrently.');
    }, auditRecord);
  }

  async recordPaymentResults(guildId: string, id: string, input: SettlementPaymentResultsInput, auditRecord?: AuditRecord): Promise<SettlementBatchRecord> {
    return this.mutateBatch(guildId, id, async (client, batch) => {
      requireVersion(batch.version, input.expectedBatchVersion, 'Settlement batch');
      requireStatus(batch, ['APPROVED', 'EXPORTED', 'PARTIALLY_PAID'], 'record payment results');
      const prepared = preparePaymentResults(batch, input);
      let currentVersion = input.expectedBatchVersion;
      if (batch.status === 'APPROVED') {
        const exported = await client.query(
          `UPDATE settlement_batches SET status='EXPORTED',exported_at=$1,row_version=row_version+1,updated_at=$1
           WHERE id=$2 AND row_version=$3 AND status='APPROVED'`,
          [input.now.toISOString(), id, currentVersion]
        );
        if (exported.rowCount !== 1) throw new SettlementError('CONFLICT', 'Settlement batch changed concurrently.');
        currentVersion += 1;
        batch.status = 'EXPORTED';
      }
      for (const { item, record } of prepared) {
        await client.query(
          `INSERT INTO settlement_payment_results
             (id,settlement_item_id,result,amount_minor,currency,external_batch_reference,note,idempotency_key,recorded_by_staff_id,recorded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [record.id, item.id, record.result, record.amountMinor, record.currency, record.externalBatchReference,
            record.note, record.idempotencyKey, record.recordedByStaffId, record.recordedAt]
        );
      }
      const projection = await client.query<{ total: string; paid: string }>(
        `SELECT count(*)::text total,count(*) FILTER (WHERE payment_status='SUCCEEDED')::text paid
         FROM settlement_items WHERE settlement_batch_id=$1`, [id]
      );
      const total = Number(projection.rows[0]?.total ?? 0);
      const paid = Number(projection.rows[0]?.paid ?? 0);
      const nextStatus: SettlementBatchStatus = paid === total ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : batch.status;
      const batchUpdate = await client.query(
        `UPDATE settlement_batches SET status=$1,row_version=row_version+1,updated_at=$2
         WHERE id=$3 AND row_version=$4 AND status IN ('EXPORTED','PARTIALLY_PAID')`,
        [nextStatus, input.now.toISOString(), id, currentVersion]
      );
      if (batchUpdate.rowCount !== 1) throw new SettlementError('CONFLICT', 'Settlement batch changed concurrently.');
    }, auditRecord);
  }

  async void(guildId: string, id: string, input: SettlementVoidInput, auditRecord?: AuditRecord): Promise<SettlementBatchRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const batch = await loadPostgresBatch(client, id, guildId, true);
      requireVersion(batch.version, input.expectedVersion, 'Settlement batch');
      requireStatus(batch, ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'EXPORTED'], 'voided');
      validateReplacementRequest(batch, input);
      if (input.replacement) await lockSettlementSources(client, input.replacement);
      const updated = await client.query(
        `UPDATE settlement_batches SET status='VOIDED',voided_by_staff_id=$1,voided_at=$2,void_reason=$3,
           row_version=row_version+1,updated_at=$2
         WHERE id=$4 AND guild_id=$5 AND row_version=$6 AND status IN ('DRAFT','PENDING_REVIEW','APPROVED','EXPORTED')`,
        [input.actorStaffId, input.now.toISOString(), input.reason, id, guildId, input.expectedVersion]
      );
      if (updated.rowCount !== 1) throw new SettlementError('CONFLICT', 'Settlement batch changed concurrently.');
      if (input.replacement && input.replacementBatchId) {
        const replacementInput = { ...input.replacement, guildId, currency: batch.currency, createdByStaffId: input.actorStaffId };
        const earnings = await loadPostgresCandidates(client, replacementInput, true);
        const batches = await loadPostgresMemberships(client, guildId);
        const preview = buildPreview(replacementInput, earnings, batches);
        if (preview.items.length === 0) throw new SettlementError('NO_ELIGIBLE_SOURCES', 'No eligible replacement sources were found.');
        await insertPostgresBatch(client, replacementInput, preview, input.replacementBatchId);
        await client.query('UPDATE settlement_batches SET replacement_batch_id=$1,updated_at=$2 WHERE id=$3 AND guild_id=$4',
          [input.replacementBatchId, input.now.toISOString(), id, guildId]);
      }
      if (auditRecord) await insertPostgresAuditRecord(client, auditRecord);
      const result = await loadPostgresBatch(client, id, guildId);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async mutateBatch(
    guildId: string,
    id: string,
    mutation: (client: PoolClient, batch: SettlementBatchRecord) => Promise<void>,
    auditRecord?: AuditRecord
  ): Promise<SettlementBatchRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ id: string }>('SELECT id FROM settlement_batches WHERE id=$1 AND guild_id=$2 FOR UPDATE', [id, guildId]);
      if (!locked.rows[0]) throw new SettlementError('NOT_FOUND', 'Settlement batch was not found.');
      const batch = await loadPostgresBatch(client, id, guildId);
      await mutation(client, batch);
      if (auditRecord) await insertPostgresAuditRecord(client, auditRecord);
      const result = await loadPostgresBatch(client, id, guildId);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function parseCreateInput(value: unknown, actor: ActorContext | null): SettlementCreateInput {
  const body = value as Record<string, unknown>;
  if (!body || !['SCHEDULED', 'MANUAL'].includes(String(body.source))
    || typeof body.periodStart !== 'string' || typeof body.periodEnd !== 'string'
    || typeof body.timeZone !== 'string' || typeof body.currency !== 'string') {
    throw new SettlementError('VALIDATION_ERROR', 'source, periodStart, periodEnd, timeZone, and currency are required.');
  }
  const players = body.playerUserIds;
  if (players !== undefined && (!Array.isArray(players) || players.some((id) => typeof id !== 'string'))) {
    throw new SettlementError('VALIDATION_ERROR', 'playerUserIds must be an array of user IDs.');
  }
  const periodEnd = new Date(body.periodEnd).toISOString();
  return {
    guildId: actor ? requireGuild(actor) : '',
    source: body.source as SettlementBatchSource,
    scheduleKey: typeof body.scheduleKey === 'string' ? body.scheduleKey : null,
    periodStart: new Date(body.periodStart).toISOString(), periodEnd,
    cutoffAt: typeof body.cutoffAt === 'string' ? new Date(body.cutoffAt).toISOString() : periodEnd,
    timeZone: body.timeZone, currency: body.currency,
    playerUserIds: (players as string[] | undefined) ?? null,
    createdByStaffId: actor ? requireStaff(actor).actorStaffId : null
  };
}

function parseMutation(value: unknown): { expectedVersion: number; reason: string } {
  const body = value as Record<string, unknown>;
  const reasonCode = typeof body?.reasonCode === 'string' ? body.reasonCode.trim() : '';
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  if (!Number.isInteger(body?.expectedVersion) || Number(body.expectedVersion) < 1 || reasonCode.length < 2) {
    throw new SettlementError('VALIDATION_ERROR', 'expectedVersion and reasonCode are required.');
  }
  return { expectedVersion: body.expectedVersion as number, reason: note ? `${reasonCode}: ${note}` : reasonCode };
}

function parsePaymentResults(value: unknown): Pick<SettlementPaymentResultsInput, 'expectedBatchVersion' | 'results'> {
  const body = value as Record<string, unknown>;
  if (!Number.isInteger(body?.expectedBatchVersion) || Number(body.expectedBatchVersion) < 1 || !Array.isArray(body?.results)) {
    throw new SettlementError('VALIDATION_ERROR', 'expectedBatchVersion and results are required.');
  }
  const results = body.results.map((raw) => {
    const result = raw as Record<string, unknown>;
    if (typeof result?.settlementItemId !== 'string' || !Number.isInteger(result.expectedVersion)
      || !['SUCCEEDED', 'FAILED'].includes(String(result.result)) || !Number.isInteger(result.amountMinor)
      || typeof result.currency !== 'string') {
      throw new SettlementError('VALIDATION_ERROR', 'Each payment result requires item, version, result, amount, and currency.');
    }
    return {
      settlementItemId: result.settlementItemId, expectedVersion: result.expectedVersion as number,
      result: result.result as SettlementPaymentResultStatus, amountMinor: result.amountMinor as number,
      currency: result.currency,
      externalBatchReference: typeof result.externalBatchReference === 'string' ? result.externalBatchReference : null,
      note: typeof result.note === 'string' ? result.note : null
    };
  });
  return { expectedBatchVersion: body.expectedBatchVersion as number, results };
}

function mutationContext(request: FastifyRequest, actor: ActorContext, now: () => Date): SettlementMutationInput {
  const parsed = parseMutation(request.body);
  const staff = requireStaff(actor);
  return { ...parsed, actorStaffId: staff.actorStaffId!, actorLevel: staff.actorLevel!, now: now() };
}

function parseVoidInput(value: unknown, actor: ActorContext | null, now: () => Date): SettlementVoidInput {
  const body = value as Record<string, unknown>;
  const parsed = parseMutation(value);
  const replacementBatchId = typeof body?.replacementBatchId === 'string' ? body.replacementBatchId : null;
  const replacement = body?.replacement == null ? null : parseCreateInput(body.replacement, actor);
  if (Boolean(replacementBatchId) !== Boolean(replacement)) {
    throw new SettlementError('VALIDATION_ERROR', 'replacementBatchId and replacement must be provided together.');
  }
  const staff = actor ? requireStaff(actor) : null;
  return {
    ...parsed,
    replacementBatchId,
    replacement,
    actorStaffId: staff?.actorStaffId ?? '',
    actorLevel: staff?.actorLevel ?? 'L1_SUPPORT',
    now: now()
  };
}

function requireStaff(actor: ActorContext): ActorContext & { actorStaffId: string; actorLevel: StaffLevel } {
  if (!actor.actorStaffId || !actor.actorLevel) throw new SettlementError('PERMISSION_DENIED', 'A staff actor is required.');
  return actor as ActorContext & { actorStaffId: string; actorLevel: StaffLevel };
}

function requireGuild(actor: ActorContext): string {
  const guildId = actor.guildId?.trim();
  if (!guildId) throw new SettlementError('PERMISSION_DENIED', 'Trusted Guild context is required.');
  return guildId;
}

function batchIdParam(request: FastifyRequest): string {
  const id = (request.params as { settlementBatchId?: unknown }).settlementBatchId;
  if (typeof id !== 'string' || id.length < 1) throw new SettlementError('VALIDATION_ERROR', 'settlementBatchId is required.');
  return id;
}

function exportTypeParam(request: FastifyRequest): SettlementExportType {
  const type = (request.params as { exportType?: unknown }).exportType;
  if (!['SUMMARY', 'TRANSFER_LIST', 'ENTRY_DETAIL'].includes(String(type))) {
    throw new SettlementError('VALIDATION_ERROR', 'exportType is invalid.');
  }
  return type as SettlementExportType;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string') throw new SettlementError('VALIDATION_ERROR', 'Idempotency-Key is required.');
  return value;
}

function mapSettlementError(error: unknown) {
  if (!(error instanceof SettlementError)) return null;
  const statusCode = error.code === 'NOT_FOUND' ? 404
    : ['PERMISSION_DENIED', 'MAKER_CHECKER_REQUIRED', 'L4_APPROVAL_REQUIRED'].includes(error.code) ? 403
      : ['VALIDATION_ERROR', 'UNSUPPORTED_CURRENCY'].includes(error.code) ? 400 : 409;
  return { statusCode, code: error.code, message: error.message };
}

export function buildSettlementCsv(batch: SettlementBatchRecord, exportType: SettlementExportType): string {
  const rows: string[][] = [];
  if (exportType === 'SUMMARY') {
    rows.push(['batch_public_id', 'period_start', 'period_end', 'currency', 'gross_amount', 'adjustment_amount', 'net_amount', 'status']);
    rows.push([batch.publicId, batch.periodStart, batch.periodEnd, batch.currency, formatMinor(batch.grossAmountMinor),
      formatMinor(batch.adjustmentAmountMinor), formatMinor(batch.netAmountMinor), batch.status]);
  } else if (exportType === 'TRANSFER_LIST') {
    rows.push(['batch_public_id', 'period_start', 'period_end', 'player_user_id', 'player_display_name', 'discord_user_id',
      'external_account_display', 'currency', 'gross_amount', 'adjustment_amount', 'net_amount', 'payment_status']);
    for (const item of [...batch.items].sort((left, right) => left.playerUserId.localeCompare(right.playerUserId))) {
      if (item.paymentStatus === 'SUCCEEDED') continue;
      rows.push([batch.publicId, batch.periodStart, batch.periodEnd, item.playerUserId, item.playerDisplayName,
        item.playerDiscordUserId ?? '', item.externalAccountDisplay ?? '', item.currency,
        formatMinor(item.grossAmountMinor), formatMinor(item.adjustmentAmountMinor), formatMinor(item.netAmountMinor), item.paymentStatus]);
    }
  } else {
    rows.push(['batch_public_id', 'settlement_item_id', 'player_user_id', 'entry_type', 'source_id', 'occurred_at', 'currency', 'amount']);
    const items = [...batch.items].sort((left, right) => left.playerUserId.localeCompare(right.playerUserId));
    for (const item of items) {
      for (const entry of [...item.entries].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id))) {
        rows.push([batch.publicId, item.id, item.playerUserId, entry.entryType,
          entry.playerEarningId ?? entry.playerEarningAdjustmentId ?? '', entry.occurredAt, entry.currency, formatMinor(entry.amountMinor)]);
      }
    }
  }
  return `\ufeff${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function formatMinor(value: number): string {
  if (!Number.isSafeInteger(value)) throw new SettlementError('VALIDATION_ERROR', 'CSV amount exceeds the supported range.');
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

function validateInput(input: SettlementCreateInput): void {
  if (!input.guildId.trim()) throw new SettlementError('PERMISSION_DENIED', 'Trusted Guild context is required.');
  if (input.currency !== 'USD') throw new SettlementError('UNSUPPORTED_CURRENCY', 'P0 settlements support USD only.');
  if (input.source === 'SCHEDULED' && !input.scheduleKey) {
    throw new SettlementError('VALIDATION_ERROR', 'Scheduled settlements require scheduleKey.');
  }
  if (input.source === 'MANUAL' && input.scheduleKey) {
    throw new SettlementError('VALIDATION_ERROR', 'Manual settlements cannot use scheduleKey.');
  }
  const start = Date.parse(input.periodStart);
  const end = Date.parse(input.periodEnd);
  const cutoff = Date.parse(input.cutoffAt);
  if (![start, end, cutoff].every(Number.isFinite) || start >= end || cutoff < end) {
    throw new SettlementError('VALIDATION_ERROR', 'Settlement period and cutoff are invalid.');
  }
}

function buildPreview(
  input: SettlementCreateInput,
  earnings: SettlementCandidateEarning[],
  batches: SettlementBatchRecord[]
): SettlementPreview {
  const activeEarnings = activeSourceIds(batches, 'PLAYER_EARNING');
  const activeAdjustments = activeSourceIds(batches, 'EARNING_ADJUSTMENT');
  const selectedPlayers = input.playerUserIds ? new Set(input.playerUserIds) : null;
  const byPlayer = new Map<string, SettlementEntryRecord[]>();

  for (const earning of earnings) {
    if (earning.guildId !== input.guildId || earning.currency !== input.currency
      || (selectedPlayers && !selectedPlayers.has(earning.playerUserId))) continue;
    const earningEligible = earning.status === 'CONFIRMED'
      && earning.confirmedAt !== null
      && Date.parse(earning.confirmedAt) <= Date.parse(input.cutoffAt)
      && !activeEarnings.has(earning.id);
    if (earningEligible) {
      addEntry(byPlayer, earning.playerUserId, {
        id: deterministicUuid(`settlement-entry:earning:${earning.id}`),
        entryType: 'PLAYER_EARNING',
        playerEarningId: earning.id,
        playerEarningAdjustmentId: null,
        amountMinor: earning.amountMinor,
        currency: earning.currency,
        occurredAt: earning.confirmedAt!
      });
    }

    const earningWasSettled = activeEarnings.has(earning.id) || earning.status === 'PAID';
    if (!earningEligible && !earningWasSettled) continue;
    for (const adjustment of earning.adjustments) {
      if (adjustment.currency !== input.currency
        || Date.parse(adjustment.createdAt) > Date.parse(input.cutoffAt)
        || activeAdjustments.has(adjustment.id)) continue;
      addEntry(byPlayer, earning.playerUserId, {
        id: deterministicUuid(`settlement-entry:adjustment:${adjustment.id}`),
        entryType: 'EARNING_ADJUSTMENT',
        playerEarningId: null,
        playerEarningAdjustmentId: adjustment.id,
        amountMinor: adjustmentSign(adjustment.type) * adjustment.amountMinor,
        currency: adjustment.currency,
        occurredAt: adjustment.createdAt
      });
    }
  }

  const candidateItems = [...byPlayer.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([playerUserId, entries]) => {
    const playerSnapshot = earnings.find((earning) => earning.playerUserId === playerUserId);
    entries.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
    const grossAmountMinor = sum(entries.filter((entry) => entry.entryType === 'PLAYER_EARNING').map((entry) => entry.amountMinor));
    const adjustmentAmountMinor = sum(entries.filter((entry) => entry.entryType === 'EARNING_ADJUSTMENT').map((entry) => entry.amountMinor));
    return {
      id: deterministicUuid(`settlement-item:${input.periodStart}:${input.periodEnd}:${input.currency}:${playerUserId}`),
      playerUserId,
      playerDisplayName: playerSnapshot?.playerDisplayName ?? playerUserId,
      playerDiscordUserId: playerSnapshot?.playerDiscordUserId ?? null,
      externalAccountDisplay: maskExternalAccountDisplay(playerSnapshot?.externalAccountDisplay ?? null),
      grossAmountMinor,
      adjustmentAmountMinor,
      netAmountMinor: sum([grossAmountMinor, adjustmentAmountMinor]),
      currency: input.currency,
      paymentStatus: 'PENDING' as const,
      version: 1,
      entries,
      paymentResults: []
    };
  });
  const deferredAdjustmentMinor = sum(candidateItems
    .filter((item) => item.netAmountMinor <= 0)
    .map((item) => item.adjustmentAmountMinor));
  const items = candidateItems.filter((item) => item.netAmountMinor > 0);
  const grossAmountMinor = sum(items.map((item) => item.grossAmountMinor));
  const adjustmentAmountMinor = sum(items.map((item) => item.adjustmentAmountMinor));
  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    cutoffAt: input.cutoffAt,
    timeZone: input.timeZone,
    currency: input.currency,
    grossAmountMinor,
    adjustmentAmountMinor,
    netAmountMinor: sum([grossAmountMinor, adjustmentAmountMinor]),
    deferredAdjustmentMinor,
    items
  };
}

function hasBlockedEarning(input: SettlementCreateInput, earnings: SettlementCandidateEarning[], batches: SettlementBatchRecord[]): boolean {
  const activeEarnings = activeSourceIds(batches, 'PLAYER_EARNING');
  const players = input.playerUserIds ? new Set(input.playerUserIds) : null;
  return earnings.some((earning) => earning.status === 'CONFIRMED'
    && earning.guildId === input.guildId
    && earning.currency === input.currency
    && earning.confirmedAt !== null
    && Date.parse(earning.confirmedAt) <= Date.parse(input.cutoffAt)
    && (!players || players.has(earning.playerUserId))
    && activeEarnings.has(earning.id));
}

function activeSourceIds(batches: SettlementBatchRecord[], type: SettlementEntryType): Set<string> {
  return new Set(batches.filter((batch) => batch.status !== 'VOIDED').flatMap((batch) => batch.items).flatMap((item) => item.entries)
    .filter((entry) => entry.entryType === type)
    .map((entry) => type === 'PLAYER_EARNING' ? entry.playerEarningId! : entry.playerEarningAdjustmentId!));
}

function addEntry(target: Map<string, SettlementEntryRecord[]>, playerUserId: string, entry: SettlementEntryRecord): void {
  const entries = target.get(playerUserId) ?? [];
  entries.push(entry);
  target.set(playerUserId, entries);
}

function adjustmentSign(type: SettlementAdjustmentType): 1 | -1 {
  return type === 'CORRECTION_CREDIT' ? 1 : -1;
}

function requireBatch(batches: SettlementBatchRecord[], id: string, guildId?: string): SettlementBatchRecord {
  const batch = batches.find((candidate) => candidate.id === id && (!guildId || candidate.guildId === guildId));
  if (!batch) throw new SettlementError('NOT_FOUND', 'Settlement batch was not found.');
  return batch;
}

function validateReplacementRequest(batch: SettlementBatchRecord, input: SettlementVoidInput): void {
  if ((batch.status === 'APPROVED' || batch.status === 'EXPORTED')
    && (!input.replacementBatchId || !input.replacement)) {
    throw new SettlementError('CONFLICT', 'Approved or exported settlement batches require an atomic replacement.');
  }
  if (!input.replacementBatchId || !input.replacement) return;
  if (input.replacementBatchId === batch.id) {
    throw new SettlementError('CONFLICT', 'A settlement batch cannot replace itself.');
  }
  if (input.replacement.guildId !== batch.guildId || input.replacement.currency !== batch.currency) {
    throw new SettlementError('CONFLICT', 'A replacement must use the same Guild and currency.');
  }
}

function requireVersion(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw new SettlementError('CONFLICT', `${label} version is stale.`);
}

function requireStatus(batch: SettlementBatchRecord, statuses: SettlementBatchStatus[], action: string): void {
  if (!statuses.includes(batch.status)) {
    throw new SettlementError('CONFLICT', `Settlement batch in ${batch.status} cannot be ${action}.`);
  }
}

function enforceApprovalPolicy(
  batch: SettlementBatchRecord,
  input: Pick<SettlementMutationInput, 'actorStaffId' | 'actorLevel'>,
  thresholds: SettlementReviewThresholds
): void {
  if (batch.netAmountMinor >= thresholds.l4ReviewFromMinor && levelRank(input.actorLevel) < levelRank('L4_ADMIN_OWNER')) {
    throw new SettlementError('L4_APPROVAL_REQUIRED', 'This settlement batch requires an L4 approver.');
  }
  if (batch.source === 'MANUAL'
    && batch.netAmountMinor >= thresholds.manualDualReviewFromMinor
    && batch.createdByStaffId === input.actorStaffId) {
    throw new SettlementError('MAKER_CHECKER_REQUIRED', 'A different staff actor must approve this manual high-value batch.');
  }
}

function preparePaymentResults(
  batch: SettlementBatchRecord,
  input: SettlementPaymentResultsInput
): Array<{ item: SettlementItemRecord; record: SettlementPaymentResultRecord }> {
  if (input.results.length < 1 || input.results.length > 500) {
    throw new SettlementError('VALIDATION_ERROR', 'Between 1 and 500 payment results are required.');
  }
  const seen = new Set<string>();
  return input.results.map((result) => {
    if (seen.has(result.settlementItemId)) throw new SettlementError('VALIDATION_ERROR', 'Each settlement item may appear once per request.');
    seen.add(result.settlementItemId);
    const item = batch.items.find((candidate) => candidate.id === result.settlementItemId);
    if (!item) throw new SettlementError('VALIDATION_ERROR', 'Settlement item does not belong to this batch.');
    requireVersion(item.version, result.expectedVersion, 'Settlement item');
    if (item.paymentStatus === 'SUCCEEDED') throw new SettlementError('CONFLICT', 'A successful settlement item cannot be recorded again.');
    const externalReference = normalizeOptionalEvidence(result.externalBatchReference);
    const note = normalizeOptionalEvidence(result.note);
    if (!externalReference && !note) throw new SettlementError('VALIDATION_ERROR', 'An external reference or note is required.');
    if (result.currency !== item.currency) throw new SettlementError('VALIDATION_ERROR', 'Payment result currency must match the settlement item.');
    if (!Number.isSafeInteger(result.amountMinor) || result.amountMinor < 0) {
      throw new SettlementError('VALIDATION_ERROR', 'Payment result amount must be a non-negative safe integer.');
    }
    if (result.result === 'SUCCEEDED' && result.amountMinor !== item.netAmountMinor) {
      throw new SettlementError('VALIDATION_ERROR', 'Successful payment amount must equal the whole settlement item net amount.');
    }
    const rowKey = derivePaymentResultKey(input.requestIdempotencyKey, item.id);
    return {
      item,
      record: {
        id: deterministicUuid(`settlement-payment-result:${rowKey}`),
        settlementItemId: item.id,
        result: result.result,
        amountMinor: result.amountMinor,
        currency: result.currency,
        externalBatchReference: externalReference,
        note,
        idempotencyKey: rowKey,
        recordedByStaffId: input.actorStaffId,
        recordedAt: input.now.toISOString()
      }
    };
  });
}

function derivePaymentResultKey(requestKey: string, itemId: string): string {
  return `settlement:${createHash('sha256').update(`${requestKey}:${itemId}`).digest('hex')}`;
}

function normalizeOptionalEvidence(value: string | null): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function maskExternalAccountDisplay(value: string | null): string | null {
  if (!value) return null;
  const separator = value.indexOf(':');
  const provider = separator >= 0 ? value.slice(0, separator) : 'external';
  const supplied = separator >= 0 ? value.slice(separator + 1) : value;
  if (supplied.startsWith('***')) return `${provider}:***${supplied.slice(3).slice(-4)}`;
  const identifier = supplied.replace(/^\*+/u, '');
  return identifier.length > 4 ? `${provider}:***${identifier.slice(-4)}` : `${provider}:***`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => {
    const next = total + value;
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(next)) {
      throw new SettlementError('VALIDATION_ERROR', 'Settlement amount exceeds the supported safe integer range.');
    }
    return next;
  }, 0);
}

function toSafeMinor(value: string, field: string): number {
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new SettlementError('VALIDATION_ERROR', `${field} exceeds the supported safe integer range.`);
  }
  return Number(parsed);
}

function automaticIdentity(input: Pick<SettlementCreateInput | SettlementBatchRecord, 'guildId' | 'source' | 'scheduleKey' | 'periodStart' | 'periodEnd' | 'currency'>): string | null {
  return input.source === 'SCHEDULED'
    ? [input.guildId, input.scheduleKey, input.periodStart, input.periodEnd, input.currency].join(':')
    : null;
}

function deterministicUuid(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function lockSettlementSources(client: PoolClient, input: SettlementCreateInput): Promise<void> {
  await client.query(
    `SELECT pe.id FROM player_earnings pe JOIN orders o ON o.id=pe.order_id
     WHERE o.guild_id=$1 AND pe.currency=$2 AND pe.created_at <= $3::timestamptz
       AND ($4::uuid[] IS NULL OR pe.player_user_id = ANY($4::uuid[]))
     ORDER BY pe.id FOR UPDATE`,
    [input.guildId, input.currency, input.cutoffAt, input.playerUserIds]
  );
  await client.query(
    `SELECT pea.id FROM player_earning_adjustments pea
     JOIN player_earnings pe ON pe.id=pea.player_earning_id
     JOIN orders o ON o.id=pe.order_id
     WHERE o.guild_id=$1 AND pea.currency=$2 AND pea.created_at <= $3::timestamptz
       AND ($4::uuid[] IS NULL OR pe.player_user_id = ANY($4::uuid[]))
     ORDER BY pea.id FOR UPDATE OF pea`,
    [input.guildId, input.currency, input.cutoffAt, input.playerUserIds]
  );
}

async function loadPostgresCandidates(client: SettlementDatabaseClient, input: SettlementCreateInput, _locked: boolean): Promise<SettlementCandidateEarning[]> {
  const rows = await client.query<PostgresCandidateRow>(
    `SELECT pe.id,pe.order_id,pe.player_user_id,u.display_name AS player_display_name,
       (SELECT da.discord_user_id FROM discord_accounts da WHERE da.user_id=pe.player_user_id
        ORDER BY da.last_seen_at DESC NULLS LAST,da.id LIMIT 1) AS player_discord_user_id,
       (SELECT ea.provider || ':***' || CASE WHEN length(ea.external_user_id)>4 THEN right(ea.external_user_id,4) ELSE '' END
        FROM external_accounts ea
        WHERE ea.user_id=pe.player_user_id AND ea.status='ACTIVE'
        ORDER BY ea.verified_at DESC NULLS LAST,ea.id LIMIT 1) AS external_account_display,
       pe.amount_minor::text,pe.currency,pe.status,
       pe.confirmed_at,pe.paid_at,pe.created_at,
       COALESCE(jsonb_agg(jsonb_build_object('id',pea.id,'playerEarningId',pea.player_earning_id,
         'type',pea.type,'amountMinor',pea.amount_minor::text,'currency',pea.currency,'createdAt',pea.created_at)
         ORDER BY pea.created_at,pea.id) FILTER (WHERE pea.id IS NOT NULL),'[]'::jsonb) adjustments
     FROM player_earnings pe JOIN users u ON u.id=pe.player_user_id
     JOIN orders o ON o.id=pe.order_id
     LEFT JOIN player_earning_adjustments pea ON pea.player_earning_id=pe.id
     WHERE o.guild_id=$1 AND pe.currency=$2 AND pe.created_at <= $3::timestamptz
       AND ($4::uuid[] IS NULL OR pe.player_user_id = ANY($4::uuid[]))
     GROUP BY pe.id,u.display_name ORDER BY pe.id`,
    [input.guildId, input.currency, input.cutoffAt, input.playerUserIds]
  );
  return rows.rows.map((row) => ({
    id: row.id, orderId: row.order_id, playerUserId: row.player_user_id, guildId: input.guildId,
    playerDisplayName: row.player_display_name, playerDiscordUserId: row.player_discord_user_id,
    externalAccountDisplay: row.external_account_display, amountMinor: toSafeMinor(row.amount_minor, 'earning amount'),
    currency: row.currency, status: row.status, confirmedAt: iso(row.confirmed_at), paidAt: iso(row.paid_at),
    createdAt: iso(row.created_at)!, adjustments: row.adjustments.map((adjustment) => ({
      ...adjustment, amountMinor: toSafeMinor(adjustment.amountMinor, 'adjustment amount'), createdAt: iso(adjustment.createdAt)!
    }))
  }));
}

async function loadPostgresMemberships(client: SettlementDatabaseClient, guildId: string): Promise<SettlementBatchRecord[]> {
  const rows = await client.query<PostgresMembershipRow>(
    `SELECT sb.id,sb.status,sie.entry_type,sie.player_earning_id,sie.player_earning_adjustment_id
     FROM settlement_item_entries sie JOIN settlement_items si ON si.id=sie.settlement_item_id
     JOIN settlement_batches sb ON sb.id=si.settlement_batch_id
     WHERE sb.guild_id=$1 AND sb.status<>'VOIDED'`, [guildId]
  );
  const grouped = new Map<string, SettlementBatchRecord>();
  for (const row of rows.rows) {
    const batch = grouped.get(row.id) ?? emptyMembershipBatch(row.id, row.status, guildId);
    batch.items[0]!.entries.push({
      id: `${row.id}:${batch.items[0]!.entries.length}`, entryType: row.entry_type,
      playerEarningId: row.player_earning_id, playerEarningAdjustmentId: row.player_earning_adjustment_id,
      amountMinor: 0, currency: 'USD', occurredAt: ''
    });
    grouped.set(row.id, batch);
  }
  return [...grouped.values()];
}

async function findScheduledBatch(client: SettlementDatabaseClient, input: SettlementCreateInput): Promise<SettlementBatchRecord | null> {
  if (input.source !== 'SCHEDULED') return null;
  const result = await client.query<{ id: string }>(
    `SELECT id FROM settlement_batches WHERE guild_id=$1 AND schedule_key=$2 AND period_start=$3::timestamptz
       AND period_end=$4::timestamptz AND currency=$5`,
    [input.guildId, input.scheduleKey, input.periodStart, input.periodEnd, input.currency]
  );
  return result.rows[0] ? loadPostgresBatch(client, result.rows[0].id, input.guildId) : null;
}

async function insertPostgresBatch(client: PoolClient, input: SettlementCreateInput, preview: SettlementPreview, forcedId?: string): Promise<SettlementBatchRecord> {
  const identity = automaticIdentity(input) ?? `${input.periodStart}:${input.periodEnd}:${input.currency}:${Date.now()}:${Math.random()}`;
  const batchId = forcedId ?? deterministicUuid(`settlement-batch:${identity}`);
  const publicId = `SET-${batchId.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const items = materializeItemIds(preview.items, batchId);
  await client.query(
    `INSERT INTO settlement_batches (id,public_id,guild_id,source,schedule_key,period_start,period_end,cutoff_at,time_zone,currency,
       gross_amount_minor,adjustment_amount_minor,net_amount_minor,status,row_version,created_by_staff_id,replacement_batch_id,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'DRAFT',1,$14,NULL,now(),now())`,
    [batchId, publicId, input.guildId, input.source, input.scheduleKey, input.periodStart, input.periodEnd, input.cutoffAt,
      input.timeZone, input.currency, preview.grossAmountMinor, preview.adjustmentAmountMinor,
      preview.netAmountMinor, input.createdByStaffId]
  );
  for (const item of items) {
    await client.query(
      `INSERT INTO settlement_items (id,settlement_batch_id,player_user_id,player_display_name,player_discord_user_id,
         external_account_display,gross_amount_minor,adjustment_amount_minor,net_amount_minor,currency,payment_status,row_version,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING',1,now(),now())`,
      [item.id, batchId, item.playerUserId, item.playerDisplayName, item.playerDiscordUserId,
        item.externalAccountDisplay, item.grossAmountMinor, item.adjustmentAmountMinor, item.netAmountMinor, item.currency]
    );
    for (const entry of item.entries) {
      await client.query(
        `INSERT INTO settlement_item_entries (id,settlement_item_id,entry_type,player_earning_id,
           player_earning_adjustment_id,amount_minor,currency,occurred_at,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
        [entry.id, item.id, entry.entryType, entry.playerEarningId, entry.playerEarningAdjustmentId,
          entry.amountMinor, entry.currency, entry.occurredAt]
      );
    }
  }
  await client.query('UPDATE settlement_batches SET snapshot_finalized_at=now(),updated_at=now() WHERE id=$1', [batchId]);
  return loadPostgresBatch(client, batchId, input.guildId);
}

function materializeItemIds(items: SettlementItemRecord[], batchId: string): SettlementItemRecord[] {
  return items.map((item) => ({
    ...item,
    id: deterministicUuid(`settlement-item:${batchId}:${item.playerUserId}`),
    entries: item.entries.map((entry) => ({
      ...entry,
      id: deterministicUuid(`settlement-entry:${batchId}:${entry.entryType}:${entry.playerEarningId ?? entry.playerEarningAdjustmentId}`)
    }))
  }));
}

async function loadPostgresBatch(client: SettlementDatabaseClient, id: string, guildId: string, forUpdate = false): Promise<SettlementBatchRecord> {
  const batchResult = await client.query<PostgresBatchRow>(
    `SELECT * FROM settlement_batches WHERE id=$1 AND guild_id=$2${forUpdate ? ' FOR UPDATE' : ''}`, [id, guildId]
  );
  const batch = batchResult.rows[0];
  if (!batch) throw new SettlementError('NOT_FOUND', 'Settlement batch was not found.');
  const itemResult = await client.query<PostgresItemRow>('SELECT * FROM settlement_items WHERE settlement_batch_id=$1 ORDER BY player_user_id', [id]);
  const items: SettlementItemRecord[] = [];
  for (const item of itemResult.rows) {
    const entries = await client.query<PostgresEntryRow>('SELECT * FROM settlement_item_entries WHERE settlement_item_id=$1 ORDER BY occurred_at,id', [item.id]);
    const paymentResults = await client.query<PostgresPaymentResultRow>(
      'SELECT * FROM settlement_payment_results WHERE settlement_item_id=$1 ORDER BY recorded_at,id', [item.id]
    );
    items.push({ id: item.id, playerUserId: item.player_user_id, playerDisplayName: item.player_display_name,
      playerDiscordUserId: item.player_discord_user_id, externalAccountDisplay: item.external_account_display,
      grossAmountMinor: toSafeMinor(item.gross_amount_minor, 'item gross amount'),
      adjustmentAmountMinor: toSafeMinor(item.adjustment_amount_minor, 'item adjustment amount'),
      netAmountMinor: toSafeMinor(item.net_amount_minor, 'item net amount'),
      currency: item.currency, paymentStatus: item.payment_status, version: item.row_version,
      entries: entries.rows.map((entry) => ({ id: entry.id, entryType: entry.entry_type,
        playerEarningId: entry.player_earning_id, playerEarningAdjustmentId: entry.player_earning_adjustment_id,
        amountMinor: toSafeMinor(entry.amount_minor, 'entry amount'), currency: entry.currency, occurredAt: iso(entry.occurred_at)! })),
      paymentResults: paymentResults.rows.map((result) => ({
        id: result.id, settlementItemId: result.settlement_item_id, result: result.result,
        amountMinor: toSafeMinor(result.amount_minor, 'payment result amount'), currency: result.currency,
        externalBatchReference: result.external_batch_reference, note: result.note,
        idempotencyKey: result.idempotency_key, recordedByStaffId: result.recorded_by_staff_id,
        recordedAt: iso(result.recorded_at)!
      })) });
  }
  return { id: batch.id, guildId: batch.guild_id, publicId: batch.public_id, source: batch.source, scheduleKey: batch.schedule_key,
    periodStart: iso(batch.period_start)!, periodEnd: iso(batch.period_end)!, cutoffAt: iso(batch.cutoff_at)!, timeZone: batch.time_zone,
    currency: batch.currency, grossAmountMinor: toSafeMinor(batch.gross_amount_minor, 'batch gross amount'),
    adjustmentAmountMinor: toSafeMinor(batch.adjustment_amount_minor, 'batch adjustment amount'),
    netAmountMinor: toSafeMinor(batch.net_amount_minor, 'batch net amount'),
    status: batch.status, version: batch.row_version, createdByStaffId: batch.created_by_staff_id,
    submittedByStaffId: batch.submitted_by_staff_id, approvedByStaffId: batch.approved_by_staff_id,
    voidedByStaffId: batch.voided_by_staff_id, submittedAt: iso(batch.submitted_at), approvedAt: iso(batch.approved_at),
    exportedAt: iso(batch.exported_at), voidedAt: iso(batch.voided_at), voidReason: batch.void_reason,
    replacementBatchId: batch.replacement_batch_id, createdAt: iso(batch.created_at)!, items };
}

function emptyMembershipBatch(id: string, status: SettlementBatchStatus, guildId: string): SettlementBatchRecord {
  return { id, guildId, publicId: '', source: 'MANUAL', scheduleKey: null, periodStart: '', periodEnd: '', cutoffAt: '', timeZone: '', currency: 'USD',
    grossAmountMinor: 0, adjustmentAmountMinor: 0, netAmountMinor: 0, status, version: 1, createdByStaffId: null,
    submittedByStaffId: null, approvedByStaffId: null, voidedByStaffId: null, submittedAt: null, approvedAt: null,
    exportedAt: null, voidedAt: null, voidReason: null, replacementBatchId: null, createdAt: '',
    items: [{ id: '', playerUserId: '', playerDisplayName: '', playerDiscordUserId: null, externalAccountDisplay: null, grossAmountMinor: 0,
      adjustmentAmountMinor: 0, netAmountMinor: 0, currency: 'USD', paymentStatus: 'PENDING', version: 1,
      entries: [], paymentResults: [] }] };
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

function isPostgresConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'message' in error
    && /settlement source already belongs to an active settlement batch/i.test(String(error.message));
}

interface PostgresAdjustmentJson { id: string; playerEarningId: string; type: SettlementAdjustmentType; amountMinor: string; currency: string; createdAt: Date | string; }
interface PostgresCandidateRow extends Record<string, unknown> { id: string; order_id: string; player_user_id: string; player_display_name: string; player_discord_user_id: string | null; external_account_display: string | null; amount_minor: string; currency: string; status: SettlementCandidateEarning['status']; confirmed_at: Date | null; paid_at: Date | null; created_at: Date; adjustments: PostgresAdjustmentJson[]; }
interface PostgresMembershipRow extends Record<string, unknown> { id: string; status: SettlementBatchStatus; entry_type: SettlementEntryType; player_earning_id: string | null; player_earning_adjustment_id: string | null; }
interface PostgresBatchRow extends Record<string, unknown> { id: string; guild_id: string; public_id: string; source: SettlementBatchSource; schedule_key: string | null; period_start: Date; period_end: Date; cutoff_at: Date; time_zone: string; currency: string; gross_amount_minor: string; adjustment_amount_minor: string; net_amount_minor: string; status: SettlementBatchStatus; row_version: number; created_by_staff_id: string | null; submitted_by_staff_id: string | null; approved_by_staff_id: string | null; voided_by_staff_id: string | null; submitted_at: Date | null; approved_at: Date | null; exported_at: Date | null; voided_at: Date | null; void_reason: string | null; replacement_batch_id: string | null; created_at: Date; }
interface PostgresItemRow extends Record<string, unknown> { id: string; player_user_id: string; player_display_name: string; player_discord_user_id: string | null; external_account_display: string | null; gross_amount_minor: string; adjustment_amount_minor: string; net_amount_minor: string; currency: string; payment_status: SettlementItemPaymentStatus; row_version: number; }
interface PostgresEntryRow extends Record<string, unknown> { id: string; entry_type: SettlementEntryType; player_earning_id: string | null; player_earning_adjustment_id: string | null; amount_minor: string; currency: string; occurred_at: Date; }
interface PostgresPaymentResultRow extends Record<string, unknown> { id: string; settlement_item_id: string; result: SettlementPaymentResultStatus; amount_minor: string; currency: string; external_batch_reference: string | null; note: string | null; idempotency_key: string; recorded_by_staff_id: string; recorded_at: Date; }
