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

export class PaginationHistoryStore {
  private readonly histories = new Map<string, { cursors: string[]; touchedAt: number }>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  public constructor(input: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}) {
    this.now = input.now ?? Date.now;
    this.ttlMs = input.ttlMs ?? 30 * 60_000;
    this.maxEntries = input.maxEntries ?? 2_000;
  }

  public previous(key: string, cursor: string): string | null {
    const now = this.now();
    this.prune(now);
    const current = this.histories.get(key)?.cursors ?? ['first'];
    const existingIndex = current.indexOf(cursor);
    const cursors = existingIndex >= 0 ? current.slice(0, existingIndex + 1) : [...current, cursor];
    this.set(key, cursors, now);
    return cursors.at(-2) ?? null;
  }

  public reset(key: string): void {
    const now = this.now();
    this.prune(now);
    this.set(key, ['first'], now);
  }

  public size(): number {
    return this.histories.size;
  }

  private prune(now: number): void {
    for (const [key, value] of this.histories) {
      if (value.touchedAt + this.ttlMs > now) continue;
      this.histories.delete(key);
    }
  }

  private set(key: string, cursors: string[], now: number): void {
    this.histories.delete(key);
    while (this.histories.size >= this.maxEntries) {
      const oldest = this.histories.keys().next().value;
      if (oldest === undefined) break;
      this.histories.delete(oldest);
    }
    this.histories.set(key, { cursors, touchedAt: now });
  }
}

const paginationHistory = new PaginationHistoryStore();

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
    paginationHistory.reset(key);
    return { previousCursor: null };
  }
  return { previousCursor: paginationHistory.previous(key, current) };
}
