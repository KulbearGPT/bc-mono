CREATE TYPE "PlayerCompensationType" AS ENUM ('PERCENT_BPS', 'FIXED_MINOR');

ALTER TABLE "service_catalog_versions" ADD COLUMN "default_player_payout_bps" INTEGER;
UPDATE "service_catalog_versions" SET "default_player_payout_bps" = FLOOR("player_unit_payout_minor" * 10000 / "customer_unit_price_minor");
ALTER TABLE "service_catalog_versions" ALTER COLUMN "default_player_payout_bps" SET DEFAULT 6000;
ALTER TABLE "service_catalog_versions" ALTER COLUMN "default_player_payout_bps" SET NOT NULL;
ALTER TABLE "service_catalog_versions" ADD CONSTRAINT "service_catalog_default_payout_bps_check" CHECK ("default_player_payout_bps" BETWEEN 1 AND 10000);

CREATE TABLE "player_service_compensation_rules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "player_id" UUID NOT NULL,
  "service_offering_id" UUID NOT NULL,
  "type" "PlayerCompensationType" NOT NULL,
  "value" BIGINT NOT NULL,
  "currency" CHAR(3),
  "row_version" INTEGER NOT NULL DEFAULT 1,
  "updated_by_staff_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "player_service_compensation_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "player_compensation_value_check" CHECK (
    ("type" = 'PERCENT_BPS' AND "value" BETWEEN 1 AND 10000 AND "currency" IS NULL)
    OR ("type" = 'FIXED_MINOR' AND "value" > 0 AND "currency" = 'CAT')
  ),
  CONSTRAINT "player_compensation_player_fkey" FOREIGN KEY ("player_id") REFERENCES "player_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "player_compensation_offering_fkey" FOREIGN KEY ("service_offering_id") REFERENCES "service_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "player_compensation_staff_fkey" FOREIGN KEY ("updated_by_staff_id") REFERENCES "staff_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "player_service_compensation_rules_player_id_service_offering_id_key" ON "player_service_compensation_rules"("player_id", "service_offering_id");
CREATE INDEX "player_service_compensation_rules_service_offering_id_idx" ON "player_service_compensation_rules"("service_offering_id");
