import { Command } from '@sapphire/framework';
import { buildBotActorContext } from '../../actor-context.js';
import { executePlayerWorkbenchInteraction } from '../../player-workbench-interactions.js';
import { getBotRuntimeDependencies } from '../../runtime-dependencies.js';

export default class PlayerWorkbenchCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry): void {
    registry.registerChatInputCommand((builder) => {
      return builder.setName('player-workbench').setDescription('打开你的私密陪玩工作台。').setDMPermission(false);
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
    await executePlayerWorkbenchInteraction({
      interaction,
      actor,
      api: getBotRuntimeDependencies().api
    });
  }
}
