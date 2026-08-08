import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { WalletFundingService } from './wallet.js';
import { registerSecureReadRoute, registerSecureWriteRoute, type ActorContext, type StaffLevel } from './security.js';
import { decodeKeysetCursor, encodeKeysetCursor } from './signed-cursor.js';
import {
  activeReservationStatuses,
  reservationRemainingMinorSql,
  reservationSettlementLateralSql
} from './reservation-balance.js';

export type CustomerProfileWindow = 'DAYS_30' | 'DAYS_90' | 'ALL';
export type CustomerProfileConsumptionType = 'ORDER' | 'GIFT' | 'REFUND_REVERSAL' | 'ADMIN_CORRECTION';

export interface CustomerProfileUser {
  id: string; guildId: string; discordUserId: string; displayName: string; status: string; version?:number;
}
export interface CustomerProfileOrder {
  id: string; publicId: string; customerId: string; guildId: string; status: string; gameKey: string | null; serviceKey: string | null;
  playerUserId: string | null; playerDisplayName: string | null; amountMinor: number; currency: string; createdAt: string;
  completedAt: string | null; assignedStaffIds?: string[];
}
export interface CustomerProfileConsumption {
  id: string; userId: string; type: CustomerProfileConsumptionType; sourceId: string; orderId: string | null;
  amountMinor: number; currency: string; occurredAt: string; guildId?: string;
}
export interface CustomerProfileScopeInput { userId: string; actorStaffId: string; actorLevel: StaffLevel; guildId: string }
export interface CustomerProfileScope {
  canReadCustomer(input: CustomerProfileScopeInput): Promise<boolean> | boolean;
}
export interface CustomerStatistics {
  window: CustomerProfileWindow; orderCount: number; activeOrderCount: number; completedOrderCount: number; cancelledOrderCount: number;
  refundCount: number; orderSpendMinor: number; giftSpendMinor: number; refundMinor: number; totalConsumptionMinor: number;
  averageOrderAmountMinor: number; lastConsumptionAt: string | null; currency: string;
}
export interface CustomerProfileSummaryData {
  user: CustomerProfileUser;
  statistics: CustomerStatistics;
  preferences: { preferredGameKeys: string[]; preferredServiceKeys: string[]; preferredPlayerUserIds: string[]; lastOrderAt: string | null };
  internalNotes: Array<{ id: string; text: string; createdAt: string }>;
  riskFlags: string[];
}
export interface CustomerProfileNote { id: string; text: string; createdAt: string }
export interface Page<T> { items: T[]; nextCursor: string | null }

export interface CustomerProfileStore extends CustomerProfileScope {
  getSummaryData(input: CustomerProfileScopeInput & { window: CustomerProfileWindow; now: Date }): Promise<CustomerProfileSummaryData | null>;
  appendNote(input: CustomerProfileScopeInput & { body: string; now: Date }): Promise<CustomerProfileNote>;
  updateDisplayName(input:CustomerProfileScopeInput&{displayName:string;expectedVersion:number;reasonCode:string;note:string|null;now:Date}):Promise<CustomerProfileUser>;
  listOrders(input: CustomerProfileScopeInput & { cursor: string | null; limit: number }): Promise<Page<CustomerProfileOrder>>;
  sumActiveReservations(input: { userId: string; currency: string; guildId?: string }): Promise<number>;
  countActiveReservations(input: { userId: string; currency?: string; guildId?: string }): Promise<number> | number;
}

export class CustomerProfileError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'VALIDATION_ERROR'|'CONFLICT', message: string) { super(message); this.name = 'CustomerProfileError'; }
}

export class InMemoryCustomerProfileStore implements CustomerProfileStore {
  readonly users: CustomerProfileUser[];
  readonly orders: CustomerProfileOrder[];
  readonly consumptions: CustomerProfileConsumption[];
  private readonly reservations: Array<{ userId: string; currency: string; remainingMinor: number; guildId?: string }>;
  private readonly notes: Array<{ id: string; userId: string; guildId?: string; text: string; authorStaffId: string; createdAt: string }>;
  private readonly riskFlags: Array<{ userId: string; value: string }>;

  constructor(input: { users?: CustomerProfileUser[]; orders?: CustomerProfileOrder[]; consumptions?: CustomerProfileConsumption[];
    reservations?: Array<{ userId: string; currency: string; remainingMinor: number; guildId?: string }>;
    notes?: Array<{ id: string; userId: string; guildId?: string; text: string; authorStaffId: string; createdAt: string }>;
    riskFlags?: Array<{ userId: string; value: string }> } = {}) {
    this.users = clone(input.users ?? []); this.orders = clone(input.orders ?? []); this.consumptions = clone(input.consumptions ?? []);
    this.reservations = clone(input.reservations ?? []);
    this.notes = clone(input.notes ?? []); this.riskFlags = clone(input.riskFlags ?? []);
  }

  canReadCustomer(input: CustomerProfileScopeInput): boolean {
    const user = this.users.find((item) => item.id === input.userId && item.guildId === input.guildId);
    if (!user) return false;
    if (input.actorLevel !== 'L1_SUPPORT') return true;
    return this.orders.some((item) => item.customerId === input.userId && item.guildId === input.guildId && item.assignedStaffIds?.includes(input.actorStaffId));
  }

  async getSummaryData(input: CustomerProfileScopeInput & { window: CustomerProfileWindow; now: Date }): Promise<CustomerProfileSummaryData | null> {
    if (!this.canReadCustomer(input)) return null;
    const user = this.users.find((item) => item.id === input.userId && item.guildId === input.guildId)!;
    const lowerBound = windowStart(input.window, input.now);
    const orders = this.orders.filter((item) => item.customerId === input.userId && item.guildId === input.guildId && inWindow(item.createdAt, lowerBound, input.now));
    const scopedOrderIds = new Set(this.orders.filter((item) => item.customerId === input.userId && item.guildId === input.guildId).map((item) => item.id));
    const entries = this.consumptions.filter((item) => item.userId === input.userId && (item.guildId === input.guildId || !!item.orderId && scopedOrderIds.has(item.orderId))
      && inWindow(item.occurredAt, lowerBound, input.now));
    return {
      user: clone(user), statistics: buildStatistics(input.window, orders, entries),
      preferences: buildPreferences(this.orders.filter((item) => item.customerId === input.userId && item.guildId === input.guildId)),
      internalNotes: this.notes.filter((item) => item.userId === input.userId && item.guildId === input.guildId).sort(descCreated).slice(0, 100)
        .map(({ id, text, createdAt }) => ({ id, text, createdAt })),
      riskFlags: this.riskFlags.filter((item) => item.userId === input.userId).map((item) => item.value)
    };
  }

  async listOrders(input: CustomerProfileScopeInput & { cursor: string | null; limit: number }): Promise<Page<CustomerProfileOrder>> {
    if (!this.canReadCustomer(input)) throw new CustomerProfileError('NOT_FOUND', 'Customer was not found.');
    const items = this.orders.filter((item) => item.customerId === input.userId && item.guildId === input.guildId).sort(descCreated);
    return page(items, input.cursor, input.limit, 'customer_orders');
  }

  async appendNote(input: CustomerProfileScopeInput & { body: string; now: Date }): Promise<CustomerProfileNote> {
    if (!this.canReadCustomer(input)) throw new CustomerProfileError('NOT_FOUND', 'Customer was not found.');
    const note = { id: crypto.randomUUID(), userId: input.userId, guildId: input.guildId, text: input.body,
      authorStaffId: input.actorStaffId, createdAt: input.now.toISOString() };
    this.notes.push(note);
    return { id: note.id, text: note.text, createdAt: note.createdAt };
  }

  async updateDisplayName(input:CustomerProfileScopeInput&{displayName:string;expectedVersion:number;reasonCode:string;note:string|null;now:Date}){
    if(!this.canReadCustomer(input))throw new CustomerProfileError('NOT_FOUND','Customer was not found.');
    const index=this.users.findIndex((item)=>item.id===input.userId&&item.guildId===input.guildId);const current=this.users[index]!;const version=current.version??1;
    if(version!==input.expectedVersion)throw new CustomerProfileError('CONFLICT','Customer profile version is stale.');
    const updated={...current,displayName:input.displayName,version:version+1};this.users[index]=updated;return clone(updated);
  }

  async sumActiveReservations(input: { userId: string; currency: string; guildId?: string }): Promise<number> {
    return sum(this.reservations.filter((item) => item.userId === input.userId && item.currency === input.currency
      && (!input.guildId || !item.guildId || item.guildId === input.guildId)).map((item) => item.remainingMinor));
  }
  countActiveReservations(input: { userId: string; currency?: string; guildId?: string }): number {
    return this.reservations.filter((item) => item.userId === input.userId && (!input.currency || item.currency === input.currency)
      && (!input.guildId || !item.guildId || item.guildId === input.guildId) && item.remainingMinor > 0).length;
  }
}

export class PostgresCustomerProfileStore implements CustomerProfileStore {
  constructor(private readonly pool: Pool) {}

  async canReadCustomer(input: CustomerProfileScopeInput): Promise<boolean> {
    const result = await this.pool.query(`SELECT EXISTS (
      SELECT 1 FROM users u JOIN discord_accounts da ON da.user_id=u.id AND da.guild_id=$4
      WHERE u.id=$1 AND ($3::text<>'L1_SUPPORT' OR EXISTS (
        SELECT 1 FROM orders o WHERE o.customer_id=u.id AND o.guild_id=$4 AND (
          o.automation_paused_by_staff_id=$2 OR EXISTS (
            SELECT 1 FROM staff_tasks task WHERE task.order_id=o.id AND task.claimed_by_staff_id=$2
              AND task.status IN ('CLAIMED','VERIFIED','PENDING_APPROVAL')
          )
        )
      ))
    ) visible`, [input.userId, input.actorStaffId, input.actorLevel, input.guildId]);
    return result.rows[0]?.visible === true;
  }

  async getSummaryData(input: CustomerProfileScopeInput & { window: CustomerProfileWindow; now: Date }): Promise<CustomerProfileSummaryData | null> {
    if (!await this.canReadCustomer(input)) return null;
    const lowerBound = windowStart(input.window, input.now);
    const identity = await this.pool.query(`SELECT u.id,u.display_name,u.status::text,u.row_version,da.discord_user_id
      FROM users u JOIN discord_accounts da ON da.user_id=u.id AND da.guild_id=$2
      WHERE u.id=$1 ORDER BY da.last_seen_at DESC NULLS LAST,da.id LIMIT 1`, [input.userId, input.guildId]);
    const row = identity.rows[0];
    if (!row) return null;
    const [orderRows, entryRows, preferenceRows, noteRows, riskRows] = await Promise.all([
      this.pool.query(`SELECT id,public_id,status::text,game_code_snapshot,service_code_snapshot,player_id,amount_minor,currency,created_at,completed_at
        FROM orders WHERE customer_id=$1 AND guild_id=$2 AND ($3::timestamptz IS NULL OR created_at >= $3) AND created_at <= $4`,
      [input.userId, input.guildId, lowerBound, input.now]),
      this.pool.query(`SELECT ce.id,ce.entry_type::text,ce.direction::text,ce.source_id,ce.order_id,ce.amount_minor,ce.currency,ce.occurred_at
        FROM consumption_entries ce WHERE ce.user_id=$1 AND ($3::timestamptz IS NULL OR ce.occurred_at >= $3) AND ce.occurred_at <= $4
        AND ${consumptionGuildPredicate('ce', '$2')}`,
      [input.userId, input.guildId, lowerBound, input.now]),
      this.pool.query(`SELECT o.game_code_snapshot,o.service_code_snapshot,o.player_id,o.created_at
        FROM orders o WHERE o.customer_id=$1 AND o.guild_id=$2 ORDER BY o.created_at DESC LIMIT 100`, [input.userId, input.guildId]),
      this.pool.query(`SELECT id,body,created_at FROM customer_profile_notes WHERE user_id=$1 AND guild_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100`, [input.userId, input.guildId]),
      this.pool.query(`SELECT type::text FROM risk_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [input.userId])
    ]);
    const orders = orderRows.rows.map((item) => mapOrder(item, input.userId, input.guildId));
    const consumptions = entryRows.rows.map(mapConsumption);
    const preferenceOrders = preferenceRows.rows.map((item) => ({ ...mapOrder(item, input.userId, input.guildId), id: String(item.id ?? crypto.randomUUID()), publicId: String(item.public_id ?? '') }));
    return {
      user: { id: row.id, guildId: input.guildId, discordUserId: row.discord_user_id, displayName: row.display_name, status: row.status,version:Number(row.row_version) },
      statistics: buildStatistics(input.window, orders, consumptions), preferences: buildPreferences(preferenceOrders),
      internalNotes: noteRows.rows.map((item) => ({ id: item.id, text: item.body, createdAt: iso(item.created_at) })),
      riskFlags: riskRows.rows.map((item) => item.type)
    };
  }

  async listOrders(input: CustomerProfileScopeInput & { cursor: string | null; limit: number }): Promise<Page<CustomerProfileOrder>> {
    if (!await this.canReadCustomer(input)) throw new CustomerProfileError('NOT_FOUND', 'Customer was not found.');
    const cursor = decodeCursor(input.cursor, 'customer_orders');
    const result = await this.pool.query(`SELECT o.id,o.public_id,o.status::text,o.game_code_snapshot,o.service_code_snapshot,o.player_id,
      player.display_name player_display_name,o.amount_minor,o.currency,o.created_at,o.completed_at
      FROM orders o LEFT JOIN users player ON player.id=o.player_id
      WHERE o.customer_id=$1 AND o.guild_id=$2 AND ($3::timestamptz IS NULL OR (o.created_at,o.id)<($3,$4::uuid))
      ORDER BY o.created_at DESC,o.id DESC LIMIT $5`, [input.userId, input.guildId, cursor?.createdAt ?? null, cursor?.id ?? null, input.limit + 1]);
    const items = result.rows.map((item) => mapOrder(item, input.userId, input.guildId));
    return pageFromSorted(items, input.limit, 'customer_orders');
  }

  async appendNote(input: CustomerProfileScopeInput & { body: string; now: Date }): Promise<CustomerProfileNote> {
    const noteId = crypto.randomUUID();
    const result = await this.pool.query(`WITH visible_customer AS (
      SELECT u.id FROM users u
      WHERE u.id=$2 AND EXISTS (SELECT 1 FROM discord_accounts da WHERE da.user_id=u.id AND da.guild_id=$5)
      AND ($4::text<>'L1_SUPPORT' OR EXISTS (
        SELECT 1 FROM orders o WHERE o.customer_id=u.id AND o.guild_id=$5 AND (
          o.automation_paused_by_staff_id=$3 OR EXISTS (
            SELECT 1 FROM staff_tasks task WHERE task.order_id=o.id AND task.claimed_by_staff_id=$3
              AND task.status IN ('CLAIMED','VERIFIED','PENDING_APPROVAL')
          )
        )
      )) LIMIT 1
    )
    INSERT INTO customer_profile_notes (id,user_id,guild_id,author_staff_id,body,created_at)
    SELECT $1,visible_customer.id,$5,$3,$6,$7 FROM visible_customer
    RETURNING id,body,created_at`, [noteId, input.userId, input.actorStaffId, input.actorLevel, input.guildId, input.body, input.now]);
    const row = result.rows[0];
    if (!row) throw new CustomerProfileError('NOT_FOUND', 'Customer was not found.');
    return { id: row.id, text: row.body, createdAt: iso(row.created_at) };
  }

  async updateDisplayName(input:CustomerProfileScopeInput&{displayName:string;expectedVersion:number;reasonCode:string;note:string|null;now:Date}){
    if(!await this.canReadCustomer(input))throw new CustomerProfileError('NOT_FOUND','Customer was not found.');
    const result=await this.pool.query(`UPDATE users SET display_name=$3,row_version=row_version+1,updated_at=$4 WHERE id=$1 AND row_version=$2 AND EXISTS (SELECT 1 FROM discord_accounts da WHERE da.user_id=users.id AND da.guild_id=$5) RETURNING id,display_name,status::text,row_version`,[input.userId,input.expectedVersion,input.displayName,input.now,input.guildId]);
    if(!result.rows[0])throw new CustomerProfileError('CONFLICT','Customer profile version is stale.');const row=result.rows[0];return{id:row.id,guildId:input.guildId,discordUserId:'',displayName:row.display_name,status:row.status,version:Number(row.row_version)};
  }

  async sumActiveReservations(input: { userId: string; currency: string; guildId?: string }): Promise<number> {
    const settlementJoin = reservationSettlementLateralSql('fr', 'settlement');
    const remainingMinor = reservationRemainingMinorSql('fr', 'settlement');
    const result = await this.pool.query(`SELECT COALESCE(sum(${remainingMinor}),0) total
      FROM fund_reservations fr ${settlementJoin}
      WHERE fr.user_id=$1 AND fr.currency=$2 AND fr.status IN (${activeReservationStatuses.map(status => `'${status}'`).join(',')})
      AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM orders scoped_order LEFT JOIN gift_requests scoped_gift ON scoped_gift.order_id=scoped_order.id
        WHERE scoped_order.guild_id=$3 AND (fr.order_id=scoped_order.id OR fr.gift_request_id=scoped_gift.id)))`,
    [input.userId, input.currency, input.guildId ?? null]);
    return safeInteger(result.rows[0]?.total ?? 0);
  }
  async countActiveReservations(input: { userId: string; currency?: string; guildId?: string }): Promise<number> {
    const settlementJoin = reservationSettlementLateralSql('fr', 'settlement');
    const remainingMinor = reservationRemainingMinorSql('fr', 'settlement');
    const result = await this.pool.query(`SELECT count(*)::int total FROM fund_reservations fr ${settlementJoin}
      WHERE fr.user_id=$1 AND ($2::text IS NULL OR fr.currency=$2)
      AND fr.status IN (${activeReservationStatuses.map(status => `'${status}'`).join(',')}) AND ${remainingMinor}>0
      AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM orders scoped_order LEFT JOIN gift_requests scoped_gift ON scoped_gift.order_id=scoped_order.id
        WHERE scoped_order.guild_id=$3 AND (fr.order_id=scoped_order.id OR fr.gift_request_id=scoped_gift.id)))`,
      [input.userId, input.currency ?? null, input.guildId ?? null]);
    return Number(result.rows[0]?.total ?? 0);
  }
}

export async function getAdminCustomerProfileSummary(input: { store: CustomerProfileStore; walletFunding: WalletFundingService;
  actor: ActorContext; userId: string; window: CustomerProfileWindow; now: Date }) {
  const scope = actorScope(input.actor, input.userId);
  const summary = await input.store.getSummaryData({ ...scope, window: input.window, now: input.now });
  if (!summary) throw new CustomerProfileError('NOT_FOUND', 'Customer was not found.');
  const { user } = summary;
  const walletBalance=await input.walletFunding.getBalance({userId:user.id,now:input.now});
  return {
    user: { userId: user.id, discordUserId: user.discordUserId, displayName: user.displayName, status: user.status,version:user.version??1 },
    balance: walletBalance,
    statistics: summary.statistics, preferences: summary.preferences, internalNotes: summary.internalNotes, riskFlags: summary.riskFlags
  };
}

export async function appendAdminCustomerProfileNote(input: { store: CustomerProfileStore; actor: ActorContext; userId: string; body: unknown; now: Date }) {
  const body = normalizeNoteBody(input.body);
  return input.store.appendNote({ ...actorScope(input.actor, input.userId), body, now: input.now });
}
export async function updateAdminCustomerProfile(input:{store:CustomerProfileStore;actor:ActorContext;userId:string;body:unknown;now:Date}){const body=parseProfileUpdate(input.body);return input.store.updateDisplayName({...actorScope(input.actor,input.userId),...body,now:input.now});}

export function registerCustomerProfileRoutes(server: FastifyInstance, options: { store: CustomerProfileStore;
  walletFunding: WalletFundingService; now?: () => Date }): void {
  if (!server.securityOptions) throw new Error('Customer profile routes require security options.');
  const security = server.securityOptions; const now = options.now ?? (() => new Date());
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/admin/users/:userId/profile-summary',
    permission: 'customer_profile.read', requiredFeature: 'M6', action: 'GET_ADMIN_CUSTOMER_PROFILE_SUMMARY', targetType: 'user',
    targetId: (request) => param(request, 'userId'), acceptedSources: ['DASHBOARD'], mapError,
    handler: (request, actor) => getAdminCustomerProfileSummary({ store: options.store, walletFunding: options.walletFunding,
      actor, userId: param(request, 'userId'), window: profileWindow(request), now: now() }) });
  registerSecureWriteRoute(server,security,{method:'PATCH',url:'/api/v1/admin/users/:userId/profile-summary',permission:'customer_profile.manage',requiredFeature:'M6',action:'UPDATE_ADMIN_CUSTOMER_PROFILE',targetType:'user',targetId:(request)=>param(request,'userId'),acceptedSources:['DASHBOARD'],mapError,
    fingerprintBody:(request)=>parseProfileUpdate(request.body),successReason:(request)=>parseProfileUpdate(request.body).reasonCode,
    auditSnapshots:(_request,_actor,payload)=>({afterSnapshot:{displayName:(payload as CustomerProfileUser).displayName,version:(payload as CustomerProfileUser).version}}),
    handler:(request,actor)=>updateAdminCustomerProfile({store:options.store,actor,userId:param(request,'userId'),body:request.body,now:now()})});
  registerSecureWriteRoute(server, security, { method: 'POST', url: '/api/v1/admin/users/:userId/profile-notes',
    permission: 'customer_profile.note.append', requiredFeature: 'M6', action: 'APPEND_ADMIN_CUSTOMER_PROFILE_NOTE', targetType: 'customer_profile_note',
    targetId: (request) => param(request, 'userId'), acceptedSources: ['DASHBOARD'], successStatusCode: 201,
    fingerprintBody: (request) => ({ body: parseNoteRequest(request.body) }), mapError,
    auditSnapshots: (_request, _actor, payload) => ({ afterSnapshot: { id: (payload as CustomerProfileNote).id, appendOnly: true } }),
    handler: (request, actor) => appendAdminCustomerProfileNote({ store: options.store, actor, userId: param(request, 'userId'), body: parseNoteRequest(request.body), now: now() }) });
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/admin/users/:userId/orders',
    permission: 'customer_profile.read', requiredFeature: 'M6', action: 'LIST_ADMIN_CUSTOMER_ORDERS', targetType: 'order',
    targetId: (request) => param(request, 'userId'), acceptedSources: ['DASHBOARD'], mapError,
    handler: (request, actor) => options.store.listOrders({ ...actorScope(actor, param(request, 'userId')), ...pageQuery(request) }) });
}

function actorScope(actor: ActorContext, userId: string): CustomerProfileScopeInput {
  if (!actor.actorStaffId || !actor.actorLevel || !actor.guildId) throw new CustomerProfileError('NOT_FOUND', 'Customer was not found.');
  return { userId, actorStaffId: actor.actorStaffId, actorLevel: actor.actorLevel, guildId: actor.guildId };
}
function profileWindow(request: FastifyRequest): CustomerProfileWindow { const value = String((request.query as { window?: unknown }).window ?? 'DAYS_30');
  if (value !== 'DAYS_30' && value !== 'DAYS_90' && value !== 'ALL') throw new CustomerProfileError('VALIDATION_ERROR', 'window is invalid.'); return value; }
function pageQuery(request: FastifyRequest) { const query = request.query as { cursor?: unknown; limit?: unknown }; const limit = Number(query.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CustomerProfileError('VALIDATION_ERROR', 'limit is invalid.');
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 500)) throw new CustomerProfileError('VALIDATION_ERROR', 'cursor is invalid.');
  return { cursor: query.cursor as string | undefined ?? null, limit }; }
function parseNoteRequest(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => key !== 'body'))
    throw new CustomerProfileError('VALIDATION_ERROR', 'body is invalid.');
  return normalizeNoteBody((value as { body?: unknown }).body);
}
function parseProfileUpdate(value:unknown){if(!value||typeof value!=='object'||Array.isArray(value))throw new CustomerProfileError('VALIDATION_ERROR','profile update is invalid.');const body=value as Record<string,unknown>;if(Object.keys(body).some((key)=>!['displayName','expectedVersion','reasonCode','note'].includes(key)))throw new CustomerProfileError('VALIDATION_ERROR','Only displayName can be updated.');const displayName=typeof body.displayName==='string'?body.displayName.trim():'';const reasonCode=typeof body.reasonCode==='string'?body.reasonCode.trim():'';const expectedVersion=Number(body.expectedVersion);const note=typeof body.note==='string'?body.note.trim():null;if(!displayName||displayName.length>80||!Number.isSafeInteger(expectedVersion)||expectedVersion<1||!reasonCode||reasonCode.length>50||(note?.length??0)>500)throw new CustomerProfileError('VALIDATION_ERROR','profile update fields are invalid.');return{displayName,expectedVersion,reasonCode,note};}
function normalizeNoteBody(body: unknown): string {
  if (typeof body !== 'string') throw new CustomerProfileError('VALIDATION_ERROR', 'body is invalid.');
  const normalized = body.trim();
  if (!normalized || normalized.length > 2000) throw new CustomerProfileError('VALIDATION_ERROR', 'body must contain 1 to 2000 characters.');
  return normalized;
}
function param(request: FastifyRequest, key: string) { return String((request.params as Record<string, unknown>)[key] ?? ''); }
function mapError(error: unknown) { if (!(error instanceof CustomerProfileError)) return null; return { statusCode: error.code === 'NOT_FOUND' ? 404 : error.code==='CONFLICT'?409:400, code: error.code, message: error.message }; }
export function consumptionGuildPredicate(alias: string, guildParameter: string) { return `EXISTS (
  SELECT 1 FROM orders scoped_order WHERE scoped_order.guild_id=${guildParameter} AND (
    scoped_order.id=${alias}.order_id
    OR EXISTS (SELECT 1 FROM gift_requests scoped_gift WHERE scoped_gift.id=${alias}.gift_request_id AND scoped_gift.order_id=scoped_order.id)
    OR EXISTS (SELECT 1 FROM refunds scoped_refund LEFT JOIN gift_requests refund_gift ON refund_gift.id=scoped_refund.gift_request_id
      WHERE scoped_refund.id=${alias}.refund_id AND (scoped_refund.order_id=scoped_order.id OR refund_gift.order_id=scoped_order.id))
    OR EXISTS (SELECT 1 FROM consumption_entries original LEFT JOIN gift_requests original_gift ON original_gift.id=original.gift_request_id
      LEFT JOIN refunds original_refund ON original_refund.id=original.refund_id LEFT JOIN gift_requests original_refund_gift ON original_refund_gift.id=original_refund.gift_request_id
      WHERE original.id=${alias}.reversal_of_entry_id AND (original.order_id=scoped_order.id OR original_gift.order_id=scoped_order.id
        OR original_refund.order_id=scoped_order.id OR original_refund_gift.order_id=scoped_order.id))
  ))`; }
function windowStart(window: CustomerProfileWindow, now: Date): Date | null { if (window === 'ALL') return null; return new Date(now.getTime() - (window === 'DAYS_30' ? 30 : 90) * 86_400_000); }
function inWindow(value: string, lower: Date | null, upper: Date) { const time = Date.parse(value); return Number.isFinite(time) && (!lower || time >= lower.getTime()) && time <= upper.getTime(); }
function buildStatistics(window: CustomerProfileWindow, orders: CustomerProfileOrder[], entries: CustomerProfileConsumption[]): CustomerStatistics {
  const orderSpendMinor = sum(entries.filter((item) => item.type === 'ORDER').map((item) => item.amountMinor));
  const giftSpendMinor = sum(entries.filter((item) => item.type === 'GIFT').map((item) => item.amountMinor));
  const refunds = entries.filter((item) => item.type === 'REFUND_REVERSAL');
  const refundMinor = sum(refunds.map((item) => Math.abs(item.amountMinor)));
  const corrections = sum(entries.filter((item) => item.type === 'ADMIN_CORRECTION').map((item) => item.amountMinor));
  const completedOrderCount = orders.filter((item) => item.status === 'COMPLETED').length;
  return { window, orderCount: orders.length, activeOrderCount: orders.filter((item) => ['PENDING_DISPATCH','ACCEPTED','IN_SERVICE','PENDING_CONFIRMATION','EXCEPTION'].includes(item.status)).length,
    completedOrderCount, cancelledOrderCount: orders.filter((item) => item.status === 'CANCELLED').length, refundCount: refunds.length,
    orderSpendMinor, giftSpendMinor, refundMinor, totalConsumptionMinor: orderSpendMinor + giftSpendMinor - refundMinor + corrections,
    averageOrderAmountMinor: completedOrderCount ? Math.floor(orderSpendMinor / completedOrderCount) : 0,
    lastConsumptionAt: entries.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0]?.occurredAt ?? null,
    currency: entries[0]?.currency ?? orders[0]?.currency ?? 'CAT' };
}
function buildPreferences(orders: CustomerProfileOrder[]) { const sorted = [...orders].sort(descCreated); return {
  preferredGameKeys: frequency(sorted.map((item) => item.gameKey)), preferredServiceKeys: frequency(sorted.map((item) => item.serviceKey)),
  preferredPlayerUserIds: frequency(sorted.map((item) => item.playerUserId)), lastOrderAt: sorted[0]?.createdAt ?? null }; }
function frequency(values: Array<string | null>) { const counts = new Map<string, number>(); for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort(([a, ac], [b, bc]) => bc - ac || a.localeCompare(b)).slice(0, 30).map(([value]) => value); }
function page<T extends { id: string; createdAt: string }>(items: T[], cursor: string | null, limit: number, resource: string): Page<T> { const decoded = decodeCursor(cursor, resource);
  const start = decoded ? items.findIndex((item) => item.id === decoded.id && item.createdAt === decoded.createdAt) + 1 : 0;
  if (decoded && start === 0) throw new CustomerProfileError('VALIDATION_ERROR', 'cursor is invalid.'); return pageFromSorted(items.slice(start), limit, resource); }
function pageFromSorted<T extends { id: string; createdAt: string }>(items: T[], limit: number, resource: string): Page<T> { const pageItems = items.slice(0, limit); const last = pageItems.at(-1);
  return { items: clone(pageItems), nextCursor: items.length > limit && last ? encodeCursor(resource, last) : null }; }
function encodeCursor(resource: string, item: { id: string; createdAt: string }) {
  if (resource !== 'customer_orders') throw new CustomerProfileError('VALIDATION_ERROR', 'cursor resource is invalid.');
  return encodeKeysetCursor('customer-orders', { id: item.id, at: item.createdAt });
}
function decodeCursor(value: string | null, resource: string): { id: string; createdAt: string } | null {
  if (!value) return null;
  try {
    if (resource !== 'customer_orders') throw new Error('invalid resource');
    const parsed = decodeKeysetCursor(value, 'customer-orders');
    return { id: parsed.id, createdAt: parsed.at };
  } catch { throw new CustomerProfileError('VALIDATION_ERROR', 'cursor is invalid.'); }
}
function mapOrder(row: Record<string, unknown>, customerId: string, guildId: string): CustomerProfileOrder { return { id: String(row.id), publicId: String(row.public_id ?? ''), customerId, guildId,
  status: String(row.status), gameKey: nullable(row.game_code_snapshot), serviceKey: nullable(row.service_code_snapshot), playerUserId: nullable(row.player_id),
  playerDisplayName: nullable(row.player_display_name), amountMinor: safeInteger(row.amount_minor ?? 0), currency: String(row.currency ?? 'CAT'),
  createdAt: iso(row.created_at), completedAt: row.completed_at ? iso(row.completed_at) : null }; }
function mapConsumption(row: Record<string, unknown>): CustomerProfileConsumption { const type = row.entry_type === 'ORDER_CHARGE' ? 'ORDER' : row.entry_type === 'GIFT_CHARGE' ? 'GIFT' : row.entry_type;
  const amount = safeInteger(row.amount_minor); return { id: String(row.id), userId: '', type: type as CustomerProfileConsumptionType, sourceId: String(row.source_id),
    orderId: nullable(row.order_id), amountMinor: row.direction === 'CREDIT' ? -amount : amount, currency: String(row.currency), occurredAt: iso(row.occurred_at) }; }
function nullable(value: unknown) { return value == null ? null : String(value); }
function iso(value: unknown) { return new Date(value as string | number | Date).toISOString(); }
function safeInteger(value: unknown) { const number = Number(value); if (!Number.isSafeInteger(number)) throw new CustomerProfileError('VALIDATION_ERROR', 'Amount exceeds the safe integer range.'); return number; }
function sum(values: number[]) { return values.reduce((total, value) => total + value, 0); }
function descCreated<T extends { createdAt: string }>(a: T, b: T) { return b.createdAt.localeCompare(a.createdAt); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
