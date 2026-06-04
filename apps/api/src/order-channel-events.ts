import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { insertPostgresAuditRecord, registerSecureWriteRoute, type AuditRecord } from './security.js';

export type OrderChannelEventType = 'CREATED' | 'UPDATED' | 'DELETED';
export interface OrderChannelEventInput {
  guildId: string; channelId: string; messageId: string; eventId: string; eventType: OrderChannelEventType;
  authorDiscordId: string | null; authorDisplayName: string | null; authorIsBot: boolean | null; content: string | null;
  embeds: unknown[]; attachments: unknown[]; replyToMessageId: string | null; discordCreatedAt: string | null; discordEditedAt: string | null;
}
export interface OrderChannelEventRecord extends OrderChannelEventInput {
  id: string; orderId: string; orderPublicId: string; observedAt: string; created: boolean;
}
interface Staged { data: OrderChannelEventRecord; commit(audit: AuditRecord): Promise<void> | void }
export interface OrderChannelEventStore { stageRecord(input: OrderChannelEventInput & { observedAt: Date }): Promise<Staged> | Staged }

export class OrderChannelEventError extends Error {
  constructor(readonly code: 'VALIDATION_ERROR' | 'NOT_FOUND', message: string) { super(message); this.name = 'OrderChannelEventError'; }
}

export class InMemoryOrderChannelEventStore implements OrderChannelEventStore {
  readonly events: OrderChannelEventRecord[] = [];
  private readonly orders = new Map<string, { orderId: string; orderPublicId: string }>();
  constructor(orders: Array<{ guildId: string; channelId: string; orderId: string; orderPublicId: string }> = []) {
    for (const order of orders) this.orders.set(`${order.guildId}:${order.channelId}`, { orderId: order.orderId, orderPublicId: order.orderPublicId });
  }
  stageRecord(input: OrderChannelEventInput & { observedAt: Date }): Staged {
    const order = this.orders.get(`${input.guildId}:${input.channelId}`);
    if (!order) throw new OrderChannelEventError('NOT_FOUND', 'Order channel is not registered.');
    const existing = this.events.find((item) => item.eventId === input.eventId);
    const data: OrderChannelEventRecord = existing ? { ...existing, created: false } : {
      ...input, ...order, id: randomUUID(), observedAt: input.observedAt.toISOString(), created: true
    };
    return { data, commit: () => { if (!existing) this.events.push(structuredClone(data)); } };
  }
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
      await client.query(`INSERT INTO order_channel_message_events
        (id,order_id,order_public_id,guild_id,channel_id,discord_message_id,event_id,event_type,author_discord_id,author_display_name,author_is_bot,
         content_snapshot,embeds_snapshot,attachments_snapshot,reply_to_message_id,discord_created_at,discord_edited_at,observed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18) ON CONFLICT (event_id) DO NOTHING`,
      [data.id,data.orderId,data.orderPublicId,data.guildId,data.channelId,data.messageId,data.eventId,data.eventType,data.authorDiscordId,
       data.authorDisplayName,data.authorIsBot,data.content,JSON.stringify(data.embeds),JSON.stringify(data.attachments),data.replyToMessageId,
       data.discordCreatedAt,data.discordEditedAt,data.observedAt]);
      await insertPostgresAuditRecord(client,audit); await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); } } };
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
