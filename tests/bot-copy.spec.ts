import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { BOT_COPY, botCopy } from '../apps/bot/src/bot-copy.js';
import { buildOnboardingMessage } from '../apps/bot/src/onboarding.js';
import { buildPublicServiceEntryMessage } from '../apps/bot/src/service-center.js';

describe('Bot copy catalog', () => {
  test('keeps static and interpolated user-facing copy in one typed module', () => {
    expect(BOT_COPY.onboarding.welcomeIntroduction).toContain('今晚想找一位合拍的游戏搭子');
    expect(BOT_COPY.onboarding.customerPath).toContain('第一次来请先注册玩家');
    expect(BOT_COPY.onboarding.welcomeIntroduction).toContain('ฅ^•ﻌ•^ฅ');
    expect(JSON.stringify(BOT_COPY).split('ฅ^•ﻌ•^ฅ')).toHaveLength(2);
    expect(botCopy.gifts.requestSubmitted('大袋猫粮', '50.0 CAT')).toBe(
      '**🎁 礼物已送到猫舍前台**\n\n**礼物**：大袋猫粮\n**已预留**：50.0 CAT\n**当前进度**：等待猫舍前台核对\n\n核对完成前不会正式扣除。'
    );
    expect(botCopy.orders.channelCreationFailed('req-1')).toContain('request_id: req-1');
    expect(botCopy.onboarding.registrationResult({ applicant: false, created: true, rolePending: false })).toContain(
      '欢迎成为黑猫电竞的新玩家'
    );
    expect(BOT_COPY.orders.dispatchStarted).toContain('猫舍正在为你寻找合适的陪玩');
  });

  test('uses a consistent black-cat hierarchy for high-traffic entry messages', () => {
    const onboarding = buildOnboardingMessage();
    const onboardingRow = onboarding.components?.[0]?.toJSON();
    const publicEntry = buildPublicServiceEntryMessage();

    expect(onboardingRow?.components.map((component) => component.label)).toEqual([
      '🐾 注册为玩家',
      '🎧 申请成为陪玩',
      '🎮 开始找陪玩'
    ]);
    expect(publicEntry.title).toBe('🐈‍⬛ 陪玩服务中心');
    expect(publicEntry.fields?.map((field) => field.name)).toContain('🛎️ 下单前请留意');
    expect(publicEntry.components[0]).toMatchObject({
      components: [{ label: '🐾 创建订单' }, { label: '🐈‍⬛ 我的服务中心' }]
    });
  });

  test('makes copy consumers reference the catalog instead of duplicating key phrases', () => {
    const consumers = [
      'apps/bot/src/onboarding.ts',
      'apps/bot/src/gifts.ts',
      'apps/bot/src/pieces/interaction-handlers/onboarding-buttons.ts'
    ]
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    expect(consumers).toContain("from './bot-copy.js'");
    expect(consumers).not.toContain('点击「注册为玩家」创建账户');
    expect(consumers).not.toContain('等待客服核对。');
    expect(consumers).not.toContain('暂时无法完成操作，请稍后重试。request_id:');
  });
});
