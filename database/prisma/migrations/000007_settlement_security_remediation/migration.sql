ALTER TABLE settlement_batches ADD COLUMN guild_id varchar(32);

WITH batch_guilds AS (
  SELECT sb.id, min(o.guild_id) AS guild_id, count(DISTINCT o.guild_id) AS guild_count,
    count(*) FILTER (WHERE o.guild_id IS NULL) AS missing_count
  FROM settlement_batches sb
  LEFT JOIN settlement_items si ON si.settlement_batch_id=sb.id
  LEFT JOIN settlement_item_entries sie ON sie.settlement_item_id=si.id
  LEFT JOIN player_earnings pe ON pe.id=sie.player_earning_id
  LEFT JOIN player_earning_adjustments pea ON pea.id=sie.player_earning_adjustment_id
  LEFT JOIN player_earnings source_pe ON source_pe.id=pea.player_earning_id
  LEFT JOIN orders o ON o.id=COALESCE(pe.order_id,source_pe.order_id)
  GROUP BY sb.id
)
UPDATE settlement_batches sb SET guild_id=bg.guild_id
FROM batch_guilds bg
WHERE bg.id=sb.id AND bg.guild_count=1 AND bg.missing_count=0;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM settlement_batches WHERE guild_id IS NULL) THEN
    RAISE EXCEPTION 'cannot prove one Guild owner for every legacy settlement batch';
  END IF;
END $$;

ALTER TABLE settlement_batches ALTER COLUMN guild_id SET NOT NULL;
ALTER TABLE settlement_batches DROP CONSTRAINT IF EXISTS settlement_batches_schedule_key_period_start_period_end_currency_key;
ALTER TABLE settlement_batches ADD CONSTRAINT settlement_batches_guild_schedule_period_currency_key
  UNIQUE (guild_id,schedule_key,period_start,period_end,currency);
CREATE INDEX settlement_batches_guild_created_idx ON settlement_batches(guild_id,created_at DESC,id DESC);
CREATE INDEX settlement_batches_guild_status_period_end_idx ON settlement_batches(guild_id,status,period_end);

CREATE OR REPLACE FUNCTION enforce_settlement_entry_guild_ownership()
RETURNS trigger AS $$
DECLARE
  batch_guild_id varchar(32);
  source_guild_id varchar(32);
BEGIN
  SELECT sb.guild_id INTO batch_guild_id
  FROM settlement_items si JOIN settlement_batches sb ON sb.id=si.settlement_batch_id
  WHERE si.id=NEW.settlement_item_id;

  IF NEW.player_earning_id IS NOT NULL THEN
    SELECT o.guild_id INTO source_guild_id
    FROM player_earnings pe JOIN orders o ON o.id=pe.order_id
    WHERE pe.id=NEW.player_earning_id;
  ELSE
    SELECT o.guild_id INTO source_guild_id
    FROM player_earning_adjustments pea
    JOIN player_earnings pe ON pe.id=pea.player_earning_id
    JOIN orders o ON o.id=pe.order_id
    WHERE pea.id=NEW.player_earning_adjustment_id;
  END IF;

  IF batch_guild_id IS NULL OR source_guild_id IS NULL OR source_guild_id<>batch_guild_id THEN
    RAISE EXCEPTION 'settlement source Guild ownership must match batch Guild ownership';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_settlement_entry_guild_ownership
BEFORE INSERT ON settlement_item_entries
FOR EACH ROW EXECUTE FUNCTION enforce_settlement_entry_guild_ownership();

CREATE OR REPLACE FUNCTION enforce_settlement_guild_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW.guild_id IS DISTINCT FROM OLD.guild_id THEN
    RAISE EXCEPTION 'settlement Guild ownership is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_settlement_guild_immutable
BEFORE UPDATE ON settlement_batches
FOR EACH ROW EXECUTE FUNCTION enforce_settlement_guild_immutable();

CREATE OR REPLACE FUNCTION enforce_settlement_replacement()
RETURNS trigger AS $$
DECLARE
  replacement_guild_id varchar(32);
  replacement_currency char(3);
  replacement_status "SettlementBatchStatus";
  replacement_finalized_at timestamptz;
BEGIN
  IF OLD.replacement_batch_id IS NOT NULL AND NEW.replacement_batch_id IS DISTINCT FROM OLD.replacement_batch_id THEN
    RAISE EXCEPTION 'settlement replacement relationship is immutable';
  END IF;
  IF NEW.replacement_batch_id IS NOT NULL AND NEW.replacement_batch_id IS DISTINCT FROM OLD.replacement_batch_id THEN
    IF NEW.status <> 'VOIDED' THEN
      RAISE EXCEPTION 'only a voided settlement batch can have a replacement';
    END IF;
    SELECT guild_id,currency,status,snapshot_finalized_at
    INTO replacement_guild_id,replacement_currency,replacement_status,replacement_finalized_at
    FROM settlement_batches WHERE id=NEW.replacement_batch_id;
    IF replacement_guild_id IS NULL OR replacement_guild_id <> NEW.guild_id
      OR replacement_currency <> NEW.currency OR replacement_status='VOIDED' OR replacement_finalized_at IS NULL THEN
      RAISE EXCEPTION 'replacement settlement batch must be finalized, active, same-Guild, and use the same currency';
    END IF;
    IF EXISTS (
      WITH RECURSIVE replacement_chain(id,replacement_batch_id) AS (
        SELECT id,replacement_batch_id FROM settlement_batches WHERE id=NEW.replacement_batch_id
        UNION ALL
        SELECT sb.id,sb.replacement_batch_id FROM settlement_batches sb
        JOIN replacement_chain chain ON sb.id=chain.replacement_batch_id
      )
      SELECT 1 FROM replacement_chain WHERE id=NEW.id OR replacement_batch_id=NEW.id
    ) THEN
      RAISE EXCEPTION 'settlement replacement cycle is forbidden';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
