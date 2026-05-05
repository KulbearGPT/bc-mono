import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ButtonInteraction } from 'discord.js';
import { validateRuntimeEnv } from '@blackcat/platform/env';
import { HttpBotApiClient, buildDiscordIdempotencyKey } from '../../service-center.js';

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
    const env = validateRuntimeEnv(process.env, { allowMissingDiscordToken: true });
    if (!env.ok) {
      await interaction.reply({ content: '配置暂不可用，请联系管理员。', ephemeral: true });
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

    if (parsed.action === 'accept') {
      await api.acceptOrder(
        parsed.orderId,
        { expectedVersion: parsed.expectedVersion, dispatchAttemptId: parsed.dispatchAttemptId },
        actor,
        buildDiscordIdempotencyKey('dispatch:accept', interaction.id)
      );
      await interaction.reply({ content: '已提交接单请求。', ephemeral: true });
      return;
    }

    await api.declineOrderOffer(
      parsed.orderId,
      { expectedVersion: parsed.expectedVersion },
      actor,
      buildDiscordIdempotencyKey('dispatch:decline', interaction.id)
    );
    await interaction.reply({ content: '已记录本轮暂不接单。', ephemeral: true });
  }
}
