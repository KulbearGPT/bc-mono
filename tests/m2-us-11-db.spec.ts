import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresOrderStore, type OrderRecord } from '@blackcat/api/orders';
import { InMemoryAuditSink, type AuditRecord } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T09:00:00.000Z');
const orderId = '00000000-0000-0000-0000-00000000b611';
const customerId = '00000000-0000-0000-0000-00000000a611';
const staffId = '00000000-0000-0000-0000-000000000622';
let tmpRoot = '';
let dataDir = '';
let socketDir = '';
let port = 0;
let pool: Pool;

describe('M2-US-11 PostgreSQL automation control', () => {
  beforeAll(async () => {
    port = 60_300 + (process.pid % 200);
    tmpRoot = await mkdtemp(join(tmpdir(), 'blackcat-m2-automation-'));
    dataDir = join(tmpRoot, 'data');
    socketDir = tmpRoot;
    await execFile('initdb', ['-D', dataDir, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${socketDir}`, '-l', join(tmpRoot, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', socketDir, '-p', String(port), 'blackcat_m2_automation']);
    await execFile('psql', ['-h', socketDir, '-p', String(port), '-d', 'blackcat_m2_automation', '-v', 'ON_ERROR_STOP=1', '-f', 'database/prisma/migrations/000001_p0_baseline/migration.sql']);
    pool = new Pool({ host: socketDir, port, database: 'blackcat_m2_automation', application_name: 'blackcat_m2_automation_test', max: 4 });
    await seed();
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (dataDir) await execFile('pg_ctl', ['-D', dataDir, 'stop', '-m', 'fast']).catch(() => undefined);
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  test('persists pause metadata and audit in one versioned transaction', async () => {
    const store = new PostgresOrderStore({ pool });
    const current = await store.findById(orderId);
    const paused: OrderRecord = {
      ...current!, version: 4, automationState: 'PAUSED', automationVersion: 2,
      automationPausedByStaffId: staffId, automationStaffTaskId: '00000000-0000-0000-0000-00000000c611',
      automationReasonCode: 'STAFF_TAKEOVER', automationScope: 'ALL', automationPausedAt: now.toISOString(),
      automationResumedAt: null, automationExpiresAt: '2026-07-18T09:30:00.000Z', updatedAt: now.toISOString()
    };
    await store.commitAutomationControl({ order: paused, expectedVersion: 3, auditRecord: audit(), auditSink: new InMemoryAuditSink() });
    const snapshot = await pool.query(`SELECT row_version, automation_state, automation_version, automation_reason_code, automation_scope FROM orders WHERE id = $1`, [orderId]);
    const auditCount = await pool.query(`SELECT count(*)::text AS count FROM audit_logs WHERE action = 'PAUSE_ORDER_AUTOMATION' AND target_id = $1`, [orderId]);

    expect(snapshot.rows[0]).toMatchObject({ row_version: 4, automation_state: 'PAUSED', automation_version: 2, automation_reason_code: 'STAFF_TAKEOVER', automation_scope: 'ALL' });
    expect(auditCount.rows[0].count).toBe('1');
    await expect(store.commitAutomationControl({ order: { ...paused, version: 5 }, expectedVersion: 3, auditRecord: audit(), auditSink: new InMemoryAuditSink() }))
      .rejects.toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  });
});

function audit(): AuditRecord {
  return {
    id: crypto.randomUUID(), actorId: staffId, actorStaffId: staffId, actorLevel: 'L2_SUPERVISOR', actorSource: 'DASHBOARD',
    clientId: 'dashboard', interactionId: null, permissionCode: 'order.pause', action: 'PAUSE_ORDER_AUTOMATION', targetType: 'order',
    targetId: orderId, outcome: 'SUCCEEDED', reason: 'STAFF_TAKEOVER', requestId: crypto.randomUUID(), approvalRequestId: null,
    occurredAt: now.toISOString(), beforeSnapshot: { orderVersion: 3 }, afterSnapshot: { orderVersion: 4 }
  };
}

async function seed() {
  await pool.query(`
INSERT INTO users (id, display_name, status, row_version, created_at, updated_at)
VALUES ('${customerId}', 'Customer', 'ACTIVE', 1, now(), now()),
       ('${staffId}', 'Supervisor', 'ACTIVE', 1, now(), now());
INSERT INTO staff_accounts (id, user_id, level, status, role_source, permissions_version, created_at, updated_at)
VALUES ('${staffId}', '${staffId}', 'L2_SUPERVISOR', 'ACTIVE', 'MANUAL', 1, now(), now());
INSERT INTO orders (
  id, public_id, customer_id, active_customer_slot_id, status, row_version,
  game_code_snapshot, service_code_snapshot, region_code_snapshot, billing_unit_minutes, unit_count,
  customer_unit_price_minor, player_unit_payout_minor, amount_minor, expected_player_earning_minor,
  currency, guild_id, channel_id, panel_message_id, submitted_at, created_at, updated_at
) VALUES (
  '${orderId}', 'P-611', '${customerId}', '${customerId}', 'PENDING_DISPATCH', 3,
  'VALORANT', 'ENTERTAINMENT', 'NA', 60, 2, 6000, 4200, 12000, 8400,
  'CNY', '999999999999999999', '444444444444444444', '555555555555555555', now(), now(), now()
);
INSERT INTO staff_tasks (
  id, public_id, type, reason_code, status, row_version, order_id, claimed_by_staff_id,
  context_snapshot, claimed_at, created_at, updated_at
) VALUES (
  '00000000-0000-0000-0000-00000000c611', 'T-611', 'CANCELLATION_ASSIST', 'CUSTOMER_REQUEST', 'CLAIMED', 2,
  '${orderId}', '${staffId}', '{}'::jsonb, now(), now(), now()
);
  `);
}
