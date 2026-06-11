import { describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  HttpBotApiClient,
  buildDiscordSourceEventId,
  buildDiscordIdempotencyKey,
  type BotActorContext
} from '@blackcat/bot/service-center';
import { discoverSapphirePieces } from '@blackcat/bot/piece-manifest';

const guildId = '999999999999999999';
const discordUserId = '111111111111111111';
const interactionId = 'presence:111111111111111111:1';

function actor(): BotActorContext {
  return {
    guildId,
    discordUserId: '999999999999999999',
    interactionId,
    clientSource: 'DISCORD_BOT'
  };
}

describe('M2-US-01 Bot Discord presence sync', () => {
  test('creates distinct source event ids that fit the audit interaction id contract', () => {
    const first = buildDiscordSourceEventId('presence');
    const second = buildDiscordSourceEventId('presence');

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(32);
    expect(first).toMatch(/^[A-Za-z0-9:_-]+$/);
  });

  test('HttpBotApiClient posts presence signals to the reusable unified API endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          discordUserId,
          presence: 'ONLINE',
          observedAt: '2026-07-18T00:00:00.000Z',
          dispatchEligible: true
        }
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBotApiClient({
      apiBaseUrl: 'https://api.example.test/',
      botServiceToken: 'bot-token'
    });

    const result = await client.syncDiscordPresence(
      {
        guildId,
        discordUserId,
        presence: 'ONLINE',
        observedAt: '2026-07-18T00:00:00.000Z',
        sourceEventId: interactionId
      },
      actor(),
      buildDiscordIdempotencyKey('presence:sync', interactionId)
    );

    expect(result).toMatchObject({ discordUserId, presence: 'ONLINE', dispatchEligible: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/internal/discord/presence',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          guildId,
          discordUserId,
          presence: 'ONLINE',
          observedAt: '2026-07-18T00:00:00.000Z',
          sourceEventId: interactionId
        }),
        headers: expect.objectContaining({
          authorization: 'Bearer bot-token',
          'x-client-source': 'DISCORD_BOT',
          'x-actor-guild-id': guildId,
          'idempotency-key': 'discord:presence:sync:presence:111111111111111111:1'
        })
      })
    );
  });

  test('registers a Sapphire presence listener that forwards status changes through HttpBotApiClient', async () => {
    const manifest = await discoverSapphirePieces();
    const source = await readFile('apps/bot/src/pieces/listeners/presence-update.ts', 'utf8');

    expect(manifest.pieces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'listeners', name: 'presence-update' })
      ])
    );
    expect(source).toContain('Events.PresenceUpdate');
    expect(source).toContain('syncDiscordPresence');
    expect(source).toContain("buildDiscordSourceEventId('presence')");
    expect(source).toContain('buildDiscordIdempotencyKey');
    expect(source).not.toContain('`${observedAt}`');
    expect(source).not.toMatch(/updateAvailability|setPlayerAvailability/);
  });
});
