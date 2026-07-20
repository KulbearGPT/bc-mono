import { Events, Listener } from '@sapphire/framework';
import type { NonThreadGuildBasedChannel } from 'discord.js';
import { deleteRetiredSelectionChannel } from '../../selection-channel-cleanup.js';

export default class ChannelUpdateListener extends Listener<typeof Events.ChannelUpdate> {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: Events.ChannelUpdate });
  }

  public override async run(
    _oldChannel: NonThreadGuildBasedChannel,
    newChannel: NonThreadGuildBasedChannel
  ): Promise<void> {
    try {
      await deleteRetiredSelectionChannel(newChannel as never);
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
