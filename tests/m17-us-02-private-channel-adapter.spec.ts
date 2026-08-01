import { describe, expect, test, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { createProvisionalPrivateOrderChannel, finalizePrivateOrderChannel } from '@blackcat/bot/private-order-channel';

function discordFixture(input: { pinRejects?: boolean } = {}) {
  const deleteChannel = vi.fn().mockResolvedValue(undefined);
  const setName = vi.fn().mockResolvedValue(undefined);
  const edit = vi.fn().mockResolvedValue(undefined);
  const pin = input.pinRejects
    ? vi.fn().mockRejectedValue(new Error('missing pin permission'))
    : vi.fn().mockResolvedValue(undefined);
  const panel = { id: 'panel-1', edit, pin };
  const send = vi.fn().mockResolvedValue(panel);
  const channel = { id: 'channel-1', send, delete: deleteChannel, setName };
  const create = vi.fn().mockResolvedValue(channel);
  const guild = { channels: { create } };
  return { guild, channel, panel, create, send, pin, edit, setName, deleteChannel };
}

describe('M17-US-02 private order channel Discord adapter', () => {
  test('applies the shared private-channel plan and pins the placeholder before returning it to the API flow', async () => {
    const fixture = discordFixture();

    const result = await createProvisionalPrivateOrderChannel({
      guild: fixture.guild,
      guildId: 'guild-1',
      categoryId: 'category-1',
      customerDiscordUserId: 'customer-1',
      botUserId: 'bot-1',
      staffRoleIds: ['staff-l1', 'staff-l2'],
      playerRoleId: 'player-role',
      provisionalName: 'customer-name'
    });

    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '订单-customer-name',
        parent: 'category-1',
        permissionOverwrites: expect.arrayContaining([
          { id: 'guild-1', allow: [], deny: [PermissionFlagsBits.ViewChannel] },
          {
            id: 'customer-1',
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
            deny: [PermissionFlagsBits.ManageChannels]
          },
          {
            id: 'bot-1',
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ManageChannels
            ],
            deny: []
          },
          {
            id: 'staff-l1',
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ManageChannels
            ],
            deny: []
          },
          { id: 'player-role', allow: [], deny: [PermissionFlagsBits.ViewChannel] }
        ])
      })
    );
    expect(fixture.send).toHaveBeenCalledWith('正在创建订单面板…');
    expect(fixture.pin).toHaveBeenCalledOnce();
    expect(fixture.send.mock.invocationCallOrder[0]).toBeLessThan(fixture.pin.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ channelId: 'channel-1', panelMessageId: 'panel-1' });
  });

  test('cleans up the provisional channel when sending or pinning the panel fails', async () => {
    const fixture = discordFixture({ pinRejects: true });

    await expect(
      createProvisionalPrivateOrderChannel({
        guild: fixture.guild,
        guildId: 'guild-1',
        categoryId: 'category-1',
        customerDiscordUserId: 'customer-1',
        botUserId: 'bot-1',
        staffRoleIds: [],
        provisionalName: 'customer-name'
      })
    ).rejects.toThrow('missing pin permission');

    expect(fixture.deleteChannel).toHaveBeenCalledWith('Provisional order channel setup failed');
  });

  test('edits the pinned panel and applies the final public order name', async () => {
    const fixture = discordFixture();

    const result = await finalizePrivateOrderChannel({
      channel: fixture.channel,
      panel: fixture.panel,
      orderPublicId: 'P-1042',
      message: { content: 'rendered panel' }
    });

    expect(fixture.edit).toHaveBeenCalledWith({ content: 'rendered panel' });
    expect(fixture.setName).toHaveBeenCalledWith('订单-p-1042');
    expect(result).toEqual({ renamed: true });
  });
});
