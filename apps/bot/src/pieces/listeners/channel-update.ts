import { Events, Listener } from '@sapphire/framework';
import type { NonThreadGuildBasedChannel } from 'discord.js';
import { botConfigCache } from '../../bot-config.js';
import { deleteRetiredSelectionChannel, retiredSelectionChannelRegistry } from '../../selection-channel-cleanup.js';

export default class ChannelUpdateListener extends Listener<typeof Events.ChannelUpdate> {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: Events.ChannelUpdate });
  }

  public override async run(
    oldChannel: NonThreadGuildBasedChannel,
    newChannel: NonThreadGuildBasedChannel
  ): Promise<void> {
    try {
      const configuredCategoryId = botConfigCache.get(newChannel.guildId)?.values.private_order_category_id;
      const authorization = retiredSelectionChannelRegistry.authorizeTransition({
        oldChannel: oldChannel as never,
        newChannel: newChannel as never,
        configuredCategoryId: typeof configuredCategoryId === 'string' ? configuredCategoryId : null
      });
      await deleteRetiredSelectionChannel(newChannel as never, authorization);
    } catch (error) {
      this.container.logger.error({
        event: 'bot.selection_voice.cleanup_failed',
        guildId: newChannel.guildId,
        channelId: newChannel.id,
        error
      });
    }
  }
}
