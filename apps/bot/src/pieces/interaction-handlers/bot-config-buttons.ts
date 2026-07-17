import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Interaction
} from 'discord.js';
import { buildBotActorContext } from '../../actor-context.js';
import {
  botConfigFlow,
  parseBotConfigCustomId,
  toDiscordBotConfigReply,
  type BotConfigActorContext
} from '../../bot-config.js';
import { formatUserFacingError } from '../../user-facing-error.js';

export default class BotConfigButtonHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) {
    super(context, { interactionHandlerType: InteractionHandlerTypes.Button });
  }

  public override parse(interaction: Interaction) {
    if (!interaction.isButton()) return this.none();
    const route = parseBotConfigCustomId(interaction.customId);
    return route &&
      (route.operation === 'input' ||
        route.operation === 'clear' ||
        route.operation === 'test' ||
        route.operation === 'confirm' ||
        route.operation === 'cancel')
      ? this.some(route)
      : this.none();
  }

  public override async run(
    interaction: ButtonInteraction,
    route: { operation: 'input' | 'clear' | 'test' | 'confirm' | 'cancel'; sessionId: string }
  ): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({ content: '请在服务器内管理 Bot 配置。', ephemeral: true });
      return;
    }
    try {
      if (route.operation === 'input') {
        const input = botConfigFlow.describeTextInput(actor, route.sessionId);
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(`bc:cfg:modal:${route.sessionId}`)
            .setTitle(input.title.slice(0, 45))
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                  .setCustomId('value')
                  .setLabel(input.label)
                  .setStyle(input.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
                  .setRequired(true)
                  .setMaxLength(input.paragraph ? 500 : 6)
              )
            )
        );
        return;
      }
      await interaction.deferUpdate();
      const reply =
        route.operation === 'confirm'
          ? await botConfigFlow.confirm(actor, route.sessionId, `discord:bot-config:update:${interaction.id}`)
          : route.operation === 'test'
            ? await botConfigFlow.testDelivery(actor, route.sessionId, `discord:bot-config:test:${interaction.id}`)
            : route.operation === 'clear'
              ? await botConfigFlow.previewValue(
                  actor,
                  route.sessionId,
                  null,
                  `discord:bot-config:validate:${interaction.id}`
                )
              : botConfigFlow.cancel(actor, route.sessionId);
      const rendered = toDiscordBotConfigReply(reply);
      await interaction.editReply({ content: rendered.content, components: rendered.components });
    } catch (error) {
      interaction.client.logger.error({
        event: 'bot.config.button_failed',
        guildId: interaction.guildId,
        discordUserId: interaction.user.id,
        customId: interaction.customId,
        error
      });
      if (interaction.deferred || interaction.replied)
        await interaction.editReply({
          content: formatUserFacingError(error, {
            operation: botConfigOperation(route.operation),
            localRequestId: `discord-interaction-${interaction.id}`
          }),
          components: []
        });
      else
        await interaction.reply({
          content: formatUserFacingError(error, {
            operation: botConfigOperation(route.operation),
            localRequestId: `discord-interaction-${interaction.id}`
          }),
          ephemeral: true
        });
    }
  }
}

function actorFromInteraction(interaction: ButtonInteraction): BotConfigActorContext | null {
  return buildBotActorContext(interaction);
}

function botConfigOperation(operation: 'input' | 'clear' | 'test' | 'confirm' | 'cancel'): string {
  if (operation === 'test') return '测试 Bot 配置投递';
  if (operation === 'confirm') return '保存 Bot 配置';
  if (operation === 'clear') return '清除 Bot 配置字段';
  if (operation === 'cancel') return '取消 Bot 配置会话';
  return '打开 Bot 配置输入框';
}
