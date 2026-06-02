import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();

describe('M9-US-02 CAT persistence contract', () => {
  test('models CAT wallets, USD receipt evidence and product role tasks', async () => {
    const schema = await readFile(resolve(root, 'database/prisma/schema.prisma'), 'utf8');
    expect(schema).toContain('model WalletAccount');
    expect(schema).toContain('currency   String              @default("CAT")');
    expect(schema).toContain('paidAmountUsdCents');
    expect(schema).toContain('creditedCatSubunits');
    expect(schema).toContain('model DiscordProductRoleTask');
    expect(schema).toContain('model CompanionReviewEvent');
  });

  test('ships a complete forward migration with fixed conversion constraints', async () => {
    const migration = await readFile(resolve(root, 'database/prisma/migrations/000011_cat_wallet_onboarding/migration.sql'), 'utf8');
    expect(migration).toContain("paid_currency = 'USD'");
    expect(migration).toContain('rate_cat_per_usd = 10');
    expect(migration).toContain('credited_cat_subunits = paid_amount_usd_cents');
    expect(migration).toContain('CREATE TABLE discord_product_role_tasks');
  });
});
