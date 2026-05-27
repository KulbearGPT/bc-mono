export interface WalletDisplayConfig {
  displayName: string;
  symbol: string;
  unitsPerUsd: 10;
}

export const DEFAULT_WALLET_DISPLAY_CONFIG: Readonly<WalletDisplayConfig> = Object.freeze({
  displayName: '猫币',
  symbol: 'MB',
  unitsPerUsd: 10
});

const SYMBOL_PATTERN = /^[\p{L}0-9_·-]+$/u;

export function parseWalletDisplayConfig(
  env: Record<string, string | undefined> = process.env
): WalletDisplayConfig {
  const displayName = validateDisplayName(env.WALLET_DISPLAY_NAME);
  const symbol = validateDisplaySymbol(env.WALLET_DISPLAY_SYMBOL);
  return { displayName, symbol, unitsPerUsd: 10 };
}

export function formatCustomerWalletAmount(
  amountMinor: number,
  config: WalletDisplayConfig = DEFAULT_WALLET_DISPLAY_CONFIG
): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new Error('amountMinor must be a safe integer in USD minor units.');
  }
  assertWalletDisplayConfig(config);

  const hundredths = BigInt(amountMinor) * 10n;
  const sign = hundredths < 0n ? '-' : '';
  const absolute = hundredths < 0n ? -hundredths : hundredths;
  const whole = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${sign}${whole}.${fraction} ${config.symbol}`;
}

export function customerWalletLabel(
  config: WalletDisplayConfig = DEFAULT_WALLET_DISPLAY_CONFIG
): string {
  assertWalletDisplayConfig(config);
  return `${config.displayName}钱包`;
}

function assertWalletDisplayConfig(config: WalletDisplayConfig): void {
  validateDisplayName(config.displayName, false);
  validateDisplaySymbol(config.symbol, false);
  if (config.unitsPerUsd !== 10) throw new Error('unitsPerUsd must remain fixed at 10.');
}

function validateDisplayName(value: string | undefined, useDefault = true): string {
  if (value === undefined && useDefault) return DEFAULT_WALLET_DISPLAY_CONFIG.displayName;
  const normalized = value?.trim() ?? '';
  const length = [...normalized].length;
  if (length < 1 || length > 20) {
    throw new Error('WALLET_DISPLAY_NAME must contain 1 to 20 Unicode characters.');
  }
  return normalized;
}

function validateDisplaySymbol(value: string | undefined, useDefault = true): string {
  if (value === undefined && useDefault) return DEFAULT_WALLET_DISPLAY_CONFIG.symbol;
  const normalized = value?.trim() ?? '';
  const length = [...normalized].length;
  if (normalized !== value || length < 1 || length > 8 || !SYMBOL_PATTERN.test(normalized)) {
    throw new Error('WALLET_DISPLAY_SYMBOL must contain 1 to 8 letters, ASCII digits, _, - or ·.');
  }
  return normalized;
}
