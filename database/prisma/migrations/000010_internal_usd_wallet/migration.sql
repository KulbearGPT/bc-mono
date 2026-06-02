-- M7-US-02: immutable internal USD wallet, receipt evidence, and per-object audit changes.

ALTER TYPE "FundReservationMode"
  RENAME VALUE 'LOCAL_RESERVATION_FALLBACK' TO 'LOCAL_RESERVATION';
ALTER TABLE provider_balance_snapshots
  RENAME COLUMN provider_balance_minor TO observed_balance_minor;

ALTER TABLE settlement_batches DROP CONSTRAINT settlement_batches_currency_chk;
ALTER TABLE settlement_items DROP CONSTRAINT settlement_items_currency_chk;
ALTER TABLE settlement_payment_results DROP CONSTRAINT settlement_payment_results_currency_chk;
ALTER TABLE settlement_item_entries DROP CONSTRAINT settlement_item_entries_currency_chk;
ALTER TABLE player_weekly_reports DROP CONSTRAINT player_weekly_reports_currency_chk;
ALTER TABLE weekly_report_summaries DROP CONSTRAINT weekly_report_summaries_currency_chk;

DO $$
DECLARE
  money_table RECORD;
BEGIN
  FOR money_table IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'currency'
      AND table_name NOT LIKE 'sandbox_provider_%'
  LOOP
    EXECUTE format('UPDATE %I SET currency = ''USD'' WHERE currency IS NOT NULL AND currency <> ''USD''', money_table.table_name);
  END LOOP;
END $$;

ALTER TABLE settlement_batches ADD CONSTRAINT settlement_batches_currency_chk CHECK (currency = 'USD');
ALTER TABLE settlement_items ADD CONSTRAINT settlement_items_currency_chk CHECK (currency = 'USD');
ALTER TABLE settlement_payment_results ADD CONSTRAINT settlement_payment_results_currency_chk CHECK (currency = 'USD');
ALTER TABLE settlement_item_entries ADD CONSTRAINT settlement_item_entries_currency_chk CHECK (currency = 'USD');
ALTER TABLE player_weekly_reports ADD CONSTRAINT player_weekly_reports_currency_chk CHECK (currency = 'USD');
ALTER TABLE weekly_report_summaries ADD CONSTRAINT weekly_report_summaries_currency_chk CHECK (currency = 'USD');

CREATE TYPE "WalletAccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE "WalletEntryDirection" AS ENUM ('CREDIT', 'DEBIT');
CREATE TYPE "WalletEntryType" AS ENUM (
  'TOP_UP_CREDIT',
  'ORDER_CAPTURE_DEBIT',
  'GIFT_CAPTURE_DEBIT',
  'ORDER_REFUND_CREDIT',
  'EXTERNAL_REFUND_DEBIT',
  'ADJUSTMENT_CREDIT',
  'ADJUSTMENT_DEBIT'
);
CREATE TYPE "AuditChangeType" AS ENUM (
  'CREATE',
  'UPDATE',
  'APPEND',
  'STATE_TRANSITION',
  'INVALIDATE'
);

ALTER TABLE audit_logs
  ADD COLUMN idempotency_key VARCHAR(200),
  ADD COLUMN job_id UUID,
  ADD COLUMN trigger_source VARCHAR(100),
  ADD COLUMN retry_attempt INTEGER,
  ADD CONSTRAINT audit_logs_retry_attempt_non_negative_chk
    CHECK (retry_attempt IS NULL OR retry_attempt >= 0);

CREATE TABLE "wallet_accounts" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'USD',
  "status" "WalletAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "row_version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "wallet_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallet_accounts_currency_usd_chk" CHECK ("currency" = 'USD'),
  CONSTRAINT "wallet_accounts_row_version_positive_chk" CHECK ("row_version" > 0),
  CONSTRAINT "wallet_accounts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "wallet_entries" (
  "id" UUID NOT NULL,
  "wallet_account_id" UUID NOT NULL,
  "entry_type" "WalletEntryType" NOT NULL,
  "direction" "WalletEntryDirection" NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'USD',
  "source_type" VARCHAR(50) NOT NULL,
  "source_id" UUID NOT NULL,
  "reversal_of_entry_id" UUID,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallet_entries_amount_positive_chk" CHECK ("amount_minor" > 0),
  CONSTRAINT "wallet_entries_currency_usd_chk" CHECK ("currency" = 'USD'),
  CONSTRAINT "wallet_entries_type_direction_chk" CHECK (
    ("entry_type" IN ('TOP_UP_CREDIT', 'ORDER_REFUND_CREDIT', 'ADJUSTMENT_CREDIT')
      AND "direction" = 'CREDIT')
    OR
    ("entry_type" IN (
      'ORDER_CAPTURE_DEBIT', 'GIFT_CAPTURE_DEBIT', 'EXTERNAL_REFUND_DEBIT', 'ADJUSTMENT_DEBIT'
    ) AND "direction" = 'DEBIT')
  ),
  CONSTRAINT "wallet_entries_wallet_account_id_fkey"
    FOREIGN KEY ("wallet_account_id") REFERENCES "wallet_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wallet_entries_reversal_of_entry_id_fkey"
    FOREIGN KEY ("reversal_of_entry_id") REFERENCES "wallet_entries"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "top_ups" (
  "id" UUID NOT NULL,
  "wallet_account_id" UUID NOT NULL,
  "wallet_entry_id" UUID NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'USD',
  "payment_channel" VARCHAR(50) NOT NULL,
  "external_transaction_id" VARCHAR(200) NOT NULL,
  "paid_at" TIMESTAMPTZ(3) NOT NULL,
  "note" VARCHAR(1000) NOT NULL,
  "created_by_staff_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "top_ups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "top_ups_amount_positive_chk" CHECK ("amount_minor" > 0),
  CONSTRAINT "top_ups_currency_usd_chk" CHECK ("currency" = 'USD'),
  CONSTRAINT "top_ups_channel_nonempty_chk" CHECK (length(btrim("payment_channel")) > 0),
  CONSTRAINT "top_ups_external_transaction_nonempty_chk"
    CHECK (length(btrim("external_transaction_id")) > 0),
  CONSTRAINT "top_ups_note_nonempty_chk" CHECK (length(btrim("note")) > 0),
  CONSTRAINT "top_ups_wallet_account_id_fkey"
    FOREIGN KEY ("wallet_account_id") REFERENCES "wallet_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "top_ups_wallet_entry_id_fkey"
    FOREIGN KEY ("wallet_entry_id") REFERENCES "wallet_entries"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "top_ups_created_by_staff_id_fkey"
    FOREIGN KEY ("created_by_staff_id") REFERENCES "staff_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "external_refund_debits" (
  "id" UUID NOT NULL,
  "wallet_account_id" UUID NOT NULL,
  "wallet_entry_id" UUID NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'USD',
  "payment_channel" VARCHAR(50) NOT NULL,
  "external_transaction_id" VARCHAR(200) NOT NULL,
  "refunded_at" TIMESTAMPTZ(3) NOT NULL,
  "note" VARCHAR(1000) NOT NULL,
  "created_by_staff_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "external_refund_debits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_refund_debits_amount_positive_chk" CHECK ("amount_minor" > 0),
  CONSTRAINT "external_refund_debits_currency_usd_chk" CHECK ("currency" = 'USD'),
  CONSTRAINT "external_refund_debits_channel_nonempty_chk"
    CHECK (length(btrim("payment_channel")) > 0),
  CONSTRAINT "external_refund_debits_external_transaction_nonempty_chk"
    CHECK (length(btrim("external_transaction_id")) > 0),
  CONSTRAINT "external_refund_debits_note_nonempty_chk" CHECK (length(btrim("note")) > 0),
  CONSTRAINT "external_refund_debits_wallet_account_id_fkey"
    FOREIGN KEY ("wallet_account_id") REFERENCES "wallet_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "external_refund_debits_wallet_entry_id_fkey"
    FOREIGN KEY ("wallet_entry_id") REFERENCES "wallet_entries"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "external_refund_debits_created_by_staff_id_fkey"
    FOREIGN KEY ("created_by_staff_id") REFERENCES "staff_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "receipt_attachments" (
  "id" UUID NOT NULL,
  "wallet_account_id" UUID NOT NULL,
  "top_up_id" UUID,
  "external_refund_debit_id" UUID,
  "media_type" VARCHAR(100) NOT NULL,
  "original_file_name" VARCHAR(255) NOT NULL,
  "byte_size" BIGINT NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "storage_key" VARCHAR(255) NOT NULL,
  "uploaded_by_staff_id" UUID NOT NULL,
  "invalidated_at" TIMESTAMPTZ(3),
  "invalidated_by_staff_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "receipt_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "receipt_attachments_one_parent_chk" CHECK (
    num_nonnulls("top_up_id", "external_refund_debit_id") = 1
  ),
  CONSTRAINT "receipt_attachments_byte_size_positive_chk" CHECK ("byte_size" > 0),
  CONSTRAINT "receipt_attachments_media_type_chk" CHECK (
    "media_type" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
  ),
  CONSTRAINT "receipt_attachments_sha256_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "receipt_attachments_invalidation_pair_chk" CHECK (
    ("invalidated_at" IS NULL AND "invalidated_by_staff_id" IS NULL)
    OR ("invalidated_at" IS NOT NULL AND "invalidated_by_staff_id" IS NOT NULL)
  ),
  CONSTRAINT "receipt_attachments_wallet_account_id_fkey"
    FOREIGN KEY ("wallet_account_id") REFERENCES "wallet_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "receipt_attachments_top_up_id_fkey"
    FOREIGN KEY ("top_up_id") REFERENCES "top_ups"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "receipt_attachments_external_refund_debit_id_fkey"
    FOREIGN KEY ("external_refund_debit_id") REFERENCES "external_refund_debits"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "receipt_attachments_uploaded_by_staff_id_fkey"
    FOREIGN KEY ("uploaded_by_staff_id") REFERENCES "staff_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "receipt_attachments_invalidated_by_staff_id_fkey"
    FOREIGN KEY ("invalidated_by_staff_id") REFERENCES "staff_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "audit_log_changes" (
  "id" UUID NOT NULL,
  "audit_log_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "target_type" VARCHAR(80) NOT NULL,
  "target_id" VARCHAR(100) NOT NULL,
  "change_type" "AuditChangeType" NOT NULL,
  "before_snapshot" JSONB,
  "after_snapshot" JSONB,
  "changed_fields" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_log_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_log_changes_sequence_positive_chk" CHECK ("sequence" > 0),
  CONSTRAINT "audit_log_changes_fields_array_chk"
    CHECK (jsonb_typeof("changed_fields") = 'array'),
  CONSTRAINT "audit_log_changes_audit_log_id_fkey"
    FOREIGN KEY ("audit_log_id") REFERENCES "audit_logs"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "wallet_accounts_user_id_key" ON "wallet_accounts"("user_id");
CREATE INDEX "wallet_accounts_status_idx" ON "wallet_accounts"("status");
CREATE UNIQUE INDEX "wallet_entries_idempotency_key_key" ON "wallet_entries"("idempotency_key");
CREATE UNIQUE INDEX "wallet_entries_source_type_source_id_entry_type_key"
  ON "wallet_entries"("source_type", "source_id", "entry_type");
CREATE INDEX "wallet_entries_wallet_account_id_occurred_at_idx"
  ON "wallet_entries"("wallet_account_id", "occurred_at");
CREATE INDEX "wallet_entries_reversal_of_entry_id_idx" ON "wallet_entries"("reversal_of_entry_id");
CREATE UNIQUE INDEX "top_ups_wallet_entry_id_key" ON "top_ups"("wallet_entry_id");
CREATE UNIQUE INDEX "top_ups_payment_channel_external_transaction_id_key"
  ON "top_ups"("payment_channel", "external_transaction_id");
CREATE INDEX "top_ups_wallet_account_id_created_at_idx"
  ON "top_ups"("wallet_account_id", "created_at");
CREATE UNIQUE INDEX "external_refund_debits_wallet_entry_id_key"
  ON "external_refund_debits"("wallet_entry_id");
CREATE UNIQUE INDEX "external_refund_debits_payment_channel_external_transaction_id_key"
  ON "external_refund_debits"("payment_channel", "external_transaction_id");
CREATE INDEX "external_refund_debits_wallet_account_id_created_at_idx"
  ON "external_refund_debits"("wallet_account_id", "created_at");
CREATE UNIQUE INDEX "receipt_attachments_storage_key_key" ON "receipt_attachments"("storage_key");
CREATE INDEX "receipt_attachments_wallet_account_id_created_at_idx"
  ON "receipt_attachments"("wallet_account_id", "created_at");
CREATE INDEX "receipt_attachments_top_up_id_idx" ON "receipt_attachments"("top_up_id");
CREATE INDEX "receipt_attachments_external_refund_debit_id_idx"
  ON "receipt_attachments"("external_refund_debit_id");
CREATE UNIQUE INDEX "audit_log_changes_audit_log_id_sequence_key"
  ON "audit_log_changes"("audit_log_id", "sequence");
CREATE INDEX "audit_log_changes_target_type_target_id_created_at_idx"
  ON "audit_log_changes"("target_type", "target_id", "created_at");
CREATE OR REPLACE FUNCTION enforce_wallet_entry_non_negative()
RETURNS trigger AS $$
DECLARE
  current_balance BIGINT;
  account_currency CHAR(3);
BEGIN
  SELECT currency INTO account_currency
  FROM wallet_accounts
  WHERE id = NEW.wallet_account_id
  FOR UPDATE;

  IF account_currency IS NULL THEN
    RAISE EXCEPTION 'wallet account does not exist';
  END IF;
  IF account_currency <> NEW.currency OR NEW.currency <> 'USD' THEN
    RAISE EXCEPTION 'wallet currency must be USD';
  END IF;

  SELECT COALESCE(SUM(
    CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE -amount_minor END
  ), 0)
  INTO current_balance
  FROM wallet_entries
  WHERE wallet_account_id = NEW.wallet_account_id;

  IF NEW.direction = 'DEBIT' AND current_balance < NEW.amount_minor THEN
    RAISE EXCEPTION 'insufficient wallet funds: debit would create negative ledger balance';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_wallet_evidence_entry_match()
RETURNS trigger AS $$
DECLARE
  linked_entry wallet_entries%ROWTYPE;
  expected_type "WalletEntryType";
BEGIN
  SELECT * INTO linked_entry FROM wallet_entries WHERE id = NEW.wallet_entry_id;
  expected_type := CASE TG_TABLE_NAME
    WHEN 'top_ups' THEN 'TOP_UP_CREDIT'::"WalletEntryType"
    ELSE 'EXTERNAL_REFUND_DEBIT'::"WalletEntryType"
  END;
  IF linked_entry.id IS NULL
     OR linked_entry.wallet_account_id <> NEW.wallet_account_id
     OR linked_entry.amount_minor <> NEW.amount_minor
     OR linked_entry.currency <> NEW.currency
     OR linked_entry.entry_type <> expected_type
     OR linked_entry.source_id <> NEW.id THEN
    RAISE EXCEPTION 'wallet evidence does not match linked wallet entry';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_wallet_entry_non_negative
BEFORE INSERT ON wallet_entries
FOR EACH ROW EXECUTE FUNCTION enforce_wallet_entry_non_negative();

CREATE TRIGGER trg_top_up_entry_match
BEFORE INSERT ON top_ups
FOR EACH ROW EXECUTE FUNCTION enforce_wallet_evidence_entry_match();

CREATE TRIGGER trg_external_refund_debit_entry_match
BEFORE INSERT ON external_refund_debits
FOR EACH ROW EXECUTE FUNCTION enforce_wallet_evidence_entry_match();

CREATE TRIGGER trg_wallet_entries_append_only
BEFORE UPDATE OR DELETE ON wallet_entries
FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();

CREATE TRIGGER trg_top_ups_append_only
BEFORE UPDATE OR DELETE ON top_ups
FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();

CREATE TRIGGER trg_external_refund_debits_append_only
BEFORE UPDATE OR DELETE ON external_refund_debits
FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();

CREATE TRIGGER trg_receipt_attachments_append_only
BEFORE UPDATE OR DELETE ON receipt_attachments
FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();

CREATE TRIGGER trg_audit_log_changes_append_only
BEFORE UPDATE OR DELETE ON audit_log_changes
FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();

GRANT SELECT, INSERT, UPDATE, DELETE ON
  wallet_accounts,
  wallet_entries,
  top_ups,
  external_refund_debits,
  receipt_attachments,
  audit_log_changes
TO blackcat_app;

REVOKE UPDATE, DELETE ON
  wallet_entries,
  top_ups,
  external_refund_debits,
  receipt_attachments,
  audit_log_changes
FROM blackcat_app;
