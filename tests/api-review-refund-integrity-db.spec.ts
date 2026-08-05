import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresAdminOrderActionStore, refundOrder } from '@blackcat/api/admin-order-actions';
import type { AuditRecord, ActorContext } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const customerId = '00000000-0000-0000-0000-000000020001';
const playerId = '00000000-0000-0000-0000-000000020002';
const staffUserId = '00000000-0000-0000-0000-000000020003';
const staffId = '00000000-0000-0000-0000-000000020004';
const orderId = '00000000-0000-0000-0000-000000020005';
const chargeId = '00000000-0000-0000-0000-000000020006';
const walletId = '00000000-0000-0000-0000-000000020007';
const now = new Date('2026-08-12T15:00:00.000Z');
let root = '';
let data = '';
let pool: Pool;

const actor: ActorContext = {
  actorUserId: staffUserId,
  actorStaffId: staffId,
  actorLevel: 'L4_ADMIN_OWNER',
  actorSource: 'DASHBOARD',
  clientId: 'DASHBOARD',
  interactionId: null,
  guildId: '900000000000020001',
  discordUserId: null,
  permissionsVersion: 1
};

describe('API review standalone refund integrity', () => {
  beforeAll(async () => {
    const port = 62_500 + (process.pid % 100);
    root = await mkdtemp(join(tmpdir(), 'blackcat-refund-integrity-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_refund_integrity']);
    for (const directory of (await readdir('database/prisma/migrations')).sort()) {
      await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_refund_integrity', '-v', 'ON_ERROR_STOP=1', '-f', join('database/prisma/migrations', directory, 'migration.sql')]);
    }
    pool = new Pool({ host: root, port, database: 'blackcat_refund_integrity', max: 4 });
  }, 45_000);

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users CASCADE');
    await pool.query(`INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
      ($1,'Customer','ACTIVE',1,$4,$4),($2,'Player','ACTIVE',1,$4,$4),($3,'Staff','ACTIVE',1,$4,$4)`,
    [customerId, playerId, staffUserId, now]);
    await pool.query(`INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
      VALUES ($1,$2,'L4_ADMIN_OWNER','ACTIVE','MANUAL',1,$3,$3)`, [staffId, staffUserId, now]);
    await pool.query(`INSERT INTO orders
      (id,public_id,customer_id,player_id,status,row_version,billing_unit_minutes,unit_count,customer_unit_price_minor,
       player_unit_payout_minor,amount_minor,expected_player_earning_minor,currency,guild_id,completed_at,created_at,updated_at)
      VALUES ($1,'P-REFUND-INTEGRITY',$2,$3,'COMPLETED',9,60,1,200000,0,200000,0,'CAT',$4,$5,$5,$5)`,
    [orderId, customerId, playerId, actor.guildId, now]);
    await pool.query(`INSERT INTO wallet_accounts (id,user_id,currency,status,row_version,created_at,updated_at)
      VALUES ($1,$2,'CAT','ACTIVE',1,$3,$3)`, [walletId, customerId, now]);
    await pool.query(`INSERT INTO external_transactions
      (id,provider,type,user_id,order_id,external_ref,idempotency_key,amount_minor,currency,status,initiated_at,settled_at,created_at,updated_at)
      VALUES ($1,'INTERNAL_WALLET','ORDER_CHARGE',$2,$3,'charge-refund-integrity','charge:refund-integrity',200000,'CAT','SUCCEEDED',$4,$4,$4,$4)`,
    [chargeId, customerId, orderId, now]);
    await pool.query(`INSERT INTO consumption_entries
      (id,user_id,entry_type,direction,order_id,external_transaction_id,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at,created_at)
      VALUES ('00000000-0000-0000-0000-000000020008',$1,'ORDER_CHARGE','DEBIT',$2,$3,200000,'CAT','ORDER',$2,'consumption:refund-integrity',$4,$4)`,
    [customerId, orderId, chargeId, now]);
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('serializes different idempotency keys and never credits more than the captured charge', async () => {
    const store = new PostgresAdminOrderActionStore({ pool });
    const first = await stage(store, 120_000, 'refund:integrity:first');
    const second = await stage(store, 100_000, 'refund:integrity:second');
    const results = await Promise.allSettled([
      first.commit(audit('00000000-0000-0000-0000-000000020011', 'refund:integrity:first')),
      second.commit(audit('00000000-0000-0000-0000-000000020012', 'refund:integrity:second'))
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const facts = await pool.query(`SELECT
      COALESCE((SELECT SUM(amount_minor) FROM refunds WHERE status='SUCCEEDED'),0)::int refunded,
      COALESCE((SELECT SUM(amount_minor) FROM wallet_entries WHERE entry_type='ORDER_REFUND_CREDIT'),0)::int credited,
      (SELECT count(*) FROM refunds)::int refund_count,
      (SELECT count(*) FROM audit_logs)::int audit_count`);
    expect(facts.rows[0].refunded).toBeLessThanOrEqual(200_000);
    expect(facts.rows[0]).toMatchObject({ credited: facts.rows[0].refunded, refund_count: 1, audit_count: 1 });
  });
});

async function stage(store: PostgresAdminOrderActionStore, amountMinor: number, idempotencyKey: string) {
  return refundOrder({
    orderStore: store,
    orderId,
    expectedVersion: 9,
    amount: { amountMinor, currency: 'CAT' },
    reasonCode: 'USER_REQUEST',
    evidenceNote: 'Verified standalone partial refund.',
    actor,
    staffLevel: 'L4_ADMIN_OWNER',
    idempotencyKey,
    now
  });
}

function audit(id: string, idempotencyKey: string): AuditRecord {
  return {
    id,
    actorId: staffUserId,
    actorStaffId: staffId,
    actorLevel: 'L4_ADMIN_OWNER',
    actorSource: 'DASHBOARD',
    clientId: 'DASHBOARD',
    interactionId: null,
    permissionCode: 'refund.execute',
    action: 'REFUND_ORDER',
    targetType: 'order',
    targetId: orderId,
    outcome: 'SUCCEEDED',
    reason: 'USER_REQUEST',
    requestId: `req:${idempotencyKey}`,
    idempotencyKey,
    approvalRequestId: null,
    occurredAt: now.toISOString(),
    changes: [{ targetType: 'order', targetId: orderId, changeType: 'APPEND', beforeSnapshot: null,
      afterSnapshot: { amountMinor: idempotencyKey }, changedFields: ['refund'] }]
  };
}
