CREATE TYPE "OrderChannelMessageEventType" AS ENUM ('CREATED','UPDATED','DELETED');
CREATE TABLE "order_channel_message_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "order_id" UUID NOT NULL, "order_public_id" VARCHAR(30) NOT NULL,
  "guild_id" VARCHAR(32) NOT NULL, "channel_id" VARCHAR(32) NOT NULL, "discord_message_id" VARCHAR(32) NOT NULL,
  "event_id" VARCHAR(150) NOT NULL, "event_type" "OrderChannelMessageEventType" NOT NULL,
  "author_discord_id" VARCHAR(32), "author_display_name" VARCHAR(100), "author_is_bot" BOOLEAN,
  "content_snapshot" VARCHAR(4000), "embeds_snapshot" JSONB NOT NULL DEFAULT '[]', "attachments_snapshot" JSONB NOT NULL DEFAULT '[]',
  "reply_to_message_id" VARCHAR(32), "discord_created_at" TIMESTAMPTZ(3), "discord_edited_at" TIMESTAMPTZ(3),
  "observed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_channel_message_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_channel_message_events_order_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "order_channel_message_events_event_id_key" ON "order_channel_message_events"("event_id");
CREATE INDEX "order_channel_message_events_ticket_idx" ON "order_channel_message_events"("order_public_id","observed_at");
CREATE INDEX "order_channel_message_events_order_idx" ON "order_channel_message_events"("order_id","observed_at");
CREATE FUNCTION prevent_order_channel_message_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'order channel message events are append-only'; END; $$;
CREATE TRIGGER "order_channel_message_events_no_update" BEFORE UPDATE ON "order_channel_message_events" FOR EACH ROW EXECUTE FUNCTION prevent_order_channel_message_event_mutation();
CREATE TRIGGER "order_channel_message_events_no_delete" BEFORE DELETE ON "order_channel_message_events" FOR EACH ROW EXECUTE FUNCTION prevent_order_channel_message_event_mutation();
