CREATE TYPE "SupportResponseStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'MET', 'OVERDUE');
CREATE TYPE "SupportRatingReason" AS ENUM ('RUDE_LANGUAGE', 'COLD_OR_DISMISSIVE', 'RESPONSIBILITY_SHIRKING', 'PRESSURING_CUSTOMER', 'OTHER');

ALTER TABLE "staff_tasks"
  ADD COLUMN "response_status" "SupportResponseStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "response_due_at" TIMESTAMPTZ(3),
  ADD COLUMN "first_responded_at" TIMESTAMPTZ(3),
  ADD COLUMN "first_response_event_id" UUID;
ALTER TABLE "staff_tasks" ADD CONSTRAINT "staff_tasks_first_response_event_id_fkey"
  FOREIGN KEY ("first_response_event_id") REFERENCES "order_channel_message_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "staff_tasks_response_status_response_due_at_idx" ON "staff_tasks"("response_status", "response_due_at");

CREATE TABLE "support_shifts" (
  "id" UUID NOT NULL,
  "guild_id" VARCHAR(32) NOT NULL,
  "staff_account_id" UUID NOT NULL,
  "clocked_in_at" TIMESTAMPTZ(3) NOT NULL,
  "clocked_out_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_shifts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_shifts_time_order" CHECK ("clocked_out_at" IS NULL OR "clocked_out_at" >= "clocked_in_at"),
  CONSTRAINT "support_shifts_staff_account_id_fkey" FOREIGN KEY ("staff_account_id") REFERENCES "staff_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "support_shifts_guild_id_staff_account_id_clocked_in_at_idx" ON "support_shifts"("guild_id", "staff_account_id", "clocked_in_at");
CREATE UNIQUE INDEX "support_shifts_one_active_per_staff_guild" ON "support_shifts"("guild_id", "staff_account_id") WHERE "clocked_out_at" IS NULL;

CREATE TABLE "order_support_ratings" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "attributed_staff_id" UUID,
  "score" INTEGER NOT NULL,
  "reason" "SupportRatingReason",
  "reason_snapshot" VARCHAR(100),
  "comment" VARCHAR(500),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_support_ratings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_support_ratings_score" CHECK ("score" BETWEEN 1 AND 5),
  CONSTRAINT "order_support_ratings_low_reason" CHECK ("score" > 2 OR "reason" IS NOT NULL),
  CONSTRAINT "order_support_ratings_other_comment" CHECK ("reason" IS DISTINCT FROM 'OTHER' OR ("comment" IS NOT NULL AND length(trim("comment")) > 0)),
  CONSTRAINT "order_support_ratings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "order_support_ratings_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "order_support_ratings_attributed_staff_id_fkey" FOREIGN KEY ("attributed_staff_id") REFERENCES "staff_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "order_support_ratings_order_id_key" ON "order_support_ratings"("order_id");
CREATE INDEX "order_support_ratings_attributed_staff_id_created_at_idx" ON "order_support_ratings"("attributed_staff_id", "created_at");

GRANT SELECT, INSERT, UPDATE ON support_shifts TO blackcat_app;
GRANT SELECT, INSERT ON order_support_ratings TO blackcat_app;
