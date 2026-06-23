import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

describe('M10-US-08 service package migration', () => {
  test('persists immutable package versions, ordered slots and order provenance', async () => {
    const [schema, migration, derivedPriceMigration] = await Promise.all([
      readFile('database/prisma/schema.prisma', 'utf8'),
      readFile('database/prisma/migrations/000024_service_packages/migration.sql', 'utf8'),
      readFile('database/prisma/migrations/000028_derived_service_package_prices/migration.sql', 'utf8')
    ]);

    expect(schema).toContain('model ServicePackageVersion');
    expect(schema).toContain('sourcePackageSlotId');
    expect(migration).toContain('CREATE TABLE service_package_versions');
    expect(migration).toContain('CREATE TABLE service_package_slots');
    expect(migration).toContain('source_package_version_id');
    expect(migration).toContain('source_package_slot_id');
    expect(migration).toContain('protect_service_package_version_mutation');
    expect(migration).toContain('CHECK (position > 0)');
    expect(migration).toContain('CHECK (unit_count > 0)');
    expect(schema).toContain('defaultCustomerPriceMinor BigInt ');
    expect(derivedPriceMigration).toContain('SUM(catalog.customer_unit_price_minor * slot.unit_count)');
    expect(derivedPriceMigration).toContain('ALTER COLUMN default_customer_price_minor SET NOT NULL');
  });
});
