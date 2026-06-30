import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

describe('M12-US-02 database constraints', () => {
  test('migration enforces one active shift per staff and Guild', () => {
    const sql = readFileSync('database/prisma/migrations/000030_m12_support_operations/migration.sql', 'utf8');
    expect(sql).toMatch(/CREATE UNIQUE INDEX "support_shifts_one_active_per_staff_guild"[\s\S]*?\("guild_id", "staff_account_id"\) WHERE "clocked_out_at" IS NULL/);
    expect(sql).toContain('CONSTRAINT "support_shifts_time_order"');
    expect(sql).toContain('REFERENCES "staff_accounts"("id")');
  });

  test('runtime schema contains response and rating facts required by the summary', () => {
    const schema = readFileSync('database/prisma/schema.prisma', 'utf8');
    expect(schema).toContain('model SupportShift');
    expect(schema).toContain('responseStatus');
    expect(schema).toContain('model OrderSupportRating');
  });
});
