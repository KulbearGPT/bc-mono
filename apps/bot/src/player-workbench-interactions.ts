import { toDiscordUpdate } from './discord-renderer.js';
import { handleOpenPlayerWorkbench } from './service-center.js';
import type { BotActorContext, BotApiClient } from './service-center-api.js';
import { formatUnexpectedBotResult, formatUserFacingError } from './user-facing-error.js';

export interface DeferredReplyInteraction {
  id: string;
  deferReply(options: { ephemeral: true }): Promise<unknown>;
  editReply(options: unknown): Promise<unknown>;
}

export async function executePlayerWorkbenchInteraction(input: {
  interaction: DeferredReplyInteraction;
  actor: BotActorContext;
  api: BotApiClient;
}): Promise<void> {
  await input.interaction.deferReply({ ephemeral: true });
  try {
    const result = await handleOpenPlayerWorkbench({ api: input.api, actor: input.actor });
    if (result.kind === 'SHOW_PLAYER_WORKBENCH') {
      await input.interaction.editReply(toDiscordUpdate(result.message));
      return;
    }
    await input.interaction.editReply(
      result.kind === 'EPHEMERAL_MESSAGE'
        ? result.message
        : formatUnexpectedBotResult('打开陪玩工作台', `discord-interaction-${input.interaction.id}`)
    );
  } catch (error) {
    await input.interaction.editReply(
      formatUserFacingError(error, {
        operation: '打开陪玩工作台',
        localRequestId: `discord-interaction-${input.interaction.id}`
      })
    );
  }
}
