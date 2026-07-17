import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { BOT_COPY, botCopy } from '../apps/bot/src/bot-copy.js';

describe('Bot copy catalog', () => {
  test('keeps static and interpolated user-facing copy in one typed module', () => {
    expect(BOT_COPY.onboarding.welcome).toContain('欢迎来到黑猫电竞');
    expect(BOT_COPY.onboarding.welcome).toContain('今晚想找一位合拍的游戏搭子');
    expect(botCopy.gifts.requestSubmitted('大袋猫粮', '50.0 CAT')).toBe(
      '🎁 礼物已经装进猫爪包裹\n「大袋猫粮」已预留 50.0 CAT，正在等待猫舍前台核对。核对完成前不会正式扣除。'
    );
    expect(botCopy.orders.channelCreationFailed('req-1')).toContain('request_id: req-1');
    expect(botCopy.onboarding.registrationResult({ applicant: false, created: true, rolePending: false }))
      .toContain('欢迎成为黑猫电竞的新客人');
    expect(BOT_COPY.orders.dispatchStarted).toContain('猫舍正在为你寻找合适的陪玩');
  });

  test('makes copy consumers reference the catalog instead of duplicating key phrases', () => {
    const consumers = [
      'apps/bot/src/onboarding.ts',
      'apps/bot/src/gifts.ts',
      'apps/bot/src/pieces/interaction-handlers/onboarding-buttons.ts'
    ].map((path) => readFileSync(path, 'utf8')).join('\n');

    expect(consumers).toContain("from './bot-copy.js'");
    expect(consumers).not.toContain('点击「注册为玩家」创建账户');
    expect(consumers).not.toContain('等待客服核对。');
    expect(consumers).not.toContain('暂时无法完成操作，请稍后重试。request_id:');
  });
});
