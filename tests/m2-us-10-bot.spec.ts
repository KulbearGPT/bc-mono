import { describe, expect, test, vi } from 'vitest';
import {
  BotApiError,
  buildCancellationPreviewMessage,
  handleConfirmCancellation,
  handleOpenCancellationPreview,
  parseServiceCenterCustomId,
  type BotApiClient,
  type BotActorContext,
  type CancellationPreviewSummary
} from '@blackcat/bot/service-center';

const orderId = '00000000-0000-0000-0000-00000000ba10';
const previewId = '00000000-0000-0000-0000-00000000ca10';
const actor: BotActorContext = {
  guildId: '999999999999999999', discordUserId: '111111111111111111', interactionId: '777777777777777777', clientSource: 'DISCORD_BOT'
};
const preview: CancellationPreviewSummary = {
  previewId, orderId, orderVersion: 3, automaticallyProcessable: true, fundAction: 'RELEASE_RESERVATION',
  estimatedAmountMinor: 12000, releaseAmountMinor: 12000, refundAmountMinor: 0, currency: 'CAT',
  handlingTimeCode: 'IMMEDIATE', staffTaskRequired: false, validUntil: '2026-07-18T08:01:00.000Z'
};

describe('M2-US-10 Bot cancellation preview flow', () => {
  test('renders API-provided impact and requires a second explicit confirmation', () => {
    const message = buildCancellationPreviewMessage(preview);
    expect(message.title).toContain('取消影响确认');
    expect(message.body).toContain('释放预留：1,200.0 CAT');
    expect(message.body).toContain('退款：0.0 CAT');
    const controls = message.components.flatMap((row) => row.components);
    expect(controls.map((component) => component.customId)).toEqual([
      `bc:cancel:${orderId}:${previewId}:confirm:v3`,
      `bc:order:${orderId}:refresh`
    ]);
    expect(controls).toContainEqual(expect.objectContaining({
      type: 'BUTTON',
      style: 'SECONDARY',
      label: '暂不取消，返回订单'
    }));
  });

  test('opens preview through API and does not calculate money in the Bot', async () => {
    const api = { previewOrderCancellation: vi.fn().mockResolvedValue(preview) } as unknown as BotApiClient;
    const result = await handleOpenCancellationPreview({
      api, actor, orderId, expectedVersion: 3, idempotencyKey: 'discord:cancel-preview:one'
    });
    expect(api.previewOrderCancellation).toHaveBeenCalledWith(
      orderId, { expectedVersion: 3, reasonCode: 'CUSTOMER_REQUEST' }, actor, 'discord:cancel-preview:one'
    );
    expect(result.kind).toBe('EDIT_ORIGINAL_MESSAGE');
  });

  test('confirms with the preview id and replaces a stale preview without executing a second cancellation', async () => {
    const successApi = { cancelOrder: vi.fn().mockResolvedValue({ orderId, status: 'CANCELLED', fundAction: 'RELEASE_RESERVATION' }) } as unknown as BotApiClient;
    const success = await handleConfirmCancellation({
      api: successApi, actor, orderId, previewId, expectedVersion: 3, idempotencyKey: 'discord:cancel-confirm:one'
    });
    expect(successApi.cancelOrder).toHaveBeenCalledWith(
      orderId,
      { expectedVersion: 3, previewId, reasonCode: 'CUSTOMER_REQUEST' },
      actor,
      'discord:cancel-confirm:one'
    );
    expect(success.kind).toBe('EPHEMERAL_MESSAGE');

    const refreshedPreview = {
      ...preview,
      previewId: '00000000-0000-0000-0000-00000000ca11',
      orderVersion: 4,
      validUntil: '2026-07-18T08:02:00.000Z'
    };
    const staleApi = {
      cancelOrder: vi.fn().mockRejectedValue(new BotApiError({
        code: 'CANCELLATION_PREVIEW_STALE', message: 'stale', requestId: 'req-stale', statusCode: 409
      })),
      getOrder: vi.fn().mockResolvedValue({ version: 4 }),
      previewOrderCancellation: vi.fn().mockResolvedValue(refreshedPreview)
    } as unknown as BotApiClient;
    const stale = await handleConfirmCancellation({
      api: staleApi, actor, orderId, previewId, expectedVersion: 3, idempotencyKey: 'discord:cancel-confirm:stale'
    });
    expect(stale).toMatchObject({ kind: 'EDIT_ORIGINAL_MESSAGE' });
    expect(stale.kind === 'EDIT_ORIGINAL_MESSAGE' ? JSON.stringify(stale.message) : '').toContain(
      `bc:cancel:${orderId}:${refreshedPreview.previewId}:confirm:v4`
    );
    expect(stale.kind === 'EDIT_ORIGINAL_MESSAGE' ? stale.notice : '').toContain('已经刷新');
    expect(staleApi.getOrder).toHaveBeenCalledWith(orderId, actor);
    expect(staleApi.previewOrderCancellation).toHaveBeenCalledWith(
      orderId,
      { expectedVersion: 4, reasonCode: 'CUSTOMER_REQUEST' },
      actor,
      'discord:cancel-confirm:stale:refresh-preview'
    );
    expect(staleApi.cancelOrder).toHaveBeenCalledTimes(1);
  });

  test('parses a confirmation id containing both order and preview versions', () => {
    expect(parseServiceCenterCustomId(`bc:cancel:${orderId}:${previewId}:confirm:v3`)).toEqual({
      area: 'cancellation-action', action: 'confirm', orderId, previewId, expectedVersion: 3
    });
  });
});
