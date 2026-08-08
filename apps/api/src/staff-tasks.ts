import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { registerSecureReadRoute, registerSecureWriteRoute, type ActorContext } from './security.js';
import type { OrderRecord, OrderStore } from './orders.js';
import type { AccountStore } from './accounts.js';

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
export type SupportResponseStatus = 'NOT_REQUIRED' | 'PENDING' | 'MET' | 'OVERDUE';

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
  resolvedBy?: string | null;
  requiredLevel: 'L1_SUPPORT';
  voiceChannelId: string | null;
  contextSnapshot: unknown;
  responseStatus?: SupportResponseStatus;
  responseDueAt?: string | null;
  firstRespondedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StaffTaskStore {
  listCurrentUserTasks(userId: string): Promise<StaffTaskRecord[]> | StaffTaskRecord[];
  findClaimedOrderTask?(orderId: string, staffId: string): Promise<StaffTaskRecord | null> | StaffTaskRecord | null;
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
  resolveTask(input: {
    staffTaskId: string;
    expectedVersion: number;
    actorStaffId: string;
    resolutionCode: string;
    note: string | null;
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

  listCurrentUserTasks(userId: string): StaffTaskRecord[] {
    return this.tasks.filter((task) => {
      const context = task.contextSnapshot as { customerId?: unknown };
      return context?.customerId === userId;
    }).map(clone);
  }

  findClaimedOrderTask(orderId: string, staffId: string): StaffTaskRecord | null {
    const task = this.tasks.find((candidate) => {
      return candidate.orderId === orderId && candidate.claimedBy === staffId && candidate.status === 'CLAIMED';
    });
    return task ? clone(task) : null;
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
        customerId: input.order.customerId,
        playerId: input.order.playerId,
        note: input.note ?? null
      },
      responseStatus: 'PENDING',
      responseDueAt: new Date(input.now.getTime() + 5 * 60_000).toISOString(),
      firstRespondedAt: null,
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

  resolveTask(input: {
    staffTaskId: string;
    expectedVersion: number;
    actorStaffId: string;
    resolutionCode: string;
    note: string | null;
    now: Date;
  }): StaffTaskRecord {
    const index = this.tasks.findIndex((task) => task.id === input.staffTaskId);
    const task = index === -1 ? null : this.tasks[index];
    if (!task) throw new StaffTaskError('NOT_FOUND', 'Staff task was not found.');
    if (!['CLAIMED', 'VERIFIED', 'APPROVED'].includes(task.status) || task.version !== input.expectedVersion) {
      throw new StaffTaskError('CONFLICT', 'Staff task cannot be resolved from its current state.');
    }
    const resolved: StaffTaskRecord = {
      ...task, status: 'RESOLVED', version: task.version + 1, resolvedBy: input.actorStaffId,
      contextSnapshot: { ...(task.contextSnapshot as Record<string, unknown>), resolutionCode: input.resolutionCode, resolutionNote: input.note },
      updatedAt: input.now.toISOString()
    };
    this.tasks[index] = resolved;
    return clone(resolved);
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

  async listCurrentUserTasks(userId: string): Promise<StaffTaskRecord[]> {
    const result = await this.client.query<StaffTaskRow>(
      `SELECT task.* FROM staff_tasks AS task JOIN orders ON orders.id = task.order_id WHERE orders.customer_id = $1 ORDER BY task.created_at DESC, task.id DESC LIMIT 50`,
      [userId]
    );
    return result.rows.map(mapStaffTaskRow);
  }

  async findClaimedOrderTask(orderId: string, staffId: string): Promise<StaffTaskRecord | null> {
    const result = await this.client.query<StaffTaskRow>(
      `SELECT * FROM staff_tasks WHERE order_id = $1 AND claimed_by_staff_id = $2 AND status = 'CLAIMED' ORDER BY claimed_at DESC NULLS LAST LIMIT 1`,
      [orderId, staffId]
    );
    return result.rows[0] ? mapStaffTaskRow(result.rows[0]) : null;
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
      customerId: input.order.customerId,
      playerId: input.order.playerId,
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

  async resolveTask(input: {
    staffTaskId: string;
    expectedVersion: number;
    actorStaffId: string;
    resolutionCode: string;
    note: string | null;
    now: Date;
  }): Promise<StaffTaskRecord> {
    const result = await this.client.query<StaffTaskRow>(
      `UPDATE staff_tasks
       SET status = 'RESOLVED', row_version = row_version + 1, resolved_by_staff_id = $3,
           resolved_at = $4, updated_at = $4,
           context_snapshot = context_snapshot || jsonb_build_object('resolutionCode', $5::text, 'resolutionNote', $6::text)
       WHERE id = $1 AND row_version = $2 AND status = ANY($7::"StaffTaskStatus"[])
       RETURNING *`,
      [input.staffTaskId, input.expectedVersion, input.actorStaffId, input.now.toISOString(), input.resolutionCode, input.note, ['CLAIMED', 'VERIFIED', 'APPROVED']]
    );
    if (!result.rows[0]) {
      const existing = await this.client.query<{ id: string }>('SELECT id FROM staff_tasks WHERE id = $1', [input.staffTaskId]);
      if (!existing.rows[0]) throw new StaffTaskError('NOT_FOUND', 'Staff task was not found.');
      throw new StaffTaskError('CONFLICT', 'Staff task cannot be resolved from its current state.');
    }
    return mapStaffTaskRow(result.rows[0]);
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

export async function resolveStaffTask(input: {
  store: StaffTaskStore;
  staffTaskId: string;
  expectedVersion: number;
  actorStaffId: string;
  resolutionCode: string;
  note: string | null;
  now: Date;
}): Promise<StaffTaskRecord> {
  validateReasonCode(input.resolutionCode);
  return input.store.resolveTask(input);
}

export function registerStaffTaskRoutes(
  server: FastifyInstance,
  options: { store: StaffTaskStore; orderStore: Pick<OrderStore, 'findById'>; accountStore?: Pick<AccountStore, 'findByDiscord'>; now?: () => Date }
): void {
  const security = server.securityOptions;
  if (!security) {
    throw new Error('Staff task routes require buildApiServer({ security })');
  }
  const now = options.now ?? (() => new Date());

  if (options.accountStore) {
    registerSecureReadRoute(server, security, {
      method: 'GET',
      url: '/api/v1/me/staff-tasks',
      permission: 'account.self.read',
      action: 'LIST_CURRENT_USER_STAFF_TASKS',
      targetType: 'staff_task',
      acceptedSources: ['DISCORD_BOT', 'DASHBOARD'],
      handler: async (_request, actor) => {
        if (!actor.guildId || !actor.discordUserId) {
          throw new StaffTaskError('PERMISSION_DENIED', 'Discord actor context is required.');
        }
        const binding = await options.accountStore!.findByDiscord({ guildId: actor.guildId, discordUserId: actor.discordUserId });
        if (!binding) {
          throw new StaffTaskError('PERMISSION_DENIED', 'Current account is not bound.');
        }
        const tasks = await options.store.listCurrentUserTasks(binding.userId);
        return { items: tasks.map(toCurrentUserTask), nextCursor: null };
      },
      mapError: mapStaffTaskError
    });
  }

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

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/admin/staff-tasks/:staffTaskId/resolve',
    permission: 'staff_task.resolve',
    action: 'RESOLVE_STAFF_TASK',
    targetType: 'staff_task',
    targetId: (request) => staffTaskIdParam(request),
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    handler: async (request, actor) => {
      const body = parseResolveTaskBody(request.body);
      if (!actor.actorStaffId) {
        throw new StaffTaskError('PERMISSION_DENIED', 'A staff actor is required to resolve a task.');
      }
      return resolveStaffTask({
        store: options.store,
        staffTaskId: staffTaskIdParam(request),
        expectedVersion: body.expectedVersion,
        actorStaffId: actor.actorStaffId,
        resolutionCode: body.resolutionCode,
        note: body.notes,
        now: now()
      });
    },
    mapError: mapStaffTaskError,
    fingerprintBody: (request) => parseResolveTaskBody(request.body)
  });
}

const activeTaskStatuses = new Set<StaffTaskStatus>(['OPEN', 'CLAIMED', 'VERIFIED', 'PENDING_APPROVAL', 'APPROVED']);

function toCurrentUserTask(task: StaffTaskRecord) {
  return {
    id: task.id,
    publicId: task.publicId,
    type: task.type,
    reasonCode: task.reasonCode,
    status: task.status,
    orderId: task.orderId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

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

function parseResolveTaskBody(body: unknown): { expectedVersion: number; resolutionCode: string; notes: string } {
  const input = objectBody(body);
  if (!Number.isInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new StaffTaskError('VALIDATION_ERROR', 'expectedVersion must be a positive integer.');
  }
  const resolutionCode = stringField(input.resolutionCode, 'resolutionCode');
  const notes = stringField(input.notes, 'notes');
  if (notes.length > 2_000) {
    throw new StaffTaskError('VALIDATION_ERROR', 'notes is invalid.');
  }
  validateReasonCode(resolutionCode);
  return {
    expectedVersion: input.expectedVersion as number,
    resolutionCode,
    notes
  };
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
  resolved_by_staff_id: string | null;
  voice_channel_id: string | null;
  context_snapshot: unknown;
  response_status: SupportResponseStatus;
  response_due_at: Date | string | null;
  first_responded_at: Date | string | null;
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
    resolvedBy: row.resolved_by_staff_id,
    requiredLevel: 'L1_SUPPORT',
    voiceChannelId: row.voice_channel_id,
    contextSnapshot: row.context_snapshot,
    responseStatus: row.response_status,
    responseDueAt: row.response_due_at ? new Date(row.response_due_at).toISOString() : null,
    firstRespondedAt: row.first_responded_at ? new Date(row.first_responded_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}
