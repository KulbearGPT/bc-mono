import { Events, Listener } from '@sapphire/framework';
import type { VoiceState } from 'discord.js';
import { deleteRetiredSelectionChannel, retiredSelectionChannelRegistry } from '../../selection-channel-cleanup.js';

export default class VoiceStateUpdateListener extends Listener<typeof Events.VoiceStateUpdate> {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: Events.VoiceStateUpdate });
  }

  public override async run(oldState: VoiceState): Promise<void> {
    try {
      const channel = oldState.channel as never;
      await deleteRetiredSelectionChannel(channel, retiredSelectionChannelRegistry.get(channel));
    } catch (error) {
      this.container.logger.error({
        event: 'bot.selection_voice.cleanup_failed',
        guildId: oldState.guild.id,
        channelId: oldState.channelId,
        error
      });
    }
  }
}
