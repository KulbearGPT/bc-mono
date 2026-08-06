import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  insertPostgresAuditRecord,
  registerSecureWriteRoute,
  type AuditRecord,
} from "./security.js";

export const supportRatingReasons = [
  "RUDE_LANGUAGE",
  "COLD_OR_DISMISSIVE",
  "RESPONSIBILITY_SHIRKING",
  "PRESSURING_CUSTOMER",
  "OTHER",
] as const;
export type SupportRatingReason = (typeof supportRatingReasons)[number];

export interface SupportRatingRecord {
  id: string;
  orderId: string;
  score: number;
  reason: SupportRatingReason | null;
  comment: string | null;
  attributedStaffId: string;
  createdAt: string;
}

interface RatingInput {
  orderId: string;
  guildId: string;
  customerDiscordId: string;
  score: number;
  reason: SupportRatingReason | null;
  comment: string | null;
  now: Date;
}

interface StagedRating {
  data: SupportRatingRecord;
  commit(audit: AuditRecord): Promise<void> | void;
}

export interface SupportRatingStore {
  stageCreate(input: RatingInput): Promise<StagedRating> | StagedRating;
}

export class SupportRatingError extends Error {
  constructor(
    readonly code:
      | "VALIDATION_ERROR"
      | "NOT_FOUND"
      | "PERMISSION_DENIED"
      | "NOT_ELIGIBLE"
      | "RATING_EXPIRED"
      | "ALREADY_RATED",
    message: string,
  ) {
    super(message);
    this.name = "SupportRatingError";
  }
}

export class InMemorySupportRatingStore implements SupportRatingStore {
  readonly ratings: SupportRatingRecord[] = [];

  constructor(
    private readonly input: {
      orders: Array<{
        id: string;
        guildId: string;
        customerId: string;
        customerDiscordId: string;
        status: string;
        completedAt: string | null;
        respondedStaffId: string | null;
      }>;
    },
  ) {}

  stageCreate(input: RatingInput): StagedRating {
    validateRating(input);
    const order = this.input.orders.find(
      (item) => item.id === input.orderId && item.guildId === input.guildId,
    );
    if (!order)
      throw new SupportRatingError("NOT_FOUND", "Order was not found.");
    if (order.customerDiscordId !== input.customerDiscordId) {
      throw new SupportRatingError(
        "PERMISSION_DENIED",
        "Only the order customer may rate support.",
      );
    }
    requireEligibility(order, input.now);
    if (this.ratings.some((item) => item.orderId === order.id)) {
      throw new SupportRatingError(
        "ALREADY_RATED",
        "Support was already rated for this order.",
      );
    }
    const data: SupportRatingRecord = {
      id: randomUUID(),
      orderId: order.id,
      score: input.score,
      reason: input.reason,
      comment: input.comment,
      attributedStaffId: order.respondedStaffId!,
      createdAt: input.now.toISOString(),
    };
    return {
      data,
      commit: () => {
        if (this.ratings.some((item) => item.orderId === order.id)) {
          throw new SupportRatingError(
            "ALREADY_RATED",
            "Support was already rated for this order.",
          );
        }
        this.ratings.push(structuredClone(data));
      },
    };
  }
}

export class PostgresSupportRatingStore implements SupportRatingStore {
  constructor(private readonly pool: Pool) {}

  async stageCreate(input: RatingInput): Promise<StagedRating> {
    validateRating(input);
    const result = await this.pool.query<EligibilityRow>(
      `SELECT o.id, o.status::text AS status, o.completed_at,
              customer_da.discord_user_id AS customer_discord_id,
              response_staff.id AS responded_staff_id
         FROM orders o
         JOIN discord_accounts customer_da
           ON customer_da.user_id=o.customer_id AND customer_da.guild_id=$2
         LEFT JOIN LATERAL (
           SELECT sa.id
             FROM staff_tasks st
             JOIN order_channel_message_events message
               ON message.id=st.first_response_event_id
             JOIN discord_accounts staff_da
               ON staff_da.guild_id=$2
              AND staff_da.discord_user_id=message.author_discord_id
             JOIN staff_accounts sa ON sa.user_id=staff_da.user_id
            WHERE st.order_id=o.id
              AND st.first_responded_at IS NOT NULL
            ORDER BY st.first_responded_at ASC, st.id ASC
            LIMIT 1
         ) response_staff ON true
        WHERE o.id=$1 AND o.guild_id=$2`,
      [input.orderId, input.guildId],
    );
    const order = result.rows[0];
    if (!order)
      throw new SupportRatingError("NOT_FOUND", "Order was not found.");
    if (order.customer_discord_id !== input.customerDiscordId) {
      throw new SupportRatingError(
        "PERMISSION_DENIED",
        "Only the order customer may rate support.",
      );
    }
    requireEligibility(
      {
        status: order.status,
        completedAt: iso(order.completed_at),
        respondedStaffId: order.responded_staff_id,
      },
      input.now,
    );

    const data: SupportRatingRecord = {
      id: randomUUID(),
      orderId: input.orderId,
      score: input.score,
      reason: input.reason,
      comment: input.comment,
      attributedStaffId: order.responded_staff_id!,
      createdAt: input.now.toISOString(),
    };
    return {
      data,
      commit: async (audit) => {
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          const inserted = await client.query(
            `INSERT INTO order_support_ratings
               (id,order_id,customer_id,attributed_staff_id,score,reason,reason_snapshot,comment,expires_at,created_at)
             SELECT $1,o.id,o.customer_id,$2,$3,$4::"SupportRatingReason",$4::text,$5,o.completed_at+interval '24 hours',$6
               FROM orders o
              WHERE o.id=$7
                AND o.guild_id=$8
                AND o.status='COMPLETED'
                AND o.completed_at IS NOT NULL
                AND o.completed_at+interval '24 hours'>=$6
                AND EXISTS (
                  SELECT 1 FROM staff_tasks st
                   WHERE st.order_id=o.id
                     AND st.first_responded_at IS NOT NULL
                     AND st.first_response_event_id IS NOT NULL
                )
             RETURNING id`,
            [
              data.id,
              data.attributedStaffId,
              data.score,
              data.reason,
              data.comment,
              data.createdAt,
              data.orderId,
              input.guildId,
            ],
          );
          if (!inserted.rows[0]) {
            throw new SupportRatingError(
              "NOT_ELIGIBLE",
              "The order is no longer eligible for a support rating.",
            );
          }
          await client.query(
            `INSERT INTO order_experience_reviews
               (id,order_id,customer_id,target_type,target_key,attributed_staff_id,score,created_at)
             SELECT $1,o.id,o.customer_id,'SUPPORT'::"ExperienceReviewTargetType",
                    'support:' || ($2::uuid)::text,$2::uuid,$3,$4
               FROM orders o WHERE o.id=$5`,
            [
              data.id,
              data.attributedStaffId,
              data.score,
              data.createdAt,
              data.orderId,
            ],
          );
          if (data.comment) {
            await client.query(
              `INSERT INTO order_experience_review_comments
                 (id,review_id,customer_id,comment,created_at)
               SELECT $1,$2,o.customer_id,$3,$4 FROM orders o WHERE o.id=$5`,
              [randomUUID(), data.id, data.comment, data.createdAt, data.orderId],
            );
          }
          await client.query(
            `INSERT INTO outbox_events
               (id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,created_at,updated_at)
             VALUES ($1,'PANEL_SYNC','order',$2,$2,$3,$4::jsonb,'PENDING',1,0,8,$5,$5,$5)
             ON CONFLICT (dedupe_key) DO NOTHING`,
            [
              randomUUID(),
              data.orderId,
              `support-rating:${data.orderId}:panel-sync`,
              JSON.stringify({ orderId: data.orderId }),
              data.createdAt,
            ],
          );
          await insertPostgresAuditRecord(client, audit);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          if ((error as { code?: string }).code === "23505") {
            throw new SupportRatingError(
              "ALREADY_RATED",
              "Support was already rated for this order.",
            );
          }
          throw error;
        } finally {
          client.release();
        }
      },
    };
  }
}

export function registerSupportRatingRoutes(
  server: FastifyInstance,
  options: { store: SupportRatingStore; now?: () => Date },
) {
  if (!server.securityOptions)
    throw new Error("Support rating routes require security options.");
  const now = options.now ?? (() => new Date());
  registerSecureWriteRoute(server, server.securityOptions, {
    method: "POST",
    url: "/api/v1/orders/:orderId/support-rating",
    permission: "order.support_rating.create",
    action: "CREATE_ORDER_SUPPORT_RATING",
    targetType: "order_support_rating",
    targetId: (request) => orderId(request),
    acceptedSources: ["DISCORD_BOT"],
    successStatusCode: 201,
    mapError,
    fingerprintBody: (request) => parseRating(request.body),
    handler: (request, actor) => {
      if (!actor.guildId || !actor.discordUserId) {
        throw new SupportRatingError(
          "PERMISSION_DENIED",
          "Discord actor context is required.",
        );
      }
      return options.store.stageCreate({
        orderId: orderId(request),
        guildId: actor.guildId,
        customerDiscordId: actor.discordUserId,
        ...parseRating(request.body),
        now: now(),
      });
    },
  });
}

function parseRating(body: unknown) {
  const value = body as
    | { score?: unknown; reason?: unknown; comment?: unknown }
    | null;
  const comment =
    value?.comment == null ? null : String(value.comment).trim() || null;
  const parsed = {
    score: Number(value?.score),
    reason:
      value?.reason == null
        ? null
        : (String(value.reason) as SupportRatingReason),
    comment,
  };
  validateRating(parsed);
  return parsed;
}

function validateRating(input: {
  score: number;
  reason: SupportRatingReason | null;
  comment: string | null;
}) {
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
    throw new SupportRatingError(
      "VALIDATION_ERROR",
      "score must be from 1 to 5.",
    );
  }
  if (input.reason !== null && !supportRatingReasons.includes(input.reason)) {
    throw new SupportRatingError("VALIDATION_ERROR", "reason is invalid.");
  }
  if (input.comment && input.comment.length > 500) {
    throw new SupportRatingError("VALIDATION_ERROR", "comment is too long.");
  }
  if (input.score <= 2 && !input.reason) {
    throw new SupportRatingError(
      "VALIDATION_ERROR",
      "A controlled reason is required for scores 1 and 2.",
    );
  }
  if (input.reason === "OTHER" && !input.comment) {
    throw new SupportRatingError(
      "VALIDATION_ERROR",
      "A comment is required for OTHER.",
    );
  }
}

function requireEligibility(
  order: {
    status: string;
    completedAt: string | null;
    respondedStaffId: string | null;
  },
  now: Date,
) {
  if (
    order.status !== "COMPLETED" ||
    !order.completedAt ||
    !order.respondedStaffId
  ) {
    throw new SupportRatingError(
      "NOT_ELIGIBLE",
      "The order has no eligible completed support response.",
    );
  }
  if (now.getTime() > new Date(order.completedAt).getTime() + 24 * 60 * 60_000) {
    throw new SupportRatingError(
      "RATING_EXPIRED",
      "The 24-hour support rating window has expired.",
    );
  }
}

function mapError(error: unknown) {
  if (!(error instanceof SupportRatingError)) return null;
  return {
    statusCode:
      error.code === "NOT_FOUND"
        ? 404
        : error.code === "PERMISSION_DENIED"
          ? 403
          : ["NOT_ELIGIBLE", "RATING_EXPIRED", "ALREADY_RATED"].includes(
                error.code,
              )
            ? 409
            : 400,
    code: error.code,
    message: error.message,
  };
}

function orderId(request: FastifyRequest) {
  return (request.params as { orderId?: string }).orderId ?? "";
}

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}

interface EligibilityRow {
  id: string;
  status: string;
  completed_at: Date | string | null;
  customer_discord_id: string;
  responded_staff_id: string | null;
}
