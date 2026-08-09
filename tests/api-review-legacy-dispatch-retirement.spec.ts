import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryBotConfigStore, type BotConfigDiscordAdapter } from '@blackcat/api/bot-config';
import { InMemoryOperationsStore } from '@blackcat/api/operations';

const guildId = '900000000000009000';
const now = new Date('2026-08-13T10:00:00.000Z');
const read = (path: string) => readFileSync(path, 'utf8');

describe('API review legacy automatic dispatch retirement', () => {
  test('does not expose or accept retired Bot configuration fields', async () => {
    const store = new InMemoryBotConfigStore({
      snapshots: [{
        guildId,
        version: 1,
        values: {
          dispatch_channel_id: '900000000000009100',
          dispatch_timeout_minutes: 5,
          dispatch_max_rounds: 3,
          auto_dispatch_enabled: true,
          new_orders_enabled: true
        },
        updatedByStaffId: '00000000-0000-0000-0000-000000009001',
        updatedAt: now.toISOString()
      }]
    });
    const server = buildApiServer({
      env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
      security: {
        staffDirectory: { resolveByDiscord: () => ({
          staffId: '00000000-0000-0000-0000-000000009001',
          userId: '00000000-0000-0000-0000-000000009002',
          level: 'L3_OPERATIONS' as const,
          permissionsVersion: 1,
          status: 'ACTIVE' as const
        }) }
      },
      botConfig: {
        store,
        discord: noDiscord,
        validationSecret: 'legacy-dispatch-retirement-secret-32-bytes',
        now: () => now
      }
    });

    const current = await server.inject({ method: 'GET', url: `/api/v1/admin/bot-config?guildId=${guildId}`, headers: headers() });
    expect(current.statusCode).toBe(200);
    expect(current.json().data.values).not.toHaveProperty('dispatch_timeout_minutes');
    expect(current.json().data.values).not.toHaveProperty('dispatch_max_rounds');
    expect(current.json().data.values).not.toHaveProperty('auto_dispatch_enabled');
    expect(current.json().data.manageableFields).not.toEqual(expect.arrayContaining([
      'dispatch_timeout_minutes', 'dispatch_max_rounds', 'auto_dispatch_enabled'
    ]));

    for (const [field, value] of [
      ['dispatch_timeout_minutes', 5],
      ['dispatch_max_rounds', 3],
      ['auto_dispatch_enabled', true]
    ] as const) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/admin/bot-config/validate',
        headers: { ...headers(), 'idempotency-key': `retired:${field}` },
        payload: { guildId, expectedVersion: 1, changes: { [field]: value }, reason: 'Retired field check.' }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    await server.close();
  });

  test('does not list or update the retired dispatch timeout policy', () => {
    const store = new InMemoryOperationsStore({ settings: [
      { key: 'DISPATCH_TIMEOUT_MINUTES', integerValue: 5, currency: null, version: 1 },
      { key: 'PLAYER_START_GRACE_MINUTES', integerValue: 10, currency: null, version: 1 }
    ] });
    expect(store.getPolicySettings().map((item) => item.key)).toEqual(['PLAYER_START_GRACE_MINUTES']);
    expect(() => store.updatePolicySetting({
      key: 'DISPATCH_TIMEOUT_MINUTES', expectedVersion: 1, integerValue: 7, currency: null,
      actorStaffId: '00000000-0000-0000-0000-000000009001', now
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  test('does not initialize legacy first-wins dispatch in the production API composition', () => {
    const index = read('apps/api/src/index.ts');
    const server = read('apps/api/src/server.ts');
    expect(index).not.toMatch(/PostgresDispatchStore|PostgresDispatchPlayerPool|dispatchStore|dispatchPlayerPool/);
    expect(server).not.toMatch(/dispatch\?:\s*\{|DispatchStore|DispatchPlayerPool/);
  });

  test('removes retired keys from current API and business configuration contracts', () => {
    const sources = [
      'outputs/P0开发交付包/02-API/openapi.yaml',
      'outputs/P0开发交付包/05-业务配置/business-config.example.yaml',
      'outputs/P0开发交付包/05-业务配置/business-config.schema.json',
      'outputs/P0开发交付包/05-业务配置/seed-data.csv',
      'outputs/P0开发交付包/05-业务配置/业务配置说明.html'
    ].map(read).join('\n');
    expect(sources).not.toMatch(/dispatch_timeout_minutes|dispatch_max_rounds|auto_dispatch_enabled|DISPATCH_TIMEOUT_MINUTES/);
  });
});

const noDiscord: BotConfigDiscordAdapter = {
  validateObject: async () => ({ ok: true }),
  sendTestMessage: async () => ({ messageId: '900000000000009999' })
};

function headers() {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-guild-id': guildId,
    'x-actor-discord-user-id': '900000000000009001',
    'x-discord-interaction-id': '900000000000009002'
  };
}
