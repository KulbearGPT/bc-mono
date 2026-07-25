import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { PostgresOrderStore, type InMemoryOrderStore, type OrderRecord } from './orders.js';
import type { InMemoryStaffTaskStore, StaffTaskRecord, StaffTaskStatus, StaffTaskType, SupportResponseStatus } from './staff-tasks.js';
import { registerSecureReadRoute, registerSecureWriteRoute, type ActorContext, type StaffLevel } from './security.js';

export interface SupportTaskNote {
  id: string;
  staffTaskId: string;
  authorStaffId: string;
  body: string;
  createdAt: string;
}

export interface SupportTaskTriageSummary {
  orderPublicId: string | null;
  customerDisplayName: string | null;
  gameDisplayName: string | null;
  serviceDisplayName: string | null;
  amountMinor: number | null;
  currency: string | null;
  reasonLabel: string;
  waitStartedAt: string;
  nextActionLabel: string;
}

export interface SupportTaskLinks {
  orderChannel: string | null;
  voiceChannel: string | null;
}

interface SupportReadinessParticipant {
  participantId: string;
  playerId: string;
  displayName: string;
  readiness: 'READY' | 'NOT_READY';
}

export interface SupportTaskView extends StaffTaskRecord {
  triage: SupportTaskTriageSummary;
  links: SupportTaskLinks;
}

export interface SupportWorkbenchStore {
  listTasks(input: { actor: ActorContext; status?: StaffTaskStatus; type?: StaffTaskType; limit: number }): Promise<SupportTaskView[]> | SupportTaskView[];
  getTask(input: { taskId: string; actor: ActorContext }): Promise<SupportTaskView> | SupportTaskView;
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

  listTasks(input: { actor: ActorContext; status?: StaffTaskStatus; type?: StaffTaskType; limit: number }): SupportTaskView[] {
    return this.input.tasks.tasks
      .filter((task) => canViewTask(task, input.actor, this.findOrder(task.orderId)))
      .filter((task) => !input.status || task.status === input.status)
      .filter((task) => !input.type || task.type === input.type)
      .sort(compareTriagePriority)
      .slice(0, input.limit)
      .map((task) => buildTaskView(task, input.actor, this.findOrder(task.orderId)));
  }

  getTask(input: { taskId: string; actor: ActorContext }): SupportTaskView {
    const task = this.findTask(input.taskId);
    const order = this.findOrder(task.orderId);
    if (!canViewTask(task, input.actor, order)) throw new SupportWorkbenchError('PERMISSION_DENIED', 'The task is outside the current staff scope.');
    return buildTaskView(task, input.actor, order);
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
    return buildOrderView(order, inMemoryReadinessParticipants(order));
  }

  private findTask(taskId: string): StaffTaskRecord {
    const task = this.input.tasks.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new SupportWorkbenchError('NOT_FOUND', 'Staff task was not found.');
    return task;
  }

  private findOrder(orderId: string | null): OrderRecord | null {
    return orderId ? this.input.orders.orders.find((candidate) => candidate.id === orderId) ?? null : null;
  }
}

export class PostgresSupportWorkbenchStore implements SupportWorkbenchStore {
  private readonly orders: PostgresOrderStore;

  constructor(private readonly pool: Pool) {
    this.orders = new PostgresOrderStore({ pool });
  }

  async listTasks(input: { actor: ActorContext; status?: StaffTaskStatus; type?: StaffTaskType; limit: number }): Promise<SupportTaskView[]> {
    requireStaff(input.actor);
    const l1Scope = input.actor.actorLevel === 'L1_SUPPORT';
    const result = await this.pool.query<SupportTaskJoinedRow>(
      `SELECT task.*, orders.public_id AS order_public_id, orders.guild_id AS order_guild_id,
              orders.channel_id AS order_channel_id, orders.voice_channel_id AS order_voice_channel_id,
              orders.game_name_snapshot, orders.game_code_snapshot, orders.service_name_snapshot,
              orders.service_code_snapshot, orders.amount_minor AS order_amount_minor,
              orders.currency AS order_currency, customers.display_name AS customer_display_name
       FROM staff_tasks task
       LEFT JOIN orders ON orders.id = task.order_id
       LEFT JOIN users customers ON customers.id = orders.customer_id
       WHERE ($1::boolean = false OR task.status = 'OPEN' OR task.claimed_by_staff_id = $2::uuid)
         AND ($3::text IS NULL OR task.status::text = $3)
         AND ($4::text IS NULL OR task.type::text = $4)
         AND orders.guild_id = $5
       ORDER BY CASE task.response_status WHEN 'OVERDUE' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END ASC,
                task.response_due_at ASC NULLS LAST, task.created_at ASC, task.id ASC
       LIMIT $6`,
      [l1Scope, input.actor.actorStaffId, input.status ?? null, input.type ?? null, input.actor.guildId, input.limit]
    );
    return result.rows.map((row) => buildTaskView(mapTask(row), input.actor, orderContextFromRow(row)));
  }

  async getTask(input: { taskId: string; actor: ActorContext }): Promise<SupportTaskView> {
    requireStaff(input.actor);
    const result = await this.pool.query<SupportTaskJoinedRow>(
      `SELECT task.*, orders.public_id AS order_public_id, orders.guild_id AS order_guild_id,
              orders.channel_id AS order_channel_id, orders.voice_channel_id AS order_voice_channel_id,
              orders.game_name_snapshot, orders.game_code_snapshot, orders.service_name_snapshot,
              orders.service_code_snapshot, orders.amount_minor AS order_amount_minor,
              orders.currency AS order_currency, customers.display_name AS customer_display_name
       FROM staff_tasks task
       LEFT JOIN orders ON orders.id = task.order_id
       LEFT JOIN users customers ON customers.id = orders.customer_id
       WHERE task.id = $1 AND orders.guild_id = $2`,
      [input.taskId, input.actor.guildId]
    );
    if (!result.rows[0]) throw new SupportWorkbenchError('NOT_FOUND', 'Staff task was not found.');
    const task = mapTask(result.rows[0]);
    if (!canViewTask(task, input.actor, orderContextFromRow(result.rows[0]))) throw new SupportWorkbenchError('PERMISSION_DENIED', 'The task is outside the current staff scope.');
    return buildTaskView(task, input.actor, orderContextFromRow(result.rows[0]));
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
    const participants = await this.pool.query<{
      id: string;
      player_id: string;
      player_display_name_snapshot: string;
      ready_at: Date | string | null;
    }>(`SELECT id, player_id, player_display_name_snapshot, ready_at
        FROM order_participants
        WHERE order_id = $1 AND status = 'ACTIVE'
        ORDER BY created_at, id`, [input.orderId]);
    return buildOrderView(order, participants.rows.map((participant) => ({
      participantId: participant.id,
      playerId: participant.player_id,
      displayName: participant.player_display_name_snapshot,
      readiness: participant.ready_at ? 'READY' : 'NOT_READY'
    })));
  }
}

export function registerSupportWorkbenchRoutes(server: FastifyInstance, options: { store: SupportWorkbenchStore; now?: () => Date; registerOrderRoute?: boolean }): void {
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
      return options.store.getTask({ taskId: taskId(request), actor });
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
  if (options.registerOrderRoute !== false) {
    registerSecureReadRoute(server, security, {
      method: 'GET', url: '/api/v1/admin/orders/:orderId', permission: 'staff_task.read', action: 'GET_ADMIN_ORDER', targetType: 'order',
      targetId: orderId, acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], handler: (request, actor) => options.store.getOrder({ orderId: orderId(request), taskId: queryTaskId(request), actor }), mapError
    });
  }
}

function buildOrderView(order: OrderRecord, participants: SupportReadinessParticipant[]) {
  const lifecycle = order as OrderRecord & { readyDeadlineAt?: string | null; startedAt?: string | null };
  const readiness = {
    participants,
    allActivePlayersReady: participants.length > 0 && participants.every((participant) => participant.readiness === 'READY'),
    readyDeadlineAt: lifecycle.readyDeadlineAt ?? null,
    startedAt: lifecycle.startedAt ?? null,
    staffTaskId: null
  };
  const automation = { state: order.automationState, version: order.automationVersion, scope: order.automationScope, reasonCode: order.automationReasonCode,
    pausedAt: order.automationPausedAt, resumedAt: order.automationResumedAt, expiresAt: order.automationExpiresAt };
  const matching = order.status === 'PENDING_DISPATCH'
    ? { stage: 'SEARCHING', nextStep: 'WAIT_FOR_PLAYER' }
    : order.status === 'ACCEPTED' ? { stage: 'ACCEPTED', nextStep: 'CONFIRM_READINESS' } : null;
  return { order: clone(order), matching, readiness, automation, transactions: [], resolutions: [], events: [] };
}

function inMemoryReadinessParticipants(order: OrderRecord): SupportReadinessParticipant[] {
  const participants = (order as OrderRecord & {
    participants?: Array<{ id: string; playerId: string; displayName: string; readyAt: string | null }>;
  }).participants ?? [];
  return participants.map((participant) => ({
    participantId: participant.id,
    playerId: participant.playerId,
    displayName: participant.displayName,
    readiness: participant.readyAt ? 'READY' : 'NOT_READY'
  }));
}

function canViewTask(task: StaffTaskRecord, actor: ActorContext, order: TaskOrderContext | OrderRecord | null): boolean {
  requireStaff(actor);
  const context = task.contextSnapshot as { guildId?: unknown };
  const taskGuildId = stringValue(context.guildId) ?? order?.guildId ?? null;
  if (taskGuildId && taskGuildId !== actor.guildId) return false;
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
  response_status: SupportResponseStatus; response_due_at: Date|string|null; first_responded_at: Date|string|null;
}
interface SupportTaskJoinedRow extends StaffTaskRow {
  order_public_id: string | null; order_guild_id: string | null; order_channel_id: string | null; order_voice_channel_id: string | null;
  game_name_snapshot: string | null; game_code_snapshot: string | null; service_name_snapshot: string | null; service_code_snapshot: string | null;
  order_amount_minor: string | number | null; order_currency: string | null; customer_display_name: string | null;
}
interface TaskOrderContext {
  publicId: string | null; guildId: string | null; customerDisplayName: string | null; gameDisplayName: string | null;
  serviceDisplayName: string | null; amountMinor: number | null; currency: string | null;
  channelSpec: { channelId: string | null; voiceChannelId: string | null };
}
function mapTask(row: StaffTaskRow): StaffTaskRecord {
  return { id: row.id, publicId: row.public_id, type: row.type, reasonCode: row.reason_code, status: row.status, version: row.row_version,
    orderId: row.order_id, giftRequestId: row.gift_request_id, claimedBy: row.claimed_by_staff_id, resolvedBy: row.resolved_by_staff_id,
    requiredLevel: 'L1_SUPPORT', voiceChannelId: row.voice_channel_id, contextSnapshot: row.context_snapshot,
    responseStatus:row.response_status,responseDueAt:row.response_due_at?new Date(row.response_due_at).toISOString():null,
    firstRespondedAt:row.first_responded_at?new Date(row.first_responded_at).toISOString():null,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}

function orderContextFromRow(row: SupportTaskJoinedRow): TaskOrderContext {
  return {
    publicId: row.order_public_id, guildId: row.order_guild_id, customerDisplayName: row.customer_display_name,
    gameDisplayName: row.game_name_snapshot ?? row.game_code_snapshot,
    serviceDisplayName: row.service_name_snapshot ?? row.service_code_snapshot,
    amountMinor: row.order_amount_minor === null ? null : Number(row.order_amount_minor), currency: row.order_currency,
    channelSpec: { channelId: row.order_channel_id, voiceChannelId: row.order_voice_channel_id }
  };
}

function buildTaskView(task: StaffTaskRecord, actor: ActorContext, order: TaskOrderContext | OrderRecord | null): SupportTaskView {
  const context = task.contextSnapshot as Record<string, unknown>;
  const guildId = validSnowflake(stringValue(context.guildId) ?? order?.guildId ?? actor.guildId);
  const channelId = validSnowflake(stringValue(context.channelId) ?? order?.channelSpec.channelId ?? null);
  const voiceChannelId = validSnowflake(stringValue(context.voiceChannelId) ?? task.voiceChannelId ?? order?.channelSpec.voiceChannelId ?? null);
  const orderPublicId = stringValue(context.orderPublicId) ?? stringValue(context.publicId) ?? order?.publicId ?? null;
  const customerDisplayName = stringValue(context.customerDisplayName) ?? stringValue(context.customerDisplay)
    ?? ('customerDisplayName' in (order ?? {}) ? (order as TaskOrderContext).customerDisplayName : null);
  const gameDisplayName = stringValue(context.gameDisplayName) ?? stringValue(context.game)
    ?? ('gameDisplayName' in (order ?? {}) ? order!.gameDisplayName ?? null : null);
  const serviceDisplayName = stringValue(context.serviceDisplayName) ?? stringValue(context.service)
    ?? ('serviceDisplayName' in (order ?? {}) ? order!.serviceDisplayName ?? null : null);
  const contextAmount = integerValue(context.amountMinor) ?? integerValue(context.priceMinor);
  const amountMinor = contextAmount ?? order?.amountMinor ?? null;
  const currency = stringValue(context.currency) ?? order?.currency ?? null;
  return {
    ...clone(task),
    triage: {
      orderPublicId, customerDisplayName, gameDisplayName, serviceDisplayName, amountMinor, currency,
      reasonLabel: reasonLabel(task.reasonCode, task.type), waitStartedAt: task.createdAt, nextActionLabel: nextActionLabel(task)
    },
    links: {
      orderChannel: guildId && channelId ? discordChannelUrl(guildId, channelId) : null,
      voiceChannel: guildId && voiceChannelId ? discordChannelUrl(guildId, voiceChannelId) : null
    }
  };
}

function compareTriagePriority(left: StaffTaskRecord, right: StaffTaskRecord): number {
  const priority = (task: StaffTaskRecord) => task.responseStatus === 'OVERDUE' ? 0 : task.responseStatus === 'PENDING' ? 1 : 2;
  const byPriority = priority(left) - priority(right);
  if (byPriority) return byPriority;
  const byDueAt = (left.responseDueAt ?? '9999').localeCompare(right.responseDueAt ?? '9999');
  if (byDueAt) return byDueAt;
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function nextActionLabel(task: StaffTaskRecord): string {
  if (task.status === 'OPEN') return task.responseStatus === 'OVERDUE' ? '立即认领并联系客户' : '认领并联系客户';
  if (task.status === 'CLAIMED') return '继续处理客户请求';
  if (task.status === 'PENDING_APPROVAL') return '等待主管处理';
  return '查看处理结果';
}

function reasonLabel(reasonCode: string, type: StaffTaskType): string {
  const labels: Record<string, string> = {
    ORDER_ASSIST_REQUESTED: '客户请求订单协助', CUSTOMER_CANCEL_AFTER_ACCEPT: '客户申请取消已接订单',
    GIFT_REQUESTED: '礼物请求待审核', FIRST_RESPONSE_OVERDUE: '客户等待客服首响超时', AUTOMATION_FAILED: '自动流程执行失败'
  };
  return labels[reasonCode] ?? ({ ORDER_ASSIST: '订单需要客服协助', CANCELLATION_ASSIST: '取消请求需要客服协助', GIFT_REVIEW: '礼物请求待审核',
    PLAYER_START_LATE: '陪玩开始服务延迟', PLAYER_NO_SHOW: '陪玩未到场', CUSTOMER_NO_SHOW: '客户未到场', SERVICE_INTERRUPTED: '服务发生中断',
    COMPLETION_REVIEW: '订单完成待核对', DISPUTE: '订单争议待处理', AUTOMATION_FAILURE: '自动流程执行失败' } satisfies Record<StaffTaskType, string>)[type];
}

function discordChannelUrl(guildId: string, channelId: string): string { return `https://discord.com/channels/${guildId}/${channelId}`; }
function validSnowflake(value: string | null): string | null { return value && /^\d{17,20}$/.test(value) ? value : null; }
function stringValue(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
function integerValue(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
