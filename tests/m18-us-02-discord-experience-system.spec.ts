import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { toDiscordReply } from '../apps/bot/src/discord-renderer.js';
import {
  DISCORD_EXPERIENCE,
  buildExperienceMessage
} from '../apps/bot/src/discord-experience.js';

describe('M18-US-02 Discord visual and copy system', () => {
  test('defines stable density, color, footer, and hierarchy tokens', () => {
    expect(DISCORD_EXPERIENCE.density).toEqual({
      PUBLIC_WELCOME: 75,
      PUBLIC_MILESTONE: 70,
      PRIVATE_ORDER: 58,
      EPHEMERAL_FEEDBACK: 35,
      HIGH_RISK: 25
    });
    expect(DISCORD_EXPERIENCE.color).toMatchObject({
      BRAND: 0x6d5dfc,
      SUCCESS: 0x35c48d,
      WAITING: 0xf0a84b,
      DANGER: 0xe35d6a,
      MUTED: 0x747f8d
    });
    expect(DISCORD_EXPERIENCE.footer).toContain('黑猫陪玩');
  });

  test('builds the contracted embed reading order without mixing boss notes into status copy', () => {
    const message = buildExperienceMessage({
      title: '新的委托',
      icon: '🐈‍⬛',
      introduction: '今晚一起遇见合拍的游戏搭子。',
      visibility: 'PUBLIC',
      density: 'PUBLIC_MILESTONE',
      tone: 'BRAND',
      coreFacts: [
        { name: '🎮 游戏与项目', value: '英雄联盟 · 上分陪玩' },
        { name: '🐟 订单价格', value: '20 CAT', inline: true }
      ],
      bossRequest: '希望声音温柔，主玩辅助。',
      progress: '正在招募',
      nextStep: '陪玩请点击对应数字 Reaction 报名。',
      components: []
    });

    expect(message.title).toBe('🐈‍⬛ 新的委托');
    expect(message.fields?.map((field) => field.name)).toEqual([
      '🎮 游戏与项目',
      '🐟 订单价格',
      '💬 老板需求',
      '⏳ 当前进度',
      '👉 下一步'
    ]);
    expect(message.fields?.[2]?.value).toBe('> 希望声音温柔，主玩辅助。');
    expect(message.body).not.toContain('希望声音温柔');
    expect(message.density).toBe('PUBLIC_MILESTONE');
  });

  test('renders semantic color, ordered fields, and Blackcat footer through Discord', () => {
    const message = buildExperienceMessage({
      title: '订单已完成',
      icon: '✨',
      introduction: '今晚的陪伴顺利结束。',
      visibility: 'PUBLIC',
      density: 'PUBLIC_MILESTONE',
      tone: 'SUCCESS',
      coreFacts: [{ name: '🐟 实际扣除', value: '20 CAT' }],
      nextStep: '感谢相伴，欢迎下次再来。',
      components: []
    });

    const reply = toDiscordReply(message);
    const embed = reply.embeds?.[0]?.toJSON();
    expect(embed).toMatchObject({
      color: DISCORD_EXPERIENCE.color.SUCCESS,
      title: '✨ 订单已完成',
      footer: { text: DISCORD_EXPERIENCE.footer }
    });
    expect(embed?.fields?.map((field) => field.name)).toEqual(['🐟 实际扣除', '👉 下一步']);
  });

  test('keeps the forbidden user-facing term out of production Discord surfaces', async () => {
    const productionSources = [
      ...(await collectTypeScriptFiles('apps/bot/src')),
      'apps/api/src/selection-pool-worker.ts'
    ];
    const violations: string[] = [];
    for (const file of productionSources) {
      const source = await readFile(file, 'utf8');
      if (source.includes('选秀')) violations.push(file);
    }
    expect(violations).toEqual([]);

    const copy = await readFile('apps/bot/src/bot-copy.ts', 'utf8');
    expect(copy).not.toContain('在线可接单');
    expect(copy).toContain('内部审批、同一服务器与需求标签');
  });
});

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(path);
      return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    })
  );
  return files.flat().sort();
}
