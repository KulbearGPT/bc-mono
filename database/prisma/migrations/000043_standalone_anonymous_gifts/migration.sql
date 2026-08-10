CREATE TYPE "GiftRequestOrigin" AS ENUM ('ORDER', 'STANDALONE');
CREATE TYPE "GiftSenderVisibility" AS ENUM ('PUBLIC', 'ANONYMOUS');

ALTER TABLE "gift_requests"
  ADD COLUMN "guild_id" VARCHAR(32),
  ADD COLUMN "origin" "GiftRequestOrigin" NOT NULL DEFAULT 'ORDER',
  ADD COLUMN "sender_visibility" "GiftSenderVisibility" NOT NULL DEFAULT 'PUBLIC';

UPDATE "gift_requests" gift
SET "guild_id" = orders."guild_id"
FROM "orders" orders
WHERE orders."id" = gift."order_id";

ALTER TABLE "gift_requests"
  ALTER COLUMN "order_id" DROP NOT NULL,
  ADD CONSTRAINT "gift_requests_source_shape_chk" CHECK (
    ("origin"='ORDER' AND "order_id" IS NOT NULL) OR
    ("origin"='STANDALONE' AND "order_id" IS NULL AND "order_participant_id" IS NULL)
  );

CREATE INDEX "gift_requests_guild_id_created_at_idx" ON "gift_requests"("guild_id","created_at");
CREATE INDEX "gift_requests_origin_created_at_idx" ON "gift_requests"("origin","created_at");

CREATE FUNCTION derive_order_gift_guild() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."origin"='ORDER' AND NEW."guild_id" IS NULL THEN
    SELECT "guild_id" INTO NEW."guild_id" FROM "orders" WHERE "id"=NEW."order_id";
  END IF;
  IF NEW."guild_id" IS NULL THEN RAISE EXCEPTION 'gift request guild is required'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "gift_requests_derive_order_guild" BEFORE INSERT ON "gift_requests"
FOR EACH ROW EXECUTE FUNCTION derive_order_gift_guild();

ALTER TABLE "gift_requests" ALTER COLUMN "guild_id" SET NOT NULL;

CREATE TABLE "guild_gift_entry_messages" (
  "guild_id" VARCHAR(32) NOT NULL,
  "channel_id" VARCHAR(32) NOT NULL,
  "message_id" VARCHAR(32),
  "rendered_version" INTEGER NOT NULL DEFAULT 1,
  "last_ensured_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "guild_gift_entry_messages_pkey" PRIMARY KEY ("guild_id"),
  CONSTRAINT "guild_gift_entry_messages_guild_id_channel_id_key" UNIQUE ("guild_id","channel_id"),
  CONSTRAINT "guild_gift_entry_messages_version_chk" CHECK ("rendered_version" > 0)
);

CREATE FUNCTION protect_gift_request_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."guild_id" IS DISTINCT FROM NEW."guild_id"
    OR OLD."origin" IS DISTINCT FROM NEW."origin"
    OR OLD."sender_visibility" IS DISTINCT FROM NEW."sender_visibility"
    OR OLD."order_id" IS DISTINCT FROM NEW."order_id"
    OR OLD."order_participant_id" IS DISTINCT FROM NEW."order_participant_id"
    OR OLD."sender_id" IS DISTINCT FROM NEW."sender_id"
    OR OLD."receiver_id" IS DISTINCT FROM NEW."receiver_id" THEN
    RAISE EXCEPTION 'gift request identity and visibility are immutable';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "gift_requests_identity_immutable"
BEFORE UPDATE ON "gift_requests"
FOR EACH ROW EXECUTE FUNCTION protect_gift_request_identity();

GRANT SELECT, INSERT, UPDATE, DELETE ON "guild_gift_entry_messages" TO blackcat_app;
