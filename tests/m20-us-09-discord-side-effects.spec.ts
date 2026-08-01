import { describe, expect, test, vi } from 'vitest';
import {
  deleteRetiredSelectionChannel,
  RetiredSelectionChannelRegistry
} from '@blackcat/bot/selection-channel-cleanup';
import {
  cleanupProvisionalPrivateOrderChannel,
  finalizePrivateOrderChannel
} from '@blackcat/bot/private-order-channel';

function voiceChannel(input: {
  name: string;
  members?: number;
  id?: string;
  guildId?: string;
  parentId?: string | null;
  remove?: ReturnType<typeof vi.fn>;
}) {
  return {
    id: input.id ?? 'selection-channel',
    guildId: input.guildId ?? 'guild-1',
    parentId: input.parentId === undefined ? 'category-1' : input.parentId,
    type: 2,
    name: input.name,
    members: { size: input.members ?? 0 },
    delete: input.remove ?? vi.fn().mockResolvedValue(undefined)
  };
}

describe('M20-US-09 trusted Discord side effects', () => {
  test('does not delete an untrusted lookalike voice channel by name alone', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);

    await expect(
      deleteRetiredSelectionChannel({
        id: 'unrelated-channel',
        guildId: 'guild-1',
        parentId: 'category-1',
        type: 2,
        name: 'selection-community-closing',
        members: { size: 0 },
        delete: remove
      })
    ).resolves.toBe(false);

    expect(remove).not.toHaveBeenCalled();
  });

  test('deletes only an exact authorized retirement transition in the configured category', async () => {
    let now = 1_000;
    const registry = new RetiredSelectionChannelRegistry({ now: () => now, ttlMs: 5_000 });
    const oldChannel = voiceChannel({ name: 'selection-p-m20' });
    const newChannel = voiceChannel({ name: 'selection-p-m20-closing' });
    const authorization = registry.authorizeTransition({
      oldChannel,
      newChannel,
      configuredCategoryId: 'category-1'
    });

    expect(authorization).not.toBeNull();
    await expect(deleteRetiredSelectionChannel(newChannel, authorization, now)).resolves.toBe(true);
    expect(newChannel.delete).toHaveBeenCalledWith('Selection finished and the room is empty');

    now = 10_000;
    const expiredChannel = voiceChannel({ name: 'selection-p-expired-closing', id: 'expired' });
    const expiredAuthorization = registry.authorizeTransition({
      oldChannel: voiceChannel({ name: 'selection-p-expired', id: 'expired' }),
      newChannel: expiredChannel,
      configuredCategoryId: 'category-1'
    });
    now = 16_000;
    await expect(deleteRetiredSelectionChannel(expiredChannel, expiredAuthorization, now)).resolves.toBe(false);
  });

  test('retains authorization while occupied and rejects wrong guild, category, or rename', async () => {
    const registry = new RetiredSelectionChannelRegistry();
    const occupied = voiceChannel({ name: 'selection-p-occupied-closing', members: 1 });
    const authorization = registry.authorizeTransition({
      oldChannel: voiceChannel({ name: 'selection-p-occupied' }),
      newChannel: occupied,
      configuredCategoryId: 'category-1'
    });

    await expect(deleteRetiredSelectionChannel(occupied, authorization)).resolves.toBe(false);
    expect(occupied.delete).not.toHaveBeenCalled();
    expect(registry.get(occupied)).toEqual(authorization);
    expect(
      registry.authorizeTransition({
        oldChannel: voiceChannel({ name: 'selection-p-wrong', guildId: 'guild-2' }),
        newChannel: voiceChannel({ name: 'selection-p-wrong-closing' }),
        configuredCategoryId: 'category-1'
      })
    ).toBeNull();
    expect(
      registry.authorizeTransition({
        oldChannel: voiceChannel({ name: 'selection-p-wrong' }),
        newChannel: voiceChannel({ name: 'selection-p-wrong-closing', parentId: 'category-2' }),
        configuredCategoryId: 'category-1'
      })
    ).toBeNull();
    expect(
      registry.authorizeTransition({
        oldChannel: voiceChannel({ name: 'selection-p-wrong' }),
        newChannel: voiceChannel({ name: 'selection-other-closing' }),
        configuredCategoryId: 'category-1'
      })
    ).toBeNull();
  });

  test('returns a recoverable rename failure instead of silently reporting success', async () => {
    const renameError = new Error('missing ManageChannels');
    const panel = { edit: vi.fn().mockResolvedValue(undefined) };
    const channel = { setName: vi.fn().mockRejectedValue(renameError) };

    const result = await finalizePrivateOrderChannel({
      channel: channel as never,
      panel: panel as never,
      orderPublicId: 'P-M20-SIDE-EFFECT',
      message: { content: 'rendered panel' }
    });

    expect(panel.edit).toHaveBeenCalledOnce();
    expect(result).toEqual({ renamed: false, error: renameError });
  });

  test('never deletes a provisional channel after the API business fact is committed', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);

    await expect(
      cleanupProvisionalPrivateOrderChannel({
        channel: { delete: remove } as never,
        businessCommitted: true,
        reason: 'Order creation failed'
      })
    ).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();

    await expect(
      cleanupProvisionalPrivateOrderChannel({
        channel: { delete: remove } as never,
        businessCommitted: false,
        reason: 'Order creation failed'
      })
    ).resolves.toBe(true);
    expect(remove).toHaveBeenCalledWith('Order creation failed');
  });
});
