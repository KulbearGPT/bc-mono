import type { SapphireClient } from '@sapphire/framework';
import { BotConfigApiError, botConfigApi, botConfigCache, reloadBotConfigCache } from './bot-config.js';
import { ensureOnboardingMessage, onboardingApi, reconcileProductRoleTasks } from './onboarding.js';
import {
  HttpRoleSyncApiClient,
  RoleSyncApiError,
  readRoleMappingVersion,
  reconcileDiscordGuilds
} from './role-sync.js';
import { BotReadinessState, initializeBotRuntime, type BotRuntimeTask } from './runtime.js';

interface RuntimeLogger {
  info(value: unknown): void;
  error(value: unknown): void;
}

export async function initializeLiveBotRuntime(input: {
  client: SapphireClient;
  readiness: BotReadinessState;
  apiBaseUrl: string;
  botServiceToken: string;
  roleMappingVersion: string | undefined;
  logger: RuntimeLogger;
  fetch?: typeof fetch;
}): Promise<{ backgroundDone: Promise<{ completed: number; failed: number }> }> {
  const guilds = [...input.client.guilds.cache.values()];
  const roleSyncApi = new HttpRoleSyncApiClient({
    apiBaseUrl: input.apiBaseUrl,
    botServiceToken: input.botServiceToken
  });
  const mappingVersion = readRoleMappingVersion(input.roleMappingVersion);
  const criticalTasks: BotRuntimeTask[] = [
    async () => {
      const response = await (input.fetch ?? fetch)(new URL('/health', input.apiBaseUrl), {
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error('Unified API health check failed during Bot startup.');
    },
    async () => {
      const fatalErrors: unknown[] = [];
      const reload = await reloadBotConfigCache({
        api: botConfigApi,
        cache: botConfigCache,
        guildIds: guilds.map((guild) => guild.id),
        actorForGuild: (guildId) => ({
          guildId,
          clientSource: 'DISCORD_BOT'
        }),
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
        api: onboardingApi
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
      api: onboardingApi
    });
    input.logger.info({
      event: 'bot.product_roles.reconciled',
      guildId: guild.id,
      ...productRoles
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
