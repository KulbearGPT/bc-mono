import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PostgresOrderChannelEventStore } from './order-channel-events.js';
import type { OutboxHandler } from './worker-runtime.js';

export interface TerminalChannelCleanupProjection {
  orderId: string;
  publicId: string;
  status: string;
  guildId: string;
  textChannelId: string | null;
  selectionVoiceChannelId: string | null;
  serviceVoiceChannelId: string | null;
  panelSyncOutstanding?: boolean;
}

export interface DiscordChannelMessageSnapshot {
  id: string;
  author?: { id?: string; username?: string; global_name?: string | null; bot?: boolean } | null;
  member?: { nick?: string | null } | null;
  content?: string | null;
  embeds?: unknown[];
  attachments?: unknown[];
  message_reference?: { message_id?: string | null } | null;
  timestamp?: string | null;
  edited_timestamp?: string | null;
}

export interface TerminalChannelCleanupStore {
  getProjection(orderId: string): Promise<TerminalChannelCleanupProjection | null>;
  appendSnapshot(input: {
    projection: TerminalChannelCleanupProjection;
    message: DiscordChannelMessageSnapshot;
    observedAt: Date;
  }): Promise<void>;
  enqueueDueTerminalOrders(now: Date): Promise<number>;
}

export interface TerminalChannelDiscordAdapter {
  freezeChannelIfExists(channelId: string): Promise<void>;
  listChannelMessages(channelId: string, before: string | null): Promise<DiscordChannelMessageSnapshot[] | null>;
  deleteChannelIfExists(channelId: string): Promise<void>;
}

interface QueryClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: Row[]; rowCount?: number | null }>;
}

export async function enqueueTerminalChannelArchive(
  client: QueryClient,
  input: { orderId: string; orderVersion: number; now: Date }
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events(
       id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,
       row_version,attempt_count,max_attempts,available_at,created_at,updated_at
     )
     SELECT gen_random_uuid(),'CHANNEL_ARCHIVE','order',orders.id,orders.id,$2,$3::jsonb,'PENDING',
            1,0,8,$4::timestamptz + make_interval(mins => ${retentionMinutesSql()}),$4,$4
       FROM orders
       LEFT JOIN guild_bot_configs config ON config.guild_id=orders.guild_id
      WHERE orders.id=$1
        AND orders.status IN ('COMPLETED','CANCELLED')
        AND orders.guild_id IS NOT NULL
        AND (orders.channel_id IS NOT NULL OR orders.selection_voice_channel_id IS NOT NULL OR orders.voice_channel_id IS NOT NULL)
     ON CONFLICT(dedupe_key) DO NOTHING`,
    [
      input.orderId,
      cleanupDedupeKey(input.orderId, input.orderVersion),
      JSON.stringify({ orderId: input.orderId }),
      input.now
    ]
  );
}

export class PostgresTerminalChannelCleanupStore implements TerminalChannelCleanupStore {
  private readonly transcriptStore: PostgresOrderChannelEventStore;

  constructor(private readonly pool: Pool) {
    this.transcriptStore = new PostgresOrderChannelEventStore(pool);
  }

  async getProjection(orderId: string): Promise<TerminalChannelCleanupProjection | null> {
    const result = await this.pool.query<CleanupProjectionRow>(
      `SELECT orders.id,orders.public_id,orders.status::text,orders.guild_id,orders.channel_id,
              orders.selection_voice_channel_id,orders.voice_channel_id,
              EXISTS(
                SELECT 1 FROM outbox_events panel
                 WHERE panel.order_id=orders.id AND panel.event_type='PANEL_SYNC'
                   AND panel.status IN ('PENDING','PROCESSING','FAILED')
              ) panel_sync_outstanding
         FROM orders WHERE orders.id=$1`,
      [orderId]
    );
    const row = result.rows[0];
    if (!row || !row.guild_id) return null;
    return {
      orderId: row.id,
      publicId: row.public_id,
      status: row.status,
      guildId: row.guild_id,
      textChannelId: row.channel_id,
      selectionVoiceChannelId: row.selection_voice_channel_id,
      serviceVoiceChannelId: row.voice_channel_id,
      panelSyncOutstanding: row.panel_sync_outstanding
    };
  }

  async appendSnapshot(input: {
    projection: TerminalChannelCleanupProjection;
    message: DiscordChannelMessageSnapshot;
    observedAt: Date;
  }): Promise<void> {
    if (!input.projection.textChannelId) return;
    const message = input.message;
    const eventId = `${message.id}:CREATED:v1`;
    const staged = await this.transcriptStore.stageRecord({
      guildId: input.projection.guildId,
      channelId: input.projection.textChannelId,
      messageId: message.id,
      eventId,
      eventType: 'CREATED',
      authorDiscordId: optionalString(message.author?.id),
      authorDisplayName:
        optionalString(message.member?.nick) ??
        optionalString(message.author?.global_name) ??
        optionalString(message.author?.username),
      authorIsBot: typeof message.author?.bot === 'boolean' ? message.author.bot : null,
      content: typeof message.content === 'string' ? message.content : null,
      embeds: Array.isArray(message.embeds) ? message.embeds : [],
      attachments: attachmentMetadata(message.attachments),
      replyToMessageId: optionalString(message.message_reference?.message_id),
      discordCreatedAt: optionalString(message.timestamp),
      discordEditedAt: optionalString(message.edited_timestamp),
      observedAt: discordMessageTime(message.timestamp, input.observedAt)
    });
    if (!staged.data.created) return;
    await staged.commit({
      id: randomUUID(),
      actorId: null,
      actorStaffId: null,
      actorLevel: null,
      actorSource: 'SYSTEM_JOB',
      clientId: 'OUTBOX_WORKER',
      interactionId: null,
      permissionCode: 'transcript.event.append',
      action: 'BACKFILL_ORDER_CHANNEL_TRANSCRIPT',
      targetType: 'order_channel_message_event',
      targetId: staged.data.id,
      outcome: 'SUCCEEDED',
      reason: 'TERMINAL_CHANNEL_CLEANUP',
      requestId: `channel-archive:${input.projection.orderId}:${message.id}`,
      approvalRequestId: null,
      occurredAt: input.observedAt.toISOString()
    });
  }

  async enqueueDueTerminalOrders(now: Date): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO outbox_events(
         id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,
         row_version,attempt_count,max_attempts,available_at,created_at,updated_at
       )
       SELECT gen_random_uuid(),'CHANNEL_ARCHIVE','order',orders.id,orders.id,
              'terminal-channel-cleanup:'||orders.id::text||':v'||orders.row_version::text,
              jsonb_build_object('orderId',orders.id),'PENDING',1,0,8,$1,$1,$1
         FROM orders
         LEFT JOIN guild_bot_configs config ON config.guild_id=orders.guild_id
        WHERE orders.status IN ('COMPLETED','CANCELLED')
          AND orders.guild_id IS NOT NULL
          AND (orders.channel_id IS NOT NULL OR orders.selection_voice_channel_id IS NOT NULL OR orders.voice_channel_id IS NOT NULL)
          AND COALESCE(orders.completed_at,orders.cancelled_at,orders.updated_at)
              + make_interval(mins => ${retentionMinutesSql()}) <= $1
          AND NOT EXISTS(
            SELECT 1 FROM outbox_events panel
             WHERE panel.order_id=orders.id AND panel.event_type='PANEL_SYNC'
               AND panel.status IN ('PENDING','PROCESSING','FAILED')
          )
       ON CONFLICT(dedupe_key) DO UPDATE
         SET available_at=EXCLUDED.available_at,
             updated_at=EXCLUDED.updated_at,
             row_version=outbox_events.row_version+1
       WHERE outbox_events.status='PENDING'
         AND outbox_events.available_at>EXCLUDED.available_at
       RETURNING id`,
      [now]
    );
    return result.rows.length;
  }
}

export function createTerminalChannelArchiveHandler(input: {
  store: TerminalChannelCleanupStore;
  discord: TerminalChannelDiscordAdapter;
  now?: () => Date;
}): OutboxHandler {
  return async (job) => {
    if (job.type !== 'CHANNEL_ARCHIVE') throw new Error('Expected a CHANNEL_ARCHIVE job.');
    const payload = job.payload as { orderId?: unknown } | null;
    if (!payload || typeof payload.orderId !== 'string' || payload.orderId !== job.aggregateId) {
      throw new Error('Channel archive payload is invalid.');
    }
    const projection = await input.store.getProjection(payload.orderId);
    if (!projection) throw new Error('Terminal order channel projection was not found.');
    if (projection.status !== 'COMPLETED' && projection.status !== 'CANCELLED') {
      throw new Error('Order is not terminal; channel cleanup was refused.');
    }
    if (projection.panelSyncOutstanding) {
      throw new Error('Terminal order panel synchronization is not complete.');
    }
    if (projection.textChannelId) {
      await input.discord.freezeChannelIfExists(projection.textChannelId);
      let before: string | null = null;
      const seenCursors = new Set<string>();
      while (true) {
        const messages = await input.discord.listChannelMessages(projection.textChannelId, before);
        if (messages === null) break;
        for (const message of messages) {
          await input.store.appendSnapshot({
            projection,
            message,
            observedAt: (input.now ?? (() => new Date()))()
          });
        }
        if (messages.length < 100) break;
        const next = messages.at(-1)?.id;
        if (!next || seenCursors.has(next)) throw new Error('Discord message pagination did not advance.');
        seenCursors.add(next);
        before = next;
      }
    }
    const voiceChannelIds = new Set(
      [projection.selectionVoiceChannelId, projection.serviceVoiceChannelId].filter(
        (channelId): channelId is string => Boolean(channelId) && channelId !== projection.textChannelId
      )
    );
    for (const channelId of voiceChannelIds) await input.discord.deleteChannelIfExists(channelId);
    if (projection.textChannelId) await input.discord.deleteChannelIfExists(projection.textChannelId);
  };
}

function cleanupDedupeKey(orderId: string, orderVersion: number): string {
  return `terminal-channel-cleanup:${orderId}:v${orderVersion}`;
}

function retentionMinutesSql(): string {
  return `CASE
    WHEN config.config_json->>'channel_archive_after_completion_minutes' ~ '^[0-9]+$'
    THEN LEAST(60,GREATEST(0,(config.config_json->>'channel_archive_after_completion_minutes')::int))
    ELSE 60
  END`;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function discordMessageTime(value: unknown, fallback: Date): Date {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : fallback;
}

function attachmentMetadata(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const attachment = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    return {
      id: optionalString(attachment.id),
      name: optionalString(attachment.filename),
      size: Number.isSafeInteger(attachment.size) ? Number(attachment.size) : null,
      contentType: optionalString(attachment.content_type),
      url: optionalString(attachment.url)
    };
  });
}

interface CleanupProjectionRow {
  id: string;
  public_id: string;
  status: string;
  guild_id: string | null;
  channel_id: string | null;
  selection_voice_channel_id: string | null;
  voice_channel_id: string | null;
  panel_sync_outstanding: boolean;
}
