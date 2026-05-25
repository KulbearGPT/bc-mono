import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import {
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
  registerSecureWriteRoute,
  type StaffDirectory
} from '@blackcat/api/security';
import {
  normalizeAuditChanges,
  redactAuditSnapshot
} from '@blackcat/api/audit-changes';
import { InMemoryOutboxStore, OutboxWorker, type OutboxJob } from '@blackcat/api/outbox';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};
const staffDirectory: StaffDirectory = {
  resolveByDiscord() {
    return {
      staffId: '00000000-0000-0000-0000-000000007301',
      userId: '00000000-0000-0000-0000-000000007302',
      level: 'L1_SUPPORT',
      permissionsVersion: 1,
      status: 'ACTIVE'
    };
  }
};
const headers = {
  authorization: 'Bearer valid-bot-token',
  'x-client-source': 'DISCORD_BOT',
  'x-actor-discord-user-id': '111111111111111111',
  'x-actor-guild-id': '999999999999999999',
  'x-discord-interaction-id': '777777777777777777',
  'idempotency-key': 'discord:m7:audit:probe:1'
};

describe('M7-US-03 universal mutation audit envelope', () => {
  test('records success, failure, and rejection with stable change semantics', async () => {
    const audit = new InMemoryAuditSink();
    const server = buildApiServer({
      env,
      security: {
        auditSink: audit,
        idempotencyStore: new InMemoryIdempotencyStore(),
        staffDirectory
      }
    });
    registerSecureWriteRoute(server, server.securityOptions!, {
      method: 'POST',
      url: '/__m7/audit-success',
      permission: 'staff_task.claim',
      action: 'UPDATE_PROBE',
      targetType: 'Probe',
      targetId: () => '00000000-0000-0000-0000-000000007303',
      auditSnapshots: () => ({
        beforeSnapshot: { status: 'OLD', authorization: 'Bearer secret' },
        afterSnapshot: { status: 'NEW', cardNumber: '4111111111111111' }
      }),
      auditChanges: (_request, _actor, payload) => [{
        targetType: 'Probe',
        targetId: '00000000-0000-0000-0000-000000007303',
        changeType: 'UPDATE',
        beforeSnapshot: { status: 'OLD', password: 'hidden' },
        afterSnapshot: payload,
        changedFields: ['status']
      }],
      handler: () => ({ status: 'NEW' })
    });
    registerSecureWriteRoute(server, server.securityOptions!, {
      method: 'POST',
      url: '/__m7/audit-failure',
      permission: 'staff_task.claim',
      action: 'FAIL_PROBE',
      targetType: 'Probe',
      mapError: () => ({ statusCode: 422, code: 'PROBE_FAILED', message: 'probe failed' }),
      handler: () => {
        throw new Error('synthetic failure');
      }
    });

    expect((await server.inject({ method: 'POST', url: '/__m7/audit-success', headers })).statusCode)
      .toBe(200);
    expect((await server.inject({
      method: 'POST',
      url: '/__m7/audit-failure',
      headers: { ...headers, 'idempotency-key': 'discord:m7:audit:probe:2' }
    })).statusCode).toBe(422);
    expect((await server.inject({
      method: 'POST',
      url: '/__m7/audit-success',
      headers: { ...headers, authorization: 'Bearer invalid', 'idempotency-key': 'discord:m7:audit:probe:3' }
    })).statusCode).toBe(401);

    expect(audit.records[0]).toMatchObject({
      outcome: 'SUCCEEDED',
      idempotencyKey: 'discord:m7:audit:probe:1',
      changes: [{
        targetType: 'Probe',
        changeType: 'UPDATE',
        changedFields: ['status'],
        beforeSnapshot: { status: 'OLD' },
        afterSnapshot: { status: 'NEW' }
      }]
    });
    expect(JSON.stringify(audit.records[0])).not.toMatch(/secret|4111111111111111|hidden/u);
    expect(audit.records[1]).toMatchObject({
      outcome: 'FAILED',
      idempotencyKey: 'discord:m7:audit:probe:2',
      changes: []
    });
    expect(audit.records[2]).toMatchObject({ outcome: 'REJECTED', changes: [] });
  });

  test('redacts nested secrets, normalizes fields, and caps oversized snapshots', () => {
    expect(redactAuditSnapshot({
      profile: { token: 'secret', displayName: 'Safe' },
      cookie: 'secret',
      items: [{ cvv: '123', value: 1 }]
    })).toEqual({ profile: { displayName: 'Safe' }, items: [{ value: 1 }] });
    const normalized = normalizeAuditChanges([{
      targetType: 'Order',
      targetId: 'order-1',
      changeType: 'UPDATE',
      beforeSnapshot: { status: 'DRAFT' },
      afterSnapshot: { status: 'READY' },
      changedFields: ['status', 'status', ' authorization ']
    }]);
    expect(normalized[0]?.changedFields).toEqual(['authorization', 'status']);
    expect(redactAuditSnapshot({ note: 'x'.repeat(70_000) })).toMatchObject({
      truncated: true,
      byteLength: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
  });

  test('all ordinary API mutation routes use the secure wrapper', () => {
    const sourceRoot = 'apps/api/src';
    const raw: string[] = [];
    for (const file of readdirSync(sourceRoot).filter((name) => name.endsWith('.ts'))) {
      if (file === 'webhooks.ts') continue; // Removed by the explicit M7-US-07 Provider retirement gate.
      const source = readFileSync(join(sourceRoot, file), 'utf8');
      if (/server\.(post|put|patch|delete)\s*\(/u.test(source)) raw.push(file);
    }
    expect(raw).toEqual([]);
  });

  test('records system-job transitions with job, trigger, retry, and affected-object facts', async () => {
    const audit = new InMemoryAuditSink();
    const occurredAt = new Date('2026-07-21T15:00:00.000Z');
    const job: OutboxJob = {
      id: '00000000-0000-0000-0000-000000007304',
      type: 'PANEL_SYNC',
      status: 'PENDING',
      payload: { orderId: '00000000-0000-0000-0000-000000007305' },
      aggregateType: 'order',
      aggregateId: '00000000-0000-0000-0000-000000007305',
      dedupeKey: 'm7:audit:worker:1',
      attempts: 0,
      maxAttempts: 3,
      runAfter: occurredAt.toISOString(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      version: 1,
      createdAt: occurredAt.toISOString(),
      updatedAt: occurredAt.toISOString()
    };
    const store = new InMemoryOutboxStore({ now: occurredAt, jobs: [job] });

    await new OutboxWorker({
      store,
      workerId: 'm7-audit-worker',
      now: () => occurredAt,
      auditSink: audit
    }).runOnce({ PANEL_SYNC: async () => undefined });

    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      actorSource: 'SYSTEM_JOB',
      outcome: 'SUCCEEDED',
      jobId: job.id,
      triggerSource: 'OUTBOX',
      retryAttempt: 1,
      idempotencyKey: `job:${job.id}:1`,
      changes: [
        { targetType: 'outbox_event', targetId: job.id, changeType: 'STATE_TRANSITION' },
        { targetType: 'order', targetId: job.aggregateId, changeType: 'UPDATE' }
      ]
    });
  });
});
