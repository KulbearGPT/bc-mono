import { Listener } from '@sapphire/framework';
import { Events, type GuildMember } from 'discord.js';
import { botConfigCache } from '../../bot-config.js';
import { sendWelcomeDm } from '../../welcome-dm.js';

export default class GuildMemberAddListener extends Listener<typeof Events.GuildMemberAdd> {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: Events.GuildMemberAdd });
  }

  public override async run(member: GuildMember): Promise<void> {
    try {
      const configuredEntryChannelId = botConfigCache.get(member.guild.id)?.values.public_entry_channel_id;
      const result = await sendWelcomeDm({
        recipient: member,
        guild: member.guild,
        publicEntryChannelId:
          typeof configuredEntryChannelId === 'string' && configuredEntryChannelId.length > 0
            ? configuredEntryChannelId
            : null
      });
      this.container.logger.info({
        event: result.sent ? 'bot.welcome_dm.sent' : 'bot.welcome_dm.skipped',
        trigger: 'GUILD_MEMBER_ADD',
        guildId: member.guild.id,
        discordUserId: member.id,
        ...result
      });
    } catch (error) {
      this.container.logger.error({
        event: 'bot.welcome_dm.failed',
        trigger: 'GUILD_MEMBER_ADD',
        guildId: member.guild.id,
        discordUserId: member.id,
        error
      });
    }
  }
}
