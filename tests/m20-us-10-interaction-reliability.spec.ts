import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { BotApiError, type BotActorContext, type BotApiClient } from '@blackcat/bot/service-center-api';
import { executePlayerWorkbenchInteraction } from '@blackcat/bot/player-workbench-interactions';
import { executeServiceCenterModalSubmit } from '@blackcat/bot/service-center-modal-interactions';

const actor: BotActorContext = {
  guildId: '999999999999999999',
  discordUserId: '888888888888888888',
  interactionId: '777777777777777777',
  clientSource: 'DISCORD_BOT'
};

describe('M20-US-10 Discord interaction reliability', () => {
  test('restricts the public service-center deployment command to Guild managers', async () => {
    const source = await readFile('apps/bot/src/pieces/commands/service-center.ts', 'utf8');
    expect(source).toContain('.setDMPermission(false)');
    expect(source).toContain('.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)');
  });

  test('acknowledges the player workbench before a slow API read and edits the private response', async () => {
    const events: string[] = [];
    const interaction = {
      id: actor.interactionId,
      deferReply: vi.fn(async () => void events.push('ack')),
      editReply: vi.fn(async () => void events.push('edit'))
    };
    const api = {
      getPlayerWorkbench: vi.fn(async () => {
        events.push('api');
        throw new BotApiError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'unavailable',
          requestId: 'req-workbench-down',
          statusCode: 503
        });
      })
    } as unknown as BotApiClient;

    await executePlayerWorkbenchInteraction({ interaction, actor, api });

    expect(events).toEqual(['ack', 'api', 'edit']);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('request_id: req-workbench-down'));
  });

  test('catches requirement-note API failures after defer and sends a private traceable follow-up', async () => {
    const events: string[] = [];
    const interaction = {
      id: actor.interactionId,
      deferUpdate: vi.fn(async () => void events.push('ack')),
      editReply: vi.fn(async () => void events.push('edit')),
      followUp: vi.fn(async () => void events.push('follow-up')),
      fields: { getTextInputValue: vi.fn().mockReturnValue('偏好备注') }
    };
    const api = {
      listOrderRequirements: vi.fn(),
      addOrderRequirement: vi.fn(),
      updateOrderRequirement: vi.fn(async () => {
        events.push('api');
        throw new BotApiError({
          code: 'CONFLICT',
          message: 'stale requirement',
          requestId: 'req-note-stale',
          statusCode: 409
        });
      })
    } as unknown as BotApiClient;

    await executeServiceCenterModalSubmit({
      interaction,
      route: {
        area: 'requirement-note-modal',
        orderId: '11111111-1111-4111-8111-111111111111',
        requirementId: '22222222-2222-4222-8222-222222222222',
        expectedVersion: 3,
        expectedRequirementVersion: 4
      },
      actor,
      api
    });

    expect(events).toEqual(['ack', 'api', 'follow-up']);
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: expect.stringContaining('request_id: req-note-stale'),
      ephemeral: true
    });
  });
});
