import { access } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { buildOnboardingMessage } from '@blackcat/bot/onboarding';
import {
  buildGameOrderingMenuMessage,
  buildGamePickerMessage,
  buildMultiProjectOrderConfirmationMessage,
  buildPublicServiceEntryMessage,
  type OrderRequirementPageSummary,
  type OrderSummary,
  type PublicServiceSummary
} from '@blackcat/bot/service-center';
import { resolveGameBanner } from '../apps/bot/src/game-banners.js';
import { toDiscordReply } from '../apps/bot/src/discord-renderer.js';

const orderId = '00000000-0000-0000-0000-000000180301';

describe('M18-US-03 onboarding and order composer experience', () => {
  test('turns the persistent onboarding entry into a rich brand embed with three stable actions', () => {
    const payload = buildOnboardingMessage();
    const embed = payload.embeds?.[0] as { toJSON?: () => Record<string, unknown> } | undefined;
    const json = embed?.toJSON?.() as { title?: string; fields?: Array<{ name: string }>; footer?: { text: string } };

    expect(payload.content).toBeUndefined();
    expect(json.title).toBe('🐈‍⬛ 欢迎来到黑猫陪玩');
    expect(json.fields?.map((field) => field.name)).toEqual(['🎮 想找陪玩', '🎧 想加入猫舍', '🛎️ 需要真人帮助']);
    expect(json.footer?.text).toContain('黑猫陪玩');
    const row = payload.components?.[0]?.toJSON();
    expect(row?.components.map((component) => component.label)).toEqual([
      '🐾 注册为玩家',
      '🎧 申请成为陪玩',
      '🎮 开始找陪玩'
    ]);
  });

  test('gives the public service entry welcome density and one clear next step per action', () => {
    const message = buildPublicServiceEntryMessage();
    expect(message.density).toBe('PUBLIC_WELCOME');
    expect(message.tone).toBe('BRAND');
    expect(message.fields?.map((field) => field.name)).toEqual(['🎮 创建新订单', '🐾 继续当前旅程', '🛎️ 下单前请留意']);
    expect(message.body).toContain('今晚想玩什么');
    expect(message.body).not.toContain('下单前请留意');
  });

  test('keeps four-step progress visible and isolates the boss request in its own field', () => {
    const picker = buildGamePickerMessage(order(), [service()]);
    expect(picker.density).toBe('PRIVATE_ORDER');
    expect(picker.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '🧭 下单进度', value: '第 1/4 步 · 选择游戏' }),
        expect.objectContaining({ name: '👉 下一步' })
      ])
    );

    const menu = buildGameOrderingMenuMessage(order({ notes: '希望声音温柔，主玩辅助。' }), 'LOLNA', [service()], {
      items: [],
      nextCursor: null
    });
    expect(menu.fields?.map((field) => field.name)).toEqual(['🧭 下单进度', '📚 当前目录', '💬 老板需求', '👉 下一步']);
    expect(menu.fields?.find((field) => field.name === '💬 老板需求')?.value).toBe('> 希望声音温柔，主玩辅助。');
    expect(menu.body).not.toContain('希望声音温柔');
    expect(menu.components[0]).toMatchObject({ type: 'V2_MEDIA' });
    expect(menu.attachments?.[0]?.name).toBe('blackcat-game-league-of-legends.png');
    const reply = toDiscordReply(menu);
    const container = reply.components?.[0] as { toJSON?: () => unknown };
    expect(JSON.stringify(container.toJSON?.())).toContain('attachment://blackcat-game-league-of-legends.png');
    expect(reply.files).toEqual([expect.objectContaining({ name: 'blackcat-game-league-of-legends.png' })]);
  });

  test('uses every generated category banner through a deterministic safe resolver', async () => {
    for (const [label, expected] of [
      ['英雄联盟美服', 'league-of-legends.png'],
      ['无畏契约', 'valorant.png'],
      ['三角洲行动', 'delta-force.png'],
      ['Apex 英雄', 'apex-legends.png'],
      ['绝地求生', 'pubg.png'],
      ['CS2 / CSGO', 'cs2-csgo.png'],
      ['守望先锋', 'overwatch.png'],
      ['永劫无间', 'naraka-bladepoint.png'],
      ['DOTA2', 'dota2.png'],
      ['金铲铲 / 云顶', 'tft.png'],
      ['聊天 / 小游戏', 'chat-minigames.png'],
      ['唱歌 / 声优', 'singing-voice.png'],
      ['未知游戏', 'other.png']
    ] as const) {
      const banner = resolveGameBanner(label, label);
      expect(banner.fileName).toBe(expected);
      await expect(access(banner.path)).resolves.toBeUndefined();
    }
  });

  test('groups final facts, boss request, funds, and submission result instead of one dense paragraph', () => {
    const confirmation = buildMultiProjectOrderConfirmationMessage({
      order: order({ notes: '轻松聊天，不要压力。' }),
      requirements: requirementPage(),
      balance: {
        ledgerBalanceMinor: 1000,
        reservedMinor: 0,
        availableMinor: 1000,
        currency: 'CAT',
        calculatedAt: '2026-08-08T00:00:00Z'
      }
    });
    expect(confirmation.fields?.map((field) => field.name)).toEqual([
      '🧭 下单进度',
      '🎮 陪玩清单',
      '🐟 价格与钱包',
      '✅ 提交状态',
      '💬 老板需求',
      '👉 下一步'
    ]);
    expect(confirmation.fields?.find((field) => field.name === '💬 老板需求')?.value).toBe('> 轻松聊天，不要压力。');
    expect(confirmation.body).not.toContain('轻松聊天');
  });
});

function order(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: orderId,
    publicId: 'P-M18',
    status: 'DRAFT',
    version: 1,
    serviceCatalogId: null,
    game: null,
    service: null,
    region: null,
    billingUnitMinutes: null,
    unitCount: null,
    amountMinor: 0,
    currency: 'CAT',
    notes: null,
    compositionMode: 'CUSTOMIZED',
    channelSpec: { channelId: '111111111111111111', panelMessageId: '222222222222222222', voiceChannelId: null },
    ...overrides
  };
}

function service(): PublicServiceSummary {
  return {
    id: '00000000-0000-0000-0000-000000180302',
    game: 'LOLNA',
    gameDisplayName: '英雄联盟美服',
    service: 'FUN',
    serviceDisplayName: '娱乐陪玩',
    region: null,
    regionDisplayName: null,
    billingUnitMinutes: 60,
    minimumUnits: 1,
    customerUnitPriceMinor: 20,
    currency: 'CAT',
    version: 1
  };
}

function requirementPage(): OrderRequirementPageSummary {
  return {
    items: [
      {
        id: '00000000-0000-0000-0000-000000180303',
        orderId,
        position: 1,
        serviceCatalogVersionId: service().id,
        game: 'LOLNA',
        gameDisplayName: '英雄联盟美服',
        service: 'FUN',
        serviceDisplayName: '娱乐陪玩',
        region: null,
        regionDisplayName: null,
        billingUnitMinutes: 60,
        unitCount: 1,
        requestedPlayerCount: 1,
        customerNote: null,
        customerUnitPriceMinor: 20,
        estimatedLinePriceMinor: 20,
        status: 'ACTIVE',
        version: 1
      }
    ],
    nextCursor: null,
    orderVersion: 1,
    compositionMode: 'CUSTOMIZED',
    packageVersionId: null,
    packageAdjustmentMinor: 0,
    catalogSubtotalMinor: 20,
    derivedTotalMinor: 20,
    currency: 'CAT'
  };
}
