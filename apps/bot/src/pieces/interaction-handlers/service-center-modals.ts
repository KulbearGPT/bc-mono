import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { Interaction } from 'discord.js';
import { buildBotActorContext } from '../../actor-context.js';
import { executeServiceCenterModalSubmit } from '../../service-center-modal-interactions.js';
import { parseServiceCenterCustomId } from '../../service-center.js';
import { serviceCenterInteractionKind } from '../../service-center-route-registry.js';
import { getBotRuntimeDependencies } from '../../runtime-dependencies.js';
import { executeOrderExperienceReviewModal } from '../../order-experience-review-interactions.js';
import type { ServiceCenterRoute } from '../../service-center-routes.js';

type ModalRoute =
  | Parameters<typeof executeServiceCenterModalSubmit>[0]['route']
  | Extract<ServiceCenterRoute, { area: 'experience-review-comment-modal' }>;

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
    parsedData?: ModalRoute
  ): Promise<void> {
    if (!interaction.isModalSubmit() || !parsedData || !interaction.guildId) return;
    const actor = buildBotActorContext(interaction);
    if (!actor) return;
    if (parsedData.area === 'experience-review-comment-modal') {
      const dependencies = getBotRuntimeDependencies();
      await executeOrderExperienceReviewModal({
        interaction,
        route: parsedData,
        actor,
        api: dependencies.api,
        secret: dependencies.reviewContinuationSigningSecret
      });
      return;
    }
    await executeServiceCenterModalSubmit({
      interaction,
      route: parsedData,
      actor,
      api: getBotRuntimeDependencies().api
    });
  }
}
