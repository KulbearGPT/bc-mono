import { describe, expect, test } from 'vitest';
import {
  buildFundReservationDraft,
  resolveFundReservationMode,
  type FundingAdapterCapabilitiesSource
} from '@blackcat/api/funding';

const now = new Date('2026-07-17T23:00:00.000Z');

describe('M1-US-08 reusable funding reservation helpers', () => {
  test('builds deterministic reservation drafts for order and gift sources without client-side balance math', () => {
    const orderReservation = buildFundReservationDraft({
      businessSource: { type: 'ORDER', referenceId: '00000000-0000-0000-0000-00000000b001' },
      userId: '00000000-0000-0000-0000-00000000a001',
      provider: 'mock-provider',
      mode: 'PROVIDER_NATIVE_HOLD',
      amountMinor: 12_000,
      currency: 'CNY',
      idempotencyKey: 'discord:order:submit:shared',
      ttlMinutes: 30,
      now
    });
    const giftReservation = buildFundReservationDraft({
      businessSource: { type: 'GIFT', referenceId: '00000000-0000-0000-0000-00000000g001' },
      userId: '00000000-0000-0000-0000-00000000a001',
      provider: 'mock-provider',
      mode: 'LOCAL_RESERVATION_FALLBACK',
      amountMinor: 2_000,
      currency: 'CNY',
      idempotencyKey: 'discord:gift:request:shared',
      ttlMinutes: 30,
      now
    });

    expect(orderReservation).toMatchObject({
      sourceType: 'ORDER',
      orderId: '00000000-0000-0000-0000-00000000b001',
      giftRequestId: null,
      amountMinor: 12_000,
      status: 'PENDING',
      version: 1
    });
    expect(giftReservation).toMatchObject({
      sourceType: 'GIFT',
      orderId: null,
      giftRequestId: '00000000-0000-0000-0000-00000000g001',
      mode: 'LOCAL_RESERVATION_FALLBACK',
      amountMinor: 2_000
    });
    expect(buildFundReservationDraft({ ...orderReservation, businessSource: { type: 'ORDER', referenceId: orderReservation.orderId ?? '' }, ttlMinutes: 30, now }).id).toBe(orderReservation.id);
  });

  test('resolves provider native hold preference but falls back when capability discovery says native hold is unsupported', () => {
    const nativeAdapter: FundingAdapterCapabilitiesSource = {
      discoverCapabilities: () => ({ nativeHold: { supported: true } })
    };
    const fallbackAdapter: FundingAdapterCapabilitiesSource = {
      discoverCapabilities: () => ({ nativeHold: { supported: false } })
    };

    expect(resolveFundReservationMode(nativeAdapter)).toBe('PROVIDER_NATIVE_HOLD');
    expect(resolveFundReservationMode(fallbackAdapter)).toBe('LOCAL_RESERVATION_FALLBACK');
    expect(resolveFundReservationMode({})).toBe('PROVIDER_NATIVE_HOLD');
  });
});
