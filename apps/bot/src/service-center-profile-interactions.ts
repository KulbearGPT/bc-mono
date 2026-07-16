import { botCopy } from './bot-copy.js';
import { toDiscordUpdate } from './discord-renderer.js';
import { BotApiError, type BotActorContext, type BotApiClient } from './service-center-api.js';
import {
  buildCurrentPlayerWeeklyReportDetailMessage,
  buildCurrentPlayerWeeklyReportListMessage,
  buildCurrentUserConsumptionsMessage,
  buildCurrentUserOrdersMessage,
  buildCurrentUserProfileMessage
} from './service-center-profile.js';
import type { ServiceCenterRoute } from './service-center-routes.js';

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
    const requestId = error instanceof BotApiError ? error.requestId : 'local-profile-fallback';
    await input.interaction.followUp({
      content: botCopy.common.featureUnavailable('个人中心', requestId),
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
    const requestId = error instanceof BotApiError ? error.requestId : 'local-report-fallback';
    await input.interaction.followUp({
      content: botCopy.common.featureUnavailable('我的周报', requestId),
      ephemeral: true
    });
  }
}
