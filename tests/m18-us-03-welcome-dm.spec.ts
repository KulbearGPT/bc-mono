import { access, readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { discoverSapphirePieces } from '@blackcat/bot/piece-manifest';
import { executeWelcomeCommand } from '@blackcat/bot/welcome-command';
import { buildWelcomeDmMessage, isWelcomeDmBlocked, resendWelcomeDm, sendWelcomeDm } from '@blackcat/bot/welcome-dm';

const guildId = '999999999999999999';
const playerId = '111111111111111111';
const entryChannelId = '222222222222222222';

describe('M18-US-03 newcomer welcome DM', () => {
  test('renders a 90-density branded welcome with an original banner and safe server navigation', async () => {
    const payload = buildWelcomeDmMessage({
      guildId,
      guildName: '黑猫陪玩店',
      guildIconUrl: 'https://cdn.example.test/blackcat.png',
      recipientUserId: playerId,
      publicEntryChannelId: entryChannelId
    });
    const embed = payload.embeds?.[0] as { toJSON(): Record<string, any> };
    const json = embed.toJSON();
    const rendered = JSON.stringify(payload);

    expect(json.title).toBe('🐈‍⬛ 欢迎来到黑猫陪玩店');
    expect(json.author).toEqual({ name: '黑猫陪玩 · 新朋友接待处' });
    expect(json.description).toContain(`<@${playerId}>`);
    expect(json.fields.map((field: { name: string }) => field.name)).toEqual([
      '🌙 今晚想怎么玩',
      '🎮 老板找陪玩',
      '🎧 想加入猫舍',
      '🛎️ 真人客服在这里',
      '💎 黑猫陪伴承诺',
      '🐾 三步开启今晚'
    ]);
    expect(json.thumbnail).toEqual({ url: 'https://cdn.example.test/blackcat.png' });
    expect(json.image).toEqual({ url: 'attachment://blackcat-welcome.png' });
    expect(json.footer.text).toContain('不会在私信中索要密码');
    expect(payload.files).toEqual([expect.objectContaining({ name: 'blackcat-welcome.png' })]);
    await expect(access('apps/api/assets/onboarding/welcome.png')).resolves.toBeUndefined();
    expect(rendered).toContain(`https://discord.com/channels/${guildId}/${entryChannelId}`);
    expect(rendered).not.toMatch(/5000\+|最大华人|秒回不是AI|单价加成/u);
    expect(payload.allowedMentions).toEqual({ parse: [], users: [playerId] });
    expect(isWelcomeDmBlocked({ code: 50_007 })).toBe(true);
    expect(isWelcomeDmBlocked({ code: 50_013 })).toBe(false);
  });

  test('skips bots and sends the same DM to a real member', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'dm-message-1' });
    const guild = { id: guildId, name: '黑猫陪玩店', iconURL: () => null };
    await expect(
      sendWelcomeDm({
        recipient: { id: 'bot-1', displayName: 'Bot', user: { bot: true }, send },
        guild,
        publicEntryChannelId: entryChannelId
      })
    ).resolves.toEqual({ sent: false, reason: 'BOT' });
    expect(send).not.toHaveBeenCalled();

    await expect(
      sendWelcomeDm({
        recipient: { id: playerId, displayName: '小黑', user: { bot: false }, send },
        guild,
        publicEntryChannelId: entryChannelId
      })
    ).resolves.toEqual({ sent: true, messageId: 'dm-message-1' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('re-send authorizes through the unified API before fetching and messaging the target member', async () => {
    const calls: string[] = [];
    const send = vi.fn(async () => {
      calls.push('send');
      return { id: 'dm-message-2' };
    });
    const recipient = { id: playerId, displayName: '小黑', user: { bot: false }, send };
    const guild = {
      id: guildId,
      name: '黑猫陪玩店',
      iconURL: () => null,
      members: {
        fetch: vi.fn(async () => {
          calls.push('fetch-member');
          return recipient;
        })
      }
    };
    const api = {
      getBotConfig: vi.fn(async () => {
        calls.push('authorize');
        return { guildId, version: 1, values: { public_entry_channel_id: entryChannelId } };
      })
    };
    const actor = {
      guildId,
      discordUserId: '333333333333333333',
      interactionId: '444444444444444444',
      clientSource: 'DISCORD_BOT' as const
    };

    await expect(resendWelcomeDm({ actor, guild, targetUserId: playerId, api })).resolves.toEqual({
      sent: true,
      messageId: 'dm-message-2'
    });
    expect(calls).toEqual(['authorize', 'fetch-member', 'send']);
    expect(api.getBotConfig).toHaveBeenCalledWith(guildId, actor);
  });

  test('registers automatic join and privileged /welcome re-send pieces', async () => {
    const manifest = await discoverSapphirePieces();
    expect(manifest.pieces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'listeners', name: 'guild-member-add' }),
        expect.objectContaining({ kind: 'commands', name: 'welcome' })
      ])
    );
    const [listener, command] = await Promise.all([
      readFile('apps/bot/src/pieces/listeners/guild-member-add.ts', 'utf8'),
      readFile('apps/bot/src/pieces/commands/welcome.ts', 'utf8')
    ]);
    expect(listener).toContain('Events.GuildMemberAdd');
    expect(listener).toContain('sendWelcomeDm');
    expect(command).toContain("setName('welcome')");
    expect(command).toContain("setName('player')");
    expect(command).toContain('PermissionFlagsBits.ManageGuild');
    expect(command).toContain('executeWelcomeCommand');
  });

  test('the real command executor acknowledges privately, authorizes, then reports delivery privately', async () => {
    const events: string[] = [];
    const send = vi.fn(async () => {
      events.push('send');
      return { id: 'dm-message-3' };
    });
    const interaction = {
      id: '444444444444444444',
      guildId,
      guild: {
        id: guildId,
        name: '黑猫陪玩店',
        iconURL: () => null,
        members: {
          fetch: vi.fn(async () => {
            events.push('fetch-member');
            return { id: playerId, displayName: '小黑', user: { bot: false }, send };
          })
        }
      },
      user: { id: '333333333333333333' },
      options: { getUser: vi.fn(() => ({ id: playerId, username: 'xiaomao' })) },
      deferReply: vi.fn(async (value) => {
        events.push(`defer:${JSON.stringify(value)}`);
      }),
      editReply: vi.fn(async (value) => {
        events.push(`edit:${String(value)}`);
      }),
      reply: vi.fn(),
      client: { logger: { error: vi.fn() } }
    };
    const api = {
      getBotConfig: vi.fn(async () => {
        events.push('authorize');
        return { values: { public_entry_channel_id: entryChannelId } };
      })
    };

    await executeWelcomeCommand(interaction as never, api);

    expect(events).toEqual([
      'defer:{"ephemeral":true}',
      'authorize',
      'fetch-member',
      'send',
      'edit:迎新私信已重新发送给 xiaomao。'
    ]);
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});
