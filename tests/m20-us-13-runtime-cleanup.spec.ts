import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { BotConfigApiError, BotConfigSessionStore, HttpBotConfigApiClient } from '@blackcat/bot/bot-config';
import {
  configureBotRuntimeDependencies,
  createBotRuntimeDependencies,
  getBotRuntimeDependencies,
  resetBotRuntimeDependenciesForTests
} from '@blackcat/bot/runtime-dependencies';
import { validateBotApiData } from '@blackcat/bot/bot-api-validation';
import { PaginationHistoryStore } from '@blackcat/bot/service-center-profile-interactions';
import { BotApiError, HttpBotApiClient } from '@blackcat/bot/service-center-api';

describe('M20-US-13 Bot runtime and module cleanup', () => {
  test('constructs one injectable runtime graph and never falls back to global fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ requestId: 'req-health', data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const dependencies = createBotRuntimeDependencies({
      apiBaseUrl: 'https://api.example.test',
      botServiceToken: 'x'.repeat(40),
      giftContinuationSigningSecret: 'g'.repeat(40),
      fetch: fetchMock
    });
    await dependencies.transport.request('/probe', { method: 'GET' });
    expect(fetchMock).toHaveBeenCalledOnce();

    resetBotRuntimeDependenciesForTests();
    configureBotRuntimeDependencies(dependencies);
    expect(getBotRuntimeDependencies()).toBe(dependencies);
    expect(() => configureBotRuntimeDependencies(dependencies)).toThrow('already configured');
    resetBotRuntimeDependenciesForTests();
  });

  test('fails closed for malformed order, wallet, gift, selection and config DTOs', () => {
    for (const [kind, value] of [
      ['order', { id: 'order-only' }],
      ['balance', { ledgerBalanceMinor: 10, reservedMinor: 20, availableMinor: 999, currency: 'USD' }],
      ['gift-panel', { orderId: 'order', recipients: 'not-an-array' }],
      ['selection-page', { pool: {}, items: 'not-an-array', nextCursor: null }],
      ['bot-config', { guildId: '', version: 0, values: [] }]
    ] as const) {
      expect(() => validateBotApiData(kind, value)).toThrow(/invalid/i);
    }
  });

  test('translates malformed unified API responses into stable 502 client errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            requestId: 'req-balance',
            data: { ledgerBalanceMinor: 10, reservedMinor: 2, availableMinor: 999, currency: 'USD' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ requestId: 'req-config', data: { guildId: '', version: 0, values: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    const actor = {
      guildId: 'guild-1',
      discordUserId: 'user-1',
      interactionId: 'interaction-1',
      clientSource: 'DISCORD_BOT' as const
    };
    const api = new HttpBotApiClient({
      apiBaseUrl: 'https://api.example.test',
      botServiceToken: 'x'.repeat(40),
      fetch: fetchMock
    });
    await expect(api.getCurrentBalance(actor)).rejects.toMatchObject<Partial<BotApiError>>({
      code: 'INVALID_RESPONSE',
      statusCode: 502
    });

    const configApi = new HttpBotConfigApiClient({
      apiBaseUrl: 'https://api.example.test',
      botServiceToken: 'x'.repeat(40),
      fetch: fetchMock
    });
    await expect(configApi.getBotConfig(actor.guildId, actor)).rejects.toMatchObject<Partial<BotConfigApiError>>({
      code: 'INVALID_RESPONSE',
      statusCode: 502
    });
  });

  test('bounds and expires config sessions and profile cursor histories', () => {
    let now = 1_000;
    let sequence = 0;
    const sessions = new BotConfigSessionStore({
      now: () => now,
      ttlMs: 100,
      maxEntries: 2,
      idFactory: () => `session_${++sequence}`
    });
    const actor = {
      guildId: 'guild-1',
      discordUserId: 'user-1',
      interactionId: 'interaction-1',
      clientSource: 'DISCORD_BOT' as const
    };
    const snapshot = { guildId: 'guild-1', version: 1, values: {}, manageableFields: [] };
    const first = sessions.create(actor, snapshot);
    sessions.create(actor, snapshot);
    sessions.create(actor, snapshot);
    expect(() => sessions.require(actor, first.id)).toThrow();

    const history = new PaginationHistoryStore({ now: () => now, ttlMs: 100, maxEntries: 2 });
    history.previous('a', 'cursor-a');
    history.previous('b', 'cursor-b');
    history.previous('c', 'cursor-c');
    expect(history.size()).toBe(2);
    now += 101;
    expect(history.previous('c', 'cursor-c2')).toBe('first');
    expect(history.size()).toBe(1);
    history.reset('d');
    history.reset('e');
    history.reset('f');
    expect(history.size()).toBe(2);
  });

  test('removes env-reading Piece clients, retired dispatch DTOs and dead permission plans', async () => {
    const piecePaths = [
      'apps/bot/src/pieces/commands/player-workbench.ts',
      'apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts',
      'apps/bot/src/pieces/interaction-handlers/order-selects.ts',
      'apps/bot/src/pieces/interaction-handlers/selection-selects.ts',
      'apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts',
      'apps/bot/src/pieces/interaction-handlers/service-center-modals.ts',
      'apps/bot/src/pieces/listeners/guild-member-update.ts',
      'apps/bot/src/pieces/listeners/message-reaction-add.ts',
      'apps/bot/src/pieces/listeners/message-reaction-remove.ts',
      'apps/bot/src/pieces/listeners/presence-update.ts'
    ];
    const pieces = (await Promise.all(piecePaths.map((path) => readFile(path, 'utf8')))).join('\n');
    expect(pieces).not.toContain('process.env.API_BASE_URL');
    expect(pieces).not.toContain('new HttpBotApiClient');

    const [api, center, components, entry] = await Promise.all(
      [
        'apps/bot/src/service-center-api.ts',
        'apps/bot/src/service-center.ts',
        'apps/bot/src/service-center-components.ts',
        'apps/bot/src/service-center-entry.ts'
      ].map((path) => readFile(path, 'utf8'))
    );
    const retired = [api, center, components, entry].join('\n');
    expect(retired).not.toContain('DispatchOfferSummary');
    expect(retired).not.toContain('AcceptedPlayerChannelPermissionPlan');
    expect(retired).not.toContain('buildAcceptedPlayerChannelPermissionPlan');
    expect(retired).not.toContain("'SET_AVAILABLE'");
    expect(center.split('\n').length).toBeLessThan(2_200);
  });
});
