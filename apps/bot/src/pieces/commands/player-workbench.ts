import { Command } from '@sapphire/framework';
import { buildBotActorContext } from '../../actor-context.js';
import { toDiscordReply } from '../../discord-renderer.js';
import { HttpBotApiClient, handleOpenPlayerWorkbench } from '../../service-center.js';

export default class PlayerWorkbenchCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry): void {
    registry.registerChatInputCommand((builder) => {
      return builder.setName('player-workbench').setDescription('Open your private player workbench.');
    });
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: '请在服务器内打开陪玩工作台。', ephemeral: true });
      return;
    }
    const actor = buildBotActorContext(interaction);
    if (!actor) {
      await interaction.reply({ content: '请在服务器内打开陪玩工作台。', ephemeral: true });
      return;
    }
    const api = new HttpBotApiClient({
      apiBaseUrl: process.env.API_BASE_URL ?? '',
      botServiceToken: process.env.BOT_SERVICE_TOKEN ?? ''
    });
    const result = await handleOpenPlayerWorkbench({
      api,
      actor
    });
    if (result.kind === 'SHOW_PLAYER_WORKBENCH') {
      await interaction.reply(toDiscordReply(result.message));
      return;
    }
    await interaction.reply({
      content: result.kind === 'EPHEMERAL_MESSAGE' ? result.message : '暂时无法打开陪玩工作台。',
      ephemeral: true
    });
  }
}
