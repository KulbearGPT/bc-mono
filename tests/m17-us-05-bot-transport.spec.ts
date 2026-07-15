import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { buildBotActorContext, buildGuildActorContext } from '@blackcat/bot/actor-context';
import { BotApiTransport, BotApiTransportError } from '@blackcat/bot/api-transport';
import { HttpBotConfigApiClient } from '@blackcat/bot/bot-config';

const interaction = {
  guildId: '999999999999999999',
  id: '777777777777777777',
  user: { id: '111111111111111111' }
};

describe('M17-US-05 trusted Bot Actor and API transport', () => {
  test('builds trusted Guild actors once and fails closed for DM or empty identities', () => {
    expect(buildBotActorContext(interaction)).toEqual({
      guildId: interaction.guildId,
      discordUserId: interaction.user.id,
      interactionId: interaction.id,
      clientSource: 'DISCORD_BOT'
    });
    expect(buildBotActorContext({ ...interaction, guildId: null })).toBeNull();
    expect(buildBotActorContext({ ...interaction, guildId: '' })).toBeNull();
    expect(buildGuildActorContext('999999999999999999')).toEqual({
      guildId: '999999999999999999',
      clientSource: 'DISCORD_BOT'
    });
    expect(buildGuildActorContext('')).toBeNull();
  });

  test('applies service authentication, Actor Context, idempotency and JSON envelope parsing consistently', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          requestId: 'req-ok',
          data: { ok: true }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const transport = new BotApiTransport({
      apiBaseUrl: 'https://api.example.test/',
      botServiceToken: 'super-secret-token',
      fetch: fetchMock
    });

    const result = await transport.request<{ ok: boolean }>('/api/v1/example', {
      method: 'POST',
      actor: buildBotActorContext(interaction)!,
      idempotencyKey: 'discord:example:777777777777777777',
      body: { value: 1 },
      includeStatus: true
    });

    expect(result).toEqual({ statusCode: 200, data: { ok: true }, requestId: 'req-ok' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/example',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer super-secret-token',
          'content-type': 'application/json',
          'x-client-source': 'DISCORD_BOT',
          'x-actor-guild-id': interaction.guildId,
          'x-actor-discord-user-id': interaction.user.id,
          'x-discord-interaction-id': interaction.id,
          'idempotency-key': 'discord:example:777777777777777777'
        }),
        body: '{"value":1}',
        signal: expect.any(AbortSignal)
      })
    );
  });

  test('uses the trusted service identity without partial interaction headers for startup config reads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          requestId: 'req-config',
          data: { guildId: interaction.guildId, version: 1, values: {}, manageableFields: [] }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const client = new HttpBotConfigApiClient({
      apiBaseUrl: 'https://api.example.test',
      botServiceToken: 'super-secret-token',
      fetch: fetchMock
    });

    await client.getBotConfig(interaction.guildId, buildGuildActorContext(interaction.guildId)!);

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.example.test/api/v1/admin/bot-config?guildId=${interaction.guildId}`,
      expect.objectContaining({
        headers: {
          authorization: 'Bearer super-secret-token',
          'x-client-source': 'DISCORD_BOT'
        }
      })
    );
  });

  test('normalizes timeout, network, non-JSON and API envelope failures without leaking the token', async () => {
    const timeoutFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })
    ) as unknown as typeof fetch;
    const timeout = new BotApiTransport({
      apiBaseUrl: 'https://api.example.test',
      botServiceToken: 'never-leak-this-token',
      fetch: timeoutFetch,
      timeoutMs: 5
    });
    await expect(timeout.request('/slow', { method: 'GET' })).rejects.toMatchObject({
      code: 'GATEWAY_TIMEOUT',
      requestId: 'bot-api-timeout',
      statusCode: 504
    });

    const cases: Array<{ response?: Response; rejection?: Error; expected: Partial<BotApiTransportError> }> = [
      {
        rejection: new Error('socket includes never-leak-this-token'),
        expected: { code: 'SERVICE_UNAVAILABLE', requestId: 'bot-api-unreachable', statusCode: 503 }
      },
      {
        response: new Response('<html>bad gateway</html>', { status: 502 }),
        expected: { code: 'INVALID_RESPONSE', requestId: 'bot-api-invalid-response', statusCode: 502 }
      },
      {
        response: new Response(
          JSON.stringify({
            requestId: 'req-denied',
            error: { code: 'PERMISSION_DENIED', message: 'No access', details: { capability: 'order.read' } }
          }),
          { status: 403 }
        ),
        expected: {
          code: 'PERMISSION_DENIED',
          requestId: 'req-denied',
          statusCode: 403,
          details: { capability: 'order.read' }
        }
      }
    ];
    for (const item of cases) {
      const fetchMock = item.rejection
        ? vi.fn().mockRejectedValue(item.rejection)
        : vi.fn().mockResolvedValue(item.response);
      const transport = new BotApiTransport({
        apiBaseUrl: 'https://api.example.test',
        botServiceToken: 'never-leak-this-token',
        fetch: fetchMock
      });
      const failure = await transport.request('/failure', { method: 'GET' }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(BotApiTransportError);
      expect(failure).toMatchObject(item.expected);
      expect(JSON.stringify(failure)).not.toContain('never-leak-this-token');
      expect((failure as Error).message).not.toContain('never-leak-this-token');
    }
  });

  test('all five HTTP clients delegate to the transport and interaction handlers do not fabricate Guild actors', async () => {
    const clientSources = await Promise.all(
      [
        'apps/bot/src/service-center.ts',
        'apps/bot/src/bot-config.ts',
        'apps/bot/src/role-sync.ts',
        'apps/bot/src/onboarding.ts',
        'apps/bot/src/order-channel-transcript.ts'
      ].map((path) => readFile(path, 'utf8'))
    );
    for (const source of clientSources) expect(source).toContain('BotApiTransport');

    const handlerSources = await Promise.all(
      [
        'apps/bot/src/pieces/commands/bot-config.ts',
        'apps/bot/src/pieces/commands/player-workbench.ts',
        'apps/bot/src/pieces/interaction-handlers/bot-config-buttons.ts',
        'apps/bot/src/pieces/interaction-handlers/bot-config-modals.ts',
        'apps/bot/src/pieces/interaction-handlers/bot-config-selects.ts',
        'apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts',
        'apps/bot/src/pieces/interaction-handlers/order-selects.ts',
        'apps/bot/src/pieces/interaction-handlers/selection-selects.ts',
        'apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts',
        'apps/bot/src/pieces/interaction-handlers/service-center-modals.ts'
      ].map((path) => readFile(path, 'utf8'))
    );
    const handlers = handlerSources.join('\n');
    expect(handlers).toContain('buildBotActorContext');
    expect(handlers).not.toMatch(/guildId\s*:\s*interaction\.guildId\s*(?:\?\?\s*''|as\s+string)/u);
  });
});
