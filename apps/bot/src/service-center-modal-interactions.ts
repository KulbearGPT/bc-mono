import { toDiscordUpdate } from './discord-renderer.js';
import { buildDiscordIdempotencyKey, handleOrderNotesSubmit, handleRequirementNoteSubmit } from './service-center.js';
import type { BotActorContext, BotApiClient } from './service-center-api.js';
import type { ServiceCenterRoute } from './service-center-routes.js';
import { formatUnexpectedBotResult, formatUserFacingError } from './user-facing-error.js';

type SupportedModalRoute = Extract<
  ServiceCenterRoute,
  {
    area: 'support-rating-comment' | 'order-notes-modal' | 'order-menu-notes-modal' | 'requirement-note-modal';
  }
>;

export interface ServiceCenterModalInteraction {
  id: string;
  deferReply(options: { ephemeral: true }): Promise<unknown>;
  deferUpdate(): Promise<unknown>;
  editReply(options: unknown): Promise<unknown>;
  followUp(options: { content: string; ephemeral: true }): Promise<unknown>;
  fields: { getTextInputValue(customId: string): string };
}

export async function executeServiceCenterModalSubmit(input: {
  interaction: ServiceCenterModalInteraction;
  route: SupportedModalRoute;
  actor: BotActorContext;
  api: BotApiClient;
}): Promise<void> {
  if (input.route.area === 'support-rating-comment') {
    await input.interaction.deferReply({ ephemeral: true });
    try {
      await input.api.submitSupportRating(
        input.route.orderId,
        {
          score: input.route.score,
          reason: 'OTHER',
          comment: input.interaction.fields.getTextInputValue('comment')
        },
        input.actor,
        buildDiscordIdempotencyKey('support:rating:other', input.interaction.id)
      );
      await input.interaction.editReply('感谢评价，已记录。');
    } catch (error) {
      await input.interaction.editReply(
        formatUserFacingError(error, {
          operation: '提交客服评价',
          localRequestId: `discord-interaction-${input.interaction.id}`
        })
      );
    }
    return;
  }

  await input.interaction.deferUpdate();
  const operation = input.route.area === 'requirement-note-modal' ? '保存服务项目备注' : '保存订单备注';
  try {
    const result =
      input.route.area === 'requirement-note-modal'
        ? await handleRequirementNoteSubmit({
            api: input.api,
            actor: input.actor,
            orderId: input.route.orderId,
            requirementId: input.route.requirementId,
            expectedVersion: input.route.expectedVersion,
            expectedRequirementVersion: input.route.expectedRequirementVersion,
            customerNote: input.interaction.fields.getTextInputValue('requirement-note'),
            idempotencyKey: buildDiscordIdempotencyKey('requirement:note', input.interaction.id)
          })
        : await handleOrderNotesSubmit({
            api: input.api,
            actor: input.actor,
            orderId: input.route.orderId,
            expectedVersion: input.route.expectedVersion,
            notes: input.interaction.fields.getTextInputValue('notes'),
            returnGame: input.route.area === 'order-menu-notes-modal' ? input.route.game : undefined,
            idempotencyKey: buildDiscordIdempotencyKey('order:notes', input.interaction.id)
          });
    if (result.kind === 'EDIT_ORIGINAL_MESSAGE') {
      await input.interaction.editReply(toDiscordUpdate(result.message));
      if (result.notice) {
        await input.interaction.followUp({ content: result.notice, ephemeral: true });
      }
      return;
    }
    await input.interaction.followUp({
      content:
        result.kind === 'EPHEMERAL_MESSAGE'
          ? result.message
          : formatUnexpectedBotResult(operation, `discord-interaction-${input.interaction.id}`),
      ephemeral: true
    });
  } catch (error) {
    await input.interaction.followUp({
      content: formatUserFacingError(error, {
        operation,
        localRequestId: `discord-interaction-${input.interaction.id}`
      }),
      ephemeral: true
    });
  }
}
