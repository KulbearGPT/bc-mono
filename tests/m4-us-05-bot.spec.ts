import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import {
  HttpRoleSyncApiClient,
  buildRoleSyncObservation,
  reconcileDiscordGuilds,
  syncGuildMemberUpdate
} from '../apps/bot/src/role-sync.js';
import { discoverSapphirePieces } from '@blackcat/bot/piece-manifest';

const guildId = '999999999999999999';
const discordUserId = '111111111111111111';
const observedAt = '2026-07-18T12:00:00.000Z';

function member(input: { id: string; roleIds: string[]; bot?: boolean }) {
  return {
    id: input.id,
    guild: { id: guildId },
    user: { bot: input.bot ?? false },
    roles: { cache: new Map(input.roleIds.map((roleId) => [roleId, { id: roleId }])) }
  };
}

describe('M4-US-05 Bot Discord Role sync adapter', () => {
  test('posts only observed Discord facts to the shared API with service authentication', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { status: 'APPLIED' } })
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpRoleSyncApiClient({
      apiBaseUrl: 'https://api.example.test/',
      botServiceToken: 'bot-token',
      retryDelaysMs: []
    });
    const observation = buildRoleSyncObservation({
      guildId,
      discordUserId,
      observedRoleIds: ['300000000000000003', '200000000000000002', '300000000000000003'],
      mappingVersion: 7,
      source: 'GUILD_MEMBER_UPDATE',
      observedAt
    });

    await client.syncDiscordRoles(observation);

    expect(observation.observedRoleIds).toEqual(['200000000000000002', '300000000000000003']);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/internal/discord/role-sync',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(observation),
        headers: expect.objectContaining({
          authorization: 'Bearer bot-token',
          'content-type': 'application/json',
          'x-client-source': 'DISCORD_BOT',
          'idempotency-key': `discord:role-sync:${observation.sourceEventId}:v${observation.mappingVersion}`
        })
      })
    );
    const requestHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(requestHeaders).not.toHaveProperty('x-actor-guild-id');
    expect(requestHeaders).not.toHaveProperty('x-actor-discord-user-id');
    expect(JSON.stringify(observation)).not.toMatch(/effectiveLevel|staffLevel|permission/i);
  });

  test('retries transient failures with the same event identity and request body', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: { code: 'UNAVAILABLE' } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { status: 'APPLIED' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpRoleSyncApiClient({
      apiBaseUrl: 'https://api.example.test',
      botServiceToken: 'bot-token',
      retryDelaysMs: [0]
    });
    const observation = buildRoleSyncObservation({
      guildId,
      discordUserId,
      observedRoleIds: [],
      mappingVersion: 7,
      source: 'GUILD_MEMBER_UPDATE',
      observedAt
    });

    await client.syncDiscordRoles(observation);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(first.body).toBe(second.body);
    expect((first.headers as Record<string, string>)['idempotency-key'])
      .toBe((second.headers as Record<string, string>)['idempotency-key']);
  });

  test('adopts the API mapping version after a stale-version response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: { code: 'MAPPING_VERSION_STALE', details: [{ field: 'mappingVersion', reason: 'expected 8' }] } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { status: 'APPLIED' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpRoleSyncApiClient({ apiBaseUrl: 'https://api.example.test', botServiceToken: 'bot-token', retryDelaysMs: [] });
    const observation = buildRoleSyncObservation({ guildId, discordUserId, observedRoleIds: [], mappingVersion: 7, source: 'GUILD_MEMBER_UPDATE', observedAt });

    await client.syncDiscordRoles(observation);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({ mappingVersion: 8, sourceEventId: observation.sourceEventId });
    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(secondHeaders['idempotency-key']).not.toBe(firstHeaders['idempotency-key']);
  });

  test('guildMemberUpdate ignores non-role changes and forwards the current role snapshot when roles change', async () => {
    const api = { syncDiscordRoles: vi.fn().mockResolvedValue({ status: 'APPLIED' }) };
    const oldMember = member({ id: discordUserId, roleIds: ['200000000000000002'] });
    const unchangedMember = member({ id: discordUserId, roleIds: ['200000000000000002'] });
    const changedMember = member({ id: discordUserId, roleIds: ['300000000000000003', '200000000000000002'] });

    await syncGuildMemberUpdate(oldMember, unchangedMember, {
      api,
      mappingVersion: 7,
      now: () => new Date(observedAt)
    });
    await syncGuildMemberUpdate(oldMember, changedMember, {
      api,
      mappingVersion: 7,
      now: () => new Date(observedAt)
    });

    expect(api.syncDiscordRoles).toHaveBeenCalledOnce();
    expect(api.syncDiscordRoles).toHaveBeenCalledWith(expect.objectContaining({
      guildId,
      discordUserId,
      observedRoleIds: ['200000000000000002', '300000000000000003'],
      mappingVersion: 7,
      source: 'GUILD_MEMBER_UPDATE',
      observedAt
    }));
  });

  test('startup reconciliation fetches guild members, skips bots, and continues after one sync failure', async () => {
    const first = member({ id: '111111111111111111', roleIds: ['200000000000000002'] });
    const second = member({ id: '222222222222222222', roleIds: [] });
    const bot = member({ id: '333333333333333333', roleIds: ['300000000000000003'], bot: true });
    const fetchMembers = vi.fn().mockResolvedValue(new Map([
      [first.id, first], [second.id, second], [bot.id, bot]
    ]));
    const api = {
      syncDiscordRoles: vi.fn()
        .mockRejectedValueOnce(new Error('temporary API failure'))
        .mockResolvedValueOnce({ status: 'APPLIED' })
    };
    const onError = vi.fn();

    const result = await reconcileDiscordGuilds({
      guilds: new Map([[guildId, { id: guildId, members: { fetch: fetchMembers } }]]),
      api,
      mappingVersion: 7,
      now: () => new Date(observedAt),
      onError
    });

    expect(fetchMembers).toHaveBeenCalledOnce();
    expect(api.syncDiscordRoles).toHaveBeenCalledTimes(2);
    expect(api.syncDiscordRoles).toHaveBeenNthCalledWith(1, expect.objectContaining({
      discordUserId: first.id,
      source: 'STARTUP_RECONCILIATION'
    }));
    expect(api.syncDiscordRoles).toHaveBeenNthCalledWith(2, expect.objectContaining({
      discordUserId: second.id,
      observedRoleIds: [],
      source: 'STARTUP_RECONCILIATION'
    }));
    expect(onError).toHaveBeenCalledOnce();
    expect(result).toEqual({ guilds: 1, observedMembers: 2, syncedMembers: 1, failedMembers: 1 });
  });

  test('registers Sapphire ready and guildMemberUpdate listeners without local access policy', async () => {
    const manifest = await discoverSapphirePieces();
    const updateSource = await readFile('apps/bot/src/pieces/listeners/guild-member-update.ts', 'utf8');
    const readySource = await readFile('apps/bot/src/pieces/listeners/ready.ts', 'utf8');

    expect(manifest.pieces).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'listeners', name: 'guild-member-update' }),
      expect.objectContaining({ kind: 'listeners', name: 'ready' })
    ]));
    expect(updateSource).toContain('Events.GuildMemberUpdate');
    expect(updateSource).toContain('syncGuildMemberUpdate');
    expect(readySource).toContain("this.container.logger.info('Sapphire bot ready.')");
    expect(readySource).toContain('reconcileDiscordGuilds');
    expect(`${updateSource}\n${readySource}`).not.toMatch(/effectiveLevel|minimumLevel|approvedLevel|L1_SUPPORT|L2_SUPERVISOR|L3_MANAGER|L4_OWNER/);
  });
});
