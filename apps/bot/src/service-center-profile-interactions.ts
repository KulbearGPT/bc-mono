import { toDiscordUpdate } from './discord-renderer.js';
import type { BotActorContext, BotApiClient } from './service-center-api.js';
import {
  buildCurrentPlayerWeeklyReportDetailMessage,
  buildCurrentPlayerWeeklyReportListMessage,
  buildCurrentUserConsumptionsMessage,
  buildCurrentUserOrdersMessage,
  buildCurrentUserProfileMessage
} from './service-center-profile.js';
import type { ServiceCenterRoute } from './service-center-routes.js';
import { formatUserFacingError } from './user-facing-error.js';

export interface DeferredButtonInteraction {
  deferUpdate(): Promise<unknown>;
  editReply(options: unknown): Promise<unknown>;
  followUp(options: { content: string; ephemeral: true }): Promise<unknown>;
}

export async function executeProfileButton(input: {
  interaction: DeferredButtonInteraction;
  route: Extract<ServiceCenterRoute, { area: 'profile' }>;
  actor: BotActorContext;
  api: BotApiClient;
}): Promise<void> {
  await input.interaction.deferUpdate();
  try {
    const message =
      input.route.action === 'orders'
        ? buildCurrentUserOrdersMessage(await input.api.listCurrentUserOrders(input.actor, input.route.cursor, 5))
        : input.route.action === 'consumptions'
          ? buildCurrentUserConsumptionsMessage(
              await input.api.listCurrentUserConsumptions(input.actor, input.route.cursor, 5)
            )
          : buildCurrentUserProfileMessage(await input.api.getCurrentUserProfileSummary(input.actor));
    await input.interaction.editReply(toDiscordUpdate(message));
  } catch (error) {
    await input.interaction.followUp({
      content: formatUserFacingError(error, {
        operation: '打开个人中心',
        localRequestId: 'local-profile-fallback'
      }),
      ephemeral: true
    });
  }
}

export async function executeReportsButton(input: {
  interaction: DeferredButtonInteraction;
  route: Extract<ServiceCenterRoute, { area: 'reports' }>;
  actor: BotActorContext;
  api: BotApiClient;
}): Promise<void> {
  await input.interaction.deferUpdate();
  try {
    const message =
      input.route.action === 'detail'
        ? buildCurrentPlayerWeeklyReportDetailMessage(
            await input.api.getCurrentPlayerWeeklyReport(input.route.reportId, input.actor)
          )
        : buildCurrentPlayerWeeklyReportListMessage(
            await input.api.listCurrentPlayerWeeklyReports(input.actor, input.route.cursor, 4)
          );
    await input.interaction.editReply(toDiscordUpdate(message));
  } catch (error) {
    await input.interaction.followUp({
      content: formatUserFacingError(error, {
        operation: '打开我的周报',
        localRequestId: 'local-report-fallback'
      }),
      ephemeral: true
    });
  }
}
