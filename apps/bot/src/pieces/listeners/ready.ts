import { Listener } from '@sapphire/framework';
import {
  HttpRoleSyncApiClient,
  readRoleMappingVersion,
  reconcileDiscordGuilds
} from '../../role-sync.js';

export default class ReadyListener extends Listener {
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
  }
}
