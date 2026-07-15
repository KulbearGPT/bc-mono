export interface GuildBotActorContext {
  guildId: string;
  clientSource: 'DISCORD_BOT';
}

export interface DiscordBotActorContext extends GuildBotActorContext {
  discordUserId: string;
  interactionId: string;
}

export interface DiscordInteractionIdentity {
  guildId?: string | null;
  id: string;
  user: { id: string };
}

export function buildBotActorContext(input: DiscordInteractionIdentity): DiscordBotActorContext | null {
  const guildId = input.guildId?.trim();
  const discordUserId = input.user.id.trim();
  const interactionId = input.id.trim();
  if (!guildId || !discordUserId || !interactionId) return null;
  return {
    guildId,
    discordUserId,
    interactionId,
    clientSource: 'DISCORD_BOT'
  };
}

export function buildGuildActorContext(guildId: string): GuildBotActorContext | null {
  const normalizedGuildId = guildId.trim();
  return normalizedGuildId ? { guildId: normalizedGuildId, clientSource: 'DISCORD_BOT' } : null;
}

export function buildBotEventActorContext(input: {
  guildId: string;
  discordUserId: string;
  sourceEventId: string;
}): DiscordBotActorContext | null {
  return buildBotActorContext({
    guildId: input.guildId,
    id: input.sourceEventId,
    user: { id: input.discordUserId }
  });
}
