import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { BOT_COPY, botCopy } from '../../bot-copy.js';
import type { Interaction } from 'discord.js';
import { toDiscordUpdate } from '../../discord-renderer.js';
import {
  BotApiError,
  HttpBotApiClient,
  buildDiscordIdempotencyKey,
  buildOrderPanelMessage,
  buildGamePickerMessage,
  buildMultiProjectOrderPanelMessage,
  handleOrderRequirementSelectSubmit,
  handleGameMenuSelect,
  handleServicePackageSelect,
  handleOrderSelectSubmit,
  parseServiceCenterCustomId,
  type BotActorContext,
  type ServiceCenterRoute
} from '../../service-center.js';
import { buildGiftAffordabilityMessage, buildGiftCatalogMessage, createGiftContinuationToken, decodeGiftRecipientSelection, readGiftContinuationToken } from '../../gifts.js';

export default class OrderSelectHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) {
    super(context, { interactionHandlerType: InteractionHandlerTypes.SelectMenu });
  }

  public override parse(interaction: Interaction) {
    if (!interaction.isStringSelectMenu() && !interaction.isUserSelectMenu()) {
      return this.none();
    }
    const route = parseServiceCenterCustomId(interaction.customId);
    return route.area === 'order-select' || route.area === 'order-requirement-select' || route.area==='service-package-select' || route.area==='order-game-select' || route.area==='gift-recipient-select' || route.area==='gift-catalog-select' ? this.some(route) : this.none();
  }

  public override async run(interaction: Interaction, parsedData?: ServiceCenterRoute): Promise<void> {
    if ((!interaction.isStringSelectMenu() && !interaction.isUserSelectMenu()) || !parsedData || (parsedData.area !== 'order-select' && parsedData.area !== 'order-requirement-select'&&parsedData.area!=='service-package-select'&&parsedData.area!=='order-game-select'&&parsedData.area!=='gift-recipient-select'&&parsedData.area!=='gift-catalog-select')) {
      return;
    }

    await interaction.deferUpdate();
    const actor: BotActorContext = {
      guildId: interaction.guildId as string,
      discordUserId: interaction.user.id,
      interactionId: interaction.id,
      clientSource: 'DISCORD_BOT'
    };
    try {
      const api = new HttpBotApiClient({ apiBaseUrl: process.env.API_BASE_URL ?? '', botServiceToken: process.env.BOT_SERVICE_TOKEN ?? '' });
      if (parsedData.area === 'gift-catalog-select') {
        const secret = process.env.GIFT_CONTINUATION_SIGNING_SECRET?.trim() || process.env.BOT_SERVICE_TOKEN?.trim() || '';
        const token = interaction.values[0] ?? '';
        const context = readGiftContinuationToken(token, actor, secret);
        const catalog = await api.listGifts(context.orderId, actor);
        const participantIds = decodeGiftRecipientSelection(catalog.recipients, parsedData.selection);
        const affordability = await api.checkGiftAffordability(context.orderId, context.giftCatalogVersionId, participantIds, actor);
        const currentToken = createGiftContinuationToken({ orderId: context.orderId, orderVersion: context.orderVersion,
          giftCatalogVersionId: affordability.giftCatalogVersionId, catalogVersion: affordability.catalogVersion,
          priceMinor: affordability.priceMinor }, actor, secret);
        const selected = catalog.recipients.filter((recipient) => participantIds.includes(recipient.participantId));
        await interaction.editReply(toDiscordUpdate(buildGiftAffordabilityMessage(affordability, currentToken, selected)));
        return;
      }
      if (parsedData.area === 'gift-recipient-select') {
        const catalog = await api.listGifts(parsedData.orderId, actor);
        const prior = decodeGiftRecipientSelection(catalog.recipients, parsedData.selection);
        const visible = catalog.recipients.slice(parsedData.page * 25, parsedData.page * 25 + 25).map((recipient) => recipient.participantId);
        const selected = [...prior.filter((participantId) => !visible.includes(participantId)), ...interaction.values];
        await interaction.editReply(toDiscordUpdate(buildGiftCatalogMessage(catalog, parsedData.expectedVersion, actor,
          process.env.GIFT_CONTINUATION_SIGNING_SECRET?.trim() || process.env.BOT_SERVICE_TOKEN?.trim() || '', new Date(), selected, parsedData.page)));
        return;
      }
      const result = parsedData.area==='order-game-select'?await handleGameMenuSelect({api,actor,orderId:parsedData.orderId,expectedVersion:parsedData.expectedVersion,game:interaction.values[0]??''}):parsedData.area==='service-package-select'?await handleServicePackageSelect({api,actor,orderId:parsedData.orderId,expectedVersion:parsedData.expectedVersion,servicePackageVersionId:interaction.values[0]??''}):parsedData.area === 'order-requirement-select' ? await handleOrderRequirementSelectSubmit({
        api,
        actor,
        orderId: parsedData.orderId,
        expectedVersion: parsedData.expectedVersion,
        action: parsedData.action,
        requirementId: parsedData.requirementId,
        expectedRequirementVersion: parsedData.action === 'project' || parsedData.action === 'units' || parsedData.action === 'players' ? parsedData.expectedRequirementVersion : undefined,
        cursor: parsedData.action === 'edit' ? parsedData.cursor : undefined,
        value: interaction.values[0] ?? '',
        idempotencyKey: buildDiscordIdempotencyKey(`requirement:${parsedData.action}`, interaction.id)
      }) : await handleOrderSelectSubmit({
        api,
        actor,
        orderId: parsedData.orderId,
        expectedVersion: parsedData.expectedVersion,
        field: parsedData.field,
        value: parsedData.field === 'preferred-players' ? interaction.values : interaction.values[0] ?? '',
        idempotencyKey: buildDiscordIdempotencyKey(`order:update:${parsedData.field}`, interaction.id)
      });
      if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
        await interaction.editReply(toDiscordUpdate(result.message));
        return;
      }
      await interaction.editReply({ content: BOT_COPY.orders.optionUpdateFailed, components: [] });
    } catch (error) {
      const requestId = error instanceof BotApiError ? error.requestId : 'local-order-select-failed';
      if (!('orderId' in parsedData)) {
        await interaction.followUp({ content: `礼物状态已变化，请返回礼物列表后重试。request_id: ${requestId}`, ephemeral: true });
        return;
      }
      try {
        const recoveryApi = new HttpBotApiClient({ apiBaseUrl: process.env.API_BASE_URL ?? '', botServiceToken: process.env.BOT_SERVICE_TOKEN ?? '' });
        const [order, requirements, services, packages] = await Promise.all([
          recoveryApi.getOrder(parsedData.orderId, actor),
          recoveryApi.listOrderRequirements(parsedData.orderId, actor, undefined, 10),
          recoveryApi.listServices(actor),
          recoveryApi.listServicePackages(actor, undefined, 25)
        ]);
        const message=requirements.items.some((item)=>item.status==='ACTIVE')
          ?buildMultiProjectOrderPanelMessage(order,requirements,services.items)
          :buildGamePickerMessage(order,services.items,packages.items);
        await interaction.editReply(toDiscordUpdate(message));
        await interaction.followUp({ content: botCopy.orders.optionSaveFailed(requestId), ephemeral: true });
      } catch {
        await interaction.followUp({ content: botCopy.orders.menuRecoveryFailed(requestId), ephemeral: true });
      }
    }
  }
}
