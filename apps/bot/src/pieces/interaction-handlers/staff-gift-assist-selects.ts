import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { Interaction } from 'discord.js';
import { getBotRuntimeDependencies } from '../../runtime-dependencies.js';
import {
  executeStaffGiftAssistSelect,
  parseStaffGiftAssistSelect,
  type StaffGiftAssistSelectRoute
} from '../../staff-assisted-gifts.js';

export default class StaffGiftAssistSelectHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) {
    super(context, { interactionHandlerType: InteractionHandlerTypes.SelectMenu });
  }

  public override parse(interaction: Interaction) {
    if (!interaction.isStringSelectMenu()) return this.none();
    const route = parseStaffGiftAssistSelect(interaction.customId);
    return route ? this.some(route) : this.none();
  }

  public override async run(interaction: Interaction, route?: StaffGiftAssistSelectRoute): Promise<void> {
    if (!interaction.isStringSelectMenu() || !route) return;
    const dependencies = getBotRuntimeDependencies();
    await executeStaffGiftAssistSelect({
      interaction,
      route,
      api: dependencies.api,
      secret: dependencies.giftContinuationSigningSecret
    });
  }
}
