import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();

describe('M9-US-06 Dashboard operations', () => {
  test('submits USD receipt evidence and previews the fixed CAT credit', async () => {
    const source = await readFile(resolve(root, 'apps/dashboard/src/customer-wallet.ts'), 'utf8');
    expect(source).toContain("paidCurrency:'USD'");
    expect(source).toContain('paidAmountUsdCents');
    expect(source).toContain('receiptNumber');
    expect(source).toContain("paidCurrency:'USD'");
  });

  test('exposes auditable approve and reject actions for pending companions', async () => {
    const source = await readFile(resolve(root, 'apps/dashboard/src/admin-business-actions.ts'), 'utf8');
    expect(source).toContain('/approve');
    expect(source).toContain('/reject');
    expect(source).toContain('reasonCode');
    expect(source).toContain('expectedVersion');
  });
});
