import type { SapphireClient } from '@sapphire/framework';
import { buildGuildActorContext } from './actor-context.js';
import { BotConfigApiError, botConfigCache, reloadBotConfigCache } from './bot-config.js';
import { ensureOnboardingMessage, reconcileProductRoleTasks } from './onboarding.js';
import { RoleSyncApiError, reconcileDiscordGuilds } from './role-sync.js';
import { BotReadinessState, initializeBotRuntime, type BotRuntimeTask } from './runtime.js';
import { reconcileSelectionReactionCards } from './selection-reactions.js';
import type { BotRuntimeDependencies } from './runtime-dependencies.js';

interface RuntimeLogger {
  info(value: unknown): void;
  error(value: unknown): void;
}

export async function initializeLiveBotRuntime(input: {
  client: SapphireClient;
  readiness: BotReadinessState;
  apiBaseUrl: string;
  logger: RuntimeLogger;
  dependencies: BotRuntimeDependencies;
}): Promise<{ backgroundDone: Promise<{ completed: number; failed: number }> }> {
  const guilds = [...input.client.guilds.cache.values()];
  const roleSyncApi = input.dependencies.roleSyncApi;
  const selectionReactionApi = input.dependencies.api;
  const mappingVersion = input.dependencies.roleMappingVersion;
  const criticalTasks: BotRuntimeTask[] = [
    async () => {
      const response = await input.dependencies.fetch(new URL('/health', input.apiBaseUrl), {
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error('Unified API health check failed during Bot startup.');
    },
    async () => {
      const fatalErrors: unknown[] = [];
      const reload = await reloadBotConfigCache({
        api: input.dependencies.botConfigApi,
        cache: botConfigCache,
        guildIds: guilds.map((guild) => guild.id),
        actorForGuild: (guildId) => {
          const actor = buildGuildActorContext(guildId);
          if (!actor) throw new Error('Guild Actor Context is required.');
          return actor;
        },
        onError: (error, guildId) => {
          if (error instanceof BotConfigApiError && error.code === 'NOT_FOUND') {
            input.logger.info({ event: 'bot.config.not_initialized', guildId });
            return;
          }
          fatalErrors.push(error);
          input.logger.error({
            event: 'bot.config.reload_guild_failed',
            guildId,
            error
          });
        }
      });
      input.logger.info({ event: 'bot.config.reload_complete', ...reload });
      if (fatalErrors.length) throw new AggregateError(fatalErrors, 'Bot config reload failed during startup.');
    },
    ...guilds.map((guild): BotRuntimeTask => async () => {
      const channelId = botConfigCache.get(guild.id)?.values.public_entry_channel_id;
      if (typeof channelId !== 'string' || !channelId) return;
      const result = await ensureOnboardingMessage({
        guild,
        channelId,
        api: input.dependencies.onboardingApi
      });
      input.logger.info({
        event: 'bot.onboarding_message.ensured',
        guildId: guild.id,
        ...result
      });
    })
  ];
  const backgroundTasks = guilds.map((guild): BotRuntimeTask => async () => {
    const roleSync = await reconcileDiscordGuilds({
      guilds: [[guild.id, guild]],
      api: roleSyncApi,
      mappingVersion,
      isIgnorableError: (error) => error instanceof RoleSyncApiError && error.code === 'NOT_FOUND',
      onError: (error, context) => {
        input.logger.error({
          event: 'bot.role_sync.startup_member_failed',
          ...context,
          error
        });
      }
    });
    input.logger.info({
      event: 'bot.role_sync.startup_guild_complete',
      guildId: guild.id,
      ...roleSync
    });
    const productRoles = await reconcileProductRoleTasks({
      guild,
      api: input.dependencies.onboardingApi
    });
    input.logger.info({
      event: 'bot.product_roles.reconciled',
      guildId: guild.id,
      ...productRoles
    });
    const reactionCards = await reconcileSelectionReactionCards({
      guildId: guild.id,
      api: selectionReactionApi,
      fetchReactionUserIds: async (card, emoji) => {
        const channel = await guild.channels.fetch(card.channelId);
        if (!channel?.isTextBased()) throw new Error('Selection reaction channel is unavailable.');
        const message = await channel.messages.fetch(card.messageId);
        const reaction = message.reactions.resolve(emoji);
        if (!reaction) return [];
        const userIds: string[] = [];
        let after: string | undefined;
        while (true) {
          const users = await reaction.users.fetch({ limit: 100, after });
          const batch = [...users.values()];
          userIds.push(...batch.filter((user) => !user.bot).map((user) => user.id));
          if (batch.length < 100) break;
          after = batch.at(-1)?.id;
          if (!after) break;
        }
        return userIds;
      },
      logger: input.logger
    });
    input.logger.info({
      event: 'bot.selection_reactions.reconciled',
      guildId: guild.id,
      ...reactionCards
    });
  });

  return initializeBotRuntime({
    readiness: input.readiness,
    criticalTasks,
    backgroundTasks,
    backgroundConcurrency: 2,
    onBackgroundError: (error, taskIndex) => {
      input.logger.error({
        event: 'bot.background_reconciliation.failed',
        guildId: guilds[taskIndex]?.id,
        error
      });
    }
  });
}
