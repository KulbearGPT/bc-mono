import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type MessageCreateOptions } from 'discord.js';
import type { BotConfigActorContext } from './bot-config.js';
import { BOT_COPY } from './bot-copy.js';

export interface WelcomeDmRecipient {
  id: string;
  displayName: string;
  user: { bot: boolean };
  send(payload: MessageCreateOptions): Promise<{ id: string }>;
}

export interface WelcomeDmGuild {
  id: string;
  name: string;
  iconURL(): string | null;
}

export interface WelcomeDmResolvableGuild extends WelcomeDmGuild {
  members: { fetch(userId: string): Promise<WelcomeDmRecipient> };
}

export interface WelcomeDmAuthorizationApi {
  getBotConfig(guildId: string, actor: BotConfigActorContext): Promise<{ values: Partial<Record<string, unknown>> }>;
}

export function isWelcomeDmBlocked(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && Number(error.code) === 50_007;
}

export function buildWelcomeDmMessage(input: {
  guildId: string;
  guildName: string;
  guildIconUrl: string | null;
  recipientUserId: string;
  publicEntryChannelId?: string | null;
}): MessageCreateOptions {
  const serverUrl = `https://discord.com/channels/${input.guildId}`;
  const entryUrl = input.publicEntryChannelId ? `${serverUrl}/${input.publicEntryChannelId}` : serverUrl;
  const embed = new EmbedBuilder()
    .setColor(0x6d5dfc)
    .setTitle(`🐈‍⬛ 欢迎来到${input.guildName}`.slice(0, 256))
    .setDescription(`<@${input.recipientUserId}>，${BOT_COPY.onboarding.privateWelcomeIntroduction}`)
    .addFields(
      { name: '🎮 老板找陪玩', value: BOT_COPY.onboarding.privateCustomerPath },
      { name: '🎧 想加入猫舍', value: BOT_COPY.onboarding.privateCompanionPath },
      { name: '🛎️ 需要真人帮助', value: BOT_COPY.onboarding.privateSupportPath },
      { name: '🐾 第一次来怎么走', value: BOT_COPY.onboarding.privateFirstSteps }
    )
    .setFooter({ text: '不会在私信中索要密码或完整付款信息 · Blackcat Companion' });
  if (input.guildIconUrl) embed.setThumbnail(input.guildIconUrl);

  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🐾 打开黑猫服务入口').setURL(entryUrl),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('返回服务器').setURL(serverUrl)
  );
  return {
    embeds: [embed],
    components: [actions],
    allowedMentions: { parse: [], users: [input.recipientUserId] }
  };
}

export async function sendWelcomeDm(input: {
  recipient: WelcomeDmRecipient;
  guild: WelcomeDmGuild;
  publicEntryChannelId?: string | null;
}): Promise<{ sent: true; messageId: string } | { sent: false; reason: 'BOT' }> {
  if (input.recipient.user.bot) return { sent: false, reason: 'BOT' };
  const message = await input.recipient.send(
    buildWelcomeDmMessage({
      guildId: input.guild.id,
      guildName: input.guild.name,
      guildIconUrl: input.guild.iconURL(),
      recipientUserId: input.recipient.id,
      publicEntryChannelId: input.publicEntryChannelId
    })
  );
  return { sent: true, messageId: message.id };
}

export async function resendWelcomeDm(input: {
  actor: BotConfigActorContext;
  guild: WelcomeDmResolvableGuild;
  targetUserId: string;
  api: WelcomeDmAuthorizationApi;
}): Promise<{ sent: true; messageId: string } | { sent: false; reason: 'BOT' }> {
  const snapshot = await input.api.getBotConfig(input.guild.id, input.actor);
  const configuredEntryChannelId = snapshot.values.public_entry_channel_id;
  const publicEntryChannelId =
    typeof configuredEntryChannelId === 'string' && configuredEntryChannelId.length > 0
      ? configuredEntryChannelId
      : null;
  const recipient = await input.guild.members.fetch(input.targetUserId);
  return sendWelcomeDm({ recipient, guild: input.guild, publicEntryChannelId });
}
