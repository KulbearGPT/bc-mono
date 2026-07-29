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

const paginationHistory = new Map<string, string[]>();

export async function executeProfileButton(input: {
  interaction: DeferredButtonInteraction;
  route: Extract<ServiceCenterRoute, { area: 'profile' }>;
  actor: BotActorContext;
  api: BotApiClient;
}): Promise<void> {
  await input.interaction.deferUpdate();
  try {
    const navigation = profileNavigation(input.actor, input.route.action, input.route.cursor);
    const message =
      input.route.action === 'orders'
        ? buildCurrentUserOrdersMessage(
            await input.api.listCurrentUserOrders(input.actor, input.route.cursor, 5),
            navigation
          )
        : input.route.action === 'consumptions'
          ? buildCurrentUserConsumptionsMessage(
              await input.api.listCurrentUserConsumptions(input.actor, input.route.cursor, 5),
              navigation
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
    const navigation =
      input.route.action === 'list'
        ? profileNavigation(input.actor, 'reports', input.route.cursor)
        : { previousCursor: null };
    const message =
      input.route.action === 'detail'
        ? buildCurrentPlayerWeeklyReportDetailMessage(
            await input.api.getCurrentPlayerWeeklyReport(input.route.reportId, input.actor)
          )
        : buildCurrentPlayerWeeklyReportListMessage(
            await input.api.listCurrentPlayerWeeklyReports(input.actor, input.route.cursor, 4),
            navigation
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

function profileNavigation(
  actor: BotActorContext,
  area: 'orders' | 'consumptions' | 'reports' | 'open' | 'refresh',
  cursor?: string
): { previousCursor: string | null } {
  if (area === 'open' || area === 'refresh') return { previousCursor: null };
  const key = `${actor.guildId}:${actor.discordUserId}:${area}`;
  const current = cursor ?? 'first';
  if (current === 'first') {
    paginationHistory.set(key, ['first']);
    return { previousCursor: null };
  }
  const history = paginationHistory.get(key) ?? ['first'];
  const existingIndex = history.indexOf(current);
  const activeHistory = existingIndex >= 0 ? history.slice(0, existingIndex + 1) : [...history, current];
  paginationHistory.set(key, activeHistory);
  return { previousCursor: activeHistory.at(-2) ?? null };
}
