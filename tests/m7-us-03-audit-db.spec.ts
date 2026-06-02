import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresAuditSink, type AuditRecord } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const auditId = '00000000-0000-0000-0000-000000007311';
let root = '';
let data = '';
let pool: Pool;

function record(invalidChange = false): AuditRecord {
  return {
    id: auditId,
    actorId: null,
    actorStaffId: null,
    actorLevel: null,
    actorSource: 'SYSTEM_JOB',
    clientId: 'WORKER',
    interactionId: null,
    permissionCode: 'operations.failure.report',
    action: 'PROCESS_JOB',
    targetType: 'outbox_event',
    targetId: '00000000-0000-0000-0000-000000007312',
    outcome: 'SUCCEEDED',
    reason: null,
    requestId: 'request-m7-audit-db',
    approvalRequestId: null,
    idempotencyKey: 'job:m7:audit:0001',
    jobId: '00000000-0000-0000-0000-000000007312',
    triggerSource: 'OUTBOX',
    retryAttempt: 2,
    occurredAt: '2026-07-21T12:00:00.000Z',
    changes: [{
      targetType: 'outbox_event',
      targetId: '00000000-0000-0000-0000-000000007312',
      changeType: invalidChange ? 'BROKEN' as 'STATE_TRANSITION' : 'STATE_TRANSITION',
      beforeSnapshot: { status: 'PROCESSING' },
      afterSnapshot: { status: 'COMPLETED' },
      changedFields: ['status']
    }]
  };
}

describe('M7-US-03 PostgreSQL audit header/change transaction', () => {
  beforeAll(async () => {
    const port = 61_700 + (process.pid % 200);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m7-audit-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', [
      '-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start'
    ]);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m7_audit']);
    for (const directory of (await readdir('database/prisma/migrations')).sort()) {
      await execFile('psql', [
        '-h', root, '-p', String(port), '-d', 'blackcat_m7_audit', '-v', 'ON_ERROR_STOP=1',
        '-f', join('database/prisma/migrations', directory, 'migration.sql')
      ]);
    }
    pool = new Pool({ host: root, port, database: 'blackcat_m7_audit', max: 4 });
  }, 40_000);

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE audit_log_changes,audit_logs CASCADE');
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('commits header and ordered child changes together', async () => {
    await new PostgresAuditSink({ client: pool }).append(record());
    const header = await pool.query(
      'SELECT idempotency_key,job_id,trigger_source,retry_attempt FROM audit_logs WHERE id=$1',
      [auditId]
    );
    const changes = await pool.query(
      'SELECT sequence,target_type,change_type,changed_fields FROM audit_log_changes WHERE audit_log_id=$1',
      [auditId]
    );
    expect(header.rows[0]).toMatchObject({
      idempotency_key: 'job:m7:audit:0001',
      job_id: '00000000-0000-0000-0000-000000007312',
      trigger_source: 'OUTBOX',
      retry_attempt: 2
    });
    expect(changes.rows).toEqual([expect.objectContaining({
      sequence: 1,
      target_type: 'outbox_event',
      change_type: 'STATE_TRANSITION',
      changed_fields: ['status']
    })]);
  });

  test('rolls back the header when a child change is invalid', async () => {
    await expect(new PostgresAuditSink({ client: pool }).append(record(true)))
      .rejects.toThrow(/AuditChangeType|invalid input/i);
    expect((await pool.query('SELECT id FROM audit_logs WHERE id=$1', [auditId])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM audit_log_changes WHERE audit_log_id=$1', [auditId])).rowCount)
      .toBe(0);
  });
});
