export interface RetiredSelectionChannel {
  id: string;
  guildId: string;
  parentId: string | null;
  type: number;
  name: string;
  members: { size: number };
  delete(reason?: string): Promise<unknown>;
}

export interface RetiredSelectionChannelAuthorization {
  channelId: string;
  guildId: string;
  parentId: string;
  retiredName: string;
  expiresAt: number;
}

const GUILD_VOICE_CHANNEL = 2;
const RETIRED_SUFFIX = '-closing';
const DEFAULT_AUTHORIZATION_TTL_MS = 10 * 60_000;

export class RetiredSelectionChannelRegistry {
  private readonly authorizations = new Map<string, RetiredSelectionChannelAuthorization>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  public constructor(input: { now?: () => number; ttlMs?: number } = {}) {
    this.now = input.now ?? Date.now;
    this.ttlMs = input.ttlMs ?? DEFAULT_AUTHORIZATION_TTL_MS;
  }

  public authorizeTransition(input: {
    oldChannel: RetiredSelectionChannel;
    newChannel: RetiredSelectionChannel;
    configuredCategoryId: string | null | undefined;
  }): RetiredSelectionChannelAuthorization | null {
    const { oldChannel, newChannel, configuredCategoryId } = input;
    const retiredName = `${oldChannel.name}${RETIRED_SUFFIX}`;
    if (
      !configuredCategoryId ||
      oldChannel.id !== newChannel.id ||
      oldChannel.guildId !== newChannel.guildId ||
      oldChannel.parentId !== configuredCategoryId ||
      newChannel.parentId !== configuredCategoryId ||
      oldChannel.type !== GUILD_VOICE_CHANNEL ||
      newChannel.type !== GUILD_VOICE_CHANNEL ||
      !oldChannel.name.startsWith('selection-') ||
      oldChannel.name.endsWith(RETIRED_SUFFIX) ||
      newChannel.name !== retiredName
    ) {
      return null;
    }

    const authorization = {
      channelId: newChannel.id,
      guildId: newChannel.guildId,
      parentId: configuredCategoryId,
      retiredName,
      expiresAt: this.now() + this.ttlMs
    };
    this.authorizations.set(newChannel.id, authorization);
    return authorization;
  }

  public get(channel: RetiredSelectionChannel | null | undefined): RetiredSelectionChannelAuthorization | null {
    if (!channel) return null;
    const authorization = this.authorizations.get(channel.id);
    if (!authorization) return null;
    if (authorization.expiresAt <= this.now()) {
      this.authorizations.delete(channel.id);
      return null;
    }
    return authorization;
  }

  public clear(channelId: string): void {
    this.authorizations.delete(channelId);
  }
}

export const retiredSelectionChannelRegistry = new RetiredSelectionChannelRegistry();
const deletingChannelIds = new Set<string>();

export async function deleteRetiredSelectionChannel(
  channel: RetiredSelectionChannel | null | undefined,
  authorization = retiredSelectionChannelRegistry.get(channel),
  now = Date.now()
): Promise<boolean> {
  if (
    !channel ||
    !authorization ||
    authorization.channelId !== channel.id ||
    authorization.guildId !== channel.guildId ||
    authorization.parentId !== channel.parentId ||
    authorization.retiredName !== channel.name ||
    authorization.expiresAt <= now ||
    channel.type !== GUILD_VOICE_CHANNEL ||
    channel.members.size !== 0 ||
    deletingChannelIds.has(channel.id)
  ) {
    return false;
  }
  deletingChannelIds.add(channel.id);
  try {
    await channel.delete('Selection finished and the room is empty');
    retiredSelectionChannelRegistry.clear(channel.id);
    return true;
  } finally {
    deletingChannelIds.delete(channel.id);
  }
}
