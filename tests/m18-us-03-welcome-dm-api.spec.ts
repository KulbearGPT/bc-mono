import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryBotConfigStore, type BotConfigDiscordAdapter, type BotConfigSnapshot } from '@blackcat/api/bot-config';
import { InMemoryAuditSink, type StaffAccount } from '@blackcat/api/security';

const guildId = '900000000000001000';
const entryChannelId = '900000000000001100';
const targetDiscordUserId = '900000000000001200';
const now = new Date('2026-08-09T20:00:00.000Z');
const accounts: Record<string, StaffAccount> = {
  l1: {
    staffId: '00000000-0000-0000-0000-000000018001',
    userId: '00000000-0000-0000-0000-000000018011',
    level: 'L1_SUPPORT',
    permissionsVersion: 1,
    status: 'ACTIVE'
  },
  l2: {
    staffId: '00000000-0000-0000-0000-000000018002',
    userId: '00000000-0000-0000-0000-000000018012',
    level: 'L2_SUPERVISOR',
    permissionsVersion: 1,
    status: 'ACTIVE'
  }
};

const snapshot: BotConfigSnapshot = {
  guildId,
  version: 1,
  values: { public_entry_channel_id: entryChannelId },
  updatedByStaffId: accounts.l2.staffId,
  updatedAt: now.toISOString()
};

const discord: BotConfigDiscordAdapter = {
  validateObject: async () => ({ ok: true as const }),
  sendTestMessage: async () => ({ messageId: '900000000000001999' })
};

function fixture() {
  const audit = new InMemoryAuditSink();
  const server = buildApiServer({
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: '',
      API_PORT: '0',
      API_BASE_URL: 'http://localhost:3000',
      BOT_SERVICE_TOKEN: 'valid-bot-token'
    },
    security: {
      staffDirectory: {
        resolveByDiscord: ({ discordUserId }: { discordUserId: string }) => accounts[discordUserId] ?? null
      },
      auditSink: audit
    },
    botConfig: {
      store: new InMemoryBotConfigStore({ snapshots: [snapshot] }),
      discord,
      validationSecret: 'test-validation-secret-at-least-32-bytes',
      now: () => now
    }
  });
  return { server, audit };
}

function headers(actor: keyof typeof accounts) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': actor,
    'x-actor-guild-id': guildId,
    'x-discord-interaction-id': `90000000000000900${actor === 'l1' ? '1' : '2'}`
  };
}

describe('M18-US-03 /welcome least-privilege authorization API', () => {
  test('AT-EXP-006 allows L2 and returns only safe welcome navigation context', async () => {
    const { server, audit } = fixture();
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/bot/welcome-dm/context?guildId=${guildId}&targetDiscordUserId=${targetDiscordUserId}`,
      headers: headers('l2')
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ guildId, publicEntryChannelId: entryChannelId });
    expect(JSON.stringify(response.json().data)).not.toContain('manageableFields');
    expect(JSON.stringify(response.json().data)).not.toContain('values');
    expect(audit.records.at(-1)).toMatchObject({
      permissionCode: 'welcome_dm.send',
      action: 'AUTHORIZE_WELCOME_DM_SEND',
      targetType: 'discord_user',
      targetId: targetDiscordUserId,
      outcome: 'SUCCEEDED'
    });
  });

  test('AT-EXP-006 rejects L1 without exposing Bot configuration', async () => {
    const { server, audit } = fixture();
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/bot/welcome-dm/context?guildId=${guildId}&targetDiscordUserId=${targetDiscordUserId}`,
      headers: headers('l1')
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('PERMISSION_DENIED');
    expect(audit.records.at(-1)).toMatchObject({
      permissionCode: 'welcome_dm.send',
      targetId: targetDiscordUserId,
      outcome: 'REJECTED',
      reason: 'PERMISSION_DENIED'
    });
  });

  test('AT-EXP-006 rejects service-only and cross-Guild authorization attempts', async () => {
    const { server, audit } = fixture();
    const serviceOnly = await server.inject({
      method: 'GET',
      url: `/api/v1/bot/welcome-dm/context?guildId=${guildId}&targetDiscordUserId=${targetDiscordUserId}`,
      headers: {
        authorization: 'Bearer valid-bot-token',
        'x-client-source': 'DISCORD_BOT'
      }
    });

    expect(serviceOnly.statusCode).toBe(401);
    expect(audit.records.at(-1)).toMatchObject({
      permissionCode: 'welcome_dm.send',
      outcome: 'REJECTED'
    });

    const crossGuild = await server.inject({
      method: 'GET',
      url: `/api/v1/bot/welcome-dm/context?guildId=900000000000009999&targetDiscordUserId=${targetDiscordUserId}`,
      headers: headers('l2')
    });

    expect(crossGuild.statusCode).toBe(403);
    expect(audit.records.at(-1)).toMatchObject({
      permissionCode: 'welcome_dm.send',
      targetId: targetDiscordUserId,
      outcome: 'FAILED'
    });
  });
});
