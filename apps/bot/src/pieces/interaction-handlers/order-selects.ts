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
    if (!isSupportedSelect(interaction) || !isSupportedRoute(parsedData)) return;
    await interaction.deferUpdate();
    const actor = buildBotActorContext(interaction);
    if (!actor) {
      await interaction.editReply({ content: '请在服务器内使用此菜单。request_id: local-guild-required' });
      return;
    }
    try {
      await executeSelectRoute({ interaction, route: parsedData, actor });
    } catch (error) {
      await recoverSelectFailure({ interaction, route: parsedData, actor, error });
    }
  }
}

type SelectInteraction = Extract<Interaction, { values: string[] }>;
type SelectRoute = Extract<
  ServiceCenterRoute,
  {
    area:
      | 'order-select'
      | 'order-requirement-select'
      | 'service-package-select'
      | 'order-game-select'
      | 'gift-recipient-select'
      | 'gift-catalog-select';
  }
>;

function isSupportedSelect(interaction: Interaction): interaction is SelectInteraction {
  return interaction.isStringSelectMenu() || interaction.isUserSelectMenu();
}

function isSupportedRoute(route?: ServiceCenterRoute): route is SelectRoute {
  if (!route) return false;
  return [
    'order-select',
    'order-requirement-select',
    'service-package-select',
    'order-game-select',
    'gift-recipient-select',
    'gift-catalog-select'
  ].includes(route.area);
}

async function executeSelectRoute(input: {
  interaction: SelectInteraction;
  route: SelectRoute;
  actor: BotActorContext;
}): Promise<void> {
  if (input.route.area === 'gift-catalog-select') return executeGiftCatalogSelect({ ...input, route: input.route });
  if (input.route.area === 'gift-recipient-select') return executeGiftRecipientSelect({ ...input, route: input.route });
  return executeOrderOptionSelect({
    ...input,
    route: input.route
  });
}

async function executeGiftCatalogSelect(input: {
  interaction: SelectInteraction;
  route: Extract<SelectRoute, { area: 'gift-catalog-select' }>;
  actor: BotActorContext;
}): Promise<void> {
  const dependencies = getBotRuntimeDependencies();
  const secret = dependencies.giftContinuationSigningSecret;
  const token = input.interaction.values[0] ?? '';
  const context = readGiftContinuationToken(token, input.actor, secret);
  const catalog = await dependencies.api.listGifts(context.orderId, input.actor);
  const participantIds = decodeGiftRecipientSelection(catalog.recipients, input.route.selection);
  const affordability = await dependencies.api.checkGiftAffordability(
    context.orderId,
    context.giftCatalogVersionId,
    participantIds,
    input.actor
  );
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
  const selected = catalog.recipients.filter((recipient) => participantIds.includes(recipient.participantId));
  await input.interaction.editReply(
    toDiscordUpdate(buildGiftAffordabilityMessage(affordability, currentToken, selected))
  );
}

async function executeGiftRecipientSelect(input: {
  interaction: SelectInteraction;
  route: Extract<SelectRoute, { area: 'gift-recipient-select' }>;
  actor: BotActorContext;
}): Promise<void> {
  const dependencies = getBotRuntimeDependencies();
  const catalog = await dependencies.api.listGifts(input.route.orderId, input.actor);
  const prior = decodeGiftRecipientSelection(catalog.recipients, input.route.selection);
  const visible = catalog.recipients
    .slice(input.route.page * 25, input.route.page * 25 + 25)
    .map((recipient) => recipient.participantId);
  const selected = [...prior.filter((participantId) => !visible.includes(participantId)), ...input.interaction.values];
  await input.interaction.editReply(
    toDiscordUpdate(
      buildGiftCatalogMessage(
        catalog,
        input.route.expectedVersion,
        input.actor,
        dependencies.giftContinuationSigningSecret,
        new Date(),
        selected,
        input.route.page
      )
    )
  );
}

async function executeOrderOptionSelect(input: {
  interaction: SelectInteraction;
  route: Exclude<SelectRoute, { area: 'gift-catalog-select' | 'gift-recipient-select' }>;
  actor: BotActorContext;
}): Promise<void> {
  const { api } = getBotRuntimeDependencies();
  const value = input.interaction.values[0] ?? '';
  let result;
  if (input.route.area === 'order-game-select')
    result = await handleGameMenuSelect({
      api,
      actor: input.actor,
      orderId: input.route.orderId,
      expectedVersion: input.route.expectedVersion,
      game: value
    });
  else if (input.route.area === 'service-package-select')
    result = await handleServicePackageSelect({
      api,
      actor: input.actor,
      orderId: input.route.orderId,
      expectedVersion: input.route.expectedVersion,
      servicePackageVersionId: value
    });
  else if (input.route.area === 'order-requirement-select')
    result = await handleOrderRequirementSelectSubmit({
      api,
      actor: input.actor,
      orderId: input.route.orderId,
      expectedVersion: input.route.expectedVersion,
      action: input.route.action,
      requirementId: input.route.requirementId,
      expectedRequirementVersion:
        input.route.action === 'project' || input.route.action === 'units' || input.route.action === 'players'
          ? input.route.expectedRequirementVersion
          : undefined,
      cursor: input.route.action === 'edit' ? input.route.cursor : undefined,
      value,
      idempotencyKey: buildDiscordIdempotencyKey(`requirement:${input.route.action}`, input.interaction.id)
    });
  else
    result = await handleOrderSelectSubmit({
      api,
      actor: input.actor,
      orderId: input.route.orderId,
      expectedVersion: input.route.expectedVersion,
      field: input.route.field,
      value: input.route.field === 'preferred-players' ? input.interaction.values : value,
      idempotencyKey: buildDiscordIdempotencyKey(`order:update:${input.route.field}`, input.interaction.id)
    });
  if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
    await input.interaction.editReply(toDiscordUpdate(result.message));
    return;
  }
  await input.interaction.editReply({
    content: formatUnexpectedBotResult(
      orderSelectOperation(input.route),
      `discord-interaction-${input.interaction.id}`
    ),
    components: []
  });
}

async function recoverSelectFailure(input: {
  interaction: SelectInteraction;
  route: SelectRoute;
  actor: BotActorContext;
  error: unknown;
}): Promise<void> {
  const preciseError = formatUserFacingError(input.error, {
    operation: orderSelectOperation(input.route),
    localRequestId: `discord-interaction-${input.interaction.id}`
  });
  if (!('orderId' in input.route)) {
    await input.interaction.followUp({ content: preciseError, ephemeral: true });
    return;
  }
  try {
    const api = getBotRuntimeDependencies().api;
    const [order, requirements, services, packages] = await Promise.all([
      api.getOrder(input.route.orderId, input.actor),
      api.listOrderRequirements(input.route.orderId, input.actor, undefined, 10),
      api.listServices(input.actor),
      api.listServicePackages(input.actor, undefined, 25)
    ]);
    const message = requirements.items.some((item) => item.status === 'ACTIVE')
      ? buildMultiProjectOrderPanelMessage(order, requirements, services.items)
      : buildGamePickerMessage(order, services.items, packages.items);
    await input.interaction.editReply(toDiscordUpdate(message));
    await input.interaction.followUp({ content: preciseError, ephemeral: true });
  } catch (recoveryError) {
    await input.interaction.followUp({
      content: `${preciseError}\n\n${formatUserFacingError(recoveryError, {
        operation: '恢复最新订单面板',
        localRequestId: `discord-interaction-${input.interaction.id}`
      })}`,
      ephemeral: true
    });
  }
}

function orderSelectOperation(route: ServiceCenterRoute): string {
  if (route.area === 'gift-catalog-select' || route.area === 'gift-recipient-select') return '更新礼物选择';
  if (route.area === 'order-game-select') return '选择订单游戏';
  if (route.area === 'service-package-select') return '选择订单套餐';
  if (route.area === 'order-requirement-select') return '修改订单服务项目';
  return '更新订单选项';
}
