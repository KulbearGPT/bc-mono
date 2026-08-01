import type { ButtonInteraction } from 'discord.js';
import { buildBotActorContext } from './actor-context.js';
import { botConfigCache } from './bot-config.js';
import { botCopy } from './bot-copy.js';
import { toDiscordUpdate } from './discord-renderer.js';
import {
  cleanupProvisionalPrivateOrderChannel,
  createProvisionalPrivateOrderChannel,
  finalizePrivateOrderChannel
} from './private-order-channel.js';
import {
  buildDiscordIdempotencyKey,
  buildGamePickerMessage,
  buildMultiProjectOrderPanelMessage,
  handleCreateOrderFromPublicEntry
} from './service-center.js';
import type { HttpBotApiClient } from './service-center-api.js';
import { formatDiscordError, formatUnexpectedBotResult } from './user-facing-error.js';

export async function executeCreateOrderFromEntry(input: {
  interaction: ButtonInteraction;
  api: HttpBotApiClient;
}): Promise<void> {
  const { interaction, api } = input;
  if (!interaction.guild || !interaction.guildId) {
    await interaction.reply({ content: '请在服务器内创建订单。', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const values = botConfigCache.get(interaction.guildId)?.values;
  const categoryId = typeof values?.private_order_category_id === 'string' ? values.private_order_category_id : null;
  if (values?.new_orders_enabled === false || !categoryId) {
    await interaction.editReply('当前未开放新订单，或尚未配置私密订单频道分类。');
    return;
  }
  let provisional = null;
  let businessCommitted = false;
  try {
    const staffRoleIds = ['staff_l1_role_id', 'staff_l2_role_id', 'staff_l3_role_id', 'staff_l4_role_id']
      .map((key) => values?.[key])
      .filter((id): id is string => typeof id === 'string');
    provisional = await createProvisionalPrivateOrderChannel({
      guild: interaction.guild,
      guildId: interaction.guildId,
      categoryId,
      customerDiscordUserId: interaction.user.id,
      botUserId: interaction.client.user.id,
      staffRoleIds,
      playerRoleId: typeof values?.player_role_id === 'string' ? values.player_role_id : null,
      provisionalName: interaction.user.username
        .toLowerCase()
        .replace(/[^a-z0-9-]/gu, '-')
        .slice(0, 80)
    });
    const { channel, panel: placeholder } = provisional;
    const actor = buildBotActorContext(interaction);
    if (!actor) throw new Error('Guild Actor Context is required.');
    const result = await handleCreateOrderFromPublicEntry({
      api,
      actor,
      provisionalChannel: {
        channelId: provisional.channelId,
        panelMessageId: provisional.panelMessageId,
        voiceChannelId: null
      },
      idempotencyKey: buildDiscordIdempotencyKey('order:create', interaction.id)
    });
    if (result.kind === 'CREATE_PRIVATE_CHANNEL') {
      businessCommitted = true;
      await renderCommittedChannel({ interaction, api, actor, channel, placeholder, order: result.order });
      return;
    }
    if (result.kind === 'OPEN_EXISTING_CHANNEL') {
      const existing = await interaction.guild.channels.fetch(result.channelId).catch(() => null);
      if (existing) {
        await channel.delete('Duplicate provisional order channel').catch(() => undefined);
        await interaction.editReply(botCopy.entry.existingOrder(result.channelId));
        return;
      }
      const order = await api.getOrder(result.orderId, actor);
      const recovered = await api.recoverOrderChannel(
        result.orderId,
        {
          expectedVersion: order.version,
          previousChannelId: result.channelId,
          channelSpec: {
            channelId: provisional.channelId,
            panelMessageId: provisional.panelMessageId,
            voiceChannelId: order.channelSpec.voiceChannelId
          }
        },
        actor,
        buildDiscordIdempotencyKey(`order:recover-channel:${result.orderId}`, interaction.id)
      );
      businessCommitted = true;
      await renderCommittedChannel({ interaction, api, actor, channel, placeholder, order: recovered });
      return;
    }
    await channel.delete('Order creation failed').catch(() => undefined);
    await interaction.editReply(
      result.kind === 'EPHEMERAL_MESSAGE' || result.kind === 'CHANNEL_CREATION_FAILED'
        ? result.message
        : formatUnexpectedBotResult('创建订单', `discord-interaction-${interaction.id}`)
    );
  } catch (error) {
    if (provisional) {
      await cleanupProvisionalPrivateOrderChannel({
        channel: provisional.channel,
        businessCommitted,
        reason: 'Order creation failed'
      });
    }
    await interaction.editReply(formatDiscordError(error, '创建或恢复订单频道', interaction.id));
  }
}

async function renderCommittedChannel(input: {
  interaction: ButtonInteraction;
  api: HttpBotApiClient;
  actor: NonNullable<ReturnType<typeof buildBotActorContext>>;
  channel: Awaited<ReturnType<typeof createProvisionalPrivateOrderChannel>>['channel'];
  placeholder: Awaited<ReturnType<typeof createProvisionalPrivateOrderChannel>>['panel'];
  order: Awaited<ReturnType<HttpBotApiClient['getOrder']>>;
}): Promise<void> {
  const [catalog, requirements, packages] = await Promise.all([
    input.api.listServices(input.actor),
    input.api.listOrderRequirements(input.order.id, input.actor, undefined, 10),
    input.api.listServicePackages(input.actor, undefined, 25)
  ]);
  const message = requirements.items.some((item) => item.status === 'ACTIVE')
    ? buildMultiProjectOrderPanelMessage(input.order, requirements, catalog.items)
    : buildGamePickerMessage(input.order, catalog.items, packages.items);
  const finalization = await finalizePrivateOrderChannel({
    channel: input.channel,
    panel: input.placeholder,
    orderPublicId: input.order.publicId,
    message: toDiscordUpdate(message)
  });
  if (!finalization.renamed) {
    input.interaction.client.logger.error({
      event: 'bot.order_channel.rename_failed',
      guildId: input.interaction.guildId,
      channelId: input.channel.id,
      orderPublicId: input.order.publicId,
      error: finalization.error
    });
  }
  await input.interaction.editReply(
    `${botCopy.entry.channelCreated(String(input.channel))}${
      finalization.renamed
        ? ''
        : `\n频道名称暂未更新，请联系工作人员检查 Bot 权限。request_id: discord-interaction-${input.interaction.id}`
    }`
  );
}
