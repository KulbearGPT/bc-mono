import { Events, Listener } from '@sapphire/framework';
import type { MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';
import { HttpBotApiClient } from '../../service-center-api.js';
import { handleSelectionReactionEvent } from '../../selection-reactions.js';

export default class MessageReactionRemoveListener extends Listener<typeof Events.MessageReactionRemove> {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: Events.MessageReactionRemove });
  }

  public override async run(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
    const resolved = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
    const resolvedUser = user.partial ? await user.fetch().catch(() => null) : user;
    if (!resolved || !resolvedUser) return;
    const api = new HttpBotApiClient({
      apiBaseUrl: process.env.API_BASE_URL ?? '',
      botServiceToken: process.env.BOT_SERVICE_TOKEN ?? ''
    });
    await handleSelectionReactionEvent({
      state: 'REMOVED',
      reaction: resolved,
      user: resolvedUser,
      api,
      logger: this.container.logger,
      removeUserReaction: () => Promise.resolve()
    });
  }
}
