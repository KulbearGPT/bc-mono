CREATE TYPE "OrderParticipantStatus" AS ENUM ('ACTIVE', 'REMOVED');
CREATE TYPE "CompensationSource" AS ENUM ('PLAYER_OVERRIDE', 'CATALOG_DEFAULT', 'LEGACY_ORDER_SNAPSHOT');
CREATE TYPE "OrderParticipantEventType" AS ENUM ('ADDED', 'PROJECT_CHANGED', 'PRICE_CHANGED', 'READY_CONFIRMED', 'REMOVED');

CREATE TABLE "order_participants" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "player_id" UUID NOT NULL,
  "service_catalog_version_id" UUID NOT NULL,
  "status" "OrderParticipantStatus" NOT NULL DEFAULT 'ACTIVE',
  "row_version" INTEGER NOT NULL DEFAULT 1,
  "player_display_name_snapshot" VARCHAR(100) NOT NULL,
  "game_code_snapshot" VARCHAR(80) NOT NULL,
  "game_display_name_snapshot" VARCHAR(100) NOT NULL,
  "service_code_snapshot" VARCHAR(80) NOT NULL,
  "service_display_name_snapshot" VARCHAR(100) NOT NULL,
  "region_code_snapshot" VARCHAR(80),
  "region_display_name_snapshot" VARCHAR(100),
  "billing_unit_minutes_snapshot" INTEGER NOT NULL,
  "unit_count" INTEGER NOT NULL,
  "customer_unit_price_minor_snapshot" BIGINT NOT NULL,
  "line_price_minor" BIGINT NOT NULL,
  "compensation_type_snapshot" "PlayerCompensationType" NOT NULL,
  "compensation_value_snapshot" BIGINT NOT NULL,
  "compensation_source" "CompensationSource" NOT NULL,
  "expected_earning_minor" BIGINT NOT NULL,
  "ready_at" TIMESTAMPTZ(3),
  "added_by_staff_id" UUID,
  "removed_by_staff_id" UUID,
  "removed_reason_code" VARCHAR(100),
  "removed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "order_participants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_participants_version_positive_chk" CHECK ("row_version" > 0),
  CONSTRAINT "order_participants_units_positive_chk" CHECK ("billing_unit_minutes_snapshot" > 0 AND "unit_count" > 0),
  CONSTRAINT "order_participants_money_non_negative_chk" CHECK (
    "customer_unit_price_minor_snapshot" >= 0 AND "line_price_minor" >= 0
    AND "compensation_value_snapshot" >= 0 AND "expected_earning_minor" >= 0
  ),
  CONSTRAINT "order_participants_percent_bps_chk" CHECK (
    "compensation_type_snapshot" <> 'PERCENT_BPS' OR "compensation_value_snapshot" <= 10000
  ),
  CONSTRAINT "order_participants_removed_shape_chk" CHECK (
    ("status" = 'ACTIVE' AND "removed_at" IS NULL AND "removed_by_staff_id" IS NULL AND "removed_reason_code" IS NULL)
    OR ("status" = 'REMOVED' AND "removed_at" IS NOT NULL AND "removed_reason_code" IS NOT NULL)
  ),
  CONSTRAINT "order_participants_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "order_participants_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "order_participants_service_catalog_version_id_fkey" FOREIGN KEY ("service_catalog_version_id") REFERENCES "service_catalog_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "order_participants_added_by_staff_id_fkey" FOREIGN KEY ("added_by_staff_id") REFERENCES "staff_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "order_participants_removed_by_staff_id_fkey" FOREIGN KEY ("removed_by_staff_id") REFERENCES "staff_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "order_participants_one_active_player_idx"
  ON "order_participants"("order_id", "player_id") WHERE "status" = 'ACTIVE';
CREATE INDEX "order_participants_order_status_created_idx" ON "order_participants"("order_id", "status", "created_at");
CREATE INDEX "order_participants_player_status_created_idx" ON "order_participants"("player_id", "status", "created_at");
CREATE INDEX "order_participants_service_catalog_version_id_idx" ON "order_participants"("service_catalog_version_id");

CREATE TABLE "order_participant_events" (
  "id" UUID NOT NULL,
  "order_participant_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event_type" "OrderParticipantEventType" NOT NULL,
  "participant_version" INTEGER NOT NULL,
  "order_version" INTEGER NOT NULL,
  "actor_staff_id" UUID,
  "actor_user_id" UUID,
  "reason_code" VARCHAR(100),
  "snapshot" JSONB NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_participant_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_participant_events_sequence_positive_chk" CHECK ("sequence" > 0 AND "participant_version" > 0 AND "order_version" > 0),
  CONSTRAINT "order_participant_events_order_participant_id_fkey" FOREIGN KEY ("order_participant_id") REFERENCES "order_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "order_participant_events_actor_staff_id_fkey" FOREIGN KEY ("actor_staff_id") REFERENCES "staff_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "order_participant_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "order_participant_events_participant_sequence_key" ON "order_participant_events"("order_participant_id", "sequence");
CREATE UNIQUE INDEX "order_participant_events_idempotency_key_key" ON "order_participant_events"("idempotency_key");
CREATE INDEX "order_participant_events_participant_created_idx" ON "order_participant_events"("order_participant_id", "created_at");

ALTER TABLE "player_earnings" ADD COLUMN order_participant_id UUID;
CREATE UNIQUE INDEX "player_earnings_order_participant_id_key" ON "player_earnings"("order_participant_id") WHERE "order_participant_id" IS NOT NULL;
ALTER TABLE "player_earnings" ADD CONSTRAINT "player_earnings_order_participant_id_fkey"
  FOREIGN KEY ("order_participant_id") REFERENCES "order_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO order_participants (
  id, order_id, player_id, service_catalog_version_id, status, row_version,
  player_display_name_snapshot, game_code_snapshot, game_display_name_snapshot,
  service_code_snapshot, service_display_name_snapshot, region_code_snapshot, region_display_name_snapshot,
  billing_unit_minutes_snapshot, unit_count, customer_unit_price_minor_snapshot, line_price_minor,
  compensation_type_snapshot, compensation_value_snapshot, compensation_source, expected_earning_minor,
  ready_at, added_by_staff_id, created_at, updated_at
)
SELECT
  gen_random_uuid(), orders.id, orders.player_id, orders.service_catalog_version_id, 'ACTIVE', 1,
  users.display_name,
  COALESCE(orders.game_code_snapshot, offering.game_code), COALESCE(orders.game_name_snapshot, offering.game_name),
  COALESCE(orders.service_code_snapshot, offering.service_code), COALESCE(orders.service_name_snapshot, offering.service_name),
  COALESCE(orders.region_code_snapshot, offering.region_code), COALESCE(orders.region_name_snapshot, orders.region_code_snapshot, offering.region_code),
  COALESCE(orders.billing_unit_minutes, version.billing_unit_minutes), COALESCE(orders.unit_count, version.minimum_units),
  COALESCE(orders.customer_unit_price_minor, version.customer_unit_price_minor), orders.amount_minor,
  'FIXED_MINOR', COALESCE(orders.player_unit_payout_minor, version.player_unit_payout_minor), 'LEGACY_ORDER_SNAPSHOT',
  orders.expected_player_earning_minor, orders.player_ready_at, NULL, orders.created_at, orders.updated_at
FROM orders
JOIN users ON users.id = orders.player_id
JOIN service_catalog_versions version ON version.id = orders.service_catalog_version_id
JOIN service_offerings offering ON offering.id = version.service_offering_id
WHERE orders.player_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO order_participant_events (
  id, order_participant_id, sequence, event_type, participant_version, order_version,
  actor_staff_id, actor_user_id, reason_code, snapshot, idempotency_key, created_at
)
SELECT gen_random_uuid(), participant.id, 1, 'ADDED', participant.row_version, orders.row_version,
  NULL, NULL, 'LEGACY_ORDER_BACKFILL', to_jsonb(participant),
  'migration:000019:participant:' || participant.id::text, participant.created_at
FROM order_participants participant
JOIN orders ON orders.id = participant.order_id;

UPDATE player_earnings earning
SET order_participant_id = participant.id
FROM order_participants participant
WHERE participant.order_id = earning.order_id
  AND participant.player_id = earning.player_user_id
  AND earning.order_participant_id IS NULL;

CREATE FUNCTION guard_order_participant_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'order participants cannot be deleted';
  END IF;
  IF EXISTS (
    SELECT 1 FROM fund_reservations reservation
    WHERE reservation.order_id = OLD.order_id AND reservation.status = 'CAPTURED'
  ) THEN
    RAISE EXCEPTION 'captured order participants are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_participants_guard
BEFORE UPDATE OR DELETE ON order_participants
FOR EACH ROW EXECUTE FUNCTION guard_order_participant_mutation();

CREATE TRIGGER trg_order_participant_events_append_only
BEFORE UPDATE OR DELETE ON order_participant_events
FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();

GRANT SELECT, INSERT, UPDATE ON order_participants TO blackcat_app;
GRANT SELECT, INSERT ON order_participant_events TO blackcat_app;
REVOKE DELETE ON order_participants, order_participant_events FROM blackcat_app;
REVOKE UPDATE ON order_participant_events FROM blackcat_app;
