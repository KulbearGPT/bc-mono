import { describe, expect, test, vi } from 'vitest';
import { BotApiError, type BotActorContext, type BotApiClient } from '@blackcat/bot/service-center-api';
import { handleServiceLifecycleAction } from '@blackcat/bot/service-center';

const actor: BotActorContext = {
  guildId: 'guild-m20',
  discordUserId: 'player-m20',
  interactionId: 'interaction-m20',
  clientSource: 'DISCORD_BOT'
};

describe('M20-US-07 stale readiness recovery', () => {
  test('performs no second write and refreshes the latest order after a version conflict', async () => {
    const conflict = new BotApiError({
      code: 'CONFLICT',
      message: 'Order version is stale.',
      requestId: 'req-stale-ready-m20',
      statusCode: 409
    });
    const setOrderReadiness = vi.fn().mockRejectedValue(conflict);
    const getOrder = vi.fn().mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      publicId: 'P-M20-READY',
      status: 'ACCEPTED',
      version: 8,
      game: 'VALORANT',
      gameDisplayName: '瓦洛兰特',
      service: 'FUN',
      serviceDisplayName: '娱乐陪玩',
      region: null,
      billingUnitMinutes: 60,
      unitCount: 2,
      amountMinor: 400,
      currency: 'CAT',
      notes: null,
      channelSpec: { channelId: 'channel', panelMessageId: 'panel', voiceChannelId: 'voice' },
      matching: null,
      availableActions: [
        { key: 'PLAYER_SET_READY', role: 'PLAYER', enabled: true, risk: 'PRIMARY', reasonCode: null }
      ]
    });
    const api = { setOrderReadiness, getOrder } as Partial<BotApiClient> as BotApiClient;

    const result = await handleServiceLifecycleAction({
      api,
      actor,
      orderId: '11111111-1111-4111-8111-111111111111',
      action: 'ready',
      expectedVersion: 7,
      idempotencyKey: 'discord:service:ready:stale-m20'
    });

    expect(setOrderReadiness).toHaveBeenCalledOnce();
    expect(setOrderReadiness).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      { expectedVersion: 7, readiness: 'READY' },
      actor,
      'discord:service:ready:stale-m20'
    );
    expect(getOrder).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      kind: 'EDIT_ORIGINAL_MESSAGE',
      message: { title: expect.stringContaining('P-M20-READY') },
      notice: expect.stringContaining('req-stale-ready-m20')
    });
  });
});
