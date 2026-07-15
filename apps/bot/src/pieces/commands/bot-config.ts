import { Command } from '@sapphire/framework';
import { buildBotActorContext } from '../../actor-context.js';
import { botConfigFlow, toDiscordBotConfigReply, type BotConfigActorContext } from '../../bot-config.js';

export default class BotConfigCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry): void {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName('bot-config')
        .setDescription('Open the private Guild Bot configuration flow.')
        .setDMPermission(false)
    );
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: '请在服务器内管理 Bot 配置。', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const reply = toDiscordBotConfigReply(await botConfigFlow.open(actorFromInteraction(interaction)));
      await interaction.editReply({ content: reply.content, components: reply.components });
    } catch (error) {
      interaction.client.logger.error({
        event: 'bot.config.command_failed',
        guildId: interaction.guildId,
        discordUserId: interaction.user.id,
        error
      });
      await interaction.editReply({ content: errorMessage(error), components: [] });
    }
  }
}

function actorFromInteraction(interaction: Command.ChatInputCommandInteraction): BotConfigActorContext {
  const actor = buildBotActorContext(interaction);
  if (!actor) throw new Error('Guild Actor Context is required.');
  return actor;
}

function errorMessage(error: unknown): string {
  const requestId =
    typeof error === 'object' && error && 'requestId' in error ? String(error.requestId) : 'local-bot-config';
  return `暂时无法打开 Bot 配置。request_id: ${requestId}`;
}
