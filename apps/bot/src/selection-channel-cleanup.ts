export interface RetiredSelectionChannel {
  id: string;
  type: number;
  name: string;
  members: { size: number };
  delete(reason?: string): Promise<unknown>;
}

const GUILD_VOICE_CHANNEL = 2;
const RETIRED_SUFFIX = '-closing';
const deletingChannelIds = new Set<string>();

export async function deleteRetiredSelectionChannel(
  channel: RetiredSelectionChannel | null | undefined
): Promise<boolean> {
  if (
    !channel ||
    channel.type !== GUILD_VOICE_CHANNEL ||
    !channel.name.startsWith('selection-') ||
    !channel.name.endsWith(RETIRED_SUFFIX) ||
    channel.members.size !== 0 ||
    deletingChannelIds.has(channel.id)
  ) {
    return false;
  }
  deletingChannelIds.add(channel.id);
  try {
    await channel.delete('Selection finished and the room is empty');
    return true;
  } catch (error) {
    deletingChannelIds.delete(channel.id);
    throw error;
  }
}
