import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { PostgresOrderStore, type OrderRecord } from './orders.js';
import type { StaffLevel } from './security.js';

export type TransactionTimelineType =
  | 'WALLET_ENTRY' | 'ORDER_EVENT' | 'FUND_RESERVATION_EVENT' | 'EXTERNAL_TRANSACTION'
  | 'CONSUMPTION' | 'REFUND' | 'PLAYER_EARNING' | 'PLAYER_EARNING_ADJUSTMENT'
  | 'COMMISSION' | 'COMMISSION_ADJUSTMENT';

export interface TransactionTimelineItem {
  id: string;
  type: TransactionTimelineType;
  status: string;
  direction: 'DEBIT' | 'CREDIT' | 'HOLD' | 'RELEASE' | 'INFO';
  amountMinor: number | null;
  currency: string | null;
  sourceType: string;
  sourceId: string;
  requestId: string | null;
  actor: { source: string; userId: string | null; staffId: string | null };
  occurredAt: string;
}

export interface AdminOrderTimelineDetail {
  order: OrderRecord & {customerDiscordUserId?:string|null;customerDiscordTag?:string|null;customerDisplayName?:string|null;sourcePackageCode?:string|null;sourcePackageDisplayName?:string|null;sourcePackageVersion?:number|null};
  fundReservation: Record<string, unknown> | null;
  transactions: Array<Record<string, unknown>>;
  resolutions: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  timeline: { items: TransactionTimelineItem[]; nextCursor: string | null };
}

export interface TransactionTimelineStore {
  getAdminOrder(input: { orderId: string; actorStaffId: string; actorLevel: StaffLevel; cursor: string | null; limit: number }): Promise<AdminOrderTimelineDetail | null> | AdminOrderTimelineDetail | null;
}

export class TransactionTimelineError extends Error {
  constructor(readonly code: 'INVALID_CURSOR', message: string) { super(message); this.name = 'TransactionTimelineError'; }
}

const signingKey = process.env.BOT_SERVICE_TOKEN ? Buffer.from(process.env.BOT_SERVICE_TOKEN) : randomBytes(32);

export class InMemoryTransactionTimelineStore implements TransactionTimelineStore {
  constructor(private readonly input: { orders: OrderRecord[]; details?: Record<string, Omit<AdminOrderTimelineDetail, 'order' | 'timeline'>>; timelineByOrderId?: Record<string, TransactionTimelineItem[]>; visibleOrderIdsByStaffId?: Record<string, string[]>; teamVisibleOrderIdsByStaffId?: Record<string, string[]> }) {}

  getAdminOrder(input: { orderId: string; actorStaffId: string; actorLevel: StaffLevel; cursor: string | null; limit: number }) {
    const order = this.input.orders.find((candidate) => candidate.id === input.orderId);
    if (!order || (input.actorLevel === 'L1_SUPPORT' && !(this.input.visibleOrderIdsByStaffId?.[input.actorStaffId] ?? []).includes(order.id))) return null;
    if (input.actorLevel === 'L2_SUPERVISOR' && this.input.teamVisibleOrderIdsByStaffId && !(this.input.teamVisibleOrderIdsByStaffId[input.actorStaffId] ?? []).includes(order.id)) return null;
    const timeline = redactTimeline(this.input.timelineByOrderId?.[order.id] ?? [], input.actorLevel);
    const page = timelinePage(timeline, input.cursor, input.limit, input.orderId, input.actorLevel);
    const detail = this.input.details?.[order.id];
    return { order: clone(order), fundReservation: clone(detail?.fundReservation ?? null), transactions: clone(detail?.transactions ?? []), resolutions: clone(detail?.resolutions ?? []), events: clone(detail?.events ?? []), timeline: page };
  }
}

export class PostgresTransactionTimelineStore implements TransactionTimelineStore {
  private readonly orders: PostgresOrderStore;
  constructor(private readonly pool: Pool) { this.orders = new PostgresOrderStore({ pool }); }

  async getAdminOrder(input: { orderId: string; actorStaffId: string; actorLevel: StaffLevel; cursor: string | null; limit: number }) {
    if (input.actorLevel === 'L1_SUPPORT') {
      const scoped = await this.pool.query(`SELECT 1 FROM staff_tasks WHERE order_id=$1 AND claimed_by_staff_id=$2 AND status IN ('CLAIMED','VERIFIED','PENDING_APPROVAL') LIMIT 1`, [input.orderId, input.actorStaffId]);
      if (!scoped.rows[0]) return null;
    }
    if (input.actorLevel === 'L2_SUPERVISOR') {
      const scoped = await this.pool.query(`SELECT 1 FROM orders o JOIN staff_accounts sa ON sa.id=$2
        JOIN discord_accounts da ON da.user_id=sa.user_id AND da.guild_id=o.guild_id
        WHERE o.id=$1 LIMIT 1`, [input.orderId, input.actorStaffId]);
      if (!scoped.rows[0]) return null;
    }
    const order = await this.orders.findById(input.orderId);
    if (!order) return null;
    const [identity,reservation, transactions, resolutions, events, timelineRows] = await Promise.all([
      this.pool.query<{discord_user_id:string|null;discord_tag:string|null;display_name:string|null;source_package_code:string|null;source_package_display_name:string|null;source_package_version:number|null}>(`SELECT account.discord_user_id,account.username discord_tag,users.display_name,package.code source_package_code,package_version.display_name source_package_display_name,package_version.version source_package_version FROM orders JOIN users ON users.id=orders.customer_id LEFT JOIN discord_accounts account ON account.user_id=orders.customer_id AND account.guild_id=orders.guild_id LEFT JOIN service_package_versions package_version ON package_version.id=orders.source_package_version_id LEFT JOIN service_packages package ON package.id=package_version.service_package_id WHERE orders.id=$1 LIMIT 1`,[input.orderId]),
      this.pool.query(`SELECT fr.id,fr.user_id,fr.source_type::text,fr.order_id,fr.amount_minor,fr.currency,fr.status::text,fr.mode::text,fr.provider_hold_ref,fr.row_version,fr.expires_at,fr.created_at,fr.updated_at,
        COALESCE(sum(fre.amount_minor) FILTER (WHERE fre.event_type='CAPTURED'),0) AS captured_minor,
        COALESCE(sum(fre.amount_minor) FILTER (WHERE fre.event_type IN ('RELEASED','EXPIRED')),0) AS released_minor
        FROM fund_reservations fr LEFT JOIN fund_reservation_events fre ON fre.fund_reservation_id=fr.id
        WHERE fr.order_id=$1 GROUP BY fr.id`, [input.orderId]),
      this.pool.query(`SELECT id,provider,type::text,amount_minor,currency,status::text,request_id,failure_code,initiated_at,settled_at FROM external_transactions
        WHERE order_id=$1 OR gift_request_id IN (SELECT id FROM gift_requests WHERE order_id=$1) ORDER BY initiated_at,id`, [input.orderId]),
      this.pool.query(`SELECT id,target_status::text,reason_code::text,refund_amount_minor,player_earning_minor,currency,resolved_by_staff_id,approval_request_id,created_at FROM order_resolutions WHERE order_id=$1 ORDER BY created_at,id`, [input.orderId]),
      this.pool.query(`SELECT id,sequence,event_type::text,from_status::text,to_status::text,actor_user_id,actor_staff_id,actor_source::text,interaction_id,payload,created_at FROM order_events WHERE order_id=$1 ORDER BY sequence`, [input.orderId]),
      this.pool.query<TimelineRow>(timelineSql, [input.orderId])
    ]);
    const raw = timelineRows.rows.map(mapTimelineRow);
    return {
      order:{...order,customerDiscordUserId:identity.rows[0]?.discord_user_id??null,customerDiscordTag:identity.rows[0]?.discord_tag??null,customerDisplayName:identity.rows[0]?.display_name??null,sourcePackageCode:identity.rows[0]?.source_package_code??null,sourcePackageDisplayName:identity.rows[0]?.source_package_display_name??null,sourcePackageVersion:identity.rows[0]?.source_package_version??null},
      fundReservation: reservation.rows[0] ? mapReservation(reservation.rows[0] as Record<string, unknown>) : null,
      transactions: transactions.rows.map((row) => mapRecord(row as Record<string, unknown>)),
      resolutions: resolutions.rows.map((row) => mapRecord(row as Record<string, unknown>)),
      events: events.rows.map((row) => mapRecord(row as Record<string, unknown>)),
      timeline: timelinePage(redactTimeline(raw, input.actorLevel), input.cursor, input.limit, input.orderId, input.actorLevel)
    };
  }
}

const timelineSql = `
SELECT id,'ORDER_EVENT' AS type,event_type::text AS status,'INFO' AS direction,NULL::bigint AS amount_minor,NULL::text AS currency,
  'ORDER_EVENT' AS source_type,id AS source_id,NULL::text AS request_id,actor_source::text AS actor_source,actor_user_id,actor_staff_id,created_at AS occurred_at
FROM order_events WHERE order_id=$1
UNION ALL
SELECT fre.id,'FUND_RESERVATION_EVENT',fre.event_type::text,CASE WHEN fre.event_type::text IN ('RELEASED','EXPIRED') THEN 'RELEASE' ELSE 'HOLD' END,
  fre.amount_minor,fr.currency,'FUND_RESERVATION_EVENT',fre.id,NULL,fre.actor_source::text,fre.actor_user_id,fre.actor_staff_id,fre.created_at
FROM fund_reservation_events fre JOIN fund_reservations fr ON fr.id=fre.fund_reservation_id WHERE fr.order_id=$1
UNION ALL
SELECT et.id,'EXTERNAL_TRANSACTION',et.status::text,CASE WHEN et.type::text='REFUND' THEN 'CREDIT' ELSE 'DEBIT' END,et.amount_minor,et.currency,
  'EXTERNAL_TRANSACTION',et.id,et.request_id,'SYSTEM_JOB',NULL,NULL,et.initiated_at FROM external_transactions et
  WHERE et.order_id=$1 OR et.gift_request_id IN (SELECT id FROM gift_requests WHERE order_id=$1)
UNION ALL
SELECT ce.id,'CONSUMPTION',ce.entry_type::text,ce.direction::text,ce.amount_minor,ce.currency,'CONSUMPTION_ENTRY',ce.source_id,NULL,'SYSTEM_JOB',ce.user_id,NULL,ce.occurred_at
FROM consumption_entries ce WHERE ce.order_id=$1 OR ce.gift_request_id IN (SELECT id FROM gift_requests WHERE order_id=$1)
UNION ALL
SELECT r.id,'REFUND',r.status::text,'CREDIT',r.amount_minor,r.currency,'REFUND',r.id,NULL,CASE WHEN r.requested_by_staff_id IS NULL THEN 'DISCORD_BOT' ELSE 'DASHBOARD' END,r.requested_by_user_id,r.requested_by_staff_id,r.requested_at
FROM refunds r WHERE r.order_id=$1 OR r.gift_request_id IN (SELECT id FROM gift_requests WHERE order_id=$1)
UNION ALL
SELECT pe.id,'PLAYER_EARNING',pe.status::text,'CREDIT',pe.amount_minor,pe.currency,'PLAYER_EARNING',pe.id,NULL,'SYSTEM_JOB',pe.player_user_id,pe.confirmed_by_staff_id,pe.created_at
FROM player_earnings pe WHERE pe.order_id=$1
UNION ALL
SELECT pea.id,'PLAYER_EARNING_ADJUSTMENT',pea.type::text,CASE WHEN pea.type::text='CORRECTION_CREDIT' THEN 'CREDIT' ELSE 'DEBIT' END,pea.amount_minor,pea.currency,'PLAYER_EARNING_ADJUSTMENT',pea.id,NULL,'DASHBOARD',NULL,pea.created_by_staff_id,pea.created_at
FROM player_earning_adjustments pea JOIN player_earnings pe ON pe.id=pea.player_earning_id WHERE pe.order_id=$1
UNION ALL
SELECT c.id,'COMMISSION',c.status::text,'CREDIT',c.amount_minor,c.currency,'COMMISSION',c.id,NULL,'SYSTEM_JOB',NULL,NULL,c.created_at
FROM commissions c JOIN consumption_entries ce ON ce.id=c.source_consumption_entry_id
WHERE ce.order_id=$1 OR ce.gift_request_id IN (SELECT id FROM gift_requests WHERE order_id=$1)
UNION ALL
SELECT ca.id,'COMMISSION_ADJUSTMENT',ca.type::text,CASE WHEN ca.type::text='CORRECTION_CREDIT' THEN 'CREDIT' ELSE 'DEBIT' END,ca.amount_minor,ca.currency,'COMMISSION_ADJUSTMENT',ca.id,NULL,'DASHBOARD',NULL,ca.created_by_staff_id,ca.created_at
FROM commission_adjustments ca JOIN commissions c ON c.id=ca.commission_id JOIN consumption_entries ce ON ce.id=c.source_consumption_entry_id
WHERE ce.order_id=$1 OR ce.gift_request_id IN (SELECT id FROM gift_requests WHERE order_id=$1)
UNION ALL
SELECT we.id,'WALLET_ENTRY',we.entry_type::text,we.direction::text,we.amount_minor,we.currency,we.source_type,we.source_id,NULL,'SYSTEM_JOB',wa.user_id,NULL,we.occurred_at
FROM wallet_entries we JOIN wallet_accounts wa ON wa.id=we.wallet_account_id
WHERE (we.source_type='FUND_RESERVATION' AND we.source_id IN (
  SELECT id FROM fund_reservations WHERE order_id=$1 OR gift_request_id IN (SELECT id FROM gift_requests WHERE order_id=$1)))
OR (we.source_type='ORDER_REFUND' AND we.source_id IN (SELECT id FROM refunds WHERE order_id=$1))
ORDER BY occurred_at DESC,id DESC`;

function redactTimeline(items: TransactionTimelineItem[], level: StaffLevel): TransactionTimelineItem[] {
  return items.filter((item) => levelRank(level) >= 3 || !item.type.startsWith('COMMISSION'))
    .filter((item) => level !== 'L1_SUPPORT' || item.type === 'ORDER_EVENT' || item.type === 'FUND_RESERVATION_EVENT')
    .map((item) => level === 'L1_SUPPORT' ? { ...clone(item), amountMinor: null, currency: null, actor: { ...item.actor, userId: null, staffId: null }, requestId: null } : clone(item));
}

function timelinePage(items: TransactionTimelineItem[], cursor: string | null, limit: number, orderId: string, level: StaffLevel) {
  const sorted = [...items].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
  const keys = decodeCursor(cursor, orderId, level);
  const filtered = keys ? sorted.filter((item) => item.occurredAt < keys[0]! || (item.occurredAt === keys[0] && item.id < keys[1]!)) : sorted;
  const visible = filtered.slice(0, limit);
  return { items: visible, nextCursor: filtered.length > limit && visible.length ? encodeCursor([visible.at(-1)!.occurredAt, visible.at(-1)!.id], orderId, level) : null };
}

function encodeCursor(keys: string[], orderId: string, level: StaffLevel) { const body=Buffer.from(JSON.stringify({version:1,resource:'order_timeline',orderId,level,keys})).toString('base64url');const sig=createHmac('sha256',signingKey).update(body).digest('base64url');return `${body}.${sig}`; }
function decodeCursor(cursor:string|null,orderId:string,level:StaffLevel):string[]|null{if(!cursor)return null;try{const [body,sig,...rest]=cursor.split('.');if(!body||!sig||rest.length)throw new Error();const expected=createHmac('sha256',signingKey).update(body).digest();const actual=Buffer.from(sig,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error();const value=JSON.parse(Buffer.from(body,'base64url').toString()) as {version?:unknown;resource?:unknown;orderId?:unknown;level?:unknown;keys?:unknown};if(value.version!==1||value.resource!=='order_timeline'||value.orderId!==orderId||value.level!==level||!Array.isArray(value.keys)||value.keys.length!==2||value.keys.some((key)=>typeof key!=='string'))throw new Error();return value.keys as string[];}catch{throw new TransactionTimelineError('INVALID_CURSOR','Timeline cursor is invalid.');}}
function levelRank(level:StaffLevel){return {L1_SUPPORT:1,L2_SUPERVISOR:2,L3_OPERATIONS:3,L4_ADMIN_OWNER:4}[level];}
function mapTimelineRow(row:TimelineRow):TransactionTimelineItem{return{id:row.id,type:row.type,status:row.status,direction:row.direction,amountMinor:row.amount_minor===null?null:safeMinor(row.amount_minor),currency:row.currency,sourceType:row.source_type,sourceId:row.source_id,requestId:row.request_id,actor:{source:row.actor_source,userId:row.actor_user_id,staffId:row.actor_staff_id},occurredAt:new Date(row.occurred_at).toISOString()};}
function mapReservation(row:Record<string,unknown>){return{id:row.id,sourceType:row.source_type,sourceId:row.order_id,ownerUserId:row.user_id,amountMinor:safeMinor(row.amount_minor),capturedMinor:safeMinor(row.captured_minor),releasedMinor:safeMinor(row.released_minor),currency:row.currency,status:row.status,backend:row.mode,walletHoldReferenceDisplay:null,version:row.row_version,expiresAt:dateOrNull(row.expires_at),createdAt:date(row.created_at),updatedAt:date(row.updated_at)};}
function mapRecord(row:Record<string,unknown>){return Object.fromEntries(Object.entries(row).map(([key,value])=>[camel(key),value instanceof Date?value.toISOString():key.endsWith('_minor')&&value!==null?safeMinor(value):typeof value==='bigint'?Number(value):value]));}
function camel(value:string){return value.replace(/_([a-z])/g,(_,letter:string)=>letter.toUpperCase());}
function safeMinor(value:unknown){const result=Number(value);if(!Number.isSafeInteger(result))throw new Error('Timeline amount is outside the safe integer range.');return result;}
function date(value:unknown){return new Date(value as string|number|Date).toISOString();}
function dateOrNull(value:unknown){return value==null?null:date(value);}
function clone<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}

interface TimelineRow { id:string;type:TransactionTimelineType;status:string;direction:TransactionTimelineItem['direction'];amount_minor:string|number|bigint|null;currency:string|null;source_type:string;source_id:string;request_id:string|null;actor_source:string;actor_user_id:string|null;actor_staff_id:string|null;occurred_at:string|Date }
