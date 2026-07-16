import type { ButtonInteraction } from 'discord.js';
import { toDiscordUpdate } from './discord-renderer.js';
import {
  buildGiftAffordabilityMessage,
  buildGiftCatalogMessage,
  buildGiftRequestMessage,
  createGiftContinuationToken,
  decodeGiftRecipientSelection,
  readGiftContinuationToken
} from './gifts.js';
import {
  BotApiError,
  buildDiscordIdempotencyKey,
  type BotActorContext,
  type BotApiClient
} from './service-center-api.js';
import type { ServiceCenterRoute } from './service-center-routes.js';

export async function executeGiftRecipientPage(input: {
  interaction: ButtonInteraction;
  route: Extract<ServiceCenterRoute, { area: 'gift-recipient-page' }>;
  actor: BotActorContext;
  api: BotApiClient;
  secret: () => string;
}): Promise<void> {
  await input.interaction.deferUpdate();
  try {
    const catalog = await input.api.listGifts(input.route.orderId, input.actor);
    await input.interaction.editReply(
      toDiscordUpdate(
        buildGiftCatalogMessage(
          catalog,
          input.route.expectedVersion,
          input.actor,
          input.secret(),
          new Date(),
          decodeGiftRecipientSelection(catalog.recipients, input.route.selection),
          input.route.page
        )
      )
    );
  } catch (error) {
    await giftFailure(input.interaction, error);
  }
}

export async function executeGiftButton(input: {
  interaction: ButtonInteraction;
  route: Extract<ServiceCenterRoute, { area: 'gift' }>;
  actor: BotActorContext;
  api: BotApiClient;
  secret: () => string;
}): Promise<void> {
  if (input.route.action === 'open') await input.interaction.deferReply({ ephemeral: true });
  else await input.interaction.deferUpdate();
  try {
    const secret = input.secret();
    if (input.route.action === 'open') {
      const [order, catalog] = await Promise.all([
        input.api.getOrder(input.route.orderId, input.actor),
        input.api.listGifts(input.route.orderId, input.actor)
      ]);
      await input.interaction.editReply(
        toDiscordUpdate(buildGiftCatalogMessage(catalog, order.version, input.actor, secret))
      );
      return;
    }
    const context = readGiftContinuationToken(input.route.token, input.actor, secret);
    const selectedParticipantIds = selectedGiftParticipantIds(input.interaction);
    if (selectedParticipantIds.length === 0)
      throw new Error('Gift recipients are missing from the interaction message.');
    if (input.route.action === 'back') {
      const [order, catalog] = await Promise.all([
        input.api.getOrder(context.orderId, input.actor),
        input.api.listGifts(context.orderId, input.actor)
      ]);
      await input.interaction.editReply(
        toDiscordUpdate(
          buildGiftCatalogMessage(catalog, order.version, input.actor, secret, new Date(), selectedParticipantIds)
        )
      );
      return;
    }
    const [affordability, catalog] = await Promise.all([
      input.api.checkGiftAffordability(
        context.orderId,
        context.giftCatalogVersionId,
        selectedParticipantIds,
        input.actor
      ),
      input.api.listGifts(context.orderId, input.actor)
    ]);
    const currentToken = createGiftContinuationToken(
      {
        orderId: context.orderId,
        orderVersion: context.orderVersion,
        giftCatalogVersionId: affordability.giftCatalogVersionId,
        catalogVersion: affordability.catalogVersion,
        priceMinor: affordability.priceMinor
      },
      input.actor,
      secret
    );
    const changed =
      affordability.catalogVersion !== context.catalogVersion || affordability.priceMinor !== context.priceMinor;
    if (input.route.action !== 'confirm' || changed || !affordability.canAfford) {
      const selectedRecipients = catalog.recipients.filter((recipient) =>
        selectedParticipantIds.includes(recipient.participantId)
      );
      await input.interaction.editReply(
        toDiscordUpdate(buildGiftAffordabilityMessage(affordability, currentToken, selectedRecipients))
      );
      return;
    }
    const created = await input.api.createOrderGiftRequest(
      context.orderId,
      {
        expectedOrderVersion: context.orderVersion,
        giftCatalogVersionId: context.giftCatalogVersionId,
        participantIds: selectedParticipantIds,
        expectedCatalogVersion: context.catalogVersion,
        expectedPriceMinor: context.priceMinor
      },
      input.actor,
      buildDiscordIdempotencyKey('gift:confirm', input.interaction.id)
    );
    await input.interaction.editReply(toDiscordUpdate(buildGiftRequestMessage(created)));
  } catch (error) {
    await giftFailure(input.interaction, error);
  }
}

async function giftFailure(interaction: ButtonInteraction, error: unknown): Promise<void> {
  const requestId = error instanceof BotApiError ? error.requestId : 'local-gift-context';
  await interaction.followUp({
    content: `礼物状态已变化，请返回礼物列表后重试。request_id: ${requestId}`,
    ephemeral: true
  });
}

function selectedGiftParticipantIds(interaction: ButtonInteraction): string[] {
  const message = interaction.message.toJSON() as {
    components?: Array<{
      components?: Array<{ custom_id?: string; options?: Array<{ value?: string; default?: boolean }> }>;
    }>;
  };
  const values =
    message.components
      ?.flatMap((row) => row.components ?? [])
      .flatMap((component) => {
        if (!component.custom_id?.startsWith('bc:gift:recipients:') && component.custom_id !== 'bc:gift:selected')
          return [];
        return (component.options ?? [])
          .filter((option) => option.default && typeof option.value === 'string')
          .map((option) => option.value!);
      }) ?? [];
  return [...new Set(values)];
}
