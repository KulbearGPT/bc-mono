import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ButtonInteraction, Interaction } from 'discord.js';
import { toDiscordModal, toDiscordReply } from '../../discord-renderer.js';
import {
  HttpBotApiClient,
  buildDiscordIdempotencyKey,
  handleOpenOrderConfirmation,
  handleOpenServiceCenterFromPublicEntry,
  handleServiceLifecycleAction,
  handleSubmitFinalOrder,
  parseServiceCenterCustomId,
  type BotActorContext,
  type ServiceCenterRoute
} from '../../service-center.js';

export default class ServiceCenterButtonHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) {
    super(context, { interactionHandlerType: InteractionHandlerTypes.Button });
  }

  public override parse(interaction: Interaction) {
    if (!interaction.isButton()) {
      return this.none();
    }
    const route = parseServiceCenterCustomId(interaction.customId);
    return route.area === 'entry' || route.area === 'order-action' || route.area === 'service-action'
      ? this.some(route)
      : this.none();
  }

  public override async run(interaction: Interaction, parsedData?: ServiceCenterRoute): Promise<void> {
    if (!interaction.isButton() || !parsedData || parsedData.area === 'unknown') {
      return;
    }

    if (parsedData.area === 'entry') {
      if (parsedData.action === 'service-center') {
        await this.openPrivateServiceCenter(interaction);
        return;
      }

      await interaction.reply({
        content: '正在准备私密订单频道。',
        ephemeral: true
      });
      return;
    }

    if (parsedData.area !== 'order-action') {
      if (parsedData.area === 'service-action') {
        await this.handleServiceLifecycleButton(interaction, parsedData);
      }
      return;
    }

    if (parsedData.action === 'submit') {
      await this.openOrderConfirmation(interaction, parsedData);
      return;
    }

    if (parsedData.action === 'submit-final') {
      await this.submitFinalOrder(interaction, parsedData);
      return;
    }

    await interaction.reply({ content: '该订单操作将在后续步骤处理。request_id: local-action-pending', ephemeral: true });
  }

  private async handleServiceLifecycleButton(
    interaction: ButtonInteraction,
    route: Extract<ServiceCenterRoute, { area: 'service-action' }>
  ): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({ content: '请在服务器内操作订单状态。request_id: local-guild-required', ephemeral: true });
      return;
    }

    const api = createBotApiClient();
    const result = await handleServiceLifecycleAction({
      api,
      actor,
      orderId: route.orderId,
      action: route.action,
      expectedVersion: route.expectedVersion,
      idempotencyKey: buildDiscordIdempotencyKey(`service:${route.action}`, interaction.id)
    });
    if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
      const reply = toDiscordReply(result.message);
      await interaction.update({ content: reply.content, components: reply.components });
      return;
    }
    if (result.kind === 'EPHEMERAL_MESSAGE') {
      await interaction.reply({ content: result.message, ephemeral: true });
      return;
    }
    await interaction.reply({ content: '暂时无法处理订单状态。request_id: local-unhandled-result', ephemeral: true });
  }

  private async openPrivateServiceCenter(interaction: ButtonInteraction): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({ content: '请在服务器内打开服务中心。request_id: local-guild-required', ephemeral: true });
      return;
    }

    const api = createBotApiClient();
    const result = await handleOpenServiceCenterFromPublicEntry({ api, actor });
    if (result.kind === 'SHOW_SERVICE_CENTER') {
      await interaction.reply(toDiscordReply(result.message));
      return;
    }
    if (result.kind === 'SHOW_MODAL') {
      await interaction.showModal(toDiscordModal(result.modal));
      return;
    }
    if (result.kind === 'EPHEMERAL_MESSAGE') {
      await interaction.reply({ content: result.message, ephemeral: true });
      return;
    }
    await interaction.reply({ content: '暂时无法打开服务中心。request_id: local-unhandled-result', ephemeral: true });
  }

  private async openOrderConfirmation(
    interaction: ButtonInteraction,
    route: Extract<ServiceCenterRoute, { area: 'order-action' }>
  ): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({ content: '请在服务器内确认订单。request_id: local-guild-required', ephemeral: true });
      return;
    }

    const api = createBotApiClient();
    const result = await handleOpenOrderConfirmation({
      api,
      actor,
      orderId: route.orderId,
      expectedVersion: route.expectedVersion,
      idempotencyKey: buildDiscordIdempotencyKey('order:estimate', interaction.id)
    });
    if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
      await interaction.reply(toDiscordReply(result.message));
      return;
    }
    if (result.kind === 'EPHEMERAL_MESSAGE') {
      await interaction.reply({ content: result.message, ephemeral: true });
      return;
    }
    await interaction.reply({ content: '暂时无法打开确认面板。request_id: local-unhandled-result', ephemeral: true });
  }

  private async submitFinalOrder(
    interaction: ButtonInteraction,
    route: Extract<ServiceCenterRoute, { area: 'order-action' }>
  ): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({ content: '请在服务器内提交订单。request_id: local-guild-required', ephemeral: true });
      return;
    }

    const api = createBotApiClient();
    const result = await handleSubmitFinalOrder({
      api,
      actor,
      orderId: route.orderId,
      expectedVersion: route.expectedVersion,
      idempotencyKey: buildDiscordIdempotencyKey('order:submit-final', interaction.id)
    });
    if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
      await interaction.reply(toDiscordReply(result.message));
      return;
    }
    if (result.kind === 'EPHEMERAL_MESSAGE') {
      await interaction.reply({ content: result.message, ephemeral: true });
      return;
    }
    await interaction.reply({ content: '暂时无法提交订单。request_id: local-unhandled-result', ephemeral: true });
  }
}

function createBotApiClient(): HttpBotApiClient {
  return new HttpBotApiClient({
    apiBaseUrl: process.env.API_BASE_URL ?? '',
    botServiceToken: process.env.BOT_SERVICE_TOKEN ?? ''
  });
}

function actorFromInteraction(interaction: ButtonInteraction): BotActorContext | null {
  if (!interaction.guildId) {
    return null;
  }
  return {
    guildId: interaction.guildId,
    discordUserId: interaction.user.id,
    interactionId: interaction.id,
    clientSource: 'DISCORD_BOT'
  };
}
