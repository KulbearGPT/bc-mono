import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryApprovalStore, type ApprovalRecord } from '@blackcat/api/approvals';
import { InMemoryDashboardAuthStore } from '@blackcat/api/dashboard-auth';
import {
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
  type StaffAccount,
  type StaffDirectory
} from '@blackcat/api/security';

const now = new Date('2026-08-12T20:00:00.000Z');
const guildId = '900000000000000001';
const otherGuildId = '900000000000000002';
const staffId = '00000000-0000-0000-0000-000000000301';
const staffUserId = '00000000-0000-0000-0000-000000000302';
const approvalId = '00000000-0000-0000-0000-000000000401';
const targetId = '00000000-0000-0000-0000-000000000402';

describe('API review approval runtime', () => {
  test('lists only same-Guild approvals visible to the actor', async () => {
    const fixture = await approvalFixture('L2_SUPERVISOR');
    const response = await fixture.server.inject({
      method: 'GET',
      url: '/api/v1/admin/approval-requests?status=PENDING',
      headers: fixture.headers()
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items.map((item: ApprovalRecord) => item.id)).toContain(approvalId);
    expect(response.json().data.items.map((item: ApprovalRecord) => item.id)).not.toContain(
      '00000000-0000-0000-0000-000000000410'
    );
    expect(response.json().data.items[0]).not.toHaveProperty('guildId');
    expect(response.json().data.items[0]).not.toHaveProperty('payloadSnapshot');
  });

  test('approves a trusted request idempotently and links the success audit', async () => {
    const fixture = await approvalFixture('L3_OPERATIONS');
    const response = await fixture.server.inject({
      method: 'POST',
      url: `/api/v1/admin/approval-requests/${approvalId}/approve`,
      headers: fixture.headers('approval:runtime:approve'),
      payload: {
        expectedVersion: 1,
        confirmation: 'CONFIRM_REVIEWED_IMPACT',
        reasonCode: 'IMPACT_REVIEWED',
        note: 'Order and refund facts rechecked.'
      }
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        approvalRequestId: approvalId,
        status: 'APPROVED',
        actionExecuted: true,
        resultType: 'REFUND',
        resultId: targetId
      }
    });
    expect(fixture.store.records.find((item) => item.id === approvalId)).toMatchObject({
      status: 'APPROVED',
      version: 2
    });
    expect(fixture.audit.records.at(-1)).toMatchObject({
      approvalRequestId: approvalId,
      permissionCode: 'approval.approve'
    });

    const replay = await fixture.server.inject({
      method: 'POST',
      url: `/api/v1/admin/approval-requests/${approvalId}/approve`,
      headers: fixture.headers('approval:runtime:approve'),
      payload: {
        expectedVersion: 1,
        confirmation: 'CONFIRM_REVIEWED_IMPACT',
        reasonCode: 'IMPACT_REVIEWED',
        note: 'Order and refund facts rechecked.'
      }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['x-idempotency-replayed']).toBe('true');
    expect(fixture.store.executions).toHaveLength(1);
  });

  test('fails closed for stale, expired, cross-Guild, and reserved actions', async () => {
    const fixture = await approvalFixture('L4_ADMIN_OWNER');
    for (const id of [
      '00000000-0000-0000-0000-000000000411',
      '00000000-0000-0000-0000-000000000412',
      '00000000-0000-0000-0000-000000000413'
    ]) {
      const response = await fixture.server.inject({
        method: 'POST',
        url: `/api/v1/admin/approval-requests/${id}/approve`,
        headers: fixture.headers(`approval:runtime:${id.slice(-3)}`),
        payload: { expectedVersion: 1, confirmation: 'CONFIRM_REVIEWED_IMPACT', reasonCode: 'IMPACT_REVIEWED' }
      });
      expect([404, 409, 422]).toContain(response.statusCode);
    }
    expect(fixture.store.executions).toHaveLength(0);
  });

  test('supports the Dashboard session actor path without trusting client-reported staff facts', async () => {
    const fixture = await approvalFixture('L2_SUPERVISOR', 'L2_SUPERVISOR');
    const response = await fixture.server.inject({
      method: 'POST',
      url: `/api/v1/admin/approval-requests/${approvalId}/approve`,
      headers: fixture.dashboardHeaders('approval:runtime:dashboard'),
      payload: { expectedVersion: 1, confirmation: 'CONFIRM_REVIEWED_IMPACT', reasonCode: 'IMPACT_REVIEWED' }
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    expect(response.json().data).toMatchObject({ approvalRequestId: approvalId, status: 'APPROVED' });
  });

  test('signs and binds pagination cursors to the Guild, level, and status filter', async () => {
    const fixture = await approvalFixture('L3_OPERATIONS');
    const first = await fixture.server.inject({
      method: 'GET',
      url: '/api/v1/admin/approval-requests?status=PENDING&limit=1',
      headers: fixture.headers()
    });
    expect(first.statusCode).toBe(200);
    const cursor = first.json().data.nextCursor as string;
    expect(cursor).toMatch(/^c1_/u);

    const rebound = await fixture.server.inject({
      method: 'GET',
      url: `/api/v1/admin/approval-requests?status=APPROVED&limit=1&cursor=${encodeURIComponent(cursor)}`,
      headers: fixture.headers()
    });
    expect(rebound.statusCode).toBe(400);
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
    const forged = await fixture.server.inject({
      method: 'GET',
      url: `/api/v1/admin/approval-requests?status=PENDING&limit=1&cursor=${encodeURIComponent(tampered)}`,
      headers: fixture.headers()
    });
    expect(forged.statusCode).toBe(400);
  });

  test('rejects a supported request idempotently without executing its action', async () => {
    const fixture = await approvalFixture('L3_OPERATIONS');
    const response = await fixture.server.inject({
      method: 'POST',
      url: `/api/v1/admin/approval-requests/${approvalId}/reject`,
      headers: fixture.headers('approval:runtime:reject'),
      payload: {
        expectedVersion: 1,
        confirmation: 'CONFIRM_REVIEWED_IMPACT',
        reasonCode: 'REQUEST_REJECTED',
        note: 'Impact review failed.'
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ id: approvalId, status: 'REJECTED', version: 2 });
    expect(response.json().data).not.toHaveProperty('payloadSnapshot');
    expect(fixture.store.executions).toHaveLength(0);
    expect(fixture.audit.records.at(-1)).toMatchObject({
      approvalRequestId: approvalId,
      permissionCode: 'approval.reject'
    });
  });
});

async function approvalFixture(level: StaffAccount['level'], requiredLevel: StaffAccount['level'] = 'L3_OPERATIONS') {
  const auth = new InMemoryDashboardAuthStore();
  const audit = new InMemoryAuditSink();
  const account: StaffAccount = { staffId, userId: staffUserId, level, permissionsVersion: 1, status: 'ACTIVE' };
  const directory: StaffDirectory = { resolveByDiscord: () => account };
  const store = new InMemoryApprovalStore({
    auditSink: audit,
    records: [
      approval({ id: approvalId, requiredLevel }),
      approval({ id: '00000000-0000-0000-0000-000000000410', guildId: otherGuildId }),
      approval({ id: '00000000-0000-0000-0000-000000000411', guildId: otherGuildId }),
      approval({ id: '00000000-0000-0000-0000-000000000412', expiresAt: new Date(now.getTime() - 1).toISOString() }),
      approval({ id: '00000000-0000-0000-0000-000000000413', action: 'ORDER_REASSIGN' })
    ],
    execute: (record) => ({
      resultType: record.action === 'REFUND_EXECUTE' ? 'REFUND' : 'ORDER_RESOLUTION',
      resultId: record.targetId
    })
  });
  const session = await auth.createSession(account, now);
  const server = buildApiServer({
    env: {
      NODE_ENV: 'development',
      DATABASE_URL: '',
      API_PORT: '0',
      API_BASE_URL: 'http://localhost:3000',
      BOT_SERVICE_TOKEN: 'valid-bot-token'
    },
    security: {
      auditSink: audit,
      idempotencyStore: new InMemoryIdempotencyStore(),
      staffDirectory: directory,
      dashboardSessions: auth,
      stepUpVerifier: { verify: () => true }
    },
    dashboardAuth: {
      store: auth,
      oauth: {
        getAuthorizationUrl: ({ state }) => `https://discord.test?state=${state}`,
        exchangeCode: async () => ({ discordUserId: '300000000000000001' })
      },
      staffDirectory: directory,
      guildId,
      dashboardUrl: 'https://dashboard.example.test',
      secureCookies: false,
      now: () => now
    },
    approvals: { store, now: () => now }
  });
  return {
    server,
    store,
    audit,
    dashboardHeaders: (idempotencyKey?: string) => ({
      cookie: `p0_session=${session.sessionToken}; p0_csrf=${session.csrfToken}`,
      'x-csrf-token': session.csrfToken,
      'x-client-source': 'DASHBOARD',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
    }),
    headers: (idempotencyKey?: string) => ({
      authorization: 'Bearer valid-bot-token',
      'x-client-source': 'DISCORD_BOT',
      'x-actor-guild-id': guildId,
      'x-actor-discord-user-id': '300000000000000001',
      'x-discord-interaction-id': '300000000000000002',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
    })
  };
}

function approval(overrides: Partial<ApprovalRecord> & Pick<ApprovalRecord, 'id'>): ApprovalRecord {
  return {
    id: overrides.id,
    action: 'REFUND_EXECUTE',
    targetType: 'ORDER',
    targetId,
    targetVersion: 7,
    payloadSnapshot: {
      expectedVersion: 7,
      amount: { amountMinor: 50_100, currency: 'CAT' },
      reasonCode: 'USER_REQUEST',
      evidenceNote: 'Verified.'
    },
    payloadHash: 'trusted-payload-hash',
    amountMinor: 50_100,
    currency: 'CAT',
    requestedBy: staffId,
    requiredLevel: 'L3_OPERATIONS',
    status: 'PENDING',
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    version: 1,
    guildId,
    createdAt: now.toISOString(),
    ...overrides
  };
}
