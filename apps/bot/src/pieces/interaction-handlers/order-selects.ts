import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { buildBotActorContext } from '../../actor-context.js';
import type { Interaction } from 'discord.js';
import { toDiscordUpdate } from '../../discord-renderer.js';
import { serviceCenterInteractionKind } from '../../service-center-route-registry.js';
import {
  buildDiscordIdempotencyKey,
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
import { getBotRuntimeDependencies } from '../../runtime-dependencies.js';
import {
  buildGiftAffordabilityMessage,
  buildGiftCatalogMessage,
  createGiftContinuationToken,
  decodeGiftRecipientSelection,
  readGiftContinuationToken
} from '../../gifts.js';
import { formatUnexpectedBotResult, formatUserFacingError } from '../../user-facing-error.js';

export default class OrderSelectHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) {
    super(context, { interactionHandlerType: InteractionHandlerTypes.SelectMenu });
  }

  public override parse(interaction: Interaction) {
    if (!interaction.isStringSelectMenu() && !interaction.isUserSelectMenu()) {
      return this.none();
    }
    const route = parseServiceCenterCustomId(interaction.customId);
    return serviceCenterInteractionKind(route) === 'select' ? this.some(route) : this.none();
  }

  public override async run(interaction: Interaction, parsedData?: ServiceCenterRoute): Promise<void> {
    if (
      (!interaction.isStringSelectMenu() && !interaction.isUserSelectMenu()) ||
      !parsedData ||
      (parsedData.area !== 'order-select' &&
        parsedData.area !== 'order-requirement-select' &&
        parsedData.area !== 'service-package-select' &&
        parsedData.area !== 'order-game-select' &&
        parsedData.area !== 'gift-recipient-select' &&
        parsedData.area !== 'gift-catalog-select')
    ) {
      return;
    }

    await interaction.deferUpdate();
    const actor: BotActorContext | null = buildBotActorContext(interaction);
    if (!actor) {
      await interaction.editReply({ content: '请在服务器内使用此菜单。request_id: local-guild-required' });
      return;
    }
    try {
      const dependencies = getBotRuntimeDependencies();
      const api = dependencies.api;
      if (parsedData.area === 'gift-catalog-select') {
        const secret = dependencies.giftContinuationSigningSecret;
        const token = interaction.values[0] ?? '';
        const context = readGiftContinuationToken(token, actor, secret);
        const catalog = await api.listGifts(context.orderId, actor);
        const participantIds = decodeGiftRecipientSelection(catalog.recipients, parsedData.selection);
        const affordability = await api.checkGiftAffordability(
          context.orderId,
          context.giftCatalogVersionId,
          participantIds,
          actor
        );
        const currentToken = createGiftContinuationToken(
          {
            orderId: context.orderId,
            orderVersion: context.orderVersion,
            giftCatalogVersionId: affordability.giftCatalogVersionId,
            catalogVersion: affordability.catalogVersion,
            priceMinor: affordability.priceMinor
          },
          actor,
          secret
        );
        const selected = catalog.recipients.filter((recipient) => participantIds.includes(recipient.participantId));
        await interaction.editReply(
          toDiscordUpdate(buildGiftAffordabilityMessage(affordability, currentToken, selected))
        );
        return;
      }
      if (parsedData.area === 'gift-recipient-select') {
        const catalog = await api.listGifts(parsedData.orderId, actor);
        const prior = decodeGiftRecipientSelection(catalog.recipients, parsedData.selection);
        const visible = catalog.recipients
          .slice(parsedData.page * 25, parsedData.page * 25 + 25)
          .map((recipient) => recipient.participantId);
        const selected = [...prior.filter((participantId) => !visible.includes(participantId)), ...interaction.values];
        await interaction.editReply(
          toDiscordUpdate(
            buildGiftCatalogMessage(
              catalog,
              parsedData.expectedVersion,
              actor,
              dependencies.giftContinuationSigningSecret,
              new Date(),
              selected,
              parsedData.page
            )
          )
        );
        return;
      }
      const result =
        parsedData.area === 'order-game-select'
          ? await handleGameMenuSelect({
              api,
              actor,
              orderId: parsedData.orderId,
              expectedVersion: parsedData.expectedVersion,
              game: interaction.values[0] ?? ''
            })
          : parsedData.area === 'service-package-select'
            ? await handleServicePackageSelect({
                api,
                actor,
                orderId: parsedData.orderId,
                expectedVersion: parsedData.expectedVersion,
                servicePackageVersionId: interaction.values[0] ?? ''
              })
            : parsedData.area === 'order-requirement-select'
              ? await handleOrderRequirementSelectSubmit({
                  api,
                  actor,
                  orderId: parsedData.orderId,
                  expectedVersion: parsedData.expectedVersion,
                  action: parsedData.action,
                  requirementId: parsedData.requirementId,
                  expectedRequirementVersion:
                    parsedData.action === 'project' || parsedData.action === 'units' || parsedData.action === 'players'
                      ? parsedData.expectedRequirementVersion
                      : undefined,
                  cursor: parsedData.action === 'edit' ? parsedData.cursor : undefined,
                  value: interaction.values[0] ?? '',
                  idempotencyKey: buildDiscordIdempotencyKey(`requirement:${parsedData.action}`, interaction.id)
                })
              : await handleOrderSelectSubmit({
                  api,
                  actor,
                  orderId: parsedData.orderId,
                  expectedVersion: parsedData.expectedVersion,
                  field: parsedData.field,
                  value: parsedData.field === 'preferred-players' ? interaction.values : (interaction.values[0] ?? ''),
                  idempotencyKey: buildDiscordIdempotencyKey(`order:update:${parsedData.field}`, interaction.id)
                });
      if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
        await interaction.editReply(toDiscordUpdate(result.message));
        return;
      }
      await interaction.editReply({
        content: formatUnexpectedBotResult(orderSelectOperation(parsedData), `discord-interaction-${interaction.id}`),
        components: []
      });
    } catch (error) {
      const preciseError = formatUserFacingError(error, {
        operation: orderSelectOperation(parsedData),
        localRequestId: `discord-interaction-${interaction.id}`
      });
      if (!('orderId' in parsedData)) {
        await interaction.followUp({
          content: preciseError,
          ephemeral: true
        });
        return;
      }
      try {
        const recoveryApi = getBotRuntimeDependencies().api;
        const [order, requirements, services, packages] = await Promise.all([
          recoveryApi.getOrder(parsedData.orderId, actor),
          recoveryApi.listOrderRequirements(parsedData.orderId, actor, undefined, 10),
          recoveryApi.listServices(actor),
          recoveryApi.listServicePackages(actor, undefined, 25)
        ]);
        const message = requirements.items.some((item) => item.status === 'ACTIVE')
          ? buildMultiProjectOrderPanelMessage(order, requirements, services.items)
          : buildGamePickerMessage(order, services.items, packages.items);
        await interaction.editReply(toDiscordUpdate(message));
        await interaction.followUp({ content: preciseError, ephemeral: true });
      } catch (recoveryError) {
        await interaction.followUp({
          content: `${preciseError}\n\n${formatUserFacingError(recoveryError, {
            operation: '恢复最新订单面板',
            localRequestId: `discord-interaction-${interaction.id}`
          })}`,
          ephemeral: true
        });
      }
    }
  }
}

function orderSelectOperation(route: ServiceCenterRoute): string {
  if (route.area === 'gift-catalog-select' || route.area === 'gift-recipient-select') return '更新礼物选择';
  if (route.area === 'order-game-select') return '选择订单游戏';
  if (route.area === 'service-package-select') return '选择订单套餐';
  if (route.area === 'order-requirement-select') return '修改订单服务项目';
  return '更新订单选项';
}
