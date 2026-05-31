import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import {
  BotConfigCache,
  BotConfigFlow,
  BotConfigSessionStore,
  HttpBotConfigApiClient,
  parseBotConfigCustomId,
  reloadBotConfigCache,
  type BotConfigApiClient,
  type BotConfigSnapshot
} from '@blackcat/bot/bot-config';
import { discoverSapphirePieces } from '@blackcat/bot/piece-manifest';

const guildId = '999999999999999999';
const discordUserId = '111111111111111111';
const interactionId = '777777777777777777';
const actor = { guildId, discordUserId, interactionId, clientSource: 'DISCORD_BOT' as const };

const current: BotConfigSnapshot = {
  guildId,
  version: 12,
  values: {
    gift_broadcast_channel_id: '333333333333333333',
    player_role_id: '444444444444444444'
  },
  manageableFields: ['gift_broadcast_channel_id', 'player_role_id'],
  updatedByStaffId: null,
  updatedAt: '2026-07-18T12:00:00.000Z'
};

function configApi(overrides: Partial<BotConfigApiClient> = {}): BotConfigApiClient {
  return {
    getBotConfig: vi.fn().mockResolvedValue(current),
    validateBotConfigChange: vi.fn().mockResolvedValue({
      guildId,
      currentVersion: 12,
      normalizedChanges: { gift_broadcast_channel_id: '555555555555555555' },
      warnings: [],
      errors: [],
      mayApply: true,
      requiredPermissions: ['bot_config.operational.manage'],
      validationToken: 'validation-token-that-never-enters-a-custom-id',
      validationExpiresAt: '2026-07-18T12:05:00.000Z'
    }),
    updateBotConfig: vi.fn().mockResolvedValue({
      guildId,
      previousVersion: 12,
      version: 13,
      auditEventId: '00000000-0000-0000-0000-00000000a013',
      updatedAt: '2026-07-18T12:01:00.000Z'
    }),
    testBotConfigDelivery: vi.fn().mockResolvedValue({
      guildId,
      version: 12,
      channelField: 'gift_broadcast_channel_id',
      channelId: '555555555555555555',
      delivered: true,
      messageId: '666666666666666666',
      testedAt: '2026-07-18T12:00:30.000Z'
    }),
    ...overrides
  };
}

function customIds(reply: { components: Array<{ components: Array<{ customId: string }> }> }) {
  return reply.components.flatMap((row) => row.components.map((component) => component.customId));
}

describe('M4-US-10 Discord /bot-config adapter', () => {
  test('uses the four OpenAPI operations with trusted actor headers and idempotency', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: current }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { mayApply: true } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { version: 13 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { delivered: true } }) });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBotConfigApiClient({ apiBaseUrl: 'https://api.example.test/', botServiceToken: 'bot-token' });
    const change = { guildId, expectedVersion: 12, changes: { gift_broadcast_channel_id: '555555555555555555' }, reason: 'Discord Bot configuration update.' };

    await client.getBotConfig(guildId, actor);
    await client.validateBotConfigChange(change, actor, 'discord:bot-config:validate:one');
    await client.updateBotConfig({ ...change, validationToken: 'token-value' }, actor, 'discord:bot-config:update:one');
    await client.testBotConfigDelivery({ guildId, expectedVersion: 12, channelField: 'gift_broadcast_channel_id', channelId: '555555555555555555', reason: 'Discord Bot delivery test.' }, actor, 'discord:bot-config:test:one');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://api.example.test/api/v1/admin/bot-config?guildId=${guildId}`,
      'https://api.example.test/api/v1/admin/bot-config/validate',
      'https://api.example.test/api/v1/admin/bot-config',
      'https://api.example.test/api/v1/admin/bot-config/test-delivery'
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'POST', 'PATCH', 'POST']);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).toMatchObject({
        authorization: 'Bearer bot-token',
        'x-client-source': 'DISCORD_BOT',
        'x-actor-discord-user-id': discordUserId,
        'x-actor-guild-id': guildId,
        'x-discord-interaction-id': interactionId
      });
    }
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ 'idempotency-key': 'discord:bot-config:validate:one' });
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({ 'idempotency-key': 'discord:bot-config:update:one' });
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toMatchObject({ 'idempotency-key': 'discord:bot-config:test:one' });
  });

  test('opens a private field picker and transitions to native Channel and Role Select components', async () => {
    const flow = new BotConfigFlow({ api: configApi(), cache: new BotConfigCache(), sessions: new BotConfigSessionStore({ idFactory: () => 'abc123XYZ0' }) });

    const opened = await flow.open(actor);
    expect(opened.ephemeral).toBe(true);
    expect(opened.content).toContain('版本 12');
    expect(opened.components[0]?.components[0]).toMatchObject({
      type: 'STRING_SELECT',
      customId: 'bc:cfg:field:abc123XYZ0',
      options: [{ label: '礼物播报频道', value: 'gift_broadcast_channel_id' }]
    });
    expect(opened.components[1]?.components[0]).toMatchObject({
      type: 'STRING_SELECT',
      placeholder: '选择权限角色映射',
      options: [{ label: '陪玩角色', value: 'player_role_id' }]
    });

    const channel = flow.chooseField(actor, 'abc123XYZ0', 'gift_broadcast_channel_id');
    expect(channel.ephemeral).toBe(true);
    expect(channel.content).toContain('Bot 配置 · 礼物播报频道');
    expect(channel.components[0]?.components[0]).toMatchObject({ type: 'CHANNEL_SELECT', customId: 'bc:cfg:value:abc123XYZ0' });

    const role = flow.chooseField(actor, 'abc123XYZ0', 'player_role_id');
    expect(role.content).toContain('Bot 配置 · 陪玩角色');
    expect(role.components[0]?.components[0]).toMatchObject({ type: 'ROLE_SELECT', customId: 'bc:cfg:value:abc123XYZ0' });
  });

  test('supports timeout, template and feature-toggle fields without exceeding Discord select limits', async () => {
    const scalarSnapshot={...current,manageableFields:[
      'gift_broadcast_channel_id','dispatch_timeout_minutes','gift_broadcast_template','auto_dispatch_enabled',
      'player_role_id','staff_l1_role_id','staff_l2_role_id','staff_l3_role_id','staff_l4_role_id'
    ]};
    const api=configApi({getBotConfig:vi.fn().mockResolvedValue(scalarSnapshot)});
    const flow=new BotConfigFlow({api,cache:new BotConfigCache(),sessions:new BotConfigSessionStore({idFactory:()=> 'abc123XYZ0'})});
    const opened=await flow.open(actor);
    expect(opened.components).toHaveLength(2);
    expect(opened.components.every((row)=>row.components.every((component)=>component.type!=='STRING_SELECT'||component.options.length<=25))).toBe(true);
    expect(flow.chooseField(actor,'abc123XYZ0','auto_dispatch_enabled').components[0]?.components[0]).toMatchObject({type:'STRING_SELECT'});
    expect(flow.chooseField(actor,'abc123XYZ0','dispatch_timeout_minutes').components[0]?.components[0]).toMatchObject({type:'BUTTON',customId:'bc:cfg:input:abc123XYZ0'});
    const preview=await flow.previewTextInput(actor,'abc123XYZ0','10','discord:bot-config:validate:scalar');
    expect(api.validateBotConfigChange).toHaveBeenCalledWith(expect.objectContaining({changes:{dispatch_timeout_minutes:10}}),actor,'discord:bot-config:validate:scalar');
    expect(preview.ephemeral).toBe(true);
  });

  test('validates a Channel Select value, previews it, then confirms with the API token', async () => {
    const api = configApi();
    const cache = new BotConfigCache();
    const sessions = new BotConfigSessionStore({ idFactory: () => 'abc123XYZ0' });
    const flow = new BotConfigFlow({ api, cache, sessions });
    await flow.open(actor);
    flow.chooseField(actor, 'abc123XYZ0', 'gift_broadcast_channel_id');

    const preview = await flow.previewValue(actor, 'abc123XYZ0', '555555555555555555', 'discord:bot-config:validate:777');
    expect(api.validateBotConfigChange).toHaveBeenCalledWith({
      guildId,
      expectedVersion: 12,
      changes: { gift_broadcast_channel_id: '555555555555555555' },
      reason: 'Discord /bot-config update: gift_broadcast_channel_id'
    }, actor, 'discord:bot-config:validate:777');
    expect(preview.ephemeral).toBe(true);
    expect(preview.content).toContain('<#333333333333333333>');
    expect(preview.content).toContain('<#555555555555555555>');
    expect(customIds(preview)).toEqual([
      'bc:cfg:test:abc123XYZ0',
      'bc:cfg:confirm:abc123XYZ0',
      'bc:cfg:cancel:abc123XYZ0'
    ]);

    const refreshed = { ...current, version: 13, values: { ...current.values, gift_broadcast_channel_id: '555555555555555555' } };
    vi.mocked(api.getBotConfig).mockResolvedValueOnce(refreshed);
    const saved = await flow.confirm(actor, 'abc123XYZ0', 'discord:bot-config:update:777');
    expect(api.updateBotConfig).toHaveBeenCalledWith(expect.objectContaining({
      guildId,
      expectedVersion: 12,
      changes: { gift_broadcast_channel_id: '555555555555555555' },
      validationToken: 'validation-token-that-never-enters-a-custom-id'
    }), actor, 'discord:bot-config:update:777');
    expect(api.getBotConfig).toHaveBeenLastCalledWith(guildId, actor);
    expect(cache.get(guildId)).toEqual(refreshed);
    expect(saved.ephemeral).toBe(true);
    expect(saved.content).toContain('版本 13');
  });

  test('tests proposed channel delivery without applying the pending change', async () => {
    const api = configApi();
    const flow = new BotConfigFlow({ api, cache: new BotConfigCache(), sessions: new BotConfigSessionStore({ idFactory: () => 'abc123XYZ0' }) });
    await flow.open(actor);
    flow.chooseField(actor, 'abc123XYZ0', 'gift_broadcast_channel_id');
    await flow.previewValue(actor, 'abc123XYZ0', '555555555555555555', 'discord:bot-config:validate:777');

    const result = await flow.testDelivery(actor, 'abc123XYZ0', 'discord:bot-config:test:777');
    expect(api.testBotConfigDelivery).toHaveBeenCalledWith({
      guildId,
      expectedVersion: 12,
      channelField: 'gift_broadcast_channel_id',
      channelId: '555555555555555555',
      reason: 'Discord /bot-config delivery test: gift_broadcast_channel_id'
    }, actor, 'discord:bot-config:test:777');
    expect(api.updateBotConfig).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ephemeral: true });
    expect(result.content).toContain('测试消息已送达');
  });

  test('keeps full config, permissions and validation token out of short custom IDs and rejects another actor', async () => {
    const sessions = new BotConfigSessionStore({ idFactory: () => 'abc123XYZ0' });
    const flow = new BotConfigFlow({ api: configApi(), cache: new BotConfigCache(), sessions });
    const opened = await flow.open(actor);
    const ids = customIds(opened);

    expect(ids.every((id) => /^bc:cfg:[a-z-]+:[A-Za-z0-9_-]{8,16}$/u.test(id))).toBe(true);
    expect(ids.join('|')).not.toMatch(/gift_broadcast|player_role|permission|validation-token|333333333333333333/iu);
    expect(parseBotConfigCustomId('bc:cfg:confirm:abc123XYZ0')).toEqual({ operation: 'confirm', sessionId: 'abc123XYZ0' });
    const stored = (sessions as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions.get('abc123XYZ0');
    expect(stored).toEqual(expect.objectContaining({ guildId, discordUserId, version: 12 }));
    expect(stored).not.toHaveProperty('snapshot');
    expect(stored).not.toHaveProperty('manageableFields');
    expect(JSON.stringify(stored)).not.toContain('333333333333333333');
    expect(() => flow.chooseField({ ...actor, discordUserId: '222222222222222222' }, 'abc123XYZ0', 'gift_broadcast_channel_id')).toThrow(/session/i);
  });

  test('cold reload fetches current Guild config from API instead of relying on old memory', async () => {
    const api = configApi();
    const freshCache = new BotConfigCache();
    await reloadBotConfigCache({
      api,
      cache: freshCache,
      guildIds: [guildId],
      actorForGuild: (id) => ({ guildId: id, clientSource: 'DISCORD_BOT' })
    });

    expect(api.getBotConfig).toHaveBeenCalledWith(guildId, { guildId, clientSource: 'DISCORD_BOT' });
    expect(freshCache.get(guildId)).toEqual(current);
  });

  test('exports the module and discovers the Guild command, component handlers, and ready reload path', async () => {
    const manifest = await discoverSapphirePieces();
    const packageJson = JSON.parse(await readFile('apps/bot/package.json', 'utf8'));
    const commandSource = await readFile('apps/bot/src/pieces/commands/bot-config.ts', 'utf8');
    const selectSource = await readFile('apps/bot/src/pieces/interaction-handlers/bot-config-selects.ts', 'utf8');
    const buttonSource = await readFile('apps/bot/src/pieces/interaction-handlers/bot-config-buttons.ts', 'utf8');
    const modalSource = await readFile('apps/bot/src/pieces/interaction-handlers/bot-config-modals.ts', 'utf8');
    const readySource = await readFile('apps/bot/src/pieces/listeners/ready.ts', 'utf8');

    expect(packageJson.exports['./bot-config']).toBe('./src/bot-config.ts');
    expect(manifest.pieces).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'commands', name: 'bot-config' }),
      expect.objectContaining({ kind: 'interaction-handlers', name: 'bot-config-selects' }),
      expect.objectContaining({ kind: 'interaction-handlers', name: 'bot-config-buttons' }),
      expect.objectContaining({ kind: 'interaction-handlers', name: 'bot-config-modals' })
    ]));
    expect(commandSource).toContain("setName('bot-config')");
    expect(commandSource).toContain('interaction.guildId');
    expect(selectSource).toMatch(/isChannelSelectMenu\(\)|isRoleSelectMenu\(\)/u);
    expect(`${commandSource}\n${selectSource}\n${buttonSource}`).not.toMatch(/setDefaultMemberPermissions|L3_OPERATIONS|L4_ADMIN_OWNER/u);
    expect(`${commandSource}\n${selectSource}\n${buttonSource}`).not.toMatch(/ephemeral:\s*false/u);
    expect(commandSource.indexOf('deferReply')).toBeLessThan(commandSource.indexOf('botConfigFlow.open'));
    expect(selectSource.indexOf('deferUpdate')).toBeLessThan(selectSource.indexOf('previewValue'));
    expect(buttonSource).toContain('deferUpdate');
    expect(modalSource.indexOf('deferReply')).toBeLessThan(modalSource.indexOf('previewTextInput'));
    expect(readySource).toContain('reloadBotConfigCache');
  });
});
