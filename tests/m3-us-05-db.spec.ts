import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresAccountStore } from '@blackcat/api/accounts';
import { PostgresCommissionStore } from '@blackcat/api/commissions';

const execFile = promisify(execFileCallback);
let root = ''; let data = ''; let pool: Pool;
const beneficiaryId = '00000000-0000-0000-0000-000000004210';
const otherBeneficiaryId = '00000000-0000-0000-0000-000000004211';
const customerId = '00000000-0000-0000-0000-000000004212';
const staffId = '00000000-0000-0000-0000-000000004213';
const commissionId = '00000000-0000-0000-0000-000000004214';

describe('M3-US-05 PostgreSQL private financial history', () => {
  beforeAll(async () => {
    const port = 61_100 + (process.pid % 200); root = await mkdtemp(join(tmpdir(), 'blackcat-m3-history-')); data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m3_history']);
    await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m3_history', '-v', 'ON_ERROR_STOP=1', '-f', 'database/prisma/migrations/000001_p0_baseline/migration.sql']);
    pool = new Pool({ host: root, port, database: 'blackcat_m3_history' }); await seed();
  }, 30_000);
  afterAll(async () => { await pool?.end().catch(() => undefined); if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined); if (root) await rm(root, { recursive: true, force: true }); });

  test('paginates consumption facts without duplicates', async () => {
    const store = new PostgresAccountStore({ pool });
    const first = await store.listConsumptions({ userId: customerId, cursor: null, limit: 2 });
    expect(first.items.map((item) => item.type)).toEqual(['REVERSAL', 'GIFT']); expect(first.nextCursor).toBeTruthy();
    const second = await store.listConsumptions({ userId: customerId, cursor: decode(first.nextCursor!), limit: 2 });
    expect(second.items.map((item) => item.type)).toEqual(['ORDER']);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
  });

  test('returns beneficiary-only masked commissions and net adjustment totals', async () => {
    const store = new PostgresAccountStore({ pool });
    const page = await store.listBeneficiaryCommissions({ userId: beneficiaryId, cursor: null, limit: 10 });
    expect(page).toMatchObject({ summary: { pendingMinor: 120 }, items: [{ id: commissionId,
      sourceCustomerMasked: { display: 'Customer ***' }, amountMinor: 200, netAmountMinor: 120 }] });
    expect(JSON.stringify(page)).not.toContain(customerId);
    expect((await store.listBeneficiaryCommissions({ userId: otherBeneficiaryId, cursor: null, limit: 10 })).items)
      .toEqual([expect.objectContaining({ id: '00000000-0000-0000-0000-000000004215' })]);
  });

  test('persists an idempotent append-only reversal and keeps the original amount', async () => {
    const store = new PostgresCommissionStore(pool);
    const input = { commissionId, expectedVersion: 1, action: 'CREATE_REVERSAL' as const,
      reversalAmount: { amountMinor: 20, currency: 'CNY' }, reason: 'partial refund',
      idempotencyKey: 'commission:db:reverse:4214', actorStaffId: staffId, now: new Date('2026-07-18T19:00:00Z') };
    expect(await store.mutate(input)).toMatchObject({ commission: { amountMinor: 200, netAmountMinor: 100, version: 2 } });
    expect(await store.mutate(input)).toMatchObject({ commission: { amountMinor: 200, netAmountMinor: 100, version: 2 } });
    const facts = await pool.query(`SELECT c.amount_minor::text,c.row_version,count(ca.id)::int AS adjustments
      FROM commissions c LEFT JOIN commission_adjustments ca ON ca.commission_id=c.id WHERE c.id=$1 GROUP BY c.id`, [commissionId]);
    expect(facts.rows[0]).toEqual({ amount_minor: '200', row_version: 2, adjustments: 2 });
  });
});

function decode(value: string): { occurredAt: string; id: string } {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { occurredAt: string; id: string };
}

async function seed() {
  await pool.query(`INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
    ('${beneficiaryId}','Player A','ACTIVE',1,now(),now()),('${otherBeneficiaryId}','Player B','ACTIVE',1,now(),now()),
    ('${customerId}','Hidden Customer','ACTIVE',1,now(),now()),('${staffId}','Operator','ACTIVE',1,now(),now());
    INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
    VALUES ('${staffId}','${staffId}','L3_OPERATIONS','ACTIVE','MANUAL',1,now(),now());
    INSERT INTO consumption_entries (id,user_id,entry_type,direction,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at) VALUES
    ('00000000-0000-0000-0000-000000004220','${customerId}','ORDER_CHARGE','DEBIT',10000,'CNY','ORDER','00000000-0000-0000-0000-000000004230','history:order','2026-07-18T10:00:00Z'),
    ('00000000-0000-0000-0000-000000004221','${customerId}','GIFT_CHARGE','DEBIT',3000,'CNY','GIFT','00000000-0000-0000-0000-000000004231','history:gift','2026-07-18T11:00:00Z'),
    ('00000000-0000-0000-0000-000000004222','${customerId}','REFUND_REVERSAL','CREDIT',1000,'CNY','REFUND','00000000-0000-0000-0000-000000004232','history:refund','2026-07-18T12:00:00Z'),
    ('00000000-0000-0000-0000-000000004223','${beneficiaryId}','GIFT_CHARGE','DEBIT',3000,'CNY','GIFT','00000000-0000-0000-0000-000000004233','history:other-gift','2026-07-18T12:30:00Z');
    INSERT INTO referral_program_versions (id,program_type,version,status,active_program_key,award_mode,rate_bps,currency,eligible_order_spend,eligible_gift_spend,created_by_staff_id,activated_at,created_at)
    VALUES ('00000000-0000-0000-0000-000000004240','PLAYER_LIFETIME',1,'ACTIVE','PLAYER_LIFETIME','NET_SPEND_BPS',200,'CNY',true,true,'${staffId}',now(),now());
    INSERT INTO referral_attributions (id,program_version_id,beneficiary_user_id,referred_user_id,status,row_version,active_attribution_key,source_type,bound_by_staff_id,eligibility_checked_at,bound_at,created_at) VALUES
    ('00000000-0000-0000-0000-000000004241','00000000-0000-0000-0000-000000004240','${beneficiaryId}','${customerId}','ACTIVE',1,'${customerId}','ADMIN_MANUAL','${staffId}',now(),now(),now()),
    ('00000000-0000-0000-0000-000000004242','00000000-0000-0000-0000-000000004240','${otherBeneficiaryId}','${beneficiaryId}','ACTIVE',1,'${beneficiaryId}','ADMIN_MANUAL','${staffId}',now(),now(),now());
    INSERT INTO commissions (id,referral_attribution_id,beneficiary_user_id,source_consumption_entry_id,program_type_snapshot,program_version_snapshot,award_mode_snapshot,base_amount_minor,rate_bps,amount_minor,currency,status,row_version,created_at,updated_at) VALUES
    ('${commissionId}','00000000-0000-0000-0000-000000004241','${beneficiaryId}','00000000-0000-0000-0000-000000004220','PLAYER_LIFETIME',1,'NET_SPEND_BPS',10000,200,200,'CNY','PENDING',1,'2026-07-18T13:00:00Z','2026-07-18T13:00:00Z'),
    ('00000000-0000-0000-0000-000000004215','00000000-0000-0000-0000-000000004242','${otherBeneficiaryId}','00000000-0000-0000-0000-000000004223','PLAYER_LIFETIME',1,'NET_SPEND_BPS',3000,200,60,'CNY','PENDING',1,'2026-07-18T14:00:00Z','2026-07-18T14:00:00Z');
    INSERT INTO commission_adjustments (id,commission_id,type,amount_minor,currency,reason,idempotency_key,created_by_staff_id,created_at)
    VALUES ('00000000-0000-0000-0000-000000004250','${commissionId}','REVERSAL_DEBIT',80,'CNY','refund','commission:seed:adjustment','${staffId}',now());`);
}
