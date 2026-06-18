-- A completed multi-player order creates one earning per immutable participant snapshot.
-- The legacy one-order/one-earning index predates order_participants and blocks that model.
DROP INDEX IF EXISTS "player_earnings_order_id_key";

CREATE INDEX IF NOT EXISTS "player_earnings_order_id_created_at_idx"
  ON "player_earnings"("order_id", "created_at");
