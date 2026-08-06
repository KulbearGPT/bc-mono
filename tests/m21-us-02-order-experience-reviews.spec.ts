import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import { InMemoryOrderExperienceReviewStore } from '@blackcat/api/order-experience-reviews';

const now = new Date('2026-08-13T06:00:00.000Z');
const guildId = '999999999999999999';
const customerDiscordId = '111111111111111111';
const otherDiscordId = '222222222222222222';
const orderId = '00000000-0000-0000-0000-000000021201';
const customerId = '00000000-0000-0000-0000-000000021202';
const participantA = '00000000-0000-0000-0000-000000021203';
const participantB = '00000000-0000-0000-0000-000000021204';
const staffId = '00000000-0000-0000-0000-000000021205';

describe('M21-US-02 target-scoped order experience review API', () => {
  test('derives optional order, player and real-support targets for the owner', async () => {
    const { server } = fixture();
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/orders/${orderId}/experience-review`,
      headers: headers()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.targets).toEqual([
      expect.objectContaining({ targetKey: 'order', targetType: 'ORDER' }),
      expect.objectContaining({ targetKey: `player:${participantA}`, targetType: 'PLAYER' }),
      expect.objectContaining({ targetKey: `player:${participantB}`, targetType: 'PLAYER' }),
      expect.objectContaining({ targetKey: `support:${staffId}`, targetType: 'SUPPORT' })
    ]);
    expect(Object.keys(response.json().data.targets[3]).sort()).toEqual([
      'displayName',
      'review',
      'targetKey',
      'targetType'
    ]);

    const forbidden = await server.inject({
      method: 'GET',
      url: `/api/v1/orders/${orderId}/experience-review`,
      headers: headers(otherDiscordId)
    });
    expect(forbidden.statusCode).toBe(403);
  });

  test('atomically saves selected targets without requiring reasons or comments', async () => {
    const { server, store } = fixture();
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/experience-ratings`,
      headers: headers(customerDiscordId, 'players-two-stars'),
      payload: {
        targetKeys: [`player:${participantA}`, `player:${participantB}`],
        score: 2
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toHaveLength(2);
    expect(store.reviews.map((item) => item.score)).toEqual([2, 2]);

    const invalid = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/experience-ratings`,
      headers: headers(customerDiscordId, 'invalid-batch'),
      payload: { targetKeys: ['order', 'player:forged'], score: 5 }
    });
    expect(invalid.statusCode).toBe(409);
    expect(store.reviews).toHaveLength(2);

    const coerced = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/experience-ratings`,
      headers: headers(customerDiscordId, 'no-coercion'),
      payload: { targetKeys: ['order'], score: '5' }
    });
    expect(coerced.statusCode).toBe(400);
    const oversized = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/experience-ratings`,
      headers: headers(customerDiscordId, 'oversized-batch'),
      payload: { targetKeys: Array.from({ length: 26 }, (_, index) => `target-${index}`), score: 5 }
    });
    expect(oversized.statusCode).toBe(400);
    expect(store.reviews).toHaveLength(2);
  });

  test('omits support without a real response and rejects an expired review window', async () => {
    const noResponse = fixture({ respondedStaffId: null });
    const center = await noResponse.server.inject({
      method: 'GET',
      url: `/api/v1/orders/${orderId}/experience-review`,
      headers: headers()
    });
    expect(center.statusCode).toBe(200);
    expect(center.json().data.targets.some((item: { targetType: string }) => item.targetType === 'SUPPORT')).toBe(
      false
    );

    const expired = fixture({ completedAt: new Date(now.getTime() - 86_400_001).toISOString() });
    const response = await expired.server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/experience-ratings`,
      headers: headers(customerDiscordId, 'expired'),
      payload: { targetKeys: ['order'], score: 5 }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('RATING_EXPIRED');
    expect(expired.store.reviews).toHaveLength(0);
  });

  test('keeps a saved score when the optional comment is skipped or appended later', async () => {
    const { server, store } = fixture();
    const saved = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/experience-ratings`,
      headers: headers(customerDiscordId, 'save-order'),
      payload: { targetKeys: ['order'], score: 5 }
    });
    const reviewId = saved.json().data[0].id as string;
    expect(store.reviews[0]?.comment).toBeNull();

    const comment = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/experience-ratings/${reviewId}/comment`,
      headers: headers(customerDiscordId, 'comment-order'),
      payload: { comment: '整体体验很好' }
    });
    expect(comment.statusCode).toBe(201);
    expect(comment.json().data.comment.comment).toBe('整体体验很好');

    const duplicate = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/experience-ratings/${reviewId}/comment`,
      headers: headers(customerDiscordId, 'comment-order-again'),
      payload: { comment: '覆盖留言' }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(store.reviews[0]?.score).toBe(5);
  });

  test('requires explicit consent and snapshots only five-star targets', async () => {
    const { server, store } = fixture();
    await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/experience-ratings`,
      headers: headers(customerDiscordId, 'save-fives'),
      payload: { targetKeys: ['order', `player:${participantA}`], score: 5 }
    });
    await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/experience-ratings`,
      headers: headers(customerDiscordId, 'save-low'),
      payload: { targetKeys: [`player:${participantB}`, `support:${staffId}`], score: 1 }
    });

    const missingConsent = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/experience-review/publication`,
      headers: headers(customerDiscordId, 'no-consent'),
      payload: { confirmation: 'NO' }
    });
    expect(missingConsent.statusCode).toBe(400);
    expect(store.publications).toHaveLength(0);

    const published = await server.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/experience-review/publication`,
      headers: headers(customerDiscordId, 'publish'),
      payload: { confirmation: 'PUBLISH_FIVE_STAR_SNAPSHOT' }
    });
    expect(published.statusCode).toBe(202);
    expect(published.json().data.snapshot.targets).toEqual([
      expect.objectContaining({ targetType: 'ORDER', score: 5 }),
      expect.objectContaining({ targetType: 'PLAYER', displayName: '小黑', score: 5 })
    ]);
    expect(JSON.stringify(published.json())).not.toContain('小白');
    expect(JSON.stringify(published.json())).not.toContain('猫舍前台');
  });
});

function fixture(overrides: { respondedStaffId?: string | null; completedAt?: string } = {}) {
  const store = new InMemoryOrderExperienceReviewStore({
    orders: [
      {
        id: orderId,
        publicId: 'P-REVIEW01',
        guildId,
        customerId,
        customerDiscordId,
        status: 'COMPLETED',
        completedAt: overrides.completedAt ?? now.toISOString(),
        serviceDisplayName: '英雄联盟双排',
        participants: [
          { id: participantA, displayName: '小黑', activeAtCompletion: true },
          { id: participantB, displayName: '小白', activeAtCompletion: true }
        ],
        respondedStaffId: overrides.respondedStaffId === undefined ? staffId : overrides.respondedStaffId
      }
    ]
  });
  return {
    store,
    server: buildApiServer({
      env: {
        NODE_ENV: 'development',
        DATABASE_URL: '',
        API_PORT: '0',
        API_BASE_URL: 'http://localhost:3000',
        BOT_SERVICE_TOKEN: 'valid-bot-token'
      },
      security: {
        auditSink: new InMemoryAuditSink(),
        idempotencyStore: new InMemoryIdempotencyStore()
      },
      experienceReviews: { store, now: () => now }
    })
  };
}

function headers(discordUserId = customerDiscordId, key?: string) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': discordUserId,
    'x-actor-guild-id': guildId,
    ...(key ? { 'idempotency-key': `m21-review-${key}` } : {})
  };
}
