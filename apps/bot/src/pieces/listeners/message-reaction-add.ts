import { Events, Listener } from '@sapphire/framework';
import type { MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';
import { HttpBotApiClient } from '../../service-center-api.js';
import { handleSelectionReactionEvent } from '../../selection-reactions.js';

export default class MessageReactionAddListener extends Listener<typeof Events.MessageReactionAdd> {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: Events.MessageReactionAdd });
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
      state: 'ADDED',
      reaction: resolved,
      user: resolvedUser,
      api,
      logger: this.container.logger,
      removeUserReaction: () => resolved.users.remove(resolvedUser.id)
    });
  }
}
