import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  InMemoryAuditSink,
  insertPostgresAuditRecord,
  registerSecureReadRoute,
  registerSecureWriteRoute,
  type AuditRecord,
  type AuditSink,
  type ActorContext,
  type StaffLevel
} from './security.js';

export type OrderRequirementStatus = 'ACTIVE' | 'REMOVED';

export interface RequirementCatalog {
  id: string;
  status: 'ACTIVE' | 'DRAFT' | 'RETIRED';
  game: string;
  gameDisplayName: string;
  service: string;
  serviceDisplayName: string;
  region: string | null;
  regionDisplayName: string | null;
  billingUnitMinutes: number;
  customerUnitPriceMinor: number;
}

export interface OrderRequirementRecord {
  id: string;
  orderId: string;
  sourcePackageSlotId?: string | null;
  serviceCatalogVersionId: string;
  game: string;
  gameDisplayName: string;
  service: string;
  serviceDisplayName: string;
  region: string | null;
  regionDisplayName: string | null;
  billingUnitMinutes: number;
  unitCount: number;
  requestedPlayerCount: number;
  customerUnitPriceMinor: number;
  estimatedLinePriceMinor: number;
  filledPlayerCount: number;
  customerNote?: string | null;
  status: OrderRequirementStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RequirementPage {
  orderId: string;
  orderVersion: number;
  catalogSubtotalMinor: number;
  packageAdjustmentMinor: number;
  derivedTotalMinor: number;
  currency: 'CAT';
  items: OrderRequirementRecord[];
  nextCursor: string | null;
}

export interface RequirementMutationResult {
  orderId: string;
  orderVersion: number;
  derivedTotalMinor: number;
  currency: 'CAT';
  requirement: OrderRequirementRecord;
}

interface RequirementScope {
  orderId: string;
  actorGuildId: string;
  actorDiscordUserId: string;
}

export interface AddRequirementInput extends RequirementScope {
  serviceCatalogVersionId: string;
  unitCount: number;
  requestedPlayerCount: number;
  expectedOrderVersion: number;
  idempotencyKey: string;
  now: Date;
}

export interface UpdateRequirementInput extends RequirementScope {
  requirementId: string;
  expectedOrderVersion: number;
  expectedRequirementVersion: number;
  action: 'CHANGE_PROJECT' | 'CHANGE_QUANTITY' | 'CHANGE_NOTE' | 'REMOVE';
  serviceCatalogVersionId: string | null;
  unitCount: number | null;
  requestedPlayerCount: number | null;
  customerNote?: string | null;
  idempotencyKey: string;
  now: Date;
}

interface StagedRequirementWrite {
  data: RequirementMutationResult;
  commit(auditRecord: AuditRecord): Promise<void> | void;
}

export interface OrderRequirementStore {
  list(input: RequirementScope & { cursor: string | null; limit: number }): Promise<RequirementPage> | RequirementPage;
  add(input: AddRequirementInput): Promise<StagedRequirementWrite> | StagedRequirementWrite;
  update(input: UpdateRequirementInput): Promise<StagedRequirementWrite> | StagedRequirementWrite;
  listAdmin?(input: { orderId:string;actorStaffId:string;actorLevel:StaffLevel;guildId:string;cursor:string|null;limit:number }): Promise<RequirementPage> | RequirementPage;
}

export class OrderRequirementError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'VALIDATION_ERROR' | 'CONFLICT' | 'BUSINESS_RULE_ERROR', message: string) {
    super(message);
    this.name = 'OrderRequirementError';
  }
}

export interface RequirementOrder {
  id: string;
  guildId: string;
  customerDiscordUserId: string;
  status: string;
  version: number;
  amountMinor: number;
  sourcePackageVersionId?: string | null;
  compositionMode?: 'PACKAGE_DEFAULT' | 'CUSTOMIZED' | null;
}

export class InMemoryOrderRequirementStore implements OrderRequirementStore {
  readonly orders: RequirementOrder[];
  readonly requirements: OrderRequirementRecord[];
  private readonly catalogs: RequirementCatalog[];
  private readonly auditSink: AuditSink;
  private readonly eventKeys = new Set<string>();
  private readonly claimedOrderIdsByStaffId: Record<string,string[]>;

  constructor(input: { orders: RequirementOrder[]; catalogs: RequirementCatalog[]; requirements?: OrderRequirementRecord[]; auditSink?: AuditSink;claimedOrderIdsByStaffId?:Record<string,string[]> }) {
    this.orders = clone(input.orders);
    this.catalogs = clone(input.catalogs);
    this.requirements = clone(input.requirements ?? []);
    this.auditSink = input.auditSink ?? new InMemoryAuditSink();
    this.claimedOrderIdsByStaffId=clone(input.claimedOrderIdsByStaffId??{});
  }

  listAdmin(input:{orderId:string;actorStaffId:string;actorLevel:StaffLevel;guildId:string;cursor:string|null;limit:number}):RequirementPage{
    const order=this.orders.find((item)=>item.id===input.orderId&&item.guildId===input.guildId);if(!order)throw new OrderRequirementError('NOT_FOUND','Order was not found.');if(input.actorLevel==='L1_SUPPORT'&&!(this.claimedOrderIdsByStaffId[input.actorStaffId]??[]).includes(order.id))throw new OrderRequirementError('PERMISSION_DENIED','Order is outside the claimed task scope.');const offset=decodeCursor(input.cursor);const all=this.requirements.filter((item)=>item.orderId===order.id&&item.status==='ACTIVE').sort(sortCreated);const catalogSubtotalMinor=deriveTotal(all);const derivedTotalMinor=order.compositionMode==='PACKAGE_DEFAULT'?order.amountMinor:catalogSubtotalMinor;return{orderId:order.id,orderVersion:order.version,catalogSubtotalMinor,packageAdjustmentMinor:derivedTotalMinor-catalogSubtotalMinor,derivedTotalMinor,currency:'CAT',items:clone(all.slice(offset,offset+input.limit)),nextCursor:offset+input.limit<all.length?encodeCursor(offset+input.limit):null};
  }

  list(input: RequirementScope & { cursor: string | null; limit: number }): RequirementPage {
    const order = this.requireOrder(input);
    const offset = decodeCursor(input.cursor);
    const all = this.requirements.filter((item) => item.orderId === order.id && item.status === 'ACTIVE').sort(sortCreated);
    return {
      orderId: order.id,
      orderVersion: order.version,
      catalogSubtotalMinor: deriveTotal(all),
      packageAdjustmentMinor: order.compositionMode==='PACKAGE_DEFAULT'?order.amountMinor-deriveTotal(all):0,
      derivedTotalMinor: order.compositionMode==='PACKAGE_DEFAULT'?order.amountMinor:deriveTotal(all),
      currency: 'CAT',
      items: clone(all.slice(offset, offset + input.limit)),
      nextCursor: offset + input.limit < all.length ? encodeCursor(offset + input.limit) : null
    };
  }

  add(input: AddRequirementInput): StagedRequirementWrite {
    const order = this.requireMutableOrder(input, input.expectedOrderVersion);
    const catalog = this.requireCatalog(input.serviceCatalogVersionId);
    const requirement = buildRequirement({ id: crypto.randomUUID(), orderId: order.id, catalog, unitCount: input.unitCount, requestedPlayerCount: input.requestedPlayerCount, version: 1, now: input.now });
    const total = deriveTotal([...this.requirements, requirement]);
    const data = mutationResult(order, requirement, total);
    return { data, commit: async (audit) => {
      const current = this.requireMutableOrder(input, input.expectedOrderVersion);
      if (this.eventKeys.has(input.idempotencyKey)) return;
      await this.auditSink.append(audit);
      this.requirements.push(clone(requirement));
      current.version += 1;
      current.amountMinor = total;
      if(current.sourcePackageVersionId)current.compositionMode='CUSTOMIZED';
      this.eventKeys.add(input.idempotencyKey);
    } };
  }

  update(input: UpdateRequirementInput): StagedRequirementWrite {
    const order = this.requireMutableOrder(input, input.expectedOrderVersion);
    const existing = this.requirements.find((item) => item.id === input.requirementId && item.orderId === input.orderId);
    if (!existing) throw new OrderRequirementError('NOT_FOUND', 'Order requirement was not found.');
    if (existing.version !== input.expectedRequirementVersion) throw new OrderRequirementError('CONFLICT', 'Order requirement version is stale.');
    if (existing.status !== 'ACTIVE') throw new OrderRequirementError('BUSINESS_RULE_ERROR', 'Removed requirement cannot be changed.');
    const next = this.changeRequirement(existing, input);
    const total = deriveTotal(this.requirements.map((item) => item.id === next.id ? next : item));
    const data = mutationResult(order, next, total);
    return { data, commit: async (audit) => {
      const current = this.requireMutableOrder(input, input.expectedOrderVersion);
      const index = this.requirements.findIndex((item) => item.id === input.requirementId && item.orderId === input.orderId);
      if (index < 0 || this.requirements[index]!.version !== input.expectedRequirementVersion) throw new OrderRequirementError('CONFLICT', 'Order requirement version is stale.');
      if (this.eventKeys.has(input.idempotencyKey)) return;
      await this.auditSink.append(audit);
      this.requirements[index] = clone(next);
      current.version += 1;
      current.amountMinor = total;
      if(current.sourcePackageVersionId)current.compositionMode='CUSTOMIZED';
      this.eventKeys.add(input.idempotencyKey);
    } };
  }

  private changeRequirement(existing: OrderRequirementRecord, input: UpdateRequirementInput): OrderRequirementRecord {
    const timestamp = input.now.toISOString();
    if (input.action === 'REMOVE') return { ...clone(existing), status: 'REMOVED', version: existing.version + 1, updatedAt: timestamp };
    if (input.action === 'CHANGE_NOTE') return {...clone(existing),customerNote:input.customerNote??null,version:existing.version+1,updatedAt:timestamp};
    const catalog = input.action === 'CHANGE_PROJECT'
      ? this.requireCatalog(requiredString(input.serviceCatalogVersionId, 'serviceCatalogVersionId'))
      : this.requireCatalog(existing.serviceCatalogVersionId);
    if (input.action === 'CHANGE_PROJECT' && catalog.game !== existing.game) throw new OrderRequirementError('BUSINESS_RULE_ERROR', 'Replacement project must belong to the same game.');
    return buildRequirement({ id: existing.id, orderId: existing.orderId, catalog, unitCount: input.unitCount ?? existing.unitCount, requestedPlayerCount: input.requestedPlayerCount ?? existing.requestedPlayerCount, version: existing.version + 1, now: input.now, createdAt: existing.createdAt, sourcePackageSlotId: existing.sourcePackageSlotId ?? null, customerNote: existing.customerNote ?? null });
  }

  private requireOrder(input: RequirementScope): RequirementOrder {
    const order = this.orders.find((candidate) => candidate.id === input.orderId && candidate.guildId === input.actorGuildId);
    if (!order) throw new OrderRequirementError('NOT_FOUND', 'Order was not found.');
    if (order.customerDiscordUserId !== input.actorDiscordUserId) throw new OrderRequirementError('PERMISSION_DENIED', 'Only the order owner can manage requirements.');
    return order;
  }

  private requireMutableOrder(input: RequirementScope, expectedVersion: number): RequirementOrder {
    const order = this.requireOrder(input);
    if (order.status !== 'DRAFT') throw new OrderRequirementError('BUSINESS_RULE_ERROR', 'Only draft order requirements can be changed.');
    if (order.version !== expectedVersion) throw new OrderRequirementError('CONFLICT', 'Order version is stale.');
    return order;
  }

  private requireCatalog(id: string): RequirementCatalog {
    const catalog = this.catalogs.find((candidate) => candidate.id === id && candidate.status === 'ACTIVE');
    if (!catalog) throw new OrderRequirementError('BUSINESS_RULE_ERROR', 'Active service catalog version was not found.');
    return catalog;
  }
}

export class PostgresOrderRequirementStore implements OrderRequirementStore {
  constructor(private readonly pool: Pool) {}

  async list(input: RequirementScope & { cursor: string | null; limit: number }): Promise<RequirementPage> {
    const order = await scopedOrder(this.pool, input, false);
    const offset = decodeCursor(input.cursor);
    const result = await this.pool.query<RequirementRow>(`${requirementSelect}
      WHERE requirement.order_id=$1 AND requirement.status='ACTIVE' ORDER BY requirement.created_at,requirement.id OFFSET $2 LIMIT $3`, [input.orderId, offset, input.limit + 1]);
    const items = result.rows.slice(0, input.limit).map(mapRequirement);
    const total = order.composition_mode==='PACKAGE_DEFAULT'?safeMinor(order.amount_minor??0):await requirementTotal(this.pool, input.orderId);
    const catalogSubtotalMinor=await requirementTotal(this.pool,input.orderId);
    return { orderId: input.orderId, orderVersion: order.row_version, catalogSubtotalMinor,packageAdjustmentMinor:total-catalogSubtotalMinor,derivedTotalMinor: total, currency: 'CAT', items, nextCursor: result.rows.length > input.limit ? encodeCursor(offset + input.limit) : null };
  }
  async listAdmin(input:{orderId:string;actorStaffId:string;actorLevel:StaffLevel;guildId:string;cursor:string|null;limit:number}):Promise<RequirementPage>{
    const scoped=await this.pool.query<{row_version:number;composition_mode:string|null;amount_minor:string|number|null}>(`SELECT orders.row_version,orders.composition_mode::text,orders.amount_minor FROM orders WHERE orders.id=$1 AND orders.guild_id=$2 AND ($3::text<>'L1_SUPPORT' OR EXISTS(SELECT 1 FROM staff_tasks task WHERE task.order_id=orders.id AND task.claimed_by_staff_id=$4 AND task.status IN ('CLAIMED','VERIFIED','PENDING_APPROVAL')))`,[input.orderId,input.guildId,input.actorLevel,input.actorStaffId]);if(!scoped.rows[0])throw new OrderRequirementError('PERMISSION_DENIED','Order is outside the current staff scope.');const offset=decodeCursor(input.cursor);const result=await this.pool.query<RequirementRow>(`${requirementSelect} WHERE requirement.order_id=$1 AND requirement.status='ACTIVE' ORDER BY requirement.created_at,requirement.id OFFSET $2 LIMIT $3`,[input.orderId,offset,input.limit+1]);const items=result.rows.slice(0,input.limit).map(mapRequirement);const catalogSubtotalMinor=await requirementTotal(this.pool,input.orderId);const derivedTotalMinor=scoped.rows[0].composition_mode==='PACKAGE_DEFAULT'?safeMinor(scoped.rows[0].amount_minor??0):catalogSubtotalMinor;return{orderId:input.orderId,orderVersion:scoped.rows[0].row_version,catalogSubtotalMinor,packageAdjustmentMinor:derivedTotalMinor-catalogSubtotalMinor,derivedTotalMinor,currency:'CAT',items,nextCursor:result.rows.length>input.limit?encodeCursor(offset+input.limit):null};
  }

  add(input: AddRequirementInput): Promise<StagedRequirementWrite> { return this.prepare(input, null); }
  update(input: UpdateRequirementInput): Promise<StagedRequirementWrite> { return this.prepare(input, input.requirementId); }

  private async prepare(input: AddRequirementInput | UpdateRequirementInput, requirementId: string | null): Promise<StagedRequirementWrite> {
    const preview = await this.pool.connect();
    let data: RequirementMutationResult;
    try {
      await preview.query('BEGIN');
      data = requirementId ? await applyUpdate(preview, input as UpdateRequirementInput) : await applyAdd(preview, input as AddRequirementInput);
      await preview.query('ROLLBACK');
    } catch (error) {
      await preview.query('ROLLBACK').catch(() => undefined);
      throw normalizeError(error);
    } finally { preview.release(); }
    return { data, commit: async (audit) => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const committed = requirementId ? await applyUpdate(client, input as UpdateRequirementInput) : await applyAdd(client, input as AddRequirementInput);
        await insertPostgresAuditRecord(client, audit);
        await client.query('COMMIT');
        Object.assign(data, committed);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw normalizeError(error);
      } finally { client.release(); }
    } };
  }
}

export function registerOrderRequirementRoutes(server: FastifyInstance, options: { store: OrderRequirementStore; now?: () => Date }): void {
  if (!server.securityOptions) throw new Error('Order requirement routes require security options.');
  const security = server.securityOptions;
  const now = options.now ?? (() => new Date());
  const scope = (request: FastifyRequest, actor: ActorContext): RequirementScope => {
    if (!actor.guildId || !actor.discordUserId) throw new OrderRequirementError('PERMISSION_DENIED', 'Discord actor context is required.');
    return { orderId: parameter(request, 'orderId'), actorGuildId: actor.guildId, actorDiscordUserId: actor.discordUserId };
  };
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/orders/:orderId/requirements', permission: 'order.read', action: 'LIST_ORDER_REQUIREMENTS', targetType: 'order', acceptedSources: ['DISCORD_BOT', 'DASHBOARD'], handler: (request, actor) => options.store.list({ ...scope(request, actor), ...pageInput(request) }), mapError });
  if(options.store.listAdmin)registerSecureReadRoute(server,security,{method:'GET',url:'/api/v1/admin/orders/:orderId/requirements',permission:'order.participants.manage',action:'LIST_ADMIN_ORDER_REQUIREMENTS',targetType:'order',acceptedSources:['DASHBOARD','DISCORD_BOT'],handler:(request,actor)=>{if(!actor.actorStaffId||!actor.actorLevel||!actor.guildId)throw new OrderRequirementError('PERMISSION_DENIED','Active staff and Guild context are required.');return options.store.listAdmin!({orderId:parameter(request,'orderId'),actorStaffId:actor.actorStaffId,actorLevel:actor.actorLevel,guildId:actor.guildId,...pageInput(request)});},mapError});
  registerSecureWriteRoute(server, security, { method: 'POST', url: '/api/v1/orders/:orderId/requirements', permission: 'order.update', action: 'ADD_ORDER_REQUIREMENT', targetType: 'order_requirement', successStatusCode: 201, acceptedSources: ['DISCORD_BOT'], handler: (request, actor) => options.store.add({ ...scope(request, actor), ...parseAdd(request.body), idempotencyKey: requestIdempotencyKey(request), now: now() }), mapError });
  registerSecureWriteRoute(server, security, { method: 'PATCH', url: '/api/v1/orders/:orderId/requirements/:requirementId', permission: 'order.update', action: 'UPDATE_ORDER_REQUIREMENT', targetType: 'order_requirement', targetId: (request) => parameter(request, 'requirementId'), acceptedSources: ['DISCORD_BOT'], handler: (request, actor) => options.store.update({ ...scope(request, actor), requirementId: parameter(request, 'requirementId'), ...parseUpdate(request.body), idempotencyKey: requestIdempotencyKey(request), now: now() }), mapError });
}

async function applyAdd(client: PoolClient, input: AddRequirementInput): Promise<RequirementMutationResult> {
  const order = await scopedOrder(client, input, true);
  assertMutable(order, input.expectedOrderVersion);
  const catalog = await catalogFacts(client, input.serviceCatalogVersionId);
  const requirement = buildRequirement({ id: crypto.randomUUID(), orderId: input.orderId, catalog, unitCount: input.unitCount, requestedPlayerCount: input.requestedPlayerCount, version: 1, now: input.now });
  await client.query(`INSERT INTO order_requirements (
    id,order_id,service_catalog_version_id,status,row_version,game_code_snapshot,game_display_name_snapshot,
    service_code_snapshot,service_display_name_snapshot,region_code_snapshot,region_display_name_snapshot,
    billing_unit_minutes_snapshot,unit_count,requested_player_count,customer_unit_price_minor_snapshot,
    estimated_line_price_minor,created_at,updated_at
  ) VALUES ($1,$2,$3,'ACTIVE',1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`, requirementValues(requirement));
  return finishMutation(client, input, requirement, 'ADDED');
}

async function applyUpdate(client: PoolClient, input: UpdateRequirementInput): Promise<RequirementMutationResult> {
  const order = await scopedOrder(client, input, true);
  assertMutable(order, input.expectedOrderVersion);
  const result = await client.query<RequirementRow>(`${requirementSelect} WHERE requirement.id=$1 AND requirement.order_id=$2 FOR UPDATE`, [input.requirementId, input.orderId]);
  const existing = result.rows[0] ? mapRequirement(result.rows[0]) : null;
  if (!existing) throw new OrderRequirementError('NOT_FOUND', 'Order requirement was not found.');
  if (existing.version !== input.expectedRequirementVersion) throw new OrderRequirementError('CONFLICT', 'Order requirement version is stale.');
  if (existing.status !== 'ACTIVE') throw new OrderRequirementError('BUSINESS_RULE_ERROR', 'Removed requirement cannot be changed.');
  let next: OrderRequirementRecord;
  if (input.action === 'REMOVE') {
    next = { ...existing, status: 'REMOVED', version: existing.version + 1, updatedAt: input.now.toISOString() };
  } else if(input.action==='CHANGE_NOTE'){
    next={...existing,customerNote:input.customerNote??null,version:existing.version+1,updatedAt:input.now.toISOString()};
  } else {
    const catalog = input.action === 'CHANGE_PROJECT' ? await catalogFacts(client, requiredString(input.serviceCatalogVersionId, 'serviceCatalogVersionId')) : await catalogFacts(client, existing.serviceCatalogVersionId);
    if (input.action === 'CHANGE_PROJECT' && catalog.game !== existing.game) throw new OrderRequirementError('BUSINESS_RULE_ERROR', 'Replacement project must belong to the same game.');
    next = buildRequirement({ id: existing.id, orderId: existing.orderId, catalog, unitCount: input.unitCount ?? existing.unitCount, requestedPlayerCount: input.requestedPlayerCount ?? existing.requestedPlayerCount, version: existing.version + 1, now: input.now, createdAt: existing.createdAt, sourcePackageSlotId: existing.sourcePackageSlotId ?? null, customerNote: existing.customerNote ?? null });
  }
  await client.query(`UPDATE order_requirements SET service_catalog_version_id=$2,status=$3::"OrderRequirementStatus",row_version=$4,
    game_code_snapshot=$5,game_display_name_snapshot=$6,service_code_snapshot=$7,service_display_name_snapshot=$8,
    region_code_snapshot=$9,region_display_name_snapshot=$10,billing_unit_minutes_snapshot=$11,unit_count=$12,
    requested_player_count=$13,customer_unit_price_minor_snapshot=$14,estimated_line_price_minor=$15,customer_note=$16,
    removed_at=CASE WHEN $3::"OrderRequirementStatus"='REMOVED'::"OrderRequirementStatus" THEN $17::timestamptz ELSE NULL END,updated_at=$17::timestamptz WHERE id=$1`,
  [next.id,next.serviceCatalogVersionId,next.status,next.version,next.game,next.gameDisplayName,next.service,next.serviceDisplayName,next.region,next.regionDisplayName,next.billingUnitMinutes,next.unitCount,next.requestedPlayerCount,next.customerUnitPriceMinor,next.estimatedLinePriceMinor,next.customerNote,input.now.toISOString()]);
  return finishMutation(client, input, next, input.action === 'REMOVE' ? 'REMOVED' : input.action === 'CHANGE_PROJECT' ? 'PROJECT_CHANGED' : input.action==='CHANGE_NOTE'?'NOTE_CHANGED':'QUANTITY_CHANGED');
}

async function finishMutation(client: PoolClient, input: AddRequirementInput | UpdateRequirementInput, requirement: OrderRequirementRecord, eventType: string): Promise<RequirementMutationResult> {
  const total = await requirementTotal(client, input.orderId);
  const version = input.expectedOrderVersion + 1;
  await client.query(`INSERT INTO order_requirement_events (
    id,order_requirement_id,sequence,event_type,requirement_version,order_version,actor_user_id,snapshot,idempotency_key,created_at
  ) VALUES (gen_random_uuid(),$1,(SELECT COALESCE(MAX(sequence),0)+1 FROM order_requirement_events WHERE order_requirement_id=$1),$2::"OrderRequirementEventType",$3,$4,
    (SELECT user_id FROM discord_accounts WHERE guild_id=$5 AND discord_user_id=$6),$7::jsonb,$8,$9)`,
  [requirement.id,eventType,requirement.version,version,input.actorGuildId,input.actorDiscordUserId,JSON.stringify(requirement),input.idempotencyKey,input.now.toISOString()]);
  await client.query(`SELECT set_config('app.order_draft_amount_update','approved',true)`);
  const updated = await client.query<{ row_version: number }>(`UPDATE orders SET amount_minor=$3,composition_mode=CASE WHEN source_package_version_id IS NOT NULL THEN 'CUSTOMIZED'::"OrderCompositionMode" ELSE composition_mode END,row_version=row_version+1,updated_at=$4
    WHERE id=$1 AND row_version=$2 AND status='DRAFT' RETURNING row_version`, [input.orderId,input.expectedOrderVersion,total,input.now.toISOString()]);
  if (!updated.rows[0]) throw new OrderRequirementError('CONFLICT', 'Order version is stale.');
  return { orderId: input.orderId, orderVersion: updated.rows[0].row_version, derivedTotalMinor: total, currency: 'CAT', requirement };
}

function buildRequirement(input: { id: string; orderId: string; catalog: RequirementCatalog; unitCount: number; requestedPlayerCount: number; version: number; now: Date; createdAt?: string; sourcePackageSlotId?: string | null; customerNote?: string | null }): OrderRequirementRecord {
  const units = positiveInteger(input.unitCount, 'unitCount');
  const players = positiveInteger(input.requestedPlayerCount, 'requestedPlayerCount');
  const price = positiveInteger(input.catalog.customerUnitPriceMinor, 'customerUnitPriceMinor');
  const estimate = price * units * players;
  if (!Number.isSafeInteger(estimate)) throw new OrderRequirementError('VALIDATION_ERROR', 'Derived requirement estimate is outside the supported range.');
  const timestamp = input.now.toISOString();
  return { id: input.id, orderId: input.orderId, sourcePackageSlotId: input.sourcePackageSlotId ?? null, serviceCatalogVersionId: input.catalog.id, game: input.catalog.game, gameDisplayName: input.catalog.gameDisplayName, service: input.catalog.service, serviceDisplayName: input.catalog.serviceDisplayName, region: input.catalog.region, regionDisplayName: input.catalog.regionDisplayName, billingUnitMinutes: input.catalog.billingUnitMinutes, unitCount: units, requestedPlayerCount: players, customerUnitPriceMinor: price, estimatedLinePriceMinor: estimate, filledPlayerCount: 0, customerNote: input.customerNote ?? null, status: 'ACTIVE', version: input.version, createdAt: input.createdAt ?? timestamp, updatedAt: timestamp };
}

async function scopedOrder(client: Pick<Pool, 'query'> | PoolClient, input: RequirementScope, lock: boolean): Promise<OrderScopeRow> {
  const result = await client.query<OrderScopeRow>(`SELECT orders.id,orders.row_version,orders.status::text,orders.composition_mode::text,orders.amount_minor FROM orders
    JOIN discord_accounts account ON account.user_id=orders.customer_id AND account.guild_id=orders.guild_id
    WHERE orders.id=$1 AND orders.guild_id=$2 AND account.discord_user_id=$3 ${lock ? 'FOR UPDATE OF orders' : ''}`,
  [input.orderId,input.actorGuildId,input.actorDiscordUserId]);
  if (!result.rows[0]) throw new OrderRequirementError('PERMISSION_DENIED', 'Order was not found for the current owner.');
  return result.rows[0];
}

function assertMutable(order: OrderScopeRow, expectedVersion: number): void {
  if (order.status !== 'DRAFT') throw new OrderRequirementError('BUSINESS_RULE_ERROR', 'Only draft order requirements can be changed.');
  if (order.row_version !== expectedVersion) throw new OrderRequirementError('CONFLICT', 'Order version is stale.');
}

async function catalogFacts(client: Pick<Pool, 'query'> | PoolClient, catalogId: string): Promise<RequirementCatalog> {
  const result = await client.query<CatalogRow>(`SELECT version.id,version.status::text,version.billing_unit_minutes,version.customer_unit_price_minor,
    offering.game_code,offering.game_name,offering.service_code,offering.service_name,offering.region_code
    FROM service_catalog_versions version JOIN service_offerings offering ON offering.id=version.service_offering_id
    WHERE version.id=$1 AND version.status='ACTIVE' AND offering.archived_at IS NULL`, [catalogId]);
  const row = result.rows[0];
  if (!row) throw new OrderRequirementError('BUSINESS_RULE_ERROR', 'Active service catalog version was not found.');
  return { id: row.id, status: 'ACTIVE', game: row.game_code, gameDisplayName: row.game_name, service: row.service_code, serviceDisplayName: row.service_name, region: row.region_code, regionDisplayName: row.region_code, billingUnitMinutes: row.billing_unit_minutes, customerUnitPriceMinor: safeMinor(row.customer_unit_price_minor) };
}

async function requirementTotal(client: Pick<Pool, 'query'> | PoolClient, orderId: string): Promise<number> {
  const result = await client.query<{ total: string }>(`SELECT COALESCE(SUM(estimated_line_price_minor) FILTER (WHERE status='ACTIVE'),0)::text total FROM order_requirements WHERE order_id=$1`, [orderId]);
  return safeMinor(result.rows[0]?.total ?? '0');
}

function mutationResult(order: RequirementOrder, requirement: OrderRequirementRecord, total: number): RequirementMutationResult { return { orderId: order.id, orderVersion: order.version + 1, derivedTotalMinor: total, currency: 'CAT', requirement: clone(requirement) }; }
function deriveTotal(items: OrderRequirementRecord[]): number { const total = items.filter((item) => item.status === 'ACTIVE').reduce((sum, item) => sum + item.estimatedLinePriceMinor, 0); if (!Number.isSafeInteger(total)) throw new OrderRequirementError('VALIDATION_ERROR', 'Derived order estimate is outside the supported range.'); return total; }
function sortCreated(a: OrderRequirementRecord, b: OrderRequirementRecord): number { return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id); }
function parseAdd(value: unknown): Omit<AddRequirementInput, keyof RequirementScope | 'idempotencyKey' | 'now'> { const body = strictObject(value, ['expectedOrderVersion','serviceCatalogVersionId','unitCount','requestedPlayerCount']); return { expectedOrderVersion: positiveInteger(body.expectedOrderVersion,'expectedOrderVersion'), serviceCatalogVersionId: uuid(body.serviceCatalogVersionId,'serviceCatalogVersionId'), unitCount: positiveInteger(body.unitCount,'unitCount'), requestedPlayerCount: positiveInteger(body.requestedPlayerCount,'requestedPlayerCount') }; }
function parseUpdate(value: unknown): Omit<UpdateRequirementInput, keyof RequirementScope | 'requirementId' | 'idempotencyKey' | 'now'> { const body = strictObject(value, ['expectedOrderVersion','expectedRequirementVersion','action','serviceCatalogVersionId','unitCount','requestedPlayerCount','customerNote']); if (body.action !== 'CHANGE_PROJECT' && body.action !== 'CHANGE_QUANTITY' && body.action !== 'CHANGE_NOTE' && body.action !== 'REMOVE') throw new OrderRequirementError('VALIDATION_ERROR','action is invalid.'); return { expectedOrderVersion: positiveInteger(body.expectedOrderVersion,'expectedOrderVersion'), expectedRequirementVersion: positiveInteger(body.expectedRequirementVersion,'expectedRequirementVersion'), action: body.action, serviceCatalogVersionId: nullableUuid(body.serviceCatalogVersionId,'serviceCatalogVersionId'), unitCount: nullablePositiveInteger(body.unitCount,'unitCount'), requestedPlayerCount: nullablePositiveInteger(body.requestedPlayerCount,'requestedPlayerCount'),customerNote:nullableNote(body.customerNote) }; }
function strictObject(value: unknown, allowed: string[]): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OrderRequirementError('VALIDATION_ERROR','Object payload is required.'); const body=value as Record<string,unknown>; const extra=Object.keys(body).filter((key)=>!allowed.includes(key)); if(extra.length)throw new OrderRequirementError('VALIDATION_ERROR',`Unexpected fields: ${extra.join(', ')}.`); return body; }
function pageInput(request: FastifyRequest) { const query=request.query as Record<string,unknown>; const limit=query.limit===undefined?25:positiveInteger(Number(query.limit),'limit'); if(limit>100)throw new OrderRequirementError('VALIDATION_ERROR','limit cannot exceed 100.'); return { cursor: typeof query.cursor==='string'&&query.cursor?query.cursor:null, limit }; }
function requestIdempotencyKey(request: FastifyRequest): string { const value=request.headers['idempotency-key']; return Array.isArray(value)?value[0]??'':value??''; }
function parameter(request: FastifyRequest, key: string): string { return String((request.params as Record<string,unknown>)[key]??''); }
function positiveInteger(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new OrderRequirementError('VALIDATION_ERROR',`${field} must be a positive integer.`); return Number(value); }
function nullablePositiveInteger(value: unknown, field: string): number | null { return value === undefined || value === null ? null : positiveInteger(value, field); }
function uuid(value: unknown, field: string): string { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(value)) throw new OrderRequirementError('VALIDATION_ERROR',`${field} is invalid.`); return value; }
function nullableUuid(value: unknown, field: string): string | null { return value === undefined || value === null ? null : uuid(value,field); }
function nullableNote(value:unknown):string|null{if(value===undefined||value===null||value==='')return null;if(typeof value!=='string'||value.length>500)throw new OrderRequirementError('VALIDATION_ERROR','customerNote must be at most 500 characters.');return value;}
function requiredString(value: string | null, field: string): string { if (!value) throw new OrderRequirementError('VALIDATION_ERROR',`${field} is required.`); return value; }
function encodeCursor(offset: number): string { return Buffer.from(JSON.stringify({v:1,offset})).toString('base64url'); }
function decodeCursor(cursor: string | null): number { if (!cursor) return 0; try { const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString()) as {v?:unknown;offset?:unknown}; if(parsed.v!==1||!Number.isSafeInteger(parsed.offset)||Number(parsed.offset)<0)throw new Error(); return Number(parsed.offset); } catch { throw new OrderRequirementError('VALIDATION_ERROR','Cursor is invalid.'); } }
function safeMinor(value: string | number | bigint): number { const parsed=Number(value); if(!Number.isSafeInteger(parsed)||parsed<0)throw new OrderRequirementError('VALIDATION_ERROR','Stored money is invalid.'); return parsed; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function mapError(error: unknown) { if (!(error instanceof OrderRequirementError)) return null; return { statusCode: error.code==='NOT_FOUND'?404:error.code==='PERMISSION_DENIED'?403:error.code==='CONFLICT'?409:error.code==='BUSINESS_RULE_ERROR'?422:400, code:error.code, message:error.message }; }
function normalizeError(error: unknown): unknown { if(error instanceof OrderRequirementError)return error; const code=(error as {code?:string})?.code; if(code==='23505')return new OrderRequirementError('CONFLICT','Idempotency key was already used.'); if(code==='23503')return new OrderRequirementError('BUSINESS_RULE_ERROR','Referenced order requirement data is invalid.'); return error; }
function requirementValues(r: OrderRequirementRecord): unknown[] { return [r.id,r.orderId,r.serviceCatalogVersionId,r.game,r.gameDisplayName,r.service,r.serviceDisplayName,r.region,r.regionDisplayName,r.billingUnitMinutes,r.unitCount,r.requestedPlayerCount,r.customerUnitPriceMinor,r.estimatedLinePriceMinor,r.createdAt]; }
function mapRequirement(row: RequirementRow): OrderRequirementRecord { return { id:row.id,orderId:row.order_id,sourcePackageSlotId:row.source_package_slot_id,customerNote:row.customer_note,serviceCatalogVersionId:row.service_catalog_version_id,game:row.game_code_snapshot,gameDisplayName:row.game_display_name_snapshot,service:row.service_code_snapshot,serviceDisplayName:row.service_display_name_snapshot,region:row.region_code_snapshot,regionDisplayName:row.region_display_name_snapshot,billingUnitMinutes:row.billing_unit_minutes_snapshot,unitCount:row.unit_count,requestedPlayerCount:row.requested_player_count,customerUnitPriceMinor:safeMinor(row.customer_unit_price_minor_snapshot),estimatedLinePriceMinor:safeMinor(row.estimated_line_price_minor),filledPlayerCount:Number(row.filled_player_count),status:row.status,version:row.row_version,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString() }; }

interface OrderScopeRow { id: string; row_version: number; status: string;composition_mode:string|null;amount_minor:string|number|bigint|null }
interface CatalogRow { id:string;status:string;billing_unit_minutes:number;customer_unit_price_minor:string|number|bigint;game_code:string;game_name:string;service_code:string;service_name:string;region_code:string|null }
interface RequirementRow { id:string;order_id:string;source_package_slot_id:string|null;customer_note:string|null;service_catalog_version_id:string;status:OrderRequirementStatus;row_version:number;game_code_snapshot:string;game_display_name_snapshot:string;service_code_snapshot:string;service_display_name_snapshot:string;region_code_snapshot:string|null;region_display_name_snapshot:string|null;billing_unit_minutes_snapshot:number;unit_count:number;requested_player_count:number;customer_unit_price_minor_snapshot:string|number|bigint;estimated_line_price_minor:string|number|bigint;filled_player_count:string|number;created_at:string|Date;updated_at:string|Date }
const requirementSelect = `SELECT requirement.id,requirement.order_id,requirement.source_package_slot_id,requirement.customer_note,requirement.service_catalog_version_id,requirement.status::text,requirement.row_version,
  requirement.game_code_snapshot,requirement.game_display_name_snapshot,requirement.service_code_snapshot,requirement.service_display_name_snapshot,
  requirement.region_code_snapshot,requirement.region_display_name_snapshot,requirement.billing_unit_minutes_snapshot,requirement.unit_count,
  requirement.requested_player_count,requirement.customer_unit_price_minor_snapshot,requirement.estimated_line_price_minor,
  (SELECT COUNT(*) FROM order_participants participant WHERE participant.order_requirement_id=requirement.id AND participant.status='ACTIVE')::text filled_player_count,
  requirement.created_at,requirement.updated_at FROM order_requirements requirement`;
