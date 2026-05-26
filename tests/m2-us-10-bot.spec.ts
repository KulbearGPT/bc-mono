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
  estimatedAmountMinor: 12000, releaseAmountMinor: 12000, refundAmountMinor: 0, currency: 'USD',
  handlingTimeCode: 'IMMEDIATE', staffTaskRequired: false, validUntil: '2026-07-18T08:01:00.000Z'
};

describe('M2-US-10 Bot cancellation preview flow', () => {
  test('renders API-provided impact and requires a second explicit confirmation', () => {
    const message = buildCancellationPreviewMessage(preview);
    expect(message.title).toContain('取消影响确认');
    expect(message.body).toContain('释放预留：USD\u00a0120.00');
    expect(message.body).toContain('退款：USD\u00a00.00');
    expect(message.components.flatMap((row) => row.components).map((component) => component.customId)).toEqual([
      `bc:cancel:${orderId}:${previewId}:confirm:v3`,
      'bc:entry:service-center'
    ]);
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

  test('confirms with the preview id and reports stale previews without retrying locally', async () => {
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

    const staleApi = { cancelOrder: vi.fn().mockRejectedValue(new BotApiError({
      code: 'CANCELLATION_PREVIEW_STALE', message: 'stale', requestId: 'req-stale', statusCode: 409
    })) } as unknown as BotApiClient;
    const stale = await handleConfirmCancellation({
      api: staleApi, actor, orderId, previewId, expectedVersion: 3, idempotencyKey: 'discord:cancel-confirm:stale'
    });
    expect(stale).toMatchObject({ kind: 'EPHEMERAL_MESSAGE' });
    expect(stale.kind === 'EPHEMERAL_MESSAGE' ? stale.message : '').toContain('请刷新取消预览');
  });

  test('parses a confirmation id containing both order and preview versions', () => {
    expect(parseServiceCenterCustomId(`bc:cancel:${orderId}:${previewId}:confirm:v3`)).toEqual({
      area: 'cancellation-action', action: 'confirm', orderId, previewId, expectedVersion: 3
    });
  });
});
