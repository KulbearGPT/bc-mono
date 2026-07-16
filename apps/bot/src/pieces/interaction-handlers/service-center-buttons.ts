import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { type ButtonInteraction, type Interaction } from 'discord.js';
import { botConfigCache } from '../../bot-config.js';
import { botCopy } from '../../bot-copy.js';
import { buildBotActorContext } from '../../actor-context.js';
import { toDiscordModal, toDiscordUpdate } from '../../discord-renderer.js';
import { createProvisionalPrivateOrderChannel, finalizePrivateOrderChannel } from '../../private-order-channel.js';
import { executeGiftButton, executeGiftRecipientPage } from '../../service-center-gift-interactions.js';
import { executeProfileButton, executeReportsButton } from '../../service-center-profile-interactions.js';
import { buildCurrentUserCommissionsMessage } from '../../service-center-profile.js';
import { serviceCenterInteractionKind } from '../../service-center-route-registry.js';
import { executeSupportRatingButton } from '../../service-center-support-interactions.js';
import {
  HttpBotApiClient,
  BotApiError,
  buildGamePickerMessage,
  buildMultiProjectOrderPanelMessage,
  buildOrderNotesModal,
  buildRequirementNoteModal,
  buildDiscordIdempotencyKey,
  handleOpenOrderConfirmation,
  handleOrderRequirementAction,
  handleOrderRequirementSelectSubmit,
  handleGameMenuSelect,
  handleServicePackageAction,
  handleOpenCancellationPreview,
  handleConfirmCancellation,
  handleCreateOrderFromPublicEntry,
  handleOpenPlayerWorkbench,
  handleOpenServiceCenterFromPublicEntry,
  handleServiceLifecycleAction,
  handleSubmitFinalOrder,
  parseServiceCenterCustomId,
  type BotActorContext,
  type ServiceCenterRoute
} from '../../service-center.js';

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
    if (!interaction.isButton() || !parsedData || parsedData.area === 'unknown') {
      return;
    }

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
        const requestId = error instanceof BotApiError ? error.requestId : 'local-commissions';
        await interaction.editReply(`我的收益暂时不可用。request_id: ${requestId}`);
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
        const requestId = error instanceof BotApiError ? error.requestId : 'local-order-open';
        await interaction.editReply(`暂时无法打开订单。request_id: ${requestId}`);
      }
      return;
    }

    if (parsedData.area === 'entry') {
      if (parsedData.action === 'service-center') {
        await this.openPrivateServiceCenter(interaction);
        return;
      }
      if (parsedData.action === 'player-workbench') {
        await this.openPlayerWorkbench(interaction);
        return;
      }

      await this.createOrderFromEntry(interaction);
      return;
    }

    if (parsedData.area === 'cancellation-action') {
      await this.confirmCancellation(interaction, parsedData);
      return;
    }
    if (parsedData.area === 'order-notes-open') {
      await interaction.showModal(
        toDiscordModal(
          buildOrderNotesModal({
            orderId: parsedData.orderId,
            expectedVersion: parsedData.expectedVersion
          })
        )
      );
      return;
    }
    if (parsedData.area === 'requirement-note-open') {
      await interaction.showModal(toDiscordModal(buildRequirementNoteModal(parsedData)));
      return;
    }

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
        const requestId = error instanceof BotApiError ? error.requestId : 'local-game-action';
        await interaction.followUp({
          content: `游戏菜单刚刚发生变化，请重试。request_id: ${requestId}`,
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
        const requestId = error instanceof BotApiError ? error.requestId : 'local-requirement-add';
        await interaction.followUp({
          content: `单点项目刚刚发生变化，请重试。request_id: ${requestId}`,
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
        const requestId = error instanceof BotApiError ? error.requestId : 'local-requirement-action';
        await interaction.followUp({
          content: `订单项目刚刚发生变化，请刷新后重试。request_id: ${requestId}`,
          ephemeral: true
        });
        return;
      }
    }

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
        const requestId = error instanceof BotApiError ? error.requestId : 'local-package-action';
        await interaction.followUp({
          content: `套餐清单刚刚发生变化，请重试。request_id: ${requestId}`,
          ephemeral: true
        });
        return;
      }
    }

    if (parsedData.area !== 'order-action') {
      if (parsedData.area === 'service-action') {
        await this.handleServiceLifecycleButton(interaction, parsedData);
      }
      return;
    }

    if (parsedData.action === 'submit' || parsedData.action === 'refresh') {
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
      content: '该订单操作将在后续步骤处理。request_id: local-action-pending',
      ephemeral: true
    });
  }

  private async createOrderFromEntry(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({
        content: '请在服务器内创建订单。',
        ephemeral: true
      });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const values = botConfigCache.get(interaction.guildId)?.values;
    const categoryId = typeof values?.private_order_category_id === 'string' ? values.private_order_category_id : null;
    if (values?.new_orders_enabled === false || !categoryId) {
      await interaction.editReply('当前未开放新订单，或尚未配置私密订单频道分类。');
      return;
    }
    let provisional = null;
    try {
      const staffRoleIds = ['staff_l1_role_id', 'staff_l2_role_id', 'staff_l3_role_id', 'staff_l4_role_id']
        .map((key) => values?.[key])
        .filter((id): id is string => typeof id === 'string');
      provisional = await createProvisionalPrivateOrderChannel({
        guild: interaction.guild,
        guildId: interaction.guildId,
        categoryId,
        customerDiscordUserId: interaction.user.id,
        botUserId: interaction.client.user.id,
        staffRoleIds,
        playerRoleId: typeof values?.player_role_id === 'string' ? values.player_role_id : null,
        provisionalName: interaction.user.username
          .toLowerCase()
          .replace(/[^a-z0-9-]/gu, '-')
          .slice(0, 80)
      });
      const { channel, panel: placeholder } = provisional;
      const actor = actorFromInteraction(interaction)!;
      const api = createBotApiClient();
      const result = await handleCreateOrderFromPublicEntry({
        api,
        actor,
        provisionalChannel: {
          channelId: provisional.channelId,
          panelMessageId: provisional.panelMessageId,
          voiceChannelId: null
        },
        idempotencyKey: buildDiscordIdempotencyKey('order:create', interaction.id)
      });
      if (result.kind === 'CREATE_PRIVATE_CHANNEL') {
        const [catalog, requirements, packages] = await Promise.all([
          api.listServices(actor),
          api.listOrderRequirements(result.order.id, actor, undefined, 10),
          api.listServicePackages(actor, undefined, 25)
        ]);
        const message = requirements.items.some((item) => item.status === 'ACTIVE')
          ? buildMultiProjectOrderPanelMessage(result.order, requirements, catalog.items)
          : buildGamePickerMessage(result.order, catalog.items, packages.items);
        await finalizePrivateOrderChannel({
          channel,
          panel: placeholder,
          orderPublicId: result.order.publicId,
          message: toDiscordUpdate(message)
        });
        await interaction.editReply(botCopy.entry.channelCreated(String(channel)));
        return;
      }
      if (result.kind === 'OPEN_EXISTING_CHANNEL') {
        const existing = await interaction.guild.channels.fetch(result.channelId).catch(() => null);
        if (existing) {
          await channel.delete('Duplicate provisional order channel').catch(() => undefined);
          await interaction.editReply(botCopy.entry.existingOrder(result.channelId));
          return;
        }
        const order = await api.getOrder(result.orderId, actor);
        const recovered = await api.recoverOrderChannel(
          result.orderId,
          {
            expectedVersion: order.version,
            previousChannelId: result.channelId,
            channelSpec: {
              channelId: provisional.channelId,
              panelMessageId: provisional.panelMessageId,
              voiceChannelId: order.channelSpec.voiceChannelId
            }
          },
          actor,
          buildDiscordIdempotencyKey(`order:recover-channel:${result.orderId}`, interaction.id)
        );
        const [catalog, requirements, packages] = await Promise.all([
          api.listServices(actor),
          api.listOrderRequirements(recovered.id, actor, undefined, 10),
          api.listServicePackages(actor, undefined, 25)
        ]);
        const message = requirements.items.some((item) => item.status === 'ACTIVE')
          ? buildMultiProjectOrderPanelMessage(recovered, requirements, catalog.items)
          : buildGamePickerMessage(recovered, catalog.items, packages.items);
        await finalizePrivateOrderChannel({
          channel,
          panel: placeholder,
          orderPublicId: recovered.publicId,
          message: toDiscordUpdate(message)
        });
        await interaction.editReply(botCopy.entry.channelCreated(String(channel)));
        return;
      }
      await channel.delete('Order creation failed').catch(() => undefined);
      await interaction.editReply(
        result.kind === 'EPHEMERAL_MESSAGE' || result.kind === 'CHANNEL_CREATION_FAILED'
          ? result.message
          : '暂时无法创建订单。'
      );
    } catch (error) {
      if (provisional) await provisional.channel.delete('Order creation failed').catch(() => undefined);
      if (error instanceof BotApiError) {
        await interaction.editReply(`订单处理失败，请稍后重试或联系猫舍前台。request_id: ${error.requestId}`);
        return;
      }
      await interaction.editReply(botCopy.orders.channelCreationFailed('local-order-channel-failed'));
    }
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
      content: '暂时无法处理订单状态。request_id: local-unhandled-result',
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
    await interaction.editReply('暂时无法打开服务中心。request_id: local-unhandled-result');
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
        : '暂时无法打开陪玩工作台。request_id: local-unhandled-result'
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
      content: '暂时无法打开确认面板。request_id: local-unhandled-result',
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
          : '暂时无法打开取消预览。request_id: local-unhandled-result',
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
      content: '暂时无法提交订单。request_id: local-unhandled-result',
      ephemeral: true
    });
  }
}

function createBotApiClient(): HttpBotApiClient {
  return new HttpBotApiClient({
    apiBaseUrl: process.env.API_BASE_URL ?? '',
    botServiceToken: process.env.BOT_SERVICE_TOKEN ?? ''
  });
}

function giftContinuationSecret(): string {
  const secret = process.env.GIFT_CONTINUATION_SIGNING_SECRET?.trim() || process.env.BOT_SERVICE_TOKEN?.trim() || '';
  if (secret.length < 32) throw new Error('Gift continuation signing secret is not configured.');
  return secret;
}

async function guildRequired(interaction: ButtonInteraction, action: string): Promise<void> {
  await interaction.reply({
    content: `请在服务器内${action}。request_id: local-guild-required`,
    ephemeral: true
  });
}

function actorFromInteraction(interaction: ButtonInteraction): BotActorContext | null {
  return buildBotActorContext(interaction);
}
