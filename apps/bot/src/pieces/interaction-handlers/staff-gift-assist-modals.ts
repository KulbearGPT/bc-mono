import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { Interaction } from 'discord.js';
import { getBotRuntimeDependencies } from '../../runtime-dependencies.js';
import {
  executeStaffGiftAssistModal,
  parseStaffGiftAssistModal,
  type StaffGiftAssistModalRoute
} from '../../staff-assisted-gifts.js';

export default class StaffGiftAssistModalHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) {
    super(context, { interactionHandlerType: InteractionHandlerTypes.ModalSubmit });
  }

  public override parse(interaction: Interaction) {
    if (!interaction.isModalSubmit()) return this.none();
    const route = parseStaffGiftAssistModal(interaction.customId);
    return route ? this.some(route) : this.none();
  }

  public override async run(interaction: Interaction, route?: StaffGiftAssistModalRoute): Promise<void> {
    if (!interaction.isModalSubmit() || !route) return;
    const dependencies = getBotRuntimeDependencies();
    await executeStaffGiftAssistModal({
      interaction,
      route,
      api: dependencies.api,
      secret: dependencies.giftContinuationSigningSecret
    });
  }
}
