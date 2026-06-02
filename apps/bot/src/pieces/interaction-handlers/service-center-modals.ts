import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { Interaction } from 'discord.js';
import { parseServiceCenterCustomId, type ServiceCenterRoute } from '../../service-center.js';

export default class ServiceCenterModalHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) {
    super(context, { interactionHandlerType: InteractionHandlerTypes.ModalSubmit });
  }

  public override parse(interaction: Interaction) {
    if (!interaction.isModalSubmit()) {
      return this.none();
    }
    const route = parseServiceCenterCustomId(interaction.customId);
    return route.area === 'order-notes-modal' ? this.some(route) : this.none();
  }

  public override async run(interaction: Interaction, parsedData?: ServiceCenterRoute): Promise<void> {
    if (!interaction.isModalSubmit()) {
      return;
    }

    await interaction.reply({ content: '备注已收到，正在同步订单面板。', ephemeral: true });
  }
}
