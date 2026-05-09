import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresPlayerEarningStore } from '@blackcat/api/player-earnings';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T16:30:00.000Z');
let root = ''; let data = ''; let pool: Pool;
const earningId = '00000000-0000-0000-0000-000000003910';
const staffId = '00000000-0000-0000-0000-000000003911';

describe('M3-US-04 PostgreSQL player earnings', () => {
  beforeAll(async () => {
    const port = 60_900 + (process.pid % 200);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m3-earnings-')); data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m3_earnings']);
    await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m3_earnings', '-v', 'ON_ERROR_STOP=1', '-f', 'database/prisma/migrations/000001_p0_baseline/migration.sql']);
    pool = new Pool({ host: root, port, database: 'blackcat_m3_earnings' });
    await seed();
  }, 30_000);
  afterAll(async () => { await pool?.end().catch(() => undefined); if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined); if (root) await rm(root, { recursive: true, force: true }); });

  test('transitions state and appends a reversal while preserving the original earning', async () => {
    const store = new PostgresPlayerEarningStore(pool);
    await store.mutate({ earningId, expectedVersion: 1, action: 'CONFIRM', reason: 'reviewed',
      idempotencyKey: 'earning:confirm:3910', actorStaffId: staffId, now });
    await store.mutate({ earningId, expectedVersion: 2, action: 'MARK_PAID', reason: 'manual payment recorded',
      idempotencyKey: 'earning:paid:3910', actorStaffId: staffId, now });
    const reversed = await store.mutate({ earningId, expectedVersion: 3, action: 'CREATE_REVERSAL',
      reversalAmount: { amountMinor: 2400, currency: 'CNY' }, reason: 'partial refund',
      idempotencyKey: 'earning:reversal:3910', actorStaffId: staffId, now });
    expect(reversed).toMatchObject({ resultType: 'ADJUSTMENT_CREATED',
      playerEarning: { amountMinor: 8400, netAmountMinor: 6000, status: 'PAID', version: 4 },
      adjustment: { amountMinor: 2400, type: 'REVERSAL_DEBIT' } });
    const facts = await pool.query(`SELECT pe.amount_minor::text, pe.status, pe.row_version,
      count(pea.id)::int AS adjustment_count FROM player_earnings pe
      LEFT JOIN player_earning_adjustments pea ON pea.player_earning_id = pe.id
      WHERE pe.id = $1 GROUP BY pe.id`, [earningId]);
    expect(facts.rows[0]).toEqual({ amount_minor: '8400', status: 'PAID', row_version: 4, adjustment_count: 1 });
    expect((await store.list({ playerId: '00000000-0000-0000-0000-000000003912', limit: 10 }))[0]?.netAmountMinor).toBe(6000);
  });
});

async function seed() {
  const playerId = '00000000-0000-0000-0000-000000003912';
  const customerId = '00000000-0000-0000-0000-000000003913';
  const orderId = '00000000-0000-0000-0000-000000003914';
  await pool.query(`INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
    ('${playerId}','Player','ACTIVE',1,now(),now()),('${customerId}','Customer','ACTIVE',1,now(),now()),('${staffId}','Operator','ACTIVE',1,now(),now());
    INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
    VALUES ('${staffId}','${staffId}','L3_OPERATIONS','ACTIVE','MANUAL',1,now(),now());
    INSERT INTO discord_accounts (id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at)
    VALUES ('00000000-0000-0000-0000-000000003915','${playerId}','900000000000000001','900000000000000041',now(),now(),now());
    INSERT INTO orders (id,public_id,customer_id,player_id,status,row_version,currency,amount_minor,guild_id,channel_id,panel_message_id,created_at,updated_at)
    VALUES ('${orderId}','P-3914','${customerId}','${playerId}','COMPLETED',8,'CNY',12000,'900000000000000001','900000000000000003','900000000000000004',now(),now());
    INSERT INTO player_earnings (id,order_id,player_user_id,base_units,unit_payout_minor,amount_minor,currency,status,row_version,created_at,updated_at)
    VALUES ('${earningId}','${orderId}','${playerId}',2,4200,8400,'CNY','PENDING',1,now(),now());`);
}
