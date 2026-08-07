import type { Pool } from 'pg';
import type { FiveStarReviewSnapshot } from './order-experience-reviews.js';
import type { OutboxHandler } from './worker-runtime.js';

export type OrderReviewBroadcastPublication = {
  id: string;
  orderId: string;
  guildId: string;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  snapshot: FiveStarReviewSnapshot;
  broadcastChannelId: string | null;
  broadcastMessageId: string | null;
  publishedAt: string | null;
};

export interface OrderReviewBroadcastStore {
  getPublication(publicationId: string): Promise<OrderReviewBroadcastPublication | null>;
  getBroadcastChannelId(guildId: string): Promise<string | null>;
  markPublished(input: {
    publicationId: string;
    channelId: string;
    messageId: string;
    publishedAt: string;
  }): Promise<void>;
}

export interface OrderReviewBroadcastDiscord {
  upsertFiveStarReview(input: {
    channelId: string;
    dedupeKey: string;
    notBefore: string;
    existingMessageId: string | null;
    message: Record<string, unknown>;
  }): Promise<{ messageId: string }>;
}

export class InMemoryOrderReviewBroadcastStore implements OrderReviewBroadcastStore {
  readonly publications: OrderReviewBroadcastPublication[];
  constructor(
    private readonly input: {
      publications: OrderReviewBroadcastPublication[];
      guildChannels: Map<string, string>;
    }
  ) {
    this.publications = structuredClone(input.publications);
  }

  async getPublication(publicationId: string) {
    const publication = this.publications.find((item) => item.id === publicationId);
    return publication ? structuredClone(publication) : null;
  }

  async getBroadcastChannelId(guildId: string) {
    return this.input.guildChannels.get(guildId) ?? null;
  }

  async markPublished(input: { publicationId: string; channelId: string; messageId: string; publishedAt: string }) {
    const publication = this.publications.find((item) => item.id === input.publicationId);
    if (!publication) throw new Error('Order review publication was not found.');
    publication.status = 'PUBLISHED';
    publication.broadcastChannelId = input.channelId;
    publication.broadcastMessageId = input.messageId;
    publication.publishedAt = input.publishedAt;
  }
}

export class PostgresOrderReviewBroadcastStore implements OrderReviewBroadcastStore {
  constructor(private readonly pool: Pool) {}

  async getPublication(publicationId: string): Promise<OrderReviewBroadcastPublication | null> {
    const result = await this.pool.query(
      `SELECT publication.id,publication.order_id,orders.guild_id,publication.status::text,
              publication.snapshot,publication.broadcast_channel_id,publication.broadcast_message_id,
              publication.published_at
         FROM order_review_publications publication
         JOIN orders ON orders.id=publication.order_id
        WHERE publication.id=$1`,
      [publicationId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      orderId: row.order_id,
      guildId: row.guild_id,
      status: row.status,
      snapshot: validateSnapshot(row.snapshot),
      broadcastChannelId: row.broadcast_channel_id,
      broadcastMessageId: row.broadcast_message_id,
      publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null
    };
  }

  async getBroadcastChannelId(guildId: string): Promise<string | null> {
    const result = await this.pool.query<{ channel_id: string | null }>(
      `SELECT config_json->>'review_broadcast_channel_id' AS channel_id
         FROM guild_bot_configs WHERE guild_id=$1`,
      [guildId]
    );
    const value = result.rows[0]?.channel_id?.trim() ?? '';
    return /^\d{17,20}$/u.test(value) ? value : null;
  }

  async markPublished(input: { publicationId: string; channelId: string; messageId: string; publishedAt: string }) {
    const result = await this.pool.query(
      `UPDATE order_review_publications
          SET status='PUBLISHED',broadcast_channel_id=$2,broadcast_message_id=$3,
              published_at=COALESCE(published_at,$4),updated_at=$4
        WHERE id=$1
      RETURNING id`,
      [input.publicationId, input.channelId, input.messageId, input.publishedAt]
    );
    if (!result.rows[0]) throw new Error('Order review publication was not found.');
  }
}

export function createOrderReviewBroadcastHandler(input: {
  store: OrderReviewBroadcastStore;
  discord: OrderReviewBroadcastDiscord;
}): OutboxHandler {
  return async (job) => {
    if (job.type !== 'REVIEW_BROADCAST') throw new Error('Expected a REVIEW_BROADCAST job.');
    const payload = job.payload as { publicationId?: unknown; orderId?: unknown } | null;
    if (
      !payload ||
      typeof payload.publicationId !== 'string' ||
      typeof payload.orderId !== 'string' ||
      payload.publicationId !== job.aggregateId
    )
      throw new Error('Review broadcast payload is invalid.');
    const publication = await input.store.getPublication(payload.publicationId);
    if (!publication || publication.orderId !== payload.orderId)
      throw new Error('Order review publication was not found.');
    const channelId = await input.store.getBroadcastChannelId(publication.guildId);
    if (!channelId) throw new Error('Review broadcast channel is not configured for this Guild.');
    const result = await input.discord.upsertFiveStarReview({
      channelId,
      dedupeKey: `review-publication:${publication.id}`,
      notBefore: job.createdAt,
      existingMessageId: publication.broadcastMessageId,
      message: renderFiveStarReviewBroadcast(publication.snapshot)
    });
    await input.store.markPublished({
      publicationId: publication.id,
      channelId,
      messageId: result.messageId,
      publishedAt: job.updatedAt
    });
  };
}

export function renderFiveStarReviewBroadcast(snapshotValue: FiveStarReviewSnapshot): Record<string, unknown> {
  const snapshot = validateSnapshot(snapshotValue);
  return {
    content: null,
    allowed_mentions: { parse: [] },
    embeds: [
      {
        color: 0xf4c542,
        title: '🌟 老板五星好评',
        description: snapshot.targets
          .map((target) => `${target.targetType === 'PLAYER' ? `陪玩 · ${target.displayName}` : target.displayName} · ★★★★★`)
          .join('\n'),
        fields: [
          { name: '订单', value: snapshot.orderPublicId, inline: true },
          { name: '服务', value: snapshot.serviceDisplayName || '已完成服务', inline: true }
        ],
        footer: { text: `完成于 ${snapshot.completedAt}` }
      }
    ]
  };
}

function validateSnapshot(value: unknown): FiveStarReviewSnapshot {
  if (!record(value) || !exactKeys(value, ['orderPublicId', 'serviceDisplayName', 'completedAt', 'targets']))
    throw new Error('Review publication snapshot is invalid.');
  if (
    typeof value.orderPublicId !== 'string' ||
    typeof value.serviceDisplayName !== 'string' ||
    typeof value.completedAt !== 'string' ||
    Number.isNaN(Date.parse(value.completedAt)) ||
    !Array.isArray(value.targets) ||
    !value.targets.length
  )
    throw new Error('Review publication snapshot is invalid.');
  const targets = value.targets.map((target) => {
    if (
      !record(target) ||
      !exactKeys(target, ['targetType', 'displayName', 'score']) ||
      !['ORDER', 'PLAYER', 'SUPPORT'].includes(String(target.targetType)) ||
      typeof target.displayName !== 'string' ||
      !target.displayName.trim() ||
      target.score !== 5
    )
      throw new Error('Review publication snapshot target is invalid.');
    return {
      targetType: target.targetType as 'ORDER' | 'PLAYER' | 'SUPPORT',
      displayName: target.displayName.slice(0, 100),
      score: 5 as const
    };
  });
  return {
    orderPublicId: value.orderPublicId.slice(0, 40),
    serviceDisplayName: value.serviceDisplayName.slice(0, 100),
    completedAt: value.completedAt,
    targets
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const expected = [...keys].sort();
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}
