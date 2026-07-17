import type { ButtonInteraction } from 'discord.js';
import { toDiscordModal, toDiscordReply } from './discord-renderer.js';
import { buildDiscordIdempotencyKey, type BotActorContext, type BotApiClient } from './service-center-api.js';
import type { ServiceCenterRoute } from './service-center-routes.js';
import { formatUnexpectedBotResult } from './user-facing-error.js';
import { handleSupportRatingAction } from './service-center.js';

export async function executeSupportRatingButton(input: {
  interaction: ButtonInteraction;
  route: Extract<ServiceCenterRoute, { area: 'support-rating' }>;
  actor: BotActorContext;
  api: BotApiClient;
}): Promise<void> {
  const requiresApi =
    input.route.score !== null &&
    (input.route.score > 2 || input.route.reason !== null) &&
    input.route.reason !== 'OTHER';
  if (requiresApi) await input.interaction.deferUpdate();
  const result = await handleSupportRatingAction({
    api: input.api,
    actor: input.actor,
    orderId: input.route.orderId,
    score: input.route.score,
    reason: input.route.reason,
    idempotencyKey: buildDiscordIdempotencyKey('support:rating', input.interaction.id)
  });
  if (result.kind === 'SHOW_MODAL') {
    await input.interaction.showModal(toDiscordModal(result.modal));
    return;
  }
  if (result.kind === 'SHOW_SUPPORT_RATING') {
    await input.interaction.reply(toDiscordReply(result.message));
    return;
  }
  const message =
    result.kind === 'EPHEMERAL_MESSAGE'
      ? result.message
      : formatUnexpectedBotResult('提交客服评价', `discord-interaction-${input.interaction.id}`);
  if (requiresApi) await input.interaction.followUp({ content: message, ephemeral: true });
  else await input.interaction.reply({ content: message, ephemeral: true });
}
