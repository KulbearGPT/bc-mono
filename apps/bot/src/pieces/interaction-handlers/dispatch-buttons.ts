import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { botCopy } from '../../bot-copy.js';
import type { ButtonInteraction } from 'discord.js';
import { validateRuntimeEnv } from '@blackcat/platform/env';
import { BotApiError, HttpBotApiClient, buildDiscordIdempotencyKey, buildDispatchIneligibleReply } from '../../service-center.js';

export class DispatchButtonsHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext, options: InteractionHandler.Options) {
    super(context, {
      ...options,
      interactionHandlerType: InteractionHandlerTypes.Button
    });
  }

  public override parse(interaction: ButtonInteraction) {
    const match = /^bc:dispatch:([^:]+):(accept|decline):([^:]+):v(\d+)$/u.exec(interaction.customId);
    if (!match) {
      return this.none();
    }
    return this.some({
      dispatchAttemptId: match[1],
      action: match[2] as 'accept' | 'decline',
      orderId: match[3],
      expectedVersion: Number(match[4])
    });
  }

  public async run(
    interaction: ButtonInteraction,
    parsed: { dispatchAttemptId: string; action: 'accept' | 'decline'; orderId: string; expectedVersion: number }
  ) {
    await interaction.deferReply({ ephemeral: true });
    const env = validateRuntimeEnv(process.env, { allowMissingDiscordToken: true });
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
      if (parsed.action === 'accept') {
        const accepted = await api.acceptOrder(
          parsed.orderId,
          { expectedVersion: parsed.expectedVersion, dispatchAttemptId: parsed.dispatchAttemptId },
          actor,
          buildDiscordIdempotencyKey('dispatch:accept', interaction.id)
        );
        await interaction.editReply({ content: botCopy.dispatch.accepted(accepted.channelSpec.channelId) });
        return;
      }

      await api.declineOrderOffer(
        parsed.orderId,
        { expectedVersion: parsed.expectedVersion },
        actor,
        buildDiscordIdempotencyKey('dispatch:decline', interaction.id)
      );
      await interaction.editReply({ content: botCopy.dispatch.declined });
    } catch (error) {
      if (
        parsed.action === 'accept'
        && error instanceof BotApiError
        && (error.code === 'CONFLICT' || error.code === 'PLAYER_NOT_ELIGIBLE')
      ) {
        try {
          const currentOrder = await api.getOrder(parsed.orderId, actor);
          await interaction.editReply({
            content: botCopy.dispatch.alreadyAccepted(currentOrder.channelSpec.channelId)
          });
          return;
        } catch {
          if (error.code === 'CONFLICT') {
            await interaction.editReply({ content: botCopy.dispatch.alreadyTaken });
            return;
          }
        }
      }
      if (parsed.action === 'accept' && error instanceof BotApiError && error.code === 'PLAYER_NOT_ELIGIBLE') {
        try {
          const workbench = await api.getPlayerWorkbench(actor);
          await interaction.editReply({ content: buildDispatchIneligibleReply(workbench, error.requestId) });
          return;
        } catch {
          await interaction.editReply({ content: botCopy.dispatch.ineligible([], error.requestId) });
          return;
        }
      }
      interaction.client.logger.error({
        event: 'dispatch.button_failed',
        guildId: interaction.guildId,
        discordUserId: interaction.user.id,
        orderId: parsed.orderId,
        dispatchAttemptId: parsed.dispatchAttemptId,
        action: parsed.action,
        error
      });
      const requestId = error instanceof BotApiError ? error.requestId : 'local-dispatch-button-failed';
      const message = botCopy.dispatch.failed;
      await interaction.editReply({
        content: `${message} request_id: ${requestId}`
      });
    }
  }
}
