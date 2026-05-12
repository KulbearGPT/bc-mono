import { Listener } from '@sapphire/framework';
import { Events, type GuildMember } from 'discord.js';
import {
  HttpRoleSyncApiClient,
  readRoleMappingVersion,
  syncGuildMemberUpdate
} from '../../role-sync.js';

export default class GuildMemberUpdateListener extends Listener<typeof Events.GuildMemberUpdate> {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: Events.GuildMemberUpdate });
  }

  public override async run(oldMember: GuildMember, newMember: GuildMember): Promise<void> {
    try {
      await syncGuildMemberUpdate(oldMember, newMember, {
        api: new HttpRoleSyncApiClient({
          apiBaseUrl: process.env.API_BASE_URL ?? '',
          botServiceToken: process.env.BOT_SERVICE_TOKEN ?? ''
        }),
        mappingVersion: readRoleMappingVersion(process.env.DISCORD_ROLE_MAPPING_VERSION)
      });
    } catch (error) {
      this.container.logger.error({
        event: 'bot.role_sync.guild_member_update_failed',
        guildId: newMember.guild.id,
        discordUserId: newMember.id,
        error
      });
    }
  }
}
