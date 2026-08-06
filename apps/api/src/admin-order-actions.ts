import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Currency } from './catalog.js';
import type { ActorContext, AuditRecord } from './security.js';
import {
  PostgresOrderStore,
  type ExternalTransactionMirrorRecord,
  type OrderEventRecord,
  type OrderQueryClient,
  type OrderRecord,
  type OrderStore
} from './orders.js';
import { insertPostgresAuditRecord, registerSecureWriteRoute } from './security.js';
import type { PolicyReader } from './operations.js';
import { requiredLevelForAmount } from './authorization-policy.js';
import { enqueueTerminalChannelArchive } from './order-channel-cleanup.js';

type StaffLevel = 'L1_SUPPORT' | 'L2_SUPERVISOR' | 'L3_OPERATIONS' | 'L4_ADMIN_OWNER';
interface Transaction {
  kind: 'REFUND' | 'FALLBACK_DEBIT';
  status: 'UNKNOWN' | 'PENDING' | 'SUCCEEDED' | 'FAILED';
  idempotencyKey: string;
  fundReservationId: string | null;
  fundReservationVersion: number | null;
  businessSource: 'ORDER';
  amount: { amountMinor: number; currency: Currency };
  businessReference: string;
  providerRef: string;
  originalProviderRef: string | null;
  providerStatus: string;
  observedAt: string;
  providerOccurredAt: string;
  failure: null;
}
const resolutionReasonCodes = new Set([
  'USER_REQUEST',
  'DISPATCH_TIMEOUT',
  'PLAYER_NO_SHOW',
  'CUSTOMER_NO_SHOW',
  'SERVICE_INTERRUPTED',
  'COMPLETION_DISPUTE',
  'PAYMENT_FAILURE',
  'REFUND_FAILURE',
  'ADMIN_CORRECTION'
]);

export interface RefundOrderResult {
  orderId: string;
  refundTransactionId: string;
  amountMinor: number;
  currency: Currency;
  status: Transaction['status'];
  orderStatus: OrderRecord['status'];
}

export interface ApprovalPendingResult {
  approvalRequestId: string;
  code: 'APPROVAL_PENDING';
  requiredLevel: 'L3_OPERATIONS' | 'L4_ADMIN_OWNER';
  expiresAt: string;
  actionExecuted: false;
}

export interface OrderResolutionResult {
  resolutionId: string;
  orderId: string;
  targetStatus: 'COMPLETED' | 'CANCELLED';
  refundAmountMinor: number;
  playerEarningMinor: number;
  currency: Currency;
  approvalRequestId: string | null;
  createdAt: string;
}

export interface AdminOrderErrorDetail {
  statusCode: number;
  code: string;
  message: string;
}

export class AdminOrderActionError extends Error {
  readonly code: 'CONFLICT' | 'NOT_FOUND' | 'PERMISSION_DENIED' | 'VALIDATION_ERROR' | 'BUSINESS_RULE_VIOLATION';

  constructor(code: AdminOrderActionError['code'], message: string) {
    super(message);
    this.name = 'AdminOrderActionError';
    this.code = code;
  }
}

export interface AdminRefundOrderStore extends Pick<OrderStore, 'findById'> {
  orders?: OrderRecord[];
  events?: OrderEventRecord[];
  externalTransactions?: ExternalTransactionMirrorRecord[];
  resolutions?: Array<Record<string, unknown>>;
  playerEarningAdjustments?: Array<Record<string, unknown>>;
  commissionAdjustments?: Array<Record<string, unknown>>;
  approvalRequests?: Array<Record<string, unknown>>;
  refunds?: Array<{
    id: string;
    orderId: string;
    sourceTransactionId: string;
    amountMinor: number;
    currency: string;
    status: Transaction['status'];
    idempotencyKey: string;
  }>;
  findSucceededOrderCharge?(orderId: string): Promise<ExternalTransactionMirrorRecord | null>;
  findReservedRefundedMinor?(sourceTransactionId: string): Promise<number>;
  validateReassignmentPlayer?(input: { playerId: string; order: OrderRecord }): Promise<boolean>;
  commitApproval?(input: ApprovalCommitInput): Promise<void> | void;
  commitRefund?(input: RefundCommitInput): Promise<void> | void;
  commitResolution?(input: ResolutionCommitInput): Promise<void> | void;
  commitReassignment?(input: ReassignmentCommitInput): Promise<void> | void;
}

interface AdminStagedWrite<T> {
  data: T;
  statusCode?: number;
  commit(auditRecord: AuditRecord): Promise<void> | void;
}

interface ApprovalRecord {
  id: string;
  action: 'REFUND_EXECUTE' | 'ORDER_RESOLVE';
  targetId: string;
  targetVersion: number;
  amountMinor: number;
  currency: Currency;
  requestedByStaffId: string;
  requiredLevel: 'L3_OPERATIONS' | 'L4_ADMIN_OWNER';
  reason: string;
  payloadSnapshot: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
}

interface RefundPersistenceRecord {
  id: string;
  publicId: string;
  provider: string;
  sourceTransaction: ExternalTransactionMirrorRecord;
  beneficiaryUserId: string;
  orderId: string;
  orderResolutionId: string | null;
  requestedByStaffId: string;
  externalRefundRef: string | null;
  idempotencyKey: string;
  amountMinor: number;
  currency: Currency;
  status: Transaction['status'];
  reasonCode: string;
  reasonNote: string;
  createdAt: string;
}

interface ApprovalCommitInput {
  approval: ApprovalRecord;
  auditRecord: AuditRecord;
}

interface RefundCommitInput {
  order: OrderRecord;
  refund: RefundPersistenceRecord;
  auditRecord: AuditRecord;
}

interface ResolutionCommitInput {
  originalOrder: OrderRecord;
  updatedOrder: OrderRecord;
  resolution: OrderResolutionResult & {
    reasonCode: string;
    evidenceNote: string;
    resolvedByStaffId: string;
    orderVersionSnapshot: number;
    idempotencyKey: string;
  };
  refund: RefundPersistenceRecord | null;
  preChargeSettlement: {
    captureMinor: number;
    releaseMinor: number;
  } | null;
  event: OrderEventRecord;
  auditRecord: AuditRecord;
}

interface ReassignmentCommitInput {
  originalOrder: OrderRecord;
  updatedOrder: OrderRecord;
  event: OrderEventRecord;
  auditRecord: AuditRecord;
}

export async function refundOrder(input: {
  orderStore: AdminRefundOrderStore;
  orderId: string;
  expectedVersion: number;
  amount: { amountMinor: number; currency: Currency };
  reasonCode: string;
  evidenceNote: string;
  actor: ActorContext;
  staffLevel: StaffLevel;
  idempotencyKey: string;
  now: Date;
  approvalThresholds?: { l2LimitMinor: number; l4FromMinor: number };
}): Promise<AdminStagedWrite<RefundOrderResult | ApprovalPendingResult>> {
  if (input.staffLevel === 'L1_SUPPORT') {
    throw new AdminOrderActionError('PERMISSION_DENIED', 'L1 support cannot execute refunds.');
  }
  const order = await requireOrder(input.orderStore, input.orderId, input.expectedVersion, input.actor);
  if (order.status !== 'COMPLETED' && order.status !== 'EXCEPTION') {
    throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'Only completed or exception orders can be refunded by this endpoint.');
  }
  assertMoneyMatchesOrder(input.amount, order.currency, 'Refund');
  assertAmountWithinSnapshot(input.amount.amountMinor, order.amountMinor, 'Refund');
  const sourceTransaction = await findSucceededOrderCharge(input.orderStore, input.orderId);
  if (!sourceTransaction?.externalRef) {
    throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'A successful source charge is required before refund.');
  }
  const alreadyRefundedMinor = await findReservedRefundedMinor(input.orderStore, sourceTransaction.id);
  assertRefundWithinRemaining(input.amount.amountMinor, sourceTransaction.amountMinor, alreadyRefundedMinor);
  const requiredLevel = requiredRefundLevel(input.amount.amountMinor, input.approvalThresholds);
  if (requiredLevel !== 'L2_SUPERVISOR' && levelRank(input.staffLevel) < levelRank(requiredLevel)) {
    if (!input.actor.actorStaffId || (!input.orderStore.commitApproval && !input.orderStore.approvalRequests)) {
      throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'Order store cannot create an approval request.');
    }
    const approvalRequestId = crypto.randomUUID();
    const expiresAt = new Date(input.now.getTime() + 60 * 60_000).toISOString();
    const approval: ApprovalRecord = {
      id: approvalRequestId,
      action: 'REFUND_EXECUTE',
      targetId: order.id,
      targetVersion: order.version,
      amountMinor: input.amount.amountMinor,
      currency: input.amount.currency,
      requestedByStaffId: input.actor.actorStaffId,
      requiredLevel,
      reason: input.evidenceNote,
      payloadSnapshot: {
        expectedVersion: input.expectedVersion,
        amount: input.amount,
        reasonCode: input.reasonCode,
        evidenceNote: input.evidenceNote
      },
      expiresAt,
      createdAt: input.now.toISOString()
    };
    const data: ApprovalPendingResult = {
        approvalRequestId,
        code: 'APPROVAL_PENDING',
        requiredLevel,
        expiresAt,
        actionExecuted: false
    };
    return {
      data,
      statusCode: 202,
      commit: (auditRecord) => commitApproval(input.orderStore, { approval, auditRecord })
    };
  }
  const refund = internalWalletRefund(input.amount, input.orderId, `${input.idempotencyKey}:wallet`, input.now);

  const refundId = crypto.randomUUID();
  const data: RefundOrderResult = {
    orderId: order.id,
    refundTransactionId: refundId,
    amountMinor: refund.amount.amountMinor,
    currency: refund.amount.currency,
    status: refund.status,
    orderStatus: order.status
  };
  const refundRecord = buildRefundPersistenceRecord({
    id: refundId,
    provider: 'INTERNAL_WALLET',
    sourceTransaction,
    order,
    resolutionId: null,
    actorStaffId: input.actor.actorStaffId,
    providerRefund: refund,
    idempotencyKey: input.idempotencyKey,
    reasonCode: input.reasonCode,
    evidenceNote: input.evidenceNote,
    now: input.now
  });
  return {
    data,
    commit: (auditRecord) => commitRefund(input.orderStore, { order, refund: refundRecord, auditRecord })
  };
}

export async function resolveOrder(input: {
  orderStore: AdminRefundOrderStore;
  orderId: string;
  expectedVersion: number;
  targetStatus: 'COMPLETED' | 'CANCELLED';
  reasonCode: string;
  refund: { amountMinor: number; currency: Currency };
  playerEarning: { amountMinor: number; currency: Currency };
  evidenceNote: string;
  actor: ActorContext;
  staffLevel: StaffLevel;
  idempotencyKey: string;
  now: Date;
  approvalThresholds?: { l2LimitMinor: number; l4FromMinor: number };
}): Promise<AdminStagedWrite<OrderResolutionResult | ApprovalPendingResult>> {
  if (!input.actor.actorStaffId || input.staffLevel === 'L1_SUPPORT') {
    throw new AdminOrderActionError('PERMISSION_DENIED', 'L2 or higher staff is required to resolve orders.');
  }
  const order = await requireOrder(input.orderStore, input.orderId, input.expectedVersion, input.actor);
  if (!['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION', 'EXCEPTION'].includes(order.status)) {
    throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'Order cannot be resolved from its current status.');
  }
  assertMoneyMatchesOrder(input.refund, order.currency, 'Refund');
  assertMoneyMatchesOrder(input.playerEarning, order.currency, 'Player earning');
  assertAmountWithinSnapshot(input.refund.amountMinor, order.amountMinor, 'Refund');
  assertAmountWithinSnapshot(input.playerEarning.amountMinor, order.playerEarningMinor, 'Player earning');
  const requiredLevel = requiredRefundLevel(input.refund.amountMinor, input.approvalThresholds);
  if (requiredLevel !== 'L2_SUPERVISOR' && levelRank(input.staffLevel) < levelRank(requiredLevel)) {
    if (!input.orderStore.commitApproval && !input.orderStore.approvalRequests) {
      throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'Order store cannot create an approval request.');
    }
    const approvalRequestId = crypto.randomUUID();
    const expiresAt = new Date(input.now.getTime() + 60 * 60_000).toISOString();
    const approval: ApprovalRecord = {
      id: approvalRequestId,
      action: 'ORDER_RESOLVE',
      targetId: order.id,
      targetVersion: order.version,
      amountMinor: input.refund.amountMinor,
      currency: input.refund.currency,
      requestedByStaffId: input.actor.actorStaffId,
      requiredLevel,
      reason: input.evidenceNote,
      payloadSnapshot: {
        expectedVersion: input.expectedVersion,
        targetStatus: input.targetStatus,
        refund: input.refund,
        playerEarning: input.playerEarning,
        reasonCode: input.reasonCode,
        evidenceNote: input.evidenceNote
      },
      expiresAt,
      createdAt: input.now.toISOString()
    };
    return {
      data: {
        approvalRequestId,
        code: 'APPROVAL_PENDING',
        requiredLevel,
        expiresAt,
        actionExecuted: false
      },
      statusCode: 202,
      commit: (auditRecord) => commitApproval(input.orderStore, { approval, auditRecord })
    };
  }
  let providerRefund: Transaction | null = null;
  const sourceTransaction = await findSucceededOrderCharge(input.orderStore, input.orderId);
  if (input.refund.amountMinor > 0 && sourceTransaction) {
    if (!sourceTransaction.externalRef) {
      throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'A successful source charge must have an external reference.');
    }
    providerRefund = internalWalletRefund(input.refund, input.orderId, `${input.idempotencyKey}:wallet`, input.now);
  }

  const resolution: OrderResolutionResult = {
    resolutionId: crypto.randomUUID(),
    orderId: order.id,
    targetStatus: input.targetStatus,
    refundAmountMinor: input.refund.amountMinor,
    playerEarningMinor: input.playerEarning.amountMinor,
    currency: order.currency,
    approvalRequestId: null,
    createdAt: input.now.toISOString()
  };
  const updatedOrder: OrderRecord = {
    ...order,
    status: input.targetStatus,
    version: order.version + 1,
    updatedAt: input.now.toISOString()
  };
  const persistedResolution: ResolutionCommitInput['resolution'] = {
    ...resolution,
    reasonCode: input.reasonCode,
    evidenceNote: input.evidenceNote,
    resolvedByStaffId: input.actor.actorStaffId,
    orderVersionSnapshot: input.expectedVersion,
    idempotencyKey: input.idempotencyKey
  };
  const event: OrderEventRecord = {
    id: crypto.randomUUID(),
    orderId: order.id,
    sequence: nextEventSequence(input.orderStore, order.id),
    eventType: 'RESOLVED',
    fromStatus: order.status,
    toStatus: input.targetStatus,
    actorUserId: input.actor.actorUserId,
    actorStaffId: input.actor.actorStaffId,
    actorSource: input.actor.actorSource,
    interactionId: input.actor.interactionId,
    payload: {
      reasonCode: input.reasonCode,
      refundAmountMinor: input.refund.amountMinor,
      playerEarningMinor: input.playerEarning.amountMinor,
      resolutionId: resolution.resolutionId
    },
    createdAt: input.now.toISOString()
  };
  const refundRecord = providerRefund && sourceTransaction
    ? buildRefundPersistenceRecord({
        id: crypto.randomUUID(),
        provider: 'INTERNAL_WALLET',
        sourceTransaction,
        order,
        resolutionId: resolution.resolutionId,
        actorStaffId: input.actor.actorStaffId,
        providerRefund,
        idempotencyKey: input.idempotencyKey,
        reasonCode: input.reasonCode,
        evidenceNote: input.evidenceNote,
        now: input.now
      })
    : null;
  return {
    data: resolution,
    commit: (auditRecord) => commitResolution(input.orderStore, {
      originalOrder: order,
      updatedOrder,
      resolution: persistedResolution,
      refund: refundRecord,
      preChargeSettlement: sourceTransaction
        ? null
        : {
            captureMinor: order.amountMinor - input.refund.amountMinor,
            releaseMinor: input.refund.amountMinor
          },
      event,
      auditRecord
    })
  };
}

export async function reassignOrder(input: {
  orderStore: AdminRefundOrderStore;
  orderId: string;
  expectedVersion: number;
  playerId: string;
  reasonCode: string;
  note: string | null;
  actor: ActorContext;
  staffLevel: StaffLevel;
  now: Date;
}): Promise<AdminStagedWrite<OrderRecord>> {
  if (!input.actor.actorStaffId || input.staffLevel === 'L1_SUPPORT') {
    throw new AdminOrderActionError('PERMISSION_DENIED', 'L2 or higher staff is required to reassign orders.');
  }
  const order = await requireOrder(input.orderStore, input.orderId, input.expectedVersion, input.actor);
  if (!['ACCEPTED', 'EXCEPTION'].includes(order.status)) {
    throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'Order cannot be reassigned from its current status.');
  }
  if (input.orderStore.validateReassignmentPlayer) {
    const eligible = await input.orderStore.validateReassignmentPlayer({ playerId: input.playerId, order });
    if (!eligible) {
      throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'Replacement player is not active and available.');
    }
  }
  const previousPlayerId = order.playerId;
  const updatedOrder: OrderRecord = {
    ...order,
    playerId: input.playerId,
    version: order.version + 1,
    updatedAt: input.now.toISOString()
  };
  const event: OrderEventRecord = {
    id: crypto.randomUUID(),
    orderId: order.id,
    sequence: nextEventSequence(input.orderStore, order.id),
    eventType: 'DETAILS_UPDATED',
    fromStatus: order.status,
    toStatus: order.status,
    actorUserId: input.actor.actorUserId,
    actorStaffId: input.actor.actorStaffId,
    actorSource: input.actor.actorSource,
    interactionId: input.actor.interactionId,
    payload: {
      reasonCode: input.reasonCode,
      note: input.note,
      previousPlayerId,
      nextPlayerId: input.playerId
    },
    createdAt: input.now.toISOString()
  };
  return {
    data: updatedOrder,
    commit: (auditRecord) => commitReassignment(input.orderStore, {
      originalOrder: order,
      updatedOrder,
      event,
      auditRecord
    })
  };
}

export function registerAdminOrderActionRoutes(
  server: FastifyInstance,
  options: {
    orderStore: AdminRefundOrderStore;
    now?: () => Date;
    policyReader?: PolicyReader;
  }
): void {
  const security = server.securityOptions;
  if (!security) {
    throw new Error('Admin order action routes require buildApiServer({ security })');
  }

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/admin/orders/:orderId/refund',
    permission: 'refund.execute',
    action: 'REFUND_ORDER',
    targetType: 'order',
    targetId: (request) => orderIdParam(request),
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    retryCommitFailures: true,
    requiresRecentStepUp: (_request, actor) => actor.actorLevel === 'L3_OPERATIONS' || actor.actorLevel === 'L4_ADMIN_OWNER',
    handler: async (request, actor) => {
      if (!actor.actorLevel) {
        throw new AdminOrderActionError('PERMISSION_DENIED', 'A staff actor is required.');
      }
      const body = parseRefundOrderBody(request.body);
      const approvalThresholds = await refundApprovalThresholds(options.policyReader);
      return refundOrder({
        orderStore: options.orderStore,
        orderId: orderIdParam(request),
        expectedVersion: body.expectedVersion,
        amount: body.amount,
        reasonCode: body.reasonCode,
        evidenceNote: body.evidenceNote,
        actor,
        staffLevel: actor.actorLevel,
        idempotencyKey: idempotencyKey(request),
        now: options.now?.() ?? new Date(),
        approvalThresholds
      });
    },
    mapError: mapAdminOrderActionError,
    fingerprintBody: (request) => request.body
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/admin/orders/:orderId/resolve',
    permission: 'order.resolve',
    action: 'RESOLVE_ORDER',
    targetType: 'order',
    targetId: (request) => orderIdParam(request),
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    retryCommitFailures: true,
    requiresRecentStepUp: (_request, actor) => actor.actorLevel === 'L3_OPERATIONS' || actor.actorLevel === 'L4_ADMIN_OWNER',
    handler: async (request, actor) => {
      if (!actor.actorLevel) {
        throw new AdminOrderActionError('PERMISSION_DENIED', 'A staff actor is required.');
      }
      const body = parseResolveOrderBody(request.body);
      const approvalThresholds = await refundApprovalThresholds(options.policyReader);
      return resolveOrder({
        orderStore: options.orderStore,
        orderId: orderIdParam(request),
        expectedVersion: body.expectedVersion,
        targetStatus: body.targetStatus,
        reasonCode: body.reasonCode,
        refund: body.refund,
        playerEarning: body.playerEarning,
        evidenceNote: body.evidenceNote,
        actor,
        staffLevel: actor.actorLevel,
        idempotencyKey: idempotencyKey(request),
        now: options.now?.() ?? new Date(),
        approvalThresholds
      });
    },
    mapError: mapAdminOrderActionError,
    fingerprintBody: (request) => request.body
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/admin/orders/:orderId/reassign',
    permission: 'order.reassign',
    action: 'REASSIGN_ORDER',
    targetType: 'order',
    targetId: (request) => orderIdParam(request),
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    retryCommitFailures: true,
    handler: async (request, actor) => {
      if (!actor.actorLevel) {
        throw new AdminOrderActionError('PERMISSION_DENIED', 'A staff actor is required.');
      }
      const body = parseReassignOrderBody(request.body);
      return reassignOrder({
        orderStore: options.orderStore,
        orderId: orderIdParam(request),
        expectedVersion: body.expectedVersion,
        playerId: body.playerId,
        reasonCode: body.reasonCode,
        note: body.note,
        actor,
        staffLevel: actor.actorLevel,
        now: options.now?.() ?? new Date()
      });
    },
    mapError: mapAdminOrderActionError,
    fingerprintBody: (request) => request.body
  });
}

export class PostgresAdminOrderActionStore implements AdminRefundOrderStore {
  private readonly pool: Pool;
  private readonly orderStore: PostgresOrderStore;

  constructor(options: { pool: Pool }) {
    this.pool = options.pool;
    this.orderStore = new PostgresOrderStore({ pool: options.pool });
  }

  findById(orderId: string): Promise<OrderRecord | null> {
    return this.orderStore.findById(orderId);
  }

  async findSucceededOrderCharge(orderId: string): Promise<ExternalTransactionMirrorRecord | null> {
    const result = await this.pool.query<{
      id: string;
      provider: string;
      user_id: string;
      order_id: string;
      fund_reservation_id: string | null;
      external_ref: string | null;
      idempotency_key: string;
      amount_minor: string | number;
      currency: string;
      status: ExternalTransactionMirrorRecord['status'];
      created_at: Date | string;
    }>(
      `
SELECT id, provider, user_id, order_id, fund_reservation_id, external_ref,
       idempotency_key, amount_minor, currency, status, created_at
FROM external_transactions
WHERE order_id = $1
  AND type = 'ORDER_CHARGE'
  AND status = 'SUCCEEDED'
ORDER BY created_at DESC
LIMIT 1
      `,
      [orderId]
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          provider: row.provider,
          type: 'ORDER_CHARGE',
          userId: row.user_id,
          orderId: row.order_id,
          fundReservationId: row.fund_reservation_id,
          externalRef: row.external_ref,
          idempotencyKey: row.idempotency_key,
          amountMinor: Number(row.amount_minor),
          currency: row.currency as ExternalTransactionMirrorRecord['currency'],
          status: row.status,
          createdAt: new Date(row.created_at).toISOString()
        }
      : null;
  }

  async findReservedRefundedMinor(sourceTransactionId: string): Promise<number> {
    const result = await this.pool.query<{ amount_minor: string | number }>(
      `SELECT COALESCE(SUM(amount_minor), 0) AS amount_minor
       FROM refunds
       WHERE source_external_transaction_id = $1
         AND status IN ('PENDING', 'SUCCEEDED')`,
      [sourceTransactionId]
    );
    return Number(result.rows[0]?.amount_minor ?? 0);
  }

  async validateReassignmentPlayer(input: { playerId: string; order: OrderRecord }): Promise<boolean> {
    const result = await this.pool.query(
      `
SELECT 1
FROM player_profiles pp
WHERE pp.user_id = $1
  AND pp.review_status = 'ACTIVE'
  AND pp.availability = 'AVAILABLE'
  AND pp.discord_presence IN ('ONLINE', 'IDLE', 'DND')
  AND EXISTS (
    SELECT 1
    FROM player_skills ps
    JOIN skill_tags st ON st.id = ps.skill_tag_id
    WHERE ps.player_profile_id = pp.id
      AND st.enabled = true
      AND st.type = 'GAME'
      AND st.code = $3
  )
  AND EXISTS (
    SELECT 1
    FROM player_skills ps
    JOIN skill_tags st ON st.id = ps.skill_tag_id
    WHERE ps.player_profile_id = pp.id
      AND st.enabled = true
      AND st.type = 'SERVICE'
      AND st.code = $4
  )
  AND NOT EXISTS (
    SELECT 1
    FROM orders active_order
    WHERE active_order.active_player_slot_id = $1
      AND active_order.id <> $2
      AND active_order.status IN ('ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION')
  )
LIMIT 1
      `,
      [input.playerId, input.order.id, input.order.game, input.order.service]
    );
    return Boolean(result.rows[0]);
  }

  commitApproval(input: ApprovalCommitInput): Promise<void> {
    return this.withTransaction(async (client) => {
      await insertApprovalRequest(client, input.approval);
      await insertAdminAuditRecord(client, { ...input.auditRecord, approvalRequestId: input.approval.id });
    });
  }

  commitRefund(input: RefundCommitInput): Promise<void> {
    return this.withTransaction(async (client) => {
      await lockOrderVersion(client, input.order.id, input.order.version);
      await insertRefundAndCorrections(client, {
        order: input.order,
        refund: input.refund,
        desiredPlayerEarningMinor: null,
        resolutionId: null
      });
      await insertAdminAuditRecord(client, input.auditRecord);
    });
  }

  commitResolution(input: ResolutionCommitInput): Promise<void> {
    return this.withTransaction(async (client) => {
      if (input.preChargeSettlement) {
        await settlePreChargeReservation(client, {
          order: input.originalOrder,
          resolution: input.resolution,
          ...input.preChargeSettlement
        });
      }
      const updated = await client.query(
        `
UPDATE orders
SET status = $2::"OrderStatus",
    row_version = $3,
    active_customer_slot_id = NULL,
    active_player_slot_id = NULL,
    completed_at = CASE WHEN $2 = 'COMPLETED' THEN $4 ELSE completed_at END,
    cancelled_at = CASE WHEN $2 = 'CANCELLED' THEN $4 ELSE cancelled_at END,
    updated_at = $4
WHERE id = $1
  AND row_version = $5
  AND status = $6::"OrderStatus"
        `,
        [
          input.updatedOrder.id,
          input.updatedOrder.status,
          input.updatedOrder.version,
          new Date(input.updatedOrder.updatedAt),
          input.originalOrder.version,
          input.originalOrder.status
        ]
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new AdminOrderActionError('CONFLICT', 'Order version is stale.');
      }
      await client.query(
        `
INSERT INTO order_resolutions (
  id, order_id, target_status, reason_code, refund_amount_minor,
  player_earning_minor, currency, evidence_note, resolved_by_staff_id,
  approval_request_id, order_version_snapshot, idempotency_key, created_at
)
VALUES (
  $1, $2, $3::"OrderStatus", $4::"ResolutionReasonCode", $5,
  $6, $7, $8, $9, NULL, $10, $11, $12
)
        `,
        [
          input.resolution.resolutionId,
          input.resolution.orderId,
          input.resolution.targetStatus,
          input.resolution.reasonCode,
          input.resolution.refundAmountMinor,
          input.resolution.playerEarningMinor,
          input.resolution.currency,
          input.resolution.evidenceNote,
          input.resolution.resolvedByStaffId,
          input.resolution.orderVersionSnapshot,
          input.resolution.idempotencyKey,
          new Date(input.resolution.createdAt)
        ]
      );
      if (input.refund) {
        await insertRefundAndCorrections(client, {
          order: input.originalOrder,
          refund: input.refund,
          desiredPlayerEarningMinor: input.resolution.playerEarningMinor,
          resolutionId: input.resolution.resolutionId
        });
      } else {
        await insertEarningResolutionAdjustment(client, {
          order: input.originalOrder,
          desiredPlayerEarningMinor: input.resolution.playerEarningMinor,
          resolutionId: input.resolution.resolutionId,
          refundId: null,
          reason: input.resolution.reasonCode,
          idempotencyKey: input.resolution.idempotencyKey,
          actorStaffId: input.resolution.resolvedByStaffId,
          createdAt: input.resolution.createdAt
        });
      }
      await insertResolutionRiskEvent(client, {
        order: input.originalOrder,
        reasonCode: input.resolution.reasonCode,
        evidenceNote: input.resolution.evidenceNote,
        actorStaffId: input.resolution.resolvedByStaffId,
        createdAt: input.resolution.createdAt
      });
      await insertAdminOrderEvent(client, input.event);
      await insertAdminAuditRecord(client, input.auditRecord);
      await insertAdminOrderPanelSync(client, {
        orderId: input.updatedOrder.id, version: input.updatedOrder.version,
        kind: 'ORDER_RESOLVED_CHANNEL_SYNC', now: new Date(input.updatedOrder.updatedAt)
      });
      await enqueueTerminalChannelArchive(client, {
        orderId: input.updatedOrder.id,
        orderVersion: input.updatedOrder.version,
        now: new Date(input.updatedOrder.updatedAt)
      });
    });
  }

  commitReassignment(input: ReassignmentCommitInput): Promise<void> {
    return this.withTransaction(async (client) => {
      const updated = await client.query(
        `
UPDATE orders
SET player_id = $2,
    active_player_slot_id = $2,
    row_version = $3,
    updated_at = $4
WHERE id = $1
  AND row_version = $5
  AND status = $6::"OrderStatus"
        `,
        [
          input.updatedOrder.id,
          input.updatedOrder.playerId,
          input.updatedOrder.version,
          new Date(input.updatedOrder.updatedAt),
          input.originalOrder.version,
          input.originalOrder.status
        ]
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new AdminOrderActionError('CONFLICT', 'Order version is stale.');
      }
      await insertAdminOrderEvent(client, input.event);
      await insertAdminAuditRecord(client, input.auditRecord);
      await insertAdminOrderPanelSync(client, {
        orderId: input.updatedOrder.id, version: input.updatedOrder.version,
        kind: 'ORDER_REASSIGNED_CHANNEL_SYNC', now: new Date(input.updatedOrder.updatedAt)
      });
    });
  }

  private async withTransaction(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof AdminOrderActionError) {
        throw error;
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

async function insertAdminOrderPanelSync(client: PoolClient, input: {
  orderId: string; version: number; kind: string; now: Date;
}): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (
       id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,
       row_version,attempt_count,max_attempts,available_at,created_at,updated_at
     ) VALUES (
       gen_random_uuid(),'PANEL_SYNC','order',$1,$1,$2,$3::jsonb,'PENDING',1,0,8,$4,$4,$4
     ) ON CONFLICT DO NOTHING`,
    [input.orderId, `order-panel:${input.kind}:${input.orderId}:v${input.version}`, JSON.stringify({
      kind: input.kind, orderId: input.orderId
    }), input.now]
  );
}

function commitApproval(store: AdminRefundOrderStore, input: ApprovalCommitInput): Promise<void> | void {
  if (store.commitApproval) {
    return store.commitApproval(input);
  }
  if (!store.approvalRequests) {
    throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'Order store cannot create an approval request.');
  }
  store.approvalRequests.push({
    ...input.approval,
    targetType: 'ORDER',
    status: 'PENDING',
    rowVersion: 1
  });
}

function commitRefund(store: AdminRefundOrderStore, input: RefundCommitInput): Promise<void> | void {
  if (store.commitRefund) {
    return store.commitRefund(input);
  }
  const refunds = store.refunds ?? (store.refunds = []);
  const alreadyRefundedMinor = refunds.reduce((total, refund) => {
    return refund.sourceTransactionId === input.refund.sourceTransaction.id
      && (refund.status === 'PENDING' || refund.status === 'SUCCEEDED')
      ? total + refund.amountMinor
      : total;
  }, 0);
  assertRefundWithinRemaining(input.refund.amountMinor, input.refund.sourceTransaction.amountMinor, alreadyRefundedMinor);
  refunds.push({
    id: input.refund.id,
    orderId: input.refund.orderId,
    sourceTransactionId: input.refund.sourceTransaction.id,
    amountMinor: input.refund.amountMinor,
    currency: input.refund.currency,
    status: input.refund.status,
    idempotencyKey: input.refund.idempotencyKey
  });
}

function commitResolution(store: AdminRefundOrderStore, input: ResolutionCommitInput): Promise<void> | void {
  if (store.commitResolution) {
    return store.commitResolution(input);
  }
  commitOrderReplacement(store, input.updatedOrder);
  store.resolutions?.push({ ...input.resolution });
  const earningReversalMinor = Math.max(0, input.originalOrder.playerEarningMinor - input.resolution.playerEarningMinor);
  if (earningReversalMinor > 0) {
    store.playerEarningAdjustments?.push({
      id: crypto.randomUUID(),
      orderId: input.originalOrder.id,
      type: 'REVERSAL_DEBIT',
      amountMinor: earningReversalMinor,
      currency: input.originalOrder.currency,
      reason: input.resolution.reasonCode,
      sourceRefundId: input.refund?.id ?? null,
      sourceResolutionId: input.resolution.resolutionId,
      createdByStaffId: input.resolution.resolvedByStaffId
    });
  }
  if (input.refund) {
    store.commissionAdjustments?.push({
      id: crypto.randomUUID(),
      orderId: input.originalOrder.id,
      type: 'REVERSAL_DEBIT',
      amountMinor: input.refund.amountMinor,
      currency: input.originalOrder.currency,
      reason: input.resolution.reasonCode,
      sourceRefundId: input.refund.id,
      createdByStaffId: input.resolution.resolvedByStaffId
    });
  }
  appendOrderEvent(store, input.event);
}

function commitReassignment(store: AdminRefundOrderStore, input: ReassignmentCommitInput): Promise<void> | void {
  if (store.commitReassignment) {
    return store.commitReassignment(input);
  }
  commitOrderReplacement(store, input.updatedOrder);
  appendOrderEvent(store, input.event);
}

function buildRefundPersistenceRecord(input: {
  id: string;
  provider: string;
  sourceTransaction: ExternalTransactionMirrorRecord;
  order: OrderRecord;
  resolutionId: string | null;
  actorStaffId: string | null;
  providerRefund: Transaction;
  idempotencyKey: string;
  reasonCode: string;
  evidenceNote: string;
  now: Date;
}): RefundPersistenceRecord {
  if (!input.actorStaffId) {
    throw new AdminOrderActionError('PERMISSION_DENIED', 'A staff actor is required to execute refunds.');
  }
  return {
    id: input.id,
    publicId: `RF-${input.id.replaceAll('-', '').slice(0, 20).toUpperCase()}`,
    provider: input.provider,
    sourceTransaction: input.sourceTransaction,
    beneficiaryUserId: input.order.customerId,
    orderId: input.order.id,
    orderResolutionId: input.resolutionId,
    requestedByStaffId: input.actorStaffId,
    externalRefundRef: input.providerRefund.providerRef,
    idempotencyKey: input.idempotencyKey,
    amountMinor: input.providerRefund.amount.amountMinor,
    currency: input.providerRefund.amount.currency,
    status: input.providerRefund.status,
    reasonCode: input.reasonCode,
    reasonNote: input.evidenceNote.slice(0, 1_000),
    createdAt: input.now.toISOString()
  };
}

function internalWalletRefund(amount: { amountMinor: number; currency: Currency }, orderId: string,
  idempotencyKey: string, now: Date): Transaction {
  return { kind: 'REFUND', status: 'SUCCEEDED', idempotencyKey, fundReservationId: null, fundReservationVersion: null,
    businessSource: 'ORDER', amount, businessReference: orderId, providerRef: deterministicUuid(idempotencyKey),
    originalProviderRef: null, providerStatus: 'INTERNAL_WALLET_CREDITED', observedAt: now.toISOString(),
    providerOccurredAt: now.toISOString(), failure: null };
}

function internalWalletCharge(amount: { amountMinor: number; currency: Currency }, orderId: string, reservationId: string,
  reservationVersion: number, idempotencyKey: string, now: Date): Transaction {
  return { kind:'FALLBACK_DEBIT',status:'SUCCEEDED',idempotencyKey,fundReservationId:reservationId,
    fundReservationVersion:reservationVersion,businessSource:'ORDER',amount,businessReference:orderId,
    providerRef:deterministicUuid(idempotencyKey),originalProviderRef:null,providerStatus:'INTERNAL_WALLET_CAPTURED',
    observedAt:now.toISOString(),providerOccurredAt:now.toISOString(),failure:null };
}

function deterministicUuid(value: string): string {
  const bytes=crypto.createHash('sha256').update(value).digest().subarray(0,16);
  bytes[6]=(bytes[6]&0x0f)|0x50;bytes[8]=(bytes[8]&0x3f)|0x80;
  return `${bytes.subarray(0,4).toString('hex')}-${bytes.subarray(4,6).toString('hex')}-${bytes.subarray(6,8).toString('hex')}-${bytes.subarray(8,10).toString('hex')}-${bytes.subarray(10).toString('hex')}`;
}

async function lockOrderVersion(client: OrderQueryClient, orderId: string, version: number): Promise<void> {
  const result = await client.query<{ row_version: number }>(
    'SELECT row_version FROM orders WHERE id = $1 FOR UPDATE',
    [orderId]
  );
  if (!result.rows[0]) {
    throw new AdminOrderActionError('NOT_FOUND', 'Order was not found.');
  }
  if (result.rows[0].row_version !== version) {
    throw new AdminOrderActionError('CONFLICT', 'Order version is stale.');
  }
}

async function insertApprovalRequest(client: OrderQueryClient, approval: ApprovalRecord): Promise<void> {
  const payloadJson = JSON.stringify(approval.payloadSnapshot);
  const payloadHash = crypto.createHash('sha256').update(payloadJson).digest('hex');
  await client.query(
    `
INSERT INTO approval_requests (
  id, public_id, action, target_type, target_id, target_version,
  payload_snapshot, payload_hash, amount_minor, currency,
  requested_by_staff_id, required_level, status, row_version,
  reason, expires_at, created_at, updated_at
)
VALUES (
  $1, $2, $3::"ApprovalAction", 'ORDER', $4, $5,
  $6::jsonb, $7, $8, $9,
  $10, $11::"StaffLevel", 'PENDING', 1,
  $12, $13, $14, $14
)
    `,
    [
      approval.id,
      `APR-${approval.id.replaceAll('-', '').slice(0, 18).toUpperCase()}`,
      approval.action,
      approval.targetId,
      approval.targetVersion,
      payloadJson,
      payloadHash,
      approval.amountMinor,
      approval.currency,
      approval.requestedByStaffId,
      approval.requiredLevel,
      approval.reason.slice(0, 1_000),
      new Date(approval.expiresAt),
      new Date(approval.createdAt)
    ]
  );
}

async function settlePreChargeReservation(client: OrderQueryClient, input: {
  order: OrderRecord;
  resolution: ResolutionCommitInput['resolution'];
  captureMinor: number;
  releaseMinor: number;
}): Promise<void> {
  const reservationResult = await client.query<{
    id: string;
    user_id: string;
    mode: 'LOCAL_RESERVATION';
    provider: string | null;
    provider_hold_ref: string | null;
    amount_minor: string | number;
    currency: Currency;
    status: 'ACTIVE' | 'DISPUTED';
    row_version: number;
  }>(
    `
SELECT fr.id, fr.user_id, fr.mode, fr.provider, fr.provider_hold_ref,
       fr.amount_minor, fr.currency, fr.status, fr.row_version
FROM fund_reservations fr
WHERE fr.order_id = $1
  AND fr.source_type = 'ORDER'
  AND fr.status IN ('ACTIVE', 'DISPUTED')
FOR UPDATE OF fr
    `,
    [input.order.id]
  );
  const reservation = reservationResult.rows[0];
  if (!reservation) {
    throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'An active or disputed order reservation is required before pre-charge resolution.');
  }
  const reservationAmount = Number(reservation.amount_minor);
  if (input.captureMinor < 0 || input.releaseMinor < 0 || input.captureMinor + input.releaseMinor !== reservationAmount) {
    throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'Resolution settlement must exactly match the order reservation amount.');
  }
  const providerCharge = input.captureMinor > 0
    ? internalWalletCharge({ amountMinor: input.captureMinor, currency: reservation.currency }, input.order.id,
        reservation.id, reservation.row_version, `${input.resolution.idempotencyKey}:wallet-capture`, new Date(input.resolution.createdAt))
    : null;
  if(providerCharge){
    const wallet=await client.query<{id:string}>('SELECT id FROM wallet_accounts WHERE user_id=$1 FOR UPDATE',[reservation.user_id]);
    if(!wallet.rows[0])throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION','Customer wallet was not found.');
    await client.query(`INSERT INTO wallet_entries
      (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at,created_at)
      VALUES ($1,$2,'ORDER_CAPTURE_DEBIT','DEBIT',$3,'CAT','FUND_RESERVATION',$4,$5,$6,$6)`,
      [deterministicUuid(`${providerCharge.idempotencyKey}:entry`),wallet.rows[0].id,input.captureMinor,reservation.id,providerCharge.idempotencyKey,new Date(input.resolution.createdAt)]);
    await client.query('UPDATE wallet_accounts SET row_version=row_version+1,updated_at=$2 WHERE id=$1',[wallet.rows[0].id,new Date(input.resolution.createdAt)]);
  }

  let sequence = await nextFundReservationSequence(client, reservation.id);
  let status: 'ACTIVE' | 'DISPUTED' | 'PARTIALLY_SETTLED' = reservation.status;
  let version = reservation.row_version;
  if (status === 'DISPUTED') {
    version += 1;
    await insertFundReservationSettlementEvent(client, {
      reservationId: reservation.id,
      sequence: sequence++,
      eventType: 'DISPUTE_RESOLVED',
      fromStatus: 'DISPUTED',
      toStatus: 'ACTIVE',
      amountMinor: 0,
      version,
      idempotencyKey: `${input.resolution.idempotencyKey}:reservation:dispute-resolved`,
      actorStaffId: input.resolution.resolvedByStaffId,
      reasonCode: input.resolution.reasonCode,
      createdAt: input.resolution.createdAt
    });
    status = 'ACTIVE';
  }
  if (input.captureMinor > 0) {
    version += 1;
    const toStatus = input.releaseMinor > 0 ? 'PARTIALLY_SETTLED' : 'CAPTURED';
    await insertFundReservationSettlementEvent(client, {
      reservationId: reservation.id,
      sequence: sequence++,
      eventType: 'CAPTURED',
      fromStatus: status,
      toStatus,
      amountMinor: input.captureMinor,
      version,
      idempotencyKey: `${input.resolution.idempotencyKey}:reservation:capture`,
      actorStaffId: input.resolution.resolvedByStaffId,
      reasonCode: input.resolution.reasonCode,
      createdAt: input.resolution.createdAt
    });
    status = toStatus === 'PARTIALLY_SETTLED' ? 'PARTIALLY_SETTLED' : 'ACTIVE';
  }
  if (input.releaseMinor > 0) {
    version += 1;
    await insertFundReservationSettlementEvent(client, {
      reservationId: reservation.id,
      sequence,
      eventType: 'RELEASED',
      fromStatus: status,
      toStatus: 'RELEASED',
      amountMinor: input.releaseMinor,
      version,
      idempotencyKey: `${input.resolution.idempotencyKey}:reservation:release`,
      actorStaffId: input.resolution.resolvedByStaffId,
      reasonCode: input.resolution.reasonCode,
      createdAt: input.resolution.createdAt
    });
  }
  if (providerCharge) {
    await insertResolutionOrderCharge(client, {
      order: input.order,
      reservationId: reservation.id,
      provider: 'INTERNAL_WALLET',
      providerCharge,
      idempotencyKey: input.resolution.idempotencyKey,
      createdAt: input.resolution.createdAt
    });
  }
}

async function nextFundReservationSequence(client: OrderQueryClient, reservationId: string): Promise<number> {
  const result = await client.query<{ next_sequence: string | number }>(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM fund_reservation_events WHERE fund_reservation_id = $1`,
    [reservationId]
  );
  return Number(result.rows[0]?.next_sequence ?? 1);
}

async function insertFundReservationSettlementEvent(client: OrderQueryClient, input: {
  reservationId: string;
  sequence: number;
  eventType: 'DISPUTE_RESOLVED' | 'CAPTURED' | 'RELEASED';
  fromStatus: 'ACTIVE' | 'DISPUTED' | 'PARTIALLY_SETTLED';
  toStatus: 'ACTIVE' | 'PARTIALLY_SETTLED' | 'CAPTURED' | 'RELEASED';
  amountMinor: number;
  version: number;
  idempotencyKey: string;
  actorStaffId: string;
  reasonCode: string;
  createdAt: string;
}): Promise<void> {
  await client.query(
    `
INSERT INTO fund_reservation_events (
  id, fund_reservation_id, sequence, event_type, from_status, to_status,
  amount_minor, reservation_version, idempotency_key,
  actor_user_id, actor_staff_id, actor_source, reason_code, created_at
) VALUES (
  gen_random_uuid(), $1, $2, $3::"FundReservationEventType", $4::"FundReservationStatus", $5::"FundReservationStatus",
  $6, $7, $8, NULL, $9, 'DASHBOARD', $10, $11
)
    `,
    [
      input.reservationId,
      input.sequence,
      input.eventType,
      input.fromStatus,
      input.toStatus,
      input.amountMinor,
      input.version,
      input.idempotencyKey,
      input.actorStaffId,
      input.reasonCode,
      new Date(input.createdAt)
    ]
  );
}

async function insertResolutionOrderCharge(client: OrderQueryClient, input: {
  order: OrderRecord;
  reservationId: string;
  provider: string;
  providerCharge: Transaction;
  idempotencyKey: string;
  createdAt: string;
}): Promise<void> {
  const transactionId = crypto.randomUUID();
  await client.query(
    `
INSERT INTO external_transactions (
  id, provider, type, user_id, order_id, fund_reservation_id, external_ref,
  idempotency_key, amount_minor, currency, status, initiated_at, settled_at, created_at, updated_at
) VALUES (
  $1, $2, 'ORDER_CHARGE', $3, $4, $5, $6,
  $7, $8, $9, 'SUCCEEDED', $10, $10, $10, $10
)
    `,
    [
      transactionId,
      input.provider,
      input.order.customerId,
      input.order.id,
      input.reservationId,
      input.providerCharge.providerRef,
      `${input.idempotencyKey}:external`,
      input.providerCharge.amount.amountMinor,
      input.providerCharge.amount.currency,
      new Date(input.createdAt)
    ]
  );
  await client.query(
    `
INSERT INTO consumption_entries (
  id, user_id, entry_type, direction, order_id, external_transaction_id,
  amount_minor, currency, source_type, source_id, idempotency_key, occurred_at
) VALUES (
  gen_random_uuid(), $1, 'ORDER_CHARGE', 'DEBIT', $2, $3,
  $4, $5, 'ORDER', $2, $6, $7
)
    `,
    [
      input.order.customerId,
      input.order.id,
      transactionId,
      input.providerCharge.amount.amountMinor,
      input.providerCharge.amount.currency,
      `${input.idempotencyKey}:consumption`,
      new Date(input.createdAt)
    ]
  );
}

async function insertRefundAndCorrections(client: OrderQueryClient, input: {
  order: OrderRecord;
  refund: RefundPersistenceRecord;
  desiredPlayerEarningMinor: number | null;
  resolutionId: string | null;
}): Promise<void> {
  const refund = input.refund;
  if(refund.currency!=='CAT')throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION','Refunds must use CAT.');
  await lockAndAssertRefundCapacity(client, refund);
  const wallet=await client.query<{id:string}>('SELECT id FROM wallet_accounts WHERE user_id=$1 FOR UPDATE',[refund.beneficiaryUserId]);
  if(!wallet.rows[0])throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION','Customer wallet was not found.');
  await client.query(
    `
INSERT INTO refunds (
  id, public_id, provider, source_external_transaction_id, beneficiary_user_id,
  order_id, order_resolution_id, requested_by_staff_id, external_refund_ref,
  idempotency_key, amount_minor, currency, status, reason_code, reason_note,
  requested_at, settled_at, created_at, updated_at
)
VALUES (
  $1, $2, $3, $4, $5,
  $6, $7, $8, $9,
  $10, $11, $12, $13::"RefundStatus", $14::"ResolutionReasonCode", $15,
  $16::timestamptz,
  CASE WHEN $13::"RefundStatus" = 'SUCCEEDED' THEN $16::timestamptz ELSE NULL END,
  $16::timestamptz, $16::timestamptz
)
    `,
    [
      refund.id,
      refund.publicId,
      refund.provider,
      refund.sourceTransaction.id,
      refund.beneficiaryUserId,
      refund.orderId,
      refund.orderResolutionId,
      refund.requestedByStaffId,
      refund.externalRefundRef,
      refund.idempotencyKey,
      refund.amountMinor,
      refund.currency,
      refund.status,
      refund.reasonCode,
      refund.reasonNote,
      new Date(refund.createdAt)
    ]
  );
  await client.query(`INSERT INTO wallet_entries
    (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at,created_at)
    VALUES ($1,$2,'ORDER_REFUND_CREDIT','CREDIT',$3,'CAT','ORDER_REFUND',$4,$5,$6,$6)`,
    [deterministicUuid(`${refund.idempotencyKey}:wallet-entry`),wallet.rows[0].id,refund.amountMinor,refund.id,`${refund.idempotencyKey}:wallet`,new Date(refund.createdAt)]);
  await client.query('UPDATE wallet_accounts SET row_version=row_version+1,updated_at=$2 WHERE id=$1',[wallet.rows[0].id,new Date(refund.createdAt)]);
  const sourceConsumption = await client.query<{ id: string; amount_minor: string | number }>(
    `
SELECT id, amount_minor
FROM consumption_entries
WHERE external_transaction_id = $1
  AND direction = 'DEBIT'
ORDER BY occurred_at ASC
LIMIT 1
FOR UPDATE
    `,
    [refund.sourceTransaction.id]
  );
  const source = sourceConsumption.rows[0];
  if (!source) {
    throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'Original consumption entry is required for refund correction.');
  }
  await client.query(
    `
INSERT INTO consumption_entries (
  id, user_id, entry_type, direction, order_id, refund_id,
  reversal_of_entry_id, amount_minor, currency, source_type, source_id,
  idempotency_key, occurred_at
)
VALUES ($1, $2, 'REFUND_REVERSAL', 'CREDIT', $3, $4, $5, $6, $7, 'REFUND', $4, $8, $9)
    `,
    [
      crypto.randomUUID(),
      refund.beneficiaryUserId,
      refund.orderId,
      refund.id,
      source.id,
      refund.amountMinor,
      refund.currency,
      `${refund.idempotencyKey}:consumption`,
      new Date(refund.createdAt)
    ]
  );
  const desiredPlayerEarningMinor = input.desiredPlayerEarningMinor ?? Math.max(
    0,
    input.order.playerEarningMinor - proportionalAmount(input.order.playerEarningMinor, refund.amountMinor, input.order.amountMinor)
  );
  await insertEarningResolutionAdjustment(client, {
    order: input.order,
    desiredPlayerEarningMinor,
    resolutionId: input.resolutionId,
    refundId: refund.id,
    reason: refund.reasonCode,
    idempotencyKey: refund.idempotencyKey,
    actorStaffId: refund.requestedByStaffId,
    createdAt: refund.createdAt
  });
  const commissions = await client.query<{ id: string; amount_minor: string | number }>(
    'SELECT id, amount_minor FROM commissions WHERE source_consumption_entry_id = $1 FOR UPDATE',
    [source.id]
  );
  for (const commission of commissions.rows) {
    const reversalMinor = proportionalAmount(Number(commission.amount_minor), refund.amountMinor, Number(source.amount_minor));
    if (reversalMinor === 0) {
      continue;
    }
    await client.query(
      `
INSERT INTO commission_adjustments (
  id, commission_id, type, source_refund_id, amount_minor, currency,
  reason, idempotency_key, created_by_staff_id, created_at
)
VALUES ($1, $2, 'REVERSAL_DEBIT', $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        crypto.randomUUID(),
        commission.id,
        refund.id,
        reversalMinor,
        refund.currency,
        refund.reasonCode,
        `${refund.idempotencyKey}:commission:${commission.id}`,
        refund.requestedByStaffId,
        new Date(refund.createdAt)
      ]
    );
  }
}

async function lockAndAssertRefundCapacity(client: OrderQueryClient, refund: RefundPersistenceRecord): Promise<void> {
  const source = await client.query<{ amount_minor: string | number; currency: string; status: string }>(
    `SELECT amount_minor, currency, status
     FROM external_transactions
     WHERE id = $1
     FOR UPDATE`,
    [refund.sourceTransaction.id]
  );
  const charge = source.rows[0];
  if (!charge || charge.status !== 'SUCCEEDED' || charge.currency !== refund.currency) {
    throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'The successful source charge is unavailable or changed.');
  }
  const refunded = await client.query<{ amount_minor: string | number }>(
    `SELECT COALESCE(SUM(amount_minor), 0) AS amount_minor
     FROM refunds
     WHERE source_external_transaction_id = $1
       AND status IN ('PENDING', 'SUCCEEDED')`,
    [refund.sourceTransaction.id]
  );
  assertRefundWithinRemaining(refund.amountMinor, Number(charge.amount_minor), Number(refunded.rows[0]?.amount_minor ?? 0));
}

async function insertEarningResolutionAdjustment(client: OrderQueryClient, input: {
  order: OrderRecord;
  desiredPlayerEarningMinor: number;
  resolutionId: string | null;
  refundId: string | null;
  reason: string;
  idempotencyKey: string;
  actorStaffId: string;
  createdAt: string;
}): Promise<void> {
  const earningResult = await client.query<{ id: string; amount_minor: string | number }>(
    'SELECT id, amount_minor FROM player_earnings WHERE order_id = $1 FOR UPDATE',
    [input.order.id]
  );
  const earning = earningResult.rows[0];
  if (!earning) {
    if (input.desiredPlayerEarningMinor === 0) {
      return;
    }
    await client.query(
      `
INSERT INTO player_earnings (
  id, order_id, player_user_id, base_units, unit_payout_minor,
  amount_minor, currency, status, row_version, created_at, updated_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', 1, $8, $8)
      `,
      [
        crypto.randomUUID(),
        input.order.id,
        input.order.playerId,
        input.order.unitCount,
        input.order.playerUnitPayoutMinor,
        input.desiredPlayerEarningMinor,
        input.order.currency,
        new Date(input.createdAt)
      ]
    );
    return;
  }
  const reversalMinor = Math.max(0, Number(earning.amount_minor) - input.desiredPlayerEarningMinor);
  if (reversalMinor === 0) {
    return;
  }
  await client.query(
    `
INSERT INTO player_earning_adjustments (
  id, player_earning_id, type, source_refund_id, source_resolution_id,
  amount_minor, currency, reason, idempotency_key, created_by_staff_id, created_at
)
VALUES ($1, $2, 'REVERSAL_DEBIT', $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [
      crypto.randomUUID(),
      earning.id,
      input.refundId,
      input.resolutionId,
      reversalMinor,
      input.order.currency,
      input.reason,
      `${input.idempotencyKey}:earning:${earning.id}`,
      input.actorStaffId,
      new Date(input.createdAt)
    ]
  );
}

async function insertAdminOrderEvent(client: OrderQueryClient, event: OrderEventRecord): Promise<void> {
  await client.query(
    `
INSERT INTO order_events (
  id, order_id, sequence, event_type, from_status, to_status,
  actor_user_id, actor_staff_id, actor_source, interaction_id, payload, created_at
)
SELECT $1, $2, COALESCE(MAX(sequence), 0) + 1, $3::"OrderEventType", $4::"OrderStatus", $5::"OrderStatus",
       $6, $7, $8::"ActorSource", $9, $10::jsonb, $11
FROM order_events
WHERE order_id = $2
    `,
    [
      event.id,
      event.orderId,
      event.eventType,
      event.fromStatus,
      event.toStatus,
      event.actorUserId,
      event.actorStaffId,
      event.actorSource,
      event.interactionId,
      JSON.stringify(event.payload),
      new Date(event.createdAt)
    ]
  );
}

async function insertResolutionRiskEvent(client: OrderQueryClient, input: {
  order: OrderRecord;
  reasonCode: string;
  evidenceNote: string;
  actorStaffId: string;
  createdAt: string;
}): Promise<void> {
  const userId = input.reasonCode === 'PLAYER_NO_SHOW'
    ? input.order.playerId
    : input.reasonCode === 'CUSTOMER_NO_SHOW'
      ? input.order.customerId
      : null;
  if (!userId) {
    return;
  }
  await client.query(
    `
INSERT INTO risk_events (
  id, user_id, order_id, type, severity, source, notes, created_by_staff_id, created_at
)
VALUES ($1, $2, $3, $4::"RiskEventType", 'MEDIUM', 'ORDER_RESOLUTION', $5, $6, $7)
    `,
    [
      crypto.randomUUID(),
      userId,
      input.order.id,
      input.reasonCode,
      input.evidenceNote.slice(0, 1_000),
      input.actorStaffId,
      new Date(input.createdAt)
    ]
  );
}

async function insertAdminAuditRecord(client: OrderQueryClient, record: AuditRecord): Promise<void> {
  await insertPostgresAuditRecord(client, record);
}

function proportionalAmount(baseMinor: number, portionMinor: number, totalMinor: number): number {
  if (baseMinor <= 0 || portionMinor <= 0 || totalMinor <= 0) {
    return 0;
  }
  return Number((BigInt(baseMinor) * BigInt(portionMinor)) / BigInt(totalMinor));
}

function isUuid(value: string | null): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value));
}


function requiredRefundLevel(amountMinor: number, thresholds: { l2LimitMinor: number; l4FromMinor: number } = { l2LimitMinor: 50_000, l4FromMinor: 500_000 }): 'L2_SUPERVISOR' | 'L3_OPERATIONS' | 'L4_ADMIN_OWNER' {
  return requiredLevelForAmount(amountMinor, thresholds);
}

async function refundApprovalThresholds(policyReader?: PolicyReader) {
  return {
    l2LimitMinor: await policyReader?.getPolicyInteger('L2_REFUND_LIMIT_MINOR', 50_000) ?? 50_000,
    l4FromMinor: await policyReader?.getPolicyInteger('L4_DIRECT_EXECUTION_THRESHOLD_MINOR', 500_000) ?? 500_000
  };
}

function levelRank(level: StaffLevel): number {
  return {
    L1_SUPPORT: 1,
    L2_SUPERVISOR: 2,
    L3_OPERATIONS: 3,
    L4_ADMIN_OWNER: 4
  }[level];
}

function assertAmountWithinSnapshot(amountMinor: number, snapshotMinor: number, label: string): void {
  if (amountMinor > snapshotMinor) {
    throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', `${label} amount exceeds the immutable order snapshot.`);
  }
}

async function requireOrder(store: AdminRefundOrderStore, orderId: string, expectedVersion: number, actor: ActorContext): Promise<OrderRecord> {
  const order = await store.findById(orderId);
  if (!order || !actor.guildId || order.guildId !== actor.guildId) {
    throw new AdminOrderActionError('NOT_FOUND', 'Order was not found.');
  }
  if (order.version !== expectedVersion) {
    throw new AdminOrderActionError('CONFLICT', 'Order version is stale.');
  }
  return order;
}

function assertMoneyMatchesOrder(amount: { amountMinor: number; currency: Currency }, currency: string, label: string): void {
  if (amount.currency !== currency) {
    throw new AdminOrderActionError('VALIDATION_ERROR', `${label} currency must match the order currency.`);
  }
}

async function findSucceededOrderCharge(store: AdminRefundOrderStore, orderId: string): Promise<ExternalTransactionMirrorRecord | null> {
  if (store.findSucceededOrderCharge) {
    return store.findSucceededOrderCharge(orderId);
  }
  return store.externalTransactions?.find((transaction) => {
    return transaction.orderId === orderId && transaction.type === 'ORDER_CHARGE' && transaction.status === 'SUCCEEDED';
  }) ?? null;
}

async function findReservedRefundedMinor(store: AdminRefundOrderStore, sourceTransactionId: string): Promise<number> {
  if (store.findReservedRefundedMinor) {
    return store.findReservedRefundedMinor(sourceTransactionId);
  }
  return (store.refunds ?? []).reduce((total, refund) => {
    return refund.sourceTransactionId === sourceTransactionId
      && (refund.status === 'PENDING' || refund.status === 'SUCCEEDED')
      ? total + refund.amountMinor
      : total;
  }, 0);
}

function assertRefundWithinRemaining(requestedMinor: number, capturedMinor: number, alreadyRefundedMinor: number): void {
  if (!Number.isSafeInteger(capturedMinor) || !Number.isSafeInteger(alreadyRefundedMinor)
    || capturedMinor < 0 || alreadyRefundedMinor < 0 || requestedMinor > capturedMinor - alreadyRefundedMinor) {
    throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'Refund amount exceeds the remaining refundable charge.');
  }
}

function parseRefundOrderBody(body: unknown): {
  expectedVersion: number;
  amount: { amountMinor: number; currency: Currency };
  reasonCode: string;
  evidenceNote: string;
} {
  const input = objectBody(body);
  const amount = parseMoney(input.amount, 'amount', true);
  const expectedVersion = positiveVersion(input.expectedVersion);
  const reasonCode = validReasonCode(input.reasonCode);
  const evidenceNote = evidenceNoteField(input.evidenceNote);
  if (input.confirmation !== 'EXECUTE_OR_REQUEST_APPROVAL') {
    throw new AdminOrderActionError('VALIDATION_ERROR', 'confirmation is invalid.');
  }
  return { expectedVersion, amount, reasonCode, evidenceNote };
}

function parseResolveOrderBody(body: unknown): {
  expectedVersion: number;
  targetStatus: 'COMPLETED' | 'CANCELLED';
  reasonCode: string;
  refund: { amountMinor: number; currency: Currency };
  playerEarning: { amountMinor: number; currency: Currency };
  evidenceNote: string;
} {
  const input = objectBody(body);
  const targetStatus = input.targetStatus;
  if (targetStatus !== 'COMPLETED' && targetStatus !== 'CANCELLED') {
    throw new AdminOrderActionError('VALIDATION_ERROR', 'targetStatus is invalid.');
  }
  if (input.confirmation !== 'EXECUTE_OR_REQUEST_APPROVAL') {
    throw new AdminOrderActionError('VALIDATION_ERROR', 'confirmation is invalid.');
  }
  return {
    expectedVersion: positiveVersion(input.expectedVersion),
    targetStatus,
    reasonCode: validReasonCode(input.reasonCode),
    refund: parseMoney(input.refund, 'refund', false),
    playerEarning: parseMoney(input.playerEarning, 'playerEarning', false),
    evidenceNote: evidenceNoteField(input.evidenceNote)
  };
}

function parseReassignOrderBody(body: unknown): {
  expectedVersion: number;
  playerId: string;
  reasonCode: string;
  note: string | null;
} {
  const input = objectBody(body);
  const playerId = stringField(input.playerId, 'playerId');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(playerId)) {
    throw new AdminOrderActionError('VALIDATION_ERROR', 'playerId is invalid.');
  }
  const note = input.note === undefined || input.note === null ? null : stringField(input.note, 'note');
  if (note && note.length > 1_000) {
    throw new AdminOrderActionError('VALIDATION_ERROR', 'note is too long.');
  }
  return {
    expectedVersion: positiveVersion(input.expectedVersion),
    playerId,
    reasonCode: validReasonCode(input.reasonCode),
    note
  };
}

function parseMoney(value: unknown, field: string, positive: boolean): { amountMinor: number; currency: Currency } {
  const input = objectBody(value);
  const amountMinor = input.amountMinor;
  const currency = input.currency;
  if (!Number.isInteger(amountMinor) || (amountMinor as number) < (positive ? 1 : 0)) {
    throw new AdminOrderActionError('VALIDATION_ERROR', `${field}.amountMinor is invalid.`);
  }
  if (currency !== 'CAT') {
    throw new AdminOrderActionError('VALIDATION_ERROR', `${field}.currency is invalid.`);
  }
  return { amountMinor: amountMinor as number, currency: currency as Currency };
}

function positiveVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new AdminOrderActionError('VALIDATION_ERROR', 'expectedVersion must be a positive integer.');
  }
  return value as number;
}

function validReasonCode(value: unknown): string {
  const reasonCode = stringField(value, 'reasonCode');
  if (!resolutionReasonCodes.has(reasonCode)) {
    throw new AdminOrderActionError('VALIDATION_ERROR', 'reasonCode is invalid.');
  }
  return reasonCode;
}

function evidenceNoteField(value: unknown): string {
  const evidenceNote = stringField(value, 'evidenceNote');
  if (evidenceNote.length > 2_000) {
    throw new AdminOrderActionError('VALIDATION_ERROR', 'evidenceNote is too long.');
  }
  return evidenceNote;
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AdminOrderActionError('VALIDATION_ERROR', 'Request body must be an object.');
  }
  return body as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AdminOrderActionError('VALIDATION_ERROR', `${field} is required.`);
  }
  return value.trim();
}

function commitOrderReplacement(store: AdminRefundOrderStore, order: OrderRecord): void {
  if (!store.orders) {
    throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'Order store cannot commit admin order action.');
  }
  const index = store.orders.findIndex((candidate) => candidate.id === order.id);
  if (index === -1) {
    throw new AdminOrderActionError('NOT_FOUND', 'Order was not found.');
  }
  store.orders[index] = order;
}

function appendOrderEvent(store: AdminRefundOrderStore, event: OrderEventRecord): void {
  if (!store.events) {
    throw new AdminOrderActionError('BUSINESS_RULE_VIOLATION', 'Order store cannot append admin order event.');
  }
  store.events.push(event);
}

function nextEventSequence(store: AdminRefundOrderStore, orderId: string): number {
  return (store.events?.filter((event) => event.orderId === orderId).length ?? 0) + 1;
}

function orderIdParam(request: FastifyRequest): string {
  return (request.params as { orderId?: string }).orderId ?? '';
}

function idempotencyKey(request: FastifyRequest): string {
  return String(request.headers['idempotency-key'] ?? '');
}

function mapAdminOrderActionError(error: unknown): AdminOrderErrorDetail | null {
  if (!(error instanceof AdminOrderActionError)) {
    return null;
  }
  if (error.code === 'NOT_FOUND') {
    return { statusCode: 404, code: error.code, message: error.message };
  }
  if (error.code === 'CONFLICT') {
    return { statusCode: 409, code: error.code, message: error.message };
  }
  if (error.code === 'PERMISSION_DENIED') {
    return { statusCode: 403, code: error.code, message: error.message };
  }
  if (error.code === 'VALIDATION_ERROR') {
    return { statusCode: 400, code: error.code, message: error.message };
  }
  return { statusCode: 422, code: error.code, message: error.message };
}
