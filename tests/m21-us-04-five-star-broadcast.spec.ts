import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildOrderExperienceReviewMessage,
  buildOrderReviewPublicationPreview,
  executeOrderExperienceReviewButton
} from '@blackcat/bot/order-experience-review-interactions';
import type { BotActorContext, BotApiClient, OrderExperienceReviewCenter } from '@blackcat/bot/service-center-api';
import {
  InMemoryOrderReviewBroadcastStore,
  createOrderReviewBroadcastHandler,
  type OrderReviewBroadcastDiscord
} from '@blackcat/api/order-review-broadcast';
import { InMemoryAuditSink } from '@blackcat/api/security';
import { InMemoryOutboxStore, OutboxWorker, type OutboxJob } from '@blackcat/api/outbox';
import { DiscordRestDeliveryAdapter } from '@blackcat/api/worker-delivery';
import { botConfigChannelFields } from '@blackcat/bot/bot-config';
import { validateBotApiData } from '@blackcat/bot/bot-api-validation';

const orderId = '00000000-0000-0000-0000-000000021401';
const publicationId = '00000000-0000-0000-0000-000000021402';
const actor: BotActorContext = {
  guildId: '999999999999999999',
  discordUserId: '111111111111111111',
  interactionId: '888888888888888888',
  clientSource: 'DISCORD_BOT'
};
const secret = 'review-state-secret-that-survives-a-restart';

describe('M21-US-04 explicit-consent five-star broadcast', () => {
  test('exposes the dedicated review channel through the managed Bot configuration contract', () => {
    const apiRuntime = readFileSync('apps/api/src/bot-config.ts', 'utf8');
    const botConfig = readFileSync('apps/bot/src/bot-config-contracts.ts', 'utf8');
    const botFlow = readFileSync('apps/bot/src/bot-config-flow.ts', 'utf8');
    const dashboard = readFileSync('apps/dashboard/src/bot-config-dashboard.ts', 'utf8');
    const openapi = readFileSync('outputs/P0开发交付包/02-API/openapi.yaml', 'utf8');

    expect(apiRuntime).toContain('"review_broadcast_channel_id"');
    expect(botConfigChannelFields).toContain('review_broadcast_channel_id');
    expect(botConfig).toContain("'review_broadcast_channel_id'");
    expect(botFlow).toContain("review_broadcast_channel_id: '好评展示频道'");
    expect(dashboard).toContain("'review_broadcast_channel_id'");
    expect(dashboard).toContain("review_broadcast_channel_id:'好评展示频道'");
    expect(openapi.match(/review_broadcast_channel_id/gu)).toHaveLength(5);
  });

  test('ships a guarded, self-cleaning real-Guild broadcast recovery probe', () => {
    const script = readFileSync('scripts/uat/m21-review-broadcast-uat.ts', 'utf8');
    expect(script).toContain("M21_UAT_CONFIRM !== 'DELETE_TEMP_REVIEW_CHANNEL'");
    expect(script).toContain('createOrderReviewBroadcastHandler');
    expect(script).toContain('DiscordRestDeliveryAdapter');
    expect(script).toContain('renderFiveStarReviewBroadcast');
    expect(script).toContain('randomUUID()');
    expect(script).toContain("channel.delete('M21 review broadcast UAT cleanup')");
    expect(script).toContain("acceptanceId: 'AT-REVIEW-003'");
    expect(script).toContain("status: 'PASS'");
  });

  test('offers a safe preview only after a five-star fact and requires the explicit consent button', async () => {
    const initial = center();
    expect(JSON.stringify(buildOrderExperienceReviewMessage(initial, actor, secret))).not.toContain('预览可公开');

    const fiveStar = center(true);
    const message = buildOrderExperienceReviewMessage(fiveStar, actor, secret);
    expect(JSON.stringify(message)).toContain('预览可公开的五星好评');
    const preview = buildOrderReviewPublicationPreview(fiveStar);
    expect(preview.body).toContain('订单整体 · ★★★★★');
    expect(preview.body).toContain('陪玩 · 小黑 · ★★★★★');
    expect(preview.body).not.toContain('小白');
    expect(preview.body).not.toContain(actor.discordUserId);
    expect(preview.body).not.toContain('私密留言');
    expect(JSON.stringify(preview.components)).toContain('同意公开五星好评');
    expect(JSON.stringify(preview.components)).toContain('仅内部保存');

    const publishOrderFiveStarReview = vi.fn().mockResolvedValue({ id: publicationId });
    const api = {
      getOrderExperienceReview: vi.fn().mockResolvedValueOnce(fiveStar).mockResolvedValueOnce({
        ...fiveStar,
        publication: { id: publicationId, status: 'PENDING' }
      }),
      publishOrderFiveStarReview
    } as unknown as BotApiClient;
    const interaction = {
      id: actor.interactionId,
      deferUpdate: vi.fn(),
      editReply: vi.fn(),
      followUp: vi.fn()
    };
    await executeOrderExperienceReviewButton({
      interaction,
      route: { area: 'experience-review', action: 'publish', orderId },
      actor,
      api,
      secret
    });
    expect(publishOrderFiveStarReview).toHaveBeenCalledWith(
      orderId,
      { confirmation: 'PUBLISH_FIVE_STAR_SNAPSHOT' },
      actor,
      expect.stringContaining('review:publication')
    );
  });

  test('delivers exactly one safe aggregate from the immutable snapshot across retries and message loss', async () => {
    const store = new InMemoryOrderReviewBroadcastStore({
      publications: [publication()],
      guildChannels: new Map([['999999999999999999', '777777777777777777']])
    });
    const messages = new Map<string, { id: string; body: unknown }>();
    const discord: OrderReviewBroadcastDiscord = {
      upsertFiveStarReview: vi.fn(async (input) => {
        const existing = messages.get(input.dedupeKey);
        if (existing) return { messageId: existing.id };
        const value = { id: `message-${messages.size + 1}`, body: input.message };
        messages.set(input.dedupeKey, value);
        return { messageId: value.id };
      })
    };
    const handler = createOrderReviewBroadcastHandler({ store, discord });
    const outbox = new InMemoryOutboxStore({ now: new Date(), jobs: [job()] });
    const worker = new OutboxWorker({
      store: outbox,
      workerId: 'review-worker',
      now: () => new Date('2026-08-13T07:00:00.000Z'),
      auditSink: new InMemoryAuditSink()
    });
    await worker.runOnce({ REVIEW_BROADCAST: handler });
    expect(messages).toHaveLength(1);
    const rendered = JSON.stringify([...messages.values()][0]!.body);
    expect(rendered).toContain('订单整体');
    expect(rendered).toContain('小黑');
    expect(rendered).not.toContain('低分陪玩');
    expect(rendered).not.toContain('私密留言');
    expect(rendered).not.toContain(actor.discordUserId);
    expect(store.publications[0]).toMatchObject({
      status: 'PUBLISHED',
      broadcastChannelId: '777777777777777777',
      broadcastMessageId: 'message-1'
    });

    await handler(job({ status: 'PROCESSING', attempts: 2 }));
    expect(messages).toHaveLength(1);
    messages.clear();
    await handler(job({ status: 'PROCESSING', attempts: 3 }));
    expect(messages).toHaveLength(1);
    expect([...messages.values()][0]!.id).toBe('message-1');
  });

  test('fails closed when the same-Guild review channel is absent', async () => {
    const store = new InMemoryOrderReviewBroadcastStore({
      publications: [publication()],
      guildChannels: new Map([['222222222222222222', '777777777777777777']])
    });
    const handler = createOrderReviewBroadcastHandler({
      store,
      discord: { upsertFiveStarReview: vi.fn() }
    });
    await expect(handler(job())).rejects.toThrow(/channel/i);
  });

  test('the real Discord adapter reconciles the stable nonce before a retry can post again', async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> | null }> = [];
    let remoteMessage: { id: string; nonce: string } | null = null;
    const adapter = new DiscordRestDeliveryAdapter({
      botToken: 'discord-token-value',
      fetch: async (_url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
        requests.push({ method: init?.method ?? 'GET', body });
        if (!init?.method || init.method === 'GET')
          return new Response(JSON.stringify(remoteMessage ? [remoteMessage] : []), { status: 200 });
        remoteMessage = { id: 'review-message-1', nonce: String(body?.nonce) };
        return new Response(JSON.stringify({ id: remoteMessage.id }), { status: 200 });
      }
    });
    const input = {
      channelId: '777777777777777777',
      dedupeKey: `review-publication:${publicationId}`,
      notBefore: '2026-08-13T06:00:00Z',
      existingMessageId: null,
      message: { content: null, embeds: [{ title: '五星好评' }] }
    };

    await expect(adapter.upsertFiveStarReview(input)).resolves.toEqual({ messageId: 'review-message-1' });
    await expect(adapter.upsertFiveStarReview(input)).resolves.toEqual({ messageId: 'review-message-1' });

    expect(requests.map(({ method }) => method)).toEqual(['GET', 'POST', 'GET']);
    expect(requests[1]?.body).toMatchObject({ enforce_nonce: true, content: null });
    expect(requests[1]?.body?.nonce).toMatch(/^[a-f0-9]{24}$/u);
  });

  test('uses an old persisted message ID to derive a new stable nonce after Discord reports deletion', async () => {
    const requests: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
    let remoteMessage: { id: string; nonce: string } | null = null;
    let postCount = 0;
    const adapter = new DiscordRestDeliveryAdapter({
      botToken: 'discord-token-value',
      fetch: async (url, init) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        const request = { method: init?.method ?? 'GET', url: String(url), body };
        requests.push(request);
        if (request.method === 'PATCH') return new Response('{}', { status: 404 });
        if (request.method === 'GET') {
          return new Response(JSON.stringify(remoteMessage ? [remoteMessage] : []), { status: 200 });
        }
        postCount += 1;
        remoteMessage = { id: `review-message-${postCount}`, nonce: String(body?.nonce) };
        return new Response(JSON.stringify({ id: remoteMessage.id }), { status: 200 });
      }
    });
    const base = {
      channelId: '777777777777777777',
      dedupeKey: `review-publication:${publicationId}`,
      notBefore: '2026-08-13T06:00:00Z',
      message: { content: null, embeds: [{ title: '五星好评' }] }
    };

    const first = await adapter.upsertFiveStarReview({ ...base, existingMessageId: null });
    const firstNonce = remoteMessage?.nonce;
    remoteMessage = null;
    const recovered = await adapter.upsertFiveStarReview({ ...base, existingMessageId: first.messageId });
    const recoveredNonce = remoteMessage?.nonce;
    const replay = await adapter.upsertFiveStarReview({ ...base, existingMessageId: first.messageId });

    expect(first).toEqual({ messageId: 'review-message-1' });
    expect(recovered).toEqual({ messageId: 'review-message-2' });
    expect(replay).toEqual({ messageId: 'review-message-2' });
    expect(firstNonce).toMatch(/^[a-f0-9]{24}$/u);
    expect(recoveredNonce).toMatch(/^[a-f0-9]{24}$/u);
    expect(recoveredNonce).not.toBe(firstNonce);
    expect(requests.map(({ method }) => method)).toEqual(['GET', 'POST', 'PATCH', 'GET', 'POST', 'PATCH', 'GET']);
    expect(postCount).toBe(2);
  });

  test('rejects any publication snapshot that contains a private review field', async () => {
    const unsafe = publication();
    unsafe.snapshot.targets[0] = { ...unsafe.snapshot.targets[0]!, comment: '私密留言' } as never;
    const discord = { upsertFiveStarReview: vi.fn() };
    const handler = createOrderReviewBroadcastHandler({
      store: new InMemoryOrderReviewBroadcastStore({
        publications: [unsafe],
        guildChannels: new Map([[unsafe.guildId, '777777777777777777']])
      }),
      discord
    });

    await expect(handler(job())).rejects.toThrow(/snapshot target/i);
    expect(discord.upsertFiveStarReview).not.toHaveBeenCalled();
    expect(() =>
      validateBotApiData('review-publication', {
        id: unsafe.id,
        orderId: unsafe.orderId,
        status: unsafe.status,
        snapshot: unsafe.snapshot,
        consentedAt: '2026-08-13T06:00:00Z',
        publishedAt: null
      })
    ).toThrow(/review-publication/i);
  });
});

function center(fiveStar = false): OrderExperienceReviewCenter {
  const review = (id: string, targetKey: string, targetType: 'ORDER' | 'PLAYER', score: number) => ({
    id,
    orderId,
    targetKey,
    targetType,
    orderParticipantId: targetType === 'PLAYER' ? targetKey.slice('player:'.length) : null,
    attributedStaffId: null,
    score,
    comment: score === 1 ? { id: `${id.slice(0, -1)}9`, comment: '私密留言', createdAt: '2026-08-13T06:00:00Z' } : null,
    createdAt: '2026-08-13T06:00:00Z'
  });
  return {
    orderId,
    orderPublicId: 'P-M21-PUBLIC',
    expiresAt: '2026-08-14T06:00:00Z',
    targets: [
      { targetKey: 'order', targetType: 'ORDER', displayName: '订单整体', review: fiveStar ? review('00000000-0000-0000-0000-000000021411', 'order', 'ORDER', 5) : null },
      { targetKey: 'player:00000000-0000-0000-0000-000000021412', targetType: 'PLAYER', displayName: '小黑', review: fiveStar ? review('00000000-0000-0000-0000-000000021413', 'player:00000000-0000-0000-0000-000000021412', 'PLAYER', 5) : null },
      { targetKey: 'player:00000000-0000-0000-0000-000000021414', targetType: 'PLAYER', displayName: '小白', review: fiveStar ? review('00000000-0000-0000-0000-000000021415', 'player:00000000-0000-0000-0000-000000021414', 'PLAYER', 1) : null }
    ],
    hasPublishableFiveStar: fiveStar,
    publication: null
  };
}

function publication() {
  return {
    id: publicationId,
    orderId,
    guildId: '999999999999999999',
    status: 'PENDING' as const,
    snapshot: {
      orderPublicId: 'P-M21-PUBLIC',
      serviceDisplayName: '英雄联盟双排',
      completedAt: '2026-08-13T06:00:00Z',
      targets: [
        { targetType: 'ORDER' as const, displayName: '订单整体', score: 5 as const },
        { targetType: 'PLAYER' as const, displayName: '小黑', score: 5 as const }
      ]
    },
    broadcastChannelId: null,
    broadcastMessageId: null,
    publishedAt: null
  };
}

function job(overrides: Partial<OutboxJob> = {}): OutboxJob {
  return {
    id: '00000000-0000-0000-0000-000000021499',
    type: 'REVIEW_BROADCAST',
    status: 'PENDING',
    payload: { publicationId, orderId },
    aggregateType: 'order_review_publication',
    aggregateId: publicationId,
    dedupeKey: `review-publication:${orderId}`,
    attempts: 1,
    maxAttempts: 8,
    runAfter: '2026-08-13T06:00:00Z',
    lockedAt: null,
    lockedBy: null,
    lastError: null,
    version: 2,
    createdAt: '2026-08-13T06:00:00Z',
    updatedAt: '2026-08-13T06:00:00Z',
    ...overrides
  };
}
