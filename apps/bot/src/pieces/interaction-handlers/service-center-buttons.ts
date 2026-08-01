import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { type ButtonInteraction, type Interaction } from 'discord.js';
import { botConfigCache } from '../../bot-config.js';
import { botCopy } from '../../bot-copy.js';
import { buildBotActorContext } from '../../actor-context.js';
import { toDiscordModal, toDiscordUpdate } from '../../discord-renderer.js';
import {
  cleanupProvisionalPrivateOrderChannel,
  createProvisionalPrivateOrderChannel,
  finalizePrivateOrderChannel
} from '../../private-order-channel.js';
import { executeGiftButton, executeGiftRecipientPage } from '../../service-center-gift-interactions.js';
import { executeProfileButton, executeReportsButton } from '../../service-center-profile-interactions.js';
import { buildCurrentUserCommissionsMessage } from '../../service-center-profile.js';
import { serviceCenterInteractionKind } from '../../service-center-route-registry.js';
import { executeSupportRatingButton } from '../../service-center-support-interactions.js';
import {
  HttpBotApiClient,
  buildGamePickerMessage,
  buildMultiProjectOrderPanelMessage,
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
  handleCreateOrderFromPublicEntry,
  handleOpenPlayerWorkbench,
  handleOpenServiceCenterFromPublicEntry,
  handleServiceLifecycleAction,
  handleSubmitFinalOrder,
  parseServiceCenterCustomId,
  type BotActorContext,
  type ServiceCenterRoute
} from '../../service-center.js';
import { formatDiscordError, formatUnexpectedBotResult } from '../../user-facing-error.js';
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
    let businessCommitted = false;
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
        businessCommitted = true;
        const [catalog, requirements, packages] = await Promise.all([
          api.listServices(actor),
          api.listOrderRequirements(result.order.id, actor, undefined, 10),
          api.listServicePackages(actor, undefined, 25)
        ]);
        const message = requirements.items.some((item) => item.status === 'ACTIVE')
          ? buildMultiProjectOrderPanelMessage(result.order, requirements, catalog.items)
          : buildGamePickerMessage(result.order, catalog.items, packages.items);
        const finalization = await finalizePrivateOrderChannel({
          channel,
          panel: placeholder,
          orderPublicId: result.order.publicId,
          message: toDiscordUpdate(message)
        });
        if (!finalization.renamed) {
          this.container.logger.error({
            event: 'bot.order_channel.rename_failed',
            guildId: interaction.guildId,
            channelId: channel.id,
            orderPublicId: result.order.publicId,
            error: finalization.error
          });
        }
        await interaction.editReply(
          `${botCopy.entry.channelCreated(String(channel))}${
            finalization.renamed
              ? ''
              : `\n频道名称暂未更新，请联系工作人员检查 Bot 权限。request_id: discord-interaction-${interaction.id}`
          }`
        );
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
        businessCommitted = true;
        const [catalog, requirements, packages] = await Promise.all([
          api.listServices(actor),
          api.listOrderRequirements(recovered.id, actor, undefined, 10),
          api.listServicePackages(actor, undefined, 25)
        ]);
        const message = requirements.items.some((item) => item.status === 'ACTIVE')
          ? buildMultiProjectOrderPanelMessage(recovered, requirements, catalog.items)
          : buildGamePickerMessage(recovered, catalog.items, packages.items);
        const finalization = await finalizePrivateOrderChannel({
          channel,
          panel: placeholder,
          orderPublicId: recovered.publicId,
          message: toDiscordUpdate(message)
        });
        if (!finalization.renamed) {
          this.container.logger.error({
            event: 'bot.order_channel.rename_failed',
            guildId: interaction.guildId,
            channelId: channel.id,
            orderPublicId: recovered.publicId,
            error: finalization.error
          });
        }
        await interaction.editReply(
          `${botCopy.entry.channelCreated(String(channel))}${
            finalization.renamed
              ? ''
              : `\n频道名称暂未更新，请联系工作人员检查 Bot 权限。request_id: discord-interaction-${interaction.id}`
          }`
        );
        return;
      }
      await channel.delete('Order creation failed').catch(() => undefined);
      await interaction.editReply(
        result.kind === 'EPHEMERAL_MESSAGE' || result.kind === 'CHANNEL_CREATION_FAILED'
          ? result.message
          : formatUnexpectedBotResult('创建订单', `discord-interaction-${interaction.id}`)
      );
    } catch (error) {
      if (provisional) {
        await cleanupProvisionalPrivateOrderChannel({
          channel: provisional.channel,
          businessCommitted,
          reason: 'Order creation failed'
        });
      }
      await interaction.editReply(formatDiscordError(error, '创建或恢复订单频道', interaction.id));
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
    content: `无法${action}：该功能需要可信的服务器身份，私信中没有 Guild 上下文。\n请返回目标 Discord 服务器后重新操作。\nrequest_id: discord-interaction-${interaction.id}`,
    ephemeral: true
  });
}

function actorFromInteraction(interaction: ButtonInteraction): BotActorContext | null {
  return buildBotActorContext(interaction);
}
