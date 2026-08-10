import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { type ButtonInteraction, type Interaction } from 'discord.js';
import { buildBotActorContext } from '../../actor-context.js';
import { toDiscordModal, toDiscordUpdate } from '../../discord-renderer.js';
import { executeCreateOrderFromEntry } from '../../public-entry-order-interactions.js';
import { executeGiftButton, executeGiftRecipientPage } from '../../service-center-gift-interactions.js';
import { executeProfileButton, executeReportsButton } from '../../service-center-profile-interactions.js';
import { buildCurrentUserCommissionsMessage } from '../../service-center-profile.js';
import { serviceCenterInteractionKind } from '../../service-center-route-registry.js';
import { executeSupportRatingButton } from '../../service-center-support-interactions.js';
import { executeOrderExperienceReviewButton } from '../../order-experience-review-interactions.js';
import { executeStandaloneGiftButton } from '../../standalone-gifts.js';
import {
  buildOrderNotesModal,
  buildRequirementNoteModal,
  buildDiscordIdempotencyKey,
  handleOpenOrderConfirmation,
  handleOrderRefresh,
  handleOrderRequirementAction,
  handleOrderRequirementSelectSubmit,
  handleGameMenuSelect,
  handleServicePackageAction,
  handleOpenCancellationPreview,
  handleConfirmCancellation,
  handleOpenPlayerWorkbench,
  handleOpenServiceCenterFromPublicEntry,
  handleServiceLifecycleAction,
  handleSubmitFinalOrder,
  parseServiceCenterCustomId,
  type BotActorContext,
  type ServiceCenterRoute
} from '../../service-center.js';
import { getBotRuntimeDependencies } from '../../runtime-dependencies.js';
import { formatDiscordError, formatUnexpectedBotResult } from '../../user-facing-error.js';
const accountRouteAreas = new Set<ServiceCenterRoute['area']>([
  'profile',
  'reports',
  'gift',
  'gift-recipient-page',
  'support-rating',
  'service-center-action',
  'order-open',
  'experience-review'
]);
const entryRouteAreas = new Set<ServiceCenterRoute['area']>([
  'entry',
  'cancellation-action',
  'order-notes-open',
  'order-menu-notes-open',
  'requirement-note-open'
]);
const editorRouteAreas = new Set<ServiceCenterRoute['area']>([
  'order-game-action',
  'order-requirement-add-action',
  'order-requirement-action'
]);
const packageRouteAreas = new Set<ServiceCenterRoute['area']>(['service-package-action']);

export default class ServiceCenterButtonHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) {
    super(context, { interactionHandlerType: InteractionHandlerTypes.Button });
  }

  public override parse(interaction: Interaction) {
    if (!interaction.isButton()) {
      return this.none();
    }
    const route = parseServiceCenterCustomId(interaction.customId);
    return serviceCenterInteractionKind(route) === 'button' ? this.some(route) : this.none();
  }

  public override async run(interaction: Interaction, parsedData?: ServiceCenterRoute): Promise<void> {
    try {
      await this.dispatch(interaction, parsedData);
    } catch (error) {
      if (!interaction.isButton()) return;
      this.container.logger.error({
        event: 'bot.service_center.interaction_failed',
        guildId: interaction.guildId,
        discordUserId: interaction.user.id,
        customId: interaction.customId,
        error
      });
      const response = {
        content: formatDiscordError(error, '处理服务中心操作', interaction.id),
        ephemeral: true as const
      };
      if (interaction.deferred || interaction.replied) await interaction.followUp(response);
      else await interaction.reply(response);
    }
  }

  private async dispatch(interaction: Interaction, route?: ServiceCenterRoute): Promise<void> {
    if (!interaction.isButton() || !route || route.area === 'unknown') return;
    if (route.area === 'standalone-gift') return this.dispatchStandaloneGift(interaction, route);
    if (accountRouteAreas.has(route.area)) return this.dispatchAccountRoute(interaction, route);
    if (entryRouteAreas.has(route.area)) return this.dispatchEntryRoute(interaction, route);
    if (editorRouteAreas.has(route.area)) return this.dispatchEditorRoute(interaction, route);
    if (packageRouteAreas.has(route.area)) return this.dispatchPackageRoute(interaction, route);
    return this.dispatchOrderRoute(interaction, route);
  }

  private async dispatchAccountRoute(interaction: ButtonInteraction, parsedData: ServiceCenterRoute): Promise<void> {
    if (parsedData.area === 'profile') {
      const actor = actorFromInteraction(interaction);
      if (!actor) return void (await guildRequired(interaction, '打开个人中心'));
      await executeProfileButton({ interaction, route: parsedData, actor, api: createBotApiClient() });
      return;
    }
    if (parsedData.area === 'reports') {
      const actor = actorFromInteraction(interaction);
      if (!actor) return void (await guildRequired(interaction, '打开我的周报'));
      await executeReportsButton({ interaction, route: parsedData, actor, api: createBotApiClient() });
      return;
    }
    if (parsedData.area === 'gift') {
      const actor = actorFromInteraction(interaction);
      if (!actor) return void (await guildRequired(interaction, '赠送礼物'));
      await executeGiftButton({
        interaction,
        route: parsedData,
        actor,
        api: createBotApiClient(),
        secret: giftContinuationSecret
      });
      return;
    }
    if (parsedData.area === 'gift-recipient-page') {
      const actor = actorFromInteraction(interaction);
      if (!actor) return void (await guildRequired(interaction, '浏览礼物接收人'));
      await executeGiftRecipientPage({
        interaction,
        route: parsedData,
        actor,
        api: createBotApiClient(),
        secret: giftContinuationSecret
      });
      return;
    }

    if (parsedData.area === 'support-rating') {
      const actor = actorFromInteraction(interaction);
      if (!actor) return void (await guildRequired(interaction, '评价客服'));
      await executeSupportRatingButton({ interaction, route: parsedData, actor, api: createBotApiClient() });
      return;
    }

    if (parsedData.area === 'experience-review') {
      const actor = actorFromInteraction(interaction);
      if (!actor) return void (await guildRequired(interaction, '评价本次服务'));
      const dependencies = getBotRuntimeDependencies();
      await executeOrderExperienceReviewButton({
        interaction,
        route: parsedData,
        actor,
        api: dependencies.api,
        secret: dependencies.reviewContinuationSigningSecret
      });
      return;
    }

    if (parsedData.area === 'service-center-action') {
      if (parsedData.action === 'recharge') {
        await interaction.reply({
          content: '请联系猫舍前台并提交付款 receipt；到账与换汇结果以客服核对后的猫条钱包为准。',
          ephemeral: true
        });
        return;
      }
      const actor = actorFromInteraction(interaction);
      if (!actor) return void (await guildRequired(interaction, '查看我的收益'));
      await interaction.deferReply({ ephemeral: true });
      try {
        const commissions = await createBotApiClient().listCurrentUserCommissions(actor);
        await interaction.editReply(toDiscordUpdate(buildCurrentUserCommissionsMessage(commissions)));
      } catch (error) {
        await interaction.editReply(formatDiscordError(error, '查看我的收益', interaction.id));
      }
      return;
    }

    if (parsedData.area === 'order-open') {
      const actor = actorFromInteraction(interaction);
      if (!actor) return void (await guildRequired(interaction, '打开订单'));
      await interaction.deferReply({ ephemeral: true });
      try {
        const order = await createBotApiClient().getOrder(parsedData.orderId, actor);
        await interaction.editReply(`订单 #${order.publicId}：<#${order.channelSpec.channelId}>`);
      } catch (error) {
        await interaction.editReply(formatDiscordError(error, '打开订单频道', interaction.id));
      }
      return;
    }
  }

  private async dispatchStandaloneGift(
    interaction: ButtonInteraction,
    route: Extract<ServiceCenterRoute, { area: 'standalone-gift' }>
  ) {
    const actor = actorFromInteraction(interaction);
    if (!actor) return void (await guildRequired(interaction, '赠送礼物'));
    const dependencies = getBotRuntimeDependencies();
    await executeStandaloneGiftButton({
      interaction,
      route,
      actor,
      api: dependencies.api,
      secret: () => dependencies.giftContinuationSigningSecret
    });
  }

  private async dispatchEntryRoute(interaction: ButtonInteraction, parsedData: ServiceCenterRoute): Promise<void> {
    if (parsedData.area === 'entry') {
      if (parsedData.action === 'service-center') {
        await this.openPrivateServiceCenter(interaction);
        return;
      }
      if (parsedData.action === 'player-workbench') {
        await this.openPlayerWorkbench(interaction);
        return;
      }

      await executeCreateOrderFromEntry({ interaction, api: createBotApiClient() });
      return;
    }

    if (parsedData.area === 'cancellation-action') {
      await this.confirmCancellation(interaction, parsedData);
      return;
    }
    if (parsedData.area === 'order-notes-open' || parsedData.area === 'order-menu-notes-open') {
      await interaction.showModal(
        toDiscordModal(
          buildOrderNotesModal({
            orderId: parsedData.orderId,
            expectedVersion: parsedData.expectedVersion,
            returnGame: parsedData.area === 'order-menu-notes-open' ? parsedData.game : undefined
          })
        )
      );
      return;
    }
    if (parsedData.area === 'requirement-note-open') {
      await interaction.showModal(toDiscordModal(buildRequirementNoteModal(parsedData)));
      return;
    }
  }

  private async dispatchEditorRoute(interaction: ButtonInteraction, parsedData: ServiceCenterRoute): Promise<void> {
    if (parsedData.area === 'order-game-action') {
      const actor = actorFromInteraction(interaction);
      if (!actor) {
        await interaction.reply({
          content: '请在服务器内选择游戏。request_id: local-guild-required',
          ephemeral: true
        });
        return;
      }
      await interaction.deferUpdate();
      try {
        const result = await handleGameMenuSelect({
          api: createBotApiClient(),
          actor,
          orderId: parsedData.orderId,
          expectedVersion: parsedData.expectedVersion,
          game: parsedData.game
        });
        if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
          await interaction.editReply(toDiscordUpdate(result.message));
          return;
        }
      } catch (error) {
        await interaction.followUp({
          content: formatDiscordError(error, '选择订单游戏', interaction.id),
          ephemeral: true
        });
        return;
      }
    }

    if (parsedData.area === 'order-requirement-add-action') {
      const actor = actorFromInteraction(interaction);
      if (!actor) {
        await interaction.reply({
          content: '请在服务器内添加单点。request_id: local-guild-required',
          ephemeral: true
        });
        return;
      }
      await interaction.deferUpdate();
      try {
        const result = await handleOrderRequirementSelectSubmit({
          api: createBotApiClient(),
          actor,
          orderId: parsedData.orderId,
          expectedVersion: parsedData.expectedVersion,
          action: 'add',
          value: parsedData.serviceCatalogVersionId,
          idempotencyKey: buildDiscordIdempotencyKey('requirement:add', interaction.id)
        });
        if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
          await interaction.editReply(toDiscordUpdate(result.message));
          return;
        }
      } catch (error) {
        await interaction.followUp({
          content: formatDiscordError(error, '添加订单服务项目', interaction.id),
          ephemeral: true
        });
        return;
      }
    }

    if (parsedData.area === 'order-requirement-action') {
      const actor = actorFromInteraction(interaction);
      if (!actor) {
        await interaction.reply({
          content: '请在服务器内修改订单。request_id: local-guild-required',
          ephemeral: true
        });
        return;
      }
      await interaction.deferUpdate();
      try {
        const result = await handleOrderRequirementAction({
          api: createBotApiClient(),
          actor,
          orderId: parsedData.orderId,
          expectedVersion: parsedData.expectedVersion,
          action: parsedData.action,
          requirementId: parsedData.action === 'remove' ? parsedData.requirementId : undefined,
          expectedRequirementVersion:
            parsedData.action === 'remove' ? parsedData.expectedRequirementVersion : undefined,
          cursor: parsedData.action === 'page' ? parsedData.cursor : undefined,
          idempotencyKey: buildDiscordIdempotencyKey(`requirement:${parsedData.action}`, interaction.id)
        });
        if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
          await interaction.editReply(toDiscordUpdate(result.message));
          return;
        }
      } catch (error) {
        await interaction.followUp({
          content: formatDiscordError(error, '修改订单服务项目', interaction.id),
          ephemeral: true
        });
        return;
      }
    }
  }

  private async dispatchPackageRoute(interaction: ButtonInteraction, parsedData: ServiceCenterRoute): Promise<void> {
    if (parsedData.area === 'service-package-action') {
      const actor = actorFromInteraction(interaction);
      if (!actor) {
        await interaction.reply({
          content: '请在服务器内选择套餐。request_id: local-guild-required',
          ephemeral: true
        });
        return;
      }
      await interaction.deferUpdate();
      try {
        const result = await handleServicePackageAction({
          api: createBotApiClient(),
          actor,
          orderId: parsedData.orderId,
          expectedVersion: parsedData.expectedVersion,
          action: parsedData.action,
          servicePackageVersionId:
            parsedData.action === 'apply' || parsedData.action === 'preview'
              ? parsedData.servicePackageVersionId
              : undefined,
          idempotencyKey: buildDiscordIdempotencyKey(`package:${parsedData.action}`, interaction.id)
        });
        if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
          await interaction.editReply(toDiscordUpdate(result.message));
          return;
        }
      } catch (error) {
        await interaction.followUp({
          content: formatDiscordError(error, '处理订单套餐', interaction.id),
          ephemeral: true
        });
        return;
      }
    }
  }

  private async dispatchOrderRoute(interaction: ButtonInteraction, parsedData: ServiceCenterRoute): Promise<void> {
    if (parsedData.area === 'order-refresh') {
      const actor = actorFromInteraction(interaction);
      if (!actor) return void (await guildRequired(interaction, '刷新订单'));
      await interaction.deferUpdate();
      const result = await handleOrderRefresh({ api: createBotApiClient(), actor, orderId: parsedData.orderId });
      if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
        await interaction.editReply(toDiscordUpdate(result.message));
      } else {
        await interaction.followUp({ content: result.message, ephemeral: true });
      }
      return;
    }

    if (parsedData.area !== 'order-action') {
      if (parsedData.area === 'service-action') {
        await this.handleServiceLifecycleButton(interaction, parsedData);
      }
      return;
    }

    if (parsedData.action === 'submit') {
      await this.openOrderConfirmation(interaction, parsedData);
      return;
    }

    if (parsedData.action === 'submit-final') {
      await this.submitFinalOrder(interaction, parsedData);
      return;
    }

    if (parsedData.action === 'cancel') {
      await this.openCancellationPreview(interaction, parsedData);
      return;
    }

    await interaction.reply({
      content: `这个订单操作已失效，请刷新订单后使用最新按钮。\nrequest_id: discord-interaction-${interaction.id}`,
      ephemeral: true
    });
  }

  private async handleServiceLifecycleButton(
    interaction: ButtonInteraction,
    route: Extract<ServiceCenterRoute, { area: 'service-action' }>
  ): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({
        content: '请在服务器内操作订单状态。request_id: local-guild-required',
        ephemeral: true
      });
      return;
    }

    const api = createBotApiClient();
    await interaction.deferUpdate();
    const result = await handleServiceLifecycleAction({
      api,
      actor,
      orderId: route.orderId,
      action: route.action,
      expectedVersion: route.expectedVersion,
      idempotencyKey: buildDiscordIdempotencyKey(`service:${route.action}`, interaction.id)
    });
    if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
      await interaction.editReply(toDiscordUpdate(result.message));
      return;
    }
    if (result.kind === 'EPHEMERAL_MESSAGE') {
      await interaction.followUp({ content: result.message, ephemeral: true });
      return;
    }
    await interaction.followUp({
      content: formatUnexpectedBotResult('处理订单状态', `discord-interaction-${interaction.id}`),
      ephemeral: true
    });
  }

  private async openPrivateServiceCenter(interaction: ButtonInteraction): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({
        content: '请在服务器内打开服务中心。request_id: local-guild-required',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const api = createBotApiClient();
    const result = await handleOpenServiceCenterFromPublicEntry({ api, actor });
    if (result.kind === 'SHOW_SERVICE_CENTER') {
      await interaction.editReply(toDiscordUpdate(result.message));
      return;
    }
    if (result.kind === 'EPHEMERAL_MESSAGE') {
      await interaction.editReply(result.message);
      return;
    }
    await interaction.editReply(formatUnexpectedBotResult('打开服务中心', `discord-interaction-${interaction.id}`));
  }

  private async openPlayerWorkbench(interaction: ButtonInteraction): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({
        content: '请在服务器内打开陪玩工作台。request_id: local-guild-required',
        ephemeral: true
      });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const result = await handleOpenPlayerWorkbench({
      api: createBotApiClient(),
      actor
    });
    if (result.kind === 'SHOW_PLAYER_WORKBENCH') {
      await interaction.editReply(toDiscordUpdate(result.message));
      return;
    }
    await interaction.editReply(
      result.kind === 'EPHEMERAL_MESSAGE'
        ? result.message
        : formatUnexpectedBotResult('打开陪玩工作台', `discord-interaction-${interaction.id}`)
    );
  }

  private async openOrderConfirmation(
    interaction: ButtonInteraction,
    route: Extract<ServiceCenterRoute, { area: 'order-action' }>
  ): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({
        content: '请在服务器内确认订单。request_id: local-guild-required',
        ephemeral: true
      });
      return;
    }

    await interaction.deferUpdate();
    const api = createBotApiClient();
    const result = await handleOpenOrderConfirmation({
      api,
      actor,
      orderId: route.orderId,
      expectedVersion: route.expectedVersion,
      idempotencyKey: buildDiscordIdempotencyKey('order:estimate', interaction.id)
    });
    if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
      await interaction.editReply(toDiscordUpdate(result.message));
      return;
    }
    if (result.kind === 'EPHEMERAL_MESSAGE') {
      await interaction.followUp({ content: result.message, ephemeral: true });
      return;
    }
    await interaction.followUp({
      content: formatUnexpectedBotResult('打开订单确认面板', `discord-interaction-${interaction.id}`),
      ephemeral: true
    });
  }

  private async openCancellationPreview(
    interaction: ButtonInteraction,
    route: Extract<ServiceCenterRoute, { area: 'order-action' }>
  ): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({
        content: '请在服务器内取消订单。request_id: local-guild-required',
        ephemeral: true
      });
      return;
    }
    await interaction.deferUpdate();
    const result = await handleOpenCancellationPreview({
      api: createBotApiClient(),
      actor,
      orderId: route.orderId,
      expectedVersion: route.expectedVersion,
      idempotencyKey: buildDiscordIdempotencyKey('order:cancel-preview', interaction.id)
    });
    if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
      await interaction.editReply(toDiscordUpdate(result.message));
      return;
    }
    await interaction.followUp({
      content:
        result.kind === 'EPHEMERAL_MESSAGE'
          ? result.message
          : formatUnexpectedBotResult('打开订单取消说明', `discord-interaction-${interaction.id}`),
      ephemeral: true
    });
  }

  private async confirmCancellation(
    interaction: ButtonInteraction,
    route: Extract<ServiceCenterRoute, { area: 'cancellation-action' }>
  ): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({
        content: '请在服务器内取消订单。request_id: local-guild-required',
        ephemeral: true
      });
      return;
    }
    await interaction.deferUpdate();
    const result = await handleConfirmCancellation({
      api: createBotApiClient(),
      actor,
      orderId: route.orderId,
      previewId: route.previewId,
      expectedVersion: route.expectedVersion,
      idempotencyKey: buildDiscordIdempotencyKey('order:cancel-confirm', interaction.id)
    });
    if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
      await interaction.editReply(toDiscordUpdate(result.message));
      if (result.notice) await interaction.followUp({ content: result.notice, ephemeral: true });
      return;
    }
    await interaction.followUp({
      content: result.kind === 'EPHEMERAL_MESSAGE' ? result.message : '取消请求已处理。',
      ephemeral: true
    });
  }

  private async submitFinalOrder(
    interaction: ButtonInteraction,
    route: Extract<ServiceCenterRoute, { area: 'order-action' }>
  ): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({
        content: '请在服务器内提交订单。request_id: local-guild-required',
        ephemeral: true
      });
      return;
    }

    await interaction.deferUpdate();
    const api = createBotApiClient();
    const result = await handleSubmitFinalOrder({
      api,
      actor,
      orderId: route.orderId,
      expectedVersion: route.expectedVersion,
      idempotencyKey: buildDiscordIdempotencyKey('order:submit-final', interaction.id)
    });
    if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
      await interaction.editReply(toDiscordUpdate(result.message));
      return;
    }
    if (result.kind === 'EPHEMERAL_MESSAGE') {
      await interaction.followUp({ content: result.message, ephemeral: true });
      return;
    }
    await interaction.followUp({
      content: formatUnexpectedBotResult('提交订单', `discord-interaction-${interaction.id}`),
      ephemeral: true
    });
  }
}

function createBotApiClient() {
  return getBotRuntimeDependencies().api;
}

function giftContinuationSecret(): string {
  return getBotRuntimeDependencies().giftContinuationSigningSecret;
}

async function guildRequired(interaction: ButtonInteraction, action: string): Promise<void> {
  await interaction.reply({
    content: `无法${action}：该功能需要可信的服务器身份，私信中没有 Guild 上下文。\n请返回目标 Discord 服务器后重新操作。\nrequest_id: discord-interaction-${interaction.id}`,
    ephemeral: true
  });
}

function actorFromInteraction(interaction: ButtonInteraction): BotActorContext | null {
  return buildBotActorContext(interaction);
}
