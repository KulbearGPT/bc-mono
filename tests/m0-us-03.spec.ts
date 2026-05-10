import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import {
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
  type AuditRecord,
  registerSecureWriteRoute,
  registerSecurityProbeRoutes,
  type StaffDirectory
} from '@blackcat/api/security';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};

const staffDirectory: StaffDirectory = {
  resolveByDiscord({ discordUserId, guildId }) {
    if (discordUserId === '111111111111111111' && guildId === '999999999999999999') {
      return {
        staffId: '00000000-0000-0000-0000-000000000111',
        userId: '00000000-0000-0000-0000-000000000011',
        level: 'L1_SUPPORT',
        permissionsVersion: 1,
        status: 'ACTIVE'
      };
    }
    if (discordUserId === '222222222222222222' && guildId === '999999999999999999') {
      return {
        staffId: '00000000-0000-0000-0000-000000000222',
        userId: '00000000-0000-0000-0000-000000000022',
        level: 'L2_SUPERVISOR',
        permissionsVersion: 2,
        status: 'ACTIVE'
      };
    }
    return null;
  }
};

function buildSecuredProbeServer() {
  const auditSink = new InMemoryAuditSink();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const server = buildApiServer({
    env,
    security: {
      auditSink,
      idempotencyStore,
      staffDirectory
    }
  });

  registerSecurityProbeRoutes(server);

  return { server, auditSink, idempotencyStore };
}

function botHeaders(discordUserId: string, extra: Record<string, string> = {}) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': discordUserId,
    'x-actor-guild-id': '999999999999999999',
    'x-discord-interaction-id': '777777777777777777',
    'idempotency-key': 'discord:777777777777777777',
    ...extra
  };
}

describe('M0-US-03 unified auth, actor context, idempotency, and audit middleware', () => {
  test('rejects forged actor headers before parsing untrusted level or staff claims', async () => {
    const { server, auditSink } = buildSecuredProbeServer();

    const response = await server.inject({
      method: 'POST',
      url: '/__m0/security/gift-approval-probe',
      headers: {
        authorization: 'Bearer invalid-token',
        'x-client-source': 'DISCORD_BOT',
        'x-actor-discord-user-id': '222222222222222222',
        'x-actor-guild-id': '999999999999999999',
        'x-actor-level': 'L4_ADMIN_OWNER',
        'x-actor-staff-id': '00000000-0000-0000-0000-000000000999',
        'x-discord-interaction-id': '777777777777777777',
        'idempotency-key': 'discord:777777777777777777'
      },
      payload: { action: 'approveGift' }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: 'AUTH_REQUIRED'
      }
    });
    expect(auditSink.records).toHaveLength(1);
    expect(auditSink.records[0]).toMatchObject({
      actorId: null,
      actorLevel: null,
      actorSource: 'DISCORD_BOT',
      clientId: 'DISCORD_BOT',
      interactionId: '777777777777777777',
      outcome: 'REJECTED',
      reason: 'AUTH_REQUIRED'
    });
    expect(JSON.stringify(auditSink.records)).not.toContain('invalid-token');
  });

  test('ignores client-reported level and denies insufficient permission with audit', async () => {
    const { server, auditSink } = buildSecuredProbeServer();

    const response = await server.inject({
      method: 'POST',
      url: '/__m0/security/gift-approval-probe',
      headers: botHeaders('111111111111111111', { 'x-actor-level': 'L4_ADMIN_OWNER' }),
      payload: { action: 'approveGift' }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: 'PERMISSION_DENIED',
        details: [{ field: 'permission', reason: 'gift.approve required' }]
      }
    });
    expect(auditSink.records.at(-1)).toMatchObject({
      actorId: '00000000-0000-0000-0000-000000000011',
      actorLevel: 'L1_SUPPORT',
      permissionCode: 'gift.approve',
      outcome: 'REJECTED',
      reason: 'PERMISSION_DENIED'
    });
  });

  test('allows L1 basic support action and appends success audit', async () => {
    const { server, auditSink } = buildSecuredProbeServer();

    const response = await server.inject({
      method: 'POST',
      url: '/__m0/security/staff-task-claim-probe',
      headers: botHeaders('111111111111111111'),
      payload: { taskId: 'T-100' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        actorLevel: 'L1_SUPPORT',
        claimed: true
      }
    });
    expect(auditSink.records.at(-1)).toMatchObject({
      actorLevel: 'L1_SUPPORT',
      permissionCode: 'staff_task.claim',
      outcome: 'SUCCEEDED'
    });
  });

  test('authorizes job.retry through the central permission matrix for L2 and above', async () => {
    const { server, auditSink } = buildSecuredProbeServer();

    registerSecureWriteRoute(server, server.securityOptions!, {
      method: 'POST',
      url: '/__m0/security/job-retry-probe',
      permission: 'job.retry',
      action: 'RETRY_JOB_PROBE',
      targetType: 'outbox_event',
      targetId: () => '00000000-0000-0000-0000-00000000a001',
      handler: (_request, actor) => ({
        actorLevel: actor.actorLevel,
        retryQueued: true
      })
    });

    const denied = await server.inject({
      method: 'POST',
      url: '/__m0/security/job-retry-probe',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:jobretry:l1' }),
      payload: { jobId: '00000000-0000-0000-0000-00000000a001' }
    });
    const allowed = await server.inject({
      method: 'POST',
      url: '/__m0/security/job-retry-probe',
      headers: botHeaders('222222222222222222', { 'idempotency-key': 'discord:jobretry:l2' }),
      payload: { jobId: '00000000-0000-0000-0000-00000000a001' }
    });

    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      data: {
        actorLevel: 'L2_SUPERVISOR',
        retryQueued: true
      }
    });
    expect(auditSink.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorLevel: 'L1_SUPPORT',
          permissionCode: 'job.retry',
          outcome: 'REJECTED',
          reason: 'PERMISSION_DENIED'
        }),
        expect.objectContaining({
          actorLevel: 'L2_SUPERVISOR',
          permissionCode: 'job.retry',
          outcome: 'SUCCEEDED'
        })
      ])
    );
  });

  test('authorizes job.read through the central permission matrix for L2 and above', async () => {
    const { server, auditSink } = buildSecuredProbeServer();

    registerSecureWriteRoute(server, server.securityOptions!, {
      method: 'POST',
      url: '/__m0/security/job-read-probe',
      permission: 'job.read',
      action: 'READ_JOB_PROBE',
      targetType: 'outbox_event',
      targetId: () => '00000000-0000-0000-0000-00000000a001',
      handler: (_request, actor) => ({
        actorLevel: actor.actorLevel,
        visible: true
      })
    });

    const denied = await server.inject({
      method: 'POST',
      url: '/__m0/security/job-read-probe',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:jobread:l1' }),
      payload: { jobId: '00000000-0000-0000-0000-00000000a001' }
    });
    const allowed = await server.inject({
      method: 'POST',
      url: '/__m0/security/job-read-probe',
      headers: botHeaders('222222222222222222', { 'idempotency-key': 'discord:jobread:l2' }),
      payload: { jobId: '00000000-0000-0000-0000-00000000a001' }
    });

    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(auditSink.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorLevel: 'L1_SUPPORT',
          permissionCode: 'job.read',
          outcome: 'REJECTED',
          reason: 'PERMISSION_DENIED'
        }),
        expect.objectContaining({
          actorLevel: 'L2_SUPERVISOR',
          permissionCode: 'job.read',
          outcome: 'SUCCEEDED'
        })
      ])
    );
  });

  test('requires idempotency key for write operations', async () => {
    const { server, auditSink } = buildSecuredProbeServer();

    const response = await server.inject({
      method: 'POST',
      url: '/__m0/security/staff-task-claim-probe',
      headers: botHeaders('111111111111111111', { 'idempotency-key': '' }),
      payload: { taskId: 'T-101' }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(auditSink.records.at(-1)).toMatchObject({
      permissionCode: 'staff_task.claim',
      outcome: 'REJECTED',
      reason: 'IDEMPOTENCY_KEY_REQUIRED'
    });
  });

  test('validates idempotency key against the API contract', async () => {
    const { server, auditSink } = buildSecuredProbeServer();

    const shortKey = await server.inject({
      method: 'POST',
      url: '/__m0/security/staff-task-claim-probe',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'short' }),
      payload: { taskId: 'T-102' }
    });
    const malformedKey = await server.inject({
      method: 'POST',
      url: '/__m0/security/staff-task-claim-probe',
      headers: botHeaders('111111111111111111', {
        'idempotency-key': 'discord:bad key with spaces'
      }),
      payload: { taskId: 'T-103' }
    });

    expect(shortKey.statusCode).toBe(400);
    expect(malformedKey.statusCode).toBe(400);
    expect(shortKey.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(malformedKey.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(auditSink.records.at(-2)).toMatchObject({
      reason: 'IDEMPOTENCY_KEY_INVALID',
      outcome: 'REJECTED'
    });
    expect(auditSink.records.at(-1)).toMatchObject({
      reason: 'IDEMPOTENCY_KEY_INVALID',
      outcome: 'REJECTED'
    });
  });

  test('replays the first successful write response and rejects changed fingerprint conflicts', async () => {
    const { server, auditSink } = buildSecuredProbeServer();
    const headers = botHeaders('222222222222222222', {
      'idempotency-key': 'discord:approve:abc12345'
    });

    const first = await server.inject({
      method: 'POST',
      url: '/__m0/security/gift-approval-probe',
      headers,
      payload: { giftRequestId: 'G-1', decision: 'approve' }
    });
    const replay = await server.inject({
      method: 'POST',
      url: '/__m0/security/gift-approval-probe',
      headers,
      payload: { giftRequestId: 'G-1', decision: 'approve' }
    });
    const conflict = await server.inject({
      method: 'POST',
      url: '/__m0/security/gift-approval-probe',
      headers,
      payload: { giftRequestId: 'G-1', decision: 'reject' }
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['x-idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(auditSink.records.filter((record) => record.outcome === 'SUCCEEDED')).toHaveLength(1);
  });

  test('scopes idempotency by client, operation, actor, and key', async () => {
    const { server, idempotencyStore } = buildSecuredProbeServer();
    const sharedKey = { 'idempotency-key': 'discord:shared-key-12345' };

    const l1Claim = await server.inject({
      method: 'POST',
      url: '/__m0/security/staff-task-claim-probe',
      headers: botHeaders('111111111111111111', sharedKey),
      payload: { taskId: 'T-200' }
    });
    const l2Claim = await server.inject({
      method: 'POST',
      url: '/__m0/security/staff-task-claim-probe',
      headers: botHeaders('222222222222222222', sharedKey),
      payload: { taskId: 'T-200' }
    });
    const l2GiftApproval = await server.inject({
      method: 'POST',
      url: '/__m0/security/gift-approval-probe',
      headers: botHeaders('222222222222222222', sharedKey),
      payload: { giftRequestId: 'G-200', decision: 'approve' }
    });

    expect(l1Claim.statusCode).toBe(200);
    expect(l2Claim.statusCode).toBe(200);
    expect(l2GiftApproval.statusCode).toBe(200);
    expect(l2Claim.headers['x-idempotency-replayed']).toBeUndefined();
    expect(l2GiftApproval.headers['x-idempotency-replayed']).toBeUndefined();
    expect(idempotencyStore.scopeKeys).toEqual(
      expect.arrayContaining([
        expect.stringContaining('STAFF:00000000-0000-0000-0000-000000000111'),
        expect.stringContaining('STAFF:00000000-0000-0000-0000-000000000222')
      ])
    );
  });

  test('rejects missing or invalid client source instead of defaulting attribution', async () => {
    const { server, auditSink } = buildSecuredProbeServer();

    const response = await server.inject({
      method: 'POST',
      url: '/__m0/security/staff-task-claim-probe',
      headers: botHeaders('111111111111111111', { 'x-client-source': 'MOBILE_APP' }),
      payload: { taskId: 'T-300' }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    expect(auditSink.records.at(-1)).toMatchObject({
      actorSource: 'UNKNOWN',
      outcome: 'REJECTED',
      reason: 'INVALID_CLIENT_SOURCE'
    });

    const missing = await server.inject({
      method: 'POST',
      url: '/__m0/security/staff-task-claim-probe',
      headers: {
        authorization: 'Bearer valid-bot-token',
        'x-actor-discord-user-id': '111111111111111111',
        'x-actor-guild-id': '999999999999999999',
        'idempotency-key': 'discord:missing-source-12345'
      },
      payload: { taskId: 'T-301' }
    });

    expect(missing.statusCode).toBe(401);
    expect(auditSink.records.at(-1)).toMatchObject({
      actorSource: 'UNKNOWN',
      clientId: 'UNKNOWN',
      outcome: 'REJECTED',
      reason: 'INVALID_CLIENT_SOURCE'
    });
  });

  test('reserves idempotency before running the handler so concurrent duplicates execute once', async () => {
    const auditSink = new InMemoryAuditSink();
    const idempotencyStore = new InMemoryIdempotencyStore();
    const server = buildApiServer({
      env,
      security: {
        auditSink,
        idempotencyStore,
        staffDirectory
      }
    });

    let runCount = 0;
    let releaseHandler: (() => void) | undefined;
    registerSecureWriteRoute(server, server.securityOptions!, {
      method: 'POST',
      url: '/__m0/security/slow-probe',
      permission: 'staff_task.claim',
      action: 'SLOW_PROBE',
      targetType: 'staff_task',
      targetId: () => '00000000-0000-0000-0000-00000000d1ce',
      handler: async () => {
        runCount += 1;
        await new Promise<void>((resolve) => {
          releaseHandler = resolve;
        });
        return { runCount };
      }
    });

    const headers = botHeaders('111111111111111111', {
      'idempotency-key': 'discord:slow-probe-12345'
    });
    const first = server.inject({
      method: 'POST',
      url: '/__m0/security/slow-probe',
      headers,
      payload: { taskId: 'T-400' }
    });
    const second = server.inject({
      method: 'POST',
      url: '/__m0/security/slow-probe',
      headers,
      payload: { taskId: 'T-400' }
    });

    await waitUntil(() => runCount === 1);
    expect(runCount).toBe(1);
    releaseHandler?.();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.headers['x-idempotency-replayed']).toBe('true');
    expect(secondResponse.json()).toEqual(firstResponse.json());
    expect(auditSink.records.filter((record) => record.outcome === 'SUCCEEDED')).toHaveLength(1);
  });

  test('replays the first failed handler response without rerunning side effects', async () => {
    const auditSink = new InMemoryAuditSink();
    const idempotencyStore = new InMemoryIdempotencyStore();
    const server = buildApiServer({
      env,
      security: {
        auditSink,
        idempotencyStore,
        staffDirectory
      }
    });

    let runCount = 0;
    registerSecureWriteRoute(server, server.securityOptions!, {
      method: 'POST',
      url: '/__m0/security/failing-probe',
      permission: 'staff_task.claim',
      action: 'FAILING_PROBE',
      targetType: 'staff_task',
      handler: () => {
        runCount += 1;
        throw new Error('probe failed');
      }
    });

    const headers = botHeaders('111111111111111111', {
      'idempotency-key': 'discord:failing-probe-12345'
    });
    const first = await server.inject({
      method: 'POST',
      url: '/__m0/security/failing-probe',
      headers,
      payload: { taskId: 'T-500' }
    });
    const replay = await server.inject({
      method: 'POST',
      url: '/__m0/security/failing-probe',
      headers,
      payload: { taskId: 'T-500' }
    });

    expect(runCount).toBe(1);
    expect(first.statusCode).toBe(500);
    expect(replay.statusCode).toBe(500);
    expect(replay.headers['x-idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(auditSink.records.at(-1)).toMatchObject({
      outcome: 'FAILED',
      reason: 'HANDLER_FAILED'
    });
  });

  test('does not complete idempotency before success audit append succeeds', async () => {
    const auditSink = {
      records: [] as AuditRecord[],
      append(record: AuditRecord) {
        this.records.push(record);
        if (record.outcome === 'SUCCEEDED') {
          throw new Error('audit unavailable');
        }
      }
    };
    const idempotencyStore = new InMemoryIdempotencyStore();
    const server = buildApiServer({
      env,
      security: {
        auditSink,
        idempotencyStore,
        staffDirectory
      }
    });

    let runCount = 0;
    registerSecureWriteRoute(server, server.securityOptions!, {
      method: 'POST',
      url: '/__m0/security/audit-fails-probe',
      permission: 'staff_task.claim',
      action: 'AUDIT_FAILS_PROBE',
      targetType: 'staff_task',
      handler: () => {
        runCount += 1;
        return { runCount };
      }
    });

    const headers = botHeaders('111111111111111111', {
      'idempotency-key': 'discord:audit-fails-probe-12345'
    });
    const first = await server.inject({
      method: 'POST',
      url: '/__m0/security/audit-fails-probe',
      headers,
      payload: { taskId: 'T-600' }
    });
    const replay = await server.inject({
      method: 'POST',
      url: '/__m0/security/audit-fails-probe',
      headers,
      payload: { taskId: 'T-600' }
    });

    expect(runCount).toBe(1);
    expect(first.statusCode).toBe(500);
    expect(replay.statusCode).toBe(500);
    expect(replay.headers['x-idempotency-replayed']).toBe('true');
    expect(first.json()).toMatchObject({ error: { code: 'AUDIT_APPEND_FAILED' } });
    expect(replay.json()).toEqual(first.json());
  });

  test('delegates staged writes and success audit to transactional commit', async () => {
    const auditSink = new InMemoryAuditSink();
    const server = buildApiServer({
      env,
      security: {
        auditSink,
        idempotencyStore: new InMemoryIdempotencyStore(),
        staffDirectory
      }
    });

    const transactionalAuditRecords: AuditRecord[] = [];
    let committed = false;
    registerSecureWriteRoute(server, server.securityOptions!, {
      method: 'POST',
      url: '/__m0/security/transactional-commit-probe',
      permission: 'staff_task.claim',
      action: 'TRANSACTIONAL_COMMIT_PROBE',
      targetType: 'staff_task',
      handler: () => ({
        data: { status: 'CLAIMED' },
        commit: (auditRecord: AuditRecord) => {
          transactionalAuditRecords.push(auditRecord);
          committed = true;
        }
      }),
      auditSnapshots: () => ({
        beforeSnapshot: { status: 'OPEN' },
        afterSnapshot: { status: 'CLAIMED' }
      })
    });

    const response = await server.inject({
      method: 'POST',
      url: '/__m0/security/transactional-commit-probe',
      headers: botHeaders('111111111111111111', {
        'idempotency-key': 'discord:transactional-commit-12345'
      }),
      payload: { taskId: 'T-610' }
    });

    expect(response.statusCode).toBe(200);
    expect(committed).toBe(true);
    expect(auditSink.records).toHaveLength(0);
    expect(transactionalAuditRecords).toHaveLength(1);
    expect(transactionalAuditRecords[0]).toMatchObject({
      outcome: 'SUCCEEDED',
      beforeSnapshot: { status: 'OPEN' },
      afterSnapshot: { status: 'CLAIMED' }
    });
  });

  test('does not append success audit or rerun handler if transactional commit fails', async () => {
    const auditSink = new InMemoryAuditSink();
    const server = buildApiServer({
      env,
      security: {
        auditSink,
        idempotencyStore: new InMemoryIdempotencyStore(),
        staffDirectory
      }
    });

    let runCount = 0;
    let commitAttempts = 0;
    registerSecureWriteRoute(server, server.securityOptions!, {
      method: 'POST',
      url: '/__m0/security/commit-fails-probe',
      permission: 'staff_task.claim',
      action: 'COMMIT_FAILS_PROBE',
      targetType: 'staff_task',
      handler: () => {
        runCount += 1;
        return {
          data: { prepared: true },
          commit: () => {
            commitAttempts += 1;
            throw new Error('commit failed');
          }
        };
      }
    });

    const headers = botHeaders('111111111111111111', {
      'idempotency-key': 'discord:commit-fails-probe-12345'
    });
    const first = await server.inject({
      method: 'POST',
      url: '/__m0/security/commit-fails-probe',
      headers,
      payload: { taskId: 'T-611' }
    });
    const replay = await server.inject({
      method: 'POST',
      url: '/__m0/security/commit-fails-probe',
      headers,
      payload: { taskId: 'T-611' }
    });

    expect(runCount).toBe(1);
    expect(commitAttempts).toBe(1);
    expect(first.statusCode).toBe(500);
    expect(replay.statusCode).toBe(500);
    expect(replay.headers['x-idempotency-replayed']).toBe('true');
    expect(first.json()).toMatchObject({ error: { code: 'COMMIT_FAILED' } });
    expect(replay.json()).toEqual(first.json());
    expect(auditSink.records.some((record) => record.outcome === 'SUCCEEDED')).toBe(false);
  });

  test('allows routes to attach before and after snapshots to success audit', async () => {
    const auditSink = new InMemoryAuditSink();
    const server = buildApiServer({
      env,
      security: {
        auditSink,
        idempotencyStore: new InMemoryIdempotencyStore(),
        staffDirectory
      }
    });

    registerSecureWriteRoute(server, server.securityOptions!, {
      method: 'POST',
      url: '/__m0/security/snapshot-probe',
      permission: 'staff_task.claim',
      action: 'SNAPSHOT_PROBE',
      targetType: 'staff_task',
      handler: () => ({ status: 'CLAIMED' }),
      auditSnapshots: () => ({
        beforeSnapshot: { status: 'OPEN' },
        afterSnapshot: { status: 'CLAIMED' }
      })
    });

    const response = await server.inject({
      method: 'POST',
      url: '/__m0/security/snapshot-probe',
      headers: botHeaders('111111111111111111', {
        'idempotency-key': 'discord:snapshot-probe-12345'
      }),
      payload: { taskId: 'T-700' }
    });

    expect(response.statusCode).toBe(200);
    expect(auditSink.records.at(-1)).toMatchObject({
      outcome: 'SUCCEEDED',
      beforeSnapshot: { status: 'OPEN' },
      afterSnapshot: { status: 'CLAIMED' }
    });
  });

  test('stores failure response if failed-audit append or snapshot resolution throws', async () => {
    const failingAuditSink = {
      append(record: AuditRecord) {
        if (record.outcome === 'FAILED') {
          throw new Error('failed audit unavailable');
        }
      }
    };
    const failingAuditServer = buildApiServer({
      env,
      security: {
        auditSink: failingAuditSink,
        idempotencyStore: new InMemoryIdempotencyStore(),
        staffDirectory
      }
    });
    registerSecureWriteRoute(failingAuditServer, failingAuditServer.securityOptions!, {
      method: 'POST',
      url: '/__m0/security/failing-audit-path',
      permission: 'staff_task.claim',
      action: 'FAILING_AUDIT_PATH',
      targetType: 'staff_task',
      handler: () => {
        throw new Error('handler failed');
      }
    });

    const failedHeaders = botHeaders('111111111111111111', {
      'idempotency-key': 'discord:failed-audit-path-12345'
    });
    const failedFirst = await failingAuditServer.inject({
      method: 'POST',
      url: '/__m0/security/failing-audit-path',
      headers: failedHeaders,
      payload: { taskId: 'T-800' }
    });
    const failedReplay = await failingAuditServer.inject({
      method: 'POST',
      url: '/__m0/security/failing-audit-path',
      headers: failedHeaders,
      payload: { taskId: 'T-800' }
    });

    expect(failedFirst.statusCode).toBe(500);
    expect(failedReplay.statusCode).toBe(500);
    expect(failedReplay.headers['x-idempotency-replayed']).toBe('true');
    expect(failedReplay.json()).toEqual(failedFirst.json());

    const snapshotServer = buildApiServer({
      env,
      security: {
        auditSink: new InMemoryAuditSink(),
        idempotencyStore: new InMemoryIdempotencyStore(),
        staffDirectory
      }
    });
    let snapshotRunCount = 0;
    registerSecureWriteRoute(snapshotServer, snapshotServer.securityOptions!, {
      method: 'POST',
      url: '/__m0/security/snapshot-throws',
      permission: 'staff_task.claim',
      action: 'SNAPSHOT_THROWS',
      targetType: 'staff_task',
      handler: () => {
        snapshotRunCount += 1;
        return { prepared: true };
      },
      auditSnapshots: () => {
        throw new Error('snapshot failed');
      }
    });

    const snapshotHeaders = botHeaders('111111111111111111', {
      'idempotency-key': 'discord:snapshot-throws-12345'
    });
    const snapshotFirst = await snapshotServer.inject({
      method: 'POST',
      url: '/__m0/security/snapshot-throws',
      headers: snapshotHeaders,
      payload: { taskId: 'T-801' }
    });
    const snapshotReplay = await snapshotServer.inject({
      method: 'POST',
      url: '/__m0/security/snapshot-throws',
      headers: snapshotHeaders,
      payload: { taskId: 'T-801' }
    });

    expect(snapshotRunCount).toBe(1);
    expect(snapshotFirst.statusCode).toBe(500);
    expect(snapshotReplay.statusCode).toBe(500);
    expect(snapshotReplay.headers['x-idempotency-replayed']).toBe('true');
    expect(snapshotReplay.json()).toEqual(snapshotFirst.json());
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the asynchronous test condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
