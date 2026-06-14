import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  InMemoryAuditSink,
  insertPostgresAuditRecord,
  registerSecureReadRoute,
  registerSecureWriteRoute,
  type ActorContext,
  type AuditRecord,
  type AuditSink,
  type StaffLevel
} from './security.js';

export type OrderParticipantStatus = 'ACTIVE' | 'REMOVED';
export type ParticipantCompensationType = 'PERCENT_BPS' | 'FIXED_MINOR';
export type ParticipantCompensationSource = 'PLAYER_OVERRIDE' | 'CATALOG_DEFAULT' | 'LEGACY_ORDER_SNAPSHOT';

export interface OrderParticipantRecord {
  id: string;
  orderId: string;
  playerId: string;
  displayName: string;
  serviceCatalogVersionId: string;
  game: string;
  gameDisplayName: string;
  service: string;
  serviceDisplayName: string;
  region: string | null;
  regionDisplayName: string | null;
  billingUnitMinutes: number;
  unitCount: number;
  customerUnitPriceMinor: number;
  status: OrderParticipantStatus;
  linePriceMinor: number;
  compensationType: ParticipantCompensationType;
  compensationValue: number;
  compensationSource: ParticipantCompensationSource;
  expectedEarningMinor: number;
  readiness: 'NOT_READY' | 'READY';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ParticipantPage {
  orderId: string;
  orderVersion: number;
  derivedTotalMinor: number;
  currency: 'CAT';
  items: OrderParticipantRecord[];
  nextCursor: string | null;
}
export interface ParticipantCandidate { playerId:string;displayName:string;serviceCatalogVersionIds:string[];projects:Array<{id:string;game:string;gameDisplayName:string;service:string;serviceDisplayName:string;region:string|null;regionDisplayName:string|null;billingUnitMinutes:number;customerUnitPriceMinor:number}> }
export interface ParticipantCandidatePage { items:ParticipantCandidate[];nextCursor:string|null }

interface ParticipantMutationResult {
  orderId: string;
  orderVersion: number;
  derivedTotalMinor: number;
  currency: 'CAT';
  participant: OrderParticipantRecord;
}

interface ParticipantScope {
  orderId: string;
  actorStaffId: string;
  actorLevel: StaffLevel;
  guildId: string;
  actorSource?:ActorContext['actorSource'];
}

interface AddParticipantInput extends ParticipantScope {
  playerId: string;
  serviceCatalogVersionId: string;
  unitCount: number;
  linePriceMinor: number;
  expectedOrderVersion: number;
  reasonCode: string;
  idempotencyKey: string;
  now: Date;
}

interface UpdateParticipantInput extends ParticipantScope {
  participantId: string;
  expectedOrderVersion: number;
  expectedParticipantVersion: number;
  action: 'CHANGE_PROJECT' | 'CHANGE_PRICE' | 'REMOVE';
  serviceCatalogVersionId: string | null;
  unitCount: number | null;
  linePriceMinor: number | null;
  reasonCode: string;
  idempotencyKey: string;
  now: Date;
}

interface StagedParticipantWrite {
  data: ParticipantMutationResult;
  commit(auditRecord: AuditRecord): Promise<void> | void;
}

export interface OrderParticipantStore {
  list(input: ParticipantScope & { cursor: string | null; limit: number }): Promise<ParticipantPage> | ParticipantPage;
  listCandidates(input:ParticipantScope&{cursor:string|null;limit:number;query:string|null}):Promise<ParticipantCandidatePage>|ParticipantCandidatePage;
  add(input: AddParticipantInput): Promise<StagedParticipantWrite> | StagedParticipantWrite;
  update(input: UpdateParticipantInput): Promise<StagedParticipantWrite> | StagedParticipantWrite;
}

export class OrderParticipantError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'VALIDATION_ERROR' | 'CONFLICT' | 'BUSINESS_RULE_ERROR', message: string) {
    super(message); this.name = 'OrderParticipantError';
  }
}

export interface InMemoryParticipantOrder { id: string; guildId: string; version: number; status: string; captured: boolean; amountMinor: number }
export interface InMemoryParticipantPlayer { userId: string; displayName: string; eligible: boolean }
export interface InMemoryParticipantCatalog { id: string; serviceOfferingId: string; status: 'ACTIVE' | 'DRAFT' | 'RETIRED'; game: string; gameDisplayName: string; service: string; serviceDisplayName: string; region: string | null; regionDisplayName: string | null; billingUnitMinutes: number; customerUnitPriceMinor: number; defaultPlayerPayoutBps: number }
export interface InMemoryParticipantCompensation { playerUserId: string; serviceOfferingId: string; type: ParticipantCompensationType; value: number }

export class InMemoryOrderParticipantStore implements OrderParticipantStore {
  readonly orders: InMemoryParticipantOrder[];
  readonly participants: OrderParticipantRecord[];
  private readonly players: InMemoryParticipantPlayer[];
  private readonly catalogs: InMemoryParticipantCatalog[];
  private readonly compensationRules: InMemoryParticipantCompensation[];
  private readonly claimedOrderIdsByStaffId: Record<string, string[]>;
  private readonly auditSink: AuditSink;
  private readonly eventKeys = new Set<string>();

  constructor(input: { orders: InMemoryParticipantOrder[]; players: InMemoryParticipantPlayer[]; catalogs: InMemoryParticipantCatalog[]; compensationRules?: InMemoryParticipantCompensation[]; participants?: OrderParticipantRecord[]; claimedOrderIdsByStaffId?: Record<string, string[]>; auditSink?: AuditSink }) {
    this.orders = clone(input.orders); this.players = clone(input.players); this.catalogs = clone(input.catalogs);
    this.compensationRules = clone(input.compensationRules ?? []); this.participants = clone(input.participants ?? []);
    this.claimedOrderIdsByStaffId = clone(input.claimedOrderIdsByStaffId ?? {}); this.auditSink = input.auditSink ?? new InMemoryAuditSink();
  }

  list(input: ParticipantScope & { cursor: string | null; limit: number }): ParticipantPage {
    const order = this.requireScopedOrder(input);
    const offset = decodeCursor(input.cursor);
    const active = this.participants.filter((item) => item.orderId === order.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const items = active.slice(offset, offset + input.limit).map(clone);
    return { orderId: order.id, orderVersion: order.version, derivedTotalMinor: deriveTotal(active), currency: 'CAT', items, nextCursor: offset + input.limit < active.length ? encodeCursor(offset + input.limit) : null };
  }
  listCandidates(input:ParticipantScope&{cursor:string|null;limit:number;query:string|null}):ParticipantCandidatePage{this.requireScopedOrder(input);const offset=decodeCursor(input.cursor);const activePlayers=new Set(this.participants.filter((item)=>item.orderId===input.orderId&&item.status==='ACTIVE').map((item)=>item.playerId));const projects=this.catalogs.filter((catalog)=>catalog.status==='ACTIVE').map(candidateProject);const candidates=this.players.filter((player)=>player.eligible&&!activePlayers.has(player.userId)&&(!input.query||`${player.displayName} ${player.userId}`.toLowerCase().includes(input.query.toLowerCase()))).map((player)=>({playerId:player.userId,displayName:player.displayName,serviceCatalogVersionIds:projects.map((project)=>project.id),projects}));return{items:candidates.slice(offset,offset+input.limit),nextCursor:offset+input.limit<candidates.length?encodeCursor(offset+input.limit):null};}

  add(input: AddParticipantInput): StagedParticipantWrite {
    const order = this.requireMutableOrder(input);
    if (order.version !== input.expectedOrderVersion) throw new OrderParticipantError('CONFLICT', 'Order version is stale.');
    if (this.participants.some((item) => item.orderId === input.orderId && item.playerId === input.playerId && item.status === 'ACTIVE')) throw new OrderParticipantError('CONFLICT', 'Player already has an active order line.');
    const player = this.players.find((item) => item.userId === input.playerId && item.eligible);
    if (!player) throw new OrderParticipantError('BUSINESS_RULE_ERROR', 'Player is not eligible for this order.');
    const catalog = this.requireCatalog(input.serviceCatalogVersionId);
    const participant = buildParticipant({ id: crypto.randomUUID(), orderId: order.id, player, catalog, unitCount: input.unitCount, linePriceMinor: input.linePriceMinor, compensation: this.findCompensation(player.userId, catalog), version: 1, now: input.now });
    const nextTotal = deriveTotal([...this.participants, participant]);
    const data = { orderId: order.id, orderVersion: order.version + 1, derivedTotalMinor: nextTotal, currency: 'CAT' as const, participant: clone(participant) };
    return { data, commit: async (auditRecord) => {
      const current = this.requireMutableOrder(input);
      if (current.version !== input.expectedOrderVersion) throw new OrderParticipantError('CONFLICT', 'Order version is stale.');
      if (this.eventKeys.has(input.idempotencyKey)) return;
      if (this.participants.some((item) => item.orderId === input.orderId && item.playerId === input.playerId && item.status === 'ACTIVE')) throw new OrderParticipantError('CONFLICT', 'Player already has an active order line.');
      await this.auditSink.append(auditRecord);
      this.participants.push(clone(participant)); current.version += 1; current.amountMinor = nextTotal; this.eventKeys.add(input.idempotencyKey);
    } };
  }

  update(input: UpdateParticipantInput): StagedParticipantWrite {
    const order = this.requireMutableOrder(input);
    const existing = this.participants.find((item) => item.id === input.participantId && item.orderId === input.orderId);
    if (!existing) throw new OrderParticipantError('NOT_FOUND', 'Order participant was not found.');
    if (order.version !== input.expectedOrderVersion || existing.version !== input.expectedParticipantVersion) throw new OrderParticipantError('CONFLICT', 'Order or participant version is stale.');
    if (existing.status !== 'ACTIVE') throw new OrderParticipantError('BUSINESS_RULE_ERROR', 'Removed participant cannot be changed.');
    const next = this.updatedParticipant(existing, input);
    const nextTotal = deriveTotal(this.participants.map((item) => item.id === next.id ? next : item));
    const data = { orderId: order.id, orderVersion: order.version + 1, derivedTotalMinor: nextTotal, currency: 'CAT' as const, participant: clone(next) };
    return { data, commit: async (auditRecord) => {
      const currentOrder = this.requireMutableOrder(input);
      const index = this.participants.findIndex((item) => item.id === input.participantId && item.orderId === input.orderId);
      if (index < 0) throw new OrderParticipantError('NOT_FOUND', 'Order participant was not found.');
      if (currentOrder.version !== input.expectedOrderVersion || this.participants[index]!.version !== input.expectedParticipantVersion) throw new OrderParticipantError('CONFLICT', 'Order or participant version is stale.');
      if (this.eventKeys.has(input.idempotencyKey)) return;
      await this.auditSink.append(auditRecord);
      this.participants[index] = clone(next); currentOrder.version += 1; currentOrder.amountMinor = nextTotal; this.eventKeys.add(input.idempotencyKey);
    } };
  }

  private updatedParticipant(existing: OrderParticipantRecord, input: UpdateParticipantInput): OrderParticipantRecord {
    const now = input.now.toISOString();
    if (input.action === 'REMOVE') return { ...clone(existing), status: 'REMOVED', readiness: 'NOT_READY', version: existing.version + 1, updatedAt: now };
    const catalog = input.action === 'CHANGE_PROJECT' ? this.requireCatalog(requiredString(input.serviceCatalogVersionId, 'serviceCatalogVersionId')) : this.requireCatalog(existing.serviceCatalogVersionId);
    const player = this.players.find((item) => item.userId === existing.playerId);
    if (!player) throw new OrderParticipantError('BUSINESS_RULE_ERROR', 'Player is not eligible for this order.');
    const unitCount = input.unitCount ?? existing.unitCount;
    const linePriceMinor = input.linePriceMinor ?? existing.linePriceMinor;
    if (input.action === 'CHANGE_PROJECT' && (input.unitCount === null || input.linePriceMinor === null)) throw new OrderParticipantError('VALIDATION_ERROR', 'Project changes require unitCount and linePriceMinor.');
    if (input.action === 'CHANGE_PRICE' && input.linePriceMinor === null) throw new OrderParticipantError('VALIDATION_ERROR', 'Price changes require linePriceMinor.');
    return buildParticipant({ id: existing.id, orderId: existing.orderId, player, catalog, unitCount, linePriceMinor, compensation: this.findCompensation(player.userId, catalog), version: existing.version + 1, now: input.now, createdAt: existing.createdAt });
  }

  private findCompensation(playerUserId: string, catalog: InMemoryParticipantCatalog) { return this.compensationRules.find((item) => item.playerUserId === playerUserId && item.serviceOfferingId === catalog.serviceOfferingId) ?? null; }
  private requireCatalog(id: string) { const catalog = this.catalogs.find((item) => item.id === id && item.status === 'ACTIVE'); if (!catalog) throw new OrderParticipantError('BUSINESS_RULE_ERROR', 'Active service catalog version was not found.'); return catalog; }
  private requireScopedOrder(input: ParticipantScope) { const order = this.orders.find((item) => item.id === input.orderId && item.guildId === input.guildId); if (!order) throw new OrderParticipantError('NOT_FOUND', 'Order was not found.'); if (input.actorLevel === 'L1_SUPPORT' && !(this.claimedOrderIdsByStaffId[input.actorStaffId] ?? []).includes(order.id)) throw new OrderParticipantError('PERMISSION_DENIED', 'Order is outside the claimed task scope.'); return order; }
  private requireMutableOrder(input: ParticipantScope) { const order = this.requireScopedOrder(input); if (order.captured) throw new OrderParticipantError('BUSINESS_RULE_ERROR', 'Captured order participants are immutable.'); return order; }
}

export class PostgresOrderParticipantStore implements OrderParticipantStore {
  constructor(private readonly pool: Pool) {}
  async list(input: ParticipantScope & { cursor: string | null; limit: number }): Promise<ParticipantPage> {
    const offset = decodeCursor(input.cursor); const order = await this.scopedOrder(this.pool, input, false);
    const result = await this.pool.query<ParticipantRow>(`${participantSelect} WHERE participant.order_id=$1 ORDER BY participant.created_at,participant.id OFFSET $2 LIMIT $3`, [input.orderId, offset, input.limit + 1]);
    const items = result.rows.slice(0, input.limit).map(mapParticipant);
    const total = await this.pool.query<{ total: string }>(`SELECT COALESCE(SUM(line_price_minor) FILTER (WHERE status='ACTIVE'),0)::text total FROM order_participants WHERE order_id=$1`, [input.orderId]);
    return { orderId: input.orderId, orderVersion: order.row_version, derivedTotalMinor: safeMinor(total.rows[0]?.total ?? '0'), currency: 'CAT', items, nextCursor: result.rows.length > input.limit ? encodeCursor(offset + input.limit) : null };
  }
  async listCandidates(input:ParticipantScope&{cursor:string|null;limit:number;query:string|null}):Promise<ParticipantCandidatePage>{await this.scopedOrder(this.pool,input,false);const offset=decodeCursor(input.cursor);const result=await this.pool.query<{player_id:string;display_name:string;catalog_ids:string[];projects:ParticipantCandidate['projects']}>(`SELECT users.id player_id,users.display_name,array_agg(version.id::text ORDER BY version.id) catalog_ids,jsonb_agg(jsonb_build_object('id',version.id,'game',offering.game_code,'gameDisplayName',offering.game_name,'service',offering.service_code,'serviceDisplayName',offering.service_name,'region',offering.region_code,'regionDisplayName',offering.region_code,'billingUnitMinutes',version.billing_unit_minutes,'customerUnitPriceMinor',version.customer_unit_price_minor) ORDER BY version.id) projects FROM users JOIN player_profiles profile ON profile.user_id=users.id AND profile.review_status='ACTIVE' JOIN service_catalog_versions version ON version.status='ACTIVE' JOIN service_offerings offering ON offering.id=version.service_offering_id WHERE ($2::text IS NULL OR users.display_name ILIKE '%'||$2||'%' OR users.id::text=$2) AND NOT EXISTS(SELECT 1 FROM order_participants participant WHERE participant.order_id=$1 AND participant.player_id=users.id AND participant.status='ACTIVE') AND NOT EXISTS(SELECT 1 FROM service_version_skill_requirements requirement WHERE requirement.service_catalog_version_id=version.id AND NOT EXISTS(SELECT 1 FROM player_skills skill WHERE skill.player_profile_id=profile.id AND skill.skill_tag_id=requirement.skill_tag_id)) GROUP BY users.id,users.display_name ORDER BY users.display_name,users.id OFFSET $3 LIMIT $4`,[input.orderId,input.query,offset,input.limit+1]);return{items:result.rows.slice(0,input.limit).map((row)=>({playerId:row.player_id,displayName:row.display_name,serviceCatalogVersionIds:row.catalog_ids,projects:row.projects.map((project)=>({...project,billingUnitMinutes:Number(project.billingUnitMinutes),customerUnitPriceMinor:safeMinor(project.customerUnitPriceMinor)}))})),nextCursor:result.rows.length>input.limit?encodeCursor(offset+input.limit):null};}
  async add(input: AddParticipantInput): Promise<StagedParticipantWrite> { return this.prepareMutation(input, null); }
  async update(input: UpdateParticipantInput): Promise<StagedParticipantWrite> { return this.prepareMutation(input, input.participantId); }

  private async prepareMutation(input: AddParticipantInput | UpdateParticipantInput, participantId: string | null): Promise<StagedParticipantWrite> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = participantId ? await this.applyUpdate(client, input as UpdateParticipantInput) : await this.applyAdd(client, input as AddParticipantInput);
      await client.query('ROLLBACK');
      return { data: result, commit: async (auditRecord) => {
        const tx = await this.pool.connect();
        try { await tx.query('BEGIN'); const committed = participantId ? await this.applyUpdate(tx, input as UpdateParticipantInput) : await this.applyAdd(tx, input as AddParticipantInput); await insertPostgresAuditRecord(tx, auditRecord); await tx.query('COMMIT'); Object.assign(result, committed); }
        catch (error) { await tx.query('ROLLBACK').catch(() => undefined); throw normalizePgError(error); } finally { tx.release(); }
      } };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw normalizePgError(error); } finally { client.release(); }
  }

  private async applyAdd(client: PoolClient, input: AddParticipantInput): Promise<ParticipantMutationResult> {
    const order = await this.scopedOrder(client, input, true); this.assertMutable(order, input.expectedOrderVersion);
    const facts = await this.catalogFacts(client, input.playerId, input.serviceCatalogVersionId);
    const participant = buildParticipant({ id: crypto.randomUUID(), orderId: input.orderId, player: { userId: input.playerId, displayName: facts.display_name, eligible: true }, catalog: mapCatalogFacts(facts), unitCount: input.unitCount, linePriceMinor: input.linePriceMinor, compensation: mapCompensationFacts(facts), version: 1, now: input.now });
    await client.query(`INSERT INTO order_participants (id,order_id,player_id,service_catalog_version_id,status,row_version,player_display_name_snapshot,game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,region_code_snapshot,region_display_name_snapshot,billing_unit_minutes_snapshot,unit_count,customer_unit_price_minor_snapshot,line_price_minor,compensation_type_snapshot,compensation_value_snapshot,compensation_source,expected_earning_minor,added_by_staff_id,created_at,updated_at) VALUES ($1,$2,$3,$4,'ACTIVE',1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)`, participantInsertValues(participant, input.actorStaffId));
    return this.finishMutation(client, input, participant, 'ADDED');
  }

  private async applyUpdate(client: PoolClient, input: UpdateParticipantInput): Promise<ParticipantMutationResult> {
    const order = await this.scopedOrder(client, input, true); this.assertMutable(order, input.expectedOrderVersion);
    const currentResult = await client.query<ParticipantRow>(`${participantSelect} WHERE participant.id=$1 AND participant.order_id=$2 FOR UPDATE`, [input.participantId, input.orderId]);
    const current = currentResult.rows[0] ? mapParticipant(currentResult.rows[0]) : null;
    if (!current) throw new OrderParticipantError('NOT_FOUND', 'Order participant was not found.');
    if (current.version !== input.expectedParticipantVersion) throw new OrderParticipantError('CONFLICT', 'Participant version is stale.');
    if (current.status !== 'ACTIVE') throw new OrderParticipantError('BUSINESS_RULE_ERROR', 'Removed participant cannot be changed.');
    let next: OrderParticipantRecord;
    if (input.action === 'REMOVE') {
      next = { ...current, status: 'REMOVED', readiness: 'NOT_READY', version: current.version + 1, updatedAt: input.now.toISOString() };
      await client.query(`UPDATE order_participants SET status='REMOVED',row_version=row_version+1,ready_at=NULL,removed_by_staff_id=$3,removed_reason_code=$4,removed_at=$5,updated_at=$5 WHERE id=$1 AND row_version=$2`, [current.id, current.version, input.actorStaffId, input.reasonCode, input.now.toISOString()]);
    } else {
      const catalogId = input.action === 'CHANGE_PROJECT' ? requiredString(input.serviceCatalogVersionId, 'serviceCatalogVersionId') : current.serviceCatalogVersionId;
      if (input.action === 'CHANGE_PROJECT' && (input.unitCount === null || input.linePriceMinor === null)) throw new OrderParticipantError('VALIDATION_ERROR', 'Project changes require unitCount and linePriceMinor.');
      if (input.action === 'CHANGE_PRICE' && input.linePriceMinor === null) throw new OrderParticipantError('VALIDATION_ERROR', 'Price changes require linePriceMinor.');
      const facts = await this.catalogFacts(client, current.playerId, catalogId);
      next = buildParticipant({ id: current.id, orderId: current.orderId, player: { userId: current.playerId, displayName: facts.display_name, eligible: true }, catalog: mapCatalogFacts(facts), unitCount: input.unitCount ?? current.unitCount, linePriceMinor: input.linePriceMinor ?? current.linePriceMinor, compensation: mapCompensationFacts(facts), version: current.version + 1, now: input.now, createdAt: current.createdAt });
      await client.query(`UPDATE order_participants SET service_catalog_version_id=$3,row_version=row_version+1,player_display_name_snapshot=$4,game_code_snapshot=$5,game_display_name_snapshot=$6,service_code_snapshot=$7,service_display_name_snapshot=$8,region_code_snapshot=$9,region_display_name_snapshot=$10,billing_unit_minutes_snapshot=$11,unit_count=$12,customer_unit_price_minor_snapshot=$13,line_price_minor=$14,compensation_type_snapshot=$15,compensation_value_snapshot=$16,compensation_source=$17,expected_earning_minor=$18,ready_at=NULL,updated_at=$19 WHERE id=$1 AND row_version=$2`, [current.id,current.version,next.serviceCatalogVersionId,next.displayName,next.game,next.gameDisplayName,next.service,next.serviceDisplayName,next.region,next.regionDisplayName,next.billingUnitMinutes,next.unitCount,next.customerUnitPriceMinor,next.linePriceMinor,next.compensationType,next.compensationValue,next.compensationSource,next.expectedEarningMinor,input.now.toISOString()]);
    }
    return this.finishMutation(client, input, next, input.action === 'REMOVE' ? 'REMOVED' : input.action === 'CHANGE_PROJECT' ? 'PROJECT_CHANGED' : 'PRICE_CHANGED');
  }

  private async finishMutation(client: PoolClient, input: AddParticipantInput | UpdateParticipantInput, participant: OrderParticipantRecord, eventType: string): Promise<ParticipantMutationResult> {
    const total = await client.query<{ total: string;earning:string }>(`SELECT COALESCE(SUM(line_price_minor) FILTER (WHERE status='ACTIVE'),0)::text total,COALESCE(SUM(expected_earning_minor) FILTER (WHERE status='ACTIVE'),0)::text earning FROM order_participants WHERE order_id=$1`, [input.orderId]);
    const derivedTotalMinor = safeMinor(total.rows[0]?.total ?? '0');const derivedEarningMinor=safeMinor(total.rows[0]?.earning??'0');
    await this.rebalanceReservation(client,input,derivedTotalMinor);
    await client.query("SELECT set_config('app.order_participant_rebalance', 'approved', true)");
    const updated = await client.query<{ row_version: number }>(`UPDATE orders SET amount_minor=$3,expected_player_earning_minor=$4,row_version=row_version+1,updated_at=$5 WHERE id=$1 AND row_version=$2 RETURNING row_version`, [input.orderId, input.expectedOrderVersion, derivedTotalMinor,derivedEarningMinor, input.now.toISOString()]);
    if (!updated.rows[0]) throw new OrderParticipantError('CONFLICT', 'Order version is stale.');
    const sequence = await client.query<{ next: number }>(`SELECT COALESCE(MAX(sequence),0)+1 next FROM order_participant_events WHERE order_participant_id=$1`, [participant.id]);
    await client.query(`INSERT INTO order_participant_events (id,order_participant_id,sequence,event_type,participant_version,order_version,actor_staff_id,reason_code,snapshot,idempotency_key,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [crypto.randomUUID(),participant.id,Number(sequence.rows[0]?.next ?? 1),eventType,participant.version,updated.rows[0].row_version,input.actorStaffId,input.reasonCode,participant,input.idempotencyKey,input.now.toISOString()]);
    return { orderId: input.orderId, orderVersion: updated.rows[0].row_version, derivedTotalMinor, currency: 'CAT', participant };
  }

  private async rebalanceReservation(client:PoolClient,input:AddParticipantInput|UpdateParticipantInput,targetMinor:number){
    const orderResult=await client.query<{customer_id:string;status:string}>(`SELECT customer_id,status::text FROM orders WHERE id=$1`,[input.orderId]);const order=orderResult.rows[0];if(!order||order.status==='DRAFT')return;
    const reservationResult=await client.query<{id:string;user_id:string;amount_minor:string|number;row_version:number;status:string}>(`SELECT id,user_id,amount_minor,row_version,status::text FROM fund_reservations WHERE order_id=$1 AND status IN ('PENDING','ACTIVE','DISPUTED','PARTIALLY_SETTLED') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[input.orderId]);const reservation=reservationResult.rows[0];
    if(!reservation){if(targetMinor===0)return;await this.assertWalletIncrease(client,order.customer_id,targetMinor,null);const reservationId=crypto.randomUUID();await client.query(`INSERT INTO fund_reservations(id,user_id,source_type,order_id,gift_request_id,mode,provider,provider_hold_ref,amount_minor,currency,status,row_version,idempotency_key,expires_at,activated_at,created_at,updated_at) VALUES($1,$2,'ORDER',$3,NULL,'LOCAL_RESERVATION',NULL,NULL,$4,'CAT','ACTIVE',1,$5,$6,$7,$7,$7)`,[reservationId,order.customer_id,input.orderId,targetMinor,`${input.idempotencyKey}:reservation:create`,new Date(input.now.getTime()+30*60_000),input.now]);await this.insertReservationEvent(client,{reservationId,sequence:1,eventType:'CREATED',fromStatus:null,toStatus:'ACTIVE',amountMinor:targetMinor,version:1,input});await this.bumpWalletVersion(client,order.customer_id,input.now);return;}
    if(reservation.status!=='ACTIVE')throw new OrderParticipantError('BUSINESS_RULE_ERROR','Only an active reservation can be rebalanced.');const current=safeMinor(reservation.amount_minor);if(current===targetMinor)return;
    if(targetMinor>current)await this.assertWalletIncrease(client,reservation.user_id,targetMinor-current,null);
    const eventType=targetMinor===0?'RELEASED':targetMinor>current?'INCREASED':'DECREASED';const eventAmount=targetMinor===0?current:Math.abs(targetMinor-current);await this.insertReservationEvent(client,{reservationId:reservation.id,sequence:await this.nextReservationSequence(client,reservation.id),eventType,fromStatus:'ACTIVE',toStatus:targetMinor===0?'RELEASED':'ACTIVE',amountMinor:eventAmount,version:reservation.row_version+1,input});await this.bumpWalletVersion(client,reservation.user_id,input.now);
  }
  private async assertWalletIncrease(client:PoolClient,userId:string,delta:number,excludeReservationId:string|null){const wallet=await client.query<{id:string}>(`SELECT id FROM wallet_accounts WHERE user_id=$1 AND status='ACTIVE' FOR UPDATE`,[userId]);if(!wallet.rows[0])throw new OrderParticipantError('BUSINESS_RULE_ERROR','Customer wallet was not found.');const balance=await client.query<{available:string}>(`SELECT (COALESCE((SELECT SUM(CASE WHEN direction='CREDIT' THEN amount_minor ELSE -amount_minor END) FROM wallet_entries WHERE wallet_account_id=$1),0)-COALESCE((SELECT SUM(GREATEST(reservation.amount_minor-COALESCE(settled.amount,0),0)) FROM fund_reservations reservation LEFT JOIN LATERAL(SELECT SUM(amount_minor) amount FROM fund_reservation_events WHERE fund_reservation_id=reservation.id AND event_type IN ('CAPTURED','RELEASED','EXPIRED')) settled ON true WHERE reservation.user_id=$2 AND reservation.status IN ('PENDING','ACTIVE','DISPUTED','PARTIALLY_SETTLED') AND ($3::uuid IS NULL OR reservation.id<>$3)),0))::text available`,[wallet.rows[0].id,userId,excludeReservationId]);if(safeSignedMinor(balance.rows[0]?.available??'0')<delta)throw new OrderParticipantError('BUSINESS_RULE_ERROR','Available wallet balance is insufficient for the participant price increase.');}
  private async bumpWalletVersion(client:PoolClient,userId:string,now:Date){await client.query(`UPDATE wallet_accounts SET row_version=row_version+1,updated_at=$2 WHERE user_id=$1`,[userId,now]);}
  private async nextReservationSequence(client:PoolClient,reservationId:string){const result=await client.query<{next:number}>(`SELECT COALESCE(MAX(sequence),0)+1 next FROM fund_reservation_events WHERE fund_reservation_id=$1`,[reservationId]);return Number(result.rows[0]?.next??1);}
  private async insertReservationEvent(client:PoolClient,event:{reservationId:string;sequence:number;eventType:string;fromStatus:string|null;toStatus:string;amountMinor:number;version:number;input:AddParticipantInput|UpdateParticipantInput}){await client.query(`INSERT INTO fund_reservation_events(id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,idempotency_key,actor_staff_id,actor_source,reason_code,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[crypto.randomUUID(),event.reservationId,event.sequence,event.eventType,event.fromStatus,event.toStatus,event.amountMinor,event.version,`${event.input.idempotencyKey}:reservation:event`,event.input.actorStaffId,event.input.actorSource??'DASHBOARD',event.input.reasonCode,event.input.now]);}

  private async scopedOrder(client: Pick<Pool, 'query'> | PoolClient, input: ParticipantScope, lock: boolean) {
    const result = await client.query<OrderScopeRow>(`SELECT orders.id,orders.row_version,orders.guild_id,orders.status::text,EXISTS(SELECT 1 FROM fund_reservations reservation WHERE reservation.order_id=orders.id AND reservation.status='CAPTURED') captured FROM orders WHERE orders.id=$1 AND orders.guild_id=$2 AND ($3::text<>'L1_SUPPORT' OR EXISTS(SELECT 1 FROM staff_tasks task WHERE task.order_id=orders.id AND task.claimed_by_staff_id=$4 AND task.status IN ('CLAIMED','VERIFIED','PENDING_APPROVAL'))) ${lock ? 'FOR UPDATE' : ''}`, [input.orderId,input.guildId,input.actorLevel,input.actorStaffId]);
    if (!result.rows[0]) throw new OrderParticipantError(input.actorLevel === 'L1_SUPPORT' ? 'PERMISSION_DENIED' : 'NOT_FOUND', 'Order was not found in the permitted scope.'); return result.rows[0];
  }
  private assertMutable(order: OrderScopeRow, expectedVersion: number) { if (order.row_version !== expectedVersion) throw new OrderParticipantError('CONFLICT', 'Order version is stale.'); if (order.captured) throw new OrderParticipantError('BUSINESS_RULE_ERROR', 'Captured order participants are immutable.'); }
  private async catalogFacts(client: PoolClient, playerUserId: string, catalogId: string) { const result = await client.query<CatalogFactsRow>(`SELECT users.display_name,version.id,version.status::text,version.billing_unit_minutes,version.customer_unit_price_minor,version.default_player_payout_bps,offering.id service_offering_id,offering.game_code,offering.game_name,offering.service_code,offering.service_name,offering.region_code,offering.region_code region_name,rule.type::text compensation_type,rule.value compensation_value FROM users JOIN player_profiles profile ON profile.user_id=users.id AND profile.review_status='ACTIVE' JOIN service_catalog_versions version ON version.id=$2 AND version.status='ACTIVE' JOIN service_offerings offering ON offering.id=version.service_offering_id LEFT JOIN player_service_compensation_rules rule ON rule.player_id=profile.id AND rule.service_offering_id=offering.id WHERE users.id=$1 AND NOT EXISTS (SELECT 1 FROM service_version_skill_requirements requirement WHERE requirement.service_catalog_version_id=version.id AND NOT EXISTS (SELECT 1 FROM player_skills skill WHERE skill.player_profile_id=profile.id AND skill.skill_tag_id=requirement.skill_tag_id))`, [playerUserId,catalogId]); if (!result.rows[0]) throw new OrderParticipantError('BUSINESS_RULE_ERROR', 'Eligible player and active service catalog version were not found.'); return result.rows[0]; }
}

export function registerOrderParticipantRoutes(server: FastifyInstance, options: { store: OrderParticipantStore; now?: () => Date }): void {
  if (!server.securityOptions) throw new Error('Order participant routes require security options.');
  const security = server.securityOptions; const now = options.now ?? (() => new Date());
  const actorScope = (request: FastifyRequest, actor: ActorContext): ParticipantScope => {
    if (!actor.actorStaffId || !actor.actorLevel || !actor.guildId) throw new OrderParticipantError('PERMISSION_DENIED', 'Active staff and Guild context are required.');
    return { orderId: param(request, 'orderId'), actorStaffId: actor.actorStaffId, actorLevel: actor.actorLevel, guildId: actor.guildId,actorSource:actor.actorSource };
  };
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/admin/orders/:orderId/participants', permission: 'order.participants.manage', action: 'LIST_ADMIN_ORDER_PARTICIPANTS', targetType: 'order', acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], handler: (request, actor) => options.store.list({ ...actorScope(request, actor), ...pageInput(request) }), mapError });
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/admin/orders/:orderId/participant-candidates', permission: 'order.participants.manage', action: 'LIST_ADMIN_ORDER_PARTICIPANT_CANDIDATES', targetType: 'order', acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], handler: (request, actor) => options.store.listCandidates({ ...actorScope(request, actor), ...pageInput(request),query:queryText(request) }), mapError });
  registerSecureWriteRoute(server, security, { method: 'POST', url: '/api/v1/admin/orders/:orderId/participants', permission: 'order.participants.manage', action: 'ADD_ADMIN_ORDER_PARTICIPANT', targetType: 'order_participant', successStatusCode: 201, acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], handler: (request, actor) => options.store.add({ ...actorScope(request, actor), ...parseAdd(request.body), idempotencyKey: idempotencyKey(request), now: now() }), successReason: (request) => parseAdd(request.body).reasonCode, mapError });
  registerSecureWriteRoute(server, security, { method: 'PATCH', url: '/api/v1/admin/orders/:orderId/participants/:participantId', permission: 'order.participants.manage', action: 'UPDATE_ADMIN_ORDER_PARTICIPANT', targetType: 'order_participant', targetId: (request) => param(request, 'participantId'), acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], handler: (request, actor) => options.store.update({ ...actorScope(request, actor), participantId: param(request, 'participantId'), ...parseUpdate(request.body), idempotencyKey: idempotencyKey(request), now: now() }), successReason: (request) => parseUpdate(request.body).reasonCode, mapError });
}

function buildParticipant(input: { id: string; orderId: string; player: InMemoryParticipantPlayer; catalog: InMemoryParticipantCatalog; unitCount: number; linePriceMinor: number; compensation: InMemoryParticipantCompensation | null; version: number; now: Date; createdAt?: string }): OrderParticipantRecord {
  positiveInteger(input.unitCount, 'unitCount'); positiveInteger(input.linePriceMinor, 'linePriceMinor'); positiveInteger(input.catalog.customerUnitPriceMinor, 'customerUnitPriceMinor');
  const type = input.compensation?.type ?? 'PERCENT_BPS'; const value = input.compensation?.value ?? input.catalog.defaultPlayerPayoutBps;
  positiveInteger(value, 'compensationValue'); if (type === 'PERCENT_BPS' && value > 10000) throw new OrderParticipantError('VALIDATION_ERROR', 'Percentage compensation is invalid.');
  const expected = type === 'PERCENT_BPS' ? Math.floor(input.linePriceMinor * value / 10000) : value * input.unitCount;
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > input.linePriceMinor) throw new OrderParticipantError('BUSINESS_RULE_ERROR', 'Player compensation exceeds the line price.');
  const timestamp = input.now.toISOString();
  return { id: input.id, orderId: input.orderId, playerId: input.player.userId, displayName: input.player.displayName, serviceCatalogVersionId: input.catalog.id,
    game: input.catalog.game, gameDisplayName: input.catalog.gameDisplayName, service: input.catalog.service, serviceDisplayName: input.catalog.serviceDisplayName,
    region: input.catalog.region, regionDisplayName: input.catalog.regionDisplayName, billingUnitMinutes: input.catalog.billingUnitMinutes, unitCount: input.unitCount,
    customerUnitPriceMinor: input.catalog.customerUnitPriceMinor, status: 'ACTIVE', linePriceMinor: input.linePriceMinor, compensationType: type, compensationValue: value,
    compensationSource: input.compensation ? 'PLAYER_OVERRIDE' : 'CATALOG_DEFAULT', expectedEarningMinor: expected, readiness: 'NOT_READY', version: input.version,
    createdAt: input.createdAt ?? timestamp, updatedAt: timestamp };
}

function parseAdd(value: unknown): Omit<AddParticipantInput, keyof ParticipantScope | 'idempotencyKey' | 'now'> { const body = strictObject(value, ['playerId','serviceCatalogVersionId','unitCount','linePriceMinor','expectedOrderVersion','reasonCode']); return { playerId: uuid(body.playerId,'playerId'), serviceCatalogVersionId: uuid(body.serviceCatalogVersionId,'serviceCatalogVersionId'), unitCount: positiveInteger(body.unitCount,'unitCount'), linePriceMinor: positiveInteger(body.linePriceMinor,'linePriceMinor'), expectedOrderVersion: positiveInteger(body.expectedOrderVersion,'expectedOrderVersion'), reasonCode: reason(body.reasonCode) }; }
function parseUpdate(value: unknown): Omit<UpdateParticipantInput, keyof ParticipantScope | 'participantId' | 'idempotencyKey' | 'now'> { const body = strictObject(value, ['expectedOrderVersion','expectedParticipantVersion','action','serviceCatalogVersionId','unitCount','linePriceMinor','reasonCode']); const action = body.action; if (action !== 'CHANGE_PROJECT' && action !== 'CHANGE_PRICE' && action !== 'REMOVE') throw new OrderParticipantError('VALIDATION_ERROR','action is invalid.'); return { expectedOrderVersion: positiveInteger(body.expectedOrderVersion,'expectedOrderVersion'), expectedParticipantVersion: positiveInteger(body.expectedParticipantVersion,'expectedParticipantVersion'), action, serviceCatalogVersionId: nullableUuid(body.serviceCatalogVersionId,'serviceCatalogVersionId'), unitCount: nullablePositiveInteger(body.unitCount,'unitCount'), linePriceMinor: nullablePositiveInteger(body.linePriceMinor,'linePriceMinor'), reasonCode: reason(body.reasonCode) }; }
function strictObject(value: unknown, allowed: string[]) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OrderParticipantError('VALIDATION_ERROR','Object payload is required.'); const body=value as Record<string,unknown>; const extra=Object.keys(body).filter((key)=>!allowed.includes(key)); if(extra.length)throw new OrderParticipantError('VALIDATION_ERROR',`Unexpected fields: ${extra.join(', ')}.`); return body; }
function pageInput(request: FastifyRequest) { const query=request.query as Record<string,unknown>; const limit=query.limit===undefined?25:positiveInteger(Number(query.limit),'limit'); if(limit>100)throw new OrderParticipantError('VALIDATION_ERROR','limit cannot exceed 100.'); return { cursor: typeof query.cursor==='string'&&query.cursor?query.cursor:null, limit }; }
function queryText(request:FastifyRequest){const value=(request.query as Record<string,unknown>).query;if(value===undefined||value==='')return null;if(typeof value!=='string'||value.trim().length>100)throw new OrderParticipantError('VALIDATION_ERROR','query is invalid.');return value.trim();}
function reason(value: unknown) { if(typeof value!=='string'||!/^[A-Z0-9_]{3,100}$/.test(value))throw new OrderParticipantError('VALIDATION_ERROR','reasonCode is invalid.'); return value; }
function uuid(value: unknown, field: string) { if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new OrderParticipantError('VALIDATION_ERROR',`${field} is invalid.`); return value; }
function nullableUuid(value: unknown, field: string) { return value===undefined||value===null?null:uuid(value,field); }
function positiveInteger(value: unknown, field: string): number { if(!Number.isSafeInteger(value)||Number(value)<1)throw new OrderParticipantError('VALIDATION_ERROR',`${field} must be a positive integer.`); return Number(value); }
function nullablePositiveInteger(value: unknown, field: string) { return value===undefined||value===null?null:positiveInteger(value,field); }
function requiredString(value: string|null, field:string){if(!value)throw new OrderParticipantError('VALIDATION_ERROR',`${field} is required.`);return value;}
function idempotencyKey(request: FastifyRequest){const value=request.headers['idempotency-key'];return Array.isArray(value)?value[0]??'':value??'';}
function param(request:FastifyRequest,key:string){return String((request.params as Record<string,unknown>)[key]??'');}
function deriveTotal(items: OrderParticipantRecord[]) { const total=items.filter((item)=>item.status==='ACTIVE').reduce((sum,item)=>sum+item.linePriceMinor,0); if(!Number.isSafeInteger(total))throw new OrderParticipantError('VALIDATION_ERROR','Derived order total is outside the supported range.'); return total; }
function encodeCursor(offset:number){return Buffer.from(JSON.stringify({v:1,offset})).toString('base64url');}
function decodeCursor(cursor:string|null){if(!cursor)return 0;try{const value=JSON.parse(Buffer.from(cursor,'base64url').toString()) as {v?:unknown;offset?:unknown};if(value.v!==1||!Number.isSafeInteger(value.offset)||Number(value.offset)<0)throw new Error();return Number(value.offset);}catch{throw new OrderParticipantError('VALIDATION_ERROR','Cursor is invalid.');}}
function clone<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}
function mapError(error:unknown){if(!(error instanceof OrderParticipantError))return null;return{statusCode:error.code==='NOT_FOUND'?404:error.code==='PERMISSION_DENIED'?403:error.code==='CONFLICT'?409:error.code==='BUSINESS_RULE_ERROR'?422:400,code:error.code,message:error.message};}
function safeMinor(value:string|number){const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<0)throw new OrderParticipantError('VALIDATION_ERROR','Stored money is invalid.');return parsed;}
function safeSignedMinor(value:string|number){const parsed=Number(value);if(!Number.isSafeInteger(parsed))throw new OrderParticipantError('VALIDATION_ERROR','Stored money is invalid.');return parsed;}
function normalizePgError(error:unknown){if(error instanceof OrderParticipantError)return error;const code=(error as {code?:string})?.code;if(code==='23505')return new OrderParticipantError('CONFLICT','Player already has an active order line or idempotency key was reused.');if(code==='23503')return new OrderParticipantError('BUSINESS_RULE_ERROR','Referenced order participant data is invalid.');return error;}

interface OrderScopeRow { id:string;row_version:number;guild_id:string;status:string;captured:boolean }
interface CatalogFactsRow { display_name:string;id:string;status:string;billing_unit_minutes:number;customer_unit_price_minor:string|number;default_player_payout_bps:number;service_offering_id:string;game_code:string;game_name:string;service_code:string;service_name:string;region_code:string|null;region_name:string|null;compensation_type:ParticipantCompensationType|null;compensation_value:string|number|null }
function mapCatalogFacts(row:CatalogFactsRow):InMemoryParticipantCatalog{return{id:row.id,serviceOfferingId:row.service_offering_id,status:'ACTIVE',game:row.game_code,gameDisplayName:row.game_name,service:row.service_code,serviceDisplayName:row.service_name,region:row.region_code,regionDisplayName:row.region_name,billingUnitMinutes:Number(row.billing_unit_minutes),customerUnitPriceMinor:safeMinor(row.customer_unit_price_minor),defaultPlayerPayoutBps:Number(row.default_player_payout_bps)};}
function candidateProject(catalog:InMemoryParticipantCatalog){return{id:catalog.id,game:catalog.game,gameDisplayName:catalog.gameDisplayName,service:catalog.service,serviceDisplayName:catalog.serviceDisplayName,region:catalog.region,regionDisplayName:catalog.regionDisplayName,billingUnitMinutes:catalog.billingUnitMinutes,customerUnitPriceMinor:catalog.customerUnitPriceMinor};}
function mapCompensationFacts(row:CatalogFactsRow):InMemoryParticipantCompensation|null{return row.compensation_type&&row.compensation_value!==null?{playerUserId:'',serviceOfferingId:row.service_offering_id,type:row.compensation_type,value:safeMinor(row.compensation_value)}:null;}
function participantInsertValues(p:OrderParticipantRecord,staffId:string){return[p.id,p.orderId,p.playerId,p.serviceCatalogVersionId,p.displayName,p.game,p.gameDisplayName,p.service,p.serviceDisplayName,p.region,p.regionDisplayName,p.billingUnitMinutes,p.unitCount,p.customerUnitPriceMinor,p.linePriceMinor,p.compensationType,p.compensationValue,p.compensationSource,p.expectedEarningMinor,staffId,p.createdAt];}
interface ParticipantRow { id:string;order_id:string;player_id:string;service_catalog_version_id:string;status:OrderParticipantStatus;row_version:number;player_display_name_snapshot:string;game_code_snapshot:string;game_display_name_snapshot:string;service_code_snapshot:string;service_display_name_snapshot:string;region_code_snapshot:string|null;region_display_name_snapshot:string|null;billing_unit_minutes_snapshot:number;unit_count:number;customer_unit_price_minor_snapshot:string|number;line_price_minor:string|number;compensation_type_snapshot:ParticipantCompensationType;compensation_value_snapshot:string|number;compensation_source:ParticipantCompensationSource;expected_earning_minor:string|number;ready_at:string|Date|null;created_at:string|Date;updated_at:string|Date }
const participantSelect=`SELECT participant.id,participant.order_id,participant.player_id,participant.service_catalog_version_id,participant.status::text,participant.row_version,participant.player_display_name_snapshot,participant.game_code_snapshot,participant.game_display_name_snapshot,participant.service_code_snapshot,participant.service_display_name_snapshot,participant.region_code_snapshot,participant.region_display_name_snapshot,participant.billing_unit_minutes_snapshot,participant.unit_count,participant.customer_unit_price_minor_snapshot,participant.line_price_minor,participant.compensation_type_snapshot::text,participant.compensation_value_snapshot,participant.compensation_source::text,participant.expected_earning_minor,participant.ready_at,participant.created_at,participant.updated_at FROM order_participants participant`;
function mapParticipant(row:ParticipantRow):OrderParticipantRecord{return{id:row.id,orderId:row.order_id,playerId:row.player_id,displayName:row.player_display_name_snapshot,serviceCatalogVersionId:row.service_catalog_version_id,game:row.game_code_snapshot,gameDisplayName:row.game_display_name_snapshot,service:row.service_code_snapshot,serviceDisplayName:row.service_display_name_snapshot,region:row.region_code_snapshot,regionDisplayName:row.region_display_name_snapshot,billingUnitMinutes:Number(row.billing_unit_minutes_snapshot),unitCount:Number(row.unit_count),customerUnitPriceMinor:safeMinor(row.customer_unit_price_minor_snapshot),status:row.status,linePriceMinor:safeMinor(row.line_price_minor),compensationType:row.compensation_type_snapshot,compensationValue:safeMinor(row.compensation_value_snapshot),compensationSource:row.compensation_source,expectedEarningMinor:safeMinor(row.expected_earning_minor),readiness:row.ready_at?'READY':'NOT_READY',version:row.row_version,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()};}
