import {
  InteractionHandler,
  InteractionHandlerTypes,
} from "@sapphire/framework";
import type { StringSelectMenuInteraction } from "discord.js";
import { validateRuntimeEnv } from "@blackcat/platform/env";
import {
  BotApiError,
  HttpBotApiClient,
  buildDiscordIdempotencyKey,
} from "../../service-center.js";
import {
  closeCustomId,
  decodeSelectionId,
  parseSelectionCustomId,
  withdrawCustomId,
} from "../../selection-discord.js";

export default class SelectionSelectsHandler extends InteractionHandler {
  public constructor(
    context: InteractionHandler.LoaderContext,
    options: InteractionHandler.Options,
  ) {
    super(context, {
      ...options,
      interactionHandlerType: InteractionHandlerTypes.SelectMenu,
    });
  }
  public override parse(interaction: StringSelectMenuInteraction) {
    const initial = /^bc:sp:new:([0-9a-f-]{36}):o(\d+)(?::[ab])?$/u.exec(
      interaction.customId,
    );
    if (initial)
      return this.some({
        action: "repeat" as const,
        orderId: initial[1]!,
        poolId: null,
        expectedOrderVersion: Number(initial[2]),
      });
    const repeat = /^bc:sp:r:([^:]+):([^:]+):o(\d+)(?::[ab])?$/u.exec(
      interaction.customId,
    );
    if (repeat)
      return this.some({
        action: "repeat" as const,
        orderId: decodeSelectionId(repeat[1]!),
        poolId: decodeSelectionId(repeat[2]!),
        expectedOrderVersion: Number(repeat[3]),
      });
    const route = parseSelectionCustomId(
      interaction.customId.replace(":s:", ":f:"),
    );
    return route.action === "finalize" || route.action === "apply-menu"
      ? this.some(route)
      : this.none();
  }
  public async run(
    interaction: StringSelectMenuInteraction,
    route:
      | Extract<
          ReturnType<typeof parseSelectionCustomId>,
          { action: "finalize" | "apply-menu" }
        >
      | {
          action: "repeat";
          orderId: string;
          poolId: string | null;
          expectedOrderVersion: number;
        },
  ) {
    await interaction.deferReply({ ephemeral: true });
    const env = validateRuntimeEnv(process.env, {
      allowMissingDiscordToken: true,
    });
    if (!env.ok) {
      await interaction.editReply({ content: "配置暂不可用，请联系管理员。" });
      return;
    }
    const api = new HttpBotApiClient({
      apiBaseUrl: env.values.apiBaseUrl,
      botServiceToken: env.values.botServiceToken,
    });
    const actor = {
      guildId: interaction.guildId ?? "",
      discordUserId: interaction.user.id,
      interactionId: interaction.id,
      clientSource: "DISCORD_BOT" as const,
    };
    try {
      if (route.action === "repeat") {
        const waitMinutes = Number(interaction.values[0]);
        const result = await api.createSelectionPool(
          route.orderId,
          { expectedOrderVersion: route.expectedOrderVersion, waitMinutes },
          actor,
          buildDiscordIdempotencyKey(
            route.poolId ? "selection:repeat" : "selection:create",
            interaction.id,
          ),
        );
        await interaction.editReply({
          content: `已开启新一轮 ${waitMinutes} 分钟报名，原预留保持不变。`,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 2,
                  label: "提前结束报名",
                  custom_id: closeCustomId({
                    orderId: route.orderId,
                    poolId: result.pool.id,
                    poolVersion: result.pool.version,
                  }),
                },
              ],
            },
          ],
        });
        return;
      }
      if (route.action === "apply-menu") {
        const result = await api.applyToSelectionPool(
          route.orderId,
          route.poolId,
          {
            expectedPoolVersion: route.expectedPoolVersion,
            orderRequirementId: decodeSelectionId(interaction.values[0]!),
          },
          actor,
          buildDiscordIdempotencyKey("selection:apply", interaction.id),
        );
        await interaction.editReply({
          content: "报名成功。你可以在截止前撤回。",
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 2,
                  label: "撤回报名",
                  custom_id: withdrawCustomId({
                    orderId: route.orderId,
                    poolId: route.poolId,
                    applicationId: result.application.id,
                    poolVersion: result.pool.version,
                    applicationVersion: result.application.version,
                  }),
                },
              ],
            },
          ],
        });
        return;
      }
      const result = await api.finalizeSelectionPool(
        route.orderId,
        route.poolId,
        {
          expectedOrderVersion: route.expectedOrderVersion,
          expectedPoolVersion: route.expectedPoolVersion,
          applicationIds: interaction.values.map(decodeSelectionId),
        },
        actor,
        buildDiscordIdempotencyKey("selection:finalize", interaction.id),
      );
      await interaction.editReply({
        content: `已确认入选：${result.selectedDisplayNames.join("、")}。${result.remainingSlotCount ? `还缺 ${result.remainingSlotCount} 位，可继续开启下一轮。` : "订单人员已选齐。"}`,
      });
    } catch (error) {
      interaction.client.logger.error({
        event: "selection.finalize_failed",
        route,
        error,
      });
      const requestId =
        error instanceof BotApiError
          ? error.requestId
          : "local-selection-finalize-failed";
      await interaction.editReply({
        content: `操作失败，本次未写入任何部分结果，请刷新后重试。request_id: ${requestId}`,
      });
    }
  }
}
