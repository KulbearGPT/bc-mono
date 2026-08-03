import { Command } from '@sapphire/framework';
import { buildBotActorContext } from '../../actor-context.js';
import { toDiscordBotConfigReply, type BotConfigActorContext } from '../../bot-config.js';
import { getBotRuntimeDependencies } from '../../runtime-dependencies.js';
import { formatUserFacingError } from '../../user-facing-error.js';

export default class BotConfigCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry): void {
    registry.registerChatInputCommand((builder) =>
      builder.setName('bot-config').setDescription('打开本服务器的私密运营配置。').setDMPermission(false)
    );
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: '请在服务器内管理运营配置。', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const reply = toDiscordBotConfigReply(
        await getBotRuntimeDependencies().botConfigFlow.open(actorFromInteraction(interaction))
      );
      await interaction.editReply({ content: reply.content, components: reply.components });
    } catch (error) {
      interaction.client.logger.error({
        event: 'bot.config.command_failed',
        guildId: interaction.guildId,
        discordUserId: interaction.user.id,
        error
      });
      await interaction.editReply({
        content: formatUserFacingError(error, {
          operation: '打开服务器配置',
          localRequestId: `discord-interaction-${interaction.id}`
        }),
        components: []
      });
    }
  }
}

function actorFromInteraction(interaction: Command.ChatInputCommandInteraction): BotConfigActorContext {
  const actor = buildBotActorContext(interaction);
  if (!actor) throw new Error('Guild Actor Context is required.');
  return actor;
}
