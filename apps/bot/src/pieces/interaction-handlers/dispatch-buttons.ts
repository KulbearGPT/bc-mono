import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ButtonInteraction } from 'discord.js';
import { validateRuntimeEnv } from '@blackcat/platform/env';
import { buildBotActorContext } from '../../actor-context.js';
import { HttpBotApiClient, buildDiscordIdempotencyKey } from '../../service-center.js';
import {
  buildSelectionCandidatePanel,
  parseSelectionCustomId,
  selectionFinalizeRouteFromConfirmationComponents,
  selectionIdsFromConfirmationComponents,
  withdrawCustomId
} from '../../selection-discord.js';
import { toDiscordUpdate } from '../../discord-renderer.js';
import { formatUserFacingError } from '../../user-facing-error.js';
import { executeSelectionReselect, executeSelectionStart } from './selection-selects.js';

export class DispatchButtonsHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext, options: InteractionHandler.Options) {
    super(context, {
      ...options,
      interactionHandlerType: InteractionHandlerTypes.Button
    });
  }
  public override parse(interaction: ButtonInteraction) {
    const route = parseSelectionCustomId(interaction.customId);
    return route.action === 'unknown' || route.action === 'apply-menu' ? this.none() : this.some(route);
  }
  public async run(
    interaction: ButtonInteraction,
    route: Exclude<ReturnType<typeof parseSelectionCustomId>, { action: 'unknown' }>
  ) {
    const updatesConfirmation = route.action === 'finalize' || route.action === 'reselect' || route.action === 'start';
    if (updatesConfirmation) await interaction.deferUpdate();
    else await interaction.deferReply({ ephemeral: true });
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
    const actor = buildBotActorContext(interaction);
    if (!actor) {
      await interaction.editReply({ content: '请在服务器内进行报名与试音匹配操作。request_id: local-guild-required' });
      return;
    }
    try {
      if (route.action === 'start') {
        await executeSelectionStart({ interaction, api, actor, route });
        return;
      }
      if (route.action === 'reselect') {
        const confirmationRoute =
          route.expectedPoolVersion === null || route.expectedOrderVersion === null
            ? selectionFinalizeRouteFromConfirmationComponents(interaction.message.components)
            : null;
        const expectedPoolVersion = route.expectedPoolVersion ?? confirmationRoute?.expectedPoolVersion;
        const expectedOrderVersion = route.expectedOrderVersion ?? confirmationRoute?.expectedOrderVersion;
        if (
          expectedPoolVersion === undefined ||
          expectedOrderVersion === undefined ||
          (confirmationRoute &&
            (confirmationRoute.orderId !== route.orderId || confirmationRoute.poolId !== route.poolId))
        ) {
          await interaction.editReply({
            content: '确认信息已经失效，请刷新报名名单后再试。',
            embeds: [],
            components: []
          });
          return;
        }
        await executeSelectionReselect({
          interaction,
          api,
          actor,
          route: { ...route, expectedPoolVersion, expectedOrderVersion }
        });
        return;
      }
      if (route.action === 'finalize') {
        const applicationIds = selectionIdsFromConfirmationComponents(interaction.message.components);
        if (!applicationIds.length) {
          await interaction.editReply({
            content: '确认信息已经失效，请返回报名名单重新选择。',
            embeds: [],
            components: []
          });
          return;
        }
        const result = await api.finalizeSelectionPool(
          route.orderId,
          route.poolId,
          {
            expectedOrderVersion: route.expectedOrderVersion,
            expectedPoolVersion: route.expectedPoolVersion,
            applicationIds
          },
          actor,
          buildDiscordIdempotencyKey('selection:finalize', interaction.id)
        );
        await interaction.editReply({
          content: `已确认入选：${result.selectedDisplayNames.join('、')}。${result.remainingSlotCount ? `还缺 ${result.remainingSlotCount} 位，可继续开启下一轮。` : '订单人员已选齐。'}`,
          embeds: [],
          components: []
        });
        return;
      }
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
            expectedPoolVersion: route.expectedPoolVersion
          },
          actor,
          buildDiscordIdempotencyKey('selection:close', interaction.id)
        );
        await interaction.editReply({
          content: '招募已终止，正在准备试音房与报名名单。'
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
      await interaction.editReply({
        content: formatUserFacingError(error, {
          operation: dispatchOperation(route.action),
          localRequestId: `discord-interaction-${interaction.id}`
        }),
        components: updatesConfirmation ? [] : undefined
      });
    }
  }
}

function dispatchOperation(
  action: 'start' | 'apply' | 'apply-menu' | 'withdraw' | 'close' | 'finalize' | 'reselect' | 'page'
): string {
  if (action === 'start') return '开始新一轮招募';
  if (action === 'apply') return '报名陪玩项目';
  if (action === 'withdraw') return '取消陪玩报名';
  if (action === 'close') return '终止本轮招募';
  if (action === 'finalize') return '确认试音匹配结果';
  if (action === 'reselect') return '返回报名名单';
  if (action === 'apply-menu') return '打开报名项目菜单';
  return '查看报名名单下一页';
}
