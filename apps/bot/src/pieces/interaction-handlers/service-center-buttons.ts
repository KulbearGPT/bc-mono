import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { ChannelType, PermissionFlagsBits, type ButtonInteraction, type Interaction } from 'discord.js';
import { botConfigCache } from '../../bot-config.js';
import { botCopy } from '../../bot-copy.js';
import { toDiscordModal, toDiscordReply } from '../../discord-renderer.js';
import { buildGiftAffordabilityMessage, buildGiftCatalogMessage, buildGiftRequestMessage,
  createGiftContinuationToken, readGiftContinuationToken } from '../../gifts.js';
import {
  HttpBotApiClient,
  BotApiError,
  buildOrderPanelMessage,
  buildMultiProjectOrderPanelMessage,
  buildOrderNotesModal,
  buildRequirementNoteModal,
  buildCurrentPlayerWeeklyReportDetailMessage,
  buildCurrentPlayerWeeklyReportListMessage,
  buildCurrentUserConsumptionsMessage,
  buildCurrentUserOrdersMessage,
  buildCurrentUserProfileMessage,
  buildDiscordIdempotencyKey,
  handleOpenOrderConfirmation,
  handleOrderRequirementAction,
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
    return route.area === 'entry' || route.area === 'order-action' || route.area === 'order-requirement-action' || route.area==='service-package-action' || route.area === 'order-notes-open' || route.area==='requirement-note-open' || route.area === 'service-action' || route.area === 'player-action' || route.area === 'cancellation-action' || route.area === 'profile' || route.area === 'reports' || route.area === 'gift'
      ? this.some(route)
      : this.none();
  }

  public override async run(interaction: Interaction, parsedData?: ServiceCenterRoute): Promise<void> {
    if (!interaction.isButton() || !parsedData || parsedData.area === 'unknown') {
      return;
    }

    if (parsedData.area === 'profile') {
      await this.handleProfile(interaction, parsedData);
      return;
    }
    if (parsedData.area === 'reports') {
      await this.handleReports(interaction, parsedData);
      return;
    }
    if (parsedData.area === 'gift') {
      await this.handleGift(interaction, parsedData);
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

    if (parsedData.area === 'player-action') {
      await this.setPlayerAvailable(interaction, parsedData.expectedVersion);
      return;
    }

    if (parsedData.area === 'cancellation-action') {
      await this.confirmCancellation(interaction, parsedData);
      return;
    }
    if(parsedData.area==='order-notes-open'){await interaction.showModal(toDiscordModal(buildOrderNotesModal({orderId:parsedData.orderId,expectedVersion:parsedData.expectedVersion})));return;}
    if(parsedData.area==='requirement-note-open'){await interaction.showModal(toDiscordModal(buildRequirementNoteModal(parsedData)));return;}

    if(parsedData.area==='order-requirement-action'){
      const actor=actorFromInteraction(interaction);if(!actor){await interaction.reply({content:'请在服务器内修改订单。request_id: local-guild-required',ephemeral:true});return;}
      try{const result=await handleOrderRequirementAction({api:createBotApiClient(),actor,orderId:parsedData.orderId,expectedVersion:parsedData.expectedVersion,action:parsedData.action,requirementId:parsedData.action==='remove'?parsedData.requirementId:undefined,expectedRequirementVersion:parsedData.action==='remove'?parsedData.expectedRequirementVersion:undefined,cursor:parsedData.action==='page'?parsedData.cursor:undefined,idempotencyKey:buildDiscordIdempotencyKey(`requirement:${parsedData.action}`,interaction.id)});if(result.kind==='EDIT_ORIGINAL_MESSAGE'){const reply=toDiscordReply(result.message);await interaction.update({content:null,embeds:reply.embeds,components:reply.components});return;}}
      catch(error){const requestId=error instanceof BotApiError?error.requestId:'local-requirement-action';await interaction.reply({content:`订单项目刚刚发生变化，请刷新后重试。request_id: ${requestId}`,ephemeral:true});return;}
    }

    if(parsedData.area==='service-package-action'){
      const actor=actorFromInteraction(interaction);if(!actor){await interaction.reply({content:'请在服务器内选择套餐。request_id: local-guild-required',ephemeral:true});return;}try{const result=await handleServicePackageAction({api:createBotApiClient(),actor,orderId:parsedData.orderId,expectedVersion:parsedData.expectedVersion,action:parsedData.action,servicePackageVersionId:parsedData.action==='apply'?parsedData.servicePackageVersionId:undefined,idempotencyKey:buildDiscordIdempotencyKey(`package:${parsedData.action}`,interaction.id)});if(result.kind==='EDIT_ORIGINAL_MESSAGE'){const reply=toDiscordReply(result.message);await interaction.update({content:null,embeds:reply.embeds,components:reply.components});return;}}catch(error){const requestId=error instanceof BotApiError?error.requestId:'local-package-action';await interaction.reply({content:`套餐清单刚刚发生变化，请重试。request_id: ${requestId}`,ephemeral:true});return;}
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

    await interaction.reply({ content: '该订单操作将在后续步骤处理。request_id: local-action-pending', ephemeral: true });
  }

  private async createOrderFromEntry(interaction: ButtonInteraction):Promise<void>{
    if(!interaction.guild||!interaction.guildId){await interaction.reply({content:'请在服务器内创建订单。',ephemeral:true});return;}
    await interaction.deferReply({ephemeral:true});
    const values=botConfigCache.get(interaction.guildId)?.values;
    const categoryId=typeof values?.private_order_category_id==='string'?values.private_order_category_id:null;
    if(values?.new_orders_enabled===false||!categoryId){await interaction.editReply('当前未开放新订单，或尚未配置私密订单频道分类。');return;}
    let channel=null;
    try{
      const staffRoleIds=['staff_l1_role_id','staff_l2_role_id','staff_l3_role_id','staff_l4_role_id'].map((key)=>values?.[key]).filter((id):id is string=>typeof id==='string');
      channel=await interaction.guild.channels.create({name:`order-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/gu,'-').slice(0,80),type:ChannelType.GuildText,parent:categoryId,
        permissionOverwrites:[{id:interaction.guildId,deny:[PermissionFlagsBits.ViewChannel]},{id:interaction.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]},{id:interaction.client.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ManageChannels]},...staffRoleIds.map((id)=>({id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]}))]});
      const placeholder=await channel.send('正在创建订单面板…');
      const actor=actorFromInteraction(interaction)!;
      const api=createBotApiClient();
      const result=await handleCreateOrderFromPublicEntry({api,actor,provisionalChannel:{channelId:channel.id,panelMessageId:placeholder.id,voiceChannelId:null},idempotencyKey:buildDiscordIdempotencyKey('order:create',interaction.id)});
      if(result.kind==='CREATE_PRIVATE_CHANNEL'){
        const [catalog,requirements]=await Promise.all([api.listServices(actor),api.listOrderRequirements(result.order.id,actor,undefined,10)]);
        const reply=toDiscordReply(buildMultiProjectOrderPanelMessage(result.order,requirements,catalog.items));await placeholder.edit({content:null,embeds:reply.embeds,components:reply.components});await channel.setName(`order-${result.order.publicId}`.toLowerCase().slice(0,90)).catch(()=>undefined);await interaction.editReply(botCopy.entry.channelCreated(String(channel)));return;}
      if(result.kind==='OPEN_EXISTING_CHANNEL'){await channel.delete('Duplicate provisional order channel').catch(()=>undefined);await interaction.editReply(botCopy.entry.existingOrder(result.channelId));return;}
      await channel.delete('Order creation failed').catch(()=>undefined);await interaction.editReply(result.kind==='EPHEMERAL_MESSAGE'||result.kind==='CHANNEL_CREATION_FAILED'?result.message:'暂时无法创建订单。');
    }catch(error){if(channel)await channel.delete('Order creation failed').catch(()=>undefined);const requestId=error instanceof BotApiError?error.requestId:'local-order-channel-failed';await interaction.editReply(botCopy.orders.channelCreationFailed(requestId));}
  }

  private async handleServiceLifecycleButton(
    interaction: ButtonInteraction,
    route: Extract<ServiceCenterRoute, { area: 'service-action' }>
  ): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({ content: '请在服务器内操作订单状态。request_id: local-guild-required', ephemeral: true });
      return;
    }

    const api = createBotApiClient();
    const result = await handleServiceLifecycleAction({
      api,
      actor,
      orderId: route.orderId,
      action: route.action,
      expectedVersion: route.expectedVersion,
      idempotencyKey: buildDiscordIdempotencyKey(`service:${route.action}`, interaction.id)
    });
    if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
      const reply = toDiscordReply(result.message);
      await interaction.update({ content: null, embeds: reply.embeds, components: reply.components });
      return;
    }
    if (result.kind === 'EPHEMERAL_MESSAGE') {
      await interaction.reply({ content: result.message, ephemeral: true });
      return;
    }
    await interaction.reply({ content: '暂时无法处理订单状态。request_id: local-unhandled-result', ephemeral: true });
  }

  private async handleProfile(interaction: ButtonInteraction, route: Extract<ServiceCenterRoute, { area: 'profile' }>): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) { await interaction.reply({ content: '请在服务器内打开个人中心。request_id: local-guild-required', ephemeral: true }); return; }
    try {
      const api = createBotApiClient();
      const message = route.action === 'orders'
        ? buildCurrentUserOrdersMessage(await api.listCurrentUserOrders(actor, route.cursor, 5))
        : route.action === 'consumptions'
          ? buildCurrentUserConsumptionsMessage(await api.listCurrentUserConsumptions(actor, route.cursor, 5))
          : buildCurrentUserProfileMessage(await api.getCurrentUserProfileSummary(actor));
      const reply = toDiscordReply(message);
      await interaction.update({ content: null, embeds: reply.embeds, components: reply.components });
    } catch (error) {
      const requestId = error instanceof BotApiError ? error.requestId : 'local-profile-fallback';
      await interaction.reply({ content: botCopy.common.featureUnavailable('个人中心', requestId), ephemeral: true });
    }
  }

  private async handleReports(interaction: ButtonInteraction, route: Extract<ServiceCenterRoute, { area: 'reports' }>): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) { await interaction.reply({ content: '请在服务器内打开我的周报。request_id: local-guild-required', ephemeral: true }); return; }
    try {
      const api = createBotApiClient();
      const message = route.action === 'detail'
        ? buildCurrentPlayerWeeklyReportDetailMessage(await api.getCurrentPlayerWeeklyReport(route.reportId, actor))
        : buildCurrentPlayerWeeklyReportListMessage(await api.listCurrentPlayerWeeklyReports(actor, route.cursor, 4));
      const reply = toDiscordReply(message);
      await interaction.update({ content: null, embeds: reply.embeds, components: reply.components });
    } catch (error) {
      const requestId = error instanceof BotApiError ? error.requestId : 'local-report-fallback';
      await interaction.reply({ content: botCopy.common.featureUnavailable('我的周报', requestId), ephemeral: true });
    }
  }

  private async handleGift(interaction: ButtonInteraction, route: Extract<ServiceCenterRoute, { area: 'gift' }>): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) { await interaction.reply({ content: '请在服务器内赠送礼物。request_id: local-guild-required', ephemeral: true }); return; }
    try {
      const secret = giftContinuationSecret();
      const api = createBotApiClient();
      if (route.action === 'open') {
        const [order, catalog] = await Promise.all([api.getOrder(route.orderId, actor), api.listGifts(route.orderId, actor)]);
        const reply = toDiscordReply(buildGiftCatalogMessage(catalog, order.version, actor, secret));
        await interaction.reply(reply);
        return;
      }
      const context = readGiftContinuationToken(route.token, actor, secret);
      if (route.action === 'back') {
        const [order, catalog] = await Promise.all([api.getOrder(context.orderId, actor), api.listGifts(context.orderId, actor)]);
        const reply = toDiscordReply(buildGiftCatalogMessage(catalog, order.version, actor, secret));
        await interaction.update({ content: null, embeds: reply.embeds, components: reply.components });
        return;
      }
      const affordability = await api.checkGiftAffordability(context.orderId, context.giftCatalogVersionId, actor);
      const currentToken = createGiftContinuationToken({ orderId: context.orderId, orderVersion: context.orderVersion,
        giftCatalogVersionId: affordability.giftCatalogVersionId, catalogVersion: affordability.catalogVersion,
        priceMinor: affordability.priceMinor }, actor, secret);
      const changed = affordability.catalogVersion !== context.catalogVersion || affordability.priceMinor !== context.priceMinor;
      if (route.action !== 'confirm' || changed || !affordability.canAfford) {
        const reply = toDiscordReply(buildGiftAffordabilityMessage(affordability, currentToken));
        await interaction.update({ content: null, embeds: reply.embeds, components: reply.components });
        return;
      }
      const created = await api.createOrderGiftRequest(context.orderId, { expectedOrderVersion: context.orderVersion,
        giftCatalogVersionId: context.giftCatalogVersionId, expectedCatalogVersion: context.catalogVersion,
        expectedPriceMinor: context.priceMinor }, actor, buildDiscordIdempotencyKey('gift:confirm', interaction.id));
      const reply = toDiscordReply(buildGiftRequestMessage(created));
      await interaction.update({ content: null, embeds: reply.embeds, components: reply.components });
    } catch (error) {
      const requestId = error instanceof BotApiError ? error.requestId : 'local-gift-context';
      await interaction.reply({ content: `礼物状态已变化，请返回礼物列表后重试。request_id: ${requestId}`, ephemeral: true });
    }
  }

  private async openPrivateServiceCenter(interaction: ButtonInteraction): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({ content: '请在服务器内打开服务中心。request_id: local-guild-required', ephemeral: true });
      return;
    }

    const api = createBotApiClient();
    const result = await handleOpenServiceCenterFromPublicEntry({ api, actor });
    if (result.kind === 'SHOW_SERVICE_CENTER') {
      await interaction.reply(toDiscordReply(result.message));
      return;
    }
    if (result.kind === 'SHOW_MODAL') {
      await interaction.showModal(toDiscordModal(result.modal));
      return;
    }
    if (result.kind === 'EPHEMERAL_MESSAGE') {
      await interaction.reply({ content: result.message, ephemeral: true });
      return;
    }
    await interaction.reply({ content: '暂时无法打开服务中心。request_id: local-unhandled-result', ephemeral: true });
  }

  private async openPlayerWorkbench(interaction: ButtonInteraction): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({ content: '请在服务器内打开陪玩工作台。request_id: local-guild-required', ephemeral: true });
      return;
    }
    const result = await handleOpenPlayerWorkbench({ api: createBotApiClient(), actor });
    if (result.kind === 'SHOW_PLAYER_WORKBENCH') {
      await interaction.reply(toDiscordReply(result.message));
      return;
    }
    await interaction.reply({
      content: result.kind === 'EPHEMERAL_MESSAGE' ? result.message : '暂时无法打开陪玩工作台。request_id: local-unhandled-result',
      ephemeral: true
    });
  }

  private async setPlayerAvailable(interaction: ButtonInteraction, expectedVersion: number): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({ content: '请在服务器内修改可接单状态。request_id: local-guild-required', ephemeral: true });
      return;
    }
    const api = createBotApiClient();
    try {
      await api.setPlayerAvailability(
        { expectedVersion, availability: 'AVAILABLE' },
        actor,
        buildDiscordIdempotencyKey('player:set-available', interaction.id)
      );
      const result = await handleOpenPlayerWorkbench({ api, actor });
      if (result.kind === 'SHOW_PLAYER_WORKBENCH') {
        const reply = toDiscordReply(result.message);
        await interaction.update({ content: null, embeds: reply.embeds, components: reply.components });
        return;
      }
      await interaction.reply({ content: '可接单状态已更新，请刷新工作台。', ephemeral: true });
    } catch {
      await interaction.reply({ content: '更新可接单状态失败，请刷新后重试。request_id: local-player-availability', ephemeral: true });
    }
  }

  private async openOrderConfirmation(
    interaction: ButtonInteraction,
    route: Extract<ServiceCenterRoute, { area: 'order-action' }>
  ): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({ content: '请在服务器内确认订单。request_id: local-guild-required', ephemeral: true });
      return;
    }

    const api = createBotApiClient();
    const result = await handleOpenOrderConfirmation({
      api,
      actor,
      orderId: route.orderId,
      expectedVersion: route.expectedVersion,
      idempotencyKey: buildDiscordIdempotencyKey('order:estimate', interaction.id)
    });
    if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
      const reply = toDiscordReply(result.message);
      await interaction.update({ content: null, embeds: reply.embeds, components: reply.components });
      return;
    }
    if (result.kind === 'EPHEMERAL_MESSAGE') {
      await interaction.reply({ content: result.message, ephemeral: true });
      return;
    }
    await interaction.reply({ content: '暂时无法打开确认面板。request_id: local-unhandled-result', ephemeral: true });
  }

  private async openCancellationPreview(
    interaction: ButtonInteraction,
    route: Extract<ServiceCenterRoute, { area: 'order-action' }>
  ): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({ content: '请在服务器内取消订单。request_id: local-guild-required', ephemeral: true });
      return;
    }
    const result = await handleOpenCancellationPreview({
      api: createBotApiClient(), actor, orderId: route.orderId, expectedVersion: route.expectedVersion,
      idempotencyKey: buildDiscordIdempotencyKey('order:cancel-preview', interaction.id)
    });
    if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
      const reply = toDiscordReply(result.message);
      await interaction.update({ content: null, embeds: reply.embeds, components: reply.components });
      return;
    }
    await interaction.reply({
      content: result.kind === 'EPHEMERAL_MESSAGE' ? result.message : '暂时无法打开取消预览。request_id: local-unhandled-result',
      ephemeral: true
    });
  }

  private async confirmCancellation(
    interaction: ButtonInteraction,
    route: Extract<ServiceCenterRoute, { area: 'cancellation-action' }>
  ): Promise<void> {
    const actor = actorFromInteraction(interaction);
    if (!actor) {
      await interaction.reply({ content: '请在服务器内取消订单。request_id: local-guild-required', ephemeral: true });
      return;
    }
    const result = await handleConfirmCancellation({
      api: createBotApiClient(), actor, orderId: route.orderId, previewId: route.previewId,
      expectedVersion: route.expectedVersion,
      idempotencyKey: buildDiscordIdempotencyKey('order:cancel-confirm', interaction.id)
    });
    await interaction.reply({
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
      await interaction.reply({ content: '请在服务器内提交订单。request_id: local-guild-required', ephemeral: true });
      return;
    }

    const api = createBotApiClient();
    const result = await handleSubmitFinalOrder({
      api,
      actor,
      orderId: route.orderId,
      expectedVersion: route.expectedVersion,
      idempotencyKey: buildDiscordIdempotencyKey('order:submit-final', interaction.id)
    });
    if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
      const reply = toDiscordReply(result.message);
      await interaction.update({ content: null, embeds: reply.embeds, components: reply.components });
      return;
    }
    if (result.kind === 'EPHEMERAL_MESSAGE') {
      await interaction.reply({ content: result.message, ephemeral: true });
      return;
    }
    await interaction.reply({ content: '暂时无法提交订单。request_id: local-unhandled-result', ephemeral: true });
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

function actorFromInteraction(interaction: ButtonInteraction): BotActorContext | null {
  if (!interaction.guildId) {
    return null;
  }
  return {
    guildId: interaction.guildId,
    discordUserId: interaction.user.id,
    interactionId: interaction.id,
    clientSource: 'DISCORD_BOT'
  };
}
