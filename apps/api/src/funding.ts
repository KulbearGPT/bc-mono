import crypto from 'node:crypto';
import type { Currency } from './catalog.js';
type MaybePromise<T> = T | Promise<T>;

export type FundReservationSourceType = 'ORDER' | 'GIFT';
export type FundReservationMode = 'LOCAL_RESERVATION';
export type FundReservationStatus = 'PENDING' | 'ACTIVE' | 'DISPUTED' | 'PARTIALLY_SETTLED' | 'CAPTURED' | 'RELEASED' | 'EXPIRED' | 'FAILED';

export interface FundingAdapterCapabilitiesSource {
  discoverCapabilities?: () => MaybePromise<{
    nativeHold: { supported: boolean };
  }>;
}

export interface FundReservationDraft {
  id: string;
  userId: string;
  sourceType: FundReservationSourceType;
  orderId: string | null;
  giftRequestId: string | null;
  mode: FundReservationMode;
  provider: string | null;
  providerHoldRef: string | null;
  amountMinor: number;
  currency: Currency;
  status: FundReservationStatus;
  version: number;
  idempotencyKey: string;
  expiresAt: string;
  activatedAt: string | null;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function resolveFundReservationMode(adapter: FundingAdapterCapabilitiesSource): Promise<FundReservationMode> {
  void adapter;
  return 'LOCAL_RESERVATION';
}

export function buildFundReservationDraft(input: {
  businessSource: { type: FundReservationSourceType; referenceId: string };
  userId: string;
  provider: string | null;
  mode: FundReservationMode;
  amountMinor: number;
  currency: Currency;
  idempotencyKey: string;
  ttlMinutes: number;
  now: Date;
}): FundReservationDraft {
  const timestamp = input.now.toISOString();
  return {
    id: deterministicFundReservationId(input.businessSource.type, input.businessSource.referenceId, input.idempotencyKey),
    userId: input.userId,
    sourceType: input.businessSource.type,
    orderId: input.businessSource.type === 'ORDER' ? input.businessSource.referenceId : null,
    giftRequestId: input.businessSource.type === 'GIFT' ? input.businessSource.referenceId : null,
    mode: input.mode,
    provider: input.provider,
    providerHoldRef: null,
    amountMinor: input.amountMinor,
    currency: input.currency,
    status: 'PENDING',
    version: 1,
    idempotencyKey: input.idempotencyKey,
    expiresAt: new Date(input.now.getTime() + input.ttlMinutes * 60_000).toISOString(),
    activatedAt: null,
    settledAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function deterministicFundReservationId(sourceType: FundReservationSourceType, referenceId: string, idempotencyKey: string): string {
  const bytes = crypto.createHash('sha256').update(`${sourceType}:${referenceId}:${idempotencyKey}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [
    bytes.subarray(0, 4).toString('hex'),
    bytes.subarray(4, 6).toString('hex'),
    bytes.subarray(6, 8).toString('hex'),
    bytes.subarray(8, 10).toString('hex'),
    bytes.subarray(10, 16).toString('hex')
  ].join('-');
}
