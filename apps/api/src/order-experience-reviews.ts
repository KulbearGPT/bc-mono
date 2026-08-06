import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  insertPostgresAuditRecord,
  registerSecureReadRoute,
  registerSecureWriteRoute,
  type AuditRecord
} from './security.js';

export type ExperienceReviewTargetType = 'ORDER' | 'PLAYER' | 'SUPPORT';
export type ExperienceReviewComment = { id: string; comment: string; createdAt: string };
export type ExperienceReview = {
  id: string;
  orderId: string;
  targetKey: string;
  targetType: ExperienceReviewTargetType;
  orderParticipantId: string | null;
  attributedStaffId: string | null;
  score: number;
  comment: ExperienceReviewComment | null;
  createdAt: string;
};
export type ExperienceReviewTarget = {
  targetKey: string;
  targetType: ExperienceReviewTargetType;
  displayName: string;
  review: ExperienceReview | null;
};
export type FiveStarReviewSnapshot = {
  orderPublicId: string;
  serviceDisplayName: string;
  completedAt: string;
  targets: Array<{
    targetType: ExperienceReviewTargetType;
    displayName: string;
    score: 5;
  }>;
};
export type OrderReviewPublication = {
  id: string;
  orderId: string;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  snapshot: FiveStarReviewSnapshot;
  consentedAt: string;
  publishedAt: string | null;
};
export type OrderExperienceReviewCenter = {
  orderId: string;
  orderPublicId: string;
  expiresAt: string;
  targets: ExperienceReviewTarget[];
  hasPublishableFiveStar: boolean;
  publication: OrderReviewPublication | null;
};
type Staged<T> = { data: T; commit(audit: AuditRecord): void | Promise<void> };
type Context = { orderId: string; guildId: string; customerDiscordId: string; now: Date };

export interface OrderExperienceReviewStore {
  getCenter(input: Context): OrderExperienceReviewCenter | Promise<OrderExperienceReviewCenter>;
  stageRatings(
    input: Context & { targetKeys: string[]; score: number }
  ): Staged<ExperienceReview[]> | Promise<Staged<ExperienceReview[]>>;
  stageComment(
    input: Context & { reviewId: string; comment: string }
  ): Staged<ExperienceReview> | Promise<Staged<ExperienceReview>>;
  stagePublication(
    input: Context & { confirmation: string }
  ): Staged<OrderReviewPublication> | Promise<Staged<OrderReviewPublication>>;
}

export class ExperienceReviewError extends Error {
  constructor(
    readonly code:
      'VALIDATION_ERROR' | 'NOT_FOUND' | 'PERMISSION_DENIED' | 'NOT_ELIGIBLE' | 'RATING_EXPIRED' | 'CONFLICT',
    message: string
  ) {
    super(message);
    this.name = 'ExperienceReviewError';
  }
}

type MemoryOrder = {
  id: string;
  publicId: string;
  guildId: string;
  customerId: string;
  customerDiscordId: string;
  status: string;
  completedAt: string | null;
  serviceDisplayName: string;
  participants: Array<{ id: string; displayName: string; activeAtCompletion: boolean }>;
  respondedStaffId: string | null;
};

export class InMemoryOrderExperienceReviewStore implements OrderExperienceReviewStore {
  readonly reviews: ExperienceReview[] = [];
  readonly publications: OrderReviewPublication[] = [];
  constructor(private readonly input: { orders: MemoryOrder[] }) {}

  getCenter(input: Context) {
    const order = this.order(input);
    const targets = this.targets(order).map((target) => ({
      targetKey: target.targetKey,
      targetType: target.targetType,
      displayName: target.displayName,
      review: this.reviews.find((item) => item.orderId === order.id && item.targetKey === target.targetKey) ?? null
    }));
    return {
      orderId: order.id,
      orderPublicId: order.publicId,
      expiresAt: new Date(new Date(order.completedAt!).getTime() + 86_400_000).toISOString(),
      targets,
      hasPublishableFiveStar: targets.some((item) => item.review?.score === 5),
      publication: this.publications.find((item) => item.orderId === order.id) ?? null
    };
  }

  stageRatings(input: Context & { targetKeys: string[]; score: number }): Staged<ExperienceReview[]> {
    validateRatingBatch(input.targetKeys, input.score);
    const order = this.order(input);
    const legal = new Map(this.targets(order).map((target) => [target.targetKey, target]));
    if (
      input.targetKeys.some(
        (key) =>
          !legal.has(key) || this.reviews.some((review) => review.orderId === order.id && review.targetKey === key)
      )
    )
      throw new ExperienceReviewError('CONFLICT', 'A selected review target is invalid or already rated.');
    const data = input.targetKeys.map((key) => {
      const target = legal.get(key)!;
      return {
        id: randomUUID(),
        orderId: order.id,
        targetKey: key,
        targetType: target.targetType,
        orderParticipantId: target.orderParticipantId,
        attributedStaffId: target.attributedStaffId,
        score: input.score,
        comment: null,
        createdAt: input.now.toISOString()
      } satisfies ExperienceReview;
    });
    return {
      data,
      commit: () => {
        if (
          data.some((next) =>
            this.reviews.some((item) => item.orderId === next.orderId && item.targetKey === next.targetKey)
          )
        )
          throw new ExperienceReviewError('CONFLICT', 'A selected target was already rated.');
        this.reviews.push(...structuredClone(data));
      }
    };
  }

  stageComment(input: Context & { reviewId: string; comment: string }): Staged<ExperienceReview> {
    this.order(input);
    const review = this.reviews.find((item) => item.id === input.reviewId && item.orderId === input.orderId);
    const comment = validateComment(input.comment);
    if (!review) throw new ExperienceReviewError('NOT_FOUND', 'Review was not found.');
    if (review.comment) throw new ExperienceReviewError('CONFLICT', 'A comment was already appended.');
    const data = { ...review, comment: { id: randomUUID(), comment, createdAt: input.now.toISOString() } };
    return {
      data,
      commit: () => {
        if (review.comment) throw new ExperienceReviewError('CONFLICT', 'A comment was already appended.');
        review.comment = structuredClone(data.comment);
      }
    };
  }

  stagePublication(input: Context & { confirmation: string }): Staged<OrderReviewPublication> {
    const order = this.order(input);
    if (input.confirmation !== 'PUBLISH_FIVE_STAR_SNAPSHOT')
      throw new ExperienceReviewError('VALIDATION_ERROR', 'Explicit public consent is required.');
    if (this.publications.some((item) => item.orderId === order.id))
      throw new ExperienceReviewError('CONFLICT', 'This order was already published.');
    const targets = this.targets(order).flatMap((target) => {
      const review = this.reviews.find(
        (item) => item.orderId === order.id && item.targetKey === target.targetKey && item.score === 5
      );
      return review ? [{ targetType: target.targetType, displayName: target.displayName, score: 5 as const }] : [];
    });
    if (!targets.length) throw new ExperienceReviewError('CONFLICT', 'At least one five-star review is required.');
    const data = {
      id: randomUUID(),
      orderId: order.id,
      status: 'PENDING' as const,
      snapshot: {
        orderPublicId: order.publicId,
        serviceDisplayName: order.serviceDisplayName,
        completedAt: order.completedAt!,
        targets
      },
      consentedAt: input.now.toISOString(),
      publishedAt: null
    };
    return {
      data,
      commit: () => {
        if (this.publications.some((item) => item.orderId === order.id))
          throw new ExperienceReviewError('CONFLICT', 'This order was already published.');
        this.publications.push(structuredClone(data));
      }
    };
  }

  private order(input: Context) {
    const order = this.input.orders.find((item) => item.id === input.orderId && item.guildId === input.guildId);
    if (!order) throw new ExperienceReviewError('NOT_FOUND', 'Order was not found.');
    if (order.customerDiscordId !== input.customerDiscordId)
      throw new ExperienceReviewError('PERMISSION_DENIED', 'Only the order customer may review it.');
    if (order.status !== 'COMPLETED' || !order.completedAt)
      throw new ExperienceReviewError('NOT_ELIGIBLE', 'Order is not eligible for review.');
    if (input.now.getTime() > new Date(order.completedAt).getTime() + 86_400_000)
      throw new ExperienceReviewError('RATING_EXPIRED', 'The review window has expired.');
    return order;
  }

  private targets(order: MemoryOrder) {
    return [
      {
        targetKey: 'order',
        targetType: 'ORDER' as const,
        displayName: '订单整体',
        orderParticipantId: null,
        attributedStaffId: null
      },
      ...order.participants
        .filter((item) => item.activeAtCompletion)
        .map((item) => ({
          targetKey: `player:${item.id}`,
          targetType: 'PLAYER' as const,
          displayName: item.displayName,
          orderParticipantId: item.id,
          attributedStaffId: null
        })),
      ...(order.respondedStaffId
        ? [
            {
              targetKey: `support:${order.respondedStaffId}`,
              targetType: 'SUPPORT' as const,
              displayName: '猫舍前台',
              orderParticipantId: null,
              attributedStaffId: order.respondedStaffId
            }
          ]
        : [])
    ];
  }
}

export class PostgresOrderExperienceReviewStore implements OrderExperienceReviewStore {
  constructor(private readonly pool: Pool) {}

  async getCenter(input: Context) {
    const snapshot = await loadSnapshot(this.pool, input);
    return centerFromSnapshot(snapshot);
  }

  async stageRatings(input: Context & { targetKeys: string[]; score: number }): Promise<Staged<ExperienceReview[]>> {
    validateRatingBatch(input.targetKeys, input.score);
    const snapshot = await loadSnapshot(this.pool, input);
    const legal = new Map(snapshot.targets.map((item) => [item.targetKey, item]));
    if (input.targetKeys.some((key) => !legal.has(key) || snapshot.reviews.some((item) => item.targetKey === key)))
      throw new ExperienceReviewError('CONFLICT', 'A selected review target is invalid or already rated.');
    const data = input.targetKeys.map((key) =>
      reviewFromTarget(snapshot.order.id, legal.get(key)!, input.score, input.now)
    );
    return {
      data,
      commit: (audit) =>
        this.transaction(async (client) => {
          const current = await loadSnapshot(client, input, true);
          const currentLegal = new Map(current.targets.map((item) => [item.targetKey, item]));
          if (
            input.targetKeys.some(
              (key) => !currentLegal.has(key) || current.reviews.some((item) => item.targetKey === key)
            )
          )
            throw new ExperienceReviewError('CONFLICT', 'A selected review target is invalid or already rated.');
          for (const review of data) {
            await client.query(
              `INSERT INTO order_experience_reviews
             (id,order_id,customer_id,target_type,target_key,order_participant_id,attributed_staff_id,score,created_at)
           VALUES($1,$2,$3,$4::"ExperienceReviewTargetType",$5,$6,$7,$8,$9)`,
              [
                review.id,
                review.orderId,
                current.order.customer_id,
                review.targetType,
                review.targetKey,
                review.orderParticipantId,
                review.attributedStaffId,
                review.score,
                review.createdAt
              ]
            );
          }
          await insertPanelSync(client, input.orderId, input.now);
          await insertPostgresAuditRecord(client, audit);
        })
    };
  }

  async stageComment(input: Context & { reviewId: string; comment: string }): Promise<Staged<ExperienceReview>> {
    const comment = validateComment(input.comment);
    const snapshot = await loadSnapshot(this.pool, input);
    const review = snapshot.reviews.find((item) => item.id === input.reviewId);
    if (!review) throw new ExperienceReviewError('NOT_FOUND', 'Review was not found.');
    if (review.comment) throw new ExperienceReviewError('CONFLICT', 'A comment was already appended.');
    const data = { ...review, comment: { id: randomUUID(), comment, createdAt: input.now.toISOString() } };
    return {
      data,
      commit: (audit) =>
        this.transaction(async (client) => {
          await loadSnapshot(client, input, true);
          const inserted = await client.query(
            `INSERT INTO order_experience_review_comments(id,review_id,customer_id,comment,created_at)
         SELECT $1,r.id,r.customer_id,$2,$3 FROM order_experience_reviews r
         WHERE r.id=$4 AND r.order_id=$5
         ON CONFLICT (review_id) DO NOTHING RETURNING id`,
            [data.comment!.id, comment, data.comment!.createdAt, input.reviewId, input.orderId]
          );
          if (!inserted.rows[0]) throw new ExperienceReviewError('CONFLICT', 'A comment was already appended.');
          await insertPanelSync(client, input.orderId, input.now);
          await insertPostgresAuditRecord(client, audit);
        })
    };
  }

  async stagePublication(input: Context & { confirmation: string }): Promise<Staged<OrderReviewPublication>> {
    if (input.confirmation !== 'PUBLISH_FIVE_STAR_SNAPSHOT')
      throw new ExperienceReviewError('VALIDATION_ERROR', 'Explicit public consent is required.');
    const snapshot = await loadSnapshot(this.pool, input);
    if (snapshot.publication) throw new ExperienceReviewError('CONFLICT', 'This order was already published.');
    const data = publicationFromSnapshot(snapshot, input.now);
    return {
      data,
      commit: (audit) =>
        this.transaction(async (client) => {
          const current = await loadSnapshot(client, input, true);
          if (current.publication) throw new ExperienceReviewError('CONFLICT', 'This order was already published.');
          await client.query(
            `INSERT INTO order_review_publications(id,order_id,customer_id,snapshot,status,consented_at,created_at,updated_at)
         VALUES($1,$2,$3,$4::jsonb,'PENDING',$5,$5,$5)`,
            [
              data.id,
              input.orderId,
              current.order.customer_id,
              JSON.stringify(data.snapshot),
              data.consentedAt
            ]
          );
          await client.query(
            `INSERT INTO outbox_events
          (id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,created_at,updated_at)
         VALUES($1,'REVIEW_BROADCAST','order_review_publication',$2,$3,$4,$5::jsonb,'PENDING',1,0,8,$6,$6,$6)`,
            [
              randomUUID(),
              data.id,
              input.orderId,
              `review-publication:${input.orderId}`,
              JSON.stringify({ publicationId: data.id, orderId: input.orderId }),
              input.now.toISOString()
            ]
          );
          await insertPostgresAuditRecord(client, audit);
        })
    };
  }

  private async transaction(work: (client: PoolClient) => Promise<void>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((error as { code?: string }).code === '23505')
        throw new ExperienceReviewError('CONFLICT', 'The review fact already exists.');
      throw error;
    } finally {
      client.release();
    }
  }
}

type ReviewTarget = {
  targetKey: string;
  targetType: ExperienceReviewTargetType;
  displayName: string;
  orderParticipantId: string | null;
  attributedStaffId: string | null;
};
type DbOrder = {
  id: string;
  public_id: string;
  customer_id: string;
  status: string;
  completed_at: Date | string | null;
  service_display_name: string;
  customer_discord_id: string;
};
type DbSnapshot = {
  order: DbOrder;
  targets: ReviewTarget[];
  reviews: ExperienceReview[];
  publication: OrderReviewPublication | null;
};
type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

async function loadSnapshot(client: Queryable, input: Context, lock = false): Promise<DbSnapshot> {
  const orderResult = await client.query<DbOrder>(
    `SELECT o.id,o.public_id,o.customer_id,o.status::text AS status,o.completed_at,
            COALESCE(o.service_name_snapshot,o.game_name_snapshot,'已完成服务') AS service_display_name,
            da.discord_user_id AS customer_discord_id
       FROM orders o JOIN discord_accounts da ON da.user_id=o.customer_id AND da.guild_id=$2
      WHERE o.id=$1 AND o.guild_id=$2${lock ? ' FOR UPDATE OF o' : ''}`,
    [input.orderId, input.guildId]
  );
  const order = orderResult.rows[0];
  if (!order) throw new ExperienceReviewError('NOT_FOUND', 'Order was not found.');
  if (order.customer_discord_id !== input.customerDiscordId)
    throw new ExperienceReviewError('PERMISSION_DENIED', 'Only the order customer may review it.');
  if (order.status !== 'COMPLETED' || !order.completed_at)
    throw new ExperienceReviewError('NOT_ELIGIBLE', 'Order is not eligible for review.');
  if (input.now.getTime() > new Date(order.completed_at).getTime() + 86_400_000)
    throw new ExperienceReviewError('RATING_EXPIRED', 'The review window has expired.');
  const participants = await client.query<{ id: string; display_name: string }>(
    `SELECT id,player_display_name_snapshot AS display_name FROM order_participants
      WHERE order_id=$1 AND status='ACTIVE' ORDER BY created_at,id`,
    [input.orderId]
  );
  const responder = await client.query<{ id: string }>(
    `SELECT sa.id FROM staff_tasks st
       JOIN order_channel_message_events message ON message.id=st.first_response_event_id
       JOIN discord_accounts staff_da ON staff_da.guild_id=$2 AND staff_da.discord_user_id=message.author_discord_id
       JOIN staff_accounts sa ON sa.user_id=staff_da.user_id
      WHERE st.order_id=$1 AND st.first_responded_at IS NOT NULL
      ORDER BY st.first_responded_at,st.id LIMIT 1`,
    [input.orderId, input.guildId]
  );
  const targets: ReviewTarget[] = [
    {
      targetKey: 'order',
      targetType: 'ORDER',
      displayName: '订单整体',
      orderParticipantId: null,
      attributedStaffId: null
    },
    ...participants.rows.map((item) => ({
      targetKey: `player:${item.id}`,
      targetType: 'PLAYER' as const,
      displayName: item.display_name,
      orderParticipantId: item.id,
      attributedStaffId: null
    })),
    ...(responder.rows[0]
      ? [
          {
            targetKey: `support:${responder.rows[0].id}`,
            targetType: 'SUPPORT' as const,
            displayName: '猫舍前台',
            orderParticipantId: null,
            attributedStaffId: responder.rows[0].id
          }
        ]
      : [])
  ];
  const reviewRows = await client.query<{
    id: string;
    order_id: string;
    target_key: string;
    target_type: ExperienceReviewTargetType;
    order_participant_id: string | null;
    attributed_staff_id: string | null;
    score: number;
    created_at: Date | string;
    comment_id: string | null;
    comment: string | null;
    comment_created_at: Date | string | null;
  }>(
    `SELECT r.*,c.id AS comment_id,c.comment,c.created_at AS comment_created_at
        FROM order_experience_reviews r LEFT JOIN order_experience_review_comments c ON c.review_id=r.id
       WHERE r.order_id=$1 ORDER BY r.created_at,r.id`,
    [input.orderId]
  );
  const reviews = reviewRows.rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    targetKey: row.target_key,
    targetType: row.target_type,
    orderParticipantId: row.order_participant_id,
    attributedStaffId: row.attributed_staff_id,
    score: row.score,
    comment: row.comment_id
      ? { id: row.comment_id, comment: row.comment!, createdAt: new Date(row.comment_created_at!).toISOString() }
      : null,
    createdAt: new Date(row.created_at).toISOString()
  }));
  const publicationResult = await client.query(
    `SELECT id,order_id,status::text,snapshot,consented_at,published_at FROM order_review_publications WHERE order_id=$1`,
    [input.orderId]
  );
  const publication = publicationResult.rows[0]
    ? {
        id: publicationResult.rows[0].id,
        orderId: publicationResult.rows[0].order_id,
        status: publicationResult.rows[0].status,
        snapshot: publicationResult.rows[0].snapshot,
        consentedAt: new Date(publicationResult.rows[0].consented_at).toISOString(),
        publishedAt: publicationResult.rows[0].published_at
          ? new Date(publicationResult.rows[0].published_at).toISOString()
          : null
      }
    : null;
  return { order, targets, reviews, publication };
}

function centerFromSnapshot(snapshot: DbSnapshot) {
  return {
    orderId: snapshot.order.id,
    orderPublicId: snapshot.order.public_id,
    expiresAt: new Date(new Date(snapshot.order.completed_at!).getTime() + 86_400_000).toISOString(),
    targets: snapshot.targets.map((target) => ({
      targetKey: target.targetKey,
      targetType: target.targetType,
      displayName: target.displayName,
      review: snapshot.reviews.find((item) => item.targetKey === target.targetKey) ?? null
    })),
    hasPublishableFiveStar: snapshot.reviews.some((item) => item.score === 5),
    publication: snapshot.publication
  };
}
function validateRatingBatch(keys: string[], score: number) {
  if (
    !Number.isInteger(score) ||
    score < 1 ||
    score > 5 ||
    !keys.length ||
    keys.length > 25 ||
    keys.some((key) => key.length < 1 || key.length > 120) ||
    new Set(keys).size !== keys.length
  )
    throw new ExperienceReviewError('VALIDATION_ERROR', 'targetKeys and score are invalid.');
}
function validateComment(value: string) {
  const comment = value.trim();
  if (!comment || comment.length > 500) throw new ExperienceReviewError('VALIDATION_ERROR', 'comment is invalid.');
  return comment;
}
function reviewFromTarget(orderId: string, target: ReviewTarget, score: number, now: Date): ExperienceReview {
  return {
    id: randomUUID(),
    orderId,
    targetKey: target.targetKey,
    targetType: target.targetType,
    orderParticipantId: target.orderParticipantId,
    attributedStaffId: target.attributedStaffId,
    score,
    comment: null,
    createdAt: now.toISOString()
  };
}
function publicationFromSnapshot(snapshot: DbSnapshot, now: Date) {
  const targets = snapshot.targets.flatMap((target) =>
    snapshot.reviews.some((review) => review.targetKey === target.targetKey && review.score === 5)
      ? [{ targetType: target.targetType, displayName: target.displayName, score: 5 as const }]
      : []
  );
  if (!targets.length) throw new ExperienceReviewError('CONFLICT', 'At least one five-star review is required.');
  return {
    id: randomUUID(),
    orderId: snapshot.order.id,
    status: 'PENDING' as const,
    snapshot: {
      orderPublicId: snapshot.order.public_id,
      serviceDisplayName: snapshot.order.service_display_name,
      completedAt: new Date(snapshot.order.completed_at!).toISOString(),
      targets
    },
    consentedAt: now.toISOString(),
    publishedAt: null
  };
}
async function insertPanelSync(client: PoolClient, orderIdValue: string, now: Date) {
  await client.query(
    `INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,created_at,updated_at) VALUES($1,'PANEL_SYNC','order',$2,$2,$3,$4::jsonb,'PENDING',1,0,8,$5,$5,$5) ON CONFLICT(dedupe_key) DO UPDATE SET status='PENDING',available_at=EXCLUDED.available_at,updated_at=EXCLUDED.updated_at`,
    [
      randomUUID(),
      orderIdValue,
      `experience-review:${orderIdValue}:panel-sync`,
      JSON.stringify({ orderId: orderIdValue }),
      now.toISOString()
    ]
  );
}

export function registerOrderExperienceReviewRoutes(
  server: FastifyInstance,
  options: { store: OrderExperienceReviewStore; now?: () => Date }
) {
  if (!server.securityOptions) throw new Error('Experience review routes require security options.');
  const now = options.now ?? (() => new Date());
  const context = (request: FastifyRequest, actor: { guildId?: string | null; discordUserId?: string | null }) => {
    if (!actor.guildId || !actor.discordUserId)
      throw new ExperienceReviewError('PERMISSION_DENIED', 'Discord actor context is required.');
    const requestedOrderId = orderId(request);
    validateUuid(requestedOrderId, 'orderId');
    return { orderId: requestedOrderId, guildId: actor.guildId, customerDiscordId: actor.discordUserId, now: now() };
  };
  registerSecureReadRoute(server, server.securityOptions, {
    method: 'GET',
    url: '/api/v1/orders/:orderId/experience-review',
    permission: 'order.experience_review.read',
    action: 'GET_ORDER_EXPERIENCE_REVIEW',
    targetType: 'order',
    targetId: orderId,
    acceptedSources: ['DISCORD_BOT'],
    mapError,
    handler: (request, actor) => options.store.getCenter(context(request, actor))
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST',
    url: '/api/v1/orders/:orderId/experience-ratings',
    permission: 'order.experience_review.create',
    action: 'CREATE_ORDER_EXPERIENCE_RATING',
    targetType: 'order_experience_review',
    targetId: orderId,
    acceptedSources: ['DISCORD_BOT'],
    successStatusCode: 201,
    mapError,
    fingerprintBody: (request) => request.body,
    handler: (request, actor) => {
      const body = request.body as { targetKeys?: unknown; score?: unknown };
      return options.store.stageRatings({
        ...context(request, actor),
        targetKeys:
          Array.isArray(body?.targetKeys) && body.targetKeys.every((item): item is string => typeof item === 'string')
            ? body.targetKeys
            : [],
        score: typeof body?.score === 'number' ? body.score : Number.NaN
      });
    }
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST',
    url: '/api/v1/orders/:orderId/experience-ratings/:reviewId/comment',
    permission: 'order.experience_review.comment',
    action: 'APPEND_ORDER_EXPERIENCE_REVIEW_COMMENT',
    targetType: 'order_experience_review',
    targetId: (request) => (request.params as { reviewId?: string }).reviewId ?? '',
    acceptedSources: ['DISCORD_BOT'],
    successStatusCode: 201,
    mapError,
    fingerprintBody: (request) => request.body,
    handler: (request, actor) => {
      const reviewId = (request.params as { reviewId?: string }).reviewId ?? '';
      validateUuid(reviewId, 'reviewId');
      const body = request.body as { comment?: unknown };
      return options.store.stageComment({
        ...context(request, actor),
        reviewId,
        comment: typeof body?.comment === 'string' ? body.comment : ''
      });
    }
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST',
    url: '/api/v1/orders/:orderId/experience-review/publication',
    permission: 'order.experience_review.publish',
    action: 'PUBLISH_ORDER_FIVE_STAR_REVIEW',
    targetType: 'order_review_publication',
    targetId: orderId,
    acceptedSources: ['DISCORD_BOT'],
    successStatusCode: 202,
    mapError,
    fingerprintBody: (request) => request.body,
    handler: (request, actor) => {
      const body = request.body as { confirmation?: unknown };
      return options.store.stagePublication({
        ...context(request, actor),
        confirmation: typeof body?.confirmation === 'string' ? body.confirmation : ''
      });
    }
  });
}

function orderId(request: FastifyRequest) {
  return (request.params as { orderId?: string }).orderId ?? '';
}
function validateUuid(value: string, field: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new ExperienceReviewError('VALIDATION_ERROR', `${field} must be a UUID.`);
}
function mapError(error: unknown) {
  if (!(error instanceof ExperienceReviewError)) return null;
  return {
    statusCode:
      error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'PERMISSION_DENIED'
          ? 403
          : ['NOT_ELIGIBLE', 'RATING_EXPIRED', 'CONFLICT'].includes(error.code)
            ? 409
            : 400,
    code: error.code,
    message: error.message
  };
}
