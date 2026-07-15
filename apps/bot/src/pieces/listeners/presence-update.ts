import { Events, type Presence } from 'discord.js';
import { Listener } from '@sapphire/framework';
import { buildBotEventActorContext } from '../../actor-context.js';
import {
  HttpBotApiClient,
  buildDiscordIdempotencyKey,
  buildDiscordSourceEventId,
  type BotActorContext,
  type DiscordPresenceSummary
} from '../../service-center.js';

export default class PresenceUpdateListener extends Listener<typeof Events.PresenceUpdate> {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: Events.PresenceUpdate });
  }

  public override async run(_oldPresence: Presence | null, newPresence: Presence): Promise<void> {
    const guildId = newPresence.guild?.id;
    const discordUserId = newPresence.userId;
    if (!guildId || !discordUserId) {
      return;
    }

    const observedAt = new Date().toISOString();
    const sourceEventId = buildDiscordSourceEventId('presence');
    const actor: BotActorContext | null = buildBotEventActorContext({
      guildId,
      discordUserId,
      sourceEventId
    });
    if (!actor) return;

    const api = new HttpBotApiClient({
      apiBaseUrl: process.env.API_BASE_URL ?? '',
      botServiceToken: process.env.BOT_SERVICE_TOKEN ?? ''
    });

    await api.syncDiscordPresence(
      {
        guildId,
        discordUserId,
        presence: toApiPresence(newPresence.status),
        observedAt,
        sourceEventId
      },
      actor,
      buildDiscordIdempotencyKey('presence:sync', sourceEventId)
    );
  }
}

function toApiPresence(status: Presence['status']): DiscordPresenceSummary {
  if (status === 'online') {
    return 'ONLINE';
  }
  if (status === 'idle') {
    return 'IDLE';
  }
  if (status === 'dnd') {
    return 'DND';
  }
  if (status === 'offline' || status === 'invisible') {
    return 'OFFLINE';
  }
  return 'UNKNOWN';
}
