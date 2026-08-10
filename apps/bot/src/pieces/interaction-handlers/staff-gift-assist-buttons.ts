import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { Interaction } from 'discord.js';
import { getBotRuntimeDependencies } from '../../runtime-dependencies.js';
import {
  executeStaffGiftAssistButton,
  parseStaffGiftAssistButton,
  type StaffGiftAssistButtonRoute
} from '../../staff-assisted-gifts.js';
import { formatDiscordError } from '../../user-facing-error.js';

export default class StaffGiftAssistButtonHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) {
    super(context, { interactionHandlerType: InteractionHandlerTypes.Button });
  }

  public override parse(interaction: Interaction) {
    if (!interaction.isButton()) return this.none();
    const route = parseStaffGiftAssistButton(interaction.customId);
    return route ? this.some(route) : this.none();
  }

  public override async run(interaction: Interaction, route?: StaffGiftAssistButtonRoute): Promise<void> {
    if (!interaction.isButton() || !route) return;
    const dependencies = getBotRuntimeDependencies();
    try {
      await executeStaffGiftAssistButton({
        interaction,
        route,
        api: dependencies.api,
        secret: dependencies.giftContinuationSigningSecret
      });
    } catch (error) {
      const reply = {
        content: formatDiscordError(error, '处理客服辅助送礼', interaction.id),
        ephemeral: true as const
      };
      if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
      else await interaction.reply(reply);
    }
  }
}
