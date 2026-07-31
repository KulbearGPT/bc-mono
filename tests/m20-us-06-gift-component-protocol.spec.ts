import { describe, expect, test, vi } from 'vitest';
import { toDiscordUpdate } from '../apps/bot/src/discord-renderer';
import {
  buildGiftAffordabilityMessage,
  createGiftContinuationToken,
  type GiftAffordabilityResult,
  type GiftPanelData,
  type GiftRequestResult
} from '@blackcat/bot/gifts';
import { executeGiftButton } from '../apps/bot/src/service-center-gift-interactions';
import type { BotActorContext, BotApiClient } from '@blackcat/bot/service-center';

const orderId = '11111111-1111-4111-8111-111111111111';
const giftId = '22222222-2222-4222-8222-222222222222';
const participants = [
  { participantId: '33333333-3333-4333-8333-333333333333', playerId: 'player-a', displayName: '阿岚' },
  { participantId: '44444444-4444-4444-8444-444444444444', playerId: 'player-b', displayName: '奶糖' }
];
const actor: BotActorContext = {
  guildId: 'guild-1',
  discordUserId: 'customer-1',
  interactionId: 'open-1',
  clientSource: 'DISCORD_BOT'
};
const secret = 'm20-us-06-gift-component-secret-32-bytes';
const affordability: GiftAffordabilityResult = {
  giftCatalogVersionId: giftId,
  catalogVersion: 3,
  priceMinor: 100,
  recipientCount: 2,
  totalPriceMinor: 200,
  ledgerBalanceMinor: 1_000,
  reservedMinor: 0,
  availableMinor: 1_000,
  shortfallMinor: 0,
  currency: 'CAT',
  calculatedAt: '2026-08-11T00:00:00.000Z',
  stale: false,
  canAfford: true,
  topUpInstructions: '联系猫舍前台充值。'
};
const catalog: GiftPanelData = {
  orderId,
  orderPublicId: 'P-M20-GIFT',
  receiver: { userId: 'derived', displayName: '订单陪玩' },
  recipients: participants,
  balance: {
    ledgerBalanceMinor: 1_000,
    reservedMinor: 0,
    availableMinor: 1_000,
    currency: 'CAT',
    calculatedAt: affordability.calculatedAt
  },
  items: [
    {
      id: giftId,
      code: 'HEART',
      name: '小心意',
      version: 3,
      priceMinor: 100,
      currency: 'CAT',
      affordable: true
    }
  ]
};
const created: GiftRequestResult = {
  unitPriceMinor: 100,
  recipientCount: 2,
  totalAmountMinor: 200,
  items: []
};

describe('M20-US-06 gift selected-recipient component protocol', () => {
  test('confirms the participants carried by the real affordability renderer', async () => {
    const { interaction, editReply, followUp } = renderedInteraction('confirm');
    const api = giftApi();

    await executeGiftButton({
      interaction: interaction as never,
      route: { area: 'gift', action: 'confirm', token: continuationToken() },
      actor,
      api: api as never,
      secret: () => secret
    });

    expect(api.createOrderGiftRequest).toHaveBeenCalledWith(
      orderId,
      expect.objectContaining({ participantIds: participants.map((item) => item.participantId) }),
      actor,
      'discord:gift:confirm:interaction-confirm'
    );
    expect(editReply).toHaveBeenCalledOnce();
    expect(followUp).not.toHaveBeenCalled();
  });

  test('refreshes affordability with the participants carried by the real renderer', async () => {
    const { interaction, editReply, followUp } = renderedInteraction('refresh');
    const api = giftApi();

    await executeGiftButton({
      interaction: interaction as never,
      route: { area: 'gift', action: 'refresh', token: continuationToken() },
      actor,
      api: api as never,
      secret: () => secret
    });

    expect(api.checkGiftAffordability).toHaveBeenCalledWith(
      orderId,
      giftId,
      participants.map((item) => item.participantId),
      actor
    );
    expect(api.createOrderGiftRequest).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledOnce();
    expect(followUp).not.toHaveBeenCalled();
  });

  test('returns to the catalog with the participants carried by the real renderer', async () => {
    const { interaction, editReply, followUp } = renderedInteraction('back');
    const api = giftApi();

    await executeGiftButton({
      interaction: interaction as never,
      route: { area: 'gift', action: 'back', token: continuationToken() },
      actor,
      api: api as never,
      secret: () => secret
    });

    expect(api.getOrder).toHaveBeenCalledWith(orderId, actor);
    expect(api.listGifts).toHaveBeenCalledWith(orderId, actor);
    expect(api.checkGiftAffordability).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledOnce();
    expect(followUp).not.toHaveBeenCalled();
  });

  test('reports a missing local component context as a confirmed zero-write failure', async () => {
    const followUp = vi.fn().mockResolvedValue(undefined);
    const api = giftApi();
    const interaction = {
      id: 'interaction-missing-context',
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      message: { toJSON: () => ({ components: [] }) },
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp
    };

    await executeGiftButton({
      interaction: interaction as never,
      route: { area: 'gift', action: 'confirm', token: continuationToken() },
      actor,
      api: api as never,
      secret: () => secret
    });

    expect(api.checkGiftAffordability).not.toHaveBeenCalled();
    expect(api.createOrderGiftRequest).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('本次未向业务 API 发起写请求')
      })
    );
  });
});

function continuationToken() {
  return createGiftContinuationToken(
    { orderId, orderVersion: 7, giftCatalogVersionId: giftId, catalogVersion: 3, priceMinor: 100 },
    actor,
    secret
  );
}

function renderedInteraction(action: string) {
  const message = buildGiftAffordabilityMessage(
    affordability,
    continuationToken(),
    participants.map(({ participantId, displayName }) => ({ participantId, displayName }))
  );
  const rendered = toDiscordUpdate(message);
  const components = JSON.parse(JSON.stringify(rendered.components));
  const editReply = vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  return {
    editReply,
    followUp,
    interaction: {
      id: `interaction-${action}`,
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      message: { toJSON: () => ({ components }) },
      editReply,
      followUp
    }
  };
}

function giftApi(): Partial<BotApiClient> & Record<string, ReturnType<typeof vi.fn>> {
  return {
    getOrder: vi.fn().mockResolvedValue({ id: orderId, version: 8 }),
    listGifts: vi.fn().mockResolvedValue(catalog),
    checkGiftAffordability: vi.fn().mockResolvedValue(affordability),
    createOrderGiftRequest: vi.fn().mockResolvedValue(created)
  };
}
