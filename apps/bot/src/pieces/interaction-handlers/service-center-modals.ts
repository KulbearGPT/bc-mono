import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { Interaction } from 'discord.js';
import { buildBotActorContext } from '../../actor-context.js';
import { executeServiceCenterModalSubmit } from '../../service-center-modal-interactions.js';
import { HttpBotApiClient, parseServiceCenterCustomId } from '../../service-center.js';
import { serviceCenterInteractionKind } from '../../service-center-route-registry.js';

export default class ServiceCenterModalHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) {
    super(context, { interactionHandlerType: InteractionHandlerTypes.ModalSubmit });
  }

  public override parse(interaction: Interaction) {
    if (!interaction.isModalSubmit()) return this.none();
    const route = parseServiceCenterCustomId(interaction.customId);
    return serviceCenterInteractionKind(route) === 'modal' ? this.some(route) : this.none();
  }

  public override async run(
    interaction: Interaction,
    parsedData?: Parameters<typeof executeServiceCenterModalSubmit>[0]['route']
  ): Promise<void> {
    if (!interaction.isModalSubmit() || !parsedData || !interaction.guildId) return;
    const actor = buildBotActorContext(interaction);
    if (!actor) return;
    await executeServiceCenterModalSubmit({
      interaction,
      route: parsedData,
      actor,
      api: new HttpBotApiClient({
        apiBaseUrl: process.env.API_BASE_URL ?? '',
        botServiceToken: process.env.BOT_SERVICE_TOKEN ?? ''
      })
    });
  }
}
