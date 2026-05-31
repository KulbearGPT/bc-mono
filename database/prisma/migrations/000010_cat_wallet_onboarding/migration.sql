-- M9-US-02: CAT is the canonical platform currency; USD is retained only as receipt evidence.

ALTER TYPE "WalletEntryType" RENAME VALUE 'EXTERNAL_REFUND_DEBIT' TO 'CASH_REFUND_DEBIT';
ALTER TYPE "PlayerReviewStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

-- Existing P0 money facts were test fixtures denominated in the former canonical USD unit.
-- This release is an explicit empty/pilot-data cutover: numeric minor values are preserved and
-- are re-labelled as CAT subunits. Production import requires a separate reconciled runbook.
DO $$
DECLARE item RECORD;
BEGIN
  FOR item IN
    SELECT conrelid::regclass AS relation_name, conname
    FROM pg_constraint
    WHERE contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%currency%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', item.relation_name, item.conname);
  END LOOP;
END $$;

DO $$
DECLARE item RECORD;
BEGIN
  FOR item IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name = 'currency'
  LOOP
    EXECUTE format('UPDATE %I SET currency = ''CAT'' WHERE currency IS NOT NULL', item.table_name);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN currency SET DEFAULT ''CAT''', item.table_name);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (currency = ''CAT'')',
      item.table_name, left(item.table_name || '_currency_cat_chk', 63));
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS trg_top_up_entry_match ON top_ups;

ALTER TABLE top_ups RENAME COLUMN amount_minor TO paid_amount_usd_cents;
ALTER TABLE top_ups RENAME COLUMN currency TO paid_currency;
ALTER TABLE top_ups RENAME COLUMN payment_channel TO payment_method;
ALTER TABLE top_ups RENAME COLUMN external_transaction_id TO receipt_number;
ALTER TABLE top_ups ADD COLUMN rate_cat_per_usd INTEGER NOT NULL DEFAULT 10;
ALTER TABLE top_ups ADD COLUMN credited_cat_subunits BIGINT;
ALTER TABLE top_ups ADD COLUMN reason_code VARCHAR(80) NOT NULL DEFAULT 'MANUAL_TOP_UP';
UPDATE top_ups SET paid_currency = 'USD';
UPDATE top_ups SET credited_cat_subunits = paid_amount_usd_cents;
ALTER TABLE top_ups ALTER COLUMN credited_cat_subunits SET NOT NULL;
ALTER TABLE top_ups ALTER COLUMN paid_currency SET DEFAULT 'USD';
ALTER TABLE top_ups DROP CONSTRAINT IF EXISTS top_ups_payment_channel_external_transaction_id_key;
ALTER INDEX IF EXISTS top_ups_payment_channel_external_transaction_id_key
  RENAME TO top_ups_payment_method_receipt_number_key;
ALTER TABLE top_ups ADD CONSTRAINT top_ups_paid_currency_usd_chk CHECK (paid_currency = 'USD');
ALTER TABLE top_ups ADD CONSTRAINT top_ups_rate_fixed_chk CHECK (rate_cat_per_usd = 10);
ALTER TABLE top_ups ADD CONSTRAINT top_ups_conversion_exact_chk
  CHECK (credited_cat_subunits = paid_amount_usd_cents);
ALTER TABLE top_ups ADD CONSTRAINT top_ups_payment_method_chk
  CHECK (payment_method IN ('ZELLE','PAYPAL','BANK_TRANSFER','CASH','OTHER'));

CREATE OR REPLACE FUNCTION enforce_wallet_entry_non_negative()
RETURNS trigger AS $$
DECLARE current_balance BIGINT; account_currency CHAR(3);
BEGIN
  SELECT currency INTO account_currency FROM wallet_accounts WHERE id = NEW.wallet_account_id FOR UPDATE;
  IF account_currency IS NULL THEN RAISE EXCEPTION 'wallet account does not exist'; END IF;
  IF account_currency <> NEW.currency OR NEW.currency <> 'CAT' THEN
    RAISE EXCEPTION 'wallet currency must be CAT';
  END IF;
  SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount_minor ELSE -amount_minor END),0)
    INTO current_balance FROM wallet_entries WHERE wallet_account_id=NEW.wallet_account_id;
  IF NEW.direction='DEBIT' AND current_balance < NEW.amount_minor THEN
    RAISE EXCEPTION 'insufficient wallet funds: debit would create negative ledger balance';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_wallet_evidence_entry_match()
RETURNS trigger AS $$
DECLARE linked_entry wallet_entries%ROWTYPE;
BEGIN
  SELECT * INTO linked_entry FROM wallet_entries WHERE id=NEW.wallet_entry_id;
  IF TG_TABLE_NAME='top_ups' THEN
    IF linked_entry.id IS NULL OR linked_entry.wallet_account_id<>NEW.wallet_account_id
       OR linked_entry.amount_minor<>NEW.credited_cat_subunits OR linked_entry.currency<>'CAT'
       OR linked_entry.entry_type<>'TOP_UP_CREDIT' OR linked_entry.source_id<>NEW.id THEN
      RAISE EXCEPTION 'top-up evidence does not match CAT wallet entry';
    END IF;
  ELSIF linked_entry.id IS NULL OR linked_entry.wallet_account_id<>NEW.wallet_account_id
       OR linked_entry.amount_minor<>NEW.amount_minor OR linked_entry.currency<>NEW.currency
       OR linked_entry.entry_type<>'CASH_REFUND_DEBIT' OR linked_entry.source_id<>NEW.id THEN
    RAISE EXCEPTION 'cash refund evidence does not match CAT wallet entry';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_top_up_entry_match BEFORE INSERT ON top_ups
FOR EACH ROW EXECUTE FUNCTION enforce_wallet_evidence_entry_match();

ALTER TABLE player_profiles
  ADD COLUMN rejected_at TIMESTAMPTZ(3),
  ADD COLUMN rejection_reason_code VARCHAR(80),
  ADD COLUMN rejection_note VARCHAR(1000);

CREATE TABLE guild_onboarding_messages (
  guild_id VARCHAR(32) PRIMARY KEY,
  channel_id VARCHAR(32) NOT NULL,
  message_id VARCHAR(32),
  rendered_version INTEGER NOT NULL DEFAULT 1,
  last_ensured_at TIMESTAMPTZ(3) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT guild_onboarding_messages_version_chk CHECK (rendered_version > 0),
  CONSTRAINT guild_onboarding_messages_guild_channel_key UNIQUE (guild_id,channel_id)
);

CREATE TABLE companion_review_events (
  id UUID PRIMARY KEY,
  player_profile_id UUID NOT NULL REFERENCES player_profiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  from_status "PlayerReviewStatus",
  to_status "PlayerReviewStatus" NOT NULL,
  actor_staff_id UUID,
  reason_code VARCHAR(80),
  note VARCHAR(1000),
  idempotency_key VARCHAR(200) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX companion_review_events_player_profile_id_created_at_idx
  ON companion_review_events(player_profile_id,created_at);

CREATE TABLE discord_product_role_tasks (
  id UUID PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  discord_user_id VARCHAR(32) NOT NULL,
  role_id VARCHAR(32) NOT NULL,
  action VARCHAR(10) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  dedupe_key VARCHAR(200) NOT NULL UNIQUE,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code VARCHAR(100),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT discord_product_role_tasks_action_chk CHECK (action IN ('ADD','REMOVE')),
  CONSTRAINT discord_product_role_tasks_status_chk CHECK (status IN ('PENDING','APPLIED','FAILED')),
  CONSTRAINT discord_product_role_tasks_attempt_chk CHECK (attempt_count >= 0)
);
CREATE INDEX discord_product_role_tasks_status_created_at_idx ON discord_product_role_tasks(status,created_at);
CREATE INDEX discord_product_role_tasks_guild_id_discord_user_id_idx ON discord_product_role_tasks(guild_id,discord_user_id);

CREATE TRIGGER trg_companion_review_events_append_only BEFORE UPDATE OR DELETE ON companion_review_events
FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();

GRANT SELECT,INSERT,UPDATE,DELETE ON guild_onboarding_messages,companion_review_events,discord_product_role_tasks TO blackcat_app;
REVOKE UPDATE,DELETE ON companion_review_events FROM blackcat_app;
