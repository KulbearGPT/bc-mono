import { describe, expect, test, vi } from 'vitest';
import {
  InMemoryGiftStore,
  captureApprovedGift,
  createGiftAnnouncementHandler,
  type GiftRequestRecord,
  type GiftReservationRecord,
  type GiftStaffTaskRecord
} from '@blackcat/api/gifts';

const now = new Date('2026-08-14T06:00:00.000Z');
const customerId = '00000000-0000-0000-0000-000000026001';
const playerId = '00000000-0000-0000-0000-000000026002';
const staffId = '00000000-0000-0000-0000-000000026003';
const realCustomerName = '绝不能公开的老板名字';
const customerDiscordId = '900000000000026001';
const privateChannelId = '900000000000026009';

describe('M22-US-06 gift privacy and announcement recovery', () => {
  test.each([
    { visibility: 'PUBLIC' as const, expectedSender: realCustomerName },
    { visibility: 'ANONYMOUS' as const, expectedSender: '匿名老板' }
  ])('GTA-L-004/B-006/B-007 captures once and renders $visibility from the immutable snapshot', async ({ visibility, expectedSender }) => {
    const fixture = giftFixture(visibility);
    const first = await captureApprovedGift({ store: fixture.store, giftRequestId: fixture.request.id,
      broadcastChannelId: '900000000000026099', actorStaffId: staffId, now });
    const replay = await captureApprovedGift({ store: fixture.store, giftRequestId: fixture.request.id,
      broadcastChannelId: '900000000000026099', actorStaffId: staffId, now });

    expect(replay).toEqual(first);
    expect(fixture.store.consumptions).toHaveLength(1);
    expect(fixture.store.broadcasts).toHaveLength(1);
    const payload = fixture.store.broadcasts[0]!.payload as Record<string, unknown>;
    expect(payload.content).toBe(`${expectedSender} 向 陪玩阿青 送出 星光礼盒`);
    expect(JSON.stringify(payload)).not.toContain(privateChannelId);
    expect(JSON.stringify(payload)).not.toContain(customerDiscordId);
    if (visibility === 'ANONYMOUS') {
      expect(JSON.stringify(payload)).not.toContain(realCustomerName);
      expect(JSON.stringify(payload)).not.toContain(customerId);
    }
  });

  test('GTA-L-011/L-012/B-008 retries Discord delivery without a second capture or duplicate business fact', async () => {
    const fixture = giftFixture('ANONYMOUS');
    await captureApprovedGift({ store: fixture.store, giftRequestId: fixture.request.id,
      broadcastChannelId: '900000000000026099', actorStaffId: staffId, now });
    const job = fixture.store.broadcasts[0]!;
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('DISCORD_TEMPORARILY_UNAVAILABLE'))
      .mockResolvedValue({ messageId: '900000000000026088' });
    const handler = createGiftAnnouncementHandler({ store: fixture.store, send, now: () => now });

    await expect(handler(job)).rejects.toThrow('DISCORD_TEMPORARILY_UNAVAILABLE');
    expect(fixture.store.requests[0]?.status).toBe('CAPTURED');
    expect(fixture.store.consumptions).toHaveLength(1);
    await handler(job);
    expect(fixture.store.requests[0]).toMatchObject({ status: 'ANNOUNCED', broadcastMessageId: '900000000000026088' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(new Set(send.mock.calls.map((call) => call[0].dedupeKey)).size).toBe(1);
    expect(fixture.store.consumptions).toHaveLength(1);
    expect(fixture.store.broadcasts).toHaveLength(1);
  });
});

function giftFixture(senderVisibility: 'PUBLIC' | 'ANONYMOUS') {
  const request: GiftRequestRecord = {
    id: '00000000-0000-0000-0000-000000026010', publicId: 'G-26010', guildId: '900000000000026000',
    origin: 'STANDALONE', senderVisibility, initiatorMode: 'CUSTOMER_SELF', assistedByStaffId: null,
    giftAssistChallengeId: null, orderId: null, participantId: null,
    giftCatalogVersionId: '00000000-0000-0000-0000-000000026011', senderId: customerId, receiverId: playerId,
    status: 'APPROVED', version: 3, giftCodeSnapshot: 'STAR', giftNameSnapshot: '星光礼盒', priceMinor: 5_200,
    currency: 'CAT', broadcastTemplateSnapshot: '{sender_name} 向 {receiver_name} 送出 {gift_name}',
    verifiedByStaffId: staffId, verifiedAt: now.toISOString(), verificationNote: 'verified',
    verificationPayloadHash: 'payload-hash', executionCredentialExpiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
    approvedByStaffId: staffId, approvedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
  const reservation: GiftReservationRecord = {
    id: '00000000-0000-0000-0000-000000026012', userId: customerId, sourceType: 'GIFT', orderId: null,
    giftRequestId: request.id, mode: 'LOCAL_RESERVATION', provider: 'INTERNAL_WALLET', providerHoldRef: null,
    amountMinor: 5_200, currency: 'CAT', status: 'ACTIVE', version: 2, idempotencyKey: 'gift:m22:06:privacy',
    expiresAt: request.expiresAt, activatedAt: now.toISOString(), settledAt: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
  const task: GiftStaffTaskRecord = {
    id: '00000000-0000-0000-0000-000000026013', publicId: 'T-GIFT-26013', type: 'GIFT_REVIEW',
    reasonCode: 'GIFT_REQUESTED', status: 'APPROVED', version: 4, orderId: null, giftRequestId: request.id,
    claimedBy: staffId, voiceChannelId: null,
    contextSnapshot: { source: 'STANDALONE', orderId: null, orderPublicId: null, channelId: privateChannelId,
      voiceChannelId: null, senderId: customerId, receiverId: playerId, giftCode: 'STAR', giftName: '星光礼盒',
      priceMinor: 5_200, currency: 'CAT', reservationId: reservation.id },
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
  const store = new InMemoryGiftStore({ requests: [request], reservations: [reservation], staffTasks: [task],
    displayNames: { [customerId]: realCustomerName, [playerId]: '陪玩阿青' } });
  return { store, request };
}
