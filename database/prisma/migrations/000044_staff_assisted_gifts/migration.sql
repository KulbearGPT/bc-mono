CREATE TYPE "GiftRequestInitiatorMode" AS ENUM ('CUSTOMER_SELF', 'STAFF_ASSISTED');

ALTER TABLE "gift_requests"
  ADD COLUMN "initiator_mode" "GiftRequestInitiatorMode" NOT NULL DEFAULT 'CUSTOMER_SELF',
  ADD COLUMN "assisted_by_staff_id" UUID,
  ADD COLUMN "gift_assist_challenge_id" UUID;

CREATE TABLE "staff_gift_assist_challenges" (
  "id" UUID NOT NULL,
  "guild_id" VARCHAR(32) NOT NULL,
  "staff_account_id" UUID NOT NULL,
  "staff_discord_user_id" VARCHAR(32) NOT NULL,
  "permissions_version" INTEGER NOT NULL,
  "customer_user_id" UUID NOT NULL,
  "customer_discord_user_id" VARCHAR(32) NOT NULL,
  "authorization_channel_id" VARCHAR(32) NOT NULL,
  "authorization_message_id" VARCHAR(32) NOT NULL,
  "authorization_reason" VARCHAR(1000),
  "failed_attempts" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "consumed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_gift_assist_challenges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "staff_gift_assist_permissions_version_chk" CHECK ("permissions_version" > 0),
  CONSTRAINT "staff_gift_assist_failed_attempts_chk" CHECK ("failed_attempts" BETWEEN 0 AND 5),
  CONSTRAINT "staff_gift_assist_expiry_chk" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "staff_gift_assist_consumption_chk" CHECK (
    ("consumed_at" IS NULL AND "authorization_reason" IS NULL) OR
    ("consumed_at" IS NOT NULL AND "authorization_reason" IS NOT NULL AND length(trim("authorization_reason")) >= 3
      AND "consumed_at" >= "created_at" AND "consumed_at" <= "expires_at")
  )
);

CREATE UNIQUE INDEX "gift_requests_gift_assist_challenge_id_key" ON "gift_requests"("gift_assist_challenge_id");
CREATE INDEX "staff_gift_assist_owner_state_idx" ON "staff_gift_assist_challenges"("staff_account_id","consumed_at","expires_at");
CREATE INDEX "staff_gift_assist_customer_idx" ON "staff_gift_assist_challenges"("guild_id","customer_user_id","created_at");

ALTER TABLE "staff_gift_assist_challenges"
  ADD CONSTRAINT "staff_gift_assist_challenges_staff_account_id_fkey"
    FOREIGN KEY ("staff_account_id") REFERENCES "staff_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "staff_gift_assist_challenges_customer_user_id_fkey"
    FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "gift_requests"
  ADD CONSTRAINT "gift_requests_assisted_by_staff_id_fkey"
    FOREIGN KEY ("assisted_by_staff_id") REFERENCES "staff_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gift_requests_gift_assist_challenge_id_fkey"
    FOREIGN KEY ("gift_assist_challenge_id") REFERENCES "staff_gift_assist_challenges"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gift_requests_initiator_shape_chk" CHECK (
    ("initiator_mode"='CUSTOMER_SELF' AND "assisted_by_staff_id" IS NULL AND "gift_assist_challenge_id" IS NULL) OR
    ("initiator_mode"='STAFF_ASSISTED' AND "origin"='STANDALONE'
      AND "assisted_by_staff_id" IS NOT NULL AND "gift_assist_challenge_id" IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION protect_gift_request_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."guild_id" IS DISTINCT FROM NEW."guild_id"
    OR OLD."origin" IS DISTINCT FROM NEW."origin"
    OR OLD."sender_visibility" IS DISTINCT FROM NEW."sender_visibility"
    OR OLD."initiator_mode" IS DISTINCT FROM NEW."initiator_mode"
    OR OLD."assisted_by_staff_id" IS DISTINCT FROM NEW."assisted_by_staff_id"
    OR OLD."gift_assist_challenge_id" IS DISTINCT FROM NEW."gift_assist_challenge_id"
    OR OLD."order_id" IS DISTINCT FROM NEW."order_id"
    OR OLD."order_participant_id" IS DISTINCT FROM NEW."order_participant_id"
    OR OLD."sender_id" IS DISTINCT FROM NEW."sender_id"
    OR OLD."receiver_id" IS DISTINCT FROM NEW."receiver_id" THEN
    RAISE EXCEPTION 'gift request identity, initiation and visibility are immutable';
  END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION protect_staff_gift_assist_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'staff gift assist challenges are append-only'; END IF;
  IF OLD."guild_id" IS DISTINCT FROM NEW."guild_id"
    OR OLD."staff_account_id" IS DISTINCT FROM NEW."staff_account_id"
    OR OLD."staff_discord_user_id" IS DISTINCT FROM NEW."staff_discord_user_id"
    OR OLD."permissions_version" IS DISTINCT FROM NEW."permissions_version"
    OR OLD."customer_user_id" IS DISTINCT FROM NEW."customer_user_id"
    OR OLD."customer_discord_user_id" IS DISTINCT FROM NEW."customer_discord_user_id"
    OR OLD."authorization_channel_id" IS DISTINCT FROM NEW."authorization_channel_id"
    OR OLD."authorization_message_id" IS DISTINCT FROM NEW."authorization_message_id"
    OR OLD."expires_at" IS DISTINCT FROM NEW."expires_at"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'staff gift assist challenge identity is immutable';
  END IF;
  IF OLD."consumed_at" IS NOT NULL THEN RAISE EXCEPTION 'consumed staff gift assist challenge is immutable'; END IF;
  IF NEW."failed_attempts" NOT IN (OLD."failed_attempts", OLD."failed_attempts" + 1) THEN
    RAISE EXCEPTION 'staff gift assist failed attempts may only increment once';
  END IF;
  IF NEW."consumed_at" IS NULL AND NEW."authorization_reason" IS DISTINCT FROM OLD."authorization_reason" THEN
    RAISE EXCEPTION 'authorization reason may only be frozen on consumption';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "staff_gift_assist_challenge_immutable"
BEFORE UPDATE OR DELETE ON "staff_gift_assist_challenges"
FOR EACH ROW EXECUTE FUNCTION protect_staff_gift_assist_challenge();

GRANT SELECT, INSERT, UPDATE ON "staff_gift_assist_challenges" TO blackcat_app;
REVOKE DELETE ON "staff_gift_assist_challenges" FROM blackcat_app;
REVOKE UPDATE ("guild_id","staff_account_id","staff_discord_user_id","permissions_version","customer_user_id",
  "customer_discord_user_id","authorization_channel_id","authorization_message_id","expires_at","created_at")
  ON "staff_gift_assist_challenges" FROM blackcat_app;
