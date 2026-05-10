import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { PostgresOrderStore, type InMemoryOrderStore, type OrderRecord } from './orders.js';
import type { InMemoryStaffTaskStore, StaffTaskRecord, StaffTaskStatus, StaffTaskType } from './staff-tasks.js';
import { registerSecureReadRoute, registerSecureWriteRoute, type ActorContext, type StaffLevel } from './security.js';

export interface SupportTaskNote {
  id: string;
  staffTaskId: string;
  authorStaffId: string;
  body: string;
  createdAt: string;
}

export interface SupportWorkbenchStore {
  listTasks(input: { actor: ActorContext; status?: StaffTaskStatus; type?: StaffTaskType; limit: number }): Promise<StaffTaskRecord[]> | StaffTaskRecord[];
  getTask(input: { taskId: string; actor: ActorContext }): Promise<StaffTaskRecord> | StaffTaskRecord;
  addNote(input: { taskId: string; actor: ActorContext; body: string; now: Date }): Promise<SupportTaskNote> | SupportTaskNote;
  escalate(input: { taskId: string; actor: ActorContext; expectedVersion: number; reasonCode: string; note: string; now: Date }): Promise<StaffTaskRecord> | StaffTaskRecord;
  getOrder(input: { orderId: string; taskId: string | null; actor: ActorContext }): Promise<ReturnType<typeof buildOrderView>> | ReturnType<typeof buildOrderView>;
}

export class SupportWorkbenchError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'CONFLICT' | 'VALIDATION_ERROR', message: string) {
    super(message);
    this.name = 'SupportWorkbenchError';
  }
}

export class InMemorySupportWorkbenchStore implements SupportWorkbenchStore {
  readonly notes: SupportTaskNote[] = [];

  constructor(private readonly input: { tasks: InMemoryStaffTaskStore; orders: InMemoryOrderStore }) {}

  listTasks(input: { actor: ActorContext; status?: StaffTaskStatus; type?: StaffTaskType; limit: number }): StaffTaskRecord[] {
    return this.input.tasks.tasks
      .filter((task) => canViewTask(task, input.actor))
      .filter((task) => !input.status || task.status === input.status)
      .filter((task) => !input.type || task.type === input.type)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, input.limit)
      .map(clone);
  }

  getTask(input: { taskId: string; actor: ActorContext }): StaffTaskRecord {
    const task = this.findTask(input.taskId);
    if (!canViewTask(task, input.actor)) throw new SupportWorkbenchError('PERMISSION_DENIED', 'The task is outside the current staff scope.');
    return clone(task);
  }

  addNote(input: { taskId: string; actor: ActorContext; body: string; now: Date }): SupportTaskNote {
    const task = this.findTask(input.taskId);
    requireOwnedClaim(task, input.actor);
    const note = { id: crypto.randomUUID(), staffTaskId: task.id, authorStaffId: input.actor.actorStaffId!, body: input.body, createdAt: input.now.toISOString() };
    this.notes.push(note);
    return clone(note);
  }

  escalate(input: { taskId: string; actor: ActorContext; expectedVersion: number; reasonCode: string; note: string; now: Date }): StaffTaskRecord {
    const task = this.findTask(input.taskId);
    requireOwnedClaim(task, input.actor);
    if (task.version !== input.expectedVersion) throw new SupportWorkbenchError('CONFLICT', 'The task version is stale.');
    const updated: StaffTaskRecord = {
      ...task,
      status: 'PENDING_APPROVAL',
      version: task.version + 1,
      contextSnapshot: { ...(task.contextSnapshot as Record<string, unknown>), escalationReasonCode: input.reasonCode, escalationNote: input.note },
      updatedAt: input.now.toISOString()
    };
    Object.assign(task, updated);
    return clone(updated);
  }

  getOrder(input: { orderId: string; taskId: string | null; actor: ActorContext }) {
    requireOrderScope(this.input.tasks.tasks, input);
    const order = this.input.orders.orders.find((candidate) => candidate.id === input.orderId);
    if (!order) throw new SupportWorkbenchError('NOT_FOUND', 'Order was not found.');
    return buildOrderView(order);
  }

  private findTask(taskId: string): StaffTaskRecord {
    const task = this.input.tasks.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new SupportWorkbenchError('NOT_FOUND', 'Staff task was not found.');
    return task;
  }
}

export class PostgresSupportWorkbenchStore implements SupportWorkbenchStore {
  private readonly orders: PostgresOrderStore;

  constructor(private readonly pool: Pool) {
    this.orders = new PostgresOrderStore({ pool });
  }

  async listTasks(input: { actor: ActorContext; status?: StaffTaskStatus; type?: StaffTaskType; limit: number }): Promise<StaffTaskRecord[]> {
    requireStaff(input.actor);
    const l1Scope = input.actor.actorLevel === 'L1_SUPPORT';
    const result = await this.pool.query<StaffTaskRow>(
      `SELECT * FROM staff_tasks
       WHERE ($1::boolean = false OR status = 'OPEN' OR claimed_by_staff_id = $2::uuid)
         AND ($3::text IS NULL OR status::text = $3)
         AND ($4::text IS NULL OR type::text = $4)
       ORDER BY created_at ASC, id ASC LIMIT $5`,
      [l1Scope, input.actor.actorStaffId, input.status ?? null, input.type ?? null, input.limit]
    );
    return result.rows.map(mapTask);
  }

  async getTask(input: { taskId: string; actor: ActorContext }): Promise<StaffTaskRecord> {
    const result = await this.pool.query<StaffTaskRow>('SELECT * FROM staff_tasks WHERE id = $1', [input.taskId]);
    if (!result.rows[0]) throw new SupportWorkbenchError('NOT_FOUND', 'Staff task was not found.');
    const task = mapTask(result.rows[0]);
    if (!canViewTask(task, input.actor)) throw new SupportWorkbenchError('PERMISSION_DENIED', 'The task is outside the current staff scope.');
    return task;
  }

  async addNote(input: { taskId: string; actor: ActorContext; body: string; now: Date }): Promise<SupportTaskNote> {
    const task = await this.getTask({ taskId: input.taskId, actor: input.actor });
    requireOwnedClaim(task, input.actor);
    const result = await this.pool.query<{ id: string; created_at: Date | string }>(
      `INSERT INTO staff_task_notes (id, staff_task_id, author_staff_id, body, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id, created_at`,
      [input.taskId, input.actor.actorStaffId, input.body, input.now.toISOString()]
    );
    return { id: result.rows[0]!.id, staffTaskId: input.taskId, authorStaffId: input.actor.actorStaffId!, body: input.body, createdAt: new Date(result.rows[0]!.created_at).toISOString() };
  }

  async escalate(input: { taskId: string; actor: ActorContext; expectedVersion: number; reasonCode: string; note: string; now: Date }): Promise<StaffTaskRecord> {
    const task = await this.getTask({ taskId: input.taskId, actor: input.actor });
    requireOwnedClaim(task, input.actor);
    const result = await this.pool.query<StaffTaskRow>(
      `UPDATE staff_tasks SET status = 'PENDING_APPROVAL', row_version = row_version + 1,
         context_snapshot = context_snapshot || jsonb_build_object('escalationReasonCode', $4::text, 'escalationNote', $5::text), updated_at = $6
       WHERE id = $1 AND row_version = $2 AND claimed_by_staff_id = $3 AND status = 'CLAIMED' RETURNING *`,
      [input.taskId, input.expectedVersion, input.actor.actorStaffId, input.reasonCode, input.note, input.now.toISOString()]
    );
    if (!result.rows[0]) throw new SupportWorkbenchError('CONFLICT', 'The task version or state is stale.');
    return mapTask(result.rows[0]);
  }

  async getOrder(input: { orderId: string; taskId: string | null; actor: ActorContext }) {
    requireStaff(input.actor);
    if (input.actor.actorLevel === 'L1_SUPPORT') {
      const scope = await this.pool.query(`SELECT id FROM staff_tasks WHERE order_id = $1 AND claimed_by_staff_id = $2
        AND status IN ('CLAIMED', 'VERIFIED', 'PENDING_APPROVAL') AND ($3::uuid IS NULL OR id = $3::uuid) LIMIT 1`,
      [input.orderId, input.actor.actorStaffId, input.taskId]);
      if (!scope.rows[0]) throw new SupportWorkbenchError('PERMISSION_DENIED', 'A personally claimed task is required.');
    }
    const order = await this.orders.findById(input.orderId);
    if (!order) throw new SupportWorkbenchError('NOT_FOUND', 'Order was not found.');
    return buildOrderView(order);
  }
}

export function registerSupportWorkbenchRoutes(server: FastifyInstance, options: { store: SupportWorkbenchStore; now?: () => Date }): void {
  if (!server.securityOptions) throw new Error('Support workbench routes require security options.');
  const security = server.securityOptions;
  const now = options.now ?? (() => new Date());
  registerSecureReadRoute(server, security, {
    method: 'GET', url: '/api/v1/admin/staff-tasks', permission: 'staff_task.read', action: 'LIST_STAFF_TASKS', targetType: 'staff_task',
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], handler: async (request, actor) => ({ items: await options.store.listTasks({ actor, ...parseTaskQuery(request) }), nextCursor: null }), mapError
  });
  registerSecureReadRoute(server, security, {
    method: 'GET', url: '/api/v1/admin/staff-tasks/:staffTaskId', permission: 'staff_task.read', action: 'GET_STAFF_TASK', targetType: 'staff_task',
    targetId: taskId, acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], handler: async (request, actor) => {
      const task = await options.store.getTask({ taskId: taskId(request), actor });
      return { task, links: taskLinks(task) };
    }, mapError
  });
  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/staff-tasks/:staffTaskId/notes', permission: 'staff_task.verify', action: 'ADD_STAFF_TASK_NOTE', targetType: 'staff_task',
    targetId: taskId, acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], successStatusCode: 201,
    handler: (request, actor) => options.store.addNote({ taskId: taskId(request), actor, body: parseNote(request.body), now: now() }), mapError
  });
  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/staff-tasks/:staffTaskId/escalate', permission: 'staff_task.verify', action: 'ESCALATE_STAFF_TASK', targetType: 'staff_task',
    targetId: taskId, acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], successStatusCode: 202,
    handler: async (request, actor) => ({ task: await options.store.escalate({ taskId: taskId(request), actor, ...parseEscalation(request.body), now: now() }), requiredLevel: 'L2_SUPERVISOR' }), mapError
  });
  registerSecureReadRoute(server, security, {
    method: 'GET', url: '/api/v1/admin/orders/:orderId', permission: 'staff_task.read', action: 'GET_ADMIN_ORDER', targetType: 'order',
    targetId: orderId, acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], handler: (request, actor) => options.store.getOrder({ orderId: orderId(request), taskId: queryTaskId(request), actor }), mapError
  });
}

function buildOrderView(order: OrderRecord) {
  const lifecycle = order as OrderRecord & { customerReadyAt?: string | null; playerReadyAt?: string | null; readyDeadlineAt?: string | null; startedAt?: string | null };
  const readiness = { customer: lifecycle.customerReadyAt ? 'READY' : 'NOT_READY', player: lifecycle.playerReadyAt ? 'READY' : 'NOT_READY',
    bothReady: Boolean(lifecycle.customerReadyAt && lifecycle.playerReadyAt), readyDeadlineAt: lifecycle.readyDeadlineAt ?? null, startedAt: lifecycle.startedAt ?? null };
  const automation = { state: order.automationState, version: order.automationVersion, scope: order.automationScope, reasonCode: order.automationReasonCode,
    pausedAt: order.automationPausedAt, resumedAt: order.automationResumedAt, expiresAt: order.automationExpiresAt };
  const matching = order.status === 'PENDING_DISPATCH'
    ? { stage: 'SEARCHING', nextStep: 'WAIT_FOR_PLAYER' }
    : order.status === 'ACCEPTED' ? { stage: 'ACCEPTED', nextStep: 'CONFIRM_READINESS' } : null;
  return { order: clone(order), matching, readiness, automation, transactions: [], resolutions: [], events: [] };
}

function canViewTask(task: StaffTaskRecord, actor: ActorContext): boolean {
  requireStaff(actor);
  return actor.actorLevel !== 'L1_SUPPORT' || task.status === 'OPEN' || task.claimedBy === actor.actorStaffId;
}

function requireOwnedClaim(task: StaffTaskRecord, actor: ActorContext): void {
  requireStaff(actor);
  if (task.claimedBy !== actor.actorStaffId || task.status !== 'CLAIMED') throw new SupportWorkbenchError('PERMISSION_DENIED', 'The task must be claimed by the current staff member.');
}

function requireOrderScope(tasks: StaffTaskRecord[], input: { orderId: string; taskId: string | null; actor: ActorContext }): void {
  requireStaff(input.actor);
  if (input.actor.actorLevel !== 'L1_SUPPORT') return;
  const task = tasks.find((item) => (!input.taskId || item.id === input.taskId) && item.orderId === input.orderId
    && item.claimedBy === input.actor.actorStaffId && ['CLAIMED', 'PENDING_APPROVAL', 'VERIFIED'].includes(item.status));
  if (!task) {
    throw new SupportWorkbenchError('PERMISSION_DENIED', 'A personally claimed task is required.');
  }
}

function requireStaff(actor: ActorContext): asserts actor is ActorContext & { actorStaffId: string; actorLevel: StaffLevel } {
  if (!actor.actorStaffId || !actor.actorLevel) throw new SupportWorkbenchError('PERMISSION_DENIED', 'An active staff account is required.');
}

function taskLinks(task: StaffTaskRecord) {
  const context = task.contextSnapshot as { guildId?: unknown; channelId?: unknown; voiceChannelId?: unknown };
  const guildId = typeof context.guildId === 'string' ? context.guildId : null;
  const channelId = typeof context.channelId === 'string' ? context.channelId : null;
  const voiceChannelId = typeof context.voiceChannelId === 'string' ? context.voiceChannelId : task.voiceChannelId;
  return {
    orderChannel: guildId && channelId ? `https://discord.com/channels/${guildId}/${channelId}` : null,
    voiceChannel: guildId && voiceChannelId ? `https://discord.com/channels/${guildId}/${voiceChannelId}` : null
  };
}

function parseTaskQuery(request: FastifyRequest): { status?: StaffTaskStatus; type?: StaffTaskType; limit: number } {
  const query = request.query as { status?: unknown; type?: unknown; limit?: unknown };
  const limit = Number(query.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SupportWorkbenchError('VALIDATION_ERROR', 'limit is invalid.');
  return { status: typeof query.status === 'string' ? query.status as StaffTaskStatus : undefined, type: typeof query.type === 'string' ? query.type as StaffTaskType : undefined, limit };
}

function parseNote(body: unknown): string {
  const value = (body as { body?: unknown } | null)?.body;
  if (typeof value !== 'string' || !value.trim() || value.length > 2_000) throw new SupportWorkbenchError('VALIDATION_ERROR', 'body is invalid.');
  return value.trim();
}

function parseEscalation(body: unknown) {
  const input = body as { expectedVersion?: unknown; reasonCode?: unknown; note?: unknown } | null;
  if (!Number.isInteger(input?.expectedVersion) || (input!.expectedVersion as number) < 1 || typeof input?.reasonCode !== 'string' || !/^[A-Z0-9_]{3,100}$/.test(input.reasonCode) || typeof input.note !== 'string' || !input.note.trim() || input.note.length > 2_000) {
    throw new SupportWorkbenchError('VALIDATION_ERROR', 'Escalation payload is invalid.');
  }
  return { expectedVersion: input.expectedVersion as number, reasonCode: input.reasonCode, note: input.note.trim() };
}

function taskId(request: FastifyRequest): string { return (request.params as { staffTaskId?: string }).staffTaskId ?? ''; }
function orderId(request: FastifyRequest): string { return (request.params as { orderId?: string }).orderId ?? ''; }
function queryTaskId(request: FastifyRequest): string | null { const value = (request.query as { taskId?: unknown }).taskId; return typeof value === 'string' ? value : null; }
function mapError(error: unknown) {
  if (!(error instanceof SupportWorkbenchError)) return null;
  return { statusCode: error.code === 'NOT_FOUND' ? 404 : error.code === 'PERMISSION_DENIED' ? 403 : error.code === 'CONFLICT' ? 409 : 422, code: error.code, message: error.message };
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

interface StaffTaskRow {
  id: string; public_id: string; type: StaffTaskType; reason_code: string; status: StaffTaskStatus; row_version: number;
  order_id: string | null; gift_request_id: string | null; claimed_by_staff_id: string | null; resolved_by_staff_id: string | null;
  voice_channel_id: string | null; context_snapshot: unknown; created_at: Date | string; updated_at: Date | string;
}
function mapTask(row: StaffTaskRow): StaffTaskRecord {
  return { id: row.id, publicId: row.public_id, type: row.type, reasonCode: row.reason_code, status: row.status, version: row.row_version,
    orderId: row.order_id, giftRequestId: row.gift_request_id, claimedBy: row.claimed_by_staff_id, resolvedBy: row.resolved_by_staff_id,
    requiredLevel: 'L1_SUPPORT', voiceChannelId: row.voice_channel_id, contextSnapshot: row.context_snapshot,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}
