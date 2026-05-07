import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
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
import type { StaffLevel } from './security.js';

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
  status: 'PENDING_REVIEW' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  version: number;
  giftCodeSnapshot: string;
  giftNameSnapshot: string;
  priceMinor: number;
  currency: string;
  broadcastTemplateSnapshot: string;
  verifiedByStaffId?: string | null;
  verifiedAt?: string | null;
  verificationNote?: string | null;
  verificationPayloadHash?: string | null;
  executionCredentialExpiresAt?: string | null;
  approvedByStaffId?: string | null;
  approvedAt?: string | null;
  rejectedReason?: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface GiftStaffTaskRecord {
  id: string;
  publicId: string;
  type: 'GIFT_REVIEW';
  reasonCode: 'GIFT_REQUESTED';
  status: 'OPEN' | 'CLAIMED' | 'VERIFIED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  version: number;
  orderId: string;
  giftRequestId: string;
  claimedBy?: string | null;
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
  verifyTask(input: { taskId: string; expectedVersion: number; actorStaffId: string; verificationMethod: string; notes: string; now: Date }): Promise<GiftReviewResult> | GiftReviewResult;
  authorizeGift(input: { giftRequestId: string; expectedVersion: number; actorStaffId: string; actorLevel: StaffLevel; reason: string; now: Date }): Promise<GiftAuthorizationResult> | GiftAuthorizationResult;
  rejectGift(input: { giftRequestId: string; expectedVersion: number; actorStaffId: string; reason: string; now: Date }): Promise<{ status: 'REJECTED'; reason: string }> | { status: 'REJECTED'; reason: string };
}

export interface GiftReviewResult {
  status: 'VERIFIED';
  giftRequestId: string;
  taskId: string;
  executionCredential: { payloadHash: string; expiresAt: string };
}

export interface GiftApprovalRecord {
  id: string;
  publicId: string;
  action: 'GIFT_APPROVE';
  targetId: string;
  targetVersion: number;
  payloadSnapshot: Record<string, unknown>;
  payloadHash: string;
  amountMinor: number;
  currency: string;
  requestedByStaffId: string;
  requiredLevel: 'L3_OPERATIONS' | 'L4_ADMIN_OWNER';
  reason: string;
  expiresAt: string;
  createdAt: string;
  status?: 'PENDING' | 'APPROVED';
}

export type GiftAuthorizationResult =
  | { status: 'APPROVED'; action: 'READY_FOR_CAPTURE'; requiredLevel: StaffLevel; approvalRequestId: string | null; executionCredential: { payloadHash: string; expiresAt: string } }
  | { code: 'APPROVAL_PENDING'; actionExecuted: false; requiredLevel: 'L3_OPERATIONS' | 'L4_ADMIN_OWNER'; approvalRequestId: string; expiresAt: string };

export class GiftError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'PERMISSION_DENIED'
    | 'VALIDATION_ERROR'
    | 'CONFLICT'
    | 'GIFT_WINDOW_CLOSED'
    | 'GIFT_NOT_AVAILABLE'
    | 'EXECUTION_CREDENTIAL_STALE'
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
  readonly approvals: GiftApprovalRecord[] = [];

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

  refreshVerificationHash(giftRequestId: string, now: Date): void {
    const request = this.requireRequest(giftRequestId);
    request.verificationPayloadHash = giftPayloadHash({ ...request, version: request.verifiedAt ? request.version - 1 : request.version }, this.requireReservation(giftRequestId));
    request.executionCredentialExpiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  }

  verifyTask(input: { taskId: string; expectedVersion: number; actorStaffId: string; verificationMethod: string; notes: string; now: Date }): GiftReviewResult {
    const task = this.staffTasks.find((candidate) => candidate.id === input.taskId);
    if (!task || task.status !== 'CLAIMED' || task.version !== input.expectedVersion || task.claimedBy !== input.actorStaffId) {
      throw new GiftError('CONFLICT', 'Gift task is not claimed by the current staff member.');
    }
    const request = this.requireRequest(task.giftRequestId);
    const reservation = this.requireReservation(request.id);
    if (request.status !== 'PENDING_REVIEW' || reservation.status !== 'ACTIVE') throw new GiftError('CONFLICT', 'Gift request cannot be verified.');
    const expiresAt = new Date(input.now.getTime() + 15 * 60_000).toISOString();
    const updated: GiftRequestRecord = { ...request, version: request.version + 1, verifiedByStaffId: input.actorStaffId,
      verifiedAt: input.now.toISOString(), verificationNote: `${input.verificationMethod}: ${input.notes}`,
      verificationPayloadHash: giftPayloadHash(request, reservation), executionCredentialExpiresAt: expiresAt,
      updatedAt: input.now.toISOString() };
    this.requests[this.requests.indexOf(request)] = updated;
    this.staffTasks[this.staffTasks.indexOf(task)] = { ...task, status: 'VERIFIED', version: task.version + 1, updatedAt: input.now.toISOString() };
    return { status: 'VERIFIED', giftRequestId: request.id, taskId: task.id,
      executionCredential: { payloadHash: updated.verificationPayloadHash!, expiresAt } };
  }

  authorizeGift(input: { giftRequestId: string; expectedVersion: number; actorStaffId: string; actorLevel: StaffLevel; reason: string; now: Date }): GiftAuthorizationResult {
    const request = this.requireRequest(input.giftRequestId);
    const reservation = this.requireReservation(request.id);
    const task = this.staffTasks.find((candidate) => candidate.giftRequestId === request.id);
    if (request.status === 'PENDING_APPROVAL') {
      const approval = this.approvals.find((candidate) => candidate.targetId === request.id && (candidate.status ?? 'PENDING') === 'PENDING');
      if (!approval || request.version !== input.expectedVersion || levelRank(input.actorLevel) < levelRank(approval.requiredLevel)
        || Date.parse(approval.expiresAt) <= input.now.getTime()
        || approval.payloadSnapshot.verificationPayloadHash !== request.verificationPayloadHash
        || approval.payloadHash !== crypto.createHash('sha256').update(JSON.stringify(approval.payloadSnapshot)).digest('hex')) {
        throw new GiftError('EXECUTION_CREDENTIAL_STALE', 'Approval request changed or expired.');
      }
      approval.status = 'APPROVED';
      this.requests[this.requests.indexOf(request)] = { ...request, status: 'APPROVED', version: request.version + 1,
        approvedByStaffId: input.actorStaffId, approvedAt: input.now.toISOString(), updatedAt: input.now.toISOString() };
      if (task) this.staffTasks[this.staffTasks.indexOf(task)] = { ...task, status: 'APPROVED', version: task.version + 1, updatedAt: input.now.toISOString() };
      return { status: 'APPROVED', action: 'READY_FOR_CAPTURE', requiredLevel: approval.requiredLevel,
        approvalRequestId: approval.id, executionCredential: { payloadHash: request.verificationPayloadHash!, expiresAt: request.executionCredentialExpiresAt! } };
    }
    assertExecutionCredential(request, reservation, task, input.expectedVersion, input.now);
    const requiredLevel = requiredGiftLevel(request.priceMinor);
    if (levelRank(input.actorLevel) < levelRank(requiredLevel)) {
      if (requiredLevel === 'L2_SUPERVISOR') throw new GiftError('PERMISSION_DENIED', 'L1 cannot authorize gifts.');
      const approval = buildGiftApproval(request, input.actorStaffId, requiredLevel, input.reason, input.now);
      this.approvals.push(approval);
      this.requests[this.requests.indexOf(request)] = { ...request, status: 'PENDING_APPROVAL', version: request.version + 1, updatedAt: input.now.toISOString() };
      if (task) this.staffTasks[this.staffTasks.indexOf(task)] = { ...task, status: 'PENDING_APPROVAL', version: task.version + 1, updatedAt: input.now.toISOString() };
      return { code: 'APPROVAL_PENDING', actionExecuted: false, requiredLevel, approvalRequestId: approval.id, expiresAt: approval.expiresAt };
    }
    this.requests[this.requests.indexOf(request)] = { ...request, status: 'APPROVED', version: request.version + 1,
      approvedByStaffId: input.actorStaffId, approvedAt: input.now.toISOString(), updatedAt: input.now.toISOString() };
    if (task) this.staffTasks[this.staffTasks.indexOf(task)] = { ...task, status: 'APPROVED', version: task.version + 1, updatedAt: input.now.toISOString() };
    return { status: 'APPROVED', action: 'READY_FOR_CAPTURE', requiredLevel, approvalRequestId: null,
      executionCredential: { payloadHash: request.verificationPayloadHash!, expiresAt: request.executionCredentialExpiresAt! } };
  }

  rejectGift(input: { giftRequestId: string; expectedVersion: number; actorStaffId: string; reason: string; now: Date }) {
    const request = this.requireRequest(input.giftRequestId);
    if (request.version !== input.expectedVersion || !request.verifiedAt || !request.verificationPayloadHash) throw new GiftError('CONFLICT', 'Gift request is not ready for rejection.');
    this.requests[this.requests.indexOf(request)] = { ...request, status: 'REJECTED', version: request.version + 1,
      rejectedReason: input.reason, updatedAt: input.now.toISOString() };
    const task = this.staffTasks.find((candidate) => candidate.giftRequestId === request.id);
    if (task) this.staffTasks[this.staffTasks.indexOf(task)] = { ...task, status: 'REJECTED', version: task.version + 1, updatedAt: input.now.toISOString() };
    return { status: 'REJECTED' as const, reason: input.reason };
  }

  private requireRequest(id: string): GiftRequestRecord {
    const request = this.requests.find((candidate) => candidate.id === id);
    if (!request) throw new GiftError('NOT_FOUND', 'Gift request was not found.');
    return request;
  }

  private requireReservation(giftRequestId: string): GiftReservationRecord {
    const reservation = this.reservations.find((candidate) => candidate.giftRequestId === giftRequestId);
    if (!reservation) throw new GiftError('CONFLICT', 'Gift reservation was not found.');
    return reservation;
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

  async verifyTask(input: { taskId: string; expectedVersion: number; actorStaffId: string; verificationMethod: string; notes: string; now: Date }): Promise<GiftReviewResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const snapshot = await loadGiftReviewSnapshot(client, { taskId: input.taskId });
      if (snapshot.task.status !== 'CLAIMED' || snapshot.task.version !== input.expectedVersion || snapshot.task.claimedBy !== input.actorStaffId
        || snapshot.request.status !== 'PENDING_REVIEW' || snapshot.reservation.status !== 'ACTIVE') {
        throw new GiftError('CONFLICT', 'Gift task is not claimed by the current staff member.');
      }
      const payloadHash = giftPayloadHash(snapshot.request, snapshot.reservation);
      const expiresAt = new Date(input.now.getTime() + 15 * 60_000).toISOString();
      await client.query(`UPDATE gift_requests SET row_version = row_version + 1, verified_by_staff_id = $2,
        verified_at = $3, verification_note = $4, verification_payload_hash = $5,
        execution_credential_expires_at = $6, updated_at = $3 WHERE id = $1`, [
        snapshot.request.id, input.actorStaffId, input.now, `${input.verificationMethod}: ${input.notes}`, payloadHash, new Date(expiresAt)
      ]);
      await client.query(`UPDATE staff_tasks SET status = 'VERIFIED', row_version = row_version + 1,
        verified_at = $2, updated_at = $2 WHERE id = $1`, [input.taskId, input.now]);
      await client.query('COMMIT');
      return { status: 'VERIFIED', giftRequestId: snapshot.request.id, taskId: input.taskId,
        executionCredential: { payloadHash, expiresAt } };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async authorizeGift(input: { giftRequestId: string; expectedVersion: number; actorStaffId: string; actorLevel: StaffLevel; reason: string; now: Date }): Promise<GiftAuthorizationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const snapshot = await loadGiftReviewSnapshot(client, { giftRequestId: input.giftRequestId });
      if (snapshot.request.status === 'PENDING_APPROVAL') {
        const approvalResult = await client.query<{ id: string; required_level: 'L3_OPERATIONS' | 'L4_ADMIN_OWNER'; payload_snapshot: Record<string, unknown>; payload_hash: string; expires_at: Date }>(
          `SELECT id, required_level, payload_snapshot, payload_hash, expires_at FROM approval_requests
           WHERE target_id = $1 AND action = 'GIFT_APPROVE' AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [input.giftRequestId]
        );
        const approval = approvalResult.rows[0];
        if (!approval || snapshot.request.version !== input.expectedVersion || levelRank(input.actorLevel) < levelRank(approval.required_level)
          || approval.expires_at.getTime() <= input.now.getTime()
          || approval.payload_snapshot.verificationPayloadHash !== snapshot.request.verificationPayloadHash
          || approval.payload_hash !== crypto.createHash('sha256').update(JSON.stringify(approval.payload_snapshot)).digest('hex')) {
          throw new GiftError('EXECUTION_CREDENTIAL_STALE', 'Approval request changed or expired.');
        }
        await client.query(`UPDATE approval_requests SET status = 'APPROVED', row_version = row_version + 1, updated_at = $2 WHERE id = $1`, [approval.id, input.now]);
        await client.query(`INSERT INTO approval_decisions (id,approval_request_id,decision,decided_by_staff_id,reason,target_version_checked,payload_hash_checked,decided_at)
          VALUES ($1,$2,'APPROVE',$3,$4,$5,$6,$7)`, [crypto.randomUUID(), approval.id, input.actorStaffId, input.reason,
          snapshot.request.version, approval.payload_hash, input.now]);
        await client.query(`UPDATE gift_requests SET status = 'APPROVED', row_version = row_version + 1,
          approved_by_staff_id = $2, approved_at = $3, updated_at = $3 WHERE id = $1`, [input.giftRequestId, input.actorStaffId, input.now]);
        await client.query(`UPDATE staff_tasks SET status = 'APPROVED', row_version = row_version + 1, updated_at = $2 WHERE id = $1`, [snapshot.task.id, input.now]);
        await client.query('COMMIT');
        return { status: 'APPROVED', action: 'READY_FOR_CAPTURE', requiredLevel: approval.required_level,
          approvalRequestId: approval.id, executionCredential: { payloadHash: snapshot.request.verificationPayloadHash!, expiresAt: snapshot.request.executionCredentialExpiresAt! } };
      }
      assertExecutionCredential(snapshot.request, snapshot.reservation, snapshot.task, input.expectedVersion, input.now);
      const requiredLevel = requiredGiftLevel(snapshot.request.priceMinor);
      if (levelRank(input.actorLevel) < levelRank(requiredLevel)) {
        if (requiredLevel === 'L2_SUPERVISOR') throw new GiftError('PERMISSION_DENIED', 'L1 cannot authorize gifts.');
        const approval = buildGiftApproval(snapshot.request, input.actorStaffId, requiredLevel, input.reason, input.now);
        await insertGiftApproval(client, approval, snapshot.task.id);
        await client.query(`UPDATE gift_requests SET status = 'PENDING_APPROVAL', row_version = row_version + 1, updated_at = $2 WHERE id = $1`, [input.giftRequestId, input.now]);
        await client.query(`UPDATE staff_tasks SET status = 'PENDING_APPROVAL', row_version = row_version + 1, updated_at = $2 WHERE id = $1`, [snapshot.task.id, input.now]);
        await client.query('COMMIT');
        return { code: 'APPROVAL_PENDING', actionExecuted: false, requiredLevel, approvalRequestId: approval.id, expiresAt: approval.expiresAt };
      }
      await client.query(`UPDATE gift_requests SET status = 'APPROVED', row_version = row_version + 1,
        approved_by_staff_id = $2, approved_at = $3, updated_at = $3 WHERE id = $1`, [input.giftRequestId, input.actorStaffId, input.now]);
      await client.query(`UPDATE staff_tasks SET status = 'APPROVED', row_version = row_version + 1, updated_at = $2 WHERE id = $1`, [snapshot.task.id, input.now]);
      await client.query('COMMIT');
      return { status: 'APPROVED', action: 'READY_FOR_CAPTURE', requiredLevel, approvalRequestId: null,
        executionCredential: { payloadHash: snapshot.request.verificationPayloadHash!, expiresAt: snapshot.request.executionCredentialExpiresAt! } };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async rejectGift(input: { giftRequestId: string; expectedVersion: number; actorStaffId: string; reason: string; now: Date }): Promise<{ status: 'REJECTED'; reason: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const snapshot = await loadGiftReviewSnapshot(client, { giftRequestId: input.giftRequestId });
      if (snapshot.request.version !== input.expectedVersion || !snapshot.request.verifiedAt || snapshot.task.status !== 'VERIFIED') {
        throw new GiftError('CONFLICT', 'Gift request is not ready for rejection.');
      }
      await client.query(`UPDATE gift_requests SET status = 'REJECTED', row_version = row_version + 1,
        rejected_reason = $2, updated_at = $3 WHERE id = $1`, [input.giftRequestId, input.reason, input.now]);
      await client.query(`UPDATE staff_tasks SET status = 'REJECTED', row_version = row_version + 1,
        resolved_by_staff_id = $2, resolved_at = $3, updated_at = $3 WHERE id = $1`, [snapshot.task.id, input.actorStaffId, input.now]);
      await client.query('COMMIT');
      return { status: 'REJECTED', reason: input.reason };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
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

  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/staff-tasks/:staffTaskId/verify', permission: 'staff_task.verify',
    action: 'VERIFY_GIFT_TASK', targetType: 'staff_task', targetId: giftTaskIdParam,
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    handler: async (request, actor) => {
      if (!actor.actorStaffId) throw new GiftError('PERMISSION_DENIED', 'A staff actor is required.');
      const body = parseVerifyBody(request.body);
      return options.store.verifyTask({ taskId: giftTaskIdParam(request), expectedVersion: body.expectedVersion,
        actorStaffId: actor.actorStaffId, verificationMethod: body.verificationMethod, notes: body.notes, now: now() });
    },
    fingerprintBody: (request) => parseVerifyBody(request.body), mapError: mapGiftError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/gift-requests/:giftRequestId/approve', permission: 'gift.approve',
    action: 'AUTHORIZE_GIFT_REQUEST', targetType: 'gift_request', targetId: giftRequestIdParam,
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    requiresRecentStepUp: (_request, actor) => actor.actorLevel === 'L3_OPERATIONS' || actor.actorLevel === 'L4_ADMIN_OWNER',
    handler: async (request, actor) => {
      if (!actor.actorStaffId || !actor.actorLevel) throw new GiftError('PERMISSION_DENIED', 'A staff actor is required.');
      const body = parseDecisionBody(request.body);
      const data = await options.store.authorizeGift({ giftRequestId: giftRequestIdParam(request), expectedVersion: body.expectedVersion,
        actorStaffId: actor.actorStaffId, actorLevel: actor.actorLevel, reason: body.reason, now: now() });
      return { data, statusCode: 'code' in data && data.code === 'APPROVAL_PENDING' ? 202 : 200, commit: () => undefined };
    },
    fingerprintBody: (request) => parseDecisionBody(request.body), mapError: mapGiftError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/gift-requests/:giftRequestId/reject', permission: 'gift.reject',
    action: 'REJECT_GIFT_REQUEST', targetType: 'gift_request', targetId: giftRequestIdParam,
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    requiresRecentStepUp: (_request, actor) => actor.actorLevel === 'L3_OPERATIONS' || actor.actorLevel === 'L4_ADMIN_OWNER',
    handler: (request, actor) => {
      if (!actor.actorStaffId) throw new GiftError('PERMISSION_DENIED', 'A staff actor is required.');
      const body = parseDecisionBody(request.body);
      return options.store.rejectGift({ giftRequestId: giftRequestIdParam(request), expectedVersion: body.expectedVersion,
        actorStaffId: actor.actorStaffId, reason: body.reason, now: now() });
    },
    fingerprintBody: (request) => parseDecisionBody(request.body), mapError: mapGiftError
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

function parseVerifyBody(value: unknown) {
  const body = value as Record<string, unknown>;
  if (!body || !Number.isInteger(body.expectedVersion) || typeof body.verificationMethod !== 'string'
    || typeof body.notes !== 'string' || body.notes.trim().length < 3) {
    throw new GiftError('VALIDATION_ERROR', 'expectedVersion, verificationMethod, and notes are required.');
  }
  return { expectedVersion: body.expectedVersion as number, verificationMethod: body.verificationMethod, notes: body.notes.trim() };
}

function parseDecisionBody(value: unknown) {
  const body = value as Record<string, unknown>;
  const reason = typeof body?.reason === 'string'
    ? body.reason
    : [body?.reasonCode, body?.note].filter((part): part is string => typeof part === 'string').join(': ');
  if (!body || !Number.isInteger(body.expectedVersion) || reason.trim().length < 3) {
    throw new GiftError('VALIDATION_ERROR', 'expectedVersion and reason are required.');
  }
  return { expectedVersion: body.expectedVersion as number, reason: reason.trim() };
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

function giftTaskIdParam(request: FastifyRequest): string {
  const id = (request.params as { staffTaskId?: unknown }).staffTaskId;
  if (typeof id !== 'string') throw new GiftError('VALIDATION_ERROR', 'staffTaskId is required.');
  return id;
}

function giftRequestIdParam(request: FastifyRequest): string {
  const id = (request.params as { giftRequestId?: unknown }).giftRequestId;
  if (typeof id !== 'string') throw new GiftError('VALIDATION_ERROR', 'giftRequestId is required.');
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

function giftPayloadHash(request: GiftRequestRecord, reservation: GiftReservationRecord): string {
  return crypto.createHash('sha256').update(JSON.stringify({ giftRequestId: request.id, version: request.version,
    orderId: request.orderId, senderId: request.senderId, receiverId: request.receiverId,
    giftCatalogVersionId: request.giftCatalogVersionId, giftCode: request.giftCodeSnapshot,
    giftName: request.giftNameSnapshot, priceMinor: request.priceMinor, currency: request.currency,
    reservationId: reservation.id, reservationVersion: reservation.version, reservationStatus: reservation.status,
    reservationAmountMinor: reservation.amountMinor })).digest('hex');
}

function assertExecutionCredential(request: GiftRequestRecord, reservation: GiftReservationRecord,
  task: GiftStaffTaskRecord | undefined, expectedVersion: number, now: Date): void {
  if (request.version !== expectedVersion || request.status !== 'PENDING_REVIEW' || !request.verifiedAt
    || !request.verificationPayloadHash || !request.executionCredentialExpiresAt || task?.status !== 'VERIFIED'
    || reservation.status !== 'ACTIVE' || reservation.amountMinor !== request.priceMinor
    || Date.parse(request.executionCredentialExpiresAt) <= now.getTime()
    || request.verificationPayloadHash !== giftPayloadHash({ ...request, version: request.version - 1 }, reservation)) {
    throw new GiftError('EXECUTION_CREDENTIAL_STALE', 'Gift verification changed or expired; verify again.');
  }
}

function requiredGiftLevel(amountMinor: number): 'L2_SUPERVISOR' | 'L3_OPERATIONS' | 'L4_ADMIN_OWNER' {
  if (amountMinor <= 200_000) return 'L2_SUPERVISOR';
  if (amountMinor < 500_000) return 'L3_OPERATIONS';
  return 'L4_ADMIN_OWNER';
}

function levelRank(level: StaffLevel): number {
  return { L1_SUPPORT: 1, L2_SUPERVISOR: 2, L3_OPERATIONS: 3, L4_ADMIN_OWNER: 4 }[level];
}

function buildGiftApproval(request: GiftRequestRecord, actorStaffId: string, requiredLevel: 'L3_OPERATIONS' | 'L4_ADMIN_OWNER', reason: string, now: Date): GiftApprovalRecord {
  const id = crypto.randomUUID();
  const payloadSnapshot = { giftRequestId: request.id, expectedVersion: request.version,
    verificationPayloadHash: request.verificationPayloadHash, executionCredentialExpiresAt: request.executionCredentialExpiresAt,
    amountMinor: request.priceMinor, currency: request.currency };
  return { id, publicId: `APR-${id.replaceAll('-', '').slice(0, 18).toUpperCase()}`, action: 'GIFT_APPROVE',
    targetId: request.id, targetVersion: request.version, payloadSnapshot,
    payloadHash: crypto.createHash('sha256').update(JSON.stringify(payloadSnapshot)).digest('hex'),
    amountMinor: request.priceMinor, currency: request.currency, requestedByStaffId: actorStaffId,
    requiredLevel, reason, expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), createdAt: now.toISOString(), status: 'PENDING' };
}

async function loadGiftReviewSnapshot(client: PoolClient, selector: { taskId?: string; giftRequestId?: string }) {
  const result = await client.query<GiftReviewRow>(`
SELECT gr.id AS gr_id, gr.public_id, gr.order_id, gr.gift_catalog_version_id, gr.sender_id, gr.receiver_id,
  gr.status AS gr_status, gr.row_version AS gr_version, gr.gift_code_snapshot, gr.gift_name_snapshot,
  gr.price_minor, gr.currency, gr.broadcast_template_snapshot, gr.verified_by_staff_id, gr.verified_at,
  gr.verification_note, gr.verification_payload_hash, gr.execution_credential_expires_at,
  gr.approved_by_staff_id, gr.approved_at, gr.rejected_reason, gr.expires_at AS gr_expires_at,
  gr.created_at AS gr_created_at, gr.updated_at AS gr_updated_at,
  fr.id AS fr_id, fr.user_id AS fr_user_id, fr.mode AS fr_mode, fr.provider, fr.provider_hold_ref,
  fr.amount_minor AS fr_amount_minor, fr.currency AS fr_currency, fr.status AS fr_status,
  fr.row_version AS fr_version, fr.idempotency_key, fr.expires_at AS fr_expires_at,
  fr.activated_at, fr.settled_at, fr.created_at AS fr_created_at, fr.updated_at AS fr_updated_at,
  st.id AS st_id, st.public_id AS st_public_id, st.status AS st_status, st.row_version AS st_version,
  st.claimed_by_staff_id, st.voice_channel_id, st.context_snapshot, st.created_at AS st_created_at, st.updated_at AS st_updated_at
FROM gift_requests gr
JOIN fund_reservations fr ON fr.gift_request_id = gr.id
JOIN staff_tasks st ON st.gift_request_id = gr.id
WHERE ${selector.taskId ? 'st.id = $1' : 'gr.id = $1'}
FOR UPDATE OF gr, fr, st`, [selector.taskId ?? selector.giftRequestId]);
  const row = result.rows[0];
  if (!row) throw new GiftError('NOT_FOUND', 'Gift review record was not found.');
  const request: GiftRequestRecord = {
    id: row.gr_id, publicId: row.public_id, orderId: row.order_id, giftCatalogVersionId: row.gift_catalog_version_id,
    senderId: row.sender_id, receiverId: row.receiver_id, status: row.gr_status, version: row.gr_version,
    giftCodeSnapshot: row.gift_code_snapshot, giftNameSnapshot: row.gift_name_snapshot, priceMinor: Number(row.price_minor),
    currency: row.currency, broadcastTemplateSnapshot: row.broadcast_template_snapshot,
    verifiedByStaffId: row.verified_by_staff_id, verifiedAt: nullableIso(row.verified_at), verificationNote: row.verification_note,
    verificationPayloadHash: row.verification_payload_hash, executionCredentialExpiresAt: nullableIso(row.execution_credential_expires_at),
    approvedByStaffId: row.approved_by_staff_id, approvedAt: nullableIso(row.approved_at), rejectedReason: row.rejected_reason,
    expiresAt: toIso(row.gr_expires_at), createdAt: toIso(row.gr_created_at), updatedAt: toIso(row.gr_updated_at)
  };
  const reservation: GiftReservationRecord = {
    id: row.fr_id, userId: row.fr_user_id, sourceType: 'GIFT', orderId: null, giftRequestId: row.gr_id,
    mode: row.fr_mode, provider: row.provider, providerHoldRef: row.provider_hold_ref,
    amountMinor: Number(row.fr_amount_minor), currency: row.fr_currency as GiftReservationRecord['currency'], status: row.fr_status, version: row.fr_version,
    idempotencyKey: row.idempotency_key, expiresAt: toIso(row.fr_expires_at), activatedAt: nullableIso(row.activated_at),
    settledAt: nullableIso(row.settled_at), createdAt: toIso(row.fr_created_at), updatedAt: toIso(row.fr_updated_at)
  };
  const task: GiftStaffTaskRecord = {
    id: row.st_id, publicId: row.st_public_id, type: 'GIFT_REVIEW', reasonCode: 'GIFT_REQUESTED', status: row.st_status,
    version: row.st_version, orderId: row.order_id, giftRequestId: row.gr_id, claimedBy: row.claimed_by_staff_id,
    voiceChannelId: row.voice_channel_id, contextSnapshot: row.context_snapshot as GiftStaffTaskRecord['contextSnapshot'],
    createdAt: toIso(row.st_created_at), updatedAt: toIso(row.st_updated_at)
  };
  return { request, reservation, task };
}

async function insertGiftApproval(client: PoolClient, approval: GiftApprovalRecord, staffTaskId: string): Promise<void> {
  await client.query(`INSERT INTO approval_requests (
    id, public_id, action, target_type, target_id, target_version, payload_snapshot, payload_hash,
    amount_minor, currency, requested_by_staff_id, required_level, status, row_version, staff_task_id,
    reason, expires_at, created_at, updated_at
  ) VALUES ($1,$2,'GIFT_APPROVE','GIFT_REQUEST',$3,$4,$5::jsonb,$6,$7,$8,$9,$10,'PENDING',1,$11,$12,$13,$14,$14)`, [
    approval.id, approval.publicId, approval.targetId, approval.targetVersion, JSON.stringify(approval.payloadSnapshot),
    approval.payloadHash, approval.amountMinor, approval.currency, approval.requestedByStaffId, approval.requiredLevel,
    staffTaskId, approval.reason, new Date(approval.expiresAt), new Date(approval.createdAt)
  ]);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value ? toIso(value) : null;
}

interface GiftReviewRow {
  gr_id: string; public_id: string; order_id: string; gift_catalog_version_id: string; sender_id: string; receiver_id: string;
  gr_status: GiftRequestRecord['status']; gr_version: number; gift_code_snapshot: string; gift_name_snapshot: string;
  price_minor: string | number | bigint; currency: string; broadcast_template_snapshot: string;
  verified_by_staff_id: string | null; verified_at: Date | string | null; verification_note: string | null;
  verification_payload_hash: string | null; execution_credential_expires_at: Date | string | null;
  approved_by_staff_id: string | null; approved_at: Date | string | null; rejected_reason: string | null;
  gr_expires_at: Date | string; gr_created_at: Date | string; gr_updated_at: Date | string;
  fr_id: string; fr_user_id: string; fr_mode: GiftReservationRecord['mode']; provider: string; provider_hold_ref: string | null;
  fr_amount_minor: string | number | bigint; fr_currency: string; fr_status: GiftReservationRecord['status']; fr_version: number;
  idempotency_key: string; fr_expires_at: Date | string; activated_at: Date | string | null; settled_at: Date | string | null;
  fr_created_at: Date | string; fr_updated_at: Date | string;
  st_id: string; st_public_id: string; st_status: GiftStaffTaskRecord['status']; st_version: number;
  claimed_by_staff_id: string | null; voice_channel_id: string | null; context_snapshot: unknown;
  st_created_at: Date | string; st_updated_at: Date | string;
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
