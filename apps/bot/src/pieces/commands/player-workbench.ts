import { Command } from '@sapphire/framework';
import { buildBotActorContext } from '../../actor-context.js';
import { executePlayerWorkbenchInteraction } from '../../player-workbench-interactions.js';
import { HttpBotApiClient } from '../../service-center.js';

export default class PlayerWorkbenchCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry): void {
    registry.registerChatInputCommand((builder) => {
      return builder
        .setName('player-workbench')
        .setDescription('Open your private player workbench.')
        .setDMPermission(false);
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
    await executePlayerWorkbenchInteraction({ interaction, actor, api });
  }
}
