-- M5-US-05: persistent Railway Sandbox funding provider facts.

CREATE TYPE "SandboxProviderAccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "SandboxProviderAdjustmentDirection" AS ENUM ('CREDIT', 'DEBIT');
CREATE TYPE "SandboxProviderTransactionOperation" AS ENUM ('DEBIT', 'REFUND');
CREATE TYPE "SandboxProviderTransactionStatus" AS ENUM ('UNKNOWN', 'PENDING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "sandbox_provider_accounts" (
  "id" UUID NOT NULL,
  "external_user_id" VARCHAR(255) NOT NULL,
  "display_name" VARCHAR(200) NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'CNY',
  "status" "SandboxProviderAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "binding_code_hash" VARCHAR(128),
  "binding_code_consumed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sandbox_provider_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sandbox_provider_account_currency_cny" CHECK ("currency" = 'CNY'),
  CONSTRAINT "sandbox_provider_account_version_positive" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "sandbox_provider_accounts_external_user_id_key" ON "sandbox_provider_accounts"("external_user_id");
CREATE UNIQUE INDEX "sandbox_provider_accounts_binding_code_hash_key" ON "sandbox_provider_accounts"("binding_code_hash");
CREATE INDEX "sandbox_provider_accounts_status_idx" ON "sandbox_provider_accounts"("status");

CREATE TABLE "sandbox_provider_balance_adjustments" (
  "id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "direction" "SandboxProviderAdjustmentDirection" NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "balance_before_minor" BIGINT NOT NULL,
  "balance_after_minor" BIGINT NOT NULL,
  "reason_code" VARCHAR(100) NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "created_by_staff_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sandbox_provider_balance_adjustments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sandbox_adjustment_amount_positive" CHECK ("amount_minor" > 0),
  CONSTRAINT "sandbox_adjustment_balance_nonnegative" CHECK ("balance_before_minor" >= 0 AND "balance_after_minor" >= 0),
  CONSTRAINT "sandbox_adjustment_currency_math" CHECK (
    ("direction" = 'CREDIT' AND "balance_after_minor" = "balance_before_minor" + "amount_minor") OR
    ("direction" = 'DEBIT' AND "balance_after_minor" = "balance_before_minor" - "amount_minor")
  ),
  CONSTRAINT "sandbox_adjustment_account_idempotency_unique" UNIQUE ("account_id", "idempotency_key"),
  CONSTRAINT "sandbox_adjustments_account_fkey" FOREIGN KEY ("account_id") REFERENCES "sandbox_provider_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sandbox_adjustments_staff_fkey" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "sandbox_provider_balance_adjustments_account_id_created_at_idx" ON "sandbox_provider_balance_adjustments"("account_id", "created_at");
CREATE INDEX "sandbox_provider_balance_adjustments_created_by_staff_id_created_at_idx" ON "sandbox_provider_balance_adjustments"("created_by_staff_id", "created_at");

CREATE TABLE "sandbox_provider_transactions" (
  "id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "operation" "SandboxProviderTransactionOperation" NOT NULL,
  "business_source" "FundReservationSourceType" NOT NULL,
  "business_source_id" UUID NOT NULL,
  "business_reference" VARCHAR(255) NOT NULL,
  "fund_reservation_id" UUID,
  "fund_reservation_version" INTEGER,
  "direction" "LedgerDirection" NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'CNY',
  "status" "SandboxProviderTransactionStatus" NOT NULL,
  "provider_reference" VARCHAR(255) NOT NULL,
  "original_provider_reference" VARCHAR(255),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sandbox_provider_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sandbox_transaction_amount_positive" CHECK ("amount_minor" > 0),
  CONSTRAINT "sandbox_transaction_currency_cny" CHECK ("currency" = 'CNY'),
  CONSTRAINT "sandbox_transaction_operation_direction" CHECK (
    ("operation" = 'DEBIT' AND "direction" = 'DEBIT') OR
    ("operation" = 'REFUND' AND "direction" = 'CREDIT')
  ),
  CONSTRAINT "sandbox_transaction_idempotency_unique" UNIQUE ("idempotency_key"),
  CONSTRAINT "sandbox_transactions_account_fkey" FOREIGN KEY ("account_id") REFERENCES "sandbox_provider_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sandbox_transactions_reservation_fkey" FOREIGN KEY ("fund_reservation_id") REFERENCES "fund_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sandbox_transaction_reservation_binding" CHECK (("operation"='DEBIT' AND "fund_reservation_id" IS NOT NULL AND "fund_reservation_version" > 0) OR ("operation"='REFUND' AND "fund_reservation_id" IS NULL AND "fund_reservation_version" IS NULL))
);

CREATE UNIQUE INDEX "sandbox_provider_transactions_provider_reference_key" ON "sandbox_provider_transactions"("provider_reference");
CREATE INDEX "sandbox_provider_transactions_account_id_created_at_idx" ON "sandbox_provider_transactions"("account_id", "created_at");
CREATE INDEX "sandbox_provider_transactions_business_source_business_source_id_idx" ON "sandbox_provider_transactions"("business_source", "business_source_id");
CREATE INDEX "sandbox_provider_transactions_original_provider_reference_idx" ON "sandbox_provider_transactions"("original_provider_reference");

CREATE TRIGGER sandbox_adjustments_append_only
BEFORE UPDATE OR DELETE ON "sandbox_provider_balance_adjustments"
FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();

CREATE TRIGGER sandbox_transactions_append_only
BEFORE UPDATE OR DELETE ON "sandbox_provider_transactions"
FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();
