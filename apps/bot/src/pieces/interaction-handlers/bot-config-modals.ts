import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { Interaction, ModalSubmitInteraction } from 'discord.js';
import { buildBotActorContext } from '../../actor-context.js';
import { parseBotConfigCustomId, toDiscordBotConfigReply, type BotConfigActorContext } from '../../bot-config.js';
import { getBotRuntimeDependencies } from '../../runtime-dependencies.js';
import { formatUserFacingError } from '../../user-facing-error.js';

export default class BotConfigModalHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) {
    super(context, { interactionHandlerType: InteractionHandlerTypes.ModalSubmit });
  }
  public override parse(interaction: Interaction) {
    if (!interaction.isModalSubmit()) return this.none();
    const route = parseBotConfigCustomId(interaction.customId);
    return route?.operation === 'modal' ? this.some(route) : this.none();
  }
  public override async run(interaction: ModalSubmitInteraction, route: { operation: 'modal'; sessionId: string }) {
    const actor = actorFrom(interaction);
    if (!actor) {
      await interaction.reply({ content: '请在服务器内管理 Bot 配置。', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const botConfigFlow = getBotRuntimeDependencies().botConfigFlow;
      const reply = toDiscordBotConfigReply(
        await botConfigFlow.previewTextInput(
          actor,
          route.sessionId,
          interaction.fields.getTextInputValue('value'),
          `discord:bot-config:validate:${interaction.id}`
        )
      );
      await interaction.editReply({ content: reply.content, components: reply.components });
    } catch (error) {
      interaction.client.logger.error({
        event: 'bot.config.modal_failed',
        guildId: interaction.guildId,
        discordUserId: interaction.user.id,
        customId: interaction.customId,
        error
      });
      await interaction.editReply({
        content: formatUserFacingError(error, {
          operation: '校验 Bot 配置输入',
          localRequestId: `discord-interaction-${interaction.id}`
        }),
        components: []
      });
    }
  }
}
function actorFrom(interaction: ModalSubmitInteraction): BotConfigActorContext | null {
  return buildBotActorContext(interaction);
}
