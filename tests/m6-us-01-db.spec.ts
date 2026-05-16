import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresSettlementStore,
  createSettlementBatch,
  previewSettlement,
  type SettlementCreateInput
} from '@blackcat/api/settlements';

const execFile = promisify(execFileCallback);
const playerId = '00000000-0000-0000-0000-000000006201';
const customerId = '00000000-0000-0000-0000-000000006202';
const staffId = '00000000-0000-0000-0000-000000006203';
const earningId = '00000000-0000-0000-0000-000000006211';
const orderId = '00000000-0000-0000-0000-000000006221';
const cutoffAt = '2026-07-19T16:00:00.000Z';
let root = '';
let data = '';
let pool: Pool;

function input(overrides: Partial<SettlementCreateInput> = {}): SettlementCreateInput {
  return {
    source: 'MANUAL', scheduleKey: null,
    periodStart: '2026-07-13T16:00:00.000Z', periodEnd: cutoffAt, cutoffAt,
    timeZone: 'Asia/Shanghai', currency: 'CNY', playerUserIds: null, createdByStaffId: staffId,
    ...overrides
  };
}

describe('M6-US-01 PostgreSQL settlement persistence', () => {
  beforeAll(async () => {
    const port = 61_200 + (process.pid % 200);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m6-settlements-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m6_settlements']);
    for (const migration of [
      'database/prisma/migrations/000001_p0_baseline/migration.sql',
      'database/prisma/migrations/000002_m6_settlements/migration.sql'
    ]) {
      await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m6_settlements', '-v', 'ON_ERROR_STOP=1', '-f', migration]);
    }
    pool = new Pool({ host: root, port, database: 'blackcat_m6_settlements', max: 8 });
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE settlement_payment_results,settlement_item_entries,settlement_items,
      settlement_batches,player_earning_adjustments,player_earnings,orders,staff_accounts,users RESTART IDENTITY CASCADE`);
    await seedBase();
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('serializes two creations and lets only one active batch claim an earning', async () => {
    await insertEarning({ id: earningId, orderId });
    const store = new PostgresSettlementStore(pool);

    const results = await Promise.allSettled([
      createSettlementBatch({ store, input: input() }),
      createSettlementBatch({ store, input: input({ periodStart: '2026-07-12T16:00:00.000Z' }) })
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await pool.query('SELECT id FROM settlement_batches')).rowCount).toBe(1);
    expect((await pool.query('SELECT player_earning_id FROM settlement_item_entries WHERE player_earning_id=$1', [earningId])).rowCount).toBe(1);
  });

  test('returns the same batch from concurrent automatic schedule replays', async () => {
    await insertEarning({ id: earningId, orderId });
    const store = new PostgresSettlementStore(pool);
    const scheduled = input({ source: 'SCHEDULED', scheduleKey: 'weekly-cny' });

    const [first, second] = await Promise.all([
      createSettlementBatch({ store, input: scheduled }),
      createSettlementBatch({ store, input: scheduled })
    ]);

    expect(second.id).toBe(first.id);
    expect((await pool.query('SELECT id FROM settlement_batches')).rowCount).toBe(1);
    expect((await pool.query('SELECT id FROM settlement_item_entries')).rowCount).toBe(1);
  });

  test('database rejects duplicate active membership and permits one replacement after void', async () => {
    await insertEarning({ id: earningId, orderId });
    const store = new PostgresSettlementStore(pool);
    const original = await createSettlementBatch({ store, input: input() });
    const secondBatchId = '00000000-0000-0000-0000-000000006231';
    const secondItemId = '00000000-0000-0000-0000-000000006232';
    await insertEmptyBatch(secondBatchId, secondItemId);

    await expect(pool.query(`INSERT INTO settlement_item_entries
      (id,settlement_item_id,entry_type,player_earning_id,amount_minor,currency,occurred_at)
      VALUES ('00000000-0000-0000-0000-000000006233',$1,'PLAYER_EARNING',$2,10000,'CNY',$3)`,
      [secondItemId, earningId, cutoffAt])).rejects.toThrow(/active settlement batch/i);

    await pool.query(`UPDATE settlement_batches SET status='VOIDED',voided_at=$2,void_reason='operator correction' WHERE id=$1`, [original.id, cutoffAt]);
    const replacement = await createSettlementBatch({ store, input: input({ replacementForBatchId: original.id }) });
    const relation = await pool.query('SELECT status,replacement_batch_id FROM settlement_batches WHERE id=$1', [original.id]);
    expect(relation.rows[0]).toEqual({ status: 'VOIDED', replacement_batch_id: replacement.id });
    await expect(createSettlementBatch({ store, input: input({ periodStart: '2026-07-11T16:00:00.000Z', replacementForBatchId: original.id }) }))
      .rejects.toThrow(/replacement/i);
  });

  test('rolls back batch, item, and prior entries when a later entry insert fails', async () => {
    await insertEarning({ id: earningId, orderId });
    const secondOrderId = '00000000-0000-0000-0000-000000006222';
    const secondEarningId = '00000000-0000-0000-0000-000000006212';
    await insertOrder(secondOrderId, 'P-6222');
    await insertEarning({ id: secondEarningId, orderId: secondOrderId });
    await pool.query(`CREATE FUNCTION fail_second_settlement_entry() RETURNS trigger AS $$ BEGIN
      IF NEW.player_earning_id='${secondEarningId}'::uuid THEN RAISE EXCEPTION 'injected partial failure'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_second_settlement_entry BEFORE INSERT ON settlement_item_entries
      FOR EACH ROW EXECUTE FUNCTION fail_second_settlement_entry()`);

    await expect(createSettlementBatch({ store: new PostgresSettlementStore(pool), input: input() }))
      .rejects.toThrow(/injected partial failure/i);
    expect((await pool.query('SELECT id FROM settlement_batches')).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM settlement_items')).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM settlement_item_entries')).rowCount).toBe(0);
    await pool.query('DROP TRIGGER test_fail_second_settlement_entry ON settlement_item_entries; DROP FUNCTION fail_second_settlement_entry()');
  });

  test('enforces one currency, non-negative net payable, and append-only entries', async () => {
    await insertEarning({ id: earningId, orderId });
    const batch = await createSettlementBatch({ store: new PostgresSettlementStore(pool), input: input() });
    const itemId = batch.items[0]!.id;
    const entryId = batch.items[0]!.entries[0]!.id;

    await expect(pool.query('UPDATE settlement_items SET currency=$2 WHERE id=$1', [itemId, 'USD']))
      .rejects.toThrow(/currency/i);
    await expect(pool.query('UPDATE settlement_items SET net_amount_minor=-1 WHERE id=$1', [itemId]))
      .rejects.toThrow(/snapshot|check constraint|violates/i);
    await expect(pool.query('UPDATE settlement_items SET gross_amount_minor=9000,net_amount_minor=9000 WHERE id=$1', [itemId]))
      .rejects.toThrow(/snapshot/i);
    await expect(pool.query('UPDATE settlement_batches SET gross_amount_minor=9000,net_amount_minor=9000 WHERE id=$1', [batch.id]))
      .rejects.toThrow(/snapshot/i);
    await expect(pool.query('UPDATE settlement_item_entries SET amount_minor=1 WHERE id=$1', [entryId]))
      .rejects.toThrow(/append-only/i);
    await expect(pool.query('DELETE FROM settlement_item_entries WHERE id=$1', [entryId]))
      .rejects.toThrow(/append-only/i);
    await expect(pool.query('DELETE FROM settlement_items WHERE id=$1', [itemId]))
      .rejects.toThrow(/cannot be deleted/i);
    await expect(pool.query('DELETE FROM settlement_batches WHERE id=$1', [batch.id]))
      .rejects.toThrow(/cannot be deleted/i);
    await expect(pool.query(`INSERT INTO settlement_item_entries
      (id,settlement_item_id,entry_type,amount_minor,currency,occurred_at)
      VALUES ('00000000-0000-0000-0000-000000006253',$1,'PLAYER_EARNING',1,'CNY',$2)`, [itemId, cutoffAt]))
      .rejects.toThrow(/source|check constraint/i);
    await expect(pool.query(`INSERT INTO settlement_item_entries
      (id,settlement_item_id,entry_type,player_earning_id,amount_minor,currency,occurred_at)
      VALUES ('00000000-0000-0000-0000-000000006254',$1,'EARNING_ADJUSTMENT',$2,10000,'CNY',$3)`,
    [itemId, earningId, cutoffAt])).rejects.toThrow(/source|check constraint/i);
  });

  test('rejects an empty scheduled key at the database boundary', async () => {
    await expect(pool.query(`INSERT INTO settlement_batches
      (id,public_id,source,schedule_key,period_start,period_end,time_zone,currency,
       gross_amount_minor,adjustment_amount_minor,net_amount_minor,created_by_staff_id,updated_at)
      VALUES ('00000000-0000-0000-0000-000000006251','SET-EMPTY-KEY','SCHEDULED','',
       '2026-07-13T16:00:00.000Z',$1,'Asia/Shanghai','CNY',0,0,0,$2,$1)`, [cutoffAt, staffId]))
      .rejects.toThrow(/schedule|check constraint/i);
  });

  test('rejects PENDING as a settlement payment result', async () => {
    await insertEarning({ id: earningId, orderId });
    const batch = await createSettlementBatch({ store: new PostgresSettlementStore(pool), input: input() });
    await expect(pool.query(`INSERT INTO settlement_payment_results
      (id,settlement_item_id,result,amount_minor,currency,idempotency_key,recorded_by_staff_id,recorded_at)
      VALUES ('00000000-0000-0000-0000-000000006252',$1,'PENDING',10000,'CNY','m6:pending-result',$2,$3)`,
    [batch.items[0]!.id, staffId, cutoffAt])).rejects.toThrow(/SettlementPaymentResultStatus|invalid input value/i);
  });

  test('defers a negative-only paid adjustment then applies it with a later positive earning', async () => {
    await insertEarning({ id: earningId, orderId, status: 'PAID', paidAt: '2026-07-18T16:00:00.000Z' });
    const adjustmentId = '00000000-0000-0000-0000-000000006241';
    await pool.query(`INSERT INTO player_earning_adjustments
      (id,player_earning_id,type,amount_minor,currency,reason,idempotency_key,created_at)
      VALUES ($1,$2,'CORRECTION_DEBIT',1200,'CNY','late debit','m6:late-debit',$3)`, [adjustmentId, earningId, '2026-07-19T15:00:00.000Z']);
    const store = new PostgresSettlementStore(pool);

    const deferred = await previewSettlement({ store, input: input() });
    expect(deferred).toMatchObject({ items: [], deferredAdjustmentMinor: -1200, netAmountMinor: 0 });
    expect((await pool.query('SELECT id FROM settlement_item_entries WHERE player_earning_adjustment_id=$1', [adjustmentId])).rowCount).toBe(0);

    const positiveOrderId = '00000000-0000-0000-0000-000000006223';
    const positiveEarningId = '00000000-0000-0000-0000-000000006213';
    await insertOrder(positiveOrderId, 'P-6223');
    await insertEarning({ id: positiveEarningId, orderId: positiveOrderId, amountMinor: 10000, confirmedAt: '2026-07-19T15:30:00.000Z' });
    const batch = await createSettlementBatch({ store, input: input() });

    expect(batch.items[0]).toMatchObject({ playerUserId: playerId, grossAmountMinor: 10000, adjustmentAmountMinor: -1200, netAmountMinor: 8800 });
    expect(batch.items[0]!.entries.map((entry) => entry.playerEarningId).filter(Boolean)).toEqual([positiveEarningId]);
    expect(batch.items[0]!.entries.some((entry) => entry.playerEarningAdjustmentId === adjustmentId)).toBe(true);

    const duplicateBatchId = '00000000-0000-0000-0000-000000006261';
    const duplicateItemId = '00000000-0000-0000-0000-000000006262';
    await insertEmptyBatch(duplicateBatchId, duplicateItemId);
    await expect(pool.query(`INSERT INTO settlement_item_entries
      (id,settlement_item_id,entry_type,player_earning_adjustment_id,amount_minor,currency,occurred_at)
      VALUES ('00000000-0000-0000-0000-000000006263',$1,'EARNING_ADJUSTMENT',$2,-1200,'CNY',$3)`,
    [duplicateItemId, adjustmentId, cutoffAt])).rejects.toThrow(/active settlement batch/i);
  });
});

async function seedBase(): Promise<void> {
  await pool.query(`INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
    ($1,'Player','ACTIVE',1,now(),now()),($2,'Customer','ACTIVE',1,now(),now()),($3,'Operator','ACTIVE',1,now(),now())`,
  [playerId, customerId, staffId]);
  await pool.query(`INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
    VALUES ($1,$1,'L3_OPERATIONS','ACTIVE','MANUAL',1,now(),now())`, [staffId]);
  await insertOrder(orderId, 'P-6221');
}

async function insertOrder(id: string, publicId: string): Promise<void> {
  await pool.query(`INSERT INTO orders
    (id,public_id,customer_id,player_id,status,row_version,currency,amount_minor,guild_id,channel_id,panel_message_id,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'COMPLETED',8,'CNY',12000,'900000000000000001',$5,$6,$7,$7)`,
  [id, publicId, customerId, playerId, `channel-${publicId}`, `panel-${publicId}`, '2026-07-19T11:00:00.000Z']);
}

async function insertEarning(options: {
  id: string;
  orderId: string;
  amountMinor?: number;
  status?: 'CONFIRMED' | 'PAID';
  confirmedAt?: string;
  paidAt?: string | null;
}): Promise<void> {
  await pool.query(`INSERT INTO player_earnings
    (id,order_id,player_user_id,base_units,unit_payout_minor,amount_minor,currency,status,row_version,confirmed_by_staff_id,confirmed_at,paid_at,created_at,updated_at)
    VALUES ($1,$2,$3,1,$4,$4,'CNY',$5,1,$6,$7,$8,'2026-07-19T11:00:00.000Z','2026-07-19T11:00:00.000Z')`,
  [options.id, options.orderId, playerId, options.amountMinor ?? 10000, options.status ?? 'CONFIRMED', staffId,
    options.confirmedAt ?? '2026-07-19T12:00:00.000Z', options.paidAt ?? null]);
}

async function insertEmptyBatch(batchId: string, itemId: string): Promise<void> {
  await pool.query(`INSERT INTO settlement_batches
    (id,public_id,source,period_start,period_end,time_zone,currency,gross_amount_minor,adjustment_amount_minor,net_amount_minor,status,row_version,created_by_staff_id,created_at,updated_at)
    VALUES ($1,'SET-DIRECT','MANUAL',$2,$3,'Asia/Shanghai','CNY',10000,0,10000,'DRAFT',1,$4,$3,$3)`,
  [batchId, '2026-07-12T16:00:00.000Z', cutoffAt, staffId]);
  await pool.query(`INSERT INTO settlement_items
    (id,settlement_batch_id,player_user_id,gross_amount_minor,adjustment_amount_minor,net_amount_minor,currency,payment_status,row_version,created_at,updated_at)
    VALUES ($1,$2,$3,10000,0,10000,'CNY','PENDING',1,$4,$4)`,
  [itemId, batchId, playerId, cutoffAt]);
}
