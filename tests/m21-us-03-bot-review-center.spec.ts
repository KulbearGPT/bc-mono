import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { DiscordRestWorkerAdapter } from '@blackcat/api/worker-adapters';
import {
  buildOrderExperienceReviewMessage,
  createReviewSelectionState,
  executeOrderExperienceReviewButton,
  executeOrderExperienceReviewModal,
  executeOrderExperienceReviewSelect,
  readReviewSelectionState
} from '@blackcat/bot/order-experience-review-interactions';
import { buildServiceLifecyclePanelMessage } from '@blackcat/bot/service-lifecycle-message';
import { parseServiceCenterCustomId } from '@blackcat/bot/service-center-routes';
import { assertDiscordMessageSpec } from '@blackcat/bot/service-center-components';
import { createBotRuntimeDependencies } from '@blackcat/bot/runtime-dependencies';
import type { BotActorContext, BotApiClient, OrderExperienceReviewCenter } from '@blackcat/bot/service-center-api';
import { BotApiError, HttpBotApiClient } from '@blackcat/bot/service-center-api';

const orderId = '00000000-0000-0000-0000-000000021301';
const reviewId = '00000000-0000-0000-0000-000000021302';
const playerA = '00000000-0000-0000-0000-000000021303';
const playerB = '00000000-0000-0000-0000-000000021304';
const actor: BotActorContext = {
  guildId: '999999999999999999',
  discordUserId: '111111111111111111',
  interactionId: '888888888888888888',
  clientSource: 'DISCORD_BOT'
};
const secret = 'review-state-secret-that-survives-a-restart';

describe('M21-US-03 Discord low-click order review center', () => {
  test('replaces the completed-card support-only entry with one optional service-review entry', async () => {
    const message = buildServiceLifecyclePanelMessage({
      orderId,
      publicId: 'P-M21-REVIEW',
      status: 'COMPLETED',
      version: 10,
      actorRole: 'CUSTOMER',
      availableActions: [],
      readiness: {
        participants: [],
        allActivePlayersReady: true,
        readyDeadlineAt: null,
        startedAt: null,
        staffTaskId: null
      }
    });
    expect(JSON.stringify(message.components)).toContain(`bc:r:${orderId}:o`);
    expect(JSON.stringify(message.components)).toContain('评价本次服务');

    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: '777777777777777777' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    await new DiscordRestWorkerAdapter({ token: 'token', fetch }).upsertOrderPanel(
      {
        orderId,
        publicId: 'P-M21-REVIEW',
        status: 'COMPLETED',
        version: 10,
        channelId: '777777777777777777',
        panelMessageId: '666666666666666666',
        customerDiscordUserId: actor.discordUserId,
        playerDiscordUserId: null,
        amountMinor: 100,
        currency: 'CAT',
        experienceReviewEligible: true
      },
      '2026-08-13T06:00:00.000Z'
    );
    const body = JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(JSON.stringify(body)).toContain(`bc:r:${orderId}:o`);
    expect(JSON.stringify(body)).not.toContain('support-rating');
  });

  test('opens with five one-click overall scores and optional multi-target controls', () => {
    const message = buildOrderExperienceReviewMessage(center(), actor, secret);
    expect(() => assertDiscordMessageSpec(message)).not.toThrow();
    const components = message.components.flatMap((row) => (row.type === 'ACTION_ROW' ? row.components : []));
    const overall = components.filter(
      (item) => item.type === 'BUTTON' && item.customId.startsWith(`bc:r:${orderId}:o`)
    );
    expect(overall).toHaveLength(5);
    expect(message.body).toContain('所有评价均为可选');
    expect(message.body).toContain('点击星级即保存');
    expect(components).toContainEqual(
      expect.objectContaining({ type: 'STRING_SELECT', maxValues: 3, placeholder: expect.stringContaining('可选') })
    );
    expect(parseServiceCenterCustomId(overall[4]!.customId)).toMatchObject({
      area: 'experience-review',
      action: 'overall',
      orderId,
      score: 5
    });
  });

  test('keeps selected targets in signed restart-safe state and saves low scores without a reason step', async () => {
    const initial = center();
    const selected = [`player:${playerA}`, `player:${playerB}`];
    const state = createReviewSelectionState(initial, selected, actor, secret);
    expect(readReviewSelectionState(initial, state, actor, secret)).toEqual(selected);
    expect(() =>
      readReviewSelectionState(initial, state, { ...actor, discordUserId: '222222222222222222' }, secret)
    ).toThrow(/state/i);
    expect(() => readReviewSelectionState(initial, `${state}x`, actor, secret)).toThrow(/state/i);

    const selectedMessage = buildOrderExperienceReviewMessage(initial, actor, secret, { selectedTargetKeys: selected });
    const scoreButton = selectedMessage.components
      .flatMap((row) => (row.type === 'ACTION_ROW' ? row.components : []))
      .find((item) => item.type === 'BUTTON' && item.customId.includes(':s1:'));
    if (!scoreButton || scoreButton.type !== 'BUTTON') throw new Error('score button missing');
    const route = parseServiceCenterCustomId(scoreButton.customId);
    expect(route).toMatchObject({ area: 'experience-review', action: 'rate', score: 1 });

    const saved = center({
      reviews: new Map([
        [`player:${playerA}`, review(`player:${playerA}`, 'PLAYER', 1, playerA)],
        [`player:${playerB}`, review(`player:${playerB}`, 'PLAYER', 1, playerB)]
      ])
    });
    const events: string[] = [];
    const api = {
      getOrderExperienceReview: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(saved),
      createOrderExperienceRatings: vi.fn(async () => {
        events.push('api-write');
        return [];
      })
    } as unknown as BotApiClient;
    const interaction = {
      id: actor.interactionId,
      deferUpdate: vi.fn(async () => void events.push('ack')),
      editReply: vi.fn(async () => void events.push('edit')),
      followUp: vi.fn()
    };
    if (route.area !== 'experience-review') throw new Error('route mismatch');
    await executeOrderExperienceReviewButton({ interaction, route, actor, api, secret });

    expect(events).toEqual(['ack', 'api-write', 'edit']);
    expect(api.createOrderExperienceRatings).toHaveBeenCalledWith(
      orderId,
      { targetKeys: selected, score: 1 },
      actor,
      expect.stringContaining('review:rating')
    );
  });

  test('paginates more than 25 targets without process memory and keeps comments optional', async () => {
    const large = center({ playerCount: 30 });
    const first = buildOrderExperienceReviewMessage(large, actor, secret);
    expect(() => assertDiscordMessageSpec(first)).not.toThrow();
    const firstComponents = first.components.flatMap((row) => (row.type === 'ACTION_ROW' ? row.components : []));
    const targetSelect = firstComponents.find((item) => item.type === 'STRING_SELECT');
    expect(targetSelect).toMatchObject({ type: 'STRING_SELECT', options: expect.any(Array) });
    if (!targetSelect || targetSelect.type !== 'STRING_SELECT') throw new Error('target select missing');
    expect(targetSelect.options).toHaveLength(25);
    expect(parseServiceCenterCustomId(targetSelect.customId)).toMatchObject({
      area: 'experience-review-target-select',
      orderId,
      page: 0
    });
    const next = firstComponents.find((item) => item.type === 'BUTTON' && item.label === '下一页');
    expect(next).toBeDefined();
    if (!next || next.type !== 'BUTTON') throw new Error('next button missing');
    expect(parseServiceCenterCustomId(next.customId)).toMatchObject({
      area: 'experience-review',
      action: 'page',
      orderId,
      page: 1
    });

    const commentedCenter = center({
      reviews: new Map([['order', review('order', 'ORDER', 5)]])
    });
    const message = buildOrderExperienceReviewMessage(commentedCenter, actor, secret);
    const commentSelect = message.components
      .flatMap((row) => (row.type === 'ACTION_ROW' ? row.components : []))
      .find((item) => item.type === 'STRING_SELECT' && item.customId === `bc:r:${orderId}:c`);
    expect(commentSelect).toBeDefined();
    const route = parseServiceCenterCustomId(`bc:r:${orderId}:c`);
    const interaction = { values: [reviewId], showModal: vi.fn() };
    if (route.area !== 'experience-review-comment-select') throw new Error('route mismatch');
    await executeOrderExperienceReviewSelect({ interaction, route, actor, api: {} as BotApiClient, secret });
    expect(interaction.showModal).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ custom_id: `bc:rc:${orderId}:${reviewId}` }) })
    );

    const modalRoute = parseServiceCenterCustomId(`bc:rc:${orderId}:${reviewId}`);
    const appendOrderExperienceReviewComment = vi.fn().mockResolvedValue(review('order', 'ORDER', 5, null, '收到'));
    const api = {
      appendOrderExperienceReviewComment,
      getOrderExperienceReview: vi
        .fn()
        .mockResolvedValue(center({ reviews: new Map([['order', review('order', 'ORDER', 5, null, '收到')]]) }))
    } as unknown as BotApiClient;
    const modal = {
      id: '999999999999999999',
      deferUpdate: vi.fn(),
      editReply: vi.fn(),
      followUp: vi.fn(),
      fields: { getTextInputValue: vi.fn().mockReturnValue('收到') }
    };
    if (modalRoute.area !== 'experience-review-comment-modal') throw new Error('modal route mismatch');
    await executeOrderExperienceReviewModal({ interaction: modal, route: modalRoute, actor, api, secret });
    expect(appendOrderExperienceReviewComment).toHaveBeenCalledOnce();
    expect(modal.deferUpdate).toHaveBeenCalledOnce();
    expect(modal.editReply).toHaveBeenCalledOnce();
  });

  test('refreshes current API facts after a stale score click and does not replay the old intent', async () => {
    const current = center({ reviews: new Map([['order', review('order', 'ORDER', 4)]]) });
    const api = {
      getOrderExperienceReview: vi.fn().mockResolvedValueOnce(center()).mockResolvedValueOnce(current),
      createOrderExperienceRatings: vi.fn().mockRejectedValue(
        new BotApiError({
          code: 'CONFLICT',
          message: 'already rated',
          requestId: 'req-review-stale',
          statusCode: 409
        })
      )
    } as unknown as BotApiClient;
    const interaction = {
      id: actor.interactionId,
      deferUpdate: vi.fn(),
      editReply: vi.fn(),
      followUp: vi.fn()
    };
    await executeOrderExperienceReviewButton({
      interaction,
      route: { area: 'experience-review', action: 'overall', orderId, score: 5 },
      actor,
      api,
      secret
    });
    expect(api.createOrderExperienceRatings).toHaveBeenCalledOnce();
    expect(api.getOrderExperienceReview).toHaveBeenCalledTimes(2);
    expect(interaction.editReply).toHaveBeenCalledOnce();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: expect.stringContaining('request_id: req-review-stale'),
      ephemeral: true
    });
  });

  test('wires real Sapphire button, select and modal adapters to the review executors', async () => {
    const [buttons, selects, modals] = await Promise.all(
      [
        'apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts',
        'apps/bot/src/pieces/interaction-handlers/order-selects.ts',
        'apps/bot/src/pieces/interaction-handlers/service-center-modals.ts'
      ].map((path) => readFile(path, 'utf8'))
    );
    expect(buttons).toContain('executeOrderExperienceReviewButton');
    expect(selects).toContain('executeOrderExperienceReviewSelect');
    expect(modals).toContain('executeOrderExperienceReviewModal');
  });

  test('uses the unified review API with actor context, idempotency and fail-closed DTO validation', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(envelope(center()))
      .mockResolvedValueOnce(envelope([review('order', 'ORDER', 5)]))
      .mockResolvedValueOnce(envelope(review('order', 'ORDER', 5, null, '很好')))
      .mockResolvedValueOnce(envelope({ orderId, targets: 'invalid' }));
    const api = new HttpBotApiClient({
      apiBaseUrl: 'https://api.example.test',
      botServiceToken: 'x'.repeat(40),
      fetch
    });
    await api.getOrderExperienceReview(orderId, actor);
    await api.createOrderExperienceRatings(orderId, { targetKeys: ['order'], score: 5 }, actor, 'rating-key');
    await api.appendOrderExperienceReviewComment(orderId, reviewId, { comment: '很好' }, actor, 'comment-key');
    await expect(api.getOrderExperienceReview(orderId, actor)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      statusCode: 502
    });

    expect(fetch.mock.calls[0]![0]).toBe(`https://api.example.test/api/v1/orders/${orderId}/experience-review`);
    expect(fetch.mock.calls[1]![1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'idempotency-key': 'rating-key' }),
      body: JSON.stringify({ targetKeys: ['order'], score: 5 })
    });
    expect(fetch.mock.calls[2]![0]).toBe(
      `https://api.example.test/api/v1/orders/${orderId}/experience-ratings/${reviewId}/comment`
    );
  });

  test('requires an explicitly configured review state secret to be cryptographically sized', () => {
    expect(() =>
      createBotRuntimeDependencies({
        apiBaseUrl: 'https://api.example.test',
        botServiceToken: 'x'.repeat(40),
        reviewContinuationSigningSecret: 'short'
      })
    ).toThrow(/at least 32/i);
  });
});

function center(
  input: { reviews?: Map<string, ReturnType<typeof review>>; playerCount?: number } = {}
): OrderExperienceReviewCenter {
  const players = Array.from({ length: input.playerCount ?? 2 }, (_, index) => {
    const id =
      index === 0
        ? playerA
        : index === 1
          ? playerB
          : `00000000-0000-0000-0000-${String(21305 + index).padStart(12, '0')}`;
    const targetKey = `player:${id}`;
    return {
      targetKey,
      targetType: 'PLAYER' as const,
      displayName: `陪玩 ${index + 1}`,
      review: input.reviews?.get(targetKey) ?? null
    };
  });
  return {
    orderId,
    orderPublicId: 'P-M21-REVIEW',
    expiresAt: '2026-08-14T06:00:00.000Z',
    targets: [
      {
        targetKey: 'order',
        targetType: 'ORDER',
        displayName: '订单整体',
        review: input.reviews?.get('order') ?? null
      },
      ...players,
      {
        targetKey: 'support:00000000-0000-0000-0000-000000021399',
        targetType: 'SUPPORT',
        displayName: '猫舍前台',
        review: input.reviews?.get('support:00000000-0000-0000-0000-000000021399') ?? null
      }
    ],
    hasPublishableFiveStar: [...(input.reviews?.values() ?? [])].some((item) => item.score === 5),
    publication: null
  };
}

function review(
  targetKey: string,
  targetType: 'ORDER' | 'PLAYER' | 'SUPPORT',
  score: number,
  orderParticipantId: string | null = null,
  comment?: string
) {
  return {
    id: reviewId,
    orderId,
    targetKey,
    targetType,
    orderParticipantId,
    attributedStaffId: null,
    score,
    comment: comment
      ? { id: '00000000-0000-0000-0000-000000021398', comment, createdAt: '2026-08-13T06:01:00.000Z' }
      : null,
    createdAt: '2026-08-13T06:00:00.000Z'
  };
}

function envelope(data: unknown) {
  return new Response(JSON.stringify({ requestId: 'req-review', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
