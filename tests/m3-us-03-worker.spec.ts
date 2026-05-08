import { describe, expect, test } from 'vitest';
import { InMemoryGiftStore, createGiftAnnouncementHandler, type GiftRequestRecord } from '@blackcat/api/gifts';
import { InMemoryOutboxStore, OutboxWorker, type OutboxJob } from '@blackcat/api/outbox';

const now = new Date('2026-07-18T14:30:00.000Z');

describe('M3-US-03 gift announcement recovery', () => {
  test('retries only Discord delivery and marks the gift announced after success', async () => {
    const giftRequestId = '00000000-0000-0000-0000-000000003710';
    const gift = { id: giftRequestId, status: 'CAPTURED', version: 4 } as GiftRequestRecord;
    const giftStore = new InMemoryGiftStore({ requests: [gift] });
    const job: OutboxJob = { id: '00000000-0000-0000-0000-000000003711', type: 'GIFT_ANNOUNCEMENT', status: 'PENDING',
      payload: { giftRequestId, channelId: '900000000000000020', content: '小林送给阿青星光礼盒' },
      aggregateType: 'GIFT_REQUEST', aggregateId: giftRequestId, dedupeKey: `gift:announcement:${giftRequestId}:v1`,
      attempts: 0, maxAttempts: 3, runAfter: now.toISOString(), lockedAt: null, lockedBy: null, lastError: null,
      version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    const outbox = new InMemoryOutboxStore({ now, jobs: [job] });
    let sends = 0;
    const handler = createGiftAnnouncementHandler({ store: giftStore, send: async () => {
      sends += 1;
      if (sends === 1) throw new Error('Discord unavailable');
      return { messageId: '900000000000000021' };
    }, now: () => now });
    const worker = new OutboxWorker({ store: outbox, workerId: 'gift-worker', now: () => now, backoffMs: [0] });

    await worker.runOnce({ GIFT_ANNOUNCEMENT: handler });
    await worker.runOnce({ GIFT_ANNOUNCEMENT: handler });

    expect(sends).toBe(2);
    expect(giftStore.captures).toHaveLength(0);
    expect(giftStore.requests[0]).toMatchObject({ status: 'ANNOUNCED', announcedAt: now.toISOString(), broadcastMessageId: '900000000000000021' });
    expect(await outbox.getJob(job.id)).toMatchObject({ status: 'COMPLETED', attempts: 2 });
  });
});
