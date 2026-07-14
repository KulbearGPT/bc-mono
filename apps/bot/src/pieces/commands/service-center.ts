import { Command } from '@sapphire/framework';
import { toDiscordReply } from '../../discord-renderer.js';
import { buildPublicServiceEntryMessage } from '../../service-center.js';

export default class ServiceCenterCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry): void {
    registry.registerChatInputCommand((builder) => {
      return builder.setName('service-center').setDescription('Open the private companion service center.');
    });
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction): Promise<void> {
    await interaction.reply(toDiscordReply(buildPublicServiceEntryMessage()));
  }
}
