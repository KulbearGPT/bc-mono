import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import {
  InMemoryAuditSink,
  insertPostgresAuditRecord,
  registerSecureReadRoute,
  registerSecureWriteRoute,
  type ActorContext,
  type AuditRecord,
  type AuditSink
} from './security.js';
import type { AccountBindingRecord, AccountStore } from './accounts.js';
import type { Currency, ServiceCatalogRecord, ServiceCatalogStore } from './catalog.js';
import {
  buildFundReservationDraft,
  resolveFundReservationMode,
  type FundReservationMode,
  type FundReservationStatus
} from './funding.js';
import type { WalletFundingService } from './wallet.js';
import type { OutboxJob } from './outbox.js';
import {
  createOrderStaffTask,
  type StaffTaskRecord,
  type StaffTaskStore
} from './staff-tasks.js';

export type OrderStatus =
  | 'DRAFT'
  | 'PENDING_DISPATCH'
  | 'ACCEPTED'
  | 'IN_SERVICE'
  | 'PENDING_CONFIRMATION'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXCEPTION';

export type OrderEventType =
  | 'CREATED'
  | 'DETAILS_UPDATED'
  | 'SUBMITTED'
  | 'DISPATCH_STARTED'
  | 'DISPATCH_TIMED_OUT'
  | 'ACCEPTED'
  | 'CUSTOMER_READY_CONFIRMED'
  | 'PLAYER_READY_CONFIRMED'
  | 'READINESS_RESET'
  | 'READINESS_TIMED_OUT'
  | 'SERVICE_STARTED'
  | 'SERVICE_STARTED_OVERRIDE'
  | 'COMPLETION_REQUESTED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXCEPTION_ENTERED'
  | 'EXCEPTION_RECOVERED'
  | 'RESOLVED'
  | 'PANEL_SYNC_REQUESTED';
export type FundReservationEventType = 'CREATED' | 'ACTIVATED' | 'CAPTURED' | 'RELEASED' | 'DISPUTED' | 'DISPUTE_RESOLVED' | 'EXPIRED' | 'FAILED';

export interface ChannelSpec {
  channelId: string;
  panelMessageId: string;
  voiceChannelId: string | null;
}

export interface OrderRecord {
  id: string;
  publicId: string;
  customerId: string;
  guildId?: string | null;
  playerId: string | null;
  status: OrderStatus;
  version: number;
  serviceCatalogId: string | null;
  catalogVersion: number | null;
  game: string | null;
  service: string | null;
  region: string | null;
  billingUnitMinutes: number | null;
  unitCount: number | null;
  customerUnitPriceMinor: number | null;
  playerUnitPayoutMinor: number | null;
  amountMinor: number;
  playerEarningMinor: number;
  currency: Currency;
  notes: string | null;
  preferredPlayerDiscordUserIds?: string[];
  channelSpec: ChannelSpec;
  automationState?: 'RUNNING' | 'PAUSED';
  automationVersion?: number;
  automationPausedByStaffId?: string | null;
  automationStaffTaskId?: string | null;
  automationReasonCode?: string | null;
  automationScope?: 'ALL' | 'DISPATCH' | 'LIFECYCLE' | 'CANCELLATION' | null;
  automationPausedAt?: string | null;
  automationResumedAt?: string | null;
  automationExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export interface OrderEventRecord {
  id: string;
  orderId: string;
  sequence: number;
  eventType: OrderEventType;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorUserId: string | null;
  actorStaffId: string | null;
  actorSource: ActorContext['actorSource'];
  interactionId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface CreateOrderInput {
  orderType: 'IMMEDIATE';
  channelSpec: ChannelSpec;
}

export interface UpdateOrderInput {
  expectedVersion: number;
  serviceCatalogId: string;
  unitCount: number;
  region?: string | null;
  notes?: string | null;
  voiceChannelId?: string | null;
  preferredPlayerDiscordUserIds?: string[];
}

export interface EstimateOrderInput {
  expectedVersion: number;
}

export interface SubmitOrderInput {
  expectedVersion: number;
}

export interface CancelOrderInput {
  expectedVersion: number;
  previewId: string;
  reasonCode: string;
  note?: string | null;
}

export interface AutomationControlInput {
  expectedVersion: number;
  reasonCode: string;
  note?: string | null;
  scope?: 'ALL' | 'DISPATCH' | 'LIFECYCLE' | 'CANCELLATION';
  expiresAt?: string | null;
  resumeAction?: 'REDISPATCH' | 'RESTART_READINESS_TIMEOUT' | 'NONE';
}

export interface AutomationControlResult {
  orderId: string;
  orderVersion: number;
  resumeAction: AutomationControlInput['resumeAction'] | null;
  automation: {
    state: 'RUNNING' | 'PAUSED';
    version: number;
    pausedByStaffId: string | null;
    staffTaskId: string | null;
    reasonCode: string | null;
    scope: OrderRecord['automationScope'];
    pausedAt: string | null;
    resumedAt: string | null;
    expiresAt: string | null;
  };
}

export interface CancellationPreviewRequest {
  expectedVersion: number;
  reasonCode: string;
}

export interface CancellationPreviewRecord {
  id: string;
  orderId: string;
  fundReservationId: string | null;
  orderVersionSnapshot: number;
  reservationVersionSnapshot: number | null;
  status: 'ISSUED' | 'APPLIED' | 'EXPIRED' | 'INVALIDATED';
  disposition: 'AUTO_RELEASE' | 'AUTO_REFUND' | 'STAFF_REVIEW_REQUIRED' | 'BLOCKED';
  releaseAmountMinor: number;
  refundAmountMinor: number;
  currency: Currency;
  policyKey: string;
  policyVersion: number;
  reasonCode: string;
  requestedByUserId: string | null;
  requestedByStaffId: string | null;
  estimatedResolutionAt: string | null;
  expiresAt: string;
  appliedAt: string | null;
  invalidatedAt: string | null;
  createdAt: string;
}

export interface CancellationPreviewResult {
  previewId: string;
  orderId: string;
  orderVersion: number;
  automaticallyProcessable: boolean;
  fundAction: 'RELEASE_RESERVATION' | 'REFUND_CAPTURED_PAYMENT' | 'NONE';
  estimatedAmountMinor: number;
  releaseAmountMinor: number;
  refundAmountMinor: number;
  currency: Currency;
  handlingTimeCode: 'IMMEDIATE' | 'STAFF_REVIEW_REQUIRED';
  staffTaskRequired: boolean;
  validUntil: string;
}

export interface FundReservationRecord {
  id: string;
  userId: string;
  sourceType: 'ORDER';
  orderId: string;
  mode: FundReservationMode;
  provider: string | null;
  providerHoldRef: string | null;
  amountMinor: number;
  currency: Currency;
  status: FundReservationStatus;
  version: number;
  idempotencyKey: string;
  expiresAt: string;
  activatedAt: string | null;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FundReservationEventRecord {
  id: string;
  fundReservationId: string;
  sequence: number;
  eventType: FundReservationEventType;
  fromStatus: FundReservationStatus | null;
  toStatus: FundReservationStatus;
  amountMinor: number;
  reservationVersion: number;
  idempotencyKey: string;
  actorUserId: string | null;
  actorStaffId: string | null;
  actorSource: ActorContext['actorSource'];
  reasonCode: string | null;
  createdAt: string;
}

export interface ExternalTransactionMirrorRecord {
  id: string;
  provider: string;
  type: 'ORDER_CHARGE';
  userId: string;
  orderId: string;
  fundReservationId: string | null;
  externalRef: string | null;
  idempotencyKey: string;
  amountMinor: number;
  currency: Currency;
  status: 'UNKNOWN' | 'PENDING' | 'SUCCEEDED' | 'FAILED';
  createdAt: string;
}

export interface FundReservationSummary {
  reservationId: string;
  amountMinor: number;
  capturedMinor: number;
  releasedMinor: number;
  currency: Currency;
  status: FundReservationStatus;
  version: number;
  expiresAt: string | null;
}

export interface FundReservationApiRecord {
  id: string;
  sourceType: 'ORDER';
  sourceId: string;
  ownerUserId: string;
  amountMinor: number;
  capturedMinor: number;
  releasedMinor: number;
  currency: Currency;
  status: FundReservationStatus;
  backend: FundReservationMode;
  walletHoldReferenceDisplay: string | null;
  idempotencyKey: string;
  version: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderReservationResult {
  orderId: string;
  status: 'PENDING_DISPATCH';
  version: number;
  reservation: FundReservationSummary;
  balance: {
    ledgerBalanceMinor: number;
    reservedMinor: number;
    availableMinor: number;
    currency: string;
    calculatedAt: string;
    version: number;
  };
}

export interface CancellationResult {
  orderId: string;
  status: OrderStatus;
  version: number;
  fundAction: 'RELEASE_RESERVATION' | 'NONE';
  amountMinor: number;
  currency: Currency;
  reservation: FundReservationSummary | null;
  refundTransaction: null;
  staffTaskId: string | null;
}

export interface OrderEstimateResult {
  serviceCatalogId: string;
  catalogVersion: number;
  unitCount: number;
  billingUnitMinutes: number;
  amountMinor: number;
  currency: Currency;
  validUntil: string;
}

export interface PreparedOrderWrite {
  data: OrderApiRecord;
  statusCode?: number;
  order: OrderRecord;
  event: OrderEventRecord;
}

export interface PreparedSubmitOrderWrite {
  data: OrderReservationResult;
  order: OrderRecord;
  orderEvent: OrderEventRecord;
  reservation: FundReservationRecord;
  reservationEvent: FundReservationEventRecord;
  externalTransactions: ExternalTransactionMirrorRecord[];
  ledgerBalanceMinor: number;
  dispatchStartJob: OutboxJob;
}

export interface PreparedCancelOrderWrite {
  data: CancellationResult;
  order: OrderRecord;
  orderEvent: OrderEventRecord | null;
  expectedVersion: number;
  reservation: FundReservationRecord | null;
  reservationEvent: FundReservationEventRecord | null;
  staffTask: StaffTaskRecord | null;
  previewId: string;
}

export interface OrderStore {
  findActiveByCustomer(customerId: string): Promise<OrderRecord | null>;
  findById(orderId: string): Promise<OrderRecord | null>;
  findActiveReservationByOrder?(orderId: string): Promise<FundReservationRecord | null>;
  getMatchingProgress?(orderId: string): Promise<OrderMatchingProgress | null>;
  issueCancellationPreview(preview: CancellationPreviewRecord): Promise<void> | void;
  findCancellationPreview(previewId: string): Promise<CancellationPreviewRecord | null> | CancellationPreviewRecord | null;
  applyCancellationPreview(previewId: string, now: Date): Promise<void> | void;
  commitAutomationControl(input: {
    order: OrderRecord;
    expectedVersion: number;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
  }): Promise<void> | void;
  nextEventSequence(orderId: string): Promise<number>;
  commitCreate(input: { order: OrderRecord; event: OrderEventRecord; auditRecord: AuditRecord; auditSink: AuditSink }): Promise<void>;
  commitUpdate(input: {
    order: OrderRecord;
    event: OrderEventRecord;
    expectedVersion: number;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
  }): Promise<void>;
  commitSubmit?(input: {
    order: OrderRecord;
    expectedVersion: number;
    ledgerBalanceMinor: number;
    orderEvent: OrderEventRecord;
    reservation: FundReservationRecord;
    reservationEvent: FundReservationEventRecord;
    externalTransactions: ExternalTransactionMirrorRecord[];
    dispatchStartJob: OutboxJob;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
  }): Promise<void>;
  commitCancel?(input: {
    order: OrderRecord;
    expectedVersion: number;
    orderEvent: OrderEventRecord;
    reservation: FundReservationRecord | null;
    reservationEvent: FundReservationEventRecord | null;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
    previewId: string;
    now: Date;
  }): Promise<void>;
}

export interface OrderMatchingProgress {
  stage: 'SEARCHING' | 'WAITING_FOR_ACCEPTANCE' | 'TIMED_OUT' | 'ACCEPTED';
  notifiedCandidateCount: number;
  timeoutAt: string | null;
  nextStep: 'WAIT_FOR_PLAYER' | 'CHOOSE_CONTINUE_OR_CANCEL' | 'CONFIRM_READINESS';
  playerSummary: { playerId: string; displayName: string } | null;
}

export interface OrderQueryClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>;
}

export interface OrderTransactionClient extends OrderQueryClient {
  release(): void;
}

export interface OrderPool extends OrderQueryClient {
  connect(): Promise<OrderTransactionClient>;
}

export interface OrderApiRecord {
  id: string;
  publicId: string;
  status: OrderStatus;
  version: number;
  orderType: 'IMMEDIATE';
  serviceCatalogId: string | null;
  catalogVersion: number | null;
  unitCount: number | null;
  billingUnitMinutes: number | null;
  customerUnitPriceMinor: number | null;
  playerUnitPayoutMinor: number | null;
  currency: Currency;
  amountMinor: number;
  playerEarningMinor: number;
  game: string | null;
  service: string | null;
  matching: OrderMatchingProgress | null;
  fundReservation: FundReservationSummary | null;
  readiness: {
    customer: 'NOT_READY';
    player: 'NOT_READY';
    bothReady: false;
    readyDeadlineAt: null;
    startedAt: null;
    staffTaskId: null;
  };
  automation: {
    state: 'RUNNING' | 'PAUSED';
    version: number;
    pausedByStaffId: string | null;
    staffTaskId: string | null;
    reasonCode: string | null;
    scope: OrderRecord['automationScope'];
    pausedAt: string | null;
    resumedAt: string | null;
    expiresAt: string | null;
  };
  playerId: string | null;
  region: string | null;
  notes: string | null;
  preferredPlayerDiscordUserIds: string[];
  channelSpec: ChannelSpec;
  createdAt: string;
  updatedAt: string;
}

export class OrderError extends Error {
  readonly code:
    | 'ACCOUNT_NOT_BOUND'
    | 'BUSINESS_RULE_VIOLATION'
    | 'CANCELLATION_PREVIEW_STALE'
    | 'CONFLICT'
    | 'INSUFFICIENT_AVAILABLE_BALANCE'
    | 'PERMISSION_DENIED'
    | 'RESOURCE_NOT_FOUND'
    | 'SERVICE_NOT_AVAILABLE'
    | 'VALIDATION_ERROR';

  constructor(code: OrderError['code'], message: string) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
  }
}

export class InMemoryOrderStore implements OrderStore {
  readonly orders: OrderRecord[];
  readonly events: OrderEventRecord[];
  readonly reservations: FundReservationRecord[];
  readonly reservationEvents: FundReservationEventRecord[];
  readonly externalTransactions: ExternalTransactionMirrorRecord[];
  readonly outboxJobs: OutboxJob[] = [];
  readonly cancellationPreviews: CancellationPreviewRecord[];

  constructor(input: {
    orders?: OrderRecord[];
    events?: OrderEventRecord[];
    reservations?: FundReservationRecord[];
    reservationEvents?: FundReservationEventRecord[];
    externalTransactions?: ExternalTransactionMirrorRecord[];
    cancellationPreviews?: CancellationPreviewRecord[];
  } = {}) {
    this.orders = input.orders?.map(clone) ?? [];
    this.events = input.events?.map(clone) ?? [];
    this.reservations = input.reservations?.map(clone) ?? [];
    this.reservationEvents = input.reservationEvents?.map(clone) ?? [];
    this.externalTransactions = input.externalTransactions?.map(clone) ?? [];
    this.cancellationPreviews = input.cancellationPreviews?.map(clone) ?? [];
  }

  issueCancellationPreview(preview: CancellationPreviewRecord): void {
    this.cancellationPreviews.push(clone(preview));
  }

  findCancellationPreview(previewId: string): CancellationPreviewRecord | null {
    const preview = this.cancellationPreviews.find((candidate) => candidate.id === previewId);
    return preview ? clone(preview) : null;
  }

  applyCancellationPreview(previewId: string, now: Date): void {
    const index = this.cancellationPreviews.findIndex((candidate) => candidate.id === previewId);
    const preview = index === -1 ? null : this.cancellationPreviews[index];
    if (!preview || preview.status !== 'ISSUED') {
      throw new OrderError('CANCELLATION_PREVIEW_STALE', 'Refresh the cancellation preview before retrying.');
    }
    this.cancellationPreviews[index] = { ...preview, status: 'APPLIED', appliedAt: now.toISOString() };
  }

  async findActiveByCustomer(customerId: string): Promise<OrderRecord | null> {
    const order = this.orders.find((candidate) => {
      return candidate.customerId === customerId && activeOrderStatuses.has(candidate.status);
    });
    return order ? clone(order) : null;
  }

  async findById(orderId: string): Promise<OrderRecord | null> {
    const order = this.orders.find((candidate) => candidate.id === orderId);
    return order ? clone(order) : null;
  }

  async findActiveReservationByOrder(orderId: string): Promise<FundReservationRecord | null> {
    const reservation = this.reservations.find((candidate) => {
      return candidate.orderId === orderId && activeFundReservationStatuses.includes(candidate.status);
    });
    return reservation ? clone(reservation) : null;
  }

  async nextEventSequence(orderId: string): Promise<number> {
    const maxSequence = this.events.reduce((max, event) => {
      return event.orderId === orderId ? Math.max(max, event.sequence) : max;
    }, 0);
    return maxSequence + 1;
  }

  async commitCreate(input: { order: OrderRecord; event: OrderEventRecord; auditRecord: AuditRecord; auditSink: AuditSink }): Promise<void> {
    if (await this.findActiveByCustomer(input.order.customerId)) {
      throw new OrderError('CONFLICT', 'Customer already has an active order.');
    }
    this.orders.push(clone(input.order));
    this.events.push(clone(input.event));
    await input.auditSink.append(input.auditRecord);
  }

  async commitUpdate(input: {
    order: OrderRecord;
    event: OrderEventRecord;
    expectedVersion: number;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
  }): Promise<void> {
    const index = this.orders.findIndex((candidate) => candidate.id === input.order.id);
    const existing = index === -1 ? null : this.orders[index];
    if (!existing) {
      throw new OrderError('RESOURCE_NOT_FOUND', 'Order was not found.');
    }
    if (existing.version !== input.expectedVersion) {
      throw new OrderError('CONFLICT', 'Order version is stale.');
    }
    this.orders[index] = clone(input.order);
    this.events.push(clone(input.event));
    await input.auditSink.append(input.auditRecord);
  }

  async commitAutomationControl(input: {
    order: OrderRecord;
    expectedVersion: number;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
  }): Promise<void> {
    const index = this.orders.findIndex((candidate) => candidate.id === input.order.id);
    const existing = index === -1 ? null : this.orders[index];
    if (!existing) {
      throw new OrderError('RESOURCE_NOT_FOUND', 'Order was not found.');
    }
    if (existing.version !== input.expectedVersion) {
      throw new OrderError('CONFLICT', 'Order version is stale.');
    }
    this.orders[index] = clone(input.order);
    await input.auditSink.append(input.auditRecord);
  }

  async commitSubmit(input: {
    order: OrderRecord;
    expectedVersion: number;
    ledgerBalanceMinor: number;
    orderEvent: OrderEventRecord;
    reservation: FundReservationRecord;
    reservationEvent: FundReservationEventRecord;
    externalTransactions: ExternalTransactionMirrorRecord[];
    dispatchStartJob: OutboxJob;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
  }): Promise<void> {
    const index = this.orders.findIndex((candidate) => candidate.id === input.order.id);
    const existing = index === -1 ? null : this.orders[index];
    if (!existing) {
      throw new OrderError('RESOURCE_NOT_FOUND', 'Order was not found.');
    }
    if (existing.status !== 'DRAFT' || existing.version !== input.expectedVersion) {
      throw new OrderError('CONFLICT', 'Order version is stale.');
    }
    if (this.reservations.some((reservation) => reservation.orderId === input.order.id)) {
      throw new OrderError('CONFLICT', 'Order already has a fund reservation.');
    }
    assertCommitAvailableBalance({
      ledgerBalanceMinor: input.ledgerBalanceMinor,
      activeReservedMinor: sumActiveReservedMinor(this.reservations, input.reservation),
      amountMinor: input.reservation.amountMinor
    });
    this.orders[index] = clone(input.order);
    this.reservations.push(clone(input.reservation));
    this.reservationEvents.push(clone(input.reservationEvent));
    this.externalTransactions.push(...input.externalTransactions.map(clone));
    this.events.push(clone(input.orderEvent));
    this.outboxJobs.push(clone(input.dispatchStartJob));
    await input.auditSink.append(input.auditRecord);
  }

  async commitCancel(input: {
    order: OrderRecord;
    expectedVersion: number;
    orderEvent: OrderEventRecord;
    reservation: FundReservationRecord | null;
    reservationEvent: FundReservationEventRecord | null;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
    previewId: string;
    now: Date;
  }): Promise<void> {
    const previewIndex = this.cancellationPreviews.findIndex((candidate) => candidate.id === input.previewId);
    const preview = previewIndex === -1 ? null : this.cancellationPreviews[previewIndex];
    const index = this.orders.findIndex((candidate) => candidate.id === input.order.id);
    const existing = index === -1 ? null : this.orders[index];
    if (!existing) {
      throw new OrderError('RESOURCE_NOT_FOUND', 'Order was not found.');
    }
    if (!preview || !isCancellationPreviewCurrent(preview, existing, this.reservations, input.now)) {
      throw new OrderError('CANCELLATION_PREVIEW_STALE', 'Refresh the cancellation preview before retrying.');
    }
    if (existing.version !== input.expectedVersion || !['DRAFT', 'PENDING_DISPATCH'].includes(existing.status)) {
      throw new OrderError('CANCELLATION_PREVIEW_STALE', 'Refresh the cancellation preview before retrying.');
    }
    if (input.reservation) {
      const reservationIndex = this.reservations.findIndex((candidate) => candidate.id === input.reservation?.id);
      const existingReservation = reservationIndex === -1 ? null : this.reservations[reservationIndex];
      if (
        !existingReservation ||
        existingReservation.version !== input.reservation.version - 1 ||
        !activeFundReservationStatuses.includes(existingReservation.status)
      ) {
        throw new OrderError('CONFLICT', 'Order reservation is stale.');
      }
      this.reservations[reservationIndex] = clone(input.reservation);
    }
    this.orders[index] = clone(input.order);
    this.cancellationPreviews[previewIndex] = { ...preview, status: 'APPLIED', appliedAt: input.now.toISOString() };
    if (input.reservationEvent) {
      this.reservationEvents.push(clone(input.reservationEvent));
    }
    this.events.push(clone(input.orderEvent));
    await input.auditSink.append(input.auditRecord);
  }
}

export class PostgresOrderStore implements OrderStore {
  private readonly client: OrderQueryClient;
  private readonly pool: OrderPool | null;

  constructor(options: { client?: OrderQueryClient; pool?: OrderPool }) {
    if (!options.client && !options.pool) {
      throw new OrderError('VALIDATION_ERROR', 'PostgresOrderStore requires a client or pool.');
    }
    this.client = options.pool ?? options.client!;
    this.pool = options.pool ?? null;
  }

  async findActiveByCustomer(customerId: string): Promise<OrderRecord | null> {
    const result = await this.client.query<OrderRow>(
      `
SELECT *
FROM orders
WHERE customer_id = $1
  AND status = ANY($2::"OrderStatus"[])
ORDER BY created_at ASC
LIMIT 1
      `,
      [customerId, Array.from(activeOrderStatuses)]
    );
    return result.rows[0] ? mapOrderRow(result.rows[0]) : null;
  }

  async issueCancellationPreview(preview: CancellationPreviewRecord): Promise<void> {
    await this.client.query(
      `
INSERT INTO cancellation_previews (
  id, order_id, fund_reservation_id, order_version_snapshot, reservation_version_snapshot,
  status, disposition, release_amount_minor, refund_amount_minor, currency,
  policy_key, policy_version, reason_code, requested_by_user_id, requested_by_staff_id,
  estimated_resolution_at, expires_at, applied_at, invalidated_at, created_at
)
VALUES ($1, $2, $3, $4, $5, $6::"CancellationPreviewStatus", $7::"CancellationDisposition", $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      `,
      [
        preview.id, preview.orderId, preview.fundReservationId, preview.orderVersionSnapshot, preview.reservationVersionSnapshot,
        preview.status, preview.disposition, preview.releaseAmountMinor, preview.refundAmountMinor, preview.currency,
        preview.policyKey, preview.policyVersion, preview.reasonCode, preview.requestedByUserId, preview.requestedByStaffId,
        preview.estimatedResolutionAt, preview.expiresAt, preview.appliedAt, preview.invalidatedAt, preview.createdAt
      ]
    );
  }

  async findCancellationPreview(previewId: string): Promise<CancellationPreviewRecord | null> {
    const result = await this.client.query<CancellationPreviewRow>('SELECT * FROM cancellation_previews WHERE id = $1 LIMIT 1', [previewId]);
    return result.rows[0] ? mapCancellationPreviewRow(result.rows[0]) : null;
  }

  async applyCancellationPreview(previewId: string, now: Date): Promise<void> {
    const result = await this.client.query(
      `UPDATE cancellation_previews SET status = 'APPLIED', applied_at = $2 WHERE id = $1 AND status = 'ISSUED'`,
      [previewId, now.toISOString()]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new OrderError('CANCELLATION_PREVIEW_STALE', 'Refresh the cancellation preview before retrying.');
    }
  }

  async findById(orderId: string): Promise<OrderRecord | null> {
    const result = await this.client.query<OrderRow>(
      `
SELECT *
FROM orders
WHERE id = $1
LIMIT 1
      `,
      [orderId]
    );
    return result.rows[0] ? mapOrderRow(result.rows[0]) : null;
  }

  async findActiveReservationByOrder(orderId: string): Promise<FundReservationRecord | null> {
    const result = await this.client.query<FundReservationRow>(
      `
SELECT *
FROM fund_reservations
WHERE order_id = $1
  AND source_type = 'ORDER'
  AND status = ANY($2::"FundReservationStatus"[])
ORDER BY created_at ASC
LIMIT 1
      `,
      [orderId, activeFundReservationStatuses]
    );
    return result.rows[0] ? mapFundReservationRow(result.rows[0]) : null;
  }

  async getMatchingProgress(orderId: string): Promise<OrderMatchingProgress | null> {
    const result = await this.client.query<{
      order_status: OrderStatus;
      player_id: string | null;
      player_display_name: string | null;
      attempt_status: string | null;
      expires_at: Date | string | null;
      notified_count: string | number;
    }>(
      `
SELECT o.status AS order_status,
       o.player_id,
       player.display_name AS player_display_name,
       latest.status AS attempt_status,
       latest.expires_at,
       COALESCE(latest.notified_count, 0) AS notified_count
FROM orders o
LEFT JOIN users player ON player.id = o.player_id
LEFT JOIN LATERAL (
  SELECT da.status, da.expires_at,
         (SELECT count(*) FROM dispatch_candidates dc WHERE dc.dispatch_attempt_id = da.id) AS notified_count
  FROM dispatch_attempts da
  WHERE da.order_id = o.id
  ORDER BY da.round DESC, da.created_at DESC
  LIMIT 1
) latest ON true
WHERE o.id = $1
      `,
      [orderId]
    );
    const row = result.rows[0];
    if (!row || !['PENDING_DISPATCH', 'ACCEPTED'].includes(row.order_status)) {
      return null;
    }
    if (row.order_status === 'ACCEPTED' && row.player_id) {
      return {
        stage: 'ACCEPTED',
        notifiedCandidateCount: Number(row.notified_count),
        timeoutAt: null,
        nextStep: 'CONFIRM_READINESS',
        playerSummary: {
          playerId: row.player_id,
          displayName: row.player_display_name ?? '已接单陪玩'
        }
      };
    }
    if (row.attempt_status === 'TIMED_OUT') {
      return {
        stage: 'TIMED_OUT',
        notifiedCandidateCount: Number(row.notified_count),
        timeoutAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        nextStep: 'CHOOSE_CONTINUE_OR_CANCEL',
        playerSummary: null
      };
    }
    return {
      stage: row.attempt_status === 'ACTIVE' ? 'WAITING_FOR_ACCEPTANCE' : 'SEARCHING',
      notifiedCandidateCount: Number(row.notified_count),
      timeoutAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      nextStep: 'WAIT_FOR_PLAYER',
      playerSummary: null
    };
  }

  async nextEventSequence(orderId: string): Promise<number> {
    const result = await this.client.query<{ next_sequence: string }>(
      `
SELECT (COALESCE(MAX(sequence), 0) + 1)::text AS next_sequence
FROM order_events
WHERE order_id = $1
      `,
      [orderId]
    );
    return Number(result.rows[0]?.next_sequence ?? 1);
  }

  async commitCreate(input: { order: OrderRecord; event: OrderEventRecord; auditRecord: AuditRecord; auditSink: AuditSink }): Promise<void> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      await insertOrder(transactionClient, input.order);
      await insertOrderEvent(transactionClient, input.event);
      await insertAuditRecord(transactionClient, input.auditRecord);
      await transactionClient.query('COMMIT');
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresOrderError(error);
    } finally {
      if ('release' in transactionClient && typeof transactionClient.release === 'function') {
        transactionClient.release();
      }
    }
  }

  async commitUpdate(input: {
    order: OrderRecord;
    event: OrderEventRecord;
    expectedVersion: number;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
  }): Promise<void> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      await transactionClient.query("SELECT set_config('app.order_draft_amount_update', 'approved', true)");
      const updated = await updateDraftOrder(transactionClient, input.order, input.expectedVersion);
      if ((updated.rowCount ?? 0) !== 1) {
        throw new OrderError('CONFLICT', 'Order version is stale.');
      }
      await insertOrderEvent(transactionClient, input.event);
      await insertAuditRecord(transactionClient, input.auditRecord);
      await transactionClient.query('COMMIT');
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresOrderError(error);
    } finally {
      if ('release' in transactionClient && typeof transactionClient.release === 'function') {
        transactionClient.release();
      }
    }
  }

  async commitAutomationControl(input: {
    order: OrderRecord;
    expectedVersion: number;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
  }): Promise<void> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      const updated = await transactionClient.query(
        `UPDATE orders
         SET row_version = $3,
             automation_state = $4,
             automation_version = $5,
             automation_paused_by_staff_id = $6,
             automation_staff_task_id = $7,
             automation_reason_code = $8,
             automation_scope = $9,
             automation_paused_at = $10,
             automation_resumed_at = $11,
             automation_expires_at = $12,
             updated_at = $13
         WHERE id = $1 AND row_version = $2`,
        [
          input.order.id, input.expectedVersion, input.order.version, input.order.automationState ?? 'RUNNING',
          input.order.automationVersion ?? 1, input.order.automationPausedByStaffId ?? null,
          input.order.automationStaffTaskId ?? null, input.order.automationReasonCode ?? null,
          input.order.automationScope ?? null, input.order.automationPausedAt ? new Date(input.order.automationPausedAt) : null,
          input.order.automationResumedAt ? new Date(input.order.automationResumedAt) : null,
          input.order.automationExpiresAt ? new Date(input.order.automationExpiresAt) : null,
          new Date(input.order.updatedAt)
        ]
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new OrderError('CONFLICT', 'Order version is stale.');
      }
      await insertOrderPanelSync(transactionClient, {
        orderId: input.order.id, version: input.order.version, kind: 'ORDER_AUTOMATION_CHANNEL_SYNC', now: new Date(input.order.updatedAt)
      });
      await insertAuditRecord(transactionClient, input.auditRecord);
      await transactionClient.query('COMMIT');
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresOrderError(error);
    } finally {
      if ('release' in transactionClient && typeof transactionClient.release === 'function') {
        transactionClient.release();
      }
    }
  }

  async commitSubmit(input: {
    order: OrderRecord;
    expectedVersion: number;
    ledgerBalanceMinor: number;
    orderEvent: OrderEventRecord;
    reservation: FundReservationRecord;
    reservationEvent: FundReservationEventRecord;
    externalTransactions: ExternalTransactionMirrorRecord[];
    dispatchStartJob: OutboxJob;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
  }): Promise<void> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      await lockUserCurrency(transactionClient, input.reservation.userId, input.reservation.currency);
      await validateCatalogSnapshotForCommit(transactionClient, input.order);
      const ledgerBalanceMinor = await readLedgerBalanceForCommit(transactionClient, input.reservation.userId);
      const activeReservedMinor = await sumActiveReservedMinorForCommit(transactionClient, input.reservation);
      assertCommitAvailableBalance({
        ledgerBalanceMinor,
        activeReservedMinor,
        amountMinor: input.reservation.amountMinor
      });
      const updated = await updateSubmittedOrder(transactionClient, input.order, input.expectedVersion);
      if ((updated.rowCount ?? 0) !== 1) {
        throw new OrderError('CONFLICT', 'Order version is stale.');
      }
      await insertFundReservation(transactionClient, input.reservation);
      await insertFundReservationEvent(transactionClient, input.reservationEvent);
      for (const transaction of input.externalTransactions) {
        await insertExternalTransaction(transactionClient, transaction);
      }
      await insertOrderEvent(transactionClient, input.orderEvent);
      await transactionClient.query(`INSERT INTO outbox_events
        (id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,created_at,updated_at)
        VALUES ($1,'DISPATCH_START','order',$2,$2,$3,$4::jsonb,'PENDING',1,0,8,$5,$5,$5)`,
      [input.dispatchStartJob.id,input.order.id,input.dispatchStartJob.dedupeKey,JSON.stringify(input.dispatchStartJob.payload),input.dispatchStartJob.runAfter]);
      await insertOrderPanelSync(transactionClient, {
        orderId: input.order.id, version: input.order.version, kind: 'ORDER_SUBMITTED_CHANNEL_SYNC', now: new Date(input.order.updatedAt)
      });
      await insertAuditRecord(transactionClient, input.auditRecord);
      await transactionClient.query('COMMIT');
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresOrderError(error);
    } finally {
      if ('release' in transactionClient && typeof transactionClient.release === 'function') {
        transactionClient.release();
      }
    }
  }

  async commitCancel(input: {
    order: OrderRecord;
    expectedVersion: number;
    orderEvent: OrderEventRecord;
    reservation: FundReservationRecord | null;
    reservationEvent: FundReservationEventRecord | null;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
    previewId: string;
    now: Date;
  }): Promise<void> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      const previewResult = await transactionClient.query<CancellationPreviewRow>(
        'SELECT * FROM cancellation_previews WHERE id = $1 FOR UPDATE',
        [input.previewId]
      );
      const preview = previewResult.rows[0] ? mapCancellationPreviewRow(previewResult.rows[0]) : null;
      const currentOrderResult = await transactionClient.query<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [input.order.id]);
      const currentOrder = currentOrderResult.rows[0] ? mapOrderRow(currentOrderResult.rows[0]) : null;
      const currentReservationResult = preview?.fundReservationId
        ? await transactionClient.query<FundReservationRow>('SELECT * FROM fund_reservations WHERE id = $1 FOR UPDATE', [preview.fundReservationId])
        : { rows: [] as FundReservationRow[] };
      const currentReservations = currentReservationResult.rows.map(mapFundReservationRow);
      if (!currentOrder || !preview || !isCancellationPreviewCurrent(preview, currentOrder, currentReservations, input.now)) {
        throw new OrderError('CANCELLATION_PREVIEW_STALE', 'Refresh the cancellation preview before retrying.');
      }
      const updated = await updateCancelledOrder(transactionClient, input.order, input.expectedVersion);
      if ((updated.rowCount ?? 0) !== 1) {
        throw new OrderError('CONFLICT', 'Order version is stale.');
      }
      if (input.reservationEvent) {
        await insertFundReservationEvent(transactionClient, input.reservationEvent);
      }
      await insertOrderEvent(transactionClient, input.orderEvent);
      await insertOrderPanelSync(transactionClient, {
        orderId: input.order.id, version: input.order.version, kind: 'ORDER_CANCELLED_CHANNEL_SYNC', now: input.now
      });
      await transactionClient.query(
        `UPDATE cancellation_previews SET status = 'APPLIED', applied_at = $2 WHERE id = $1 AND status = 'ISSUED'`,
        [input.previewId, input.now.toISOString()]
      );
      await insertAuditRecord(transactionClient, input.auditRecord);
      await transactionClient.query('COMMIT');
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresOrderError(error);
    } finally {
      if ('release' in transactionClient && typeof transactionClient.release === 'function') {
        transactionClient.release();
      }
    }
  }
}

const activeOrderStatuses = new Set<OrderStatus>([
  'DRAFT',
  'PENDING_DISPATCH',
  'ACCEPTED',
  'IN_SERVICE',
  'PENDING_CONFIRMATION',
  'EXCEPTION'
]);

const activeFundReservationStatuses: FundReservationStatus[] = [
  'PENDING',
  'ACTIVE',
  'DISPUTED',
  'PARTIALLY_SETTLED'
];

function sumActiveReservedMinor(reservations: FundReservationRecord[], nextReservation: FundReservationRecord): number {
  return reservations.reduce((sum, reservation) => {
    if (
      reservation.userId === nextReservation.userId &&
      reservation.currency === nextReservation.currency &&
      reservation.id !== nextReservation.id &&
      activeFundReservationStatuses.includes(reservation.status)
    ) {
      return sum + reservation.amountMinor;
    }
    return sum;
  }, 0);
}

function assertCommitAvailableBalance(input: {
  ledgerBalanceMinor: number;
  activeReservedMinor: number;
  amountMinor: number;
}): void {
  if (input.ledgerBalanceMinor - input.activeReservedMinor < input.amountMinor) {
    throw new OrderError('INSUFFICIENT_AVAILABLE_BALANCE', 'Available balance is insufficient at commit time.');
  }
}

function buildSubmitAuditSnapshot(prepared: PreparedSubmitOrderWrite): unknown {
  return {
    orderId: prepared.order.id,
    status: prepared.order.status,
    version: prepared.order.version,
    reservation: {
      reservationId: prepared.reservation.id,
      provider: prepared.reservation.provider,
      providerHoldRef: prepared.reservation.providerHoldRef,
      amountMinor: prepared.reservation.amountMinor,
      currency: prepared.reservation.currency,
      status: prepared.reservation.status,
      version: prepared.reservation.version
    },
    ledgerBalanceMinor: prepared.ledgerBalanceMinor
  };
}

export async function prepareCreateOrder(input: {
  accountStore: AccountStore;
  orderStore: OrderStore;
  actor: ActorContext;
  input: CreateOrderInput;
  now: Date;
}): Promise<PreparedOrderWrite | { data: OrderApiRecord; statusCode: 200 }> {
  const binding = await requireCurrentBinding(input.accountStore, input.actor);
  validateCreateOrderInput(input.input);
  const existing = await input.orderStore.findActiveByCustomer(binding.userId);
  if (existing) {
    return {
      data: toApiOrder(existing),
      statusCode: 200
    };
  }

  const order = buildDraftOrder({
    binding,
    channelSpec: input.input.channelSpec,
    now: input.now
  });
  return {
    data: toApiOrder(order),
    statusCode: 201,
    order,
    event: buildOrderEvent({
      order,
      eventType: 'CREATED',
      fromStatus: null,
      toStatus: 'DRAFT',
      actor: input.actor,
      now: input.now,
      sequence: 1,
      payload: {
        channelSpec: order.channelSpec
      }
    })
  };
}

export async function getOrder(input: {
  accountStore: AccountStore;
  orderStore: OrderStore;
  actor: ActorContext;
  orderId: string;
}): Promise<OrderApiRecord> {
  const binding = await requireCurrentBinding(input.accountStore, input.actor);
  const order = await requireVisibleOrder(input.orderStore, input.orderId, binding);
  const matching = await input.orderStore.getMatchingProgress?.(order.id) ?? null;
  return toApiOrder(order, null, matching);
}

export async function prepareUpdateOrder(input: {
  accountStore: AccountStore;
  catalogStore: ServiceCatalogStore;
  orderStore: OrderStore;
  actor: ActorContext;
  orderId: string;
  input: UpdateOrderInput;
  now: Date;
}): Promise<PreparedOrderWrite> {
  const binding = await requireCurrentBinding(input.accountStore, input.actor);
  const order = await requireVisibleOrder(input.orderStore, input.orderId, binding);
  validateDraftOrderVersion(order, input.input.expectedVersion);
  validateUpdateOrderInput(input.input);
  const service = await input.catalogStore.getById(input.input.serviceCatalogId);
  assertAvailableService(service);
  if (input.input.unitCount < service.minimumUnits) {
    throw new OrderError('VALIDATION_ERROR', 'unitCount must be at least the service minimum.');
  }

  const updated = applyServiceSnapshot({
    order,
    service,
    unitCount: input.input.unitCount,
    region: input.input.region ?? service.region,
    notes: input.input.notes ?? null,
    voiceChannelId: input.input.voiceChannelId ?? order.channelSpec.voiceChannelId,
    preferredPlayerDiscordUserIds: input.input.preferredPlayerDiscordUserIds ?? order.preferredPlayerDiscordUserIds ?? [],
    now: input.now
  });
  return {
    data: toApiOrder(updated),
    order: updated,
    event: buildOrderEvent({
      order: updated,
      eventType: 'DETAILS_UPDATED',
      fromStatus: 'DRAFT',
      toStatus: 'DRAFT',
      actor: input.actor,
      now: input.now,
      sequence: updated.version,
      payload: {
        serviceCatalogId: updated.serviceCatalogId,
        catalogVersion: updated.catalogVersion,
        unitCount: updated.unitCount,
        amountMinor: updated.amountMinor,
        currency: updated.currency,
        preferredPlayerDiscordUserIds: updated.preferredPlayerDiscordUserIds
      }
    })
  };
}

export async function estimateOrder(input: {
  accountStore: AccountStore;
  orderStore: OrderStore;
  actor: ActorContext;
  orderId: string;
  input: EstimateOrderInput;
  now: Date;
}): Promise<OrderEstimateResult> {
  const binding = await requireCurrentBinding(input.accountStore, input.actor);
  const order = await requireVisibleOrder(input.orderStore, input.orderId, binding);
  validateDraftOrderVersion(order, input.input.expectedVersion);
  if (
    !order.serviceCatalogId ||
    !order.catalogVersion ||
    !order.unitCount ||
    !order.billingUnitMinutes ||
    order.amountMinor <= 0
  ) {
    throw new OrderError('BUSINESS_RULE_VIOLATION', 'Order draft is not ready to estimate.');
  }
  return {
    serviceCatalogId: order.serviceCatalogId,
    catalogVersion: order.catalogVersion,
    unitCount: order.unitCount,
    billingUnitMinutes: order.billingUnitMinutes,
    amountMinor: order.amountMinor,
    currency: order.currency,
    validUntil: new Date(input.now.getTime() + 5 * 60_000).toISOString()
  };
}

export async function prepareSubmitOrder(input: {
  accountStore: AccountStore;
  catalogStore: ServiceCatalogStore;
  orderStore: OrderStore;
  walletFunding: WalletFundingService;
  actor: ActorContext;
  orderId: string;
  input: SubmitOrderInput;
  idempotencyKey: string;
  now: Date;
}): Promise<PreparedSubmitOrderWrite> {
  const binding = await requireCurrentBinding(input.accountStore, input.actor);
  const order = await requireVisibleOrder(input.orderStore, input.orderId, binding);
  validateSubmitOrderInput(input.input);
  validateDraftOrderVersion(order, input.input.expectedVersion);
  validateSubmittableDraft(order);
  await validateCurrentCatalogSnapshot(input.catalogStore, order);

  if (order.currency !== 'CAT') throw new OrderError('VALIDATION_ERROR', 'Orders must use USD.');
  const walletBalance = await input.walletFunding.getBalance({ userId: binding.userId, now: input.now });
  const reservedMinor = walletBalance.reservedMinor;
  const availableMinor = walletBalance.availableMinor;
  if (availableMinor < order.amountMinor) {
    throw new OrderError('INSUFFICIENT_AVAILABLE_BALANCE', 'Available balance is insufficient.');
  }

  const reservation = buildOrderReservation({
    order,
    binding,
    providerKey: 'INTERNAL_WALLET',
    mode: 'LOCAL_RESERVATION',
    idempotencyKey: input.idempotencyKey,
    now: input.now
  });
  const activatedReservation: FundReservationRecord = {
    ...reservation,
    status: 'ACTIVE',
    provider: null,
    providerHoldRef: null,
    activatedAt: input.now.toISOString()
  };
  const submittedOrder = applySubmitOrder(order, input.now);
  const nextSequence = await input.orderStore.nextEventSequence(order.id);
  const reservationEvent = buildReservationEvent({
    reservation: activatedReservation,
    actor: input.actor,
    now: input.now,
    idempotencyKey: `${input.idempotencyKey}:reservation`,
    amountMinor: order.amountMinor
  });
  const orderEvent = buildOrderEvent({
    order: submittedOrder,
    eventType: 'SUBMITTED',
    fromStatus: 'DRAFT',
    toStatus: 'PENDING_DISPATCH',
    actor: input.actor,
    now: input.now,
    sequence: nextSequence,
    payload: {
      reservationId: activatedReservation.id,
      amountMinor: activatedReservation.amountMinor,
      currency: activatedReservation.currency
    }
  });

  return {
    data: {
      orderId: submittedOrder.id,
      status: 'PENDING_DISPATCH',
      version: submittedOrder.version,
      reservation: toApiReservationSummary(activatedReservation),
      balance: {
        ledgerBalanceMinor: walletBalance.ledgerBalanceMinor,
        reservedMinor: reservedMinor + activatedReservation.amountMinor,
        availableMinor: walletBalance.ledgerBalanceMinor - reservedMinor - activatedReservation.amountMinor,
        currency: 'CAT',
        calculatedAt: walletBalance.calculatedAt,
        version: walletBalance.version
      }
    },
    order: submittedOrder,
    orderEvent,
    reservation: activatedReservation,
    reservationEvent,
    ledgerBalanceMinor: walletBalance.ledgerBalanceMinor,
    externalTransactions: [],
    dispatchStartJob: {
      id: crypto.randomUUID(), type: 'DISPATCH_START', status: 'PENDING', aggregateType: 'order', aggregateId: submittedOrder.id,
      dedupeKey: `${input.idempotencyKey}:dispatch-start`, payload: { orderId: submittedOrder.id, expectedVersion: submittedOrder.version, trigger: 'ORDER_SUBMITTED' },
      attempts: 0, maxAttempts: 8, runAfter: input.now.toISOString(), lockedAt: null, lockedBy: null, completedAt: null,
      lastError: null, version: 1, createdAt: input.now.toISOString(), updatedAt: input.now.toISOString()
    }
  };
}

export async function prepareCancelOrder(input: {
  accountStore: AccountStore;
  orderStore: OrderStore;
  staffTaskStore?: StaffTaskStore;
  actor: ActorContext;
  orderId: string;
  input: CancelOrderInput;
  idempotencyKey: string;
  now: Date;
}): Promise<PreparedCancelOrderWrite> {
  const binding = await requireCurrentBinding(input.accountStore, input.actor);
  const order = await requireVisibleOrder(input.orderStore, input.orderId, binding);
  validateCancelOrderInput(input.input);
  const preview = await input.orderStore.findCancellationPreview(input.input.previewId);
  const currentReservation = await input.orderStore.findActiveReservationByOrder?.(order.id) ?? null;
  if (
    !preview ||
    preview.reasonCode !== input.input.reasonCode ||
    !isCancellationPreviewCurrent(preview, order, currentReservation ? [currentReservation] : [], input.now)
  ) {
    throw new OrderError('CANCELLATION_PREVIEW_STALE', 'Refresh the cancellation preview before retrying.');
  }
  if (order.version !== input.input.expectedVersion) {
    throw new OrderError('CANCELLATION_PREVIEW_STALE', 'Refresh the cancellation preview before retrying.');
  }
  if (preview.disposition === 'STAFF_REVIEW_REQUIRED') {
    if (!input.staffTaskStore) {
      throw new OrderError('BUSINESS_RULE_VIOLATION', 'Staff task store is not configured.');
    }
    const staffTask = await createOrderStaffTask({
      store: input.staffTaskStore,
      order,
      type: 'CANCELLATION_ASSIST',
      reasonCode: isOrderAutomationPausedFor(order, 'CANCELLATION') ? 'AUTOMATION_PAUSED' : 'CUSTOMER_CANCEL_AFTER_ACCEPT',
      note: input.input.note ?? null,
      voiceChannelId: order.channelSpec.voiceChannelId,
      actor: input.actor,
      now: input.now
    });
    await input.orderStore.applyCancellationPreview(preview.id, input.now);
    return {
      data: {
        orderId: order.id,
        status: order.status,
        version: order.version,
        fundAction: 'NONE',
        amountMinor: 0,
        currency: order.currency,
        reservation: null,
        refundTransaction: null,
        staffTaskId: staffTask.id
      },
      order,
      expectedVersion: input.input.expectedVersion,
      orderEvent: null,
      reservation: null,
      reservationEvent: null,
      staffTask,
      previewId: preview.id
    };
  }
  if (!['DRAFT', 'PENDING_DISPATCH'].includes(order.status)) {
    throw new OrderError('CONFLICT', 'Order cannot be cancelled automatically.');
  }
  const reservation = order.status === 'PENDING_DISPATCH' ? currentReservation : null;
  if (order.status === 'PENDING_DISPATCH' && !reservation) {
    throw new OrderError('CONFLICT', 'Order reservation is not active.');
  }

  const releasedReservation = reservation
    ? await releaseOrderReservation({
        reservation,
        idempotencyKey: input.idempotencyKey,
        reasonCode: input.input.reasonCode,
        now: input.now
      })
    : null;
  if (reservation && !releasedReservation) {
    if (!input.staffTaskStore) {
      throw new OrderError('BUSINESS_RULE_VIOLATION', 'Staff task store is required for an unresolved wallet release.');
    }
    const exceptionOrder: OrderRecord = {
      ...order,
      status: 'EXCEPTION',
      version: order.version + 1,
      updatedAt: input.now.toISOString()
    };
    const staffTask = await input.staffTaskStore.createOrderTask({
      order: exceptionOrder,
      type: 'AUTOMATION_FAILURE',
      reasonCode: 'WALLET_RELEASE_UNRESOLVED',
      note: '供应商预留释放结果未知，需核对 Hold 状态后再处理取消。',
      voiceChannelId: order.channelSpec.voiceChannelId,
      actor: input.actor,
      now: input.now
    });
    const nextSequence = await input.orderStore.nextEventSequence(order.id);
    const orderEvent = buildOrderEvent({
      order: exceptionOrder,
      eventType: 'EXCEPTION_ENTERED',
      fromStatus: order.status,
      toStatus: 'EXCEPTION',
      actor: input.actor,
      now: input.now,
      sequence: nextSequence,
      payload: {
        reasonCode: 'WALLET_RELEASE_UNRESOLVED',
        previewId: input.input.previewId,
        reservationId: reservation.id,
        staffTaskId: staffTask.id
      }
    });
    return {
      data: {
        orderId: exceptionOrder.id,
        status: 'EXCEPTION',
        version: exceptionOrder.version,
        fundAction: 'NONE',
        amountMinor: 0,
        currency: reservation.currency,
        reservation: toApiReservationSummary(reservation),
        refundTransaction: null,
        staffTaskId: staffTask.id
      },
      order: exceptionOrder,
      expectedVersion: input.input.expectedVersion,
      orderEvent,
      reservation: null,
      reservationEvent: null,
      staffTask,
      previewId: preview.id
    };
  }
  const cancelledOrder = applyCancelOrder(order, input.now);
  const nextSequence = await input.orderStore.nextEventSequence(order.id);
  const reservationEvent = releasedReservation
    ? buildReservationEvent({
        reservation: releasedReservation,
        actor: input.actor,
        now: input.now,
        idempotencyKey: `${input.idempotencyKey}:reservation`,
        amountMinor: releasedReservation.amountMinor,
        eventType: 'RELEASED',
        fromStatus: reservation!.status,
        reasonCode: input.input.reasonCode,
        sequence: releasedReservation.version
      })
    : null;
  const orderEvent = buildOrderEvent({
    order: cancelledOrder,
    eventType: 'DETAILS_UPDATED',
    fromStatus: order.status,
    toStatus: 'CANCELLED',
    actor: input.actor,
    now: input.now,
    sequence: nextSequence,
    payload: {
      reasonCode: input.input.reasonCode,
      previewId: input.input.previewId,
      reservationId: releasedReservation?.id ?? null
    }
  });

  return {
    data: {
      orderId: cancelledOrder.id,
      status: 'CANCELLED',
      version: cancelledOrder.version,
      fundAction: releasedReservation ? 'RELEASE_RESERVATION' : 'NONE',
      amountMinor: releasedReservation?.amountMinor ?? 0,
      currency: releasedReservation?.currency ?? order.currency,
      reservation: releasedReservation ? toApiReservationSummary(releasedReservation) : null,
      refundTransaction: null,
      staffTaskId: null
    },
    order: cancelledOrder,
    expectedVersion: input.input.expectedVersion,
    orderEvent,
    reservation: releasedReservation,
    reservationEvent,
    staffTask: null,
    previewId: preview.id
  };
}

export async function previewOrderCancellation(input: {
  accountStore: AccountStore;
  orderStore: OrderStore;
  actor: ActorContext;
  orderId: string;
  input: CancellationPreviewRequest;
  now: Date;
}): Promise<CancellationPreviewResult> {
  const binding = await requireCurrentBinding(input.accountStore, input.actor);
  const order = await requireVisibleOrder(input.orderStore, input.orderId, binding);
  validateCancellationPreviewRequest(input.input);
  if (order.version !== input.input.expectedVersion) {
    throw new OrderError('CONFLICT', 'Order version is stale.');
  }
  const reservation = await input.orderStore.findActiveReservationByOrder?.(order.id) ?? null;
  const automationPaused = isOrderAutomationPausedFor(order, 'CANCELLATION');
  const automaticallyProcessable = !automationPaused && (order.status === 'DRAFT' || (order.status === 'PENDING_DISPATCH' && Boolean(reservation)));
  const releaseAmountMinor = automaticallyProcessable && order.status === 'PENDING_DISPATCH' && reservation ? reservation.amountMinor : 0;
  const staffTaskRequired = automationPaused || ['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION'].includes(order.status);
  if (!automaticallyProcessable && !staffTaskRequired) {
    throw new OrderError('CONFLICT', 'Order cannot be cancelled from its current state.');
  }
  const expiresAt = new Date(input.now.getTime() + 60_000).toISOString();
  const record: CancellationPreviewRecord = {
    id: crypto.randomUUID(),
    orderId: order.id,
    fundReservationId: automaticallyProcessable ? reservation?.id ?? null : null,
    orderVersionSnapshot: order.version,
    reservationVersionSnapshot: automaticallyProcessable ? reservation?.version ?? null : null,
    status: 'ISSUED',
    disposition: automaticallyProcessable ? 'AUTO_RELEASE' : 'STAFF_REVIEW_REQUIRED',
    releaseAmountMinor,
    refundAmountMinor: 0,
    currency: order.currency,
    policyKey: 'ORDER_CANCELLATION_V1',
    policyVersion: 1,
    reasonCode: input.input.reasonCode,
    requestedByUserId: binding.userId,
    requestedByStaffId: input.actor.actorStaffId,
    estimatedResolutionAt: automaticallyProcessable ? input.now.toISOString() : null,
    expiresAt,
    appliedAt: null,
    invalidatedAt: null,
    createdAt: input.now.toISOString()
  };
  await input.orderStore.issueCancellationPreview(record);
  return {
    previewId: record.id,
    orderId: order.id,
    orderVersion: order.version,
    automaticallyProcessable,
    fundAction: releaseAmountMinor > 0 ? 'RELEASE_RESERVATION' : 'NONE',
    estimatedAmountMinor: releaseAmountMinor,
    releaseAmountMinor,
    refundAmountMinor: 0,
    currency: order.currency,
    handlingTimeCode: automaticallyProcessable ? 'IMMEDIATE' : 'STAFF_REVIEW_REQUIRED',
    staffTaskRequired,
    validUntil: expiresAt
  };
}

export async function preparePauseOrderAutomation(input: {
  orderStore: OrderStore;
  staffTaskStore: StaffTaskStore;
  actor: ActorContext;
  orderId: string;
  control: AutomationControlInput;
  now: Date;
}): Promise<{ order: OrderRecord; expectedVersion: number; data: AutomationControlResult }> {
  validateAutomationControlInput(input.control, false, input.now);
  if (!input.actor.actorStaffId || !input.actor.actorLevel) {
    throw new OrderError('PERMISSION_DENIED', 'A staff actor is required to pause automation.');
  }
  const order = await input.orderStore.findById(input.orderId);
  if (!order) {
    throw new OrderError('RESOURCE_NOT_FOUND', 'Order was not found.');
  }
  if (order.version !== input.control.expectedVersion) {
    throw new OrderError('CONFLICT', 'Order version is stale.');
  }
  if (!activeOrderStatuses.has(order.status) || order.status === 'DRAFT') {
    throw new OrderError('CONFLICT', 'Automation cannot be paused for this order state.');
  }
  const claimedTask = await input.staffTaskStore.findClaimedOrderTask?.(order.id, input.actor.actorStaffId) ?? null;
  if (input.actor.actorLevel === 'L1_SUPPORT' && !claimedTask) {
    throw new OrderError('PERMISSION_DENIED', 'L1 support may pause only an order task they claimed.');
  }
  if ((order.automationState ?? 'RUNNING') === 'PAUSED') {
    if (order.automationPausedByStaffId !== input.actor.actorStaffId) {
      throw new OrderError('CONFLICT', 'Order automation is already paused by another staff member.');
    }
    return { order, expectedVersion: order.version, data: toAutomationControlResult(order, null) };
  }
  const paused: OrderRecord = {
    ...order,
    version: order.version + 1,
    automationState: 'PAUSED',
    automationVersion: (order.automationVersion ?? 1) + 1,
    automationPausedByStaffId: input.actor.actorStaffId,
    automationStaffTaskId: claimedTask?.id ?? null,
    automationReasonCode: input.control.reasonCode,
    automationScope: input.control.scope ?? 'ALL',
    automationPausedAt: input.now.toISOString(),
    automationResumedAt: null,
    automationExpiresAt: input.control.expiresAt ?? null,
    updatedAt: input.now.toISOString()
  };
  return { order: paused, expectedVersion: order.version, data: toAutomationControlResult(paused, null) };
}

export async function prepareResumeOrderAutomation(input: {
  orderStore: OrderStore;
  actor: ActorContext;
  orderId: string;
  control: AutomationControlInput;
  now: Date;
}): Promise<{ order: OrderRecord; expectedVersion: number; data: AutomationControlResult }> {
  validateAutomationControlInput(input.control, true, input.now);
  if (!input.actor.actorStaffId) {
    throw new OrderError('PERMISSION_DENIED', 'A staff actor is required to resume automation.');
  }
  const order = await input.orderStore.findById(input.orderId);
  if (!order) {
    throw new OrderError('RESOURCE_NOT_FOUND', 'Order was not found.');
  }
  if (order.version !== input.control.expectedVersion) {
    throw new OrderError('CONFLICT', 'Order version is stale.');
  }
  if ((order.automationState ?? 'RUNNING') !== 'PAUSED') {
    return { order, expectedVersion: order.version, data: toAutomationControlResult(order, input.control.resumeAction ?? null) };
  }
  validateResumeAction(order, input.control.resumeAction!);
  if (['PENDING_DISPATCH', 'ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION'].includes(order.status)) {
    const reservation = await input.orderStore.findActiveReservationByOrder?.(order.id) ?? null;
    if (!reservation) {
      throw new OrderError('CONFLICT', 'Active reservation must be restored before automation can resume.');
    }
  }
  const resumed: OrderRecord = {
    ...order,
    version: order.version + 1,
    automationState: 'RUNNING',
    automationVersion: (order.automationVersion ?? 1) + 1,
    automationPausedByStaffId: null,
    automationStaffTaskId: null,
    automationReasonCode: null,
    automationScope: null,
    automationPausedAt: null,
    automationResumedAt: input.now.toISOString(),
    automationExpiresAt: null,
    updatedAt: input.now.toISOString()
  };
  return { order: resumed, expectedVersion: order.version, data: toAutomationControlResult(resumed, input.control.resumeAction!) };
}

function validateAutomationControlInput(control: AutomationControlInput, resume: boolean, now: Date): void {
  if (!control || !Number.isInteger(control.expectedVersion) || control.expectedVersion < 1) {
    throw new OrderError('VALIDATION_ERROR', 'expectedVersion must be a positive integer.');
  }
  if (!control.reasonCode || !/^[A-Z][A-Z0-9_]{2,63}$/.test(control.reasonCode)) {
    throw new OrderError('VALIDATION_ERROR', 'reasonCode is invalid.');
  }
  if (control.expiresAt && new Date(control.expiresAt).getTime() <= now.getTime()) {
    throw new OrderError('VALIDATION_ERROR', 'expiresAt must be in the future.');
  }
  if (resume && !control.resumeAction) {
    throw new OrderError('VALIDATION_ERROR', 'resumeAction is required when resuming automation.');
  }
}

function validateResumeAction(order: OrderRecord, action: NonNullable<AutomationControlInput['resumeAction']>): void {
  const permitted = order.status === 'PENDING_DISPATCH'
    ? ['REDISPATCH', 'NONE']
    : order.status === 'ACCEPTED'
      ? ['RESTART_READINESS_TIMEOUT', 'NONE']
      : ['NONE'];
  if (!permitted.includes(action)) {
    throw new OrderError('CONFLICT', 'resumeAction is not valid for the current order state.');
  }
}

function toAutomationControlResult(order: OrderRecord, resumeAction: AutomationControlResult['resumeAction']): AutomationControlResult {
  return {
    orderId: order.id,
    orderVersion: order.version,
    resumeAction,
    automation: {
      state: order.automationState ?? 'RUNNING',
      version: order.automationVersion ?? 1,
      pausedByStaffId: order.automationPausedByStaffId ?? null,
      staffTaskId: order.automationStaffTaskId ?? null,
      reasonCode: order.automationReasonCode ?? null,
      scope: order.automationScope ?? null,
      pausedAt: order.automationPausedAt ?? null,
      resumedAt: order.automationResumedAt ?? null,
      expiresAt: order.automationExpiresAt ?? null
    }
  };
}

function isOrderAutomationPausedFor(order: OrderRecord, scope: NonNullable<OrderRecord['automationScope']>): boolean {
  return order.automationState === 'PAUSED'
    && (!order.automationScope || order.automationScope === 'ALL' || order.automationScope === scope);
}

export function registerOrderRoutes(
  server: FastifyInstance,
  options: {
    accountStore: AccountStore;
    catalogStore: ServiceCatalogStore;
    orderStore: OrderStore;
    walletFunding?: WalletFundingService;
    staffTaskStore?: StaffTaskStore;
    now?: () => Date;
    auditSink?: AuditSink;
  }
): void {
  const security = server.securityOptions;
  if (!security) {
    throw new Error('Order routes require buildApiServer({ security })');
  }
  const now = options.now ?? (() => new Date());
  const auditSink = options.auditSink ?? security.auditSink ?? new InMemoryAuditSink();

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/admin/orders/:orderId/automation/pause',
    permission: 'order.pause',
    action: 'PAUSE_ORDER_AUTOMATION',
    targetType: 'order',
    targetId: (request) => readParams(request).orderId ?? '00000000-0000-0000-0000-000000000000',
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    handler: async (request, actor) => {
      if (!options.staffTaskStore) {
        throw new OrderError('BUSINESS_RULE_VIOLATION', 'Staff task store is required for automation takeover.');
      }
      const prepared = await preparePauseOrderAutomation({
        orderStore: options.orderStore,
        staffTaskStore: options.staffTaskStore,
        actor,
        orderId: readParams(request).orderId ?? '',
        control: request.body as AutomationControlInput,
        now: now()
      });
      return {
        data: prepared.data,
        commit: (auditRecord: AuditRecord) => options.orderStore.commitAutomationControl({
          order: prepared.order,
          expectedVersion: prepared.expectedVersion,
          auditRecord: {
            ...auditRecord,
            beforeSnapshot: { orderVersion: prepared.expectedVersion, automationState: 'RUNNING' },
            afterSnapshot: prepared.data
          },
          auditSink
        })
      };
    },
    mapError: mapOrderError,
    fingerprintBody: (request) => request.body
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/admin/orders/:orderId/automation/resume',
    permission: 'order.resume',
    action: 'RESUME_ORDER_AUTOMATION',
    targetType: 'order',
    targetId: (request) => readParams(request).orderId ?? '00000000-0000-0000-0000-000000000000',
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    handler: async (request, actor) => {
      const prepared = await prepareResumeOrderAutomation({
        orderStore: options.orderStore,
        actor,
        orderId: readParams(request).orderId ?? '',
        control: request.body as AutomationControlInput,
        now: now()
      });
      return {
        data: prepared.data,
        commit: (auditRecord: AuditRecord) => options.orderStore.commitAutomationControl({
          order: prepared.order,
          expectedVersion: prepared.expectedVersion,
          auditRecord: {
            ...auditRecord,
            beforeSnapshot: { orderVersion: prepared.expectedVersion, automationState: 'PAUSED' },
            afterSnapshot: prepared.data
          },
          auditSink
        })
      };
    },
    mapError: mapOrderError,
    fingerprintBody: (request) => request.body
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/orders/:orderId/cancellation-preview',
    permission: 'order.cancellation.preview',
    action: 'PREVIEW_ORDER_CANCELLATION',
    targetType: 'order',
    targetId: (request) => readParams(request).orderId ?? '00000000-0000-0000-0000-000000000000',
    acceptedSources: ['DISCORD_BOT', 'DASHBOARD'],
    handler: async (request, actor) => previewOrderCancellation({
      accountStore: options.accountStore,
      orderStore: options.orderStore,
      actor,
      orderId: readParams(request).orderId ?? '',
      input: request.body as CancellationPreviewRequest,
      now: now()
    }),
    mapError: mapOrderError,
    fingerprintBody: (request) => request.body
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/orders',
    permission: 'order.create',
    action: 'CREATE_ORDER',
    targetType: 'order',
    handler: async (request, actor) => {
      const prepared = await prepareCreateOrder({
        accountStore: options.accountStore,
        orderStore: options.orderStore,
        actor,
        input: request.body as CreateOrderInput,
        now: now()
      });
      if (!('order' in prepared)) {
        return {
          data: prepared.data,
          statusCode: prepared.statusCode,
          commit: async (auditRecord: AuditRecord) => {
            await auditSink.append(auditRecord);
          }
        };
      }
      return {
        data: prepared.data,
        statusCode: prepared.statusCode,
        commit: async (auditRecord: AuditRecord) => {
          await options.orderStore.commitCreate({
            order: prepared.order,
            event: prepared.event,
            auditRecord,
            auditSink
          });
        }
      };
    },
    mapError: mapOrderError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/orders/:orderId/submit',
    permission: 'order.submit',
    action: 'SUBMIT_ORDER',
    targetType: 'order',
    targetId: (request) => readParams(request).orderId ?? '00000000-0000-0000-0000-000000000000',
    handler: async (request, actor) => {
      if (!options.walletFunding) throw new OrderError('BUSINESS_RULE_VIOLATION', 'Wallet funding is not configured.');
      const prepared = await prepareSubmitOrder({
        accountStore: options.accountStore,
        catalogStore: options.catalogStore,
        orderStore: options.orderStore,
        walletFunding: options.walletFunding,
        actor,
        orderId: readParams(request).orderId ?? '',
        input: request.body as SubmitOrderInput,
        idempotencyKey: readIdempotencyKey(request),
        now: now()
      });
      return {
        data: prepared.data,
        commit: async (auditRecord: AuditRecord) => {
          if (!options.orderStore.commitSubmit) {
            throw new OrderError('BUSINESS_RULE_VIOLATION', 'Order store cannot submit orders.');
          }
          try {
            await options.orderStore.commitSubmit({
              order: prepared.order,
              expectedVersion: (request.body as SubmitOrderInput).expectedVersion,
              ledgerBalanceMinor: prepared.ledgerBalanceMinor,
              orderEvent: prepared.orderEvent,
              reservation: prepared.reservation,
              reservationEvent: prepared.reservationEvent,
              externalTransactions: prepared.externalTransactions,
              dispatchStartJob: prepared.dispatchStartJob,
              auditRecord: {
                ...auditRecord,
                beforeSnapshot: {
                  orderId: prepared.order.id,
                  expectedVersion: (request.body as SubmitOrderInput).expectedVersion,
                  status: 'DRAFT'
                },
                afterSnapshot: buildSubmitAuditSnapshot(prepared)
              },
              auditSink
            });
          } catch (error) { throw error; }
        }
      };
    },
    mapError: mapOrderError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/orders/:orderId/cancel',
    retryCommitFailures: true,
    permission: 'order.cancel',
    action: 'CANCEL_ORDER',
    targetType: 'order',
    targetId: (request) => readParams(request).orderId ?? '00000000-0000-0000-0000-000000000000',
    handler: async (request, actor) => {
      const prepared = await prepareCancelOrder({
        accountStore: options.accountStore,
        orderStore: options.orderStore,
        staffTaskStore: options.staffTaskStore,
        actor,
        orderId: readParams(request).orderId ?? '',
        input: request.body as CancelOrderInput,
        idempotencyKey: readIdempotencyKey(request),
        now: now()
      });
      if (!prepared.orderEvent) {
        return prepared.data;
      }
      const orderEvent = prepared.orderEvent;
      return {
        data: prepared.data,
        commit: async (auditRecord: AuditRecord) => {
          if (!options.orderStore.commitCancel) {
            throw new OrderError('BUSINESS_RULE_VIOLATION', 'Order store cannot cancel orders.');
          }
          await options.orderStore.commitCancel({
            order: prepared.order,
            expectedVersion: prepared.expectedVersion,
            orderEvent,
            reservation: prepared.reservation,
            reservationEvent: prepared.reservationEvent,
            auditRecord: {
              ...auditRecord,
              beforeSnapshot: {
                orderId: prepared.order.id,
                expectedVersion: prepared.expectedVersion
              },
              afterSnapshot: prepared.data
            },
            auditSink,
            previewId: prepared.previewId,
            now: now()
          });
        }
      };
    },
    mapError: mapOrderError
  });

  registerSecureReadRoute(server, security, {
    method: 'GET',
    url: '/api/v1/orders/:orderId',
    permission: 'order.read',
    action: 'GET_ORDER',
    targetType: 'order',
    targetId: (request) => readParams(request).orderId ?? '00000000-0000-0000-0000-000000000000',
    handler: async (request, actor) => getOrder({
      accountStore: options.accountStore,
      orderStore: options.orderStore,
      actor,
      orderId: readParams(request).orderId ?? ''
    }),
    mapError: mapOrderError
  });

  registerSecureWriteRoute(server, security, {
    method: 'PATCH',
    url: '/api/v1/orders/:orderId',
    permission: 'order.update',
    action: 'UPDATE_ORDER',
    targetType: 'order',
    targetId: (request) => readParams(request).orderId ?? '00000000-0000-0000-0000-000000000000',
    handler: async (request, actor) => {
      const prepared = await prepareUpdateOrder({
        accountStore: options.accountStore,
        catalogStore: options.catalogStore,
        orderStore: options.orderStore,
        actor,
        orderId: readParams(request).orderId ?? '',
        input: request.body as UpdateOrderInput,
        now: now()
      });
      return {
        data: prepared.data,
        commit: async (auditRecord: AuditRecord) => {
          await options.orderStore.commitUpdate({
            order: prepared.order,
            event: prepared.event,
            expectedVersion: (request.body as UpdateOrderInput).expectedVersion,
            auditRecord,
            auditSink
          });
        }
      };
    },
    mapError: mapOrderError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/orders/:orderId/estimate',
    permission: 'order.estimate',
    action: 'ESTIMATE_ORDER',
    targetType: 'order',
    targetId: (request) => readParams(request).orderId ?? '00000000-0000-0000-0000-000000000000',
    handler: async (request, actor) => estimateOrder({
      accountStore: options.accountStore,
      orderStore: options.orderStore,
      actor,
      orderId: readParams(request).orderId ?? '',
      input: request.body as EstimateOrderInput,
      now: now()
    }),
    mapError: mapOrderError
  });
}

function buildDraftOrder(input: {
  binding: AccountBindingRecord;
  channelSpec: ChannelSpec;
  now: Date;
}): OrderRecord {
  const createdAt = input.now.toISOString();
  return {
    id: crypto.randomUUID(),
    publicId: `P-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    customerId: input.binding.userId,
    guildId: input.binding.guildId,
    playerId: null,
    status: 'DRAFT',
    version: 1,
    serviceCatalogId: null,
    catalogVersion: null,
    game: null,
    service: null,
    region: null,
    billingUnitMinutes: null,
    unitCount: null,
    customerUnitPriceMinor: null,
    playerUnitPayoutMinor: null,
    amountMinor: 0,
    playerEarningMinor: 0,
    currency: 'CAT',
    notes: null,
    preferredPlayerDiscordUserIds: [],
    channelSpec: clone(input.channelSpec),
    createdAt,
    updatedAt: createdAt
  };
}

function applyServiceSnapshot(input: {
  order: OrderRecord;
  service: ServiceCatalogRecord & {
    customerUnitPriceMinor: number;
    playerUnitPayoutMinor: number;
  };
  unitCount: number;
  region: string | null;
  notes: string | null;
  voiceChannelId: string | null;
  preferredPlayerDiscordUserIds: string[];
  now: Date;
}): OrderRecord {
  return {
    ...input.order,
    version: input.order.version + 1,
    serviceCatalogId: input.service.id,
    catalogVersion: input.service.version,
    game: input.service.game,
    service: input.service.service,
    region: input.region,
    billingUnitMinutes: input.service.billingUnitMinutes,
    unitCount: input.unitCount,
    customerUnitPriceMinor: input.service.customerUnitPriceMinor,
    playerUnitPayoutMinor: input.service.playerUnitPayoutMinor,
    amountMinor: input.unitCount * input.service.customerUnitPriceMinor,
    playerEarningMinor: input.unitCount * input.service.playerUnitPayoutMinor,
    currency: input.service.currency,
    notes: input.notes,
    preferredPlayerDiscordUserIds: [...input.preferredPlayerDiscordUserIds],
    channelSpec: {
      ...input.order.channelSpec,
      voiceChannelId: input.voiceChannelId
    },
    updatedAt: input.now.toISOString()
  };
}

function buildOrderEvent(input: {
  order: OrderRecord;
  eventType: OrderEventType;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actor: ActorContext;
  now: Date;
  sequence: number;
  payload: unknown;
}): OrderEventRecord {
  return {
    id: crypto.randomUUID(),
    orderId: input.order.id,
    sequence: input.sequence,
    eventType: input.eventType,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    actorUserId: input.actor.actorUserId,
    actorStaffId: input.actor.actorStaffId,
    actorSource: input.actor.actorSource,
    interactionId: input.actor.interactionId,
    payload: input.payload,
    createdAt: input.now.toISOString()
  };
}

async function requireCurrentBinding(store: AccountStore, actor: ActorContext): Promise<AccountBindingRecord> {
  if (!actor.guildId || !actor.discordUserId) {
    throw new OrderError('VALIDATION_ERROR', 'Discord actor context is required.');
  }
  const binding = await store.findByDiscord({
    guildId: actor.guildId,
    discordUserId: actor.discordUserId
  });
  if (!binding) {
    throw new OrderError('ACCOUNT_NOT_BOUND', 'Current Discord actor is not bound.');
  }
  return binding;
}

async function requireVisibleOrder(
  store: OrderStore,
  orderId: string,
  binding: AccountBindingRecord
): Promise<OrderRecord> {
  const order = await store.findById(orderId);
  if (!order) {
    throw new OrderError('RESOURCE_NOT_FOUND', 'Order was not found.');
  }
  if (order.customerId !== binding.userId) {
    throw new OrderError('PERMISSION_DENIED', 'Order is not visible to the current actor.');
  }
  return order;
}

function validateDraftOrderVersion(order: OrderRecord, expectedVersion: number): void {
  if (order.status !== 'DRAFT') {
    throw new OrderError('BUSINESS_RULE_VIOLATION', 'Only draft orders can be changed.');
  }
  if (order.version !== expectedVersion) {
    throw new OrderError('CONFLICT', 'Order version is stale.');
  }
}

function validateCreateOrderInput(input: CreateOrderInput): void {
  if (!input || typeof input !== 'object') {
    throw new OrderError('VALIDATION_ERROR', 'Order payload is required.');
  }
  if (input.orderType !== 'IMMEDIATE') {
    throw new OrderError('VALIDATION_ERROR', 'orderType must be IMMEDIATE.');
  }
  validateChannelSpec(input.channelSpec);
}

function validateUpdateOrderInput(input: UpdateOrderInput): void {
  if (!input || typeof input !== 'object') {
    throw new OrderError('VALIDATION_ERROR', 'Order update payload is required.');
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new OrderError('VALIDATION_ERROR', 'expectedVersion must be a positive integer.');
  }
  if (!isUuid(input.serviceCatalogId)) {
    throw new OrderError('VALIDATION_ERROR', 'serviceCatalogId must be a uuid.');
  }
  if (!Number.isInteger(input.unitCount) || input.unitCount < 1 || input.unitCount > 1440) {
    throw new OrderError('VALIDATION_ERROR', 'unitCount must be between 1 and 1440.');
  }
  if (input.region !== undefined && input.region !== null && typeof input.region !== 'string') {
    throw new OrderError('VALIDATION_ERROR', 'region must be a string or null.');
  }
  if (input.notes !== undefined && input.notes !== null && typeof input.notes !== 'string') {
    throw new OrderError('VALIDATION_ERROR', 'notes must be a string or null.');
  }
  if (input.voiceChannelId !== undefined && input.voiceChannelId !== null && !isSnowflake(input.voiceChannelId)) {
    throw new OrderError('VALIDATION_ERROR', 'voiceChannelId must be a Discord snowflake or null.');
  }
  if (input.preferredPlayerDiscordUserIds !== undefined) {
    if (
      !Array.isArray(input.preferredPlayerDiscordUserIds) ||
      input.preferredPlayerDiscordUserIds.length > 3 ||
      new Set(input.preferredPlayerDiscordUserIds).size !== input.preferredPlayerDiscordUserIds.length ||
      input.preferredPlayerDiscordUserIds.some((id) => !isSnowflake(id))
    ) {
      throw new OrderError('VALIDATION_ERROR', 'preferredPlayerDiscordUserIds must contain at most three unique Discord users.');
    }
  }
}

function validateChannelSpec(channelSpec: ChannelSpec): void {
  if (!channelSpec || typeof channelSpec !== 'object') {
    throw new OrderError('VALIDATION_ERROR', 'channelSpec is required.');
  }
  if (!isSnowflake(channelSpec.channelId)) {
    throw new OrderError('VALIDATION_ERROR', 'channelSpec.channelId must be a Discord snowflake.');
  }
  if (!isSnowflake(channelSpec.panelMessageId)) {
    throw new OrderError('VALIDATION_ERROR', 'channelSpec.panelMessageId must be a Discord snowflake.');
  }
  if (channelSpec.voiceChannelId !== null && !isSnowflake(channelSpec.voiceChannelId)) {
    throw new OrderError('VALIDATION_ERROR', 'channelSpec.voiceChannelId must be a Discord snowflake or null.');
  }
}

function assertAvailableService(record: ServiceCatalogRecord | null): asserts record is ServiceCatalogRecord & {
  customerUnitPriceMinor: number;
  playerUnitPayoutMinor: number;
} {
  if (
    !record ||
    record.status !== 'ACTIVE' ||
    typeof record.customerUnitPriceMinor !== 'number' ||
    record.customerUnitPriceMinor <= 0 ||
    typeof record.playerUnitPayoutMinor !== 'number' ||
    record.playerUnitPayoutMinor <= 0
  ) {
    throw new OrderError('SERVICE_NOT_AVAILABLE', 'Service is not available.');
  }
}

function toApiOrder(
  order: OrderRecord,
  reservation: FundReservationRecord | null = null,
  matching: OrderMatchingProgress | null = null
): OrderApiRecord {
  return {
    id: order.id,
    publicId: order.publicId,
    status: order.status,
    version: order.version,
    orderType: 'IMMEDIATE',
    serviceCatalogId: order.serviceCatalogId,
    catalogVersion: order.catalogVersion,
    unitCount: order.unitCount,
    billingUnitMinutes: order.billingUnitMinutes,
    customerUnitPriceMinor: order.customerUnitPriceMinor,
    playerUnitPayoutMinor: order.playerUnitPayoutMinor,
    currency: order.currency,
    amountMinor: order.amountMinor,
    playerEarningMinor: order.playerEarningMinor,
    game: order.game,
    service: order.service,
    matching,
    fundReservation: reservation ? toApiReservationSummary(reservation) : null,
    readiness: {
      customer: 'NOT_READY',
      player: 'NOT_READY',
      bothReady: false,
      readyDeadlineAt: null,
      startedAt: null,
      staffTaskId: null
    },
    automation: {
      state: order.automationState ?? 'RUNNING',
      version: order.automationVersion ?? 1,
      pausedByStaffId: order.automationPausedByStaffId ?? null,
      staffTaskId: order.automationStaffTaskId ?? null,
      reasonCode: order.automationReasonCode ?? null,
      scope: order.automationScope ?? null,
      pausedAt: order.automationPausedAt ?? null,
      resumedAt: order.automationResumedAt ?? null,
      expiresAt: order.automationExpiresAt ?? null
    },
    playerId: order.playerId,
    region: order.region,
    notes: order.notes,
    preferredPlayerDiscordUserIds: [...(order.preferredPlayerDiscordUserIds ?? [])],
    channelSpec: clone(order.channelSpec),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

function toApiReservationSummary(reservation: FundReservationRecord): FundReservationSummary {
  return {
    reservationId: reservation.id,
    amountMinor: reservation.amountMinor,
    capturedMinor: reservation.status === 'CAPTURED' ? reservation.amountMinor : 0,
    releasedMinor: reservation.status === 'RELEASED' || reservation.status === 'EXPIRED' ? reservation.amountMinor : 0,
    currency: reservation.currency,
    status: reservation.status,
    version: reservation.version,
    expiresAt: reservation.expiresAt
  };
}

function toApiReservation(reservation: FundReservationRecord): FundReservationApiRecord {
  return {
    id: reservation.id,
    sourceType: reservation.sourceType,
    sourceId: reservation.orderId,
    ownerUserId: reservation.userId,
    amountMinor: reservation.amountMinor,
    capturedMinor: reservation.status === 'CAPTURED' ? reservation.amountMinor : 0,
    releasedMinor: reservation.status === 'RELEASED' || reservation.status === 'EXPIRED' ? reservation.amountMinor : 0,
    currency: reservation.currency,
    status: reservation.status,
    backend: reservation.mode,
    walletHoldReferenceDisplay: null,
    idempotencyKey: reservation.idempotencyKey,
    version: reservation.version,
    expiresAt: reservation.expiresAt,
    createdAt: reservation.createdAt,
    updatedAt: reservation.updatedAt
  };
}

function applySubmitOrder(order: OrderRecord, now: Date): OrderRecord {
  return {
    ...order,
    status: 'PENDING_DISPATCH',
    version: order.version + 1,
    updatedAt: now.toISOString()
  };
}

function applyCancelOrder(order: OrderRecord, now: Date): OrderRecord {
  return {
    ...order,
    status: 'CANCELLED',
    version: order.version + 1,
    updatedAt: now.toISOString()
  };
}

async function releaseOrderReservation(input: {
  reservation: FundReservationRecord;
  idempotencyKey: string;
  reasonCode: string;
  now: Date;
}): Promise<FundReservationRecord | null> {
  void input.idempotencyKey;
  void input.reasonCode;
  return {
    ...input.reservation,
    status: 'RELEASED',
    version: input.reservation.version + 1,
    settledAt: input.now.toISOString(),
    updatedAt: input.now.toISOString()
  };
}

function buildOrderReservation(input: {
  order: OrderRecord;
  binding: AccountBindingRecord;
  providerKey: string;
  mode: FundReservationMode;
  idempotencyKey: string;
  now: Date;
}): FundReservationRecord {
  const draft = buildFundReservationDraft({
    businessSource: { type: 'ORDER', referenceId: input.order.id },
    userId: input.binding.userId,
    provider: input.providerKey,
    mode: input.mode,
    amountMinor: input.order.amountMinor,
    currency: input.order.currency,
    idempotencyKey: input.idempotencyKey,
    ttlMinutes: 30,
    now: input.now
  });
  return {
    id: draft.id,
    userId: draft.userId,
    sourceType: 'ORDER',
    orderId: input.order.id,
    mode: draft.mode,
    provider: draft.provider,
    providerHoldRef: draft.providerHoldRef,
    amountMinor: draft.amountMinor,
    currency: draft.currency,
    status: draft.status,
    version: draft.version,
    idempotencyKey: draft.idempotencyKey,
    expiresAt: draft.expiresAt,
    activatedAt: draft.activatedAt,
    settledAt: draft.settledAt,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt
  };
}

function buildReservationEvent(input: {
  reservation: FundReservationRecord;
  actor: ActorContext;
  now: Date;
  idempotencyKey: string;
  amountMinor: number;
  eventType?: FundReservationEventType;
  fromStatus?: FundReservationStatus | null;
  reasonCode?: string | null;
  sequence?: number;
}): FundReservationEventRecord {
  return {
    id: crypto.randomUUID(),
    fundReservationId: input.reservation.id,
    sequence: input.sequence ?? 1,
    eventType: input.eventType ?? 'CREATED',
    fromStatus: input.fromStatus ?? null,
    toStatus: input.reservation.status,
    amountMinor: input.amountMinor,
    reservationVersion: input.reservation.version,
    idempotencyKey: input.idempotencyKey,
    actorUserId: input.actor.actorUserId,
    actorStaffId: input.actor.actorStaffId,
    actorSource: input.actor.actorSource,
    reasonCode: input.reasonCode ?? 'ORDER_SUBMIT',
    createdAt: input.now.toISOString()
  };
}

function validateSubmitOrderInput(input: SubmitOrderInput): void {
  if (!input || typeof input !== 'object') {
    throw new OrderError('VALIDATION_ERROR', 'Submit payload is required.');
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new OrderError('VALIDATION_ERROR', 'expectedVersion must be a positive integer.');
  }
}

function validateCancelOrderInput(input: CancelOrderInput): void {
  if (!input || typeof input !== 'object') {
    throw new OrderError('VALIDATION_ERROR', 'Cancel payload is required.');
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new OrderError('VALIDATION_ERROR', 'expectedVersion must be a positive integer.');
  }
  if (!isUuid(input.previewId)) {
    throw new OrderError('VALIDATION_ERROR', 'previewId must be a UUID.');
  }
  if (typeof input.reasonCode !== 'string' || input.reasonCode.length < 1 || input.reasonCode.length > 64) {
    throw new OrderError('VALIDATION_ERROR', 'reasonCode is required.');
  }
}

function validateCancellationPreviewRequest(input: CancellationPreviewRequest): void {
  if (!input || typeof input !== 'object') {
    throw new OrderError('VALIDATION_ERROR', 'Cancellation preview payload is required.');
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new OrderError('VALIDATION_ERROR', 'expectedVersion must be a positive integer.');
  }
  if (typeof input.reasonCode !== 'string' || input.reasonCode.length < 1 || input.reasonCode.length > 64) {
    throw new OrderError('VALIDATION_ERROR', 'reasonCode is required.');
  }
}

function isCancellationPreviewCurrent(
  preview: CancellationPreviewRecord,
  order: OrderRecord,
  reservations: FundReservationRecord[],
  now: Date
): boolean {
  if (
    preview.status !== 'ISSUED' ||
    preview.orderId !== order.id ||
    preview.orderVersionSnapshot !== order.version ||
    Date.parse(preview.expiresAt) < now.getTime()
  ) {
    return false;
  }
  if (!preview.fundReservationId) {
    return preview.reservationVersionSnapshot === null;
  }
  const reservation = reservations.find((candidate) => candidate.id === preview.fundReservationId);
  return Boolean(
    reservation &&
    reservation.orderId === order.id &&
    reservation.version === preview.reservationVersionSnapshot &&
    activeFundReservationStatuses.includes(reservation.status)
  );
}

function validateSubmittableDraft(order: OrderRecord): void {
  if (
    !order.serviceCatalogId ||
    !order.catalogVersion ||
    !order.billingUnitMinutes ||
    !order.unitCount ||
    order.amountMinor <= 0 ||
    !order.customerUnitPriceMinor ||
    !order.playerUnitPayoutMinor
  ) {
    throw new OrderError('BUSINESS_RULE_VIOLATION', 'Order draft is not ready to submit.');
  }
}

async function validateCurrentCatalogSnapshot(catalogStore: ServiceCatalogStore, order: OrderRecord): Promise<void> {
  if (!order.serviceCatalogId) {
    throw new OrderError('BUSINESS_RULE_VIOLATION', 'Order draft is missing a service catalog snapshot.');
  }
  const catalog = await catalogStore.getById(order.serviceCatalogId);
  if (!catalog || catalog.status !== 'ACTIVE') {
    throw new OrderError('SERVICE_NOT_AVAILABLE', 'Service catalog item is no longer active.');
  }
  if (catalog.customerUnitPriceMinor === null || catalog.playerUnitPayoutMinor === null) {
    throw new OrderError('SERVICE_NOT_AVAILABLE', 'Service catalog item is missing active pricing.');
  }
  const unitCount = order.unitCount ?? 0;
  const expectedAmount = catalog.customerUnitPriceMinor * unitCount;
  const expectedPayout = catalog.playerUnitPayoutMinor * unitCount;
  if (
    order.catalogVersion !== catalog.version ||
    order.billingUnitMinutes !== catalog.billingUnitMinutes ||
    order.customerUnitPriceMinor !== catalog.customerUnitPriceMinor ||
    order.playerUnitPayoutMinor !== catalog.playerUnitPayoutMinor ||
    order.currency !== catalog.currency ||
    order.amountMinor !== expectedAmount ||
    order.playerEarningMinor !== expectedPayout ||
    order.game !== catalog.game ||
    order.service !== catalog.service ||
    order.region !== catalog.region
  ) {
    throw new OrderError('CONFLICT', 'Order price snapshot is stale.');
  }
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function readParams(request: FastifyRequest): { orderId?: string } {
  return request.params as { orderId?: string };
}

function mapOrderError(error: unknown): { statusCode: number; code: string; message: string } | null {
  if (!(error instanceof OrderError)) {
    return null;
  }
  const statusByCode: Record<OrderError['code'], number> = {
    ACCOUNT_NOT_BOUND: 403,
    BUSINESS_RULE_VIOLATION: 422,
    CANCELLATION_PREVIEW_STALE: 409,
    CONFLICT: 409,
    INSUFFICIENT_AVAILABLE_BALANCE: 422,
    PERMISSION_DENIED: 403,
    RESOURCE_NOT_FOUND: 404,
    SERVICE_NOT_AVAILABLE: 422,
    VALIDATION_ERROR: 400
  };
  return {
    statusCode: statusByCode[error.code],
    code: error.code,
    message: error.message
  };
}

async function insertOrder(client: OrderQueryClient, order: OrderRecord): Promise<void> {
  await client.query(
    `
INSERT INTO orders (
  id, public_id, customer_id, player_id, active_customer_slot_id, active_player_slot_id,
  status, row_version, service_catalog_version_id, catalog_version,
  game_code_snapshot, game_name_snapshot, service_code_snapshot, service_name_snapshot,
  region_code_snapshot, billing_unit_minutes, unit_count,
  customer_unit_price_minor, player_unit_payout_minor, amount_minor, expected_player_earning_minor,
  currency, customer_note, guild_id, channel_id, panel_message_id, voice_channel_id,
  created_at, updated_at
)
VALUES (
  $1, $2, $3, $4, $5, $6,
  $7::"OrderStatus", $8, $9, $10,
  $11, $12, $13, $14,
  $15, $16, $17,
  $18, $19, $20, $21,
  $22, $23, $24, $25, $26, $27,
  $28, $29
)
    `,
    [
      order.id,
      order.publicId,
      order.customerId,
      order.playerId,
      activeOrderStatuses.has(order.status) ? order.customerId : null,
      order.playerId && ['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION'].includes(order.status) ? order.playerId : null,
      order.status,
      order.version,
      order.serviceCatalogId,
      order.catalogVersion,
      order.game,
      order.game,
      order.service,
      order.service,
      order.region,
      order.billingUnitMinutes,
      order.unitCount,
      order.customerUnitPriceMinor,
      order.playerUnitPayoutMinor,
      order.amountMinor,
      order.playerEarningMinor,
      order.currency,
      order.notes,
      order.channelSpec.channelId ? inferGuildIdFromOrder(order) : null,
      order.channelSpec.channelId,
      order.channelSpec.panelMessageId,
      order.channelSpec.voiceChannelId,
      new Date(order.createdAt),
      new Date(order.updatedAt)
    ]
  );
}

async function updateDraftOrder(
  client: OrderQueryClient,
  order: OrderRecord,
  expectedVersion: number
): Promise<{ rowCount?: number | null }> {
  return client.query(
    `
UPDATE orders
SET row_version = $2,
    service_catalog_version_id = $3,
    catalog_version = $4,
    game_code_snapshot = $5,
    game_name_snapshot = $6,
    service_code_snapshot = $7,
    service_name_snapshot = $8,
    region_code_snapshot = $9,
    billing_unit_minutes = $10,
    unit_count = $11,
    customer_unit_price_minor = $12,
    player_unit_payout_minor = $13,
    amount_minor = $14,
    expected_player_earning_minor = $15,
    currency = $16,
    customer_note = $17,
    voice_channel_id = $18,
    requirement_snapshot = $19::jsonb,
    updated_at = $20
WHERE id = $1
  AND status = 'DRAFT'
  AND row_version = $21
    `,
    [
      order.id,
      order.version,
      order.serviceCatalogId,
      order.catalogVersion,
      order.game,
      order.game,
      order.service,
      order.service,
      order.region,
      order.billingUnitMinutes,
      order.unitCount,
      order.customerUnitPriceMinor,
      order.playerUnitPayoutMinor,
      order.amountMinor,
      order.playerEarningMinor,
      order.currency,
      order.notes,
      order.channelSpec.voiceChannelId,
      JSON.stringify({ preferredPlayerDiscordUserIds: order.preferredPlayerDiscordUserIds ?? [] }),
      new Date(order.updatedAt),
      expectedVersion
    ]
  );
}

async function insertOrderPanelSync(client: OrderQueryClient, input: {
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

async function updateSubmittedOrder(
  client: OrderQueryClient,
  order: OrderRecord,
  expectedVersion: number
): Promise<{ rowCount?: number | null }> {
  return client.query(
    `
UPDATE orders
SET status = $2::"OrderStatus",
    row_version = $3,
    updated_at = $4
WHERE id = $1
  AND status = 'DRAFT'
  AND row_version = $5
    `,
    [order.id, order.status, order.version, new Date(order.updatedAt), expectedVersion]
  );
}

async function updateCancelledOrder(
  client: OrderQueryClient,
  order: OrderRecord,
  expectedVersion: number
): Promise<{ rowCount?: number | null }> {
  return client.query(
    `
UPDATE orders
SET status = $2::"OrderStatus",
    row_version = $3,
    active_customer_slot_id = NULL,
    active_player_slot_id = NULL,
    updated_at = $4
WHERE id = $1
  AND status = ANY($6::"OrderStatus"[])
  AND row_version = $5
    `,
    [order.id, order.status, order.version, new Date(order.updatedAt), expectedVersion, ['DRAFT', 'PENDING_DISPATCH']]
  );
}

async function lockUserCurrency(client: OrderQueryClient, userId: string, currency: string): Promise<void> {
  await client.query(
    `
INSERT INTO user_currency_locks (user_id, currency, updated_at)
VALUES ($1, $2, now())
ON CONFLICT (user_id, currency) DO NOTHING
    `,
    [userId, currency]
  );
  await client.query(
    `
SELECT user_id
FROM user_currency_locks
WHERE user_id = $1
  AND currency = $2
FOR UPDATE
    `,
    [userId, currency]
  );
}

async function validateCatalogSnapshotForCommit(client: OrderQueryClient, order: OrderRecord): Promise<void> {
  if (!order.serviceCatalogId) {
    throw new OrderError('BUSINESS_RULE_VIOLATION', 'Order draft is missing a service catalog snapshot.');
  }
  const result = await client.query<{
    status: string;
    version: number;
    billing_unit_minutes: number;
    customer_unit_price_minor: string | null;
    player_unit_payout_minor: string | null;
    currency: string;
    game_name: string;
    service_name: string;
    region_code: string;
  }>(
    `
SELECT
  status::text,
  version,
  billing_unit_minutes,
  customer_unit_price_minor::text,
  player_unit_payout_minor::text,
  currency,
  so.game_name,
  so.service_name,
  so.region_code
FROM service_catalog_versions scv
JOIN service_offerings so ON so.id = scv.service_offering_id
WHERE scv.id = $1
FOR SHARE
    `,
    [order.serviceCatalogId]
  );
  const catalog = result.rows[0];
  if (!catalog || catalog.status !== 'ACTIVE') {
    throw new OrderError('SERVICE_NOT_AVAILABLE', 'Service catalog item is no longer active.');
  }
  if (catalog.customer_unit_price_minor === null || catalog.player_unit_payout_minor === null) {
    throw new OrderError('SERVICE_NOT_AVAILABLE', 'Service catalog item is missing active pricing.');
  }
  const customerUnitPriceMinor = Number(catalog.customer_unit_price_minor);
  const playerUnitPayoutMinor = Number(catalog.player_unit_payout_minor);
  const unitCount = order.unitCount ?? 0;
  if (
    order.catalogVersion !== catalog.version ||
    order.billingUnitMinutes !== catalog.billing_unit_minutes ||
    order.customerUnitPriceMinor !== customerUnitPriceMinor ||
    order.playerUnitPayoutMinor !== playerUnitPayoutMinor ||
    order.currency !== catalog.currency ||
    order.amountMinor !== customerUnitPriceMinor * unitCount ||
    order.playerEarningMinor !== playerUnitPayoutMinor * unitCount ||
    order.game !== catalog.game_name ||
    order.service !== catalog.service_name ||
    order.region !== catalog.region_code
  ) {
    throw new OrderError('CONFLICT', 'Order price snapshot is stale.');
  }
}

async function sumActiveReservedMinorForCommit(
  client: OrderQueryClient,
  reservation: FundReservationRecord
): Promise<number> {
  const result = await client.query<{ reserved_minor: string }>(
    `
SELECT COALESCE(SUM(amount_minor), 0)::text AS reserved_minor
FROM fund_reservations
WHERE user_id = $1
  AND currency = $2
  AND status = ANY($3::"FundReservationStatus"[])
  AND id <> $4
    `,
    [reservation.userId, reservation.currency, activeFundReservationStatuses, reservation.id]
  );
  return Number(result.rows[0]?.reserved_minor ?? 0);
}

async function readLedgerBalanceForCommit(client: OrderQueryClient, userId: string): Promise<number> {
  const wallet = await client.query<{ id: string }>('SELECT id FROM wallet_accounts WHERE user_id=$1 FOR UPDATE', [userId]);
  if (!wallet.rows[0]) return 0;
  const result = await client.query<{ ledger_balance_minor: string | number | bigint }>(`SELECT COALESCE(SUM(
    CASE WHEN direction='CREDIT' THEN amount_minor ELSE -amount_minor END),0) AS ledger_balance_minor
    FROM wallet_entries WHERE wallet_account_id=$1`, [wallet.rows[0].id]);
  return Number(result.rows[0]?.ledger_balance_minor ?? 0);
}

async function insertFundReservation(client: OrderQueryClient, reservation: FundReservationRecord): Promise<void> {
  await client.query(
    `
INSERT INTO fund_reservations (
  id, user_id, source_type, order_id, gift_request_id, mode, provider, provider_hold_ref,
  amount_minor, currency, status, row_version, idempotency_key,
  expires_at, activated_at, settled_at, created_at, updated_at
)
VALUES (
  $1, $2, $3::"FundReservationSourceType", $4, NULL, $5::"FundReservationMode", $6, $7,
  $8, $9, $10::"FundReservationStatus", $11, $12,
  $13, $14, $15, $16, $17
)
    `,
    [
      reservation.id,
      reservation.userId,
      reservation.sourceType,
      reservation.orderId,
      reservation.mode,
      reservation.provider,
      reservation.providerHoldRef,
      reservation.amountMinor,
      reservation.currency,
      reservation.status,
      reservation.version,
      reservation.idempotencyKey,
      new Date(reservation.expiresAt),
      reservation.activatedAt ? new Date(reservation.activatedAt) : null,
      reservation.settledAt ? new Date(reservation.settledAt) : null,
      new Date(reservation.createdAt),
      new Date(reservation.updatedAt)
    ]
  );
}

async function insertFundReservationEvent(client: OrderQueryClient, event: FundReservationEventRecord): Promise<void> {
  await client.query(
    `
INSERT INTO fund_reservation_events (
  id, fund_reservation_id, sequence, event_type, from_status, to_status,
  amount_minor, reservation_version, idempotency_key,
  actor_user_id, actor_staff_id, actor_source, reason_code, created_at
)
VALUES (
  $1, $2, $3, $4::"FundReservationEventType", $5::"FundReservationStatus", $6::"FundReservationStatus",
  $7, $8, $9,
  $10, $11, $12::"ActorSource", $13, $14
)
    `,
    [
      event.id,
      event.fundReservationId,
      event.sequence,
      event.eventType,
      event.fromStatus,
      event.toStatus,
      event.amountMinor,
      event.reservationVersion,
      event.idempotencyKey,
      event.actorUserId,
      event.actorStaffId,
      event.actorSource,
      event.reasonCode,
      new Date(event.createdAt)
    ]
  );
}

async function insertExternalTransaction(client: OrderQueryClient, transaction: ExternalTransactionMirrorRecord): Promise<void> {
  await client.query(
    `
INSERT INTO external_transactions (
  id, provider, type, user_id, order_id, gift_request_id, fund_reservation_id,
  external_ref, idempotency_key, amount_minor, currency, status, created_at, updated_at
)
VALUES (
  $1, $2, $3::"ExternalTransactionType", $4, $5, NULL, $6,
  $7, $8, $9, $10, $11::"ExternalTransactionStatus", $12, $12
)
    `,
    [
      transaction.id,
      transaction.provider,
      transaction.type,
      transaction.userId,
      transaction.orderId,
      transaction.fundReservationId,
      transaction.externalRef,
      transaction.idempotencyKey,
      transaction.amountMinor,
      transaction.currency,
      transaction.status,
      new Date(transaction.createdAt)
    ]
  );
}

async function insertOrderEvent(client: OrderQueryClient, event: OrderEventRecord): Promise<void> {
  await client.query(
    `
INSERT INTO order_events (
  id, order_id, sequence, event_type, from_status, to_status,
  actor_user_id, actor_staff_id, actor_source, interaction_id, payload, created_at
)
VALUES (
  $1, $2, $3, $4::"OrderEventType", $5::"OrderStatus", $6::"OrderStatus",
  $7, $8, $9::"ActorSource", $10, $11::jsonb, $12
)
    `,
    [
      event.id,
      event.orderId,
      event.sequence,
      event.eventType,
      event.fromStatus,
      event.toStatus,
      event.actorUserId,
      event.actorStaffId,
      event.actorSource,
      event.interactionId,
      JSON.stringify(event.payload ?? {}),
      new Date(event.createdAt)
    ]
  );
}

async function insertAuditRecord(client: OrderQueryClient, record: AuditRecord): Promise<void> {
  await insertPostgresAuditRecord(client, record);
}

function mapOrderRow(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    publicId: row.public_id,
    customerId: row.customer_id,
    guildId: row.guild_id,
    playerId: row.player_id,
    status: row.status,
    version: row.row_version,
    serviceCatalogId: row.service_catalog_version_id,
    catalogVersion: row.catalog_version,
    game: row.game_code_snapshot,
    service: row.service_code_snapshot,
    region: row.region_code_snapshot,
    billingUnitMinutes: row.billing_unit_minutes,
    unitCount: row.unit_count,
    customerUnitPriceMinor: toNullableNumber(row.customer_unit_price_minor),
    playerUnitPayoutMinor: toNullableNumber(row.player_unit_payout_minor),
    amountMinor: Number(row.amount_minor ?? 0),
    playerEarningMinor: Number(row.expected_player_earning_minor ?? 0),
    currency: (row.currency ?? 'CAT') as Currency,
    notes: row.customer_note,
    preferredPlayerDiscordUserIds: preferredPlayerIdsFromSnapshot(row.requirement_snapshot),
    channelSpec: {
      channelId: row.channel_id ?? '',
      panelMessageId: row.panel_message_id ?? '',
      voiceChannelId: row.voice_channel_id
    },
    automationState: row.automation_state,
    automationVersion: row.automation_version,
    automationPausedByStaffId: row.automation_paused_by_staff_id,
    automationStaffTaskId: row.automation_staff_task_id,
    automationReasonCode: row.automation_reason_code,
    automationScope: row.automation_scope,
    automationPausedAt: row.automation_paused_at ? toIsoString(row.automation_paused_at) : null,
    automationResumedAt: row.automation_resumed_at ? toIsoString(row.automation_resumed_at) : null,
    automationExpiresAt: row.automation_expires_at ? toIsoString(row.automation_expires_at) : null,
    completedAt: row.completed_at ? toIsoString(row.completed_at) : null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function preferredPlayerIdsFromSnapshot(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== 'object' || !('preferredPlayerDiscordUserIds' in snapshot)) return [];
  const value = (snapshot as { preferredPlayerDiscordUserIds?: unknown }).preferredPlayerDiscordUserIds;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && isSnowflake(id)).slice(0, 3) : [];
}

function mapFundReservationRow(row: FundReservationRow): FundReservationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    sourceType: row.source_type,
    orderId: row.order_id,
    mode: row.mode,
    provider: row.provider,
    providerHoldRef: row.provider_hold_ref,
    amountMinor: Number(row.amount_minor),
    currency: row.currency as Currency,
    status: row.status,
    version: row.row_version,
    idempotencyKey: row.idempotency_key,
    expiresAt: toIsoString(row.expires_at),
    activatedAt: row.activated_at ? toIsoString(row.activated_at) : null,
    settledAt: row.settled_at ? toIsoString(row.settled_at) : null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function mapCancellationPreviewRow(row: CancellationPreviewRow): CancellationPreviewRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    fundReservationId: row.fund_reservation_id,
    orderVersionSnapshot: row.order_version_snapshot,
    reservationVersionSnapshot: row.reservation_version_snapshot,
    status: row.status,
    disposition: row.disposition,
    releaseAmountMinor: Number(row.release_amount_minor),
    refundAmountMinor: Number(row.refund_amount_minor),
    currency: row.currency as Currency,
    policyKey: row.policy_key,
    policyVersion: row.policy_version,
    reasonCode: row.reason_code,
    requestedByUserId: row.requested_by_user_id,
    requestedByStaffId: row.requested_by_staff_id,
    estimatedResolutionAt: row.estimated_resolution_at ? toIsoString(row.estimated_resolution_at) : null,
    expiresAt: toIsoString(row.expires_at),
    appliedAt: row.applied_at ? toIsoString(row.applied_at) : null,
    invalidatedAt: row.invalidated_at ? toIsoString(row.invalidated_at) : null,
    createdAt: toIsoString(row.created_at)
  };
}

function mapPostgresOrderError(error: unknown): unknown {
  if (error instanceof OrderError) {
    return error;
  }
  if (isDatabaseError(error) && error.code === '23505') {
    return new OrderError('CONFLICT', 'Order conflicts with an existing active order or Discord channel.');
  }
  return error;
}

function inferGuildIdFromOrder(order: OrderRecord): string | null {
  return order.guildId ?? null;
}

interface OrderRow {
  id: string;
  public_id: string;
  customer_id: string;
  guild_id: string | null;
  player_id: string | null;
  status: OrderStatus;
  row_version: number;
  automation_state: 'RUNNING' | 'PAUSED';
  automation_version: number;
  automation_paused_by_staff_id: string | null;
  automation_staff_task_id: string | null;
  automation_reason_code: string | null;
  automation_scope: 'ALL' | 'DISPATCH' | 'LIFECYCLE' | 'CANCELLATION' | null;
  automation_paused_at: Date | string | null;
  automation_resumed_at: Date | string | null;
  automation_expires_at: Date | string | null;
  service_catalog_version_id: string | null;
  catalog_version: number | null;
  game_code_snapshot: string | null;
  service_code_snapshot: string | null;
  region_code_snapshot: string | null;
  billing_unit_minutes: number | null;
  unit_count: number | null;
  customer_unit_price_minor: number | string | bigint | null;
  player_unit_payout_minor: number | string | bigint | null;
  amount_minor: number | string | bigint | null;
  expected_player_earning_minor: number | string | bigint | null;
  currency: string | null;
  customer_note: string | null;
  requirement_snapshot: unknown;
  channel_id: string | null;
  panel_message_id: string | null;
  voice_channel_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

interface FundReservationRow {
  id: string;
  user_id: string;
  source_type: 'ORDER';
  order_id: string;
  mode: FundReservationMode;
  provider: string;
  provider_hold_ref: string | null;
  amount_minor: number | string | bigint;
  currency: string;
  status: FundReservationStatus;
  row_version: number;
  idempotency_key: string;
  expires_at: Date | string;
  activated_at: Date | string | null;
  settled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CancellationPreviewRow {
  id: string;
  order_id: string;
  fund_reservation_id: string | null;
  order_version_snapshot: number;
  reservation_version_snapshot: number | null;
  status: CancellationPreviewRecord['status'];
  disposition: CancellationPreviewRecord['disposition'];
  release_amount_minor: number | string | bigint;
  refund_amount_minor: number | string | bigint;
  currency: string;
  policy_key: string;
  policy_version: number;
  reason_code: string;
  requested_by_user_id: string | null;
  requested_by_staff_id: string | null;
  estimated_resolution_at: Date | string | null;
  expires_at: Date | string;
  applied_at: Date | string | null;
  invalidated_at: Date | string | null;
  created_at: Date | string;
}

function toNullableNumber(value: number | string | bigint | null): number | null {
  return value === null ? null : Number(value);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isDatabaseError(error: unknown): error is { code: string } {
  return Boolean(error && typeof error === 'object' && 'code' in error);
}

function isSnowflake(value: string): boolean {
  return /^[0-9]{17,20}$/.test(value);
}

function isUuid(value: string | null): boolean {
  return Boolean(value?.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
