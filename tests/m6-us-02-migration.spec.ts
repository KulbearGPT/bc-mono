import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const us01Migration = 'database/prisma/migrations/000002_m6_settlements/migration.sql';
const us02Migration = 'database/prisma/migrations/000003_m6_settlement_review/migration.sql';
const securityMigration = 'database/prisma/migrations/000007_settlement_security_remediation/migration.sql';

describe('M6-US-02 migration chain', () => {
  test('keeps the applied US01 migration immutable and adds US02 as 000003', async () => {
    const us01 = await readFile(us01Migration, 'utf8');
    expect(createHash('sha256').update(us01).digest('hex'))
      .toBe('b91a97c5eb01435775fefff2a2389eb2ee2d07147bbd9d1a51fc73b89c1eb199');

    const us02 = await readFile(us02Migration, 'utf8').catch(() => '');
    expect(us02).toContain('ALTER TABLE settlement_items');
    expect(us02).toContain('settlement_payment_results_evidence_chk');
    expect(us02).toContain('settlement_payment_results_one_success_idx');
    expect(us02).toContain('trg_settlement_payment_result_guard');
    expect(us02).toContain('trg_settlement_payment_result_projection');

    const security = await readFile(securityMigration, 'utf8');
    expect(security).toContain('ALTER COLUMN guild_id SET NOT NULL');
    expect(security).toContain('settlement_batches_guild_schedule_period_currency_key');
    expect(security).toContain('trg_settlement_guild_immutable');
    expect(security).toContain('trg_settlement_entry_guild_ownership');
    expect(security).toContain('same-Guild');
  });
});
