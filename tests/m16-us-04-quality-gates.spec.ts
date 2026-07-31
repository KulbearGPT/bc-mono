import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseWalletBalanceDto, parseWalletEntryPageDto } from '@blackcat/platform/api-contracts';

const root = new URL('../', import.meta.url);

describe('M16-US-04 shared DTO and quality gates', () => {
  test('shares wallet and error envelope DTOs between API and Dashboard', () => {
    expect(
      parseWalletBalanceDto({
        ledgerBalanceMinor: 100,
        reservedMinor: 20,
        availableMinor: 80,
        currency: 'CAT',
        calculatedAt: '2026-08-06T12:00:00Z',
        version: 1
      })
    ).toMatchObject({ currency: 'CAT', availableMinor: 80 });
    expect(parseWalletEntryPageDto({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null });
    const contract = readFileSync(new URL('../modules/platform/src/api-contracts.ts', import.meta.url), 'utf8');
    expect(contract).toContain('ErrorEnvelopeDto');
    for (const file of ['apps/api/src/wallet.ts', 'apps/dashboard/src/customer-wallet.ts']) {
      expect(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).toContain(
        '@blackcat/platform/api-contracts'
      );
    }
  });

  test('production route/OpenAPI parity, lint, and format gates are executable', () => {
    for (const script of ['quality:routes', 'lint:api-dashboard', 'format:check']) {
      execFileSync('npm', ['run', script], { cwd: root, stdio: 'pipe' });
    }
  }, 60_000);
});
