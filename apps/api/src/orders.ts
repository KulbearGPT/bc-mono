import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import {
  InMemoryAuditSink,
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
import { AdapterError, type Hold, type MockFundingAdapter } from './payment-adapter.js';
import {
  createOrderStaffTask,
  type StaffTaskRecord,
  type StaffTaskStore
} from './staff-tasks.js';

export type OrderFundingAdapter = Pick<MockFundingAdapter, 'getProviderBalance' | 'createHold' | 'getHold' | 'releaseHold'> &
  Partial<Pick<MockFundingAdapter, 'discoverCapabilities'>>;

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
  channelSpec: ChannelSpec;
  createdAt: string;
  updatedAt: string;
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

export interface FundReservationRecord {
  id: string;
  userId: string;
  sourceType: 'ORDER';
  orderId: string;
  mode: FundReservationMode;
  provider: string;
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
  providerHoldReferenceDisplay: string | null;
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
    providerBalanceMinor: number;
    reservedMinor: number;
    availableMinor: number;
    currency: string;
    fetchedAt: string;
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
  providerBalanceMinor: number;
}

export interface PreparedCancelOrderWrite {
  data: CancellationResult;
  order: OrderRecord;
  orderEvent: OrderEventRecord | null;
  expectedVersion: number;
  reservation: FundReservationRecord | null;
  reservationEvent: FundReservationEventRecord | null;
  staffTask: StaffTaskRecord | null;
}

export interface OrderStore {
  findActiveByCustomer(customerId: string): Promise<OrderRecord | null>;
  findById(orderId: string): Promise<OrderRecord | null>;
  findActiveReservationByOrder?(orderId: string): Promise<FundReservationRecord | null>;
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
    providerBalanceMinor: number;
    orderEvent: OrderEventRecord;
    reservation: FundReservationRecord;
    reservationEvent: FundReservationEventRecord;
    externalTransactions: ExternalTransactionMirrorRecord[];
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
  }): Promise<void>;
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
    state: 'RUNNING';
    pausedByStaffId: null;
    reasonCode: null;
    pausedAt: null;
    resumedAt: null;
  };
  playerId: string | null;
  region: string | null;
  notes: string | null;
  channelSpec: ChannelSpec;
  createdAt: string;
  updatedAt: string;
}

export class OrderError extends Error {
  readonly code:
    | 'ACCOUNT_NOT_BOUND'
    | 'BUSINESS_RULE_VIOLATION'
    | 'CONFLICT'
    | 'INSUFFICIENT_AVAILABLE_BALANCE'
    | 'PERMISSION_DENIED'
    | 'PROVIDER_TIMEOUT'
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

  constructor(input: {
    orders?: OrderRecord[];
    events?: OrderEventRecord[];
    reservations?: FundReservationRecord[];
    reservationEvents?: FundReservationEventRecord[];
    externalTransactions?: ExternalTransactionMirrorRecord[];
  } = {}) {
    this.orders = input.orders?.map(clone) ?? [];
    this.events = input.events?.map(clone) ?? [];
    this.reservations = input.reservations?.map(clone) ?? [];
    this.reservationEvents = input.reservationEvents?.map(clone) ?? [];
    this.externalTransactions = input.externalTransactions?.map(clone) ?? [];
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

  async commitSubmit(input: {
    order: OrderRecord;
    expectedVersion: number;
    providerBalanceMinor: number;
    orderEvent: OrderEventRecord;
    reservation: FundReservationRecord;
    reservationEvent: FundReservationEventRecord;
    externalTransactions: ExternalTransactionMirrorRecord[];
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
      providerBalanceMinor: input.providerBalanceMinor,
      activeReservedMinor: sumActiveReservedMinor(this.reservations, input.reservation),
      amountMinor: input.reservation.amountMinor
    });
    this.orders[index] = clone(input.order);
    this.reservations.push(clone(input.reservation));
    this.reservationEvents.push(clone(input.reservationEvent));
    this.externalTransactions.push(...input.externalTransactions.map(clone));
    this.events.push(clone(input.orderEvent));
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
  }): Promise<void> {
    const index = this.orders.findIndex((candidate) => candidate.id === input.order.id);
    const existing = index === -1 ? null : this.orders[index];
    if (!existing) {
      throw new OrderError('RESOURCE_NOT_FOUND', 'Order was not found.');
    }
    if (existing.version !== input.expectedVersion || !['DRAFT', 'PENDING_DISPATCH'].includes(existing.status)) {
      throw new OrderError('CONFLICT', 'Order version is stale.');
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

  async commitSubmit(input: {
    order: OrderRecord;
    expectedVersion: number;
    providerBalanceMinor: number;
    orderEvent: OrderEventRecord;
    reservation: FundReservationRecord;
    reservationEvent: FundReservationEventRecord;
    externalTransactions: ExternalTransactionMirrorRecord[];
    auditRecord: AuditRecord;
    auditSink: AuditSink;
  }): Promise<void> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      await lockUserCurrency(transactionClient, input.reservation.userId, input.reservation.currency);
      await validateCatalogSnapshotForCommit(transactionClient, input.order);
      const activeReservedMinor = await sumActiveReservedMinorForCommit(transactionClient, input.reservation);
      assertCommitAvailableBalance({
        providerBalanceMinor: input.providerBalanceMinor,
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
  }): Promise<void> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      const updated = await updateCancelledOrder(transactionClient, input.order, input.expectedVersion);
      if ((updated.rowCount ?? 0) !== 1) {
        throw new OrderError('CONFLICT', 'Order version is stale.');
      }
      if (input.reservation) {
        const released = await updateReleasedReservation(transactionClient, input.reservation);
        if ((released.rowCount ?? 0) !== 1) {
          throw new OrderError('CONFLICT', 'Order reservation is stale.');
        }
      }
      if (input.reservationEvent) {
        await insertFundReservationEvent(transactionClient, input.reservationEvent);
      }
      await insertOrderEvent(transactionClient, input.orderEvent);
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
  providerBalanceMinor: number;
  activeReservedMinor: number;
  amountMinor: number;
}): void {
  if (input.providerBalanceMinor - input.activeReservedMinor < input.amountMinor) {
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
    providerBalanceMinor: prepared.providerBalanceMinor
  };
}

function releaseSubmitHoldAfterCommitFailure(input: {
  fundingAdapter: OrderFundingAdapter;
  prepared: PreparedSubmitOrderWrite;
  reasonCode: string;
}): void {
  const holdRef = input.prepared.reservation.providerHoldRef;
  if (!holdRef) {
    return;
  }
  input.fundingAdapter.releaseHold({
    holdRef,
    idempotencyKey: `${input.prepared.reservation.id}:release-after-commit-failure`,
    fundReservationId: input.prepared.reservation.id,
    fundReservationVersion: input.prepared.reservation.version,
    reasonCode: input.reasonCode
  });
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
  return toApiOrder(order);
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
      sequence: 1,
      payload: {
        serviceCatalogId: updated.serviceCatalogId,
        catalogVersion: updated.catalogVersion,
        unitCount: updated.unitCount,
        amountMinor: updated.amountMinor,
        currency: updated.currency
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
  fundingAdapter: OrderFundingAdapter;
  providerKey: string;
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

  const providerBalance = input.fundingAdapter.getProviderBalance({ externalUserId: binding.externalUserId });
  if (providerBalance.currency !== order.currency) {
    throw new OrderError('VALIDATION_ERROR', 'Provider balance currency does not match order currency.');
  }
  const reservedMinor = await input.accountStore.sumActiveReservations({
    userId: binding.userId,
    currency: order.currency
  });
  const availableMinor = providerBalance.providerBalanceMinor - reservedMinor;
  if (availableMinor < order.amountMinor) {
    throw new OrderError('INSUFFICIENT_AVAILABLE_BALANCE', 'Available balance is insufficient.');
  }

  const reservationMode = resolveFundReservationMode(input.fundingAdapter);
  const reservation = buildOrderReservation({
    order,
    binding,
    providerKey: input.providerKey,
    mode: reservationMode,
    idempotencyKey: input.idempotencyKey,
    now: input.now
  });
  const hold = reservationMode === 'PROVIDER_NATIVE_HOLD'
    ? createOrderProviderHold({
        fundingAdapter: input.fundingAdapter,
        reservation,
        binding,
        order,
        idempotencyKey: input.idempotencyKey
      })
    : null;

  const activatedReservation: FundReservationRecord = {
    ...reservation,
    status: 'ACTIVE',
    providerHoldRef: hold?.holdRef ?? null,
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
        providerBalanceMinor: providerBalance.providerBalanceMinor,
        reservedMinor: reservedMinor + activatedReservation.amountMinor,
        availableMinor: providerBalance.providerBalanceMinor - reservedMinor - activatedReservation.amountMinor,
        currency: providerBalance.currency,
        fetchedAt: providerBalance.fetchedAt
      }
    },
    order: submittedOrder,
    orderEvent,
    reservation: activatedReservation,
    reservationEvent,
    providerBalanceMinor: providerBalance.providerBalanceMinor,
    externalTransactions: []
  };
}

export async function prepareCancelOrder(input: {
  accountStore: AccountStore;
  orderStore: OrderStore;
  fundingAdapter: OrderFundingAdapter;
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
  if (order.version !== input.input.expectedVersion) {
    throw new OrderError('CONFLICT', 'Order version is stale.');
  }
  if (['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION'].includes(order.status)) {
    if (!input.staffTaskStore) {
      throw new OrderError('BUSINESS_RULE_VIOLATION', 'Staff task store is not configured.');
    }
    const staffTask = await createOrderStaffTask({
      store: input.staffTaskStore,
      order,
      type: 'CANCELLATION_ASSIST',
      reasonCode: 'CUSTOMER_CANCEL_AFTER_ACCEPT',
      note: input.input.note ?? null,
      voiceChannelId: order.channelSpec.voiceChannelId,
      actor: input.actor,
      now: input.now
    });
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
      staffTask
    };
  }
  if (!['DRAFT', 'PENDING_DISPATCH'].includes(order.status)) {
    throw new OrderError('CONFLICT', 'Order cannot be cancelled automatically.');
  }
  const reservation = order.status === 'PENDING_DISPATCH'
    ? await input.orderStore.findActiveReservationByOrder?.(order.id) ?? null
    : null;
  if (order.status === 'PENDING_DISPATCH' && !reservation) {
    throw new OrderError('CONFLICT', 'Order reservation is not active.');
  }

  const releasedReservation = reservation
    ? releaseOrderReservation({
        fundingAdapter: input.fundingAdapter,
        reservation,
        idempotencyKey: input.idempotencyKey,
        reasonCode: input.input.reasonCode,
        now: input.now
      })
    : null;
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
        reasonCode: input.input.reasonCode
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
    staffTask: null
  };
}

export function registerOrderRoutes(
  server: FastifyInstance,
  options: {
    accountStore: AccountStore;
    catalogStore: ServiceCatalogStore;
    orderStore: OrderStore;
    fundingAdapter?: OrderFundingAdapter;
    staffTaskStore?: StaffTaskStore;
    providerKey?: string;
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
      if (!options.fundingAdapter || !options.providerKey) {
        throw new OrderError('BUSINESS_RULE_VIOLATION', 'Funding adapter is not configured.');
      }
      const fundingAdapter = options.fundingAdapter;
      const providerKey = options.providerKey;
      const prepared = await prepareSubmitOrder({
        accountStore: options.accountStore,
        catalogStore: options.catalogStore,
        orderStore: options.orderStore,
        fundingAdapter,
        providerKey,
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
              providerBalanceMinor: prepared.providerBalanceMinor,
              orderEvent: prepared.orderEvent,
              reservation: prepared.reservation,
              reservationEvent: prepared.reservationEvent,
              externalTransactions: prepared.externalTransactions,
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
          } catch (error) {
            releaseSubmitHoldAfterCommitFailure({
              fundingAdapter,
              prepared,
              reasonCode: mapOrderError(error)?.code ?? 'COMMIT_FAILED'
            });
            throw error;
          }
        }
      };
    },
    mapError: mapOrderError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/orders/:orderId/cancel',
    permission: 'order.cancel',
    action: 'CANCEL_ORDER',
    targetType: 'order',
    targetId: (request) => readParams(request).orderId ?? '00000000-0000-0000-0000-000000000000',
    handler: async (request, actor) => {
      if (!options.fundingAdapter) {
        throw new OrderError('BUSINESS_RULE_VIOLATION', 'Funding adapter is not configured.');
      }
      const prepared = await prepareCancelOrder({
        accountStore: options.accountStore,
        orderStore: options.orderStore,
        fundingAdapter: options.fundingAdapter,
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
            auditSink
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
    currency: 'CNY',
    notes: null,
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

function toApiOrder(order: OrderRecord, reservation: FundReservationRecord | null = null): OrderApiRecord {
  return {
    id: order.id,
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
      state: 'RUNNING',
      pausedByStaffId: null,
      reasonCode: null,
      pausedAt: null,
      resumedAt: null
    },
    playerId: order.playerId,
    region: order.region,
    notes: order.notes,
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
    providerHoldReferenceDisplay: reservation.providerHoldRef ? maskProviderReference(reservation.providerHoldRef) : null,
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

function releaseOrderReservation(input: {
  fundingAdapter: OrderFundingAdapter;
  reservation: FundReservationRecord;
  idempotencyKey: string;
  reasonCode: string;
  now: Date;
}): FundReservationRecord {
  if (input.reservation.mode === 'PROVIDER_NATIVE_HOLD') {
    if (!input.reservation.providerHoldRef) {
      throw new OrderError('CONFLICT', 'Provider hold reference is missing.');
    }
    try {
      input.fundingAdapter.releaseHold({
        holdRef: input.reservation.providerHoldRef,
        idempotencyKey: input.idempotencyKey,
        fundReservationId: input.reservation.id,
        fundReservationVersion: input.reservation.version,
        reasonCode: input.reasonCode,
        amount: { amountMinor: input.reservation.amountMinor, currency: input.reservation.currency }
      });
    } catch (error) {
      throw mapAdapterOrderError(error);
    }
  }
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

function createOrderProviderHold(input: {
  fundingAdapter: OrderFundingAdapter;
  reservation: FundReservationRecord;
  binding: AccountBindingRecord;
  order: OrderRecord;
  idempotencyKey: string;
}): Hold {
  let hold: Hold;
  try {
    hold = input.fundingAdapter.createHold({
      idempotencyKey: input.idempotencyKey,
      fundReservationId: input.reservation.id,
      fundReservationVersion: input.reservation.version,
      externalUserId: input.binding.externalUserId,
      amount: { amountMinor: input.order.amountMinor, currency: input.order.currency },
      businessSource: 'ORDER',
      businessReference: input.order.id,
      expiresAt: input.reservation.expiresAt
    });
  } catch (error) {
    hold = recoverTimedOutHold({
      error,
      fundingAdapter: input.fundingAdapter,
      reservation: input.reservation,
      binding: input.binding,
      order: input.order,
      idempotencyKey: input.idempotencyKey
    });
  }
  validateRecoveredHold({
    hold,
    reservation: input.reservation,
    binding: input.binding,
    order: input.order,
    idempotencyKey: input.idempotencyKey
  });
  return hold;
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
}): FundReservationEventRecord {
  return {
    id: crypto.randomUUID(),
    fundReservationId: input.reservation.id,
    sequence: 1,
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

function mapAdapterOrderError(error: unknown): OrderError {
  if (error instanceof AdapterError) {
    if (error.code === 'INSUFFICIENT_FUNDS') {
      return new OrderError('INSUFFICIENT_AVAILABLE_BALANCE', error.message);
    }
    if (error.code === 'PROVIDER_TIMEOUT') {
      return new OrderError('PROVIDER_TIMEOUT', error.message);
    }
    if (error.code === 'IDEMPOTENCY_CONFLICT' || error.code === 'RESERVATION_CONFLICT') {
      return new OrderError('CONFLICT', error.message);
    }
    return new OrderError('VALIDATION_ERROR', error.message);
  }
  if (error instanceof OrderError) {
    return error;
  }
  return new OrderError('BUSINESS_RULE_VIOLATION', 'Funding adapter failed.');
}

function recoverTimedOutHold(input: {
  error: unknown;
  fundingAdapter: OrderFundingAdapter;
  reservation: FundReservationRecord;
  binding: AccountBindingRecord;
  order: OrderRecord;
  idempotencyKey: string;
}): Hold {
  if (!(input.error instanceof AdapterError) || input.error.code !== 'PROVIDER_TIMEOUT') {
    throw mapAdapterOrderError(input.error);
  }

  let hold: Hold;
  try {
    hold = input.fundingAdapter.getHold({
      lookupType: 'IDEMPOTENCY_KEY',
      lookupValue: input.idempotencyKey
    });
  } catch {
    throw mapAdapterOrderError(input.error);
  }

  validateRecoveredHold({
    hold,
    reservation: input.reservation,
    binding: input.binding,
    order: input.order,
    idempotencyKey: input.idempotencyKey
  });
  return hold;
}

function validateRecoveredHold(input: {
  hold: Hold;
  reservation: FundReservationRecord;
  binding: AccountBindingRecord;
  order: OrderRecord;
  idempotencyKey: string;
}): void {
  const { hold, reservation, binding, order, idempotencyKey } = input;
  if (
    hold.idempotencyKey !== idempotencyKey ||
    hold.fundReservationId !== reservation.id ||
    hold.fundReservationVersion !== reservation.version ||
    hold.externalUserId !== binding.externalUserId ||
    hold.businessSource !== 'ORDER' ||
    hold.businessReference !== order.id ||
    hold.amount.amountMinor !== order.amountMinor ||
    hold.amount.currency !== order.currency ||
    hold.status !== 'ACTIVE' ||
    !hold.holdRef
  ) {
    throw new OrderError('CONFLICT', 'Recovered provider hold does not match the order reservation.');
  }
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function maskProviderReference(value: string): string {
  if (value.length <= 8) {
    return '***';
  }
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
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
    CONFLICT: 409,
    INSUFFICIENT_AVAILABLE_BALANCE: 422,
    PERMISSION_DENIED: 403,
    PROVIDER_TIMEOUT: 504,
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
    updated_at = $19
WHERE id = $1
  AND status = 'DRAFT'
  AND row_version = $20
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
      new Date(order.updatedAt),
      expectedVersion
    ]
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

async function updateReleasedReservation(
  client: OrderQueryClient,
  reservation: FundReservationRecord
): Promise<{ rowCount?: number | null }> {
  return client.query(
    `
UPDATE fund_reservations
SET status = $2::"FundReservationStatus",
    row_version = $3,
    settled_at = $4,
    updated_at = $5
WHERE id = $1
  AND status = ANY($7::"FundReservationStatus"[])
  AND row_version = $6
    `,
    [
      reservation.id,
      reservation.status,
      reservation.version,
      reservation.settledAt ? new Date(reservation.settledAt) : null,
      new Date(reservation.updatedAt),
      reservation.version - 1,
      activeFundReservationStatuses
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
  await client.query(
    `
INSERT INTO audit_logs (
  id, actor_user_id, actor_staff_id, actor_level, actor_source, client_id,
  interaction_id, permission_code, action, target_type, target_id, outcome,
  before_snapshot, after_snapshot, reason, request_id, approval_request_id, created_at
)
VALUES (
  $1, $2, $3, $4::"StaffLevel", $5::"ActorSource", $6,
  $7, $8, $9, $10, $11, $12::"AuditOutcome",
  $13::jsonb, $14::jsonb, $15, $16, $17, $18
)
    `,
    [
      record.id,
      isUuid(record.actorId) ? record.actorId : null,
      record.actorStaffId,
      record.actorLevel,
      record.actorSource,
      record.clientId,
      record.interactionId,
      record.permissionCode,
      record.action,
      record.targetType,
      record.targetId,
      record.outcome,
      record.beforeSnapshot ? JSON.stringify(record.beforeSnapshot) : null,
      record.afterSnapshot ? JSON.stringify(record.afterSnapshot) : null,
      record.reason,
      record.requestId,
      record.approvalRequestId,
      new Date(record.occurredAt)
    ]
  );
}

function mapOrderRow(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    publicId: row.public_id,
    customerId: row.customer_id,
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
    currency: (row.currency ?? 'CNY') as Currency,
    notes: row.customer_note,
    channelSpec: {
      channelId: row.channel_id ?? '',
      panelMessageId: row.panel_message_id ?? '',
      voiceChannelId: row.voice_channel_id
    },
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
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

function mapPostgresOrderError(error: unknown): unknown {
  if (error instanceof OrderError) {
    return error;
  }
  if (isDatabaseError(error) && error.code === '23505') {
    return new OrderError('CONFLICT', 'Order conflicts with an existing active order or Discord channel.');
  }
  return error;
}

function inferGuildIdFromOrder(_order: OrderRecord): string | null {
  return null;
}

interface OrderRow {
  id: string;
  public_id: string;
  customer_id: string;
  player_id: string | null;
  status: OrderStatus;
  row_version: number;
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
  channel_id: string | null;
  panel_message_id: string | null;
  voice_channel_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
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
