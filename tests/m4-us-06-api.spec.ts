import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildApiServer } from '@blackcat/api/server';
import { buildCapabilities } from '@blackcat/api/dashboard-auth';
import { handleCreateOrderFromPublicEntry, type BotActorContext, type BotApiClient } from '../apps/bot/src/service-center.js';
import {
  InMemoryOperationsStore,
  type PolicySettingRecord
} from '@blackcat/api/operations';
import type { OutboxJob } from '@blackcat/api/outbox';
import {
  InMemoryIdempotencyStore,
  type AuditRecord,
  type StaffDirectory,
  type StaffLevel
} from '@blackcat/api/security';

const env = {
  NODE_ENV: 'test',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};
const now = new Date('2026-07-18T20:00:00.000Z');
const guildId = '900000000000006001';

const staff = {
  l1: account('00000000-0000-0000-0000-000000006101', '900000000000006101', 'L1_SUPPORT'),
  teammate: account('00000000-0000-0000-0000-000000006102', '900000000000006102', 'L1_SUPPORT'),
  l2: account('00000000-0000-0000-0000-000000006201', '900000000000006201', 'L2_SUPERVISOR'),
  l3: account('00000000-0000-0000-0000-000000006301', '900000000000006301', 'L3_OPERATIONS'),
  l4: account('00000000-0000-0000-0000-000000006401', '900000000000006401', 'L4_ADMIN_OWNER')
};

const failedJobId = '00000000-0000-0000-0000-000000006501';
const completedJobId = '00000000-0000-0000-0000-000000006502';
const timeoutJobId = '00000000-0000-0000-0000-000000006503';
const reconciliationJobId = '00000000-0000-0000-0000-000000006504';
const repairOrderId = '00000000-0000-0000-0000-000000006701';

function account(staffId: string, discordUserId: string, level: StaffLevel) {
  return { staffId, discordUserId, level, permissionsVersion: 1, status: 'ACTIVE' as const };
}

function fixture() {
  const accounts = Object.values(staff);
  const directory: StaffDirectory = {
    resolveByDiscord({ discordUserId }) {
      const found = accounts.find((item) => item.discordUserId === discordUserId);
      return found
        ? {
            staffId: found.staffId,
            userId: found.staffId,
            level: found.level,
            permissionsVersion: found.permissionsVersion,
            status: found.status
          }
        : null;
    }
  };
  const store = new InMemoryOperationsStore({
    audits: [
      audit('00000000-0000-0000-0000-000000006601', staff.l1.staffId, 'L1_SUPPORT', 'SELF_ACTION'),
      audit('00000000-0000-0000-0000-000000006602', staff.teammate.staffId, 'L1_SUPPORT', 'TEAM_ACTION'),
      audit('00000000-0000-0000-0000-000000006603', staff.l3.staffId, 'L3_OPERATIONS', 'BUSINESS_ACTION'),
      audit('00000000-0000-0000-0000-000000006604', null, null, 'SYSTEM_ACTION', 'SYSTEM_JOB'),
      { ...audit('00000000-0000-0000-0000-000000006605', staff.l4.staffId, 'L4_ADMIN_OWNER', 'SECURITY_ACTION'), actorId: '00000000-0000-0000-0000-000000006406', permissionCode: 'access.manage' },
      { ...audit('00000000-0000-0000-0000-000000006606', staff.l4.staffId, 'L4_ADMIN_OWNER', 'BOOTSTRAP_ACTION'), permissionCode: 'access.bootstrap' }
    ],
    teamStaffIdsBySupervisorId: {
      [staff.l2.staffId]: [staff.l1.staffId, staff.teammate.staffId, staff.l2.staffId]
    },
    jobs: [
      job({
        id: failedJobId,
        status: 'FAILED',
        version: 4,
        lastError: 'Discord channel creation failed; requestId=req_channel_failure'
      }),
      job({ id: completedJobId, status: 'COMPLETED', version: 3, lastError: null }),
      job({ id: timeoutJobId, type: 'DISPATCH_TIMEOUT', status: 'FAILED', version: 1, lastError: 'Timed out; requestId=req_timeout' }),
      job({ id: reconciliationJobId, type: 'ROLE_RECONCILIATION', status: 'FAILED', version: 1, lastError: 'Role sync failed; requestId=req_role' })
    ],
    settings: [
      setting('L2_GIFT_APPROVAL_LIMIT_MINOR', 200_000, 'CNY'),
      setting('DISPATCH_TIMEOUT_MINUTES', 5, null)
    ],
    repairableOrders: [{ id: repairOrderId, guildId, panelMessageId: '900000000000006701', version: 8 }]
  });
  const server = buildApiServer({
    env,
    security: {
      auditSink: store,
      idempotencyStore: new InMemoryIdempotencyStore(),
      staffDirectory: directory,
      dashboardSessions: {
        resolve(sessionToken) {
          const found = accounts.find((item) => sessionToken === `session-${item.staffId}`);
          return found ? { ok: true as const, staff: { staffId: found.staffId, userId: found.staffId, level: found.level, permissionsVersion: 1, status: 'ACTIVE' as const }, csrfToken: 'csrf-token' }
            : { ok: false as const, reason: 'AUTH_REQUIRED' as const };
        },
        verifyCsrf(_sessionToken, csrfToken) { return csrfToken === 'csrf-token'; },
        verifyRecentStepUp() { return true; }
      },
      stepUpVerifier: {
        verify: ({ request }) => request.headers['x-test-step-up'] === 'valid'
      }
    },
    operations: { store, guildId, now: () => now }
  });
  return { server, store };
}

function dashboardHeaders(actor: (typeof staff)[keyof typeof staff], key: string, requestId: string) {
  return {
    cookie: `p0_session=session-${actor.staffId}; p0_csrf=csrf-token`,
    'x-csrf-token': 'csrf-token',
    'x-client-source': 'DASHBOARD',
    'idempotency-key': key,
    'x-request-id': requestId
  };
}

function headers(
  actor: (typeof staff)[keyof typeof staff],
  options: { key?: string; stepUp?: boolean; requestId?: string } = {}
) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': actor.discordUserId,
    'x-actor-guild-id': guildId,
    'x-discord-interaction-id': '900000000000006901',
    ...(options.key ? { 'idempotency-key': options.key } : {}),
    ...(options.stepUp ? { 'x-test-step-up': 'valid' } : {}),
    ...(options.requestId ? { 'x-request-id': options.requestId } : {})
  };
}

describe('M4-US-06 operational API', () => {
  test('grants cumulative Operations capabilities at the intended staff levels', async () => {
    const [l1, l2, l3, l4] = await Promise.all((['L1_SUPPORT', 'L2_SUPERVISOR', 'L3_OPERATIONS', 'L4_ADMIN_OWNER'] as const)
      .map((level) => buildCapabilities(staff.l1.staffId, level, 1)));
    expect(l1.permissions).toContain('audit.read');
    expect(l1.permissions).not.toContain('job.read');
    expect(l2.permissions).toEqual(expect.arrayContaining(['audit.read', 'job.read', 'job.retry']));
    expect(l2.permissions).not.toContain('policy.read');
    expect(l3.permissions).toEqual(expect.arrayContaining(['job.read', 'policy.read', 'policy.manage']));
    expect(l4.permissions).toEqual(expect.arrayContaining(['policy.manage', 'access.read', 'access.manage']));
  });

  test('keeps both OpenAPI mirrors aligned with the five frozen operation IDs', async () => {
    const [docs, outputs] = await Promise.all([
      readFile('docs/P0开发交付包/02-API/openapi.yaml', 'utf8'),
      readFile('outputs/P0开发交付包/02-API/openapi.yaml', 'utf8')
    ]);
    expect(docs).toBe(outputs);
    for (const operationId of ['listAuditLogs', 'listFailedJobs', 'retryJob', 'queueOrderPanelRepair', 'getPolicySettings', 'updatePolicySetting']) {
      expect(docs).toContain(`operationId: ${operationId}`);
    }
    expect(docs).toContain('operationId: reportDiscordChannelCreationFailure');
  });

  test('applies L1 self, L2 team, L3 business, and L4 all audit scopes', async () => {
    const { server } = fixture();

    const [l1, l2, l3, l4] = await Promise.all([
      server.inject({ method: 'GET', url: '/api/v1/admin/audit-logs', headers: headers(staff.l1) }),
      server.inject({ method: 'GET', url: '/api/v1/admin/audit-logs', headers: headers(staff.l2) }),
      server.inject({ method: 'GET', url: '/api/v1/admin/audit-logs', headers: headers(staff.l3) }),
      server.inject({ method: 'GET', url: '/api/v1/admin/audit-logs', headers: headers(staff.l4) })
    ]);

    for (const response of [l1, l2, l3, l4]) expect(response.statusCode).toBe(200);
    expect(actions(l1)).toEqual(['SELF_ACTION']);
    expect(actions(l2)).toEqual(expect.arrayContaining(['SELF_ACTION', 'TEAM_ACTION']));
    expect(actions(l2)).toHaveLength(2);
    expect(actions(l3)).toEqual(expect.arrayContaining(['SELF_ACTION', 'TEAM_ACTION', 'BUSINESS_ACTION']));
    expect(actions(l3)).toHaveLength(3);
    expect(actions(l4)).toEqual(expect.arrayContaining(['SELF_ACTION', 'TEAM_ACTION', 'BUSINESS_ACTION', 'SYSTEM_ACTION', 'SECURITY_ACTION', 'BOOTSTRAP_ACTION']));
    expect(actions(l4)).toHaveLength(6);
    expect(l4.json().data.items.find((item: { action: string }) => item.action === 'SECURITY_ACTION').actorId).toBe('00000000-0000-0000-0000-000000006406');
  });

  test('filters immutable audit records without exposing internal scope fields', async () => {
    const { server } = fixture();
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs?targetType=ORDER&targetId=00000000-0000-0000-0000-000000006701',
      headers: headers(staff.l4, { requestId: 'req_audit_filter' })
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requestId: 'req_audit_filter',
      data: { items: [expect.objectContaining({ action: 'SELF_ACTION', requestId: 'req_SELF_ACTION' })], nextCursor: null }
    });
    expect(response.body).not.toMatch(/actorStaffId|beforeSnapshot|afterSnapshot/);
  });

  test('lists failed jobs only for L2 or above and preserves the originating requestId in the error text', async () => {
    const { server } = fixture();
    const denied = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/jobs',
      headers: headers(staff.l1, { requestId: 'req_jobs_denied' })
    });
    const allowed = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/jobs?type=DISPATCH_MESSAGE',
      headers: headers(staff.l2, { requestId: 'req_jobs_list' })
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ requestId: 'req_jobs_denied', error: expect.any(Object) });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      requestId: 'req_jobs_list',
      data: {
        items: [expect.objectContaining({
          id: failedJobId,
          type: 'DISPATCH_MESSAGE',
          status: 'FAILED',
          lastError: 'DELIVERY_FAILED; requestId=req_channel_failure'
        })],
        nextCursor: null
      }
    });
    expect(allowed.body).not.toContain(completedJobId);
  });

  test('limits failed-job visibility by staff level', async () => {
    const { server } = fixture();
    const [l2, l3, l4] = await Promise.all([
      server.inject({ method: 'GET', url: '/api/v1/admin/jobs', headers: headers(staff.l2) }),
      server.inject({ method: 'GET', url: '/api/v1/admin/jobs', headers: headers(staff.l3) }),
      server.inject({ method: 'GET', url: '/api/v1/admin/jobs', headers: headers(staff.l4) })
    ]);

    expect(l2.json().data.items.map((item: { id: string }) => item.id)).toEqual([failedJobId]);
    expect(l3.json().data.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([failedJobId, timeoutJobId]));
    expect(l3.body).not.toContain(reconciliationJobId);
    expect(l4.json().data.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([failedJobId, timeoutJobId, reconciliationJobId]));

    const deniedFilter = await server.inject({ method: 'GET', url: '/api/v1/admin/jobs?type=ROLE_RECONCILIATION', headers: headers(staff.l2) });
    expect(deniedFilter.statusCode).toBe(403);
  });

  test('records the real Bot channel-create failure requestId for Dashboard recovery without creating an order', async () => {
    const { server } = fixture();
    const actor: BotActorContext = { discordUserId: staff.l1.discordUserId, guildId, interactionId: '900000000000006991', clientSource: 'DISCORD_BOT' };
    let createOrderCalls = 0;
    const api = {
      createOrder: async () => { createOrderCalls += 1; throw new Error('must not create an order after channel failure'); },
      reportChannelCreationFailure: async (payload: { requestId: string; failureCode: 'CHANNEL_CREATE_FAILED' }, context: BotActorContext, key: string) => {
        const response = await server.inject({ method: 'POST', url: '/api/v1/internal/discord/channel-failures', headers: {
          authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT', 'x-actor-discord-user-id': context.discordUserId,
          'x-actor-guild-id': context.guildId, 'x-discord-interaction-id': context.interactionId, 'idempotency-key': key
        }, payload });
        if (!response.ok) throw new Error(response.body);
        return response.json().data;
      }
    } as unknown as BotApiClient;

    const result = await handleCreateOrderFromPublicEntry({ api, actor, provisionalChannel: null, idempotencyKey: 'discord:create-order:channel-failure-e2e' });
    expect(result.kind).toBe('CHANNEL_CREATION_FAILED');
    const requestId = 'message' in result ? result.message.match(/request_id: (req_[A-Za-z0-9_-]+)/)?.[1] : null;
    expect(requestId).toMatch(/^req_/);
    expect(createOrderCalls).toBe(0);

    const dashboard = await server.inject({ method: 'GET', url: '/api/v1/admin/jobs?type=CHANNEL_CREATE_FAILURE', headers: headers(staff.l2) });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().data.items).toEqual([expect.objectContaining({ type: 'CHANNEL_CREATE_FAILURE', status: 'FAILED', lastError: `DELIVERY_FAILED; requestId=${requestId}` })]);
  });

  test('retries only failed delivery jobs idempotently without replaying or changing business payload', async () => {
    const { server, store } = fixture();
    const original = await store.getJob(failedJobId);
    const request = {
      method: 'POST' as const,
      url: `/api/v1/admin/jobs/${failedJobId}/retry`,
      headers: headers(staff.l2, { key: 'operations:retry:failed-job', requestId: 'req_retry_job' }),
      payload: { expectedVersion: 4, reasonCode: 'MANUAL_DISPLAY_RECOVERY', note: 'Retry delivery only.' }
    };

    const first = await server.inject(request);
    const replay = await server.inject(request);
    const after = await store.getJob(failedJobId);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      requestId: 'req_retry_job',
      data: { id: failedJobId, status: 'PENDING', attempts: 4, version: 5 }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(after).toMatchObject({ status: 'PENDING', attempts: 4, version: 5, payload: original?.payload });
    expect(store.audits.find((record) => record.action === 'RETRY_JOB')?.reason).toBe('MANUAL_DISPLAY_RECOVERY: Retry delivery only.');
  });

  test('produces the same retry state and audit facts through Bot and Dashboard clients', async () => {
    const bot = fixture();
    const dashboard = fixture();
    const payload = { expectedVersion: 4, reasonCode: 'MANUAL_DISPLAY_RECOVERY' };
    const botResponse = await bot.server.inject({ method: 'POST', url: `/api/v1/admin/jobs/${failedJobId}/retry`, headers: headers(staff.l2, { key: 'operations:parity:bot-retry' }), payload });
    const dashboardResponse = await dashboard.server.inject({ method: 'POST', url: `/api/v1/admin/jobs/${failedJobId}/retry`, headers: dashboardHeaders(staff.l2, 'operations:parity:dashboard-retry', 'req_dashboard_parity'), payload });
    expect(botResponse.statusCode).toBe(200);
    expect(dashboardResponse.statusCode).toBe(200);
    expect(dashboardResponse.json().data).toEqual(botResponse.json().data);

    const botAudit = bot.store.audits.find((record) => record.action === 'RETRY_JOB')!;
    const dashboardAudit = dashboard.store.audits.find((record) => record.action === 'RETRY_JOB')!;
    const stableFacts = (record: AuditRecord) => ({ actorId: record.actorId, actorStaffId: record.actorStaffId, actorLevel: record.actorLevel,
      permissionCode: record.permissionCode, action: record.action, targetType: record.targetType, targetId: record.targetId,
      outcome: record.outcome, reason: record.reason, beforeSnapshot: record.beforeSnapshot, afterSnapshot: record.afterSnapshot });
    expect(stableFacts(dashboardAudit)).toEqual(stableFacts(botAudit));
    expect({ source: dashboardAudit.actorSource, client: dashboardAudit.clientId, interaction: dashboardAudit.interactionId }).toEqual({ source: 'DASHBOARD', client: 'DASHBOARD', interaction: null });
    expect({ source: botAudit.actorSource, client: botAudit.clientId, interaction: botAudit.interactionId }).toEqual({ source: 'DISCORD_BOT', client: 'DISCORD_BOT', interaction: '900000000000006901' });
  });

  test('rejects retry of non-failed jobs and returns the same requestId in the error envelope', async () => {
    const { server } = fixture();
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/jobs/${completedJobId}/retry`,
      headers: headers(staff.l2, { key: 'operations:retry:completed-job', requestId: 'req_retry_rejected' }),
      payload: { expectedVersion: 3, reasonCode: 'MANUAL_DISPLAY_RECOVERY' }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      requestId: 'req_retry_rejected',
      error: { code: 'VALIDATION_ERROR' }
    });
  });

  test('lets L2 queue an idempotent panel repair while L1 remains denied', async () => {
    const { server, store } = fixture();
    const request = {
      method: 'POST' as const,
      url: `/api/v1/admin/orders/${repairOrderId}/panel-repair`,
      headers: headers(staff.l2, { key: 'operations:panel-repair:P-6701', requestId: 'req_panel_repair' }),
      payload: { reasonCode: 'PANEL_MESSAGE_DELETED', note: 'Rebuild from current database state.' }
    };
    const denied = await server.inject({ ...request, headers: headers(staff.l1, { key: 'operations:panel-repair:denied' }) });
    const crossGuild = await server.inject({ ...request, headers: {
      ...headers(staff.l2, { key: 'operations:panel-repair:cross-guild' }),
      'x-actor-guild-id': '900000000000006999'
    } });
    const first = await server.inject(request);
    const replay = await server.inject(request);

    expect(denied.statusCode).toBe(403);
    expect(crossGuild.statusCode).toBe(404);
    expect(first.statusCode).toBe(202);
    expect(replay.json()).toEqual(first.json());
    expect(first.json()).toMatchObject({ data: { type: 'PANEL_SYNC', status: 'PENDING', attempts: 0, version: 1 } });
    expect(store.jobs.filter((item) => item.type === 'PANEL_SYNC')).toEqual([
      expect.objectContaining({ aggregateId: repairOrderId, payload: { orderId: repairOrderId, kind: 'MANUAL_REPAIR' } })
    ]);
    expect(store.audits.find((record) => record.action === 'QUEUE_PANEL_REPAIR' && record.outcome === 'SUCCEEDED')?.reason)
      .toBe('PANEL_MESSAGE_DELETED: Rebuild from current database state.');
  });

  test('queues a new generation after an earlier repair completed for the same panel id', async () => {
    const { server, store } = fixture();
    const send = (key: string) => server.inject({
      method: 'POST', url: `/api/v1/admin/orders/${repairOrderId}/panel-repair`,
      headers: headers(staff.l2, { key }), payload: { reasonCode: 'PANEL_MESSAGE_DELETED' }
    });
    const first = await send('operations:panel-repair:generation-1');
    const firstJob = store.jobs.find((job) => job.type === 'PANEL_SYNC')!;
    firstJob.status = 'COMPLETED';
    const second = await send('operations:panel-repair:generation-2');

    expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
    expect(store.jobs.filter((job) => job.type === 'PANEL_SYNC')).toHaveLength(2);
    expect(second.json().data.id).not.toBe(first.json().data.id);
  });

  test('limits policy reads to L3 and returns current amount and timeout versions', async () => {
    const { server } = fixture();
    const denied = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/policy-settings',
      headers: headers(staff.l2)
    });
    const allowed = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/policy-settings',
      headers: headers(staff.l3, { requestId: 'req_policy_list' })
    });

    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      requestId: 'req_policy_list',
      data: {
        items: expect.arrayContaining([
          { key: 'L2_GIFT_APPROVAL_LIMIT_MINOR', integerValue: 200_000, currency: 'CNY', version: 1 },
          { key: 'DISPATCH_TIMEOUT_MINUTES', integerValue: 5, currency: null, version: 1 }
        ])
      }
    });
  });

  test('requires L3, step-up, reason, and optimistic version for append-only policy updates', async () => {
    const { server, store } = fixture();
    const url = '/api/v1/admin/policy-settings/DISPATCH_TIMEOUT_MINUTES';
    const payload = { expectedVersion: 1, integerValue: 7, currency: null, reasonCode: 'P0_POLICY_CONFIRMATION' };

    const l2 = await server.inject({ method: 'PUT', url, headers: headers(staff.l2, { key: 'policy:update:l2-denied', stepUp: true }), payload });
    const noStepUp = await server.inject({ method: 'PUT', url, headers: headers(staff.l3, { key: 'policy:no-step-up' }), payload });
    const noReason = await server.inject({
      method: 'PUT',
      url,
      headers: headers(staff.l3, { key: 'policy:no-reason', stepUp: true }),
      payload: { expectedVersion: 1, integerValue: 7, currency: null }
    });
    const updated = await server.inject({
      method: 'PUT',
      url,
      headers: headers(staff.l3, { key: 'policy:update:v2', stepUp: true, requestId: 'req_policy_update' }),
      payload
    });
    const stale = await server.inject({
      method: 'PUT',
      url,
      headers: headers(staff.l4, { key: 'policy:update:stale', stepUp: true, requestId: 'req_policy_stale' }),
      payload
    });

    expect(l2.statusCode).toBe(403);
    expect(noStepUp.statusCode).toBe(428);
    expect(noStepUp.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      requestId: 'req_policy_update',
      data: { key: 'DISPATCH_TIMEOUT_MINUTES', integerValue: 7, currency: null, version: 2 }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ requestId: 'req_policy_stale', error: { code: 'CONFLICT' } });
    expect(store.getPolicyHistory('DISPATCH_TIMEOUT_MINUTES')).toEqual([
      expect.objectContaining({ integerValue: 5, version: 1 }),
      expect.objectContaining({ integerValue: 7, version: 2 })
    ]);
  });

  test('uses updated policy values for subsequent runtime capability decisions', async () => {
    const { store } = fixture();
    const before = await buildCapabilities(staff.l2.staffId, 'L2_SUPERVISOR', 1, undefined, undefined, now, store);
    expect(before.thresholds.giftApprovalLimitMinor).toBe(200_000);

    const write = store.updatePolicySetting({
      key: 'L2_GIFT_APPROVAL_LIMIT_MINOR', expectedVersion: 1, integerValue: 120_000,
      currency: 'CNY', actorStaffId: staff.l3.staffId, now
    });
    await write.commit(audit('00000000-0000-0000-0000-000000006699', staff.l3.staffId, 'L3_OPERATIONS', 'POLICY_RUNTIME_ACTION'), store);

    const after = await buildCapabilities(staff.l2.staffId, 'L2_SUPERVISOR', 1, undefined, undefined, now, store);
    expect(after.thresholds.giftApprovalLimitMinor).toBe(120_000);
    expect(before.thresholds.giftApprovalLimitMinor).toBe(200_000);
  });

  test('rejects unknown fields and mismatched policy units before persistence', async () => {
    const { server, store } = fixture();
    const invalid = await server.inject({ method: 'PUT', url: '/api/v1/admin/policy-settings/DISPATCH_TIMEOUT_MINUTES',
      headers: headers(staff.l3, { key: 'policy:invalid:semantic', stepUp: true }),
      payload: { expectedVersion: 1, integerValue: 7, currency: 'CNY', reasonCode: 'P0_POLICY_CONFIRMATION', arbitrarySql: 'DROP TABLE audit_logs' } });
    const wrongCurrency = await server.inject({ method: 'PUT', url: '/api/v1/admin/policy-settings/L2_GIFT_APPROVAL_LIMIT_MINOR',
      headers: headers(staff.l3, { key: 'policy:invalid:currency', stepUp: true }),
      payload: { expectedVersion: 1, integerValue: 250_000, currency: null, reasonCode: 'P0_POLICY_CONFIRMATION' } });
    expect(invalid.statusCode).toBe(400);
    expect(wrongCurrency.statusCode).toBe(400);
    expect(store.getPolicyHistory('DISPATCH_TIMEOUT_MINUTES')).toHaveLength(1);
    expect(store.getPolicyHistory('L2_GIFT_APPROVAL_LIMIT_MINOR')).toHaveLength(1);
  });
});

function actions(response: { json(): any }) {
  return response.json().data.items.map((item: { action: string }) => item.action);
}

function audit(
  id: string,
  actorStaffId: string | null,
  actorLevel: StaffLevel | null,
  action: string,
  actorSource: AuditRecord['actorSource'] = 'DASHBOARD'
): AuditRecord {
  return {
    id,
    actorId: actorStaffId,
    actorStaffId,
    actorLevel,
    actorSource,
    clientId: actorSource === 'SYSTEM_JOB' ? 'OUTBOX_WORKER' : 'DASHBOARD',
    interactionId: null,
    permissionCode: 'audit.fixture',
    action,
    targetType: action === 'SELF_ACTION' ? 'ORDER' : 'USER',
    targetId: action === 'SELF_ACTION' ? '00000000-0000-0000-0000-000000006701' : '00000000-0000-0000-0000-000000006702',
    outcome: 'SUCCEEDED',
    reason: null,
    requestId: `req_${action}`,
    approvalRequestId: null,
    occurredAt: `2026-07-18T19:0${id.slice(-1)}:00.000Z`,
    beforeSnapshot: { internal: 'not exposed' },
    afterSnapshot: { internal: 'not exposed' }
  };
}

function job(overrides: Pick<OutboxJob, 'id' | 'status' | 'version' | 'lastError'> & { type?: OutboxJob['type'] }): OutboxJob {
  return {
    id: overrides.id,
    type: overrides.type ?? 'DISPATCH_MESSAGE',
    status: overrides.status,
    payload: { orderId: '00000000-0000-0000-0000-000000006801', operation: 'CREATE_PRIVATE_CHANNEL' },
    aggregateType: 'ORDER',
    aggregateId: '00000000-0000-0000-0000-000000006801',
    dedupeKey: `dispatch:${overrides.id}`,
    attempts: 4,
    maxAttempts: 4,
    runAfter: '2026-07-18T19:30:00.000Z',
    lockedAt: null,
    lockedBy: null,
    completedAt: overrides.status === 'COMPLETED' ? '2026-07-18T19:31:00.000Z' : null,
    lastError: overrides.lastError,
    version: overrides.version,
    createdAt: '2026-07-18T19:00:00.000Z',
    updatedAt: '2026-07-18T19:30:00.000Z'
  };
}

function setting(key: PolicySettingRecord['key'], integerValue: number, currency: string | null): PolicySettingRecord {
  return { key, integerValue, currency, version: 1 };
}
