import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { Interaction } from 'discord.js';
import { toDiscordReply } from '../../discord-renderer.js';
import {
  BotApiError,
  HttpBotApiClient,
  buildDiscordIdempotencyKey,
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
    if (!interaction.isStringSelectMenu()) {
      return this.none();
    }
    const route = parseServiceCenterCustomId(interaction.customId);
    return route.area === 'order-select' ? this.some(route) : this.none();
  }

  public override async run(interaction: Interaction, parsedData?: ServiceCenterRoute): Promise<void> {
    if (!interaction.isStringSelectMenu() || parsedData?.area !== 'order-select') {
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
        value: interaction.values[0] ?? '',
        idempotencyKey: buildDiscordIdempotencyKey(`order:update:${parsedData.field}`, interaction.id)
      });
      if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
        const reply = toDiscordReply(result.message);
        await interaction.editReply({ content: reply.content, components: reply.components });
        return;
      }
      await interaction.editReply({ content: '订单选项更新失败，请刷新订单面板。', components: [] });
    } catch (error) {
      const requestId = error instanceof BotApiError ? error.requestId : 'local-order-select-failed';
      await interaction.editReply({ content: `订单选项更新失败，请刷新后重试。request_id: ${requestId}`, components: [] });
    }
  }
}
