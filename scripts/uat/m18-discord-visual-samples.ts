import { AttachmentBuilder, Client, GatewayIntentBits, PermissionFlagsBits, type TextChannel } from 'discord.js';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  buildSelectionReactionOfferPayload,
  resolveSelectionGameBanner
} from '../../apps/api/src/selection-pool-worker.js';

const MARKER = '[M18_VISUAL_SAMPLE_V1]';
const GAME_BANNER_DIRECTORY = new URL('../../apps/api/assets/game-banners/', import.meta.url);
const DISPATCHING_BANNER = new URL('../../apps/api/assets/dispatch/dispatching.png', import.meta.url);
const CANCELLED_BANNER = new URL('../../apps/api/assets/dispatch/order-cancelled.png', import.meta.url);

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

if (process.env.M18_UAT_CONFIRM !== 'SEND_VISUAL_SAMPLES') {
  throw new Error('Set M18_UAT_CONFIRM=SEND_VISUAL_SAMPLES to send the persistent visual sample pack.');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

try {
  await client.login(required('DISCORD_BOT_TOKEN'));
  const guildId = required('DISCORD_GUILD_ID');
  const apiBaseUrl = required('API_BASE_URL').replace(/\/+$/u, '');
  const configResponse = await fetch(`${apiBaseUrl}/api/v1/admin/bot-config?guildId=${encodeURIComponent(guildId)}`, {
    headers: {
      authorization: `Bearer ${required('BOT_SERVICE_TOKEN')}`,
      'x-client-source': 'DISCORD_BOT'
    }
  });
  const configEnvelope = (await configResponse.json()) as {
    requestId?: string;
    data?: { values: Record<string, unknown> };
    error?: { code?: string };
  };
  if (!configResponse.ok || !configEnvelope.data) {
    throw new Error(`Bot configuration read failed: ${configEnvelope.error?.code ?? configResponse.status}`);
  }
  const channelId = configEnvelope.data.values.dispatch_channel_id;
  if (typeof channelId !== 'string' || !/^\d{17,20}$/u.test(channelId)) {
    throw new Error('dispatch_channel_id is not configured in the unified Bot configuration.');
  }
  const guild = await client.guilds.fetch(guildId);
  const fetched = await guild.channels.fetch(channelId);
  if (!fetched?.isTextBased() || !('send' in fetched))
    throw new Error('Configured dispatch channel is not text based.');
  const channel = fetched as TextChannel;
  const botUserId = client.user?.id;
  if (!botUserId) throw new Error('Discord Bot user was not resolved after login.');

  const permissions = channel.permissionsFor(botUserId);
  for (const permission of [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.AddReactions
  ]) {
    if (!permissions?.has(permission))
      throw new Error(`Bot lacks required Discord permission ${permission.toString()}.`);
  }

  const recent = await channel.messages.fetch({ limit: 100, cache: false });
  const previous = recent.find((message) => message.author.id === botUserId && message.content.includes(MARKER));
  if (previous) {
    process.stdout.write(
      `${JSON.stringify({
        status: 'REUSED',
        guildId,
        channelId,
        markerMessageId: previous.id,
        configRequestId: configEnvelope.requestId,
        readOnlyApiCalls: 1,
        businessMutationCalls: 0
      })}\n`
    );
  } else {
    const messageIds: string[] = [];
    const intro = await channel.send({
      content: `${MARKER}\n🐈‍⬛ **黑猫陪玩 · Discord 视觉样例包**\n以下内容只用于检查图片裁切、信息层级和手机端排版，不代表真实订单状态。`,
      allowedMentions: { parse: [] }
    });
    messageIds.push(intro.id);

    const dispatch = await channel.send({
      content: '### 🐾 示例一 · 新委托开始招募\n先发状态横幅，再发可操作的报名卡。',
      files: [new AttachmentBuilder(fileURLToPath(DISPATCHING_BANNER), { name: 'blackcat-dispatching.png' })],
      allowedMentions: { parse: [] }
    });
    messageIds.push(dispatch.id);

    const offer = buildSelectionReactionOfferPayload({
      poolId: '00000000-0000-0000-0000-000000180800',
      orderPublicId: 'M18-视觉样例',
      requirements: [
        {
          id: '00000000-0000-0000-0000-000000180801',
          label: '无畏契约 · 娱乐陪玩',
          remainingSlots: 1,
          expectedEarningMinor: 180,
          currency: 'CAT',
          customerNote: '希望声音温柔、愿意沟通，轻松玩不压力～'
        }
      ]
    });
    const valorant = resolveSelectionGameBanner(['无畏契约 · 娱乐陪玩']);
    const offerMessage = await channel.send({
      embeds: offer.embeds,
      files: [new AttachmentBuilder(fileURLToPath(valorant.asset), { name: valorant.attachmentName })],
      allowedMentions: { parse: [] }
    });
    await offerMessage.react('1️⃣');
    messageIds.push(offerMessage.id);

    const fileNames = (await readdir(GAME_BANNER_DIRECTORY)).filter((name) => name.endsWith('.webp')).sort();
    const groups = [fileNames.slice(0, 8), fileNames.slice(8)];
    for (let index = 0; index < groups.length; index += 1) {
      const names = groups[index]!;
      const gallery = await channel.send({
        content: `### 🎮 示例二${index === 0 ? '（上）' : '（下）'} · 全游戏主题横幅\n${names.map((name) => `\`${name}\``).join(' · ')}`,
        files: names.map(
          (name) => new AttachmentBuilder(fileURLToPath(new URL(name, GAME_BANNER_DIRECTORY)), { name })
        ),
        allowedMentions: { parse: [] }
      });
      messageIds.push(gallery.id);
    }

    const cancelled = await channel.send({
      content: '### 🥀 示例三 · 订单真正取消\n只有业务 API 已确认 `CANCELLED` 时，才会追加这张流单图。',
      files: [new AttachmentBuilder(fileURLToPath(CANCELLED_BANNER), { name: 'blackcat-order-cancelled.png' })],
      allowedMentions: { parse: [] }
    });
    messageIds.push(cancelled.id);

    process.stdout.write(
      `${JSON.stringify({
        status: 'SENT',
        guildId,
        channelId,
        markerMessageId: intro.id,
        messageIds,
        gameBannerCount: fileNames.length,
        configRequestId: configEnvelope.requestId,
        readOnlyApiCalls: 1,
        businessMutationCalls: 0
      })}\n`
    );
  }
} finally {
  client.destroy();
}
