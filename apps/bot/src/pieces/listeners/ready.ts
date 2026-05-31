import { Events, Listener } from '@sapphire/framework';
import {
  HttpRoleSyncApiClient,
  RoleSyncApiError,
  readRoleMappingVersion,
  reconcileDiscordGuilds
} from '../../role-sync.js';
import {
  BotConfigApiError,
  botConfigApi,
  botConfigCache,
  reloadBotConfigCache
} from '../../bot-config.js';

export default class ReadyListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: Events.ClientReady, once: true });
  }

  public override async run(): Promise<void> {
    this.container.logger.info('Sapphire bot ready.');

    try {
      const result = await reconcileDiscordGuilds({
        guilds: this.container.client.guilds.cache,
        api: new HttpRoleSyncApiClient({
          apiBaseUrl: process.env.API_BASE_URL ?? '',
          botServiceToken: process.env.BOT_SERVICE_TOKEN ?? ''
        }),
        mappingVersion: readRoleMappingVersion(process.env.DISCORD_ROLE_MAPPING_VERSION),
        isIgnorableError: (error) => error instanceof RoleSyncApiError && error.code === 'NOT_FOUND',
        onError: (error, context) => {
          this.container.logger.error({
            event: 'bot.role_sync.startup_member_failed',
            ...context,
            error
          });
        }
      });
      this.container.logger.info({ event: 'bot.role_sync.startup_complete', ...result });
    } catch (error) {
      this.container.logger.error({ event: 'bot.role_sync.startup_failed', error });
    }

    const reload = await reloadBotConfigCache({
      api: botConfigApi,
      cache: botConfigCache,
      guildIds: this.container.client.guilds.cache.keys(),
      actorForGuild: (guildId) => ({ guildId, clientSource: 'DISCORD_BOT' }),
      onError: (error, guildId) => {
        if (error instanceof BotConfigApiError && error.code === 'NOT_FOUND') {
          this.container.logger.info({ event: 'bot.config.not_initialized', guildId });
          return;
        }
        this.container.logger.error({ event: 'bot.config.reload_guild_failed', guildId, error });
      }
    });
    this.container.logger.info({ event: 'bot.config.reload_complete', ...reload });
  }
}
