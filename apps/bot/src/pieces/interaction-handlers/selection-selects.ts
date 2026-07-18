import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { StringSelectMenuInteraction } from 'discord.js';
import { validateRuntimeEnv } from '@blackcat/platform/env';
import { buildBotActorContext } from '../../actor-context.js';
import { toDiscordUpdate } from '../../discord-renderer.js';
import {
  HttpBotApiClient,
  buildDiscordIdempotencyKey,
  type BotActorContext,
  type BotApiClient
} from '../../service-center.js';
import {
  buildSelectionPoolRefreshMessage,
  decodeSelectionId,
  parseSelectionCustomId,
  withdrawCustomId
} from '../../selection-discord.js';
import { formatUserFacingError } from '../../user-facing-error.js';

export default class SelectionSelectsHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext, options: InteractionHandler.Options) {
    super(context, {
      ...options,
      interactionHandlerType: InteractionHandlerTypes.SelectMenu
    });
  }
  public override parse(interaction: StringSelectMenuInteraction) {
    const initial = /^bc:sp:new:([0-9a-f-]{36}):o(\d+)(?::[ab])?$/u.exec(interaction.customId);
    if (initial)
      return this.some({
        action: 'repeat' as const,
        orderId: initial[1]!,
        poolId: null,
        expectedOrderVersion: Number(initial[2])
      });
    const repeat = /^bc:sp:r:([^:]+):([^:]+):o(\d+)(?::[ab])?$/u.exec(interaction.customId);
    if (repeat)
      return this.some({
        action: 'repeat' as const,
        orderId: decodeSelectionId(repeat[1]!),
        poolId: decodeSelectionId(repeat[2]!),
        expectedOrderVersion: Number(repeat[3])
      });
    const route = parseSelectionCustomId(interaction.customId.replace(':s:', ':f:'));
    return route.action === 'finalize' || route.action === 'apply-menu' ? this.some(route) : this.none();
  }
  public async run(
    interaction: StringSelectMenuInteraction,
    route:
      | Extract<ReturnType<typeof parseSelectionCustomId>, { action: 'finalize' | 'apply-menu' }>
      | {
          action: 'repeat';
          orderId: string;
          poolId: string | null;
          expectedOrderVersion: number;
        }
  ) {
    const updatesOrderPanel = route.action === 'repeat';
    if (updatesOrderPanel) await interaction.deferUpdate();
    else await interaction.deferReply({ ephemeral: true });
    const env = validateRuntimeEnv(process.env, {
      allowMissingDiscordToken: true
    });
    if (!env.ok) {
      if (updatesOrderPanel) await interaction.followUp({ content: '配置暂不可用，请联系管理员。', ephemeral: true });
      else await interaction.editReply({ content: '配置暂不可用，请联系管理员。' });
      return;
    }
    const api = new HttpBotApiClient({
      apiBaseUrl: env.values.apiBaseUrl,
      botServiceToken: env.values.botServiceToken
    });
    const actor = buildBotActorContext(interaction);
    if (!actor) {
      const content = '请在服务器内进行候选池操作。request_id: local-guild-required';
      if (updatesOrderPanel) await interaction.followUp({ content, ephemeral: true });
      else await interaction.editReply({ content });
      return;
    }
    if (route.action === 'repeat') {
      await executeSelectionWaitSelection({ interaction, api, actor, route });
      return;
    }
    try {
      if (route.action === 'apply-menu') {
        const result = await api.applyToSelectionPool(
          route.orderId,
          route.poolId,
          {
            expectedPoolVersion: route.expectedPoolVersion,
            orderRequirementId: decodeSelectionId(interaction.values[0]!)
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
      const result = await api.finalizeSelectionPool(
        route.orderId,
        route.poolId,
        {
          expectedOrderVersion: route.expectedOrderVersion,
          expectedPoolVersion: route.expectedPoolVersion,
          applicationIds: interaction.values.map(decodeSelectionId)
        },
        actor,
        buildDiscordIdempotencyKey('selection:finalize', interaction.id)
      );
      await interaction.editReply({
        content: `已确认入选：${result.selectedDisplayNames.join('、')}。${result.remainingSlotCount ? `还缺 ${result.remainingSlotCount} 位，可继续开启下一轮。` : '订单人员已选齐。'}`
      });
    } catch (error) {
      interaction.client.logger.error({
        event: 'selection.finalize_failed',
        route,
        error
      });
      await interaction.editReply({
        content: formatUserFacingError(error, {
          operation: selectionOperation(route.action),
          localRequestId: `discord-interaction-${interaction.id}`
        })
      });
    }
  }
}

export interface SelectionWaitRoute {
  action: 'repeat';
  orderId: string;
  poolId: string | null;
  expectedOrderVersion: number;
}

export async function executeSelectionWaitSelection(input: {
  interaction: StringSelectMenuInteraction;
  api: BotApiClient;
  actor: BotActorContext;
  route: SelectionWaitRoute;
}): Promise<void> {
  const waitMinutes = Number(input.interaction.values[0]);
  let order;
  try {
    order = await input.api.getOrder(input.route.orderId, input.actor);
    const result = await input.api.createSelectionPool(
      input.route.orderId,
      { expectedOrderVersion: input.route.expectedOrderVersion, waitMinutes },
      input.actor,
      buildDiscordIdempotencyKey(input.route.poolId ? 'selection:repeat' : 'selection:create', input.interaction.id)
    );
    await input.interaction.editReply(toDiscordUpdate(buildSelectionPoolRefreshMessage(order, result.pool)));
    return;
  } catch (error) {
    if (isConflict(error) && order && input.api.getCurrentSelectionPool) {
      try {
        const current = await input.api.getCurrentSelectionPool(input.route.orderId, input.actor);
        await input.interaction.editReply(toDiscordUpdate(buildSelectionPoolRefreshMessage(order, current.pool)));
        await input.interaction.followUp({
          content: `本轮已经按 ${current.pool.waitMinutes} 分钟开始，活动报名期间不能直接修改时长。你可以提前结束本轮报名。`,
          ephemeral: true
        });
        return;
      } catch {
        // Fall through to the original API error when current-state recovery also fails.
      }
    }
    input.interaction.client.logger.error({
      event: 'selection.wait_failed',
      route: input.route,
      error
    });
    await input.interaction.followUp({
      content: formatUserFacingError(error, {
        operation: selectionOperation(input.route.action),
        localRequestId: `discord-interaction-${input.interaction.id}`
      }),
      ephemeral: true
    });
  }
}

function isConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'CONFLICT';
}

function selectionOperation(action: 'repeat' | 'finalize' | 'apply-menu'): string {
  if (action === 'repeat') return '继续等待并开启新一轮报名';
  if (action === 'finalize') return '确认候选名单';
  return '打开报名项目菜单';
}
