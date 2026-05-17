CREATE TYPE "SettlementBatchStatus" AS ENUM ('DRAFT','PENDING_REVIEW','APPROVED','EXPORTED','PARTIALLY_PAID','PAID','VOIDED');
CREATE TYPE "SettlementBatchSource" AS ENUM ('SCHEDULED','MANUAL');
CREATE TYPE "SettlementItemPaymentStatus" AS ENUM ('PENDING','SUCCEEDED','FAILED');
CREATE TYPE "SettlementPaymentResultStatus" AS ENUM ('SUCCEEDED','FAILED');
CREATE TYPE "SettlementEntryType" AS ENUM ('PLAYER_EARNING','EARNING_ADJUSTMENT');

CREATE TABLE settlement_batches (
  id uuid PRIMARY KEY,
  public_id varchar(30) NOT NULL UNIQUE,
  source "SettlementBatchSource" NOT NULL,
  schedule_key varchar(120),
  period_start timestamptz(3) NOT NULL,
  period_end timestamptz(3) NOT NULL,
  cutoff_at timestamptz(3) NOT NULL,
  time_zone varchar(80) NOT NULL,
  currency char(3) NOT NULL,
  gross_amount_minor bigint NOT NULL,
  adjustment_amount_minor bigint NOT NULL,
  net_amount_minor bigint NOT NULL,
  status "SettlementBatchStatus" NOT NULL DEFAULT 'DRAFT',
  row_version integer NOT NULL DEFAULT 1,
  created_by_staff_id uuid,
  submitted_by_staff_id uuid,
  approved_by_staff_id uuid,
  voided_by_staff_id uuid,
  submitted_at timestamptz(3),
  approved_at timestamptz(3),
  exported_at timestamptz(3),
  voided_at timestamptz(3),
  void_reason varchar(1000),
  replacement_batch_id uuid UNIQUE,
  snapshot_finalized_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL,
  CONSTRAINT settlement_batches_period_chk CHECK (period_start < period_end),
  CONSTRAINT settlement_batches_cutoff_chk CHECK (cutoff_at >= period_end),
  CONSTRAINT settlement_batches_currency_chk CHECK (currency = 'CNY'),
  CONSTRAINT settlement_batches_amounts_chk CHECK (
    gross_amount_minor >= 0
    AND net_amount_minor >= 0
    AND net_amount_minor = gross_amount_minor + adjustment_amount_minor
  ),
  CONSTRAINT settlement_batches_schedule_source_chk CHECK (
    (source = 'SCHEDULED' AND schedule_key IS NOT NULL AND length(btrim(schedule_key)) > 0)
    OR (source = 'MANUAL' AND schedule_key IS NULL)
  ),
  CONSTRAINT settlement_batches_void_fields_chk CHECK (
    (status = 'VOIDED' AND voided_at IS NOT NULL AND void_reason IS NOT NULL)
    OR (status <> 'VOIDED' AND voided_at IS NULL AND void_reason IS NULL AND voided_by_staff_id IS NULL)
  ),
  CONSTRAINT settlement_batches_replacement_not_self_chk CHECK (replacement_batch_id IS NULL OR replacement_batch_id <> id),
  CONSTRAINT settlement_batches_created_by_staff_id_fkey FOREIGN KEY (created_by_staff_id) REFERENCES staff_accounts(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT settlement_batches_submitted_by_staff_id_fkey FOREIGN KEY (submitted_by_staff_id) REFERENCES staff_accounts(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT settlement_batches_approved_by_staff_id_fkey FOREIGN KEY (approved_by_staff_id) REFERENCES staff_accounts(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT settlement_batches_voided_by_staff_id_fkey FOREIGN KEY (voided_by_staff_id) REFERENCES staff_accounts(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT settlement_batches_replacement_batch_id_fkey FOREIGN KEY (replacement_batch_id) REFERENCES settlement_batches(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE (schedule_key,period_start,period_end,currency)
);

CREATE INDEX settlement_batches_status_period_end_idx ON settlement_batches(status,period_end);
CREATE INDEX settlement_batches_currency_period_idx ON settlement_batches(currency,period_start,period_end);

CREATE TABLE settlement_items (
  id uuid PRIMARY KEY,
  settlement_batch_id uuid NOT NULL,
  player_user_id uuid NOT NULL,
  gross_amount_minor bigint NOT NULL,
  adjustment_amount_minor bigint NOT NULL,
  net_amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  payment_status "SettlementItemPaymentStatus" NOT NULL DEFAULT 'PENDING',
  external_batch_reference varchar(255),
  payment_note varchar(1000),
  payment_recorded_by_staff_id uuid,
  payment_recorded_at timestamptz(3),
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL,
  CONSTRAINT settlement_items_batch_fkey FOREIGN KEY (settlement_batch_id) REFERENCES settlement_batches(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT settlement_items_player_fkey FOREIGN KEY (player_user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT settlement_items_payment_staff_fkey FOREIGN KEY (payment_recorded_by_staff_id) REFERENCES staff_accounts(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT settlement_items_currency_chk CHECK (currency = 'CNY'),
  CONSTRAINT settlement_items_amounts_chk CHECK (
    gross_amount_minor >= 0
    AND net_amount_minor >= 0
    AND net_amount_minor = gross_amount_minor + adjustment_amount_minor
  ),
  UNIQUE (settlement_batch_id,player_user_id)
);

CREATE INDEX settlement_items_player_payment_created_idx ON settlement_items(player_user_id,payment_status,created_at);

CREATE TABLE settlement_payment_results (
  id uuid PRIMARY KEY,
  settlement_item_id uuid NOT NULL,
  result "SettlementPaymentResultStatus" NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  external_batch_reference varchar(255),
  note varchar(1000),
  idempotency_key varchar(200) NOT NULL UNIQUE,
  recorded_by_staff_id uuid NOT NULL,
  recorded_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT settlement_payment_results_item_fkey FOREIGN KEY (settlement_item_id) REFERENCES settlement_items(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT settlement_payment_results_staff_fkey FOREIGN KEY (recorded_by_staff_id) REFERENCES staff_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT settlement_payment_results_currency_chk CHECK (currency = 'CNY'),
  CONSTRAINT settlement_payment_results_amount_chk CHECK (amount_minor >= 0)
);

CREATE INDEX settlement_payment_results_item_recorded_idx ON settlement_payment_results(settlement_item_id,recorded_at);

CREATE TABLE settlement_item_entries (
  id uuid PRIMARY KEY,
  settlement_item_id uuid NOT NULL,
  entry_type "SettlementEntryType" NOT NULL,
  player_earning_id uuid,
  player_earning_adjustment_id uuid,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  occurred_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT settlement_item_entries_item_fkey FOREIGN KEY (settlement_item_id) REFERENCES settlement_items(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT settlement_item_entries_earning_fkey FOREIGN KEY (player_earning_id) REFERENCES player_earnings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT settlement_item_entries_adjustment_fkey FOREIGN KEY (player_earning_adjustment_id) REFERENCES player_earning_adjustments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT settlement_item_entries_currency_chk CHECK (currency = 'CNY'),
  CONSTRAINT settlement_item_entries_source_chk CHECK (
    (entry_type = 'PLAYER_EARNING' AND player_earning_id IS NOT NULL AND player_earning_adjustment_id IS NULL AND amount_minor >= 0)
    OR (entry_type = 'EARNING_ADJUSTMENT' AND player_earning_id IS NULL AND player_earning_adjustment_id IS NOT NULL)
  )
);

CREATE INDEX settlement_item_entries_item_occurred_idx ON settlement_item_entries(settlement_item_id,occurred_at);
CREATE INDEX settlement_item_entries_earning_idx ON settlement_item_entries(player_earning_id);
CREATE INDEX settlement_item_entries_adjustment_idx ON settlement_item_entries(player_earning_adjustment_id);

CREATE OR REPLACE FUNCTION enforce_settlement_item_consistency()
RETURNS trigger AS $$
DECLARE
  batch_currency char(3);
  batch_status "SettlementBatchStatus";
  finalized_at timestamptz;
BEGIN
  SELECT currency,status,snapshot_finalized_at INTO batch_currency,batch_status,finalized_at
  FROM settlement_batches WHERE id=NEW.settlement_batch_id FOR UPDATE;
  IF batch_currency IS NULL THEN
    RAISE EXCEPTION 'settlement item batch does not exist';
  END IF;
  IF NEW.currency <> batch_currency THEN
    RAISE EXCEPTION 'settlement item currency must match batch currency';
  END IF;
  IF TG_OP='INSERT' AND (batch_status <> 'DRAFT' OR finalized_at IS NOT NULL) THEN
    RAISE EXCEPTION 'settlement item cannot be added to a finalized snapshot';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_settlement_item_consistency
BEFORE INSERT OR UPDATE ON settlement_items
FOR EACH ROW EXECUTE FUNCTION enforce_settlement_item_consistency();

CREATE OR REPLACE FUNCTION enforce_settlement_item_snapshot_immutable()
RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.settlement_batch_id,NEW.player_user_id,NEW.gross_amount_minor,NEW.adjustment_amount_minor,
      NEW.net_amount_minor,NEW.currency,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.settlement_batch_id,OLD.player_user_id,OLD.gross_amount_minor,OLD.adjustment_amount_minor,
      OLD.net_amount_minor,OLD.currency,OLD.created_at) THEN
    RAISE EXCEPTION 'settlement item currency and amount snapshot fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_settlement_item_snapshot_immutable
BEFORE UPDATE ON settlement_items
FOR EACH ROW EXECUTE FUNCTION enforce_settlement_item_snapshot_immutable();

CREATE OR REPLACE FUNCTION enforce_settlement_batch_snapshot_immutable()
RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.public_id,NEW.source,NEW.schedule_key,NEW.period_start,NEW.period_end,NEW.cutoff_at,NEW.time_zone,NEW.currency,
      NEW.gross_amount_minor,NEW.adjustment_amount_minor,NEW.net_amount_minor,NEW.created_by_staff_id,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.public_id,OLD.source,OLD.schedule_key,OLD.period_start,OLD.period_end,OLD.cutoff_at,OLD.time_zone,OLD.currency,
      OLD.gross_amount_minor,OLD.adjustment_amount_minor,OLD.net_amount_minor,OLD.created_by_staff_id,OLD.created_at) THEN
    RAISE EXCEPTION 'settlement batch identity and amount snapshot fields are immutable';
  END IF;
  IF OLD.snapshot_finalized_at IS NOT NULL AND NEW.snapshot_finalized_at IS DISTINCT FROM OLD.snapshot_finalized_at THEN
    RAISE EXCEPTION 'settlement snapshot finalization is immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status='DRAFT' AND NEW.status IN ('PENDING_REVIEW','VOIDED')) OR
    (OLD.status='PENDING_REVIEW' AND NEW.status IN ('APPROVED','VOIDED')) OR
    (OLD.status='APPROVED' AND NEW.status IN ('EXPORTED','VOIDED')) OR
    (OLD.status='EXPORTED' AND NEW.status IN ('PARTIALLY_PAID','PAID','VOIDED')) OR
    (OLD.status='PARTIALLY_PAID' AND NEW.status IN ('PARTIALLY_PAID','PAID','VOIDED'))
  ) THEN
    RAISE EXCEPTION 'invalid settlement status transition from % to %',OLD.status,NEW.status;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.snapshot_finalized_at IS NULL THEN
    RAISE EXCEPTION 'settlement snapshot must be finalized before status transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_settlement_batch_snapshot_immutable
BEFORE UPDATE ON settlement_batches
FOR EACH ROW EXECUTE FUNCTION enforce_settlement_batch_snapshot_immutable();

CREATE OR REPLACE FUNCTION enforce_settlement_entry_membership()
RETURNS trigger AS $$
DECLARE
  source_id uuid;
  source_currency char(3);
  source_amount bigint;
  source_type "EarningAdjustmentType";
  item_currency char(3);
  item_player_user_id uuid;
  parent_status "SettlementBatchStatus";
  parent_cutoff_at timestamptz;
  finalized_at timestamptz;
  source_player_user_id uuid;
  source_status "PlayerEarningStatus";
  source_occurred_at timestamptz;
BEGIN
  source_id := COALESCE(NEW.player_earning_id,NEW.player_earning_adjustment_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(source_id::text,0));

  SELECT si.currency,si.player_user_id,sb.status,sb.cutoff_at,sb.snapshot_finalized_at
  INTO item_currency,item_player_user_id,parent_status,parent_cutoff_at,finalized_at
  FROM settlement_items si JOIN settlement_batches sb ON sb.id=si.settlement_batch_id
  WHERE si.id=NEW.settlement_item_id FOR UPDATE OF si,sb;
  IF item_currency IS NULL OR parent_status<>'DRAFT' OR finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'settlement entry cannot modify a finalized or inactive snapshot';
  END IF;
  IF NEW.currency <> item_currency THEN
    RAISE EXCEPTION 'settlement entry currency must match item and batch currency';
  END IF;

  IF NEW.entry_type='PLAYER_EARNING' THEN
    SELECT currency,amount_minor,player_user_id,status,confirmed_at
    INTO source_currency,source_amount,source_player_user_id,source_status,source_occurred_at
    FROM player_earnings WHERE id=NEW.player_earning_id FOR UPDATE;
    IF source_status <> 'CONFIRMED' OR source_occurred_at IS NULL THEN
      RAISE EXCEPTION 'settlement earning source must be confirmed';
    END IF;
  ELSE
    SELECT pea.currency,pea.amount_minor,pea.type,pe.player_user_id,pea.created_at
    INTO source_currency,source_amount,source_type,source_player_user_id,source_occurred_at
    FROM player_earning_adjustments pea JOIN player_earnings pe ON pe.id=pea.player_earning_id
    WHERE pea.id=NEW.player_earning_adjustment_id FOR UPDATE OF pea,pe;
    IF source_type <> 'CORRECTION_CREDIT' THEN source_amount := -source_amount; END IF;
  END IF;
  IF source_player_user_id IS DISTINCT FROM item_player_user_id THEN
    RAISE EXCEPTION 'settlement source player must match settlement item player';
  END IF;
  IF source_occurred_at > parent_cutoff_at THEN
    RAISE EXCEPTION 'settlement source occurred after batch cutoff';
  END IF;
  IF NEW.occurred_at IS DISTINCT FROM source_occurred_at THEN
    RAISE EXCEPTION 'settlement entry occurrence must match source occurrence';
  END IF;
  IF source_currency IS NULL OR source_currency <> NEW.currency OR source_amount <> NEW.amount_minor THEN
    RAISE EXCEPTION 'settlement entry must preserve source amount and currency snapshot';
  END IF;

  IF EXISTS (
    SELECT 1 FROM settlement_item_entries existing
    JOIN settlement_items existing_item ON existing_item.id=existing.settlement_item_id
    JOIN settlement_batches existing_batch ON existing_batch.id=existing_item.settlement_batch_id
    WHERE existing.id<>NEW.id AND existing_batch.status<>'VOIDED'
      AND ((NEW.player_earning_id IS NOT NULL AND existing.player_earning_id=NEW.player_earning_id)
        OR (NEW.player_earning_adjustment_id IS NOT NULL AND existing.player_earning_adjustment_id=NEW.player_earning_adjustment_id))
  ) THEN
    RAISE EXCEPTION 'settlement source already belongs to an active settlement batch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_settlement_entry_membership
BEFORE INSERT ON settlement_item_entries
FOR EACH ROW EXECUTE FUNCTION enforce_settlement_entry_membership();

CREATE OR REPLACE FUNCTION enforce_settlement_replacement()
RETURNS trigger AS $$
DECLARE
  replacement_currency char(3);
BEGIN
  IF OLD.replacement_batch_id IS NOT NULL AND NEW.replacement_batch_id IS DISTINCT FROM OLD.replacement_batch_id THEN
    RAISE EXCEPTION 'settlement replacement relationship is immutable';
  END IF;
  IF NEW.replacement_batch_id IS NOT NULL AND NEW.replacement_batch_id IS DISTINCT FROM OLD.replacement_batch_id THEN
    IF NEW.status <> 'VOIDED' THEN
      RAISE EXCEPTION 'only a voided settlement batch can have a replacement';
    END IF;
    SELECT currency INTO replacement_currency FROM settlement_batches WHERE id=NEW.replacement_batch_id;
    IF replacement_currency IS NULL OR replacement_currency <> NEW.currency THEN
      RAISE EXCEPTION 'replacement settlement batch must exist and use the same currency';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_settlement_replacement
BEFORE UPDATE ON settlement_batches
FOR EACH ROW EXECUTE FUNCTION enforce_settlement_replacement();

CREATE OR REPLACE FUNCTION validate_settlement_snapshot(target_batch_id uuid)
RETURNS void AS $$
DECLARE
  batch_row settlement_batches%ROWTYPE;
  item_row settlement_items%ROWTYPE;
  item_gross bigint;
  item_adjustment bigint;
  batch_gross bigint;
  batch_adjustment bigint;
  batch_net bigint;
BEGIN
  SELECT * INTO batch_row FROM settlement_batches WHERE id=target_batch_id FOR UPDATE;
  FOR item_row IN SELECT * FROM settlement_items WHERE settlement_batch_id=target_batch_id LOOP
    SELECT
      COALESCE(sum(amount_minor) FILTER (WHERE entry_type='PLAYER_EARNING'),0),
      COALESCE(sum(amount_minor) FILTER (WHERE entry_type='EARNING_ADJUSTMENT'),0)
    INTO item_gross,item_adjustment
    FROM settlement_item_entries WHERE settlement_item_id=item_row.id;
    IF item_row.gross_amount_minor<>item_gross
      OR item_row.adjustment_amount_minor<>item_adjustment
      OR item_row.net_amount_minor<>item_gross+item_adjustment THEN
      RAISE EXCEPTION 'settlement item totals do not match entry snapshot';
    END IF;
  END LOOP;
  SELECT COALESCE(sum(gross_amount_minor),0),COALESCE(sum(adjustment_amount_minor),0),COALESCE(sum(net_amount_minor),0)
  INTO batch_gross,batch_adjustment,batch_net
  FROM settlement_items WHERE settlement_batch_id=target_batch_id;
  IF batch_row.gross_amount_minor<>batch_gross
    OR batch_row.adjustment_amount_minor<>batch_adjustment
    OR batch_row.net_amount_minor<>batch_net THEN
    RAISE EXCEPTION 'settlement batch totals do not match item snapshot';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION finalize_settlement_snapshot()
RETURNS trigger AS $$
BEGIN
  IF OLD.snapshot_finalized_at IS NULL AND NEW.snapshot_finalized_at IS NOT NULL THEN
    PERFORM validate_settlement_snapshot(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_finalize_settlement_snapshot
BEFORE UPDATE OF snapshot_finalized_at ON settlement_batches
FOR EACH ROW EXECUTE FUNCTION finalize_settlement_snapshot();

CREATE OR REPLACE FUNCTION deny_settlement_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'settlement record % cannot be deleted',TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_settlement_entries_append_only
BEFORE UPDATE OR DELETE ON settlement_item_entries
FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();
CREATE TRIGGER trg_settlement_payment_results_append_only
BEFORE UPDATE OR DELETE ON settlement_payment_results
FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();
CREATE TRIGGER trg_settlement_items_no_delete
BEFORE DELETE ON settlement_items
FOR EACH ROW EXECUTE FUNCTION deny_settlement_delete();
CREATE TRIGGER trg_settlement_batches_no_delete
BEFORE DELETE ON settlement_batches
FOR EACH ROW EXECUTE FUNCTION deny_settlement_delete();

GRANT SELECT,INSERT,UPDATE,DELETE ON settlement_batches,settlement_items,settlement_payment_results,settlement_item_entries TO blackcat_app;
REVOKE DELETE ON settlement_batches,settlement_items,settlement_payment_results,settlement_item_entries FROM blackcat_app;
REVOKE UPDATE ON settlement_item_entries,settlement_payment_results FROM blackcat_app;
REVOKE UPDATE (public_id,source,schedule_key,period_start,period_end,cutoff_at,time_zone,currency,gross_amount_minor,
  adjustment_amount_minor,net_amount_minor,created_by_staff_id,created_at) ON settlement_batches FROM blackcat_app;
REVOKE UPDATE (settlement_batch_id,player_user_id,gross_amount_minor,adjustment_amount_minor,
  net_amount_minor,currency,created_at) ON settlement_items FROM blackcat_app;
