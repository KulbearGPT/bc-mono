import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryOrderStore, type OrderRecord } from '@blackcat/api/orders';
import { InMemoryStaffTaskStore, type StaffTaskRecord } from '@blackcat/api/staff-tasks';
import { InMemorySupportWorkbenchStore } from '@blackcat/api/support-workbench';
import type { StaffDirectory } from '@blackcat/api/security';

const guildId = '999999999999999999';
const staffId = '00000000-0000-0000-0000-000000000111';
const discordUserId = '111111111111111111';
const orderId = '00000000-0000-0000-0000-000000001401';
const env = { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'token' };
const directory: StaffDirectory = { resolveByDiscord: () => ({ staffId, userId: '00000000-0000-0000-0000-000000000011', level: 'L1_SUPPORT', permissionsVersion: 1, status: 'ACTIVE' }) };
const headers = { authorization: 'Bearer token', 'x-client-source': 'DASHBOARD', 'x-actor-discord-user-id': discordUserId, 'x-actor-guild-id': guildId };

describe('M14-US-02 support task triage API', () => {
  test('returns server-projected pre-claim context and trusted Discord links on list and detail', async () => {
    const server = fixture([
      task({ id: '00000000-0000-0000-0000-000000002401', responseStatus: 'PENDING', responseDueAt: '2026-08-05T20:05:00.000Z' })
    ]);

    const list = await server.inject({ method: 'GET', url: '/api/v1/admin/staff-tasks', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.items[0]).toMatchObject({
      triage: {
        orderPublicId: 'P-M14-01', customerDisplayName: '测试客户', gameDisplayName: '无畏契约',
        serviceDisplayName: '娱乐陪玩', amountMinor: 12000, currency: 'CAT',
        reasonLabel: '客户请求订单协助', waitStartedAt: '2026-08-05T20:00:00.000Z', nextActionLabel: '认领并联系客户'
      },
      links: {
        orderChannel: `https://discord.com/channels/${guildId}/120000000000000001`,
        voiceChannel: `https://discord.com/channels/${guildId}/120000000000000003`
      }
    });

    const detail = await server.inject({ method: 'GET', url: '/api/v1/admin/staff-tasks/00000000-0000-0000-0000-000000002401', headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data).toMatchObject({ triage: { orderPublicId: 'P-M14-01' }, links: { orderChannel: expect.stringContaining(`/${guildId}/`) } });
    expect(detail.json().data.task).toBeUndefined();
  });

  test('orders overdue first, then pending by deadline, then remaining oldest with an id tie-breaker', async () => {
    const server = fixture([
      task({ id: '00000000-0000-0000-0000-000000002405', responseStatus: 'NOT_REQUIRED', createdAt: '2026-08-05T19:00:00.000Z' }),
      task({ id: '00000000-0000-0000-0000-000000002404', responseStatus: 'PENDING', responseDueAt: '2026-08-05T20:04:00.000Z' }),
      task({ id: '00000000-0000-0000-0000-000000002403', responseStatus: 'PENDING', responseDueAt: '2026-08-05T20:03:00.000Z' }),
      task({ id: '00000000-0000-0000-0000-000000002402', responseStatus: 'OVERDUE', responseDueAt: '2026-08-05T19:59:00.000Z' })
    ]);
    const response = await server.inject({ method: 'GET', url: '/api/v1/admin/staff-tasks', headers });
    expect(response.json().data.items.map((item: { id: string }) => item.id)).toEqual([
      '00000000-0000-0000-0000-000000002402',
      '00000000-0000-0000-0000-000000002403',
      '00000000-0000-0000-0000-000000002404',
      '00000000-0000-0000-0000-000000002405'
    ]);
  });

  test('never emits malformed links and hides a task carrying another Guild context', async () => {
    const server = fixture([
      task({ id: '00000000-0000-0000-0000-000000002406', orderId: null, contextSnapshot: { channelId: '120000000000000001' }, voiceChannelId: null }),
      task({ id: '00000000-0000-0000-0000-000000002407', contextSnapshot: { guildId: '888888888888888888', channelId: '120000000000000009' } })
    ]);
    const response = await server.inject({ method: 'GET', url: '/api/v1/admin/staff-tasks', headers });
    const body = response.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].links).toEqual({
      orderChannel: `https://discord.com/channels/${guildId}/120000000000000001`,
      voiceChannel: null
    });
    expect(JSON.stringify(body)).not.toContain('/channels//');
  });
});

function fixture(tasks: StaffTaskRecord[]) {
  const taskStore = new InMemoryStaffTaskStore({ tasks });
  const orders = new InMemoryOrderStore({ orders: [order()] });
  const workbench = new InMemorySupportWorkbenchStore({ tasks: taskStore, orders });
  return buildApiServer({ env, security: { staffDirectory: directory }, supportWorkbench: { store: workbench } });
}

function task(overrides: Partial<StaffTaskRecord>): StaffTaskRecord {
  return {
    id: '00000000-0000-0000-0000-000000002400', publicId: 'T-M14-01', type: 'ORDER_ASSIST', reasonCode: 'ORDER_ASSIST_REQUESTED',
    status: 'OPEN', version: 1, orderId, giftRequestId: null, claimedBy: null, requiredLevel: 'L1_SUPPORT', voiceChannelId: '120000000000000003',
    contextSnapshot: { guildId, channelId: '120000000000000001', voiceChannelId: '120000000000000003', customerDisplayName: '测试客户' },
    responseStatus: 'PENDING', responseDueAt: '2026-08-05T20:05:00.000Z', firstRespondedAt: null,
    createdAt: '2026-08-05T20:00:00.000Z', updatedAt: '2026-08-05T20:00:00.000Z', ...overrides
  };
}

function order(): OrderRecord {
  return {
    id: orderId, publicId: 'P-M14-01', customerId: '00000000-0000-0000-0000-000000003401', guildId,
    playerId: null, status: 'PENDING_DISPATCH', version: 2, serviceCatalogId: null, catalogVersion: null,
    game: 'VALORANT', gameDisplayName: '无畏契约', service: 'FUN', serviceDisplayName: '娱乐陪玩', region: 'NA',
    billingUnitMinutes: 60, unitCount: 2, customerUnitPriceMinor: 6000, playerUnitPayoutMinor: 4000,
    amountMinor: 12000, playerEarningMinor: 8000, currency: 'CAT', notes: null,
    channelSpec: { channelId: '120000000000000001', panelMessageId: '120000000000000002', voiceChannelId: '120000000000000003' },
    createdAt: '2026-08-05T19:55:00.000Z', updatedAt: '2026-08-05T20:00:00.000Z'
  };
}
