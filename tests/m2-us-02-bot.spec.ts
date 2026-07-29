import { describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { HttpBotApiClient, buildDiscordIdempotencyKey, type BotActorContext } from '@blackcat/bot/service-center';
import { discoverSapphirePieces } from '@blackcat/bot/piece-manifest';

const guildId = '999999999999999999';
const dispatchAttemptId = '00000000-0000-0000-0000-00000000d201';
const orderId = '00000000-0000-0000-0000-00000000b001';

function actor(): BotActorContext {
  return {
    guildId,
    discordUserId: '222222222222222222',
    interactionId: '888888888888888888',
    clientSource: 'DISCORD_BOT'
  };
}

describe('M2-US-02 Bot dispatch card', () => {
  test('HttpBotApiClient accepts and declines dispatch offers through the unified API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: { id: orderId, status: 'ACCEPTED', version: 4 }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: { id: orderId, status: 'PENDING_DISPATCH', version: 3 }
        })
      });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBotApiClient({
      apiBaseUrl: 'https://api.example.test',
      botServiceToken: 'bot-token'
    });

    await client.acceptOrder(
      orderId,
      { expectedVersion: 3, dispatchAttemptId },
      actor(),
      buildDiscordIdempotencyKey('dispatch:accept', '888888888888888888')
    );
    await client.declineOrderOffer(
      orderId,
      { expectedVersion: 3 },
      actor(),
      buildDiscordIdempotencyKey('dispatch:decline', '888888888888888888')
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `https://api.example.test/api/v1/orders/${orderId}/accept`,
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.example.test/api/v1/orders/${orderId}/decline`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('registers a Sapphire dispatch interaction handler', async () => {
    const manifest = await discoverSapphirePieces();
    const source = await readFile('apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts', 'utf8');

    expect(manifest.pieces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'interaction-handlers',
          name: 'dispatch-buttons'
        })
      ])
    );
    expect(source).toContain('applyToSelectionPool');
    expect(source).toContain('withdrawSelectionApplication');
    expect(source).not.toContain('acceptOrder(');
    expect(source).toContain('buildDiscordIdempotencyKey');
  });
});
