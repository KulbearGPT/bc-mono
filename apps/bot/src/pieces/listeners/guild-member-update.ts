import { Listener } from '@sapphire/framework';
import { Events, type GuildMember } from 'discord.js';
import { syncGuildMemberUpdate } from '../../role-sync.js';
import { getBotRuntimeDependencies } from '../../runtime-dependencies.js';

export default class GuildMemberUpdateListener extends Listener<typeof Events.GuildMemberUpdate> {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: Events.GuildMemberUpdate });
  }

  public override async run(oldMember: GuildMember, newMember: GuildMember): Promise<void> {
    try {
      const dependencies = getBotRuntimeDependencies();
      await syncGuildMemberUpdate(oldMember, newMember, {
        api: dependencies.roleSyncApi,
        mappingVersion: dependencies.roleMappingVersion
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
