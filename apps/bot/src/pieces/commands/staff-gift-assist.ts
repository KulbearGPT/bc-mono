import { Command } from '@sapphire/framework';
import { ApplicationCommandType, PermissionFlagsBits } from 'discord.js';
import { getBotRuntimeDependencies } from '../../runtime-dependencies.js';
import { executeStaffGiftAssistContextMenu } from '../../staff-assisted-gifts.js';

export default class StaffGiftAssistCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry): void {
    registry.registerContextMenuCommand((builder) =>
      builder
        .setName('协助此老板送礼')
        .setType(ApplicationCommandType.Message)
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    );
  }

  public override async contextMenuRun(interaction: Command.ContextMenuCommandInteraction): Promise<void> {
    if (!interaction.isMessageContextMenuCommand()) {
      await interaction.reply({ content: '请对老板本人发送的消息使用此功能。', ephemeral: true });
      return;
    }
    await executeStaffGiftAssistContextMenu({ interaction, api: getBotRuntimeDependencies().api });
  }
}
