import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type Message,
  type MessageEditOptions,
  type TextChannel
} from 'discord.js';
import { buildPrivateOrderChannelPlan, type PermissionName } from './service-center.js';

const permissionFlags: Record<PermissionName, bigint> = {
  VIEW_CHANNEL: PermissionFlagsBits.ViewChannel,
  SEND_MESSAGES: PermissionFlagsBits.SendMessages,
  MANAGE_CHANNELS: PermissionFlagsBits.ManageChannels
};

export interface CreateProvisionalPrivateOrderChannelInput {
  guild: Guild;
  guildId: string;
  categoryId: string;
  customerDiscordUserId: string;
  botUserId: string;
  staffRoleIds: string[];
  playerRoleId?: string | null;
  provisionalName: string;
}

export interface ProvisionalPrivateOrderChannel {
  channel: TextChannel;
  panel: Message<true>;
  channelId: string;
  panelMessageId: string;
}

export type FinalizePrivateOrderChannelResult = { renamed: true } | { renamed: false; error: unknown };

export async function createProvisionalPrivateOrderChannel(
  input: CreateProvisionalPrivateOrderChannelInput
): Promise<ProvisionalPrivateOrderChannel> {
  const plan = buildPrivateOrderChannelPlan({
    guildId: input.guildId,
    orderPublicId: input.provisionalName,
    customerDiscordUserId: input.customerDiscordUserId,
    botUserId: input.botUserId,
    staffRoleIds: input.staffRoleIds,
    playerRoleId: input.playerRoleId
  });
  const channel = await input.guild.channels.create({
    name: plan.name,
    type: ChannelType.GuildText,
    parent: input.categoryId,
    permissionOverwrites: plan.permissionOverwrites.map((overwrite) => ({
      id: overwrite.id,
      allow: overwrite.allow.map((permission) => permissionFlags[permission]),
      deny: overwrite.deny.map((permission) => permissionFlags[permission])
    }))
  });

  try {
    const panel = await channel.send('正在创建订单面板…');
    if (plan.pinPanel) await panel.pin();
    return {
      channel,
      panel,
      channelId: channel.id,
      panelMessageId: panel.id
    };
  } catch (error) {
    await channel.delete('Provisional order channel setup failed').catch(() => undefined);
    throw error;
  }
}

export async function finalizePrivateOrderChannel(input: {
  channel: Pick<TextChannel, 'setName'>;
  panel: Pick<Message<true>, 'edit'>;
  orderPublicId: string;
  message: MessageEditOptions;
}): Promise<FinalizePrivateOrderChannelResult> {
  await input.panel.edit(input.message);
  const finalPlan = buildPrivateOrderChannelPlan({
    guildId: 'unused',
    orderPublicId: input.orderPublicId,
    customerDiscordUserId: 'unused-customer',
    botUserId: 'unused-bot',
    staffRoleIds: []
  });
  try {
    await input.channel.setName(finalPlan.name);
    return { renamed: true };
  } catch (error) {
    return { renamed: false, error };
  }
}

export async function cleanupProvisionalPrivateOrderChannel(input: {
  channel: Pick<TextChannel, 'delete'>;
  businessCommitted: boolean;
  reason: string;
}): Promise<boolean> {
  if (input.businessCommitted) return false;
  await input.channel.delete(input.reason).catch(() => undefined);
  return true;
}
