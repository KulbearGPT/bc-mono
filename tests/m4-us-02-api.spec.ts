import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryStaffTaskStore, type StaffTaskRecord } from '@blackcat/api/staff-tasks';
import { InMemoryOrderStore, type OrderRecord } from '@blackcat/api/orders';
import { InMemorySupportWorkbenchStore } from '@blackcat/api/support-workbench';
import type { StaffDirectory } from '@blackcat/api/security';

const env = { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'token' };
const guildId = '999999999999999999';
const l1DiscordId = '111111111111111111';
const otherDiscordId = '222222222222222222';
const l1StaffId = '00000000-0000-0000-0000-000000000111';
const otherStaffId = '00000000-0000-0000-0000-000000000222';
const orderId = '00000000-0000-0000-0000-000000001001';

const directory: StaffDirectory = {
  resolveByDiscord({ discordUserId }) {
    if (discordUserId === l1DiscordId) return { staffId: l1StaffId, userId: '00000000-0000-0000-0000-000000000011', level: 'L1_SUPPORT', permissionsVersion: 1, status: 'ACTIVE' };
    if (discordUserId === otherDiscordId) return { staffId: otherStaffId, userId: '00000000-0000-0000-0000-000000000022', level: 'L1_SUPPORT', permissionsVersion: 1, status: 'ACTIVE' };
    return null;
  }
};

function headers(discordUserId = l1DiscordId, key = 'dashboard:support:read') {
  return { authorization: 'Bearer token', 'x-client-source': 'DASHBOARD', 'x-actor-discord-user-id': discordUserId,
    'x-actor-guild-id': guildId, 'idempotency-key': key };
}

function fixture() {
  const tasks = new InMemoryStaffTaskStore({ tasks: [
    task({ id: '00000000-0000-0000-0000-000000002001', status: 'OPEN', claimedBy: null }),
    task({ id: '00000000-0000-0000-0000-000000002002', status: 'CLAIMED', claimedBy: l1StaffId }),
    task({ id: '00000000-0000-0000-0000-000000002003', status: 'CLAIMED', claimedBy: otherStaffId })
  ] });
  const orders = new InMemoryOrderStore({ orders: [order()] });
  const workbench = new InMemorySupportWorkbenchStore({ tasks, orders });
  const server = buildApiServer({ env, security: { staffDirectory: directory }, supportWorkbench: { store: workbench } });
  return { server, tasks, workbench };
}

describe('M4-US-02 L1 support workbench API', () => {
  test('lists open and personally claimed tasks but hides another L1 task', async () => {
    const { server } = fixture();
    const response = await server.inject({ method: 'GET', url: '/api/v1/admin/staff-tasks', headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items.map((item: { id: string }) => item.id)).toEqual([
      '00000000-0000-0000-0000-000000002001',
      '00000000-0000-0000-0000-000000002002'
    ]);
  });

  test('requires L1 to claim a task before opening full order context', async () => {
    const { server } = fixture();
    const denied = await server.inject({ method: 'GET', url: `/api/v1/admin/orders/${orderId}`, headers: headers() });
    expect(denied.statusCode).toBe(403);

    const own = await server.inject({ method: 'GET', url: '/api/v1/admin/staff-tasks/00000000-0000-0000-0000-000000002002', headers: headers() });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ data: { task: { claimedBy: l1StaffId }, links: {
      orderChannel: `https://discord.com/channels/${guildId}/120000000000000001`,
      voiceChannel: `https://discord.com/channels/${guildId}/120000000000000003`
    } } });

    const orderResponse = await server.inject({ method: 'GET', url: `/api/v1/admin/orders/${orderId}?taskId=00000000-0000-0000-0000-000000002002`, headers: headers() });
    expect(orderResponse.statusCode).toBe(200);
    expect(orderResponse.json()).toMatchObject({ data: { order: { status: 'ACCEPTED' }, matching: { stage: 'ACCEPTED' }, readiness: { bothReady: false }, automation: { state: 'RUNNING' } } });
  });

  test('lets L1 append a note and escalate only a personally claimed task', async () => {
    const { server, workbench } = fixture();
    const note = await server.inject({ method: 'POST', url: '/api/v1/admin/staff-tasks/00000000-0000-0000-0000-000000002002/notes',
      headers: headers(l1DiscordId, 'dashboard:support:note:0001'), payload: { body: '已联系用户，等待主管确认取消方案。' } });
    expect(note.statusCode).toBe(201);
    expect(workbench.notes).toEqual([expect.objectContaining({ authorStaffId: l1StaffId })]);

    const escalated = await server.inject({ method: 'POST', url: '/api/v1/admin/staff-tasks/00000000-0000-0000-0000-000000002002/escalate',
      headers: headers(l1DiscordId, 'dashboard:support:escalate:01'), payload: { expectedVersion: 1, reasonCode: 'SUPERVISOR_REVIEW', note: '需要主管决定退款影响。' } });
    expect(escalated.statusCode).toBe(202);
    expect(escalated.json()).toMatchObject({ data: { task: { status: 'PENDING_APPROVAL', version: 2 }, requiredLevel: 'L2_SUPERVISOR' } });

    const denied = await server.inject({ method: 'POST', url: '/api/v1/admin/staff-tasks/00000000-0000-0000-0000-000000002003/notes',
      headers: headers(l1DiscordId, 'dashboard:support:note:deny01'), payload: { body: '不应写入' } });
    expect(denied.statusCode).toBe(403);
  });
});

function task(overrides: Partial<StaffTaskRecord>): StaffTaskRecord {
  return { id: 'task', publicId: 'T-1001', type: 'CANCELLATION_ASSIST', reasonCode: 'CUSTOMER_CANCEL_AFTER_ACCEPT', status: 'OPEN',
    version: 1, orderId, giftRequestId: null, claimedBy: null, requiredLevel: 'L1_SUPPORT', voiceChannelId: '120000000000000003',
    contextSnapshot: { guildId, channelId: '120000000000000001', voiceChannelId: '120000000000000003', customerDisplay: '用户 A', playerDisplay: '陪玩 B' },
    createdAt: '2026-07-18T01:00:00.000Z', updatedAt: '2026-07-18T01:00:00.000Z', ...overrides };
}

function order(): OrderRecord {
  return { id: orderId, publicId: 'P-1001', customerId: '00000000-0000-0000-0000-000000003001', playerId: '00000000-0000-0000-0000-000000003002',
    status: 'ACCEPTED', version: 4, orderType: 'IMMEDIATE', serviceCatalogId: null, catalogVersion: null, unitCount: 2, billingUnitMinutes: 60,
    customerUnitPriceMinor: 6000, playerUnitPayoutMinor: 4000, currency: 'CNY', amountMinor: 12000, playerEarningMinor: 8000,
    game: 'VALORANT', service: '娱乐陪玩', region: 'NA', language: '中文', scheduledStartAt: null, notes: null,
    channelSpec: { channelId: '120000000000000001', panelMessageId: '120000000000000002', voiceChannelId: '120000000000000003' },
    automationState: 'RUNNING', automationVersion: 1, automationScope: null, automationPausedByStaffId: null, automationStaffTaskId: null,
    automationReasonCode: null, automationPausedAt: null, automationResumedAt: null, automationExpiresAt: null,
    customerReadyAt: null, playerReadyAt: null, readyDeadlineAt: '2026-07-18T02:00:00.000Z', startedAt: null, completionRequestedAt: null,
    completedAt: null, cancelledAt: null, createdAt: '2026-07-18T01:00:00.000Z', updatedAt: '2026-07-18T01:10:00.000Z' };
}
