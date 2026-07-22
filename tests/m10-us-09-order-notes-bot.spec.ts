import { describe, expect, test, vi } from 'vitest';
import {
  buildGameOrderingMenuMessage,
  buildMultiProjectOrderConfirmationMessage,
  buildOrderNotesModal,
  handleOrderNotesSubmit,
  parseServiceCenterCustomId,
  type BotActorContext,
  type BotApiClient,
  type OrderSummary,
  type PublicServiceSummary
} from '@blackcat/bot/service-center';
import { toDiscordReply } from '../apps/bot/src/discord-renderer';

const orderId = '00000000-0000-0000-0000-000000109001';

describe('M10-US-09 game menu order requirement note', () => {
  test('offers a recoverable modal button and shows the saved requirement note on step two', () => {
    const message = buildGameOrderingMenuMessage(
      order({ notes: '希望轻松聊天，不急着上分' }),
      'VALORANT',
      [service],
      { items: [], nextCursor: null }
    );

    expect(message.title).toContain('第 2/4 步');
    expect(message.body).toContain('需求备注：希望轻松聊天，不急着上分');
    expect(JSON.stringify(message.components)).toContain('修改需求备注');
    expect(parseServiceCenterCustomId(`bc:omno:${orderId}:VALORANT:v7`)).toEqual({
      area: 'order-menu-notes-open',
      orderId,
      game: 'VALORANT',
      expectedVersion: 7
    });
    const container = toDiscordReply(message).components?.[0] as { toJSON?: () => unknown };
    expect(() => container.toJSON?.()).not.toThrow();
  });

  test('encodes the selected game in the modal so submit can return to the same menu', () => {
    const modal = buildOrderNotesModal({ orderId, expectedVersion: 7, returnGame: 'VALORANT' });

    expect(modal.title).toBe('📝 填写需求备注');
    expect(modal.customId).toBe(`bc:omn:${orderId}:VALORANT:v7`);
    expect(parseServiceCenterCustomId(modal.customId)).toEqual({
      area: 'order-menu-notes-modal',
      orderId,
      game: 'VALORANT',
      expectedVersion: 7
    });
  });

  test('saves through the unified API and returns to the selected game menu', async () => {
    const actor: BotActorContext = {
      guildId: '999999999999999999',
      discordUserId: '111111111111111111',
      interactionId: '222222222222222222',
      clientSource: 'DISCORD_BOT'
    };
    const updated = order({ version: 8, notes: '只想轻松聊天' });
    const api = {
      updateOrder: vi.fn().mockResolvedValue(updated),
      listServices: vi.fn().mockResolvedValue({ items: [service] }),
      listServicePackages: vi.fn().mockResolvedValue({ items: [], nextCursor: null })
    } as unknown as BotApiClient;

    const result = await handleOrderNotesSubmit({
      api,
      actor,
      orderId,
      expectedVersion: 7,
      notes: '只想轻松聊天',
      returnGame: 'VALORANT',
      idempotencyKey: 'discord:order:menu:notes:0001'
    });

    expect(api.updateOrder).toHaveBeenCalledWith(
      orderId,
      { expectedVersion: 7, notes: '只想轻松聊天' },
      actor,
      'discord:order:menu:notes:0001'
    );
    expect(api.listServices).toHaveBeenCalledWith(actor, 'VALORANT');
    expect(api.listServicePackages).toHaveBeenCalledWith(actor, undefined, 25, 'VALORANT');
    expect(result.kind).toBe('EDIT_ORIGINAL_MESSAGE');
    if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
      expect(result.message.title).toContain('第 2/4 步');
      expect(result.message.body).toContain('需求备注：只想轻松聊天');
    }
  });

  test('keeps the order-level requirement note visible at final confirmation', () => {
    const message = buildMultiProjectOrderConfirmationMessage({
      order: order({ notes: '希望轻松聊天，不急着上分' }),
      requirements: {
        orderId,
        orderVersion: 7,
        catalogSubtotalMinor: 0,
        packageAdjustmentMinor: 0,
        derivedTotalMinor: 0,
        currency: 'CAT',
        items: [],
        nextCursor: null
      },
      balance: {
        ledgerBalanceMinor: 1_000,
        reservedMinor: 0,
        availableMinor: 1_000,
        currency: 'CAT',
        calculatedAt: '2026-08-08T00:00:00Z'
      }
    });

    expect(message.body).toContain('需求备注：希望轻松聊天，不急着上分');
  });

  test('refreshes a stale note modal back to the same game without overwriting newer notes', async () => {
    const actor: BotActorContext = {
      guildId: '999999999999999999',
      discordUserId: '111111111111111111',
      interactionId: '222222222222222222',
      clientSource: 'DISCORD_BOT'
    };
    const api = {
      updateOrder: vi.fn().mockRejectedValue({ code: 'CONFLICT', requestId: 'req-note-conflict' }),
      getOrder: vi.fn().mockResolvedValue(order({ version: 8, notes: '另一个窗口已保存的需求' })),
      listServices: vi.fn().mockResolvedValue({ items: [service] }),
      listServicePackages: vi.fn().mockResolvedValue({ items: [], nextCursor: null })
    } as unknown as BotApiClient;

    const result = await handleOrderNotesSubmit({
      api,
      actor,
      orderId,
      expectedVersion: 7,
      notes: '过期窗口的内容',
      returnGame: 'VALORANT',
      idempotencyKey: 'discord:order:menu:notes:conflict'
    });

    expect(result.kind).toBe('EDIT_ORIGINAL_MESSAGE');
    if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
      expect(result.message.title).toContain('第 2/4 步');
      expect(result.message.body).toContain('需求备注：另一个窗口已保存的需求');
      expect(result.notice).toContain('request_id: req-note-conflict');
    }
  });
});

function order(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: orderId,
    publicId: 'P-NOTE-001',
    status: 'DRAFT',
    version: 7,
    orderType: 'IMMEDIATE',
    serviceCatalogId: null,
    catalogVersion: null,
    game: null,
    gameDisplayName: null,
    service: null,
    serviceDisplayName: null,
    region: null,
    regionDisplayName: null,
    billingUnitMinutes: null,
    unitCount: null,
    amountMinor: 0,
    currency: 'CAT',
    notes: null,
    channelSpec: {
      guildId: '999999999999999999',
      channelId: '333333333333333333',
      panelMessageId: null,
      voiceChannelId: null
    },
    matching: null,
    compositionMode: 'CUSTOMIZED',
    sourcePackageVersionId: null,
    ...overrides
  };
}

const service: PublicServiceSummary = {
  id: '00000000-0000-0000-0000-000000109101',
  game: 'VALORANT',
  gameDisplayName: '瓦洛兰特',
  service: 'FUN',
  serviceDisplayName: '娱乐陪玩',
  region: null,
  regionDisplayName: null,
  billingUnitMinutes: 60,
  minimumUnits: 1,
  customerUnitPriceMinor: 200,
  currency: 'CAT',
  version: 1
};
