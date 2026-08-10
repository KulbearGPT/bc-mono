import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { hasStaffPermission, levelRank } from './authorization-policy.js';
import { resolveBotConfigString, type BotConfigStore } from './bot-config.js';
import {
  refundOrder,
  resolveOrder,
  type AdminRefundOrderStore,
  type ApprovalDecisionExecution
} from './admin-order-actions.js';
import type { GiftStore, GiftApprovalDecisionExecution } from './gifts.js';
import type { PolicyReader } from './operations.js';
import { decodeBoundKeysetCursor, encodeBoundKeysetCursor } from './signed-cursor.js';
import {
  insertPostgresAuditRecord,
  registerSecureReadRoute,
  registerSecureWriteRoute,
  type ActorContext,
  type AuditRecord,
  type AuditSink,
  type StaffLevel
} from './security.js';

export type SupportedApprovalAction = 'GIFT_APPROVE' | 'REFUND_EXECUTE' | 'ORDER_RESOLVE';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

export interface ApprovalRecord {
  id: string;
  action: SupportedApprovalAction | string;
  targetType: string;
  targetId: string;
  targetVersion: number;
  payloadSnapshot: Record<string, unknown>;
  payloadHash: string;
  amountMinor: number;
  currency: string;
  requestedBy: string;
  requiredLevel: StaffLevel;
  status: ApprovalStatus;
  expiresAt: string;
  version: number;
  guildId: string;
  createdAt: string;
}

export interface ApprovalView {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  amountMinor: number;
  currency: string;
  requestedBy: string;
  requiredLevel: StaffLevel;
  status: ApprovalStatus;
  expiresAt: string;
  version: number;
}

export interface ApprovalExecutionResult {
  approvalRequestId: string;
  status: 'APPROVED';
  actionExecuted: true;
  resultType: string;
  resultId: string;
}

interface ApprovalPage {
  items: ApprovalView[];
  nextCursor: string | null;
}
interface ApprovalDecisionInput {
  approvalRequestId: string;
  expectedVersion: number;
  reason: string;
  actor: ActorContext;
  now: Date;
}
interface Staged<T> {
  data: T;
  commit(audit: AuditRecord): Promise<void> | void;
}

export interface ApprovalStore {
  list(input: {
    guildId: string;
    actorLevel: StaffLevel;
    status?: ApprovalStatus;
    cursor: string | null;
    limit: number;
  }): Promise<ApprovalPage> | ApprovalPage;
  get(input: {
    approvalRequestId: string;
    guildId: string;
    actorLevel: StaffLevel;
  }): Promise<ApprovalView> | ApprovalView;
  stageApprove(
    input: ApprovalDecisionInput
  ): Promise<Staged<ApprovalExecutionResult>> | Staged<ApprovalExecutionResult>;
  stageReject(input: ApprovalDecisionInput): Promise<Staged<ApprovalView>> | Staged<ApprovalView>;
}

export class ApprovalError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'VALIDATION_ERROR' | 'CONFLICT' | 'BUSINESS_RULE_VIOLATION',
    message: string
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export class InMemoryApprovalStore implements ApprovalStore {
  readonly records: ApprovalRecord[];
  readonly executions: ApprovalExecutionResult[] = [];
  private readonly execute: (
    record: ApprovalRecord
  ) => Omit<ApprovalExecutionResult, 'approvalRequestId' | 'status' | 'actionExecuted'>;
  private readonly auditSink?: AuditSink;

  constructor(
    input: {
      records?: ApprovalRecord[];
      execute?: (record: ApprovalRecord) => { resultType: string; resultId: string };
      auditSink?: AuditSink;
    } = {}
  ) {
    this.records = clone(input.records ?? []);
    this.execute = input.execute ?? ((record) => ({ resultType: record.targetType, resultId: record.targetId }));
    this.auditSink = input.auditSink;
  }

  list(input: {
    guildId: string;
    actorLevel: StaffLevel;
    status?: ApprovalStatus;
    cursor: string | null;
    limit: number;
  }): ApprovalPage {
    requireApprovalLevel(input.actorLevel);
    const cursor = decodeApprovalCursor(input.cursor, input);
    const visible = this.records
      .filter(
        (item) =>
          item.guildId === input.guildId &&
          supportedActions.has(item.action as SupportedApprovalAction) &&
          (!input.status || item.status === input.status)
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .filter((item) => !cursor || item.createdAt < cursor.at || (item.createdAt === cursor.at && item.id < cursor.id));
    const items = visible.slice(0, input.limit).map(publicApproval);
    const last = visible.at(Math.min(input.limit, visible.length) - 1);
    return {
      items,
      nextCursor: visible.length > input.limit && last ? encodeApprovalCursor(last.createdAt, last.id, input) : null
    };
  }

  get(input: { approvalRequestId: string; guildId: string; actorLevel: StaffLevel }): ApprovalView {
    requireApprovalLevel(input.actorLevel);
    return publicApproval(this.requireScoped(input.approvalRequestId, input.guildId));
  }

  stageApprove(input: ApprovalDecisionInput): Staged<ApprovalExecutionResult> {
    const current = this.requireDecidable(input);
    assertSupported(current.action);
    assertExecutionPermission(current.action, input.actor.actorLevel);
    const executed = this.execute(current);
    const data: ApprovalExecutionResult = {
      approvalRequestId: current.id,
      status: 'APPROVED',
      actionExecuted: true,
      ...executed
    };
    return {
      data,
      commit: async (audit) => {
        const observed = this.requireDecidable(input);
        const index = this.records.indexOf(observed);
        const previous = clone(observed);
        this.records[index] = { ...observed, status: 'APPROVED', version: observed.version + 1 };
        this.executions.push(clone(data));
        audit.approvalRequestId = current.id;
        try {
          await this.auditSink?.append(audit);
        } catch (error) {
          this.records[index] = previous;
          this.executions.pop();
          throw error;
        }
      }
    };
  }

  stageReject(input: ApprovalDecisionInput): Staged<ApprovalView> {
    const current = this.requireDecidable(input);
    assertSupported(current.action);
    const data = publicApproval({ ...current, status: 'REJECTED', version: current.version + 1 });
    return {
      data,
      commit: async (audit) => {
        const observed = this.requireDecidable(input);
        const index = this.records.indexOf(observed);
        const previous = clone(observed);
        this.records[index] = {
          ...observed,
          status: 'REJECTED',
          version: observed.version + 1
        };
        audit.approvalRequestId = current.id;
        try {
          await this.auditSink?.append(audit);
        } catch (error) {
          this.records[index] = previous;
          throw error;
        }
      }
    };
  }

  private requireDecidable(input: ApprovalDecisionInput): ApprovalRecord {
    if (!input.actor.guildId || !input.actor.actorLevel || !input.actor.actorStaffId)
      throw new ApprovalError('PERMISSION_DENIED', 'Active staff and Guild context are required.');
    const current = this.requireScoped(input.approvalRequestId, input.actor.guildId);
    if (current.status !== 'PENDING' || current.version !== input.expectedVersion)
      throw new ApprovalError('CONFLICT', 'Approval request is no longer pending or its version is stale.');
    if (Date.parse(current.expiresAt) <= input.now.getTime())
      throw new ApprovalError('CONFLICT', 'Approval request has expired.');
    if (levelRank(input.actor.actorLevel) < levelRank(current.requiredLevel))
      throw new ApprovalError('PERMISSION_DENIED', 'The actor level is below the approval requirement.');
    return current;
  }

  private requireScoped(id: string, guildId: string): ApprovalRecord {
    const record = this.records.find(
      (item) =>
        item.id === id && item.guildId === guildId && supportedActions.has(item.action as SupportedApprovalAction)
    );
    if (!record) throw new ApprovalError('NOT_FOUND', 'Approval request was not found.');
    return record;
  }
}

interface ApprovalRow {
  id: string;
  action: string;
  target_type: string;
  target_id: string;
  target_version: number;
  payload_snapshot: Record<string, unknown>;
  payload_hash: string;
  amount_minor: string | number | bigint | null;
  currency: string | null;
  requested_by_staff_id: string;
  required_level: StaffLevel;
  status: ApprovalStatus;
  expires_at: Date | string;
  row_version: number;
  created_at: Date | string;
  guild_id: string;
}

export class PostgresApprovalStore implements ApprovalStore {
  constructor(protected readonly pool: Pool) {}

  async list(input: {
    guildId: string;
    actorLevel: StaffLevel;
    status?: ApprovalStatus;
    cursor: string | null;
    limit: number;
  }): Promise<ApprovalPage> {
    requireApprovalLevel(input.actorLevel);
    const cursor = decodeApprovalCursor(input.cursor, input);
    const rows = await this.pool.query<ApprovalRow>(
      `${approvalSelect}
      WHERE scope.guild_id=$1 AND approval.action::text=ANY($2::text[])
        AND ($3::text IS NULL OR approval.status::text=$3)
        AND ($4::timestamptz IS NULL OR (approval.created_at,approval.id)<($4::timestamptz,$5::uuid))
      ORDER BY approval.created_at DESC,approval.id DESC LIMIT $6`,
      [
        input.guildId,
        [...supportedActions],
        input.status ?? null,
        cursor?.at ?? null,
        cursor?.id ?? null,
        input.limit + 1
      ]
    );
    const records = rows.rows.slice(0, input.limit).map(mapRow);
    const items = records.map(publicApproval);
    const last = records.at(-1);
    return {
      items,
      nextCursor: rows.rows.length > input.limit && last ? encodeApprovalCursor(last.createdAt, last.id, input) : null
    };
  }

  async get(input: { approvalRequestId: string; guildId: string; actorLevel: StaffLevel }): Promise<ApprovalView> {
    requireApprovalLevel(input.actorLevel);
    const row = await this.load(input.approvalRequestId, input.guildId);
    return publicApproval(mapRow(row));
  }

  stageApprove(
    _input: ApprovalDecisionInput
  ): Promise<Staged<ApprovalExecutionResult>> | Staged<ApprovalExecutionResult> {
    throw new ApprovalError('BUSINESS_RULE_VIOLATION', 'Approval execution adapter is not configured.');
  }

  async stageReject(input: ApprovalDecisionInput): Promise<Staged<ApprovalView>> {
    const current = mapRow(await this.loadForDecision(input));
    assertSupported(current.action);
    const data = { ...publicApproval(current), status: 'REJECTED' as const, version: current.version + 1 };
    return { data, commit: (audit) => this.rejectTransaction(input, audit) };
  }

  private async load(id: string, guildId: string): Promise<ApprovalRow> {
    const rows = await this.pool.query<ApprovalRow>(
      `${approvalSelect} WHERE approval.id=$1 AND scope.guild_id=$2 AND approval.action::text=ANY($3::text[])`,
      [id, guildId, [...supportedActions]]
    );
    if (!rows.rows[0]) throw new ApprovalError('NOT_FOUND', 'Approval request was not found.');
    return rows.rows[0];
  }

  protected async loadForDecision(input: ApprovalDecisionInput): Promise<ApprovalRow> {
    requireDecisionActor(input.actor);
    const row = await this.load(input.approvalRequestId, input.actor.guildId!);
    assertDecision(row, input);
    return row;
  }

  private async rejectTransaction(input: ApprovalDecisionInput, audit: AuditRecord): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      const rows = await client.query<ApprovalRow>(
        `${approvalSelect} WHERE approval.id=$1 AND scope.guild_id=$2 AND approval.action::text=ANY($3::text[]) FOR UPDATE OF approval`,
        [input.approvalRequestId, input.actor.guildId, [...supportedActions]]
      );
      const row = rows.rows[0];
      if (!row) throw new ApprovalError('NOT_FOUND', 'Approval request was not found.');
      assertDecision(row, input);
      if (stablePayloadHash(row.payload_snapshot) !== row.payload_hash)
        throw new ApprovalError('CONFLICT', 'Approval payload integrity check failed.');
      if (row.action === 'GIFT_APPROVE')
        throw new ApprovalError(
          'BUSINESS_RULE_VIOLATION',
          'Gift rejection must be executed by the gift domain adapter.'
        );
      await insertDecision(client, row, input, 'REJECT');
      await insertPostgresAuditRecord(client, { ...audit, approvalRequestId: row.id });
    });
  }
}

export class PostgresDomainApprovalStore extends PostgresApprovalStore {
  constructor(
    pool: Pool,
    private readonly dependencies: {
      orderStore: AdminRefundOrderStore;
      giftStore: GiftStore;
      policyReader?: PolicyReader;
      botConfigStore?: BotConfigStore;
      giftBroadcastChannelId: string;
    }
  ) {
    super(pool);
  }

  override async stageApprove(input: ApprovalDecisionInput): Promise<Staged<ApprovalExecutionResult>> {
    try {
      const record = mapRow(await this.loadForDecision(input));
      assertSupported(record.action);
      assertExecutionPermission(record.action, input.actor.actorLevel);
      const decision = approvalDecision(record, input);
      if (record.action === 'GIFT_APPROVE') {
        const context = await this.dependencies.giftStore.getCaptureContext(record.targetId);
        const broadcastChannelId = await resolveBotConfigString(
          this.dependencies.botConfigStore,
          record.guildId,
          'gift_broadcast_channel_id',
          this.dependencies.giftBroadcastChannelId
        );
        const data: ApprovalExecutionResult = {
          approvalRequestId: record.id,
          status: 'APPROVED',
          actionExecuted: true,
          resultType: 'GIFT_REQUEST',
          resultId: record.targetId
        };
        return {
          data,
          commit: async (audit) => {
            try {
              const result = await this.dependencies.giftStore.commitApprovalDecision({
                giftRequestId: record.targetId,
                expectedVersion: context.request.version,
                actorStaffId: input.actor.actorStaffId!,
                actorLevel: input.actor.actorLevel!,
                reason: input.reason,
                broadcastChannelId,
                now: input.now,
                auditRecord: { ...audit, approvalRequestId: record.id },
                auditSink: { append: () => {} },
                approvalDecision: decision
              });
              if (result.statusCode !== 200) throw new ApprovalError('CONFLICT', 'Gift approval did not execute.');
            } catch (error) {
              throw normalizeDomainError(error);
            }
          }
        };
      }
      const payload = parseOrderPayload(record);
      const thresholds = await refundThresholds(this.dependencies.policyReader);
      if (record.action === 'REFUND_EXECUTE') {
        const staged = await refundOrder({
          orderStore: this.dependencies.orderStore,
          orderId: record.targetId,
          expectedVersion: payload.expectedVersion,
          amount: payload.amount,
          reasonCode: payload.reasonCode,
          evidenceNote: payload.evidenceNote,
          actor: input.actor,
          staffLevel: input.actor.actorLevel!,
          idempotencyKey: `approval:${record.id}:refund`,
          now: input.now,
          approvalThresholds: thresholds,
          approvalDecision: decision
        });
        if ('code' in staged.data) throw new ApprovalError('CONFLICT', 'Approval still requires escalation.');
        const data: ApprovalExecutionResult = {
          approvalRequestId: record.id,
          status: 'APPROVED',
          actionExecuted: true,
          resultType: 'REFUND',
          resultId: staged.data.refundTransactionId
        };
        return {
          data,
          commit: async (audit) => {
            try {
              await staged.commit({ ...audit, approvalRequestId: record.id });
            } catch (error) {
              throw normalizeDomainError(error);
            }
          }
        };
      }
      const staged = await resolveOrder({
        orderStore: this.dependencies.orderStore,
        orderId: record.targetId,
        expectedVersion: payload.expectedVersion,
        targetStatus: payload.targetStatus,
        reasonCode: payload.reasonCode,
        refund: payload.refund,
        playerEarning: payload.playerEarning,
        evidenceNote: payload.evidenceNote,
        actor: input.actor,
        staffLevel: input.actor.actorLevel!,
        idempotencyKey: `approval:${record.id}:resolution`,
        now: input.now,
        approvalThresholds: thresholds,
        approvalDecision: decision
      });
      if ('code' in staged.data) throw new ApprovalError('CONFLICT', 'Approval still requires escalation.');
      const data: ApprovalExecutionResult = {
        approvalRequestId: record.id,
        status: 'APPROVED',
        actionExecuted: true,
        resultType: 'ORDER_RESOLUTION',
        resultId: staged.data.resolutionId
      };
      return {
        data,
        commit: async (audit) => {
          try {
            await staged.commit({ ...audit, approvalRequestId: record.id });
          } catch (error) {
            throw normalizeDomainError(error);
          }
        }
      };
    } catch (error) {
      throw normalizeDomainError(error);
    }
  }

  override async stageReject(input: ApprovalDecisionInput): Promise<Staged<ApprovalView>> {
    const record = mapRow(await this.loadForDecision(input));
    assertSupported(record.action);
    if (record.action !== 'GIFT_APPROVE') return super.stageReject(input);
    const context = await this.dependencies.giftStore.getTerminationContext(record.targetId);
    const data = { ...publicApproval(record), status: 'REJECTED' as const, version: record.version + 1 };
    return {
      data,
      commit: async (audit) => {
        try {
          await this.dependencies.giftStore.commitTermination({
            giftRequestId: record.targetId,
            expectedGiftVersion: context.request.version,
            expectedReservationVersion: context.reservation.version,
            terminalStatus: 'REJECTED',
            reason: input.reason,
            actorStaffId: input.actor.actorStaffId!,
            now: input.now,
            auditRecord: { ...audit, approvalRequestId: record.id },
            auditSink: { append: () => {} },
            approvalDecision: approvalDecision(record, input) as GiftApprovalDecisionExecution
          });
        } catch (error) {
          throw normalizeDomainError(error);
        }
      }
    };
  }
}

export function registerApprovalRoutes(
  server: FastifyInstance,
  options: { store: ApprovalStore; now?: () => Date }
): void {
  if (!server.securityOptions) throw new Error('Approval routes require buildApiServer({ security, approvals }).');
  const security = server.securityOptions;
  const now = options.now ?? (() => new Date());
  registerSecureReadRoute(server, security, {
    method: 'GET',
    url: '/api/v1/admin/approval-requests',
    permission: 'approval.read',
    action: 'LIST_APPROVAL_REQUESTS',
    targetType: 'approval_request',
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    mapError,
    handler: (request, actor) =>
      options.store.list({
        ...pageQuery(request),
        status: statusQuery(request),
        guildId: requireGuild(actor),
        actorLevel: requireLevel(actor)
      })
  });
  registerSecureReadRoute(server, security, {
    method: 'GET',
    url: '/api/v1/admin/approval-requests/:approvalRequestId',
    permission: 'approval.read',
    action: 'GET_APPROVAL_REQUEST',
    targetType: 'approval_request',
    targetId: approvalId,
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    mapError,
    handler: (request, actor) =>
      options.store.get({
        approvalRequestId: approvalId(request),
        guildId: requireGuild(actor),
        actorLevel: requireLevel(actor)
      })
  });
  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/admin/approval-requests/:approvalRequestId/approve',
    permission: 'approval.approve',
    action: 'APPROVE_APPROVAL_REQUEST',
    targetType: 'approval_request',
    targetId: approvalId,
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    requiresRecentStepUp: (_request, actor) =>
      actor.actorLevel === 'L3_OPERATIONS' || actor.actorLevel === 'L4_ADMIN_OWNER',
    retryCommitFailures: true,
    mapError,
    fingerprintBody: (request) => parseDecision(request.body),
    successReason: (request) => decisionReason(parseDecision(request.body)),
    handler: async (request, actor) =>
      bind(
        await options.store.stageApprove({
          approvalRequestId: approvalId(request),
          ...decisionInput(request),
          actor,
          now: now()
        })
      )
  });
  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/admin/approval-requests/:approvalRequestId/reject',
    permission: 'approval.reject',
    action: 'REJECT_APPROVAL_REQUEST',
    targetType: 'approval_request',
    targetId: approvalId,
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    requiresRecentStepUp: (_request, actor) =>
      actor.actorLevel === 'L3_OPERATIONS' || actor.actorLevel === 'L4_ADMIN_OWNER',
    retryCommitFailures: true,
    mapError,
    fingerprintBody: (request) => parseDecision(request.body),
    successReason: (request) => decisionReason(parseDecision(request.body)),
    handler: async (request, actor) =>
      bind(
        await options.store.stageReject({
          approvalRequestId: approvalId(request),
          ...decisionInput(request),
          actor,
          now: now()
        })
      )
  });
}

const supportedActions = new Set<SupportedApprovalAction>(['GIFT_APPROVE', 'REFUND_EXECUTE', 'ORDER_RESOLVE']);
const approvalStatuses = new Set<ApprovalStatus>(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED']);
const approvalSelect = `SELECT approval.id,approval.action::text,approval.target_type,approval.target_id,approval.target_version,
  approval.payload_snapshot,approval.payload_hash,approval.amount_minor,approval.currency,approval.requested_by_staff_id,
  approval.required_level::text,approval.status::text,approval.expires_at,approval.row_version,approval.created_at,scope.guild_id
FROM approval_requests approval
JOIN LATERAL (
  SELECT orders.guild_id FROM orders WHERE approval.target_type='ORDER' AND orders.id=approval.target_id
  UNION ALL
  SELECT gift.guild_id FROM gift_requests gift WHERE approval.target_type='GIFT_REQUEST' AND gift.id=approval.target_id
) scope ON true`;

function bind<T>(staged: Staged<T>): Staged<T> {
  return staged;
}
function publicApproval(record: ApprovalRecord): ApprovalView {
  return {
    id: record.id,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    amountMinor: record.amountMinor,
    currency: record.currency,
    requestedBy: record.requestedBy,
    requiredLevel: record.requiredLevel,
    status: record.status,
    expiresAt: record.expiresAt,
    version: record.version
  };
}
function mapRow(row: ApprovalRow): ApprovalRecord {
  if (row.amount_minor === null || !row.currency)
    throw new ApprovalError('BUSINESS_RULE_VIOLATION', 'Supported approval amount snapshot is incomplete.');
  const amountMinor = Number(row.amount_minor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || row.currency !== 'CAT')
    throw new ApprovalError('BUSINESS_RULE_VIOLATION', 'Supported approval amount snapshot is invalid.');
  return {
    id: row.id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    targetVersion: row.target_version,
    payloadSnapshot: clone(row.payload_snapshot),
    payloadHash: row.payload_hash,
    amountMinor,
    currency: row.currency,
    requestedBy: row.requested_by_staff_id,
    requiredLevel: row.required_level,
    status: row.status,
    expiresAt: iso(row.expires_at),
    version: row.row_version,
    guildId: row.guild_id,
    createdAt: iso(row.created_at)
  };
}
function assertSupported(action: string): asserts action is SupportedApprovalAction {
  if (!supportedActions.has(action as SupportedApprovalAction))
    throw new ApprovalError('BUSINESS_RULE_VIOLATION', 'Approval action has no P0 executor.');
}
function assertExecutionPermission(action: SupportedApprovalAction, level: StaffLevel | null) {
  const permission =
    action === 'GIFT_APPROVE' ? 'gift.approve' : action === 'REFUND_EXECUTE' ? 'refund.execute' : 'order.resolve';
  if (!hasStaffPermission(level, permission))
    throw new ApprovalError('PERMISSION_DENIED', 'The actor cannot execute the approved action.');
}
function requireApprovalLevel(level: StaffLevel) {
  if (levelRank(level) < levelRank('L2_SUPERVISOR'))
    throw new ApprovalError('PERMISSION_DENIED', 'L2 or higher staff is required.');
}
function requireDecisionActor(actor: ActorContext) {
  if (!actor.guildId || !actor.actorLevel || !actor.actorStaffId)
    throw new ApprovalError('PERMISSION_DENIED', 'Active staff and Guild context are required.');
}
function requireGuild(actor: ActorContext) {
  if (!actor.guildId) throw new ApprovalError('PERMISSION_DENIED', 'Guild context is required.');
  return actor.guildId;
}
function requireLevel(actor: ActorContext) {
  if (!actor.actorLevel) throw new ApprovalError('PERMISSION_DENIED', 'Staff level is required.');
  requireApprovalLevel(actor.actorLevel);
  return actor.actorLevel;
}
function assertDecision(row: ApprovalRow, input: ApprovalDecisionInput) {
  requireDecisionActor(input.actor);
  if (row.status !== 'PENDING' || row.row_version !== input.expectedVersion)
    throw new ApprovalError('CONFLICT', 'Approval request is no longer pending or its version is stale.');
  if (new Date(row.expires_at).getTime() <= input.now.getTime())
    throw new ApprovalError('CONFLICT', 'Approval request has expired.');
  if (levelRank(input.actor.actorLevel!) < levelRank(row.required_level))
    throw new ApprovalError('PERMISSION_DENIED', 'The actor level is below the approval requirement.');
  assertSupported(row.action);
}
async function insertDecision(
  client: PoolClient,
  row: ApprovalRow,
  input: ApprovalDecisionInput,
  decision: 'APPROVE' | 'REJECT'
) {
  const updated = await client.query(
    `UPDATE approval_requests SET status=$2::"ApprovalStatus",row_version=row_version+1,updated_at=$3 WHERE id=$1 AND status='PENDING' AND row_version=$4`,
    [row.id, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', input.now, input.expectedVersion]
  );
  if (updated.rowCount !== 1) throw new ApprovalError('CONFLICT', 'Approval request changed before decision.');
  await client.query(
    `INSERT INTO approval_decisions(id,approval_request_id,decision,decided_by_staff_id,reason,target_version_checked,payload_hash_checked,decided_at) VALUES(gen_random_uuid(),$1,$2::"ApprovalDecisionType",$3,$4,$5,$6,$7)`,
    [row.id, decision, input.actor.actorStaffId, input.reason, row.target_version, row.payload_hash, input.now]
  );
}
function decisionInput(request: FastifyRequest) {
  const body = parseDecision(request.body);
  return { expectedVersion: body.expectedVersion, reason: decisionReason(body) };
}
function parseDecision(value: unknown) {
  const body = object(value);
  const allowed = ['expectedVersion', 'confirmation', 'reasonCode', 'note'];
  if (
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    !Number.isInteger(body.expectedVersion) ||
    Number(body.expectedVersion) < 1 ||
    body.confirmation !== 'CONFIRM_REVIEWED_IMPACT' ||
    typeof body.reasonCode !== 'string' ||
    !/^[A-Z0-9_]{3,100}$/u.test(body.reasonCode) ||
    !(body.note === undefined || body.note === null || (typeof body.note === 'string' && body.note.length <= 1000))
  )
    throw new ApprovalError('VALIDATION_ERROR', 'Approval decision payload is invalid.');
  return {
    expectedVersion: Number(body.expectedVersion),
    reasonCode: body.reasonCode,
    note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null
  };
}
function decisionReason(body: ReturnType<typeof parseDecision>) {
  return body.note ? `${body.reasonCode}: ${body.note}`.slice(0, 1000) : body.reasonCode;
}
function pageQuery(request: FastifyRequest) {
  const query = request.query as Record<string, unknown>;
  const limit = Number(query.limit ?? 50);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 500))
  )
    throw new ApprovalError('VALIDATION_ERROR', 'Pagination input is invalid.');
  return { limit, cursor: typeof query.cursor === 'string' ? query.cursor : null };
}
function statusQuery(request: FastifyRequest) {
  const value = (request.query as Record<string, unknown>).status;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !approvalStatuses.has(value as ApprovalStatus))
    throw new ApprovalError('VALIDATION_ERROR', 'Approval status is invalid.');
  return value as ApprovalStatus;
}
function approvalId(request: FastifyRequest) {
  const value = String((request.params as Record<string, unknown>).approvalRequestId ?? '');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value))
    throw new ApprovalError('VALIDATION_ERROR', 'approvalRequestId is invalid.');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApprovalError('VALIDATION_ERROR', 'Object payload is required.');
  return value as Record<string, unknown>;
}
function mapError(error: unknown) {
  if (!(error instanceof ApprovalError)) return null;
  return {
    statusCode:
      error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'PERMISSION_DENIED'
          ? 403
          : error.code === 'CONFLICT'
            ? 409
            : error.code === 'BUSINESS_RULE_VIOLATION'
              ? 422
              : 400,
    code: error.code,
    message: error.message
  };
}
function approvalDecision(record: ApprovalRecord, input: ApprovalDecisionInput): ApprovalDecisionExecution {
  return {
    approvalRequestId: record.id,
    expectedApprovalVersion: record.version,
    payloadHash: record.payloadHash,
    targetVersion: record.targetVersion,
    guildId: record.guildId,
    actorStaffId: input.actor.actorStaffId!,
    actorLevel: input.actor.actorLevel!,
    reason: input.reason,
    now: input.now
  };
}
function parseOrderPayload(record: ApprovalRecord) {
  const value = record.payloadSnapshot;
  const expectedVersion = integer(value.expectedVersion, 'expectedVersion');
  const reasonCode = text(value.reasonCode, 'reasonCode');
  const evidenceNote = text(value.evidenceNote, 'evidenceNote');
  const amount = money(value.amount ?? value.refund, 'amount');
  const refund = money(value.refund ?? value.amount, 'refund');
  const playerEarning = money(value.playerEarning ?? { amountMinor: 0, currency: record.currency }, 'playerEarning');
  const targetStatus = value.targetStatus === undefined ? 'CANCELLED' : value.targetStatus;
  if (targetStatus !== 'COMPLETED' && targetStatus !== 'CANCELLED')
    throw new ApprovalError('BUSINESS_RULE_VIOLATION', 'Stored targetStatus is invalid.');
  return {
    expectedVersion,
    reasonCode,
    evidenceNote,
    amount,
    refund,
    playerEarning,
    targetStatus: targetStatus as 'COMPLETED' | 'CANCELLED'
  };
}
function money(value: unknown, field: string): { amountMinor: number; currency: 'CAT' } {
  const input = object(value);
  if (!Number.isSafeInteger(input.amountMinor) || Number(input.amountMinor) < 0 || input.currency !== 'CAT')
    throw new ApprovalError('BUSINESS_RULE_VIOLATION', `Stored ${field} is invalid.`);
  return { amountMinor: Number(input.amountMinor), currency: 'CAT' };
}
function integer(value: unknown, field: string) {
  if (!Number.isInteger(value) || Number(value) < 1)
    throw new ApprovalError('BUSINESS_RULE_VIOLATION', `Stored ${field} is invalid.`);
  return Number(value);
}
function text(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000)
    throw new ApprovalError('BUSINESS_RULE_VIOLATION', `Stored ${field} is invalid.`);
  return value;
}
async function refundThresholds(reader?: PolicyReader) {
  return {
    l2LimitMinor: (await reader?.getPolicyInteger('L2_REFUND_LIMIT_MINOR', 50_000)) ?? 50_000,
    l4FromMinor: (await reader?.getPolicyInteger('L4_DIRECT_EXECUTION_THRESHOLD_MINOR', 500_000)) ?? 500_000
  };
}
function normalizeDomainError(error: unknown): ApprovalError {
  if (error instanceof ApprovalError) return error;
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const code = String(error.code);
    const mapped =
      code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : code === 'PERMISSION_DENIED'
          ? 'PERMISSION_DENIED'
          : code === 'CONFLICT' || code === 'EXECUTION_CREDENTIAL_STALE'
            ? 'CONFLICT'
            : code === 'VALIDATION_ERROR'
              ? 'VALIDATION_ERROR'
              : 'BUSINESS_RULE_VIOLATION';
    return new ApprovalError(mapped, String(error.message));
  }
  return new ApprovalError('BUSINESS_RULE_VIOLATION', 'Approval domain execution failed.');
}
function stablePayloadHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortPayload(value)))
    .digest('hex');
}
function sortPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortPayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortPayload(item)])
  );
}
function approvalCursorBinding(input: { guildId: string; actorLevel: StaffLevel; status?: ApprovalStatus }) {
  return `${input.guildId}\0${input.actorLevel}\0${input.status ?? ''}`;
}
function encodeApprovalCursor(
  createdAt: string,
  id: string,
  input: { guildId: string; actorLevel: StaffLevel; status?: ApprovalStatus }
) {
  return encodeBoundKeysetCursor('approval-requests', { id, at: createdAt }, approvalCursorBinding(input));
}
function decodeApprovalCursor(
  value: string | null,
  input: { guildId: string; actorLevel: StaffLevel; status?: ApprovalStatus }
) {
  if (!value) return null;
  try {
    return decodeBoundKeysetCursor(value, 'approval-requests', approvalCursorBinding(input));
  } catch {
    throw new ApprovalError('VALIDATION_ERROR', 'Cursor is invalid.');
  }
}
async function inTransaction(pool: Pool, fn: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
