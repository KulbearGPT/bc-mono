import { Events, Listener } from '@sapphire/framework';
import type { Message, PartialMessage } from 'discord.js';
import { resolveTranscriptUpdateMessage } from '../../order-channel-transcript.js';
import { getBotRuntimeDependencies } from '../../runtime-dependencies.js';
export default class MessageUpdateListener extends Listener<typeof Events.MessageUpdate> {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: Events.MessageUpdate });
  }
  public async run(_old: Message | PartialMessage, message: Message | PartialMessage) {
    try {
      const resolved = await resolveTranscriptUpdateMessage(message);
      if (!resolved) {
        this.container.logger.warn({
          event: 'bot.transcript.update_partial_unavailable',
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id
        });
        return;
      }
      await getBotRuntimeDependencies().transcriptApi.record(resolved, 'UPDATED');
    } catch (error) {
      this.container.logger.error({
        event: 'bot.transcript.update_failed',
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        error
      });
    }
  }
}
