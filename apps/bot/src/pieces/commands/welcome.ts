import { Command } from '@sapphire/framework';
import { PermissionFlagsBits } from 'discord.js';
import { executeWelcomeCommand } from '../../welcome-command.js';

export default class WelcomeCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry): void {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName('welcome')
        .setDescription('向服务器内的玩家重新发送黑猫迎新私信。')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addUserOption((option) =>
          option.setName('player').setDescription('需要重新接收迎新私信的玩家').setRequired(true)
        )
    );
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction): Promise<void> {
    await executeWelcomeCommand(interaction);
  }
}
