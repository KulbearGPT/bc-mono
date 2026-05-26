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
import { applyCurrentMigrations } from './support/postgres-migrations';

const execFile = promisify(execFileCallback);
const playerId = '00000000-0000-0000-0000-000000006201';
const customerId = '00000000-0000-0000-0000-000000006202';
const staffId = '00000000-0000-0000-0000-000000006203';
const earningId = '00000000-0000-0000-0000-000000006211';
const orderId = '00000000-0000-0000-0000-000000006221';
const cutoffAt = '2026-07-19T16:00:00.000Z';
const guildId = '900000000000000001';
let root = '';
let data = '';
let pool: Pool;

function input(overrides: Partial<SettlementCreateInput> = {}): SettlementCreateInput {
  return {
    guildId,
    source: 'MANUAL', scheduleKey: null,
    periodStart: '2026-07-13T16:00:00.000Z', periodEnd: cutoffAt, cutoffAt,
    timeZone: 'Asia/Shanghai', currency: 'USD', playerUserIds: null, createdByStaffId: staffId,
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
    await applyCurrentMigrations({ host: root, port, database: 'blackcat_m6_settlements' });
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
      VALUES ('00000000-0000-0000-0000-000000006233',$1,'PLAYER_EARNING',$2,10000,'USD',$3)`,
      [secondItemId, earningId, '2026-07-19T12:00:00.000Z'])).rejects.toThrow(/active settlement batch/i);

    const replacementId = '00000000-0000-0000-0000-000000006234';
    await store.void(guildId, original.id, {
      expectedVersion: 1, reason: 'operator correction', actorStaffId: staffId,
      actorLevel: 'L4_ADMIN_OWNER', now: new Date(cutoffAt), replacementBatchId: replacementId,
      replacement: input()
    });
    const replacement = await store.get(guildId, replacementId);
    const relation = await pool.query('SELECT status,replacement_batch_id FROM settlement_batches WHERE id=$1', [original.id]);
    expect(relation.rows[0]).toEqual({ status: 'VOIDED', replacement_batch_id: replacement.id });
    await expect(store.void(guildId, original.id, {
      expectedVersion: 2, reason: 'replace twice', actorStaffId: staffId,
      actorLevel: 'L4_ADMIN_OWNER', now: new Date(cutoffAt), replacementBatchId: '00000000-0000-0000-0000-000000006235',
      replacement: input({ periodStart: '2026-07-11T16:00:00.000Z' })
    })).rejects.toThrow(/voided|status/i);
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

    await expect(pool.query('UPDATE settlement_items SET currency=$2 WHERE id=$1', [itemId, 'EUR']))
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
      VALUES ('00000000-0000-0000-0000-000000006253',$1,'PLAYER_EARNING',1,'USD',$2)`, [itemId, cutoffAt]))
      .rejects.toThrow(/source|check constraint|finalized/i);
    await expect(pool.query(`INSERT INTO settlement_item_entries
      (id,settlement_item_id,entry_type,player_earning_id,amount_minor,currency,occurred_at)
      VALUES ('00000000-0000-0000-0000-000000006254',$1,'EARNING_ADJUSTMENT',$2,10000,'USD',$3)`,
    [itemId, earningId, cutoffAt])).rejects.toThrow(/source|check constraint|finalized/i);
  });

  test('rejects an empty scheduled key at the database boundary', async () => {
    await expect(pool.query(`INSERT INTO settlement_batches
      (id,public_id,guild_id,source,schedule_key,period_start,period_end,cutoff_at,time_zone,currency,
       gross_amount_minor,adjustment_amount_minor,net_amount_minor,created_by_staff_id,updated_at)
      VALUES ('00000000-0000-0000-0000-000000006251','SET-EMPTY-KEY','900000000000000001','SCHEDULED','',
       '2026-07-13T16:00:00.000Z',$1,$1,'Asia/Shanghai','USD',0,0,0,$2,$1)`, [cutoffAt, staffId]))
      .rejects.toThrow(/schedule|check constraint/i);
  });

  test('rejects a settlement entry whose source order belongs to another Guild', async () => {
    const otherOrderId = '00000000-0000-0000-0000-000000006255';
    const otherEarningId = '00000000-0000-0000-0000-000000006256';
    const batchId = '00000000-0000-0000-0000-000000006257';
    const itemId = '00000000-0000-0000-0000-000000006258';
    await insertOrder(otherOrderId, 'P-6255', '900000000000000002');
    await insertEarning({ id: otherEarningId, orderId: otherOrderId });
    await insertEmptyBatch(batchId, itemId);

    await expect(pool.query(`INSERT INTO settlement_item_entries
      (id,settlement_item_id,entry_type,player_earning_id,amount_minor,currency,occurred_at)
      VALUES ('00000000-0000-0000-0000-000000006259',$1,'PLAYER_EARNING',$2,10000,'USD',$3)`,
    [itemId, otherEarningId, '2026-07-19T12:00:00.000Z'])).rejects.toThrow(/Guild|ownership/i);
  });

  test('rejects PENDING as a settlement payment result', async () => {
    await insertEarning({ id: earningId, orderId });
    const batch = await createSettlementBatch({ store: new PostgresSettlementStore(pool), input: input() });
    await expect(pool.query(`INSERT INTO settlement_payment_results
      (id,settlement_item_id,result,amount_minor,currency,idempotency_key,recorded_by_staff_id,recorded_at)
      VALUES ('00000000-0000-0000-0000-000000006252',$1,'PENDING',10000,'USD','m6:pending-result',$2,$3)`,
    [batch.items[0]!.id, staffId, cutoffAt])).rejects.toThrow(/SettlementPaymentResultStatus|invalid input value/i);
  });

  test('defers a negative-only paid adjustment then applies it with a later positive earning', async () => {
    await insertEarning({ id: earningId, orderId, status: 'PAID', paidAt: '2026-07-18T16:00:00.000Z' });
    const adjustmentId = '00000000-0000-0000-0000-000000006241';
    await pool.query(`INSERT INTO player_earning_adjustments
      (id,player_earning_id,type,amount_minor,currency,reason,idempotency_key,created_at)
      VALUES ($1,$2,'CORRECTION_DEBIT',1200,'USD','late debit','m6:late-debit',$3)`, [adjustmentId, earningId, '2026-07-19T15:00:00.000Z']);
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
      VALUES ('00000000-0000-0000-0000-000000006263',$1,'EARNING_ADJUSTMENT',$2,-1200,'USD',$3)`,
    [duplicateItemId, adjustmentId, '2026-07-19T15:00:00.000Z'])).rejects.toThrow(/active settlement batch/i);
  });

  test('rejects source ownership, state, and cutoff mismatches at the database boundary', async () => {
    await insertEarning({ id: earningId, orderId });
    const otherPlayerId = '00000000-0000-0000-0000-000000006204';
    await pool.query(`INSERT INTO users (id,display_name,status,row_version,created_at,updated_at)
      VALUES ($1,'Other Player','ACTIVE',1,now(),now())`, [otherPlayerId]);
    const batchId = '00000000-0000-0000-0000-000000006271';
    const itemId = '00000000-0000-0000-0000-000000006272';
    await insertEmptyBatch(batchId, itemId, otherPlayerId);
    await expect(pool.query(`INSERT INTO settlement_item_entries
      (id,settlement_item_id,entry_type,player_earning_id,amount_minor,currency,occurred_at)
      VALUES ('00000000-0000-0000-0000-000000006273',$1,'PLAYER_EARNING',$2,10000,'USD',$3)`,
    [itemId, earningId, cutoffAt])).rejects.toThrow(/player/i);

    const pendingId = '00000000-0000-0000-0000-000000006274';
    const pendingOrderId = '00000000-0000-0000-0000-000000006275';
    await insertOrder(pendingOrderId, 'P-6275');
    await insertEarning({ id: pendingId, orderId: pendingOrderId, status: 'PENDING', confirmedAt: null });
    await expect(pool.query(`INSERT INTO settlement_item_entries
      (id,settlement_item_id,entry_type,player_earning_id,amount_minor,currency,occurred_at)
      VALUES ('00000000-0000-0000-0000-000000006276',$1,'PLAYER_EARNING',$2,10000,'USD',$3)`,
    [itemId, pendingId, cutoffAt])).rejects.toThrow(/confirmed/i);

    const cutoffBatchId = '00000000-0000-0000-0000-000000006280';
    const cutoffItemId = '00000000-0000-0000-0000-000000006286';
    await insertEmptyBatch(cutoffBatchId, cutoffItemId);
    const lateId = '00000000-0000-0000-0000-000000006277';
    const lateOrderId = '00000000-0000-0000-0000-000000006278';
    await insertOrder(lateOrderId, 'P-6278');
    await insertEarning({ id: lateId, orderId: lateOrderId, confirmedAt: '2026-07-19T16:00:00.001Z' });
    await expect(pool.query(`INSERT INTO settlement_item_entries
      (id,settlement_item_id,entry_type,player_earning_id,amount_minor,currency,occurred_at)
      VALUES ('00000000-0000-0000-0000-000000006279',$1,'PLAYER_EARNING',$2,10000,'USD',$3)`,
    [cutoffItemId, lateId, '2026-07-19T16:00:00.001Z'])).rejects.toThrow(/cutoff/i);
  });

  test('finalizes exact entry, item, and batch totals and freezes the snapshot', async () => {
    await insertEarning({ id: earningId, orderId });
    const batch = await createSettlementBatch({ store: new PostgresSettlementStore(pool), input: input() });
    const persisted = await pool.query('SELECT cutoff_at,snapshot_finalized_at,created_at FROM settlement_batches WHERE id=$1', [batch.id]);
    expect(new Date(persisted.rows[0].cutoff_at).toISOString()).toBe(cutoffAt);
    expect(persisted.rows[0].snapshot_finalized_at).not.toBeNull();
    expect(new Date(persisted.rows[0].created_at).toISOString()).not.toBe(cutoffAt);

    const extraOrderId = '00000000-0000-0000-0000-000000006281';
    const extraEarningId = '00000000-0000-0000-0000-000000006282';
    await insertOrder(extraOrderId, 'P-6281');
    await insertEarning({ id: extraEarningId, orderId: extraOrderId });
    await expect(pool.query(`INSERT INTO settlement_item_entries
      (id,settlement_item_id,entry_type,player_earning_id,amount_minor,currency,occurred_at)
      VALUES ('00000000-0000-0000-0000-000000006283',$1,'PLAYER_EARNING',$2,10000,'USD',$3)`,
    [batch.items[0]!.id, extraEarningId, cutoffAt])).rejects.toThrow(/finalized|snapshot/i);

    const malformedBatchId = '00000000-0000-0000-0000-000000006284';
    const malformedItemId = '00000000-0000-0000-0000-000000006285';
    await insertEmptyBatch(malformedBatchId, malformedItemId);
    await expect(pool.query('UPDATE settlement_batches SET snapshot_finalized_at=now() WHERE id=$1', [malformedBatchId]))
      .rejects.toThrow(/total|snapshot/i);
  });

  test('keeps void terminal and replacement history immutable', async () => {
    await insertEarning({ id: earningId, orderId });
    const store = new PostgresSettlementStore(pool);
    const original = await createSettlementBatch({ store, input: input() });
    const replacementId = '00000000-0000-0000-0000-000000006299';
    await store.void(guildId, original.id, {
      expectedVersion: 1, reason: 'replace', actorStaffId: staffId,
      actorLevel: 'L4_ADMIN_OWNER', now: new Date(cutoffAt), replacementBatchId: replacementId,
      replacement: input()
    });
    const replacement = await store.get(guildId, replacementId);

    await expect(pool.query(`UPDATE settlement_batches SET status='DRAFT',voided_at=NULL,void_reason=NULL WHERE id=$1`, [original.id]))
      .rejects.toThrow(/transition|terminal/i);
    await expect(pool.query('UPDATE settlement_batches SET replacement_batch_id=NULL WHERE id=$1', [original.id]))
      .rejects.toThrow(/replacement|immutable/i);
    expect(replacement.id).toBeTruthy();
  });

  test('rejects values outside the JavaScript safe minor-unit boundary', async () => {
    await insertEarning({ id: earningId, orderId, amountMinor: Number.MAX_SAFE_INTEGER + 1 });
    await expect(previewSettlement({ store: new PostgresSettlementStore(pool), input: input() }))
      .rejects.toThrow(/safe integer|supported range/i);
  });

  test('rejects partially paid voids and direct finalized batch inserts', async () => {
    await insertEarning({ id: earningId, orderId });
    const batch = await createSettlementBatch({ store: new PostgresSettlementStore(pool), input: input() });
    await pool.query(`UPDATE settlement_batches SET status='PENDING_REVIEW' WHERE id=$1`, [batch.id]);
    await pool.query(`UPDATE settlement_batches SET status='APPROVED' WHERE id=$1`, [batch.id]);
    await pool.query(`UPDATE settlement_batches SET status='EXPORTED' WHERE id=$1`, [batch.id]);
    await pool.query(`UPDATE settlement_batches SET status='PARTIALLY_PAID' WHERE id=$1`, [batch.id]);
    await expect(pool.query(`UPDATE settlement_batches SET status='VOIDED',voided_at=now(),void_reason='bad void' WHERE id=$1`, [batch.id]))
      .rejects.toThrow(/transition|partially/i);

    await expect(pool.query(`INSERT INTO settlement_batches
      (id,public_id,guild_id,source,period_start,period_end,cutoff_at,time_zone,currency,gross_amount_minor,
       adjustment_amount_minor,net_amount_minor,status,row_version,snapshot_finalized_at,created_by_staff_id,updated_at)
      VALUES ('00000000-0000-0000-0000-000000006291','SET-DIRECT-FINAL','900000000000000001','MANUAL',
       '2026-07-12T16:00:00.000Z',$1,$1,'Asia/Shanghai','USD',0,0,0,'APPROVED',1,now(),$2,now())`,
    [cutoffAt, staffId])).rejects.toThrow(/insert|draft|finalized/i);
  });

  test('rejects empty snapshot finalization and adjustment from a pending earning', async () => {
    const emptyBatchId = '00000000-0000-0000-0000-000000006292';
    await pool.query(`INSERT INTO settlement_batches
      (id,public_id,guild_id,source,period_start,period_end,cutoff_at,time_zone,currency,gross_amount_minor,
       adjustment_amount_minor,net_amount_minor,status,row_version,created_by_staff_id,updated_at)
      VALUES ($1,'SET-EMPTY-SNAPSHOT','900000000000000001','MANUAL','2026-07-12T16:00:00.000Z',$2,$2,'Asia/Shanghai','USD',0,0,0,'DRAFT',1,$3,now())`,
    [emptyBatchId, cutoffAt, staffId]);
    await expect(pool.query('UPDATE settlement_batches SET snapshot_finalized_at=now() WHERE id=$1', [emptyBatchId]))
      .rejects.toThrow(/empty|item|snapshot/i);

    const pendingId = '00000000-0000-0000-0000-000000006293';
    const pendingOrderId = '00000000-0000-0000-0000-000000006294';
    const adjustmentId = '00000000-0000-0000-0000-000000006295';
    await insertOrder(pendingOrderId, 'P-6294');
    await insertEarning({ id: pendingId, orderId: pendingOrderId, status: 'PENDING', confirmedAt: null });
    await pool.query(`INSERT INTO player_earning_adjustments
      (id,player_earning_id,type,amount_minor,currency,reason,idempotency_key,created_at)
      VALUES ($1,$2,'CORRECTION_CREDIT',100,'USD','premature credit','m6:pending-credit',$3)`,
    [adjustmentId, pendingId, '2026-07-19T14:00:00.000Z']);
    const batchId = '00000000-0000-0000-0000-000000006296';
    const itemId = '00000000-0000-0000-0000-000000006297';
    await insertEmptyBatch(batchId, itemId);
    await expect(pool.query(`INSERT INTO settlement_item_entries
      (id,settlement_item_id,entry_type,player_earning_adjustment_id,amount_minor,currency,occurred_at)
      VALUES ('00000000-0000-0000-0000-000000006298',$1,'EARNING_ADJUSTMENT',$2,100,'USD',$3)`,
    [itemId, adjustmentId, '2026-07-19T14:00:00.000Z'])).rejects.toThrow(/confirmed|paid|status/i);
  });

  test('requires replacement targets to be finalized and non-void', async () => {
    await insertEarning({ id: earningId, orderId });
    const original = await createSettlementBatch({ store: new PostgresSettlementStore(pool), input: input() });
    await pool.query(`UPDATE settlement_batches SET status='VOIDED',voided_at=now(),void_reason='replace' WHERE id=$1`, [original.id]);
    const targetId = '00000000-0000-0000-0000-000000006301';
    const targetItemId = '00000000-0000-0000-0000-000000006302';
    await insertEmptyBatch(targetId, targetItemId);
    await expect(pool.query(`UPDATE settlement_batches SET replacement_batch_id=$2 WHERE id=$1`, [original.id, targetId]))
      .rejects.toThrow(/finalized|replacement/i);
  });

  test('does not relabel an unrelated database check failure as a source conflict', async () => {
    await insertEarning({ id: earningId, orderId });
    await pool.query(`CREATE FUNCTION fail_settlement_batch_check() RETURNS trigger AS $$ BEGIN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='injected unrelated check failure';
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER test_fail_settlement_batch_check BEFORE INSERT ON settlement_batches
    FOR EACH ROW EXECUTE FUNCTION fail_settlement_batch_check()`);

    await expect(createSettlementBatch({ store: new PostgresSettlementStore(pool), input: input() }))
      .rejects.toMatchObject({ code: '23514', message: 'injected unrelated check failure' });
    await pool.query('DROP TRIGGER test_fail_settlement_batch_check ON settlement_batches; DROP FUNCTION fail_settlement_batch_check()');
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

async function insertOrder(id: string, publicId: string, orderGuildId = guildId): Promise<void> {
  await pool.query(`INSERT INTO orders
    (id,public_id,customer_id,player_id,status,row_version,currency,amount_minor,guild_id,channel_id,panel_message_id,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'COMPLETED',8,'USD',12000,$5,$6,$7,$8,$8)`,
  [id, publicId, customerId, playerId, orderGuildId, `channel-${publicId}`, `panel-${publicId}`, '2026-07-19T11:00:00.000Z']);
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
    VALUES ($1,$2,$3,1,$4,$4,'USD',$5,1,$6,$7,$8,'2026-07-19T11:00:00.000Z','2026-07-19T11:00:00.000Z')`,
  [options.id, options.orderId, playerId, options.amountMinor ?? 10000, options.status ?? 'CONFIRMED', staffId,
    options.confirmedAt ?? '2026-07-19T12:00:00.000Z', options.paidAt ?? null]);
}

async function insertEmptyBatch(batchId: string, itemId: string, itemPlayerId = playerId): Promise<void> {
  await pool.query(`INSERT INTO settlement_batches
    (id,public_id,guild_id,source,period_start,period_end,cutoff_at,time_zone,currency,gross_amount_minor,adjustment_amount_minor,net_amount_minor,status,row_version,created_by_staff_id,created_at,updated_at)
    VALUES ($1,$5,'900000000000000001','MANUAL',$2,$3,$3,'Asia/Shanghai','USD',10000,0,10000,'DRAFT',1,$4,now(),now())`,
  [batchId, '2026-07-12T16:00:00.000Z', cutoffAt, staffId, `SET-${batchId.slice(-12)}`]);
  await pool.query(`INSERT INTO settlement_items
    (id,settlement_batch_id,player_user_id,player_display_name,gross_amount_minor,adjustment_amount_minor,net_amount_minor,currency,payment_status,row_version,created_at,updated_at)
    VALUES ($1,$2,$3,'Test Player',10000,0,10000,'USD','PENDING',1,$4,$4)`,
  [itemId, batchId, itemPlayerId, cutoffAt]);
}
