export interface WalletDisplayConfig {
  displayName: string;
  symbol: string;
  subunitsPerCat: 10;
}

export const DEFAULT_WALLET_DISPLAY_CONFIG: Readonly<WalletDisplayConfig> = Object.freeze({
  displayName: '猫条',
  symbol: 'CAT',
  subunitsPerCat: 10
});

const SYMBOL_PATTERN = /^[\p{L}0-9_·-]+$/u;

export function parseWalletDisplayConfig(
  env: Record<string, string | undefined> = process.env
): WalletDisplayConfig {
  if (env.WALLET_DISPLAY_NAME !== undefined || env.WALLET_DISPLAY_SYMBOL !== undefined) {
    throw new Error('CAT wallet display is fixed; remove WALLET_DISPLAY_NAME and WALLET_DISPLAY_SYMBOL.');
  }
  return { ...DEFAULT_WALLET_DISPLAY_CONFIG };
}

export function formatCustomerWalletAmount(
  amountMinor: number,
  config: WalletDisplayConfig = DEFAULT_WALLET_DISPLAY_CONFIG
): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new Error('amountMinor must be a safe integer in CAT subunits.');
  }
  assertWalletDisplayConfig(config);

  const subunits = BigInt(amountMinor);
  const sign = subunits < 0n ? '-' : '';
  const absolute = subunits < 0n ? -subunits : subunits;
  const whole = (absolute / 10n).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const fraction = (absolute % 10n).toString();
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
  if (config.subunitsPerCat !== 10) throw new Error('subunitsPerCat must remain fixed at 10.');
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
