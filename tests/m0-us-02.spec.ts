import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import {
  IMMUTABLE_RECORD_TABLES,
  assertAllowedRecordMutation,
  isImmutableRecordTable
} from '@blackcat/database/immutable-records';

const repoRoot = new URL('../', import.meta.url);
const schemaPath = new URL('../database/prisma/schema.prisma', import.meta.url);
const canonicalSchemaPath = new URL('../outputs/P0开发交付包/03-数据模型/schema.prisma', import.meta.url);
const migrationPath = new URL(
  '../database/prisma/migrations/000001_p0_baseline/migration.sql',
  import.meta.url
);
const seedPath = new URL('../database/seed/seed-data.csv', import.meta.url);
const migrationVerifyScriptPath = new URL('../scripts/verify-m0-us-02-migration.sh', import.meta.url);

async function readText(path: URL): Promise<string> {
  return readFile(path, 'utf8');
}

describe('M0-US-02 P0 database baseline', () => {
  test('database Prisma schema is the canonical reviewed P0 data contract', async () => {
    const [databaseSchema, canonicalSchema] = await Promise.all([
      readText(schemaPath),
      readText(canonicalSchemaPath)
    ]);

    expect(databaseSchema.trim()).toBe(canonicalSchema.trim());
    expect(databaseSchema).toContain('provider = "postgresql"');
    expect(databaseSchema).toContain('enum StaffLevel');
    expect(databaseSchema).toContain('L1_SUPPORT');
    expect(databaseSchema).toContain('L4_ADMIN_OWNER');
    expect(databaseSchema).toContain('enum FundReservationStatus');
    expect(databaseSchema).toContain('PARTIALLY_SETTLED');
  });

  test('schema includes active-order slots, idempotency, referral exclusivity, and financial append-only models', async () => {
    const schema = await readText(schemaPath);

    expect(schema).toMatch(/activeCustomerSlotId\s+String\?\s+@unique/);
    expect(schema).toMatch(/activePlayerSlotId\s+String\?\s+@unique/);
    expect(schema).toMatch(/model IdempotencyRecord/);
    expect(schema).toMatch(/activeAttributionKey\s+String\?\s+@unique/);
    expect(schema).toMatch(/model FundReservationEvent/);
    expect(schema).toMatch(/@@unique\(\[fundReservationId, sequence\]\)/);
    expect(schema).toMatch(/model PlayerEarningAdjustment/);
    expect(schema).toMatch(/model CommissionAdjustment/);
    expect(schema).toMatch(/model AuditLog/);
  });

  test('baseline migration adds PostgreSQL constraints Prisma cannot express', async () => {
    const migration = await readText(migrationPath);

    expect(migration).toContain('CREATE TYPE "StaffLevel" AS ENUM');
    expect(migration).toContain('CREATE TABLE "users"');
    expect(migration).toContain('CREATE TABLE "orders"');
    expect(migration).toContain('CREATE TABLE "fund_reservations"');
    expect(migration).toContain('CREATE ROLE blackcat_app');
    expect(migration).toContain('currency_format_chk');
    expect(migration).toContain("currency ~ '^[A-Z]{3}$'");
    expect(migration).toContain('fund_reservation_amounts_non_negative_chk');
    expect(migration).toContain('fund_reservation_not_over_settled_chk');
    expect(migration).toContain('adjustment_amount_non_negative_chk');
    expect(migration).toContain('order_active_customer_slot_status_chk');
    expect(migration).toContain('order_active_player_slot_status_chk');
    expect(migration).toContain('active_customer_slot_id = customer_id');
    expect(migration).toContain('active_player_slot_id = player_id');
    expect(migration).toContain('fund_reservation_source_binding_chk');
    expect(migration).toContain('referral_attribution_not_self_chk');
    expect(migration).toContain("CREATE ROLE blackcat_app LOGIN PASSWORD 'blackcat_app'");
    expect(migration).toContain('trg_fund_reservation_event_guard');
    expect(migration).toContain('trg_order_readiness_guard');
    expect(migration).toContain('trg_referral_attribution_guard');
    expect(migration).toContain('trg_commission_attribution_guard');
    expect(migration).toContain('trg_external_transaction_reservation_guard');
    expect(migration).toContain('trg_guild_bot_config_event_immutable');
    expect(migration).toContain('protect_amount_minor_update');
    expect(migration).toContain('deny_append_only_mutation');
    expect(migration).toContain('REVOKE DELETE ON TABLE audit_logs FROM blackcat_app');
    expect(migration).toContain('REVOKE UPDATE (amount_minor) ON fund_reservations FROM blackcat_app');
  });

  test('seed baseline carries approved P0 staff levels, thresholds, funding policy, and test catalog facts', async () => {
    const seed = await readText(seedPath);

    expect(seed).toContain('access_policy","l1_support');
    expect(seed).toContain('access_policy","l4_admin_owner');
    expect(seed).toContain('access_threshold","l2_gift_limit');
    expect(seed).toContain('200000');
    expect(seed).toContain('funding_policy","reservation_mode');
    expect(seed).toContain('LOCAL_RESERVATION');
    expect(seed).toContain('permission_code","wallet.top_up');
    expect(seed).not.toContain('permission_code","account.bind');
    expect(seed).toContain('referral_program","PROMOTER_FIRST_PURCHASE');
    expect(seed).toContain('referral_program","PLAYER_LIFETIME');
  });

  test('immutable record policy blocks hard deletes and protected amount overwrites in application code', () => {
    expect(isImmutableRecordTable('audit_logs')).toBe(true);
    expect(IMMUTABLE_RECORD_TABLES).toEqual(
      expect.arrayContaining([
        'orders',
        'order_events',
        'external_transactions',
        'fund_reservations',
        'fund_reservation_events',
        'consumption_entries',
        'commissions',
        'commission_adjustments',
        'player_earnings',
        'player_earning_adjustments',
        'audit_logs'
      ])
    );

    expect(() => assertAllowedRecordMutation('audit_logs', 'delete')).toThrow(/hard delete/i);
    expect(() => assertAllowedRecordMutation('audit_logs', 'updateStatus')).toThrow(
      /immutable status/i
    );
    expect(() => assertAllowedRecordMutation('fund_reservations', 'updateAmount')).toThrow(
      /protected amount/i
    );
    expect(() => assertAllowedRecordMutation('staff_tasks', 'updateStatus')).not.toThrow();
  });

  test('database workspace is included in root TypeScript and npm verification surfaces', async () => {
    const [rootPackage, buildConfig, verifyScript] = await Promise.all([
      readText(new URL('package.json', repoRoot)),
      readText(new URL('tsconfig.build.json', repoRoot)),
      readText(migrationVerifyScriptPath)
    ]);

    expect(rootPackage).toContain('"db:validate"');
    expect(rootPackage).toContain('"db:migrate:deploy"');
    expect(rootPackage).toContain('MIGRATION_DATABASE_URL');
    expect(rootPackage).toContain('"db:verify:migration"');
    expect(rootPackage).toContain('"database"');
    expect(rootPackage).toContain(
      '"m0:verify": "vitest run tests/m0-us-01.spec.ts tests/m0-us-02.spec.ts tests/m0-us-03.spec.ts tests/m0-us-04.spec.ts tests/m0-us-05.spec.ts"'
    );
    expect(buildConfig).toContain('./database');
    expect(verifyScript).toContain('initdb');
    expect(verifyScript).toContain('migration-apply-ok');
    expect(verifyScript).toContain('active-slot-mismatch-rejected');
    expect(verifyScript).toContain('source-less-reservation-rejected');
    expect(verifyScript).toContain('over-settlement-rejected');
    expect(verifyScript).toContain('audit-delete-rejected');
    expect(verifyScript).toContain('protected-amount-update-rejected');
    expect(verifyScript).toContain('append-only-update-rejected');
    expect(verifyScript).toContain('order-amount-update-rejected');
    expect(verifyScript).toContain('gift-price-update-rejected');
    expect(verifyScript).toContain('guild-config-event-update-privilege-rejected');
    expect(verifyScript).toContain('readiness-event-required-rejected');
    expect(verifyScript).toContain('reservation-bad-transition-rejected');
    expect(verifyScript).toContain('reservation-partial-terminal-rejected');
    expect(verifyScript).toContain('active-reservation-failed-terminal-rejected');
    expect(verifyScript).toContain('expected 7 sampled guard triggers');
  });
});
