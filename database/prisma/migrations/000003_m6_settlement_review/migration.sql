-- Upgrade path for databases that already applied 000002 before M6-US-02.
ALTER TABLE settlement_items ADD COLUMN IF NOT EXISTS player_display_name varchar(200);
ALTER TABLE settlement_items ADD COLUMN IF NOT EXISTS player_discord_user_id varchar(32);
ALTER TABLE settlement_items ADD COLUMN IF NOT EXISTS external_account_display varchar(200);
UPDATE settlement_items si SET player_display_name=u.display_name
FROM users u WHERE u.id=si.player_user_id AND si.player_display_name IS NULL;
UPDATE settlement_items SET external_account_display=regexp_replace(external_account_display, ':\*{3}[^*]{1,4}$', ':***')
WHERE external_account_display ~ ':\*{3}[^*]{1,4}$';
ALTER TABLE settlement_items ALTER COLUMN player_display_name SET NOT NULL;

UPDATE settlement_payment_results
SET note='MIGRATED_LEGACY_PAYMENT_RESULT_REQUIRES_REVIEW'
WHERE length(btrim(COALESCE(external_batch_reference,'')))=0 AND length(btrim(COALESCE(note,'')))=0;
ALTER TABLE settlement_payment_results DROP CONSTRAINT IF EXISTS settlement_payment_results_evidence_chk;
ALTER TABLE settlement_payment_results ADD CONSTRAINT settlement_payment_results_evidence_chk CHECK (
  length(btrim(COALESCE(external_batch_reference,''))) > 0
  OR length(btrim(COALESCE(note,''))) > 0
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM settlement_payment_results WHERE result='SUCCEEDED'
    GROUP BY settlement_item_id HAVING count(*)>1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS settlement_payment_results_one_success_idx
    ON settlement_payment_results(settlement_item_id) WHERE result='SUCCEEDED';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_settlement_payment_result()
RETURNS trigger AS $$
DECLARE item_net bigint; item_currency char(3); item_status "SettlementItemPaymentStatus"; batch_status "SettlementBatchStatus";
BEGIN
  SELECT si.net_amount_minor,si.currency,si.payment_status,sb.status
  INTO item_net,item_currency,item_status,batch_status
  FROM settlement_items si JOIN settlement_batches sb ON sb.id=si.settlement_batch_id
  WHERE si.id=NEW.settlement_item_id FOR UPDATE OF si,sb;
  IF item_currency IS NULL OR batch_status NOT IN ('APPROVED','EXPORTED','PARTIALLY_PAID') THEN
    RAISE EXCEPTION 'settlement payment result requires an approved active batch';
  END IF;
  IF NEW.currency<>item_currency THEN RAISE EXCEPTION 'settlement payment result currency must match item'; END IF;
  IF EXISTS (SELECT 1 FROM settlement_payment_results
    WHERE settlement_item_id=NEW.settlement_item_id AND result='SUCCEEDED') THEN
    RAISE EXCEPTION 'successful settlement item cannot receive another result';
  END IF;
  IF item_status='SUCCEEDED' THEN RAISE EXCEPTION 'successful settlement item cannot receive another result'; END IF;
  IF NEW.result='SUCCEEDED' AND NEW.amount_minor<>item_net THEN
    RAISE EXCEPTION 'successful settlement payment amount must equal whole item net amount';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_settlement_payment_result_guard ON settlement_payment_results;
CREATE TRIGGER trg_settlement_payment_result_guard BEFORE INSERT ON settlement_payment_results
FOR EACH ROW EXECUTE FUNCTION enforce_settlement_payment_result();

CREATE OR REPLACE FUNCTION project_settlement_payment_result()
RETURNS trigger AS $$
BEGIN
  UPDATE settlement_items SET payment_status=NEW.result::text::"SettlementItemPaymentStatus",
    external_batch_reference=NEW.external_batch_reference,payment_note=NEW.note,
    payment_recorded_by_staff_id=NEW.recorded_by_staff_id,payment_recorded_at=NEW.recorded_at,
    row_version=row_version+1,updated_at=NEW.recorded_at
  WHERE id=NEW.settlement_item_id AND payment_status<>'SUCCEEDED';
  IF NOT FOUND THEN RAISE EXCEPTION 'settlement payment result projection conflict'; END IF;
  IF NEW.result='SUCCEEDED' THEN
    UPDATE player_earnings pe SET status='PAID',paid_at=NEW.recorded_at,row_version=row_version+1,updated_at=NEW.recorded_at
    WHERE pe.id IN (SELECT player_earning_id FROM settlement_item_entries
      WHERE settlement_item_id=NEW.settlement_item_id AND player_earning_id IS NOT NULL) AND pe.status='CONFIRMED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_settlement_payment_result_projection ON settlement_payment_results;
CREATE TRIGGER trg_settlement_payment_result_projection AFTER INSERT ON settlement_payment_results
FOR EACH ROW EXECUTE FUNCTION project_settlement_payment_result();

CREATE OR REPLACE FUNCTION enforce_settlement_item_snapshot_immutable()
RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.settlement_batch_id,NEW.player_user_id,NEW.player_display_name,NEW.player_discord_user_id,
      NEW.external_account_display,NEW.gross_amount_minor,NEW.adjustment_amount_minor,NEW.net_amount_minor,NEW.currency,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.settlement_batch_id,OLD.player_user_id,OLD.player_display_name,OLD.player_discord_user_id,
      OLD.external_account_display,OLD.gross_amount_minor,OLD.adjustment_amount_minor,OLD.net_amount_minor,OLD.currency,OLD.created_at) THEN
    RAISE EXCEPTION 'settlement item snapshot fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE UPDATE (player_display_name,player_discord_user_id,external_account_display) ON settlement_items FROM blackcat_app;
