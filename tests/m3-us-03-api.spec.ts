import { describe, expect, test } from 'vitest';
import { MockFundingAdapter } from '@blackcat/api/payment-adapter';
import {
  InMemoryGiftStore,
  captureApprovedGift,
  type GiftRequestRecord,
  type GiftReservationRecord,
  type GiftStaffTaskRecord
} from '@blackcat/api/gifts';

const now = new Date('2026-07-18T14:00:00.000Z');
const giftRequestId = '00000000-0000-0000-0000-000000003610';
const reservationId = '00000000-0000-0000-0000-000000003611';

function request(priceMinor = 500000): GiftRequestRecord {
  return {
    id: giftRequestId, publicId: 'G-3610', orderId: '00000000-0000-0000-0000-000000003612',
    giftCatalogVersionId: '00000000-0000-0000-0000-000000003613', senderId: '00000000-0000-0000-0000-000000003614',
    receiverId: '00000000-0000-0000-0000-000000003615', status: 'APPROVED', version: 3,
    giftCodeSnapshot: 'STAR', giftNameSnapshot: '星光礼盒', priceMinor, currency: 'CNY',
    broadcastTemplateSnapshot: '{sender_name} 送给 {receiver_name} {gift_name}', verifiedByStaffId: '00000000-0000-0000-0000-000000003616',
    verifiedAt: now.toISOString(), verificationNote: 'confirmed', verificationPayloadHash: 'hash',
    executionCredentialExpiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
    approvedByStaffId: '00000000-0000-0000-0000-000000003616', approvedAt: now.toISOString(),
    rejectedReason: null, expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
}

function reservation(mode: GiftReservationRecord['mode'] = 'LOCAL_RESERVATION_FALLBACK'): GiftReservationRecord {
  return {
    id: reservationId, userId: request().senderId, sourceType: 'GIFT', orderId: null, giftRequestId,
    mode, provider: 'mock-provider', providerHoldRef: null, amountMinor: request().priceMinor, currency: 'CNY',
    status: 'ACTIVE', version: 2, idempotencyKey: 'gift:3610', expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    activatedAt: now.toISOString(), settledAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
}

function task(): GiftStaffTaskRecord {
  return {
    id: '00000000-0000-0000-0000-000000003617', publicId: 'T-GIFT-3617', type: 'GIFT_REVIEW', reasonCode: 'GIFT_REQUESTED',
    status: 'APPROVED', version: 3, orderId: request().orderId, giftRequestId, claimedBy: request().approvedByStaffId,
    voiceChannelId: '900000000000000005', contextSnapshot: {
      orderId: request().orderId, orderPublicId: 'P-3612', channelId: '900000000000000003', voiceChannelId: '900000000000000005',
      senderId: request().senderId, receiverId: request().receiverId, giftCode: 'STAR', giftName: '星光礼盒',
      priceMinor: request().priceMinor, currency: 'CNY', reservationId
    }, createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
}

describe('M3-US-03 gift capture service', () => {
  test('captures an approved fallback reservation once and creates one consumption plus one announcement', async () => {
    const store = new InMemoryGiftStore({ requests: [request()], reservations: [reservation()], staffTasks: [task()],
      externalUserIds: { [request().senderId]: 'mock-user-ok' },
      displayNames: { [request().senderId]: '小林', [request().receiverId]: '阿青' } });
    const adapter = new MockFundingAdapter({ now, reservations: [{ fundReservationId: reservationId, version: 2 }] });

    const first = await captureApprovedGift({ store, fundingAdapter: adapter, providerKey: 'mock-provider',
      broadcastChannelId: '900000000000000020', giftRequestId, now });
    const replay = await captureApprovedGift({ store, fundingAdapter: adapter, providerKey: 'mock-provider',
      broadcastChannelId: '900000000000000020', giftRequestId, now });

    expect(first).toMatchObject({ status: 'CAPTURED', giftRequestId,
      reservation: { reservationId, amountMinor: 500000, status: 'CAPTURED' },
      chargeOutcome: { status: 'SUCCEEDED', amountMinor: 500000, currency: 'CNY' } });
    expect(replay).toEqual(first);
    expect(store.captures).toHaveLength(1);
    expect(store.consumptions).toHaveLength(1);
    expect(store.broadcasts).toHaveLength(1);
    expect(store.broadcasts[0]?.payload).toMatchObject({ channelId: '900000000000000020', content: '小林 送给 阿青 星光礼盒' });
    expect(store.requests[0]).toMatchObject({ status: 'CAPTURED', version: 4, capturedAt: now.toISOString() });
    expect(store.reservations[0]).toMatchObject({ status: 'CAPTURED', version: 3, settledAt: now.toISOString() });
  });

  test('captures the original native hold instead of creating another reservation', async () => {
    const adapter = new MockFundingAdapter({ now, reservations: [{ fundReservationId: reservationId, version: 2 }] });
    const hold = adapter.createHold({ idempotencyKey: 'gift:3610:provider-hold:v1', fundReservationId: reservationId, fundReservationVersion: 2,
      externalUserId: 'mock-user-ok', amount: { amountMinor: 500000, currency: 'CNY' }, businessSource: 'GIFT',
      businessReference: giftRequestId, expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString() });
    const native = { ...reservation('PROVIDER_NATIVE_HOLD'), providerHoldRef: hold.holdRef };
    const store = new InMemoryGiftStore({ requests: [request()], reservations: [native], staffTasks: [task()],
      externalUserIds: { [request().senderId]: 'mock-user-ok' } });

    const result = await captureApprovedGift({ store, fundingAdapter: adapter, providerKey: 'mock-provider',
      broadcastChannelId: '900000000000000020', giftRequestId, now });

    expect(result.chargeOutcome.providerReferenceDisplay).toMatch(/^mock_\*\*\*/);
    expect(store.reservations).toHaveLength(1);
    expect(adapter.getHold({ lookupType: 'PROVIDER_HOLD_REF', lookupValue: hold.holdRef! }).status).toBe('CAPTURED');
  });

  test('does not persist capture facts when provider debit fails', async () => {
    const store = new InMemoryGiftStore({ requests: [request()], reservations: [reservation()], staffTasks: [task()],
      externalUserIds: { [request().senderId]: 'mock-user-low' } });
    const adapter = new MockFundingAdapter({ now, reservations: [{ fundReservationId: reservationId, version: 2 }] });

    await expect(captureApprovedGift({ store, fundingAdapter: adapter, providerKey: 'mock-provider',
      broadcastChannelId: '900000000000000020', giftRequestId, now }))
      .rejects.toThrowError(expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }));
    expect(store.captures).toHaveLength(0);
    expect(store.consumptions).toHaveLength(0);
    expect(store.broadcasts).toHaveLength(0);
    expect(store.requests[0]?.status).toBe('APPROVED');
  });
});
