export type WalletEntryTypeDto =
  | 'TOP_UP_CREDIT'
  | 'ORDER_CAPTURE_DEBIT'
  | 'GIFT_CAPTURE_DEBIT'
  | 'ORDER_REFUND_CREDIT'
  | 'CASH_REFUND_DEBIT'
  | 'ADJUSTMENT_CREDIT'
  | 'ADJUSTMENT_DEBIT';

export interface WalletBalanceDto {
  ledgerBalanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  currency: 'CAT';
  calculatedAt: string;
  version: number;
}

export interface WalletEntryDto {
  id: string;
  walletAccountId?: string;
  entryType: WalletEntryTypeDto | string;
  direction: 'CREDIT' | 'DEBIT';
  amountMinor: number;
  currency: 'CAT';
  sourceType: string;
  sourceId: string;
  reversalOfEntryId?: string | null;
  occurredAt: string;
}

export interface PageDto<T> {
  items: T[];
  nextCursor: string | null;
}

export type WalletEntryPageDto = PageDto<WalletEntryDto>;

export interface ErrorEnvelopeDto {
  requestId: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: ReadonlyArray<{ field: string; reason: string }>;
  };
}

export function parseWalletBalanceDto(value: unknown): WalletBalanceDto | null {
  if (
    !isRecord(value) ||
    value.currency !== 'CAT' ||
    !safeInteger(value.ledgerBalanceMinor) ||
    !safeInteger(value.reservedMinor) ||
    !safeInteger(value.availableMinor) ||
    !safeInteger(value.version) ||
    typeof value.calculatedAt !== 'string'
  )
    return null;
  return {
    ledgerBalanceMinor: value.ledgerBalanceMinor,
    reservedMinor: value.reservedMinor,
    availableMinor: value.availableMinor,
    currency: 'CAT',
    calculatedAt: value.calculatedAt,
    version: value.version
  };
}

export function parseWalletEntryPageDto(value: unknown): WalletEntryPageDto | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    (value.nextCursor !== null && typeof value.nextCursor !== 'string')
  )
    return null;
  const items = value.items.map(parseWalletEntryDto);
  return items.every((item): item is WalletEntryDto => item !== null) ? { items, nextCursor: value.nextCursor } : null;
}

function parseWalletEntryDto(value: unknown): WalletEntryDto | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.entryType !== 'string' ||
    (value.direction !== 'CREDIT' && value.direction !== 'DEBIT') ||
    !safeInteger(value.amountMinor) ||
    value.currency !== 'CAT' ||
    typeof value.sourceType !== 'string' ||
    typeof value.sourceId !== 'string' ||
    (value.walletAccountId !== undefined && typeof value.walletAccountId !== 'string') ||
    (value.reversalOfEntryId !== undefined &&
      value.reversalOfEntryId !== null &&
      typeof value.reversalOfEntryId !== 'string') ||
    typeof value.occurredAt !== 'string'
  )
    return null;
  return {
    id: value.id,
    walletAccountId: value.walletAccountId,
    entryType: value.entryType,
    direction: value.direction,
    amountMinor: value.amountMinor,
    currency: 'CAT',
    sourceType: value.sourceType,
    sourceId: value.sourceId,
    reversalOfEntryId: value.reversalOfEntryId,
    occurredAt: value.occurredAt
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}
