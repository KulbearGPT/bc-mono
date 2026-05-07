import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AccountStore } from './accounts.js';
import { buildFundReservationDraft, resolveFundReservationMode, type FundReservationDraft } from './funding.js';
import type { OrderRecord, OrderStore, OrderFundingAdapter } from './orders.js';
import { AdapterError, type MockFundingAdapter } from './payment-adapter.js';
import {
  registerSecureReadRoute,
  registerSecureWriteRoute,
  InMemoryAuditSink,
  type ActorContext,
  type AuditRecord,
  type AuditSink
} from './security.js';

export type GiftCatalogStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

export interface GiftCatalogRecord {
  id: string;
  itemId: string;
  code: string;
  version: number;
  status: GiftCatalogStatus;
  name: string;
  priceMinor: number;
  currency: string;
  broadcastTemplate: string;
}

export interface GiftRequestRecord {
  id: string;
  publicId: string;
  orderId: string;
  giftCatalogVersionId: string;
  senderId: string;
  receiverId: string;
  status: 'PENDING_REVIEW';
  version: number;
  giftCodeSnapshot: string;
  giftNameSnapshot: string;
  priceMinor: number;
  currency: string;
  broadcastTemplateSnapshot: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface GiftStaffTaskRecord {
  id: string;
  publicId: string;
  type: 'GIFT_REVIEW';
  reasonCode: 'GIFT_REQUESTED';
  status: 'OPEN';
  version: number;
  orderId: string;
  giftRequestId: string;
  voiceChannelId: string | null;
  contextSnapshot: {
    orderId: string;
    orderPublicId: string;
    channelId: string;
    voiceChannelId: string | null;
    senderId: string;
    receiverId: string;
    giftCode: string;
    giftName: string;
    priceMinor: number;
    currency: string;
    reservationId: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface GiftReservationRecord extends FundReservationDraft {
  sourceType: 'GIFT';
  orderId: null;
  giftRequestId: string;
}

export interface GiftStore {
  listActiveCatalog(): Promise<GiftCatalogRecord[]> | GiftCatalogRecord[];
  findCatalogVersion(id: string): Promise<GiftCatalogRecord | null> | GiftCatalogRecord | null;
  commitCreate(input: {
    request: GiftRequestRecord;
    reservation: GiftReservationRecord;
    staffTask: GiftStaffTaskRecord;
    providerBalanceMinor: number;
    expectedOrderVersion: number;
    now: Date;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
  }): Promise<void> | void;
}

export class GiftError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'PERMISSION_DENIED'
    | 'VALIDATION_ERROR'
    | 'CONFLICT'
    | 'GIFT_WINDOW_CLOSED'
    | 'GIFT_NOT_AVAILABLE'
    | 'INSUFFICIENT_AVAILABLE_BALANCE';

  constructor(code: GiftError['code'], message: string) {
    super(message);
    this.name = 'GiftError';
    this.code = code;
  }
}

export class InMemoryGiftStore implements GiftStore {
  readonly catalog: GiftCatalogRecord[];
  readonly requests: GiftRequestRecord[];
  readonly reservations: GiftReservationRecord[];
  readonly staffTasks: GiftStaffTaskRecord[];
  readonly captures: unknown[] = [];
  readonly broadcasts: unknown[] = [];

  constructor(input: {
    catalog?: GiftCatalogRecord[];
    requests?: GiftRequestRecord[];
    reservations?: GiftReservationRecord[];
    staffTasks?: GiftStaffTaskRecord[];
  } = {}) {
    this.catalog = clone(input.catalog ?? []);
    this.requests = clone(input.requests ?? []);
    this.reservations = clone(input.reservations ?? []);
    this.staffTasks = clone(input.staffTasks ?? []);
  }

  listActiveCatalog(): GiftCatalogRecord[] {
    return clone(this.catalog.filter((item) => item.status === 'ACTIVE'));
  }

  findCatalogVersion(id: string): GiftCatalogRecord | null {
    const item = this.catalog.find((candidate) => candidate.id === id);
    return item ? clone(item) : null;
  }

  async commitCreate(input: {
    request: GiftRequestRecord;
    reservation: GiftReservationRecord;
    staffTask: GiftStaffTaskRecord;
    providerBalanceMinor: number;
    expectedOrderVersion: number;
    now: Date;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
  }): Promise<void> {
    if (this.requests.some((request) => request.id === input.request.id)) return;
    const activeReservedMinor = this.reservations
      .filter((reservation) => reservation.userId === input.request.senderId && reservation.currency === input.request.currency && ['PENDING', 'ACTIVE', 'DISPUTED', 'PARTIALLY_SETTLED'].includes(reservation.status))
      .reduce((sum, reservation) => sum + reservation.amountMinor, 0);
    if (input.providerBalanceMinor - activeReservedMinor < input.request.priceMinor) {
      throw new GiftError('INSUFFICIENT_AVAILABLE_BALANCE', 'Available balance is insufficient.');
    }
    this.requests.push(clone(input.request));
    this.reservations.push(clone(input.reservation));
    this.staffTasks.push(clone(input.staffTask));
    await input.auditSink.append(input.auditRecord);
  }
}

export class PostgresGiftStore implements GiftStore {
  constructor(private readonly pool: Pool) {}

  async listActiveCatalog(): Promise<GiftCatalogRecord[]> {
    const result = await this.pool.query<GiftCatalogRow>(`
SELECT versions.id, versions.gift_catalog_item_id, items.code, versions.version, versions.status,
       versions.name, versions.price_minor, versions.currency, versions.broadcast_template
FROM gift_catalog_versions versions
JOIN gift_catalog_items items ON items.id = versions.gift_catalog_item_id
WHERE versions.status = 'ACTIVE' AND items.archived_at IS NULL
ORDER BY versions.price_minor, items.code`);
    return result.rows.map(mapGiftCatalogRow);
  }

  async findCatalogVersion(id: string): Promise<GiftCatalogRecord | null> {
    const result = await this.pool.query<GiftCatalogRow>(`
SELECT versions.id, versions.gift_catalog_item_id, items.code, versions.version, versions.status,
       versions.name, versions.price_minor, versions.currency, versions.broadcast_template
FROM gift_catalog_versions versions
JOIN gift_catalog_items items ON items.id = versions.gift_catalog_item_id
WHERE versions.id = $1`, [id]);
    return result.rows[0] ? mapGiftCatalogRow(result.rows[0]) : null;
  }

  async commitCreate(input: {
    request: GiftRequestRecord;
    reservation: GiftReservationRecord;
    staffTask: GiftStaffTaskRecord;
    providerBalanceMinor: number;
    expectedOrderVersion: number;
    now: Date;
    auditRecord: AuditRecord;
    auditSink: AuditSink;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${input.request.senderId}:${input.request.currency}`]);
      const order = await client.query<{ customer_id: string; player_id: string | null; status: string; completed_at: Date | null; row_version: number }>(
        `SELECT customer_id, player_id, status, completed_at, row_version FROM orders WHERE id = $1 FOR UPDATE`,
        [input.request.orderId]
      );
      const currentOrder = order.rows[0];
      const completedWithinWindow = currentOrder?.status === 'COMPLETED' && currentOrder.completed_at
        && input.now.getTime() - currentOrder.completed_at.getTime() <= 24 * 60 * 60_000;
      if (!currentOrder || currentOrder.customer_id !== input.request.senderId || currentOrder.player_id !== input.request.receiverId
        || currentOrder.row_version !== input.expectedOrderVersion
        || (!['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION'].includes(currentOrder.status) && !completedWithinWindow)) {
        throw new GiftError('CONFLICT', 'Order changed; refresh before retrying.');
      }
      const catalog = await client.query<{ status: string }>(`SELECT status FROM gift_catalog_versions WHERE id = $1 FOR SHARE`, [input.request.giftCatalogVersionId]);
      if (catalog.rows[0]?.status !== 'ACTIVE') throw new GiftError('GIFT_NOT_AVAILABLE', 'Gift is not available.');
      const reserved = await client.query<{ amount: string }>(`
SELECT COALESCE(SUM(amount_minor), 0)::text AS amount FROM fund_reservations
WHERE user_id = $1 AND currency = $2
AND status = ANY($3::"FundReservationStatus"[])`, [input.request.senderId, input.request.currency, ['PENDING', 'ACTIVE', 'DISPUTED', 'PARTIALLY_SETTLED']]);
      if (input.providerBalanceMinor - Number(reserved.rows[0]?.amount ?? 0) < input.request.priceMinor) {
        throw new GiftError('INSUFFICIENT_AVAILABLE_BALANCE', 'Available balance is insufficient.');
      }
      await client.query(`INSERT INTO gift_requests (
        id, public_id, order_id, gift_catalog_version_id, sender_id, receiver_id, status, row_version,
        gift_code_snapshot, gift_name_snapshot, price_minor, currency, broadcast_template_snapshot,
        expires_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,'PENDING_REVIEW',1,$7,$8,$9,$10,$11,$12,$13,$13)`, [
        input.request.id, input.request.publicId, input.request.orderId, input.request.giftCatalogVersionId,
        input.request.senderId, input.request.receiverId, input.request.giftCodeSnapshot, input.request.giftNameSnapshot,
        input.request.priceMinor, input.request.currency, input.request.broadcastTemplateSnapshot,
        new Date(input.request.expiresAt), new Date(input.request.createdAt)
      ]);
      await client.query(`INSERT INTO fund_reservations (
        id,user_id,source_type,order_id,gift_request_id,mode,provider,provider_hold_ref,amount_minor,currency,
        status,row_version,idempotency_key,expires_at,activated_at,created_at,updated_at
      ) VALUES ($1,$2,'GIFT',NULL,$3,$4,$5,$6,$7,$8,'PENDING',1,$9,$10,NULL,$11,$11)`, [
        input.reservation.id, input.reservation.userId, input.request.id, input.reservation.mode,
        input.reservation.provider, input.reservation.providerHoldRef, input.reservation.amountMinor,
        input.reservation.currency, input.reservation.idempotencyKey, new Date(input.reservation.expiresAt),
        new Date(input.reservation.activatedAt ?? input.reservation.createdAt)
      ]);
      await client.query(`INSERT INTO fund_reservation_events (
        id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,
        idempotency_key,actor_user_id,actor_source,created_at
      ) VALUES ($1,$2,1,'CREATED',NULL,'PENDING',$3,1,$4,$5,'DISCORD_BOT',$6)`, [
        crypto.randomUUID(), input.reservation.id, input.reservation.amountMinor,
        `${input.reservation.idempotencyKey}:created`, input.request.senderId, new Date(input.request.createdAt)
      ]);
      await client.query(`INSERT INTO fund_reservation_events (
        id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,
        idempotency_key,actor_user_id,actor_source,created_at
      ) VALUES ($1,$2,2,'ACTIVATED','PENDING','ACTIVE',0,2,$3,$4,'DISCORD_BOT',$5)`, [
        crypto.randomUUID(), input.reservation.id, `${input.reservation.idempotencyKey}:activated`,
        input.request.senderId, new Date(input.request.createdAt)
      ]);
      await client.query(`INSERT INTO staff_tasks (
        id,public_id,type,reason_code,status,row_version,order_id,gift_request_id,voice_channel_id,
        context_snapshot,created_at,updated_at
      ) VALUES ($1,$2,'GIFT_REVIEW','GIFT_REQUESTED','OPEN',1,$3,$4,$5,$6::jsonb,$7,$7)`, [
        input.staffTask.id, input.staffTask.publicId, input.staffTask.orderId, input.staffTask.giftRequestId,
        input.staffTask.voiceChannelId, JSON.stringify(input.staffTask.contextSnapshot), new Date(input.staffTask.createdAt)
      ]);
      await client.query('COMMIT');
      await input.auditSink.append(input.auditRecord);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export function registerGiftRoutes(server: FastifyInstance, options: {
  store: GiftStore;
  orderStore: OrderStore;
  accountStore: AccountStore;
  fundingAdapter: Pick<MockFundingAdapter, 'getProviderBalance'> & OrderFundingAdapter;
  providerKey: string;
  now?: () => Date;
}): void {
  if (!server.securityOptions) throw new Error('Gift routes require security options.');
  const security = server.securityOptions;
  const auditSink = security.auditSink ?? new InMemoryAuditSink();
  const now = options.now ?? (() => new Date());

  registerSecureReadRoute(server, security, {
    method: 'GET', url: '/api/v1/gifts', permission: 'gift.request', action: 'LIST_GIFTS', targetType: 'gift_catalog',
    acceptedSources: ['DISCORD_BOT', 'DASHBOARD'],
    handler: async (request, actor) => listGifts({ ...options, actor, orderId: giftOrderIdQuery(request), now: now() }),
    mapError: mapGiftError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/orders/:orderId/gift-requests', permission: 'gift.request',
    action: 'CREATE_GIFT_REQUEST', targetType: 'order', targetId: giftOrderIdParam,
    acceptedSources: ['DISCORD_BOT', 'DASHBOARD'],
    successStatusCode: 201,
    handler: async (request, actor) => prepareGiftRequest({
      ...options, actor, orderId: giftOrderIdParam(request), body: parseGiftRequestBody(request.body),
      idempotencyKey: request.headers['idempotency-key'] as string, auditSink, now: now()
    }),
    fingerprintBody: (request) => parseGiftRequestBody(request.body), mapError: mapGiftError
  });
}

export async function listGifts(input: {
  store: GiftStore; orderStore: OrderStore; accountStore: AccountStore;
  fundingAdapter: Pick<MockFundingAdapter, 'getProviderBalance'>; actor: ActorContext; orderId: string; now: Date;
}) {
  const binding = await requireBinding(input.accountStore, input.actor);
  const order = await requireEligibleOrder(input.orderStore, input.orderId, binding.userId, input.now);
  const providerBalance = input.fundingAdapter.getProviderBalance({ externalUserId: binding.externalUserId });
  const reservedMinor = await input.accountStore.sumActiveReservations({ userId: binding.userId, currency: providerBalance.currency });
  const availableMinor = Math.max(0, providerBalance.providerBalanceMinor - reservedMinor);
  const items = (await input.store.listActiveCatalog()).filter((item) => item.currency === providerBalance.currency);
  return {
    orderId: order.id, orderPublicId: order.publicId, receiver: { userId: order.playerId },
    balance: { providerBalanceMinor: providerBalance.providerBalanceMinor, reservedMinor, availableMinor, currency: providerBalance.currency, fetchedAt: providerBalance.fetchedAt },
    items: items.map((item) => ({ id: item.id, code: item.code, name: item.name, priceMinor: item.priceMinor, currency: item.currency, affordable: item.priceMinor <= availableMinor }))
  };
}

async function prepareGiftRequest(input: {
  store: GiftStore; orderStore: OrderStore; accountStore: AccountStore;
  fundingAdapter: Pick<MockFundingAdapter, 'getProviderBalance' | 'createHold'> & Partial<Pick<MockFundingAdapter, 'discoverCapabilities'>>;
  providerKey: string; actor: ActorContext; orderId: string;
  auditSink: AuditSink;
  body: { expectedOrderVersion: number; giftCatalogVersionId: string; receiverId?: string };
  idempotencyKey: string; now: Date;
}) {
  const binding = await requireBinding(input.accountStore, input.actor);
  const order = await requireEligibleOrder(input.orderStore, input.orderId, binding.userId, input.now);
  if (order.version !== input.body.expectedOrderVersion) throw new GiftError('CONFLICT', 'Order changed; refresh before retrying.');
  const catalog = await input.store.findCatalogVersion(input.body.giftCatalogVersionId);
  if (!catalog || catalog.status !== 'ACTIVE') throw new GiftError('GIFT_NOT_AVAILABLE', 'Gift is not available.');
  const providerBalance = input.fundingAdapter.getProviderBalance({ externalUserId: binding.externalUserId });
  if (providerBalance.currency !== catalog.currency) throw new GiftError('VALIDATION_ERROR', 'Gift currency does not match the account.');
  const reservedMinor = await input.accountStore.sumActiveReservations({ userId: binding.userId, currency: catalog.currency });
  if (providerBalance.providerBalanceMinor - reservedMinor < catalog.priceMinor) {
    throw new GiftError('INSUFFICIENT_AVAILABLE_BALANCE', 'Available balance is insufficient.');
  }

  const requestId = deterministicUuid(`gift-request:${binding.userId}:${order.id}:${input.idempotencyKey}`);
  const expiresAt = new Date(input.now.getTime() + 30 * 60_000).toISOString();
  const request: GiftRequestRecord = {
    id: requestId, publicId: `G-${requestId.slice(0, 8).toUpperCase()}`, orderId: order.id,
    giftCatalogVersionId: catalog.id, senderId: binding.userId, receiverId: order.playerId!,
    status: 'PENDING_REVIEW', version: 1, giftCodeSnapshot: catalog.code, giftNameSnapshot: catalog.name,
    priceMinor: catalog.priceMinor, currency: catalog.currency, broadcastTemplateSnapshot: catalog.broadcastTemplate,
    expiresAt, createdAt: input.now.toISOString(), updatedAt: input.now.toISOString()
  };
  const mode = resolveFundReservationMode(input.fundingAdapter);
  const draft = buildFundReservationDraft({
    businessSource: { type: 'GIFT', referenceId: request.id }, userId: binding.userId,
    provider: input.providerKey, mode, amountMinor: catalog.priceMinor, currency: catalog.currency,
    idempotencyKey: input.idempotencyKey, ttlMinutes: 30, now: input.now
  });
  const hold = mode === 'PROVIDER_NATIVE_HOLD' ? input.fundingAdapter.createHold({
    idempotencyKey: input.idempotencyKey, fundReservationId: draft.id, fundReservationVersion: draft.version,
    externalUserId: binding.externalUserId, amount: { amountMinor: catalog.priceMinor, currency: catalog.currency },
    businessSource: 'GIFT', businessReference: request.id, expiresAt,
    metadata: { orderId: order.id, giftCode: catalog.code }
  }) : null;
  const reservation: GiftReservationRecord = {
    ...draft, sourceType: 'GIFT', orderId: null, giftRequestId: request.id,
    status: 'ACTIVE', version: 2, providerHoldRef: hold?.holdRef ?? null, activatedAt: input.now.toISOString()
  };
  const task: GiftStaffTaskRecord = {
    id: deterministicUuid(`gift-task:${request.id}`), publicId: `T-GIFT-${request.publicId.slice(2)}`,
    type: 'GIFT_REVIEW', reasonCode: 'GIFT_REQUESTED', status: 'OPEN', version: 1,
    orderId: order.id, giftRequestId: request.id, voiceChannelId: order.channelSpec.voiceChannelId,
    contextSnapshot: {
      orderId: order.id, orderPublicId: order.publicId, channelId: order.channelSpec.channelId,
      voiceChannelId: order.channelSpec.voiceChannelId, senderId: binding.userId, receiverId: order.playerId!,
      giftCode: catalog.code, giftName: catalog.name, priceMinor: catalog.priceMinor,
      currency: catalog.currency, reservationId: reservation.id
    },
    createdAt: input.now.toISOString(), updatedAt: input.now.toISOString()
  };
  return {
    data: toGiftRequestResult(request, reservation, task, providerBalance, reservedMinor), statusCode: 201,
    commit: (auditRecord: AuditRecord) => input.store.commitCreate({
      request, reservation, staffTask: task, providerBalanceMinor: providerBalance.providerBalanceMinor,
      expectedOrderVersion: input.body.expectedOrderVersion, now: input.now,
      auditRecord, auditSink: input.auditSink
    })
  };
}

function toGiftRequestResult(request: GiftRequestRecord, reservation: GiftReservationRecord, task: GiftStaffTaskRecord,
  providerBalance: { providerBalanceMinor: number; currency: string; fetchedAt: string }, priorReservedMinor: number) {
  return {
    id: request.id, publicId: request.publicId, orderId: request.orderId, senderId: request.senderId,
    receiverId: request.receiverId, status: request.status, expiresAt: request.expiresAt,
    gift: { code: request.giftCodeSnapshot, name: request.giftNameSnapshot, priceMinor: request.priceMinor, currency: request.currency },
    reservation: { id: reservation.id, sourceType: reservation.sourceType, status: reservation.status, amountMinor: reservation.amountMinor, currency: reservation.currency, expiresAt: reservation.expiresAt },
    staffTask: { id: task.id, publicId: task.publicId, type: task.type, status: task.status },
    balance: { providerBalanceMinor: providerBalance.providerBalanceMinor, reservedMinor: priorReservedMinor + request.priceMinor,
      availableMinor: providerBalance.providerBalanceMinor - priorReservedMinor - request.priceMinor,
      currency: providerBalance.currency, fetchedAt: providerBalance.fetchedAt }
  };
}

async function requireBinding(store: AccountStore, actor: ActorContext) {
  if (!actor.guildId || !actor.discordUserId) throw new GiftError('PERMISSION_DENIED', 'A bound customer is required.');
  const binding = await store.findByDiscord({ guildId: actor.guildId, discordUserId: actor.discordUserId });
  if (!binding) throw new GiftError('PERMISSION_DENIED', 'A bound customer is required.');
  return binding;
}

async function requireEligibleOrder(store: OrderStore, orderId: string, customerId: string, now: Date): Promise<OrderRecord> {
  const order = await store.findById(orderId);
  if (!order || order.customerId !== customerId) throw new GiftError('NOT_FOUND', 'Order was not found.');
  if (!order.playerId) throw new GiftError('GIFT_WINDOW_CLOSED', 'The order has no assigned player.');
  if (['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION'].includes(order.status)) return order;
  if (order.status === 'COMPLETED' && order.completedAt && now.getTime() - Date.parse(order.completedAt) <= 24 * 60 * 60_000) return order;
  throw new GiftError('GIFT_WINDOW_CLOSED', 'Gift requests are closed for this order.');
}

function parseGiftRequestBody(value: unknown) {
  const body = value as Record<string, unknown>;
  if (!body || !Number.isInteger(body.expectedOrderVersion) || typeof body.giftCatalogVersionId !== 'string') {
    throw new GiftError('VALIDATION_ERROR', 'expectedOrderVersion and giftCatalogVersionId are required.');
  }
  return { expectedOrderVersion: body.expectedOrderVersion as number, giftCatalogVersionId: body.giftCatalogVersionId, receiverId: typeof body.receiverId === 'string' ? body.receiverId : undefined };
}

function giftOrderIdParam(request: FastifyRequest): string {
  const id = (request.params as { orderId?: unknown }).orderId;
  if (typeof id !== 'string') throw new GiftError('VALIDATION_ERROR', 'orderId is required.');
  return id;
}

function giftOrderIdQuery(request: FastifyRequest): string {
  const id = (request.query as { orderId?: unknown }).orderId;
  if (typeof id !== 'string') throw new GiftError('VALIDATION_ERROR', 'orderId is required.');
  return id;
}

function mapGiftError(error: unknown) {
  if (error instanceof AdapterError) {
    if (error.code === 'INSUFFICIENT_FUNDS') return { statusCode: 422, code: 'INSUFFICIENT_AVAILABLE_BALANCE', message: 'Available balance is insufficient.' };
    if (error.code === 'PROVIDER_TIMEOUT') return { statusCode: 504, code: 'PROVIDER_TIMEOUT', message: 'The balance provider timed out.' };
    return { statusCode: error.retryable ? 503 : 409, code: error.code, message: error.message };
  }
  if (!(error instanceof GiftError)) return null;
  const statusCode = error.code === 'NOT_FOUND' ? 404 : error.code === 'PERMISSION_DENIED' ? 403 : error.code === 'VALIDATION_ERROR' ? 400 : error.code === 'INSUFFICIENT_AVAILABLE_BALANCE' ? 422 : 409;
  return { statusCode, code: error.code, message: error.message };
}

function deterministicUuid(seed: string): string {
  const bytes = crypto.createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return `${bytes.subarray(0, 4).toString('hex')}-${bytes.subarray(4, 6).toString('hex')}-${bytes.subarray(6, 8).toString('hex')}-${bytes.subarray(8, 10).toString('hex')}-${bytes.subarray(10).toString('hex')}`;
}

function mapGiftCatalogRow(row: GiftCatalogRow): GiftCatalogRecord {
  return { id: row.id, itemId: row.gift_catalog_item_id, code: row.code, version: row.version, status: row.status,
    name: row.name, priceMinor: Number(row.price_minor), currency: row.currency, broadcastTemplate: row.broadcast_template };
}

interface GiftCatalogRow {
  id: string; gift_catalog_item_id: string; code: string; version: number; status: GiftCatalogStatus;
  name: string; price_minor: string | number | bigint; currency: string; broadcast_template: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
