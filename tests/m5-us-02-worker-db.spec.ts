import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresOperationsStore } from '@blackcat/api/operations';
import { PostgresOrderPanelProjectionStore } from '@blackcat/api/worker-adapters';
import { InMemoryAuditSink, type AuditRecord } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T22:00:00.000Z');
const guildId = '900000000000008000';
const orderId = '00000000-0000-0000-0000-000000008001';
const customerId = '00000000-0000-0000-0000-000000008002';
const staffUserId = '00000000-0000-0000-0000-000000008003';
const staffId = '00000000-0000-0000-0000-000000008004';
const oldPanelMessageId = '900000000000008005';
const newPanelMessageId = '900000000000008006';

let root = '';
let data = '';
let pool: Pool;

describe('M5-US-02 PostgreSQL panel recovery', () => {
  beforeAll(async () => {
    const port = 62_100 + (process.pid % 200);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m5-panel-recovery-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m5_panel_recovery']);
    await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m5_panel_recovery', '-v', 'ON_ERROR_STOP=1', '-f', 'database/prisma/migrations/000001_p0_baseline/migration.sql']);
    pool = new Pool({ host: root, port, database: 'blackcat_m5_panel_recovery' });
    await seed();
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('queues and applies a panel repair without changing order or fund facts', async () => {
    const operations = new PostgresOperationsStore(pool);
    const panels = new PostgresOrderPanelProjectionStore(pool);
    const before = await orderFacts();

    const write = await operations.queuePanelRepair({ orderId, guildId, generation: 'req_panel_recovery_db', actorStaffId: staffId, now });
    await write.commit(audit(), new InMemoryAuditSink());

    expect(await panels.getOrderPanelProjection(orderId)).toMatchObject({
      orderId,
      publicId: 'P-8001',
      status: 'PENDING_DISPATCH',
      version: 8,
      panelMessageId: oldPanelMessageId,
      amountMinor: 12_000,
      currency: 'CNY'
    });
    await panels.replacePanelMessageId({ orderId, expectedPanelMessageId: oldPanelMessageId, panelMessageId: newPanelMessageId });

    const outbox = await pool.query(`
      SELECT event_type,status::text,aggregate_id,payload
      FROM outbox_events
      WHERE aggregate_id = $1::uuid AND event_type = 'PANEL_SYNC'
    `, [orderId]);
    expect(outbox.rows).toEqual([{
      event_type: 'PANEL_SYNC',
      status: 'PENDING',
      aggregate_id: orderId,
      payload: { orderId, kind: 'MANUAL_REPAIR' }
    }]);
    expect(await orderFacts()).toEqual({ ...before, panel_message_id: newPanelMessageId });
    await expect(pool.query(`SELECT count(*)::int AS count FROM fund_reservations WHERE order_id = $1::uuid`, [orderId]))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(pool.query(`SELECT action,reason FROM audit_logs WHERE action = 'QUEUE_PANEL_REPAIR'`))
      .resolves.toMatchObject({ rows: [{ action: 'QUEUE_PANEL_REPAIR', reason: 'PANEL_MESSAGE_DELETED' }] });
  });
});

function audit(): AuditRecord {
  return {
    id: crypto.randomUUID(),
    actorId: staffUserId,
    actorStaffId: staffId,
    actorLevel: 'L2_SUPERVISOR',
    actorSource: 'DASHBOARD',
    clientId: 'DASHBOARD',
    interactionId: null,
    permissionCode: 'job.retry',
    action: 'QUEUE_PANEL_REPAIR',
    targetType: 'order',
    targetId: orderId,
    outcome: 'SUCCEEDED',
    reason: 'PANEL_MESSAGE_DELETED',
    requestId: 'req_panel_recovery_db',
    approvalRequestId: null,
    occurredAt: now.toISOString()
  };
}

async function orderFacts() {
  const result = await pool.query(`
    SELECT status::text,row_version,amount_minor::int,currency,panel_message_id
    FROM orders
    WHERE id = $1::uuid
  `, [orderId]);
  return result.rows[0];
}

async function seed() {
  await pool.query(`
    INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
      ('${customerId}','Customer','ACTIVE',1,now(),now()),
      ('${staffUserId}','Supervisor','ACTIVE',1,now(),now());
    INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at) VALUES
      ('${staffId}','${staffUserId}','L2_SUPERVISOR','ACTIVE','MANUAL',1,now(),now());
    INSERT INTO discord_accounts (id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES
      (gen_random_uuid(),'${customerId}','${guildId}','900000000000008002',now(),now(),now());
    INSERT INTO orders
      (id,public_id,customer_id,active_customer_slot_id,status,row_version,game_name_snapshot,service_name_snapshot,
       amount_minor,currency,guild_id,channel_id,panel_message_id,created_at,updated_at)
    VALUES
      ('${orderId}','P-8001','${customerId}','${customerId}','PENDING_DISPATCH',8,'无畏契约','娱乐陪玩',
       12000,'CNY','${guildId}','900000000000008007','${oldPanelMessageId}',now(),now());
  `);
}
