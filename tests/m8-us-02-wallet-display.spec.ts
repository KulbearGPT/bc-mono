import { describe, expect, test } from 'vitest';
import {
  DEFAULT_WALLET_DISPLAY_CONFIG,
  customerWalletLabel,
  formatCustomerWalletAmount,
  parseWalletDisplayConfig
} from '@blackcat/bot/wallet-display';
import { validateProductionEnv } from '../scripts/verify-production-env.mjs';

describe('M8-US-02 wallet display configuration', () => {
  test('uses the approved global defaults and fixed ratio', () => {
    expect(DEFAULT_WALLET_DISPLAY_CONFIG).toEqual({
      displayName: '猫币',
      symbol: 'MB',
      unitsPerUsd: 10
    });
    expect(parseWalletDisplayConfig({})).toEqual(DEFAULT_WALLET_DISPLAY_CONFIG);
    expect(parseWalletDisplayConfig({ WALLET_DISPLAY_NAME: '星币', WALLET_DISPLAY_SYMBOL: 'SC' })).toEqual({
      displayName: '星币',
      symbol: 'SC',
      unitsPerUsd: 10
    });
    expect(customerWalletLabel()).toBe('猫币钱包');
    expect(customerWalletLabel({ displayName: '星币', symbol: 'SC', unitsPerUsd: 10 })).toBe('星币钱包');
  });

  test('formats USD minor units as exact token hundredths without floating point drift', () => {
    expect(formatCustomerWalletAmount(0)).toBe('0.00 MB');
    expect(formatCustomerWalletAmount(1)).toBe('0.10 MB');
    expect(formatCustomerWalletAmount(10)).toBe('1.00 MB');
    expect(formatCustomerWalletAmount(100)).toBe('10.00 MB');
    expect(formatCustomerWalletAmount(10_000)).toBe('1,000.00 MB');
    expect(formatCustomerWalletAmount(500_000)).toBe('50,000.00 MB');
    expect(formatCustomerWalletAmount(-1)).toBe('-0.10 MB');
    expect(formatCustomerWalletAmount(100, { displayName: '星币', symbol: 'SC', unitsPerUsd: 10 })).toBe('10.00 SC');
  });

  test.each([
    [{ WALLET_DISPLAY_NAME: '' }, 'WALLET_DISPLAY_NAME'],
    [{ WALLET_DISPLAY_NAME: '   ' }, 'WALLET_DISPLAY_NAME'],
    [{ WALLET_DISPLAY_NAME: '一二三四五六七八九十一二三四五六七八九十一' }, 'WALLET_DISPLAY_NAME'],
    [{ WALLET_DISPLAY_SYMBOL: '' }, 'WALLET_DISPLAY_SYMBOL'],
    [{ WALLET_DISPLAY_SYMBOL: 'TOO-LONG9' }, 'WALLET_DISPLAY_SYMBOL'],
    [{ WALLET_DISPLAY_SYMBOL: '$MB' }, 'WALLET_DISPLAY_SYMBOL'],
    [{ WALLET_DISPLAY_SYMBOL: 'M B' }, 'WALLET_DISPLAY_SYMBOL'],
    [{ WALLET_DISPLAY_SYMBOL: 'MB!' }, 'WALLET_DISPLAY_SYMBOL']
  ])('rejects invalid explicit config %o', (env, field) => {
    expect(() => parseWalletDisplayConfig(env)).toThrow(field);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, 0.1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects a non-integer canonical minor amount %s',
    (value) => {
      expect(() => formatCustomerWalletAmount(value)).toThrow('amountMinor');
    }
  );

  test('applies the same fail-closed checks in production validation when either key is present', () => {
    const base = validProductionEnv();
    expect(validateProductionEnv({ ...base, WALLET_DISPLAY_NAME: '星币', WALLET_DISPLAY_SYMBOL: 'SC' })).toEqual([]);
    expect(validateProductionEnv({ ...base, WALLET_DISPLAY_NAME: '' })).toContain(
      'WALLET_DISPLAY_NAME must contain 1 to 20 Unicode characters.'
    );
    expect(validateProductionEnv({ ...base, WALLET_DISPLAY_SYMBOL: '$MB' })).toContain(
      'WALLET_DISPLAY_SYMBOL must contain 1 to 8 letters, ASCII digits, _, - or ·.'
    );
  });
});

function validProductionEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://app:secret@db.internal/app',
    MIGRATION_DATABASE_URL: 'postgresql://migrate:secret@db.internal/app',
    API_BASE_URL: 'https://api.example.test',
    BOT_SERVICE_TOKEN: 'a'.repeat(32),
    BOT_CONFIG_VALIDATION_SECRET: 'b'.repeat(32),
    DASHBOARD_CSRF_SECRET: 'c'.repeat(32),
    DASHBOARD_MFA_ENCRYPTION_KEY: 'd'.repeat(32),
    DISCORD_BOT_TOKEN: 'e'.repeat(32),
    DISCORD_OAUTH_CLIENT_ID: 'client-id',
    DISCORD_OAUTH_CLIENT_SECRET: 'f'.repeat(32),
    DISCORD_OAUTH_REDIRECT_URI: 'https://dashboard.example.test/callback',
    DISCORD_GUILD_ID: '12345678901234567'
  };
}
