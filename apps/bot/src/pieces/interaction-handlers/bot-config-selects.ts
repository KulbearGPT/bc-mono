import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { AnySelectMenuInteraction, Interaction } from 'discord.js';
import { buildBotActorContext } from '../../actor-context.js';
import { parseBotConfigCustomId, toDiscordBotConfigReply, type BotConfigActorContext } from '../../bot-config.js';
import { getBotRuntimeDependencies } from '../../runtime-dependencies.js';
import { formatUserFacingError } from '../../user-facing-error.js';

export default class BotConfigSelectHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) {
    super(context, { interactionHandlerType: InteractionHandlerTypes.SelectMenu });
  }

  public override parse(interaction: Interaction) {
    if (!interaction.isStringSelectMenu() && !interaction.isChannelSelectMenu() && !interaction.isRoleSelectMenu())
      return this.none();
    const route = parseBotConfigCustomId(interaction.customId);
    return route && (route.operation === 'field' || route.operation === 'security' || route.operation === 'value')
      ? this.some(route)
      : this.none();
  }

  public override async run(
    interaction: AnySelectMenuInteraction,
    route: { operation: 'field' | 'security' | 'value'; sessionId: string }
  ): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({ content: '请在服务器内管理运营配置。', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    try {
      const botConfigFlow = getBotRuntimeDependencies().botConfigFlow;
      const reply =
        route.operation === 'field' || route.operation === 'security'
          ? botConfigFlow.chooseField(actor, route.sessionId, interaction.values[0] ?? '')
          : await botConfigFlow.previewValue(
              actor,
              route.sessionId,
              parseValue(interaction.values[0] ?? ''),
              `discord:bot-config:validate:${interaction.id}`
            );
      const rendered = toDiscordBotConfigReply(reply);
      await interaction.editReply({ content: rendered.content, components: rendered.components });
    } catch (error) {
      interaction.client.logger.error({
        event: 'bot.config.select_failed',
        guildId: interaction.guildId,
        discordUserId: interaction.user.id,
        customId: interaction.customId,
        error
      });
      await interaction.editReply({
        content: formatUserFacingError(error, {
          operation: route.operation === 'value' ? '校验服务器配置值' : '选择服务器配置项',
          localRequestId: `discord-interaction-${interaction.id}`
        }),
        components: []
      });
    }
  }
}

function parseValue(value: string) {
  return value === 'true' ? true : value === 'false' ? false : value;
}

function actorFromInteraction(interaction: AnySelectMenuInteraction): BotConfigActorContext | null {
  return buildBotActorContext(interaction);
}
