import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { BOT_COPY, botCopy } from '../../bot-copy.js';
import type { Interaction } from 'discord.js';
import { toDiscordReply } from '../../discord-renderer.js';
import {
  BotApiError,
  HttpBotApiClient,
  buildDiscordIdempotencyKey,
  buildOrderPanelMessage,
  handleOrderSelectSubmit,
  parseServiceCenterCustomId,
  type BotActorContext,
  type ServiceCenterRoute
} from '../../service-center.js';

export default class OrderSelectHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) {
    super(context, { interactionHandlerType: InteractionHandlerTypes.SelectMenu });
  }

  public override parse(interaction: Interaction) {
    if (!interaction.isStringSelectMenu() && !interaction.isUserSelectMenu()) {
      return this.none();
    }
    const route = parseServiceCenterCustomId(interaction.customId);
    return route.area === 'order-select' ? this.some(route) : this.none();
  }

  public override async run(interaction: Interaction, parsedData?: ServiceCenterRoute): Promise<void> {
    if ((!interaction.isStringSelectMenu() && !interaction.isUserSelectMenu()) || parsedData?.area !== 'order-select') {
      return;
    }

    await interaction.deferUpdate();
    const actor: BotActorContext = {
      guildId: interaction.guildId as string,
      discordUserId: interaction.user.id,
      interactionId: interaction.id,
      clientSource: 'DISCORD_BOT'
    };
    try {
      const result = await handleOrderSelectSubmit({
        api: new HttpBotApiClient({ apiBaseUrl: process.env.API_BASE_URL ?? '', botServiceToken: process.env.BOT_SERVICE_TOKEN ?? '' }),
        actor,
        orderId: parsedData.orderId,
        expectedVersion: parsedData.expectedVersion,
        field: parsedData.field,
        value: parsedData.field === 'preferred-players' ? interaction.values : interaction.values[0] ?? '',
        idempotencyKey: buildDiscordIdempotencyKey(`order:update:${parsedData.field}`, interaction.id)
      });
      if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
        const reply = toDiscordReply(result.message);
        await interaction.editReply({ content: null, embeds: reply.embeds, components: reply.components });
        return;
      }
      await interaction.editReply({ content: BOT_COPY.orders.optionUpdateFailed, components: [] });
    } catch (error) {
      const requestId = error instanceof BotApiError ? error.requestId : 'local-order-select-failed';
      try {
        const order = await new HttpBotApiClient({ apiBaseUrl: process.env.API_BASE_URL ?? '', botServiceToken: process.env.BOT_SERVICE_TOKEN ?? '' })
          .getOrder(parsedData.orderId, actor);
        const reply = toDiscordReply(buildOrderPanelMessage(order));
        await interaction.editReply({ content: null, embeds: reply.embeds, components: reply.components });
        await interaction.followUp({ content: botCopy.orders.optionSaveFailed(requestId), ephemeral: true });
      } catch {
        await interaction.followUp({ content: botCopy.orders.menuRecoveryFailed(requestId), ephemeral: true });
      }
    }
  }
}
