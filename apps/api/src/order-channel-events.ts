import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { insertPostgresAuditRecord, registerSecureReadRoute, registerSecureWriteRoute, type ActorContext, type AuditRecord } from './security.js';

export type OrderChannelEventType = 'CREATED' | 'UPDATED' | 'DELETED';
export interface OrderChannelEventInput {
  guildId: string; channelId: string; messageId: string; eventId: string; eventType: OrderChannelEventType;
  authorDiscordId: string | null; authorDisplayName: string | null; authorIsBot: boolean | null; content: string | null;
  embeds: unknown[]; attachments: unknown[]; replyToMessageId: string | null; discordCreatedAt: string | null; discordEditedAt: string | null;
}
export interface OrderChannelEventRecord extends OrderChannelEventInput {
  id: string; orderId: string; orderPublicId: string; observedAt: string; created: boolean;
}
export interface FirstResponseTaskProjection {
  id:string;orderId:string;status:'OPEN'|'CLAIMED'|'PENDING_APPROVAL'|'RESOLVED';
  responseStatus:'PENDING'|'OVERDUE'|'MET'|'NOT_REQUIRED';createdAt:string;claimedBy:string|null;claimedAt:string|null;
  firstRespondedAt:string|null;firstResponseEventId:string|null;contextSnapshot:Record<string,unknown>;
}
export interface FirstResponseStaffProjection {
  staffId:string;discordUserId:string;guildId:string;status:'ACTIVE'|'SUSPENDED'|'DISABLED';
  level:'L1_SUPPORT'|'L2_SUPERVISOR'|'L3_OPERATIONS'|'L4_ADMIN_OWNER';
}
interface Staged { data: OrderChannelEventRecord; commit(audit: AuditRecord): Promise<void> | void }
export interface OrderChannelTranscriptItem {
  eventId:string;messageId:string;eventType:OrderChannelEventType;authorDisplayName:string|null;content:string|null;
  replyToMessageId:string|null;attachmentMetadata:unknown[];occurredAt:string;deleted:boolean;
}
export interface OrderChannelTranscriptPage {items:OrderChannelTranscriptItem[];nextCursor:string|null}
export interface OrderChannelEventStore {
  stageRecord(input: OrderChannelEventInput & { observedAt: Date }): Promise<Staged> | Staged;
  listTranscript(input:{orderId:string;actor:ActorContext;cursor:string|null;limit:number}):Promise<OrderChannelTranscriptPage>|OrderChannelTranscriptPage;
}

export class OrderChannelEventError extends Error {
  constructor(readonly code: 'VALIDATION_ERROR' | 'NOT_FOUND', message: string) { super(message); this.name = 'OrderChannelEventError'; }
}

export class InMemoryOrderChannelEventStore implements OrderChannelEventStore {
  readonly events: OrderChannelEventRecord[] = [];
  private readonly orders = new Map<string, { orderId: string; orderPublicId: string }>();
  private readonly orderGuilds = new Map<string,string>();
  constructor(
    orders: Array<{ guildId: string; channelId: string; orderId: string; orderPublicId: string }> = [],
    private readonly support?: { tasks:FirstResponseTaskProjection[];staff:FirstResponseStaffProjection[] }
  ) {
    for (const order of orders) { this.orders.set(`${order.guildId}:${order.channelId}`, { orderId: order.orderId, orderPublicId: order.orderPublicId }); this.orderGuilds.set(order.orderId,order.guildId); }
  }
  stageRecord(input: OrderChannelEventInput & { observedAt: Date }): Staged {
    const order = this.orders.get(`${input.guildId}:${input.channelId}`);
    if (!order) throw new OrderChannelEventError('NOT_FOUND', 'Order channel is not registered.');
    const existing = this.events.find((item) => item.eventId === input.eventId);
    const data: OrderChannelEventRecord = existing ? { ...existing, created: false } : {
      ...input, ...order, id: randomUUID(), observedAt: input.observedAt.toISOString(), created: true
    };
    return { data, commit: () => { if (!existing) { this.events.push(structuredClone(data)); applyFirstResponseProjection(this.support,data); } } };
  }
  listTranscript(input:{orderId:string;actor:ActorContext;cursor:string|null;limit:number}):OrderChannelTranscriptPage {
    requireTranscriptScope(input.actor,input.orderId,this.orderGuilds.get(input.orderId),this.support?.tasks);
    return pageTranscript(this.events.filter((event)=>event.orderId===input.orderId),input.cursor,input.limit);
  }
}

export function applyFirstResponseProjection(
  support:{tasks:FirstResponseTaskProjection[];staff:FirstResponseStaffProjection[]}|undefined,
  event:OrderChannelEventRecord
):string|null {
  if(!support||event.eventType!=='CREATED'||event.authorIsBot!==false||!event.authorDiscordId
    ||(!event.content?.trim()&&event.attachments.length===0))return null;
  const staff=support.staff.find((item)=>item.guildId===event.guildId&&item.discordUserId===event.authorDiscordId&&item.status==='ACTIVE');
  if(!staff)return null;
  const respondedAt=event.discordCreatedAt??event.observedAt;
  const respondedAtMs=Date.parse(respondedAt);
  const eligible=support.tasks.filter((task)=>task.orderId===event.orderId&&['PENDING','OVERDUE'].includes(task.responseStatus)
    &&['OPEN','CLAIMED','PENDING_APPROVAL'].includes(task.status)&&respondedAtMs>=Date.parse(task.createdAt));
  const hasOwner=support.tasks.some((task)=>task.orderId===event.orderId&&(task.status==='CLAIMED'||task.status==='PENDING_APPROVAL'));
  const claimed=hasOwner?undefined:eligible.filter((task)=>task.status==='OPEN')
    .sort((left,right)=>left.createdAt.localeCompare(right.createdAt)||left.id.localeCompare(right.id))[0];
  if(claimed){
    claimed.status='CLAIMED';claimed.claimedBy=staff.staffId;claimed.claimedAt=respondedAt;
    claimed.contextSnapshot={...claimed.contextSnapshot,claimSource:'DISCORD_FIRST_RESPONSE',claimMessageEventId:event.id};
  }
  for(const task of eligible){task.responseStatus='MET';task.firstRespondedAt=respondedAt;task.firstResponseEventId=event.id;}
  return claimed?.id??null;
}

export class PostgresOrderChannelEventStore implements OrderChannelEventStore {
  constructor(private readonly pool: Pool) {}
  async stageRecord(input: OrderChannelEventInput & { observedAt: Date }): Promise<Staged> {
    const order = await this.pool.query<{ id: string; public_id: string }>(
      'SELECT id,public_id FROM orders WHERE guild_id=$1 AND channel_id=$2', [input.guildId, input.channelId]);
    const row = order.rows[0];
    if (!row) throw new OrderChannelEventError('NOT_FOUND', 'Order channel is not registered.');
    const existing = await this.pool.query<OrderChannelEventRecord & { order_public_id: string }>(
      'SELECT id FROM order_channel_message_events WHERE event_id=$1', [input.eventId]);
    const data: OrderChannelEventRecord = { ...input, id: existing.rows[0]?.id ?? randomUUID(), orderId: row.id,
      orderPublicId: row.public_id, observedAt: input.observedAt.toISOString(), created: existing.rows.length === 0 };
    return { data, commit: async (audit) => { const client = await this.pool.connect(); try { await client.query('BEGIN');
      const inserted = await client.query<{id:string}>(`INSERT INTO order_channel_message_events
        (id,order_id,order_public_id,guild_id,channel_id,discord_message_id,event_id,event_type,author_discord_id,author_display_name,author_is_bot,
         content_snapshot,embeds_snapshot,attachments_snapshot,reply_to_message_id,discord_created_at,discord_edited_at,observed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18)
        ON CONFLICT (event_id) DO NOTHING RETURNING id`,
      [data.id,data.orderId,data.orderPublicId,data.guildId,data.channelId,data.messageId,data.eventId,data.eventType,data.authorDiscordId,
       data.authorDisplayName,data.authorIsBot,data.content,JSON.stringify(data.embeds),JSON.stringify(data.attachments),data.replyToMessageId,
       data.discordCreatedAt,data.discordEditedAt,data.observedAt]);
      if (inserted.rows[0] && data.eventType === 'CREATED' && data.authorIsBot === false && data.authorDiscordId
        && (Boolean(data.content?.trim()) || data.attachments.length > 0)) {
        const respondedAt = data.discordCreatedAt ?? data.observedAt;
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [data.orderId]);
        const staffResult = await client.query<{ id:string;user_id:string;level:'L1_SUPPORT'|'L2_SUPERVISOR'|'L3_OPERATIONS'|'L4_ADMIN_OWNER' }>(
          `SELECT sa.id,sa.user_id,sa.level::text level FROM discord_accounts da
           JOIN staff_accounts sa ON sa.user_id=da.user_id AND sa.status='ACTIVE'
           WHERE da.guild_id=$1 AND da.discord_user_id=$2 LIMIT 1`, [data.guildId,data.authorDiscordId]);
        const staff = staffResult.rows[0];
        if (staff) {
          const claimed = await client.query<{id:string}>(`WITH target AS (
            SELECT st.id FROM staff_tasks st
            WHERE st.order_id=$1 AND st.status='OPEN' AND st.response_status IN ('PENDING','OVERDUE') AND $3::timestamptz>=st.created_at
              AND NOT EXISTS (SELECT 1 FROM staff_tasks existing WHERE existing.order_id=st.order_id AND existing.status IN ('CLAIMED','PENDING_APPROVAL'))
            ORDER BY st.created_at ASC, st.id ASC LIMIT 1 FOR UPDATE
          ) UPDATE staff_tasks st SET status='CLAIMED',claimed_by_staff_id=$2,claimed_at=$3,row_version=row_version+1,updated_at=$4,
              context_snapshot=context_snapshot||jsonb_build_object('claimSource','DISCORD_FIRST_RESPONSE','claimMessageEventId',$5::text)
            FROM target WHERE st.id=target.id AND st.status='OPEN' RETURNING st.id`,
          [data.orderId,staff.id,respondedAt,data.observedAt,data.id]);
          const responded = await client.query<{id:string}>(`UPDATE staff_tasks st SET response_status='MET',first_responded_at=$2,first_response_event_id=$3,
              row_version=row_version+1,updated_at=$4
            WHERE st.order_id=$1 AND st.response_status IN ('PENDING','OVERDUE') AND st.status IN ('OPEN','CLAIMED','PENDING_APPROVAL')
              AND $2::timestamptz>=st.created_at RETURNING st.id`,[data.orderId,respondedAt,data.id,data.observedAt]);
          for(const task of responded.rows)await client.query(`INSERT INTO outbox_events
            (id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,created_at,updated_at)
            VALUES($1,'SUPPORT_RESPONSE_REMINDER','staff_task',$2,$3,$4,$5::jsonb,'PENDING',1,0,8,$6,$6,$6)
            ON CONFLICT(dedupe_key) DO NOTHING`,[
            randomUUID(),task.id,data.orderId,`support-response-reminder-met:${task.id}:${data.id}`,
            JSON.stringify({staffTaskId:task.id}),data.observedAt
          ]);
          if (claimed.rows[0]) await insertPostgresAuditRecord(client,{
            id:randomUUID(),actorId:staff.user_id,actorStaffId:staff.id,actorLevel:staff.level,actorSource:'DISCORD_BOT',
            clientId:'DISCORD_BOT_SERVICE',interactionId:null,permissionCode:'staff_task.claim',action:'AUTO_CLAIM_STAFF_TASK',
            targetType:'staff_task',targetId:claimed.rows[0].id,outcome:'SUCCEEDED',reason:'DISCORD_FIRST_RESPONSE',
            requestId:audit.requestId,approvalRequestId:null,occurredAt:data.observedAt
          });
        }
      }
      await insertPostgresAuditRecord(client,audit); await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); } } };
  }
  async listTranscript(input:{orderId:string;actor:ActorContext;cursor:string|null;limit:number}):Promise<OrderChannelTranscriptPage> {
    if(!input.actor.guildId||!input.actor.actorStaffId||!input.actor.actorLevel)throw new OrderChannelEventError('NOT_FOUND','Order transcript was not found.');
    const offset=decodeCursor(input.cursor);
    const l1=input.actor.actorLevel==='L1_SUPPORT';
    const scope=`AND ($6::boolean = false OR EXISTS (SELECT 1 FROM staff_tasks task WHERE task.order_id=orders.id AND task.claimed_by_staff_id=$3 AND task.status IN ('CLAIMED','VERIFIED','PENDING_APPROVAL')))`;
    const result=await this.pool.query<TranscriptRow>(`SELECT event.event_id,event.discord_message_id,event.event_type::text,event.author_display_name,event.content_snapshot,event.reply_to_message_id,event.attachments_snapshot,event.discord_created_at,event.discord_edited_at,event.observed_at
      FROM order_channel_message_events event JOIN orders ON orders.id=event.order_id
      WHERE orders.id=$1 AND orders.guild_id=$2 ${scope}
      ORDER BY event.observed_at ASC,event.id ASC OFFSET $4 LIMIT $5`,[input.orderId,input.actor.guildId,input.actor.actorStaffId,offset,input.limit+1,l1]);
    if(!result.rows.length&&offset===0){const visible=await this.pool.query(`SELECT 1 FROM orders WHERE id=$1 AND guild_id=$2 AND ($4::boolean = false OR EXISTS (SELECT 1 FROM staff_tasks task WHERE task.order_id=orders.id AND task.claimed_by_staff_id=$3 AND task.status IN ('CLAIMED','VERIFIED','PENDING_APPROVAL')))`,[input.orderId,input.actor.guildId,input.actor.actorStaffId,l1]);if(!visible.rows[0])throw new OrderChannelEventError('NOT_FOUND','Order transcript was not found.');}
    const more=result.rows.length>input.limit;const rows=result.rows.slice(0,input.limit);
    return{items:rows.map(mapTranscriptRow),nextCursor:more?encodeCursor(offset+input.limit):null};
  }
}

export async function recordOrderChannelEvent(input: { store: OrderChannelEventStore; event: OrderChannelEventInput; observedAt: Date }) {
  validate(input.event);
  const staged = await input.store.stageRecord({ ...input.event, observedAt: input.observedAt });
  await staged.commit({ id: randomUUID(), actorId:null,actorStaffId:null,actorLevel:null,actorSource:'DISCORD_BOT',clientId:'DISCORD_BOT_SERVICE',
    interactionId:null,permissionCode:'transcript.event.append',action:'APPEND_ORDER_CHANNEL_EVENT',targetType:'order_channel_message_event',
    targetId:staged.data.id,outcome:'SUCCEEDED',reason:null,requestId:'internal',approvalRequestId:null,occurredAt:input.observedAt.toISOString() });
  return staged.data;
}

export function registerOrderChannelEventRoutes(server: FastifyInstance, options: { store: OrderChannelEventStore; now?: () => Date }): void {
  if (!server.securityOptions) throw new Error('Order channel event routes require security options.');
  registerSecureWriteRoute(server, server.securityOptions, { method:'POST',url:'/api/v1/internal/order-channel-events',permission:'transcript.event.append',
    action:'APPEND_ORDER_CHANNEL_EVENT',targetType:'order_channel_message_event',acceptedSources:['DISCORD_BOT'],allowServiceActor:true,successStatusCode:201,
    targetId:(request)=>String((request.body as Record<string,unknown>)?.eventId??'unknown'),mapError,
    handler:(request)=>{const event=parse(request);validate(event);return options.store.stageRecord({...event,observedAt:(options.now??(()=>new Date()))()});} });
  registerSecureReadRoute(server,server.securityOptions,{method:'GET',url:'/api/v1/admin/orders/:orderId/transcript',permission:'order.read',
    action:'LIST_ADMIN_ORDER_TRANSCRIPT',targetType:'order',targetId:request=>String((request.params as {orderId:string}).orderId),acceptedSources:['DASHBOARD'],
    handler:(request,actor)=>{const query=request.query as Record<string,unknown>;const limit=query.limit===undefined?25:Number(query.limit);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new OrderChannelEventError('VALIDATION_ERROR','limit must be from 1 to 100.');return options.store.listTranscript({orderId:String((request.params as {orderId:string}).orderId),actor,cursor:typeof query.cursor==='string'?query.cursor:null,limit});},mapError});
}

function parse(request: FastifyRequest): OrderChannelEventInput { const body=request.body as Record<string,unknown>; return {
  guildId:String(body.guildId??''),channelId:String(body.channelId??''),messageId:String(body.messageId??''),eventId:String(body.eventId??''),
  eventType:String(body.eventType??'') as OrderChannelEventType,authorDiscordId:nullable(body.authorDiscordId),authorDisplayName:nullable(body.authorDisplayName),
  authorIsBot:typeof body.authorIsBot==='boolean'?body.authorIsBot:null,content:nullable(body.content),embeds:Array.isArray(body.embeds)?body.embeds:[],
  attachments:Array.isArray(body.attachments)?body.attachments:[],replyToMessageId:nullable(body.replyToMessageId),discordCreatedAt:nullable(body.discordCreatedAt),
  discordEditedAt:nullable(body.discordEditedAt) }; }
function nullable(value:unknown){return typeof value==='string'?value:null;}
function validate(value:OrderChannelEventInput){if(!/^\d{17,20}$/u.test(value.guildId)||!/^\d{17,20}$/u.test(value.channelId)||!/^\d{17,20}$/u.test(value.messageId))throw new OrderChannelEventError('VALIDATION_ERROR','Discord identifiers are invalid.');if(!['CREATED','UPDATED','DELETED'].includes(value.eventType)||!value.eventId||value.eventId.length>150)throw new OrderChannelEventError('VALIDATION_ERROR','Transcript event is invalid.');if(value.content&&value.content.length>4000)throw new OrderChannelEventError('VALIDATION_ERROR','Message content is too long.');}
function mapError(error:unknown){return error instanceof OrderChannelEventError?{statusCode:error.code==='NOT_FOUND'?404:400,code:error.code,message:error.message}:null;}
function requireTranscriptScope(actor:ActorContext,orderId:string,guildId:string|undefined,tasks:FirstResponseTaskProjection[]|undefined){if(!actor.guildId||!actor.actorStaffId||!actor.actorLevel||guildId!==actor.guildId)throw new OrderChannelEventError('NOT_FOUND','Order transcript was not found.');if(actor.actorLevel==='L1_SUPPORT'&&!tasks?.some(task=>task.orderId===orderId&&task.claimedBy===actor.actorStaffId&&['CLAIMED','PENDING_APPROVAL'].includes(task.status)))throw new OrderChannelEventError('NOT_FOUND','Order transcript was not found.');}
function pageTranscript(events:OrderChannelEventRecord[],cursor:string|null,limit:number):OrderChannelTranscriptPage{const offset=decodeCursor(cursor);const sorted=[...events].sort((a,b)=>a.observedAt.localeCompare(b.observedAt)||a.id.localeCompare(b.id));const rows=sorted.slice(offset,offset+limit);return{items:rows.map(event=>({eventId:event.eventId,messageId:event.messageId,eventType:event.eventType,authorDisplayName:event.authorDisplayName,content:event.content,replyToMessageId:event.replyToMessageId,attachmentMetadata:structuredClone(event.attachments),occurredAt:event.discordEditedAt??event.discordCreatedAt??event.observedAt,deleted:event.eventType==='DELETED'})),nextCursor:offset+limit<sorted.length?encodeCursor(offset+limit):null};}
function encodeCursor(offset:number){return Buffer.from(JSON.stringify({v:1,offset})).toString('base64url');}
function decodeCursor(value:string|null){if(!value)return 0;try{const parsed=JSON.parse(Buffer.from(value,'base64url').toString()) as {v?:unknown;offset?:unknown};if(parsed.v!==1||!Number.isSafeInteger(parsed.offset)||Number(parsed.offset)<0)throw new Error();return Number(parsed.offset);}catch{throw new OrderChannelEventError('VALIDATION_ERROR','Cursor is invalid.');}}
interface TranscriptRow{event_id:string;discord_message_id:string;event_type:OrderChannelEventType;author_display_name:string|null;content_snapshot:string|null;reply_to_message_id:string|null;attachments_snapshot:unknown;discord_created_at:Date|string|null;discord_edited_at:Date|string|null;observed_at:Date|string}
function mapTranscriptRow(row:TranscriptRow):OrderChannelTranscriptItem{return{eventId:row.event_id,messageId:row.discord_message_id,eventType:row.event_type,authorDisplayName:row.author_display_name,content:row.content_snapshot,replyToMessageId:row.reply_to_message_id,attachmentMetadata:Array.isArray(row.attachments_snapshot)?row.attachments_snapshot:[],occurredAt:iso(row.discord_edited_at??row.discord_created_at??row.observed_at),deleted:row.event_type==='DELETED'};}
function iso(value:Date|string){return value instanceof Date?value.toISOString():new Date(value).toISOString();}
