import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ButtonInteraction } from 'discord.js';
import { validateRuntimeEnv } from '@blackcat/platform/env';
import { BotApiError, HttpBotApiClient, buildDiscordIdempotencyKey } from '../../service-center.js';
import { buildSelectionCandidatePanel, parseSelectionCustomId, withdrawCustomId } from '../../selection-discord.js';
import { toDiscordUpdate } from '../../discord-renderer.js';

export class DispatchButtonsHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext, options: InteractionHandler.Options) {
    super(context, {
      ...options,
      interactionHandlerType: InteractionHandlerTypes.Button
    });
  }
  public override parse(interaction: ButtonInteraction) {
    const route = parseSelectionCustomId(interaction.customId);
    return route.action === 'unknown' || route.action === 'finalize' || route.action === 'apply-menu'
      ? this.none()
      : this.some(route);
  }
  public async run(
    interaction: ButtonInteraction,
    route: Exclude<ReturnType<typeof parseSelectionCustomId>, { action: 'unknown' }>
  ) {
    await interaction.deferReply({ ephemeral: true });
    const env = validateRuntimeEnv(process.env, {
      allowMissingDiscordToken: true
    });
    if (!env.ok) {
      await interaction.editReply({ content: '配置暂不可用，请联系管理员。' });
      return;
    }
    const api = new HttpBotApiClient({
      apiBaseUrl: env.values.apiBaseUrl,
      botServiceToken: env.values.botServiceToken
    });
    const actor = {
      guildId: interaction.guildId ?? '',
      discordUserId: interaction.user.id,
      interactionId: interaction.id,
      clientSource: 'DISCORD_BOT' as const
    };
    try {
      if (route.action === 'apply') {
        const result = await api.applyToSelectionPool(
          route.orderId,
          route.poolId,
          {
            expectedPoolVersion: route.expectedPoolVersion,
            orderRequirementId: route.requirementId
          },
          actor,
          buildDiscordIdempotencyKey('selection:apply', interaction.id)
        );
        await interaction.editReply({
          content: '报名成功。你可以在截止前撤回。',
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 2,
                  label: '撤回报名',
                  custom_id: withdrawCustomId({
                    orderId: route.orderId,
                    poolId: route.poolId,
                    applicationId: result.application.id,
                    poolVersion: result.pool.version,
                    applicationVersion: result.application.version
                  })
                }
              ]
            }
          ]
        });
        return;
      }
      if (route.action === 'withdraw') {
        await api.withdrawSelectionApplication(
          route.orderId,
          route.poolId,
          route.applicationId,
          {
            expectedPoolVersion: route.expectedPoolVersion,
            expectedApplicationVersion: route.expectedApplicationVersion
          },
          actor,
          buildDiscordIdempotencyKey('selection:withdraw', interaction.id)
        );
        await interaction.editReply({ content: '已撤回本轮报名。' });
        return;
      }
      if (route.action === 'close') {
        await api.closeSelectionPool(
          route.orderId,
          route.poolId,
          {
            expectedPoolVersion: route.expectedPoolVersion,
            reason: 'CUSTOMER_EARLY_CLOSE'
          },
          actor,
          buildDiscordIdempotencyKey('selection:close', interaction.id)
        );
        await interaction.editReply({
          content: '报名已提前结束，正在准备选秀语音与候选名单。'
        });
        return;
      }
      if (route.action === 'page') {
        const page = await api.listSelectionApplications(route.orderId, route.poolId, actor, route.cursor);
        await interaction.editReply(
          toDiscordUpdate(
            buildSelectionCandidatePanel({
              orderId: route.orderId,
              poolId: route.poolId,
              poolVersion: page.pool.version,
              orderVersion: route.expectedOrderVersion,
              items: page.items,
              nextCursor: page.nextCursor,
              selectedApplicationIds: []
            })
          )
        );
        return;
      }
    } catch (error) {
      interaction.client.logger.error({
        event: 'selection.button_failed',
        route,
        error
      });
      const requestId = error instanceof BotApiError ? error.requestId : 'local-selection-button-failed';
      await interaction.editReply({
        content: `操作失败，请刷新后重试。request_id: ${requestId}`
      });
    }
  }
}
