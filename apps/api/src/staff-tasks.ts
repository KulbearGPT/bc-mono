import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { ActorContext } from './security.js';
import { registerSecureWriteRoute } from './security.js';
import type { OrderRecord, OrderStore } from './orders.js';

export type StaffTaskType =
  | 'ORDER_ASSIST'
  | 'CANCELLATION_ASSIST'
  | 'GIFT_REVIEW'
  | 'PLAYER_START_LATE'
  | 'PLAYER_NO_SHOW'
  | 'CUSTOMER_NO_SHOW'
  | 'SERVICE_INTERRUPTED'
  | 'COMPLETION_REVIEW'
  | 'DISPUTE'
  | 'AUTOMATION_FAILURE';

export type StaffTaskStatus = 'OPEN' | 'CLAIMED' | 'VERIFIED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'RESOLVED' | 'CANCELLED';

export interface StaffTaskRecord {
  id: string;
  publicId: string;
  type: StaffTaskType;
  reasonCode: string;
  status: StaffTaskStatus;
  version: number;
  orderId: string | null;
  giftRequestId: string | null;
  claimedBy: string | null;
  requiredLevel: 'L1_SUPPORT';
  voiceChannelId: string | null;
  contextSnapshot: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface StaffTaskStore {
  createOrderTask(input: {
    order: OrderRecord;
    type: StaffTaskType;
    reasonCode: string;
    actor: Pick<ActorContext, 'actorUserId' | 'actorStaffId' | 'actorSource'>;
    note?: string | null;
    voiceChannelId?: string | null;
    now: Date;
  }): Promise<StaffTaskRecord> | StaffTaskRecord;
  claimTask(input: {
    staffTaskId: string;
    expectedVersion: number;
    actorStaffId: string;
    now: Date;
  }): Promise<StaffTaskRecord> | StaffTaskRecord;
}

export interface StaffTaskQueryClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>;
}

export class StaffTaskError extends Error {
  readonly code: 'CONFLICT' | 'NOT_FOUND' | 'PERMISSION_DENIED' | 'VALIDATION_ERROR';

  constructor(code: StaffTaskError['code'], message: string) {
    super(message);
    this.name = 'StaffTaskError';
    this.code = code;
  }
}

export class InMemoryStaffTaskStore implements StaffTaskStore {
  readonly tasks: StaffTaskRecord[];

  constructor(input: { tasks: StaffTaskRecord[] }) {
    this.tasks = input.tasks.map(clone);
  }

  createOrderTask(input: {
    order: OrderRecord;
    type: StaffTaskType;
    reasonCode: string;
    actor: Pick<ActorContext, 'actorUserId' | 'actorStaffId' | 'actorSource'>;
    note?: string | null;
    voiceChannelId?: string | null;
    now: Date;
  }): StaffTaskRecord {
    const existing = this.tasks.find((task) => {
      return task.orderId === input.order.id
        && task.type === input.type
        && task.reasonCode === input.reasonCode
        && activeTaskStatuses.has(task.status);
    });
    if (existing) {
      return clone(existing);
    }
    const task: StaffTaskRecord = {
      id: crypto.randomUUID(),
      publicId: buildTaskPublicId(input.order, input.type, input.reasonCode),
      type: input.type,
      reasonCode: input.reasonCode,
      status: 'OPEN',
      version: 1,
      orderId: input.order.id,
      giftRequestId: null,
      claimedBy: null,
      requiredLevel: 'L1_SUPPORT',
      voiceChannelId: input.voiceChannelId ?? input.order.channelSpec.voiceChannelId,
      contextSnapshot: {
        orderId: input.order.id,
        publicId: input.order.publicId,
        status: input.order.status,
        channelId: input.order.channelSpec.channelId,
        voiceChannelId: input.voiceChannelId ?? input.order.channelSpec.voiceChannelId,
        actorUserId: input.actor.actorUserId,
        actorStaffId: input.actor.actorStaffId,
        actorSource: input.actor.actorSource,
        note: input.note ?? null
      },
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString()
    };
    this.tasks.push(task);
    return clone(task);
  }

  claimTask(input: {
    staffTaskId: string;
    expectedVersion: number;
    actorStaffId: string;
    now: Date;
  }): StaffTaskRecord {
    const index = this.tasks.findIndex((task) => task.id === input.staffTaskId);
    const task = index === -1 ? null : this.tasks[index];
    if (!task) {
      throw new StaffTaskError('NOT_FOUND', 'Staff task was not found.');
    }
    if (task.status !== 'OPEN' || task.version !== input.expectedVersion) {
      throw new StaffTaskError('CONFLICT', 'Staff task is no longer open.');
    }
    const claimed: StaffTaskRecord = {
      ...task,
      status: 'CLAIMED',
      version: task.version + 1,
      claimedBy: input.actorStaffId,
      updatedAt: input.now.toISOString()
    };
    this.tasks[index] = claimed;
    return clone(claimed);
  }
}

export class PostgresStaffTaskStore implements StaffTaskStore {
  private readonly client: StaffTaskQueryClient;

  constructor(input: { pool?: Pool; client?: StaffTaskQueryClient }) {
    const client = input.pool ?? input.client;
    if (!client) {
      throw new StaffTaskError('VALIDATION_ERROR', 'PostgresStaffTaskStore requires a pool or client.');
    }
    this.client = client;
  }

  async createOrderTask(input: {
    order: OrderRecord;
    type: StaffTaskType;
    reasonCode: string;
    actor: Pick<ActorContext, 'actorUserId' | 'actorStaffId' | 'actorSource'>;
    note?: string | null;
    voiceChannelId?: string | null;
    now: Date;
  }): Promise<StaffTaskRecord> {
    const publicId = buildTaskPublicId(input.order, input.type, input.reasonCode);
    const voiceChannelId = input.voiceChannelId ?? input.order.channelSpec.voiceChannelId;
    const contextSnapshot = {
      orderId: input.order.id,
      publicId: input.order.publicId,
      status: input.order.status,
      channelId: input.order.channelSpec.channelId,
      voiceChannelId,
      actorUserId: input.actor.actorUserId,
      actorStaffId: input.actor.actorStaffId,
      actorSource: input.actor.actorSource,
      note: input.note ?? null
    };
    const inserted = await this.client.query<StaffTaskRow>(
      `
INSERT INTO staff_tasks (
  id, public_id, type, reason_code, status, row_version,
  order_id, gift_request_id, created_by_staff_id, claimed_by_staff_id,
  resolved_by_staff_id, voice_channel_id, staff_channel_message_id,
  context_snapshot, claimed_at, verified_at, resolved_at, created_at, updated_at
)
VALUES (
  gen_random_uuid(), $1, $2::"StaffTaskType", $3, 'OPEN', 1,
  $4, NULL, $5, NULL,
  NULL, $6, NULL,
  $7::jsonb, NULL, NULL, NULL, $8, $8
)
ON CONFLICT (public_id) DO NOTHING
RETURNING *
      `,
      [
        publicId,
        input.type,
        input.reasonCode,
        input.order.id,
        input.actor.actorStaffId,
        voiceChannelId,
        JSON.stringify(contextSnapshot),
        input.now.toISOString()
      ]
    );
    const row = inserted.rows[0] ?? (await this.client.query<StaffTaskRow>(
      `
SELECT *
FROM staff_tasks
WHERE public_id = $1
  AND status = ANY($2::"StaffTaskStatus"[])
LIMIT 1
      `,
      [publicId, Array.from(activeTaskStatuses)]
    )).rows[0];
    if (!row) {
      throw new StaffTaskError('CONFLICT', 'Could not create or load active staff task.');
    }
    return mapStaffTaskRow(row);
  }

  async claimTask(input: {
    staffTaskId: string;
    expectedVersion: number;
    actorStaffId: string;
    now: Date;
  }): Promise<StaffTaskRecord> {
    const updated = await this.client.query<StaffTaskRow>(
      `
UPDATE staff_tasks
SET status = 'CLAIMED',
    row_version = row_version + 1,
    claimed_by_staff_id = $2,
    claimed_at = $4,
    updated_at = $4
WHERE id = $1
  AND status = 'OPEN'
  AND row_version = $3
RETURNING *
      `,
      [input.staffTaskId, input.actorStaffId, input.expectedVersion, input.now.toISOString()]
    );
    const row = updated.rows[0];
    if (row) {
      return mapStaffTaskRow(row);
    }
    const existing = await this.client.query<{ id: string }>('SELECT id FROM staff_tasks WHERE id = $1 LIMIT 1', [input.staffTaskId]);
    if (!existing.rows[0]) {
      throw new StaffTaskError('NOT_FOUND', 'Staff task was not found.');
    }
    throw new StaffTaskError('CONFLICT', 'Staff task is no longer open.');
  }
}

export async function createOrderStaffTask(input: {
  store: StaffTaskStore;
  order: OrderRecord;
  type: StaffTaskType;
  reasonCode: string;
  actor: Pick<ActorContext, 'actorUserId' | 'actorStaffId' | 'actorSource'>;
  note?: string | null;
  voiceChannelId?: string | null;
  now: Date;
}): Promise<StaffTaskRecord> {
  validateOrderStaffTaskType(input.type);
  validateReasonCode(input.reasonCode);
  return input.store.createOrderTask(input);
}

export async function claimStaffTask(input: {
  store: StaffTaskStore;
  staffTaskId: string;
  expectedVersion: number;
  actorStaffId: string;
  now: Date;
}): Promise<StaffTaskRecord> {
  if (!input.actorStaffId) {
    throw new StaffTaskError('PERMISSION_DENIED', 'A staff actor is required to claim a task.');
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new StaffTaskError('VALIDATION_ERROR', 'expectedVersion must be a positive integer.');
  }
  return input.store.claimTask(input);
}

export function registerStaffTaskRoutes(
  server: FastifyInstance,
  options: { store: StaffTaskStore; orderStore: Pick<OrderStore, 'findById'>; now?: () => Date }
): void {
  const security = server.securityOptions;
  if (!security) {
    throw new Error('Staff task routes require buildApiServer({ security })');
  }
  const now = options.now ?? (() => new Date());

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/orders/:orderId/staff-tasks',
    permission: 'staff_task.request',
    action: 'CREATE_ORDER_STAFF_TASK',
    targetType: 'order',
    targetId: (request) => orderIdParam(request),
    acceptedSources: ['DISCORD_BOT', 'DASHBOARD'],
    successStatusCode: 201,
    handler: async (request, actor) => {
      const body = parseCreateOrderStaffTaskBody(request.body);
      const order = await options.orderStore.findById(orderIdParam(request));
      if (!order) {
        throw new StaffTaskError('NOT_FOUND', 'Order was not found.');
      }
      return createOrderStaffTask({
        store: options.store,
        order,
        type: body.type,
        reasonCode: body.reasonCode,
        note: body.note,
        voiceChannelId: body.voiceChannelId,
        actor,
        now: now()
      });
    },
    mapError: mapStaffTaskError,
    fingerprintBody: (request) => parseCreateOrderStaffTaskBody(request.body)
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/admin/staff-tasks/:staffTaskId/claim',
    permission: 'staff_task.claim',
    action: 'CLAIM_STAFF_TASK',
    targetType: 'staff_task',
    targetId: (request) => staffTaskIdParam(request),
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    handler: async (request, actor) => {
      const body = parseTaskVersionBody(request.body);
      if (!actor.actorStaffId) {
        throw new StaffTaskError('PERMISSION_DENIED', 'A staff actor is required to claim a task.');
      }
      return claimStaffTask({
        store: options.store,
        staffTaskId: staffTaskIdParam(request),
        expectedVersion: body.expectedVersion,
        actorStaffId: actor.actorStaffId,
        now: now()
      });
    },
    mapError: mapStaffTaskError,
    fingerprintBody: (request) => parseTaskVersionBody(request.body)
  });
}

const activeTaskStatuses = new Set<StaffTaskStatus>(['OPEN', 'CLAIMED', 'VERIFIED', 'PENDING_APPROVAL', 'APPROVED']);

function validateOrderStaffTaskType(type: StaffTaskType): void {
  if (![
    'ORDER_ASSIST',
    'CANCELLATION_ASSIST',
    'PLAYER_START_LATE',
    'PLAYER_NO_SHOW',
    'CUSTOMER_NO_SHOW',
    'SERVICE_INTERRUPTED',
    'COMPLETION_REVIEW',
    'AUTOMATION_FAILURE'
  ].includes(type)) {
    throw new StaffTaskError('VALIDATION_ERROR', 'Unsupported order staff task type.');
  }
}

function validateReasonCode(reasonCode: string): void {
  if (!/^[A-Z0-9_]{3,100}$/u.test(reasonCode)) {
    throw new StaffTaskError('VALIDATION_ERROR', 'reasonCode is invalid.');
  }
}

function buildTaskPublicId(order: OrderRecord, type: StaffTaskType, reasonCode: string): string {
  const hash = crypto.createHash('sha1').update(`${order.id}:${type}:${reasonCode}`).digest('hex').slice(0, 8).toUpperCase();
  return `T-${order.publicId.slice(0, 14)}-${hash}`.slice(0, 30);
}

function parseCreateOrderStaffTaskBody(body: unknown): {
  type: StaffTaskType;
  reasonCode: string;
  note: string | null;
  voiceChannelId: string | null;
} {
  const input = objectBody(body);
  const type = stringField(input.type, 'type') as StaffTaskType;
  const reasonCode = stringField(input.reasonCode, 'reasonCode');
  validateOrderStaffTaskType(type);
  validateReasonCode(reasonCode);
  return {
    type,
    reasonCode,
    note: nullableString(input.note, 'note', 1_000),
    voiceChannelId: nullableString(input.voiceChannelId, 'voiceChannelId', 32)
  };
}

function parseTaskVersionBody(body: unknown): { expectedVersion: number } {
  const input = objectBody(body);
  if (!Number.isInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new StaffTaskError('VALIDATION_ERROR', 'expectedVersion must be a positive integer.');
  }
  return { expectedVersion: input.expectedVersion as number };
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new StaffTaskError('VALIDATION_ERROR', 'Request body must be an object.');
  }
  return body as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new StaffTaskError('VALIDATION_ERROR', `${field} is required.`);
  }
  return value.trim();
}

function nullableString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new StaffTaskError('VALIDATION_ERROR', `${field} is invalid.`);
  }
  return value;
}

function orderIdParam(request: FastifyRequest): string {
  return (request.params as { orderId?: string }).orderId ?? '';
}

function staffTaskIdParam(request: FastifyRequest): string {
  return (request.params as { staffTaskId?: string }).staffTaskId ?? '';
}

function mapStaffTaskError(error: unknown): { statusCode: number; code: string; message: string } | null {
  if (!(error instanceof StaffTaskError)) {
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
  return { statusCode: 422, code: error.code, message: error.message };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface StaffTaskRow {
  id: string;
  public_id: string;
  type: StaffTaskType;
  reason_code: string;
  status: StaffTaskStatus;
  row_version: number;
  order_id: string | null;
  gift_request_id: string | null;
  claimed_by_staff_id: string | null;
  voice_channel_id: string | null;
  context_snapshot: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapStaffTaskRow(row: StaffTaskRow): StaffTaskRecord {
  return {
    id: row.id,
    publicId: row.public_id,
    type: row.type,
    reasonCode: row.reason_code,
    status: row.status,
    version: row.row_version,
    orderId: row.order_id,
    giftRequestId: row.gift_request_id,
    claimedBy: row.claimed_by_staff_id,
    requiredLevel: 'L1_SUPPORT',
    voiceChannelId: row.voice_channel_id,
    contextSnapshot: row.context_snapshot,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}
