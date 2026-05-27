#!/usr/bin/env bash
set -euo pipefail

PORT="${BLACKCAT_TEST_PG_PORT:-55432}"
TMP_ROOT="$(mktemp -d /tmp/blackcat-pg-XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
LOG_FILE="$TMP_ROOT/postgres.log"
DB_NAME="blackcat_m0_us_02_verify"

cleanup() {
  pg_ctl -D "$DATA_DIR" stop -m fast >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

initdb -D "$DATA_DIR" --no-locale --encoding=UTF8 >/tmp/blackcat-initdb.out
pg_ctl -D "$DATA_DIR" -o "-p $PORT -k $TMP_ROOT" -l "$LOG_FILE" start >/tmp/blackcat-pgctl-start.out

createdb -h "$TMP_ROOT" -p "$PORT" "$DB_NAME"
first_migration=true
for migration_dir in database/prisma/migrations/*; do
  migration_file="$migration_dir/migration.sql"
  if [ "$first_migration" = true ]; then
    psql -h "$TMP_ROOT" -p "$PORT" -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$migration_file" >/tmp/blackcat-migration-apply.out
    first_migration=false
  else
    psql -h "$TMP_ROOT" -p "$PORT" -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$migration_file" >>/tmp/blackcat-migration-apply.out
  fi
done

psql_db() {
  psql -h "$TMP_ROOT" -p "$PORT" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"
}

expect_sql_failure() {
  local marker="$1"
  local sql="$2"
  if psql_db -qAtc "$sql" >/tmp/blackcat-expected-failure.out 2>/tmp/blackcat-expected-failure.err; then
    echo "expected SQL failure for $marker" >&2
    cat /tmp/blackcat-expected-failure.out >&2
    exit 1
  fi
  echo "$marker"
}

table_count="$(psql_db -Atc "select count(*) from information_schema.tables where table_schema='public'")"
constraint_count="$(psql_db -Atc "select count(*) from pg_constraint where conname in ('referral_attribution_not_self_chk','order_active_customer_slot_status_chk','fund_reservation_amounts_non_negative_chk')")"
trigger_count="$(psql_db -Atc "select count(*) from pg_trigger where tgname in (
  'trg_fund_reservation_event_guard',
  'trg_order_readiness_guard',
  'trg_order_readiness_event_guard',
  'trg_referral_attribution_guard',
  'trg_commission_attribution_guard',
  'trg_external_transaction_reservation_guard',
  'trg_guild_bot_config_event_immutable'
)")"
settlement_table_count="$(psql_db -Atc "select count(*) from information_schema.tables where table_schema='public' and table_name in (
  'settlement_batches','settlement_items','settlement_item_entries','settlement_payment_results'
)")"
settlement_guard_count="$(psql_db -Atc "select count(*) from pg_trigger where tgname in (
  'trg_settlement_item_consistency','trg_settlement_entry_membership','trg_settlement_replacement',
  'trg_settlement_item_snapshot_immutable','trg_settlement_batch_snapshot_immutable',
  'trg_settlement_entries_append_only','trg_settlement_payment_results_append_only',
  'trg_settlement_items_no_delete','trg_settlement_batches_no_delete'
)")"
weekly_report_table_count="$(psql_db -Atc "select count(*) from information_schema.tables where table_schema='public' and table_name in (
  'player_weekly_reports','weekly_report_summaries','weekly_report_revisions'
)")"
weekly_report_guard_count="$(psql_db -Atc "select count(*) from pg_trigger where tgname in (
  'trg_player_weekly_report_projection','trg_summary_weekly_report_projection',
  'trg_weekly_report_revisions_append_only','trg_player_weekly_reports_no_delete',
  'trg_weekly_report_summaries_no_delete'
)")"
weekly_report_scope_constraint_count="$(psql_db -Atc "select count(*) from pg_constraint where conname in (
  'player_weekly_reports_scope_key','weekly_report_summaries_scope_key','weekly_report_revisions_target_chk',
  'weekly_report_revisions_fingerprint_chk'
)")"
customer_profile_guard_count="$(psql_db -Atc "select count(*) from pg_trigger where tgname in (
  'trg_provider_balance_snapshots_append_only','trg_customer_profile_notes_append_only'
)")"
sandbox_funding_table_count="$(psql_db -Atc "select count(*) from information_schema.tables where table_schema='public' and table_name in (
  'sandbox_provider_accounts','sandbox_provider_balance_adjustments','sandbox_provider_transactions'
)")"
sandbox_funding_guard_count="$(psql_db -Atc "select count(*) from pg_trigger where tgname in (
  'sandbox_adjustments_append_only','sandbox_transactions_append_only'
)")"

if [[ "$table_count" -lt 40 ]]; then
  echo "expected at least 40 public tables, got $table_count" >&2
  exit 1
fi

if [[ "$constraint_count" != "3" ]]; then
  echo "expected 3 sampled supplemental constraints, got $constraint_count" >&2
  exit 1
fi

if [[ "$trigger_count" != "7" ]]; then
  echo "expected 7 sampled guard triggers, got $trigger_count" >&2
  exit 1
fi

if [[ "$settlement_table_count" != "4" ]]; then
  echo "expected 4 settlement tables, got $settlement_table_count" >&2
  exit 1
fi

if [[ "$settlement_guard_count" != "9" ]]; then
  echo "expected 9 settlement guard triggers, got $settlement_guard_count" >&2
  exit 1
fi

if [[ "$weekly_report_table_count" != "3" ]]; then
  echo "expected 3 weekly report tables, got $weekly_report_table_count" >&2
  exit 1
fi

if [[ "$weekly_report_guard_count" != "5" ]]; then
  echo "expected 5 weekly report guard triggers, got $weekly_report_guard_count" >&2
  exit 1
fi

if [[ "$weekly_report_scope_constraint_count" != "4" ]]; then
  echo "expected 4 weekly report scope/target/fingerprint constraints, got $weekly_report_scope_constraint_count" >&2
  exit 1
fi

if [[ "$customer_profile_guard_count" != "2" ]]; then
  echo "expected 2 customer profile append-only guards, got $customer_profile_guard_count" >&2
  exit 1
fi

if [[ "$sandbox_funding_table_count" != "3" ]]; then
  echo "expected 3 sandbox funding tables, got $sandbox_funding_table_count" >&2
  exit 1
fi

if [[ "$sandbox_funding_guard_count" != "2" ]]; then
  echo "expected 2 sandbox funding append-only guards, got $sandbox_funding_guard_count" >&2
  exit 1
fi

psql_db -qAtc "
  INSERT INTO users (id, display_name, updated_at) VALUES
    ('00000000-0000-0000-0000-000000000001', 'Customer A', now()),
    ('00000000-0000-0000-0000-000000000002', 'Customer B', now()),
    ('00000000-0000-0000-0000-000000000003', 'Staff Owner', now()),
    ('00000000-0000-0000-0000-000000000004', 'Customer C', now());

  INSERT INTO staff_accounts (id, user_id, level, role_source, mfa_enrolled, updated_at)
  VALUES (
    '00000000-0000-0000-0000-000000000501',
    '00000000-0000-0000-0000-000000000003',
    'L4_ADMIN_OWNER',
    'BOOTSTRAP',
    true,
    now()
  );
"

expect_sql_failure "active-slot-mismatch-rejected" "
  INSERT INTO orders (id, public_id, customer_id, active_customer_slot_id, status, updated_at)
  VALUES (
    '00000000-0000-0000-0000-000000000100',
    'P-BAD-SLOT',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002',
    'DRAFT',
    now()
  );
"

psql_db -qAtc "
  INSERT INTO orders (id, public_id, customer_id, active_customer_slot_id, status, updated_at)
  VALUES (
    '00000000-0000-0000-0000-000000000101',
    'P-VALID',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'DRAFT',
    now()
  );
"

expect_sql_failure "source-less-reservation-rejected" "
  INSERT INTO fund_reservations (
    id, user_id, source_type, mode, amount_minor, currency, status, idempotency_key, updated_at
  )
  VALUES (
    '00000000-0000-0000-0000-000000000200',
    '00000000-0000-0000-0000-000000000001',
    'ORDER',
    'LOCAL_RESERVATION_FALLBACK',
    100,
    'CNY',
    'PENDING',
    'bad-source',
    now()
  );
"

psql_db -qAtc "
  INSERT INTO orders (
    id, public_id, customer_id, player_id, active_customer_slot_id, active_player_slot_id,
    status, customer_ready_at, player_ready_at, updated_at
  )
  VALUES (
    '00000000-0000-0000-0000-000000000102',
    'P-READY',
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'ACCEPTED',
    now(),
    now(),
    now()
  );
"

expect_sql_failure "readiness-event-required-rejected" "
  UPDATE orders
  SET status = 'IN_SERVICE', updated_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000102';
"

psql_db -qAtc "
  INSERT INTO fund_reservations (
    id, user_id, source_type, order_id, mode, amount_minor, currency, status, idempotency_key, updated_at
  )
  VALUES (
    '00000000-0000-0000-0000-000000000201',
    '00000000-0000-0000-0000-000000000001',
    'ORDER',
    '00000000-0000-0000-0000-000000000101',
    'LOCAL_RESERVATION_FALLBACK',
    100,
    'CNY',
    'PENDING',
    'valid-reservation',
    now()
  );

  INSERT INTO fund_reservation_events (
    id, fund_reservation_id, sequence, event_type, to_status, amount_minor,
    reservation_version, idempotency_key, actor_source
  )
  VALUES (
    '00000000-0000-0000-0000-000000000301',
    '00000000-0000-0000-0000-000000000201',
    1,
    'CREATED',
    'ACTIVE',
    100,
    1,
    'created-1',
    'SYSTEM_JOB'
  );

  INSERT INTO fund_reservation_events (
    id, fund_reservation_id, sequence, event_type, from_status, to_status, amount_minor,
    reservation_version, idempotency_key, actor_source
  )
  VALUES (
    '00000000-0000-0000-0000-000000000302',
    '00000000-0000-0000-0000-000000000201',
    2,
    'CAPTURED',
    'ACTIVE',
    'PARTIALLY_SETTLED',
    60,
    2,
    'capture-1',
    'SYSTEM_JOB'
  );
"

expect_sql_failure "over-settlement-rejected" "
  INSERT INTO fund_reservation_events (
    id, fund_reservation_id, sequence, event_type, to_status, amount_minor,
    reservation_version, idempotency_key, actor_source
  )
  VALUES (
    '00000000-0000-0000-0000-000000000303',
    '00000000-0000-0000-0000-000000000201',
    3,
    'RELEASED',
    'PARTIALLY_SETTLED',
    'RELEASED',
    50,
    3,
    'release-too-much',
    'SYSTEM_JOB'
  );
"

expect_sql_failure "reservation-bad-transition-rejected" "
  INSERT INTO fund_reservation_events (
    id, fund_reservation_id, sequence, event_type, from_status, to_status, amount_minor,
    reservation_version, idempotency_key, actor_source
  )
  VALUES (
    '00000000-0000-0000-0000-000000000304',
    '00000000-0000-0000-0000-000000000201',
    3,
    'DISPUTE_RESOLVED',
    'PARTIALLY_SETTLED',
    'ACTIVE',
    0,
    3,
    'bad-transition',
    'SYSTEM_JOB'
  );
"

psql_db -qAtc "
  INSERT INTO orders (id, public_id, customer_id, active_customer_slot_id, status, updated_at)
  VALUES (
    '00000000-0000-0000-0000-000000000103',
    'P-TERMINAL',
    '00000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000004',
    'DRAFT',
    now()
  );

  INSERT INTO fund_reservations (
    id, user_id, source_type, order_id, mode, amount_minor, currency, status, idempotency_key, updated_at
  )
  VALUES (
    '00000000-0000-0000-0000-000000000202',
    '00000000-0000-0000-0000-000000000004',
    'ORDER',
    '00000000-0000-0000-0000-000000000103',
    'LOCAL_RESERVATION_FALLBACK',
    100,
    'CNY',
    'PENDING',
    'terminal-reservation',
    now()
  );

  INSERT INTO fund_reservation_events (
    id, fund_reservation_id, sequence, event_type, to_status, amount_minor,
    reservation_version, idempotency_key, actor_source
  )
  VALUES (
    '00000000-0000-0000-0000-000000000305',
    '00000000-0000-0000-0000-000000000202',
    1,
    'CREATED',
    'ACTIVE',
    100,
    1,
    'terminal-created',
    'SYSTEM_JOB'
  );
"

expect_sql_failure "reservation-partial-terminal-rejected" "
  INSERT INTO fund_reservation_events (
    id, fund_reservation_id, sequence, event_type, from_status, to_status, amount_minor,
    reservation_version, idempotency_key, actor_source
  )
  VALUES (
    '00000000-0000-0000-0000-000000000306',
    '00000000-0000-0000-0000-000000000202',
    2,
    'CAPTURED',
    'ACTIVE',
    'CAPTURED',
    1,
    2,
    'partial-terminal',
    'SYSTEM_JOB'
  );
"

expect_sql_failure "active-reservation-failed-terminal-rejected" "
  INSERT INTO fund_reservation_events (
    id, fund_reservation_id, sequence, event_type, from_status, to_status, amount_minor,
    reservation_version, idempotency_key, actor_source
  )
  VALUES (
    '00000000-0000-0000-0000-000000000307',
    '00000000-0000-0000-0000-000000000202',
    2,
    'FAILED',
    'ACTIVE',
    'FAILED',
    0,
    2,
    'failed-after-active',
    'SYSTEM_JOB'
  );
"

psql_db -qAtc "
  INSERT INTO staff_accounts (id, user_id, level, role_source, updated_at)
  VALUES (
    '00000000-0000-0000-0000-000000000502',
    '00000000-0000-0000-0000-000000000004',
    'L3_OPERATIONS',
    'MANUAL',
    now()
  );

  INSERT INTO staff_sessions (
    id, staff_account_id, session_hash, permissions_version, expires_at, updated_at
  ) VALUES
  (
    '00000000-0000-0000-0000-000000000710',
    '00000000-0000-0000-0000-000000000501',
    'm4-session-owner-a',
    1,
    now() + interval '1 hour',
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000711',
    '00000000-0000-0000-0000-000000000502',
    'm4-session-owner-b',
    1,
    now() + interval '1 hour',
    now()
  );

  INSERT INTO staff_mfa_credentials (
    id, staff_account_id, method, secret_ciphertext, verified_at, updated_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000720',
    '00000000-0000-0000-0000-000000000501',
    'TOTP',
    'ciphertext:v1:verified-secret',
    now(),
    now()
  );

  INSERT INTO staff_mfa_enrollments (
    id, staff_account_id, method, secret_ciphertext, expires_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000721',
    '00000000-0000-0000-0000-000000000502',
    'TOTP',
    'ciphertext:v1:pending-secret',
    now() + interval '10 minutes'
  );

  INSERT INTO staff_mfa_recovery_codes (id, credential_id, code_hash)
  VALUES (
    '00000000-0000-0000-0000-000000000730',
    '00000000-0000-0000-0000-000000000720',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );

  INSERT INTO staff_step_up_challenges (
    id, staff_account_id, staff_session_id, method, expires_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000740',
    '00000000-0000-0000-0000-000000000501',
    '00000000-0000-0000-0000-000000000710',
    'TOTP',
    now() + interval '5 minutes'
  );
"

expect_sql_failure "mfa-enrollment-expiry-rejected" "
  INSERT INTO staff_mfa_enrollments (
    id, staff_account_id, method, secret_ciphertext, expires_at, created_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000722',
    '00000000-0000-0000-0000-000000000502',
    'TOTP',
    'ciphertext:v1:expired-secret',
    now(),
    now()
  );
"

expect_sql_failure "mfa-enrollment-owner-missing-rejected" "
  INSERT INTO staff_mfa_enrollments (
    id, staff_account_id, method, secret_ciphertext, expires_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000723',
    '00000000-0000-0000-0000-000000000599',
    'TOTP',
    'ciphertext:v1:missing-owner',
    now() + interval '10 minutes'
  );
"

psql_db -qAtc "
  UPDATE staff_mfa_enrollments
  SET verified_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000721';

  UPDATE staff_mfa_recovery_codes
  SET consumed_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000730';

  UPDATE staff_step_up_challenges
  SET consumed_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000740';

  UPDATE staff_sessions
  SET step_up_at = now(), updated_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000710';
"

security_audit_count="$(psql_db -qAtc "SELECT count(*) FROM audit_logs WHERE reason = 'ATOMIC_SECURITY_STATE_AUDIT';")"
if [[ "${security_audit_count}" -lt 4 ]]; then
  echo "atomic-security-audit-missing" >&2
  exit 1
fi
echo "atomic-security-audit-ok"

expect_sql_failure "mfa-enrollment-replay-rejected" "
  UPDATE staff_mfa_enrollments
  SET verified_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000721';
"

expect_sql_failure "mfa-recovery-code-replay-rejected" "
  UPDATE staff_mfa_recovery_codes
  SET consumed_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000730';
"

expect_sql_failure "step-up-cross-owner-binding-rejected" "
  INSERT INTO staff_step_up_challenges (
    id, staff_account_id, staff_session_id, method, expires_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000741',
    '00000000-0000-0000-0000-000000000501',
    '00000000-0000-0000-0000-000000000711',
    'TOTP',
    now() + interval '5 minutes'
  );
"

expect_sql_failure "step-up-replay-rejected" "
  UPDATE staff_step_up_challenges
  SET consumed_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000740';
"

expect_sql_failure "mfa-secret-update-rejected" "
  SET ROLE blackcat_app;
  UPDATE staff_mfa_credentials
  SET secret_ciphertext = 'ciphertext:v1:mutated-secret'
  WHERE id = '00000000-0000-0000-0000-000000000720';
"

expect_sql_failure "audit-delete-rejected" "SET ROLE blackcat_app; DELETE FROM audit_logs;"
expect_sql_failure "protected-amount-update-rejected" "SET ROLE blackcat_app; UPDATE fund_reservations SET amount_minor = 999 WHERE id = '00000000-0000-0000-0000-000000000201';"
expect_sql_failure "order-amount-update-rejected" "SET ROLE blackcat_app; UPDATE orders SET amount_minor = 999 WHERE id = '00000000-0000-0000-0000-000000000101';"

psql_db -qAtc "
  INSERT INTO gift_catalog_items (id, code, updated_at)
  VALUES ('00000000-0000-0000-0000-000000000601', 'rose', now());

  INSERT INTO gift_catalog_versions (
    id, gift_catalog_item_id, version, status, name, price_minor, currency,
    broadcast_template, created_by_staff_id
  )
  VALUES (
    '00000000-0000-0000-0000-000000000602',
    '00000000-0000-0000-0000-000000000601',
    1,
    'ACTIVE',
    'Rose',
    20,
    'CNY',
    '{sender} sent {gift}',
    '00000000-0000-0000-0000-000000000501'
  );

  INSERT INTO gift_requests (
    id, public_id, order_id, gift_catalog_version_id, sender_id, receiver_id,
    gift_code_snapshot, gift_name_snapshot, price_minor, currency,
    broadcast_template_snapshot, expires_at, updated_at
  )
  VALUES (
    '00000000-0000-0000-0000-000000000603',
    'G-VERIFY',
    '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000602',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002',
    'rose',
    'Rose',
    20,
    'CNY',
    '{sender} sent {gift}',
    now() + interval '1 hour',
    now()
  );
"

expect_sql_failure "gift-price-update-rejected" "SET ROLE blackcat_app; UPDATE gift_requests SET price_minor = 999 WHERE id = '00000000-0000-0000-0000-000000000603';"

psql_db -qAtc "
  INSERT INTO guild_bot_configs (guild_id, config_json, updated_by_staff_id, updated_at)
  VALUES ('guild-verify', '{}', '00000000-0000-0000-0000-000000000501', now());

  INSERT INTO guild_bot_config_events (
    id, guild_id, version, changes_json, previous_values_json, reason, actor_staff_id, source
  )
  VALUES (
    '00000000-0000-0000-0000-000000000604',
    'guild-verify',
    1,
    '{}',
    '{}',
    'verify immutable config event',
    '00000000-0000-0000-0000-000000000501',
    'DASHBOARD'
  );
"

expect_sql_failure "guild-config-event-update-privilege-rejected" "SET ROLE blackcat_app; UPDATE guild_bot_config_events SET reason = 'mutated' WHERE id = '00000000-0000-0000-0000-000000000604';"

psql_db -qAtc "
  INSERT INTO audit_logs (
    id, actor_source, client_id, action, target_type, target_id, outcome, request_id
  )
  VALUES (
    '00000000-0000-0000-0000-000000000401',
    'SYSTEM_JOB',
    'migration-verify',
    'verify.audit',
    'audit_logs',
    '00000000-0000-0000-0000-000000000401',
    'SUCCEEDED',
    'req_migration_verify'
  );
"

expect_sql_failure "append-only-update-rejected" "SET ROLE blackcat_app; UPDATE audit_logs SET reason = 'mutated' WHERE id = '00000000-0000-0000-0000-000000000401';"

psql_db -qAtc "
  INSERT INTO orders (
    id, public_id, customer_id, player_id, status, currency, amount_minor, guild_id, updated_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000701', 'P-SET-VERIFY',
    '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
    'COMPLETED', 'CNY', 1000, '900000000000000001', now()
  );
  INSERT INTO player_earnings (
    id, order_id, player_user_id, base_units, unit_payout_minor, amount_minor, currency,
    status, confirmed_by_staff_id, confirmed_at, updated_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000701',
    '00000000-0000-0000-0000-000000000001', 1, 1000, 1000, 'CNY', 'CONFIRMED',
    '00000000-0000-0000-0000-000000000501', now(), now()
  );
  INSERT INTO settlement_batches (
    id, public_id, guild_id, source, period_start, period_end, cutoff_at, time_zone, currency,
    gross_amount_minor, adjustment_amount_minor, net_amount_minor, created_by_staff_id, updated_at
  ) VALUES
    ('00000000-0000-0000-0000-000000000703', 'SET-VERIFY-A', '900000000000000001', 'MANUAL', now()-interval '7 days', now(), now(),
      'Asia/Shanghai', 'CNY', 1000, 0, 1000, '00000000-0000-0000-0000-000000000501', now()),
    ('00000000-0000-0000-0000-000000000704', 'SET-VERIFY-B', '900000000000000001', 'MANUAL', now()-interval '7 days', now(), now(),
      'Asia/Shanghai', 'CNY', 1000, 0, 1000, '00000000-0000-0000-0000-000000000501', now());
  INSERT INTO settlement_items (
    id, settlement_batch_id, player_user_id, player_display_name, gross_amount_minor, adjustment_amount_minor,
    net_amount_minor, currency, updated_at
  ) VALUES
    ('00000000-0000-0000-0000-000000000705', '00000000-0000-0000-0000-000000000703',
      '00000000-0000-0000-0000-000000000001', 'Verify Player', 1000, 0, 1000, 'CNY', now()),
    ('00000000-0000-0000-0000-000000000706', '00000000-0000-0000-0000-000000000704',
      '00000000-0000-0000-0000-000000000001', 'Verify Player', 1000, 0, 1000, 'CNY', now());
  INSERT INTO settlement_item_entries (
    id, settlement_item_id, entry_type, player_earning_id, amount_minor, currency, occurred_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000707', '00000000-0000-0000-0000-000000000705',
    'PLAYER_EARNING', '00000000-0000-0000-0000-000000000702', 1000, 'CNY',
    (SELECT confirmed_at FROM player_earnings WHERE id='00000000-0000-0000-0000-000000000702')
  );
"

expect_sql_failure "settlement-negative-net-rejected" "SET ROLE blackcat_app; UPDATE settlement_items SET net_amount_minor=-1 WHERE id='00000000-0000-0000-0000-000000000705';"
expect_sql_failure "settlement-empty-schedule-key-rejected" "SET ROLE blackcat_app; INSERT INTO settlement_batches (id,public_id,guild_id,source,schedule_key,period_start,period_end,cutoff_at,time_zone,currency,gross_amount_minor,adjustment_amount_minor,net_amount_minor,created_by_staff_id,updated_at) VALUES ('00000000-0000-0000-0000-000000000709','SET-EMPTY-KEY','900000000000000001','SCHEDULED','',now()-interval '7 days',now(),now(),'Asia/Shanghai','CNY',0,0,0,'00000000-0000-0000-0000-000000000501',now());"
expect_sql_failure "settlement-active-membership-rejected" "SET ROLE blackcat_app; INSERT INTO settlement_item_entries (id,settlement_item_id,entry_type,player_earning_id,amount_minor,currency,occurred_at) VALUES ('00000000-0000-0000-0000-000000000708','00000000-0000-0000-0000-000000000706','PLAYER_EARNING','00000000-0000-0000-0000-000000000702',1000,'CNY',(SELECT confirmed_at FROM player_earnings WHERE id='00000000-0000-0000-0000-000000000702'));"
expect_sql_failure "settlement-pending-payment-result-rejected" "SET ROLE blackcat_app; INSERT INTO settlement_payment_results (id,settlement_item_id,result,amount_minor,currency,idempotency_key,recorded_by_staff_id,recorded_at) VALUES ('00000000-0000-0000-0000-000000000710','00000000-0000-0000-0000-000000000705','PENDING',1000,'CNY','verify:pending-result','00000000-0000-0000-0000-000000000501',now());"
expect_sql_failure "settlement-entry-update-rejected" "SET ROLE blackcat_app; UPDATE settlement_item_entries SET amount_minor=999 WHERE id='00000000-0000-0000-0000-000000000707';"
expect_sql_failure "settlement-entry-delete-rejected" "SET ROLE blackcat_app; DELETE FROM settlement_item_entries WHERE id='00000000-0000-0000-0000-000000000707';"
expect_sql_failure "settlement-item-delete-rejected" "SET ROLE blackcat_app; DELETE FROM settlement_items WHERE id='00000000-0000-0000-0000-000000000705';"
expect_sql_failure "settlement-batch-delete-rejected" "SET ROLE blackcat_app; DELETE FROM settlement_batches WHERE id='00000000-0000-0000-0000-000000000703';"

echo "migration-apply-ok"
echo "table_count=$table_count"
echo "constraint_count=$constraint_count"
echo "trigger_count=$trigger_count"
echo "settlement_table_count=$settlement_table_count"
echo "settlement_guard_count=$settlement_guard_count"
echo "weekly_report_table_count=$weekly_report_table_count"
echo "weekly_report_guard_count=$weekly_report_guard_count"
echo "weekly_report_scope_constraint_count=$weekly_report_scope_constraint_count"
echo "customer_profile_guard_count=$customer_profile_guard_count"
echo "sandbox_funding_table_count=$sandbox_funding_table_count"
echo "sandbox_funding_guard_count=$sandbox_funding_guard_count"
