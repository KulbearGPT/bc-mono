import { execFile as execFileCallback } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresSettlementStore,
  createSettlementBatch,
  type SettlementCreateInput,
  type SettlementMutationInput,
  type SettlementPaymentResultsInput
} from '@blackcat/api/settlements';

const execFile = promisify(execFileCallback);
const playerA = '00000000-0000-0000-0000-000000006401';
const playerB = '00000000-0000-0000-0000-000000006402';
const customerId = '00000000-0000-0000-0000-000000006403';
const staffId = '00000000-0000-0000-0000-000000006404';
const earningA = '00000000-0000-0000-0000-000000006411';
const earningB = '00000000-0000-0000-0000-000000006412';
const orderA = '00000000-0000-0000-0000-000000006421';
const orderB = '00000000-0000-0000-0000-000000006422';
const now = new Date('2026-07-19T18:00:00.000Z');
let root = '';
let data = '';
let pool: Pool;

function batchInput(): SettlementCreateInput {
  return {
    source: 'MANUAL', scheduleKey: null,
    periodStart: '2026-07-13T16:00:00.000Z', periodEnd: '2026-07-19T16:00:00.000Z',
    cutoffAt: '2026-07-19T16:00:00.000Z', timeZone: 'Asia/Shanghai', currency: 'CNY',
    playerUserIds: null, createdByStaffId: staffId
  };
}

function mutation(expectedVersion: number): SettlementMutationInput {
  return { expectedVersion, reason: 'WEEKLY_REVIEW', actorStaffId: staffId, actorLevel: 'L4_ADMIN_OWNER', now };
}

describe('M6-US-02 PostgreSQL review and payment persistence', () => {
  test('ships an upgrade migration and masks complete short external account identifiers', () => {
    const upgrade = readFileSync('database/prisma/migrations/000003_m6_settlement_review/migration.sql', 'utf8');
    const source = readFileSync('apps/api/src/settlements.ts', 'utf8');
    expect(upgrade).toContain('ADD COLUMN IF NOT EXISTS player_display_name');
    expect(upgrade).toContain('settlement_payment_results_one_success_idx');
    expect(source).toContain("CASE WHEN length(ea.external_user_id)>4 THEN right(ea.external_user_id,4) ELSE '' END");
  });
  beforeAll(async () => {
    const port = 61_400 + (process.pid % 200);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m6-payment-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m6_payment']);
    for (const migration of [
      'database/prisma/migrations/000001_p0_baseline/migration.sql',
      'database/prisma/migrations/000002_m6_settlements/migration.sql',
      'database/prisma/migrations/000003_m6_settlement_review/migration.sql'
    ]) await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m6_payment', '-v', 'ON_ERROR_STOP=1', '-f', migration]);
    pool = new Pool({ host: root, port, database: 'blackcat_m6_payment', max: 8 });
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE settlement_payment_results,settlement_item_entries,settlement_items,
      settlement_batches,player_earning_adjustments,player_earnings,orders,staff_accounts,users RESTART IDENTITY CASCADE`);
    await seed();
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('records whole-item success and failure atomically and pays only the successful earning', async () => {
    const { store, batch } = await approvedBatch();
    const [itemA, itemB] = batch.items;
    const result = await store.recordPaymentResults(batch.id, paymentInput(batch.version, 'm6:db:pay:01', [
      { settlementItemId: itemA!.id, expectedVersion: 1, result: 'SUCCEEDED', amountMinor: itemA!.netAmountMinor, currency: 'CNY', externalBatchReference: 'EXT-A', note: null },
      { settlementItemId: itemB!.id, expectedVersion: 1, result: 'FAILED', amountMinor: 0, currency: 'CNY', externalBatchReference: null, note: 'row rejected' }
    ]));

    expect(result.status).toBe('PARTIALLY_PAID');
    expect(result.version).toBe(5);
    expect(result.items.map((item) => item.paymentStatus)).toEqual(['SUCCEEDED', 'FAILED']);
    expect((await pool.query('SELECT result FROM settlement_payment_results')).rows.map((row) => row.result).sort())
      .toEqual(['FAILED', 'SUCCEEDED']);
    expect((await pool.query('SELECT id,status FROM player_earnings ORDER BY id')).rows).toEqual([
      { id: earningA, status: 'PAID' }, { id: earningB, status: 'CONFIRMED' }
    ]);
  });

  test('retries a failed item append-only and converges the batch to paid', async () => {
    const { store, batch } = await approvedBatch();
    const [itemA, itemB] = batch.items;
    const partial = await store.recordPaymentResults(batch.id, paymentInput(3, 'm6:db:pay:02', [
      { settlementItemId: itemA!.id, expectedVersion: 1, result: 'SUCCEEDED', amountMinor: itemA!.netAmountMinor, currency: 'CNY', externalBatchReference: 'EXT-A', note: null },
      { settlementItemId: itemB!.id, expectedVersion: 1, result: 'FAILED', amountMinor: 0, currency: 'CNY', externalBatchReference: null, note: 'retry later' }
    ]));
    const paid = await store.recordPaymentResults(batch.id, paymentInput(partial.version, 'm6:db:pay:03', [
      { settlementItemId: itemB!.id, expectedVersion: 2, result: 'SUCCEEDED', amountMinor: itemB!.netAmountMinor, currency: 'CNY', externalBatchReference: 'EXT-B', note: null }
    ]));

    expect(paid.status).toBe('PAID');
    expect((await pool.query('SELECT result FROM settlement_payment_results ORDER BY recorded_at,id')).rows.map((row) => row.result).sort()).toEqual(['FAILED', 'SUCCEEDED', 'SUCCEEDED']);
    expect((await pool.query("SELECT count(*)::int count FROM player_earnings WHERE status='PAID'")).rows[0]).toEqual({ count: 2 });
  });

  test('serializes concurrent payment attempts so one request wins without duplicate results', async () => {
    const { store, batch } = await approvedBatch();
    const item = batch.items[0]!;
    const requests = await Promise.allSettled([
      store.recordPaymentResults(batch.id, paymentInput(3, 'm6:db:race:01', [success(item.id, item.netAmountMinor, 'EXT-1')])),
      store.recordPaymentResults(batch.id, paymentInput(3, 'm6:db:race:02', [success(item.id, item.netAmountMinor, 'EXT-2')]))
    ]);
    expect(requests.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(requests.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await pool.query('SELECT id FROM settlement_payment_results')).rowCount).toBe(1);
  });

  test('rolls back every row when one item version is stale', async () => {
    const { store, batch } = await approvedBatch();
    const [itemA, itemB] = batch.items;
    await expect(store.recordPaymentResults(batch.id, paymentInput(3, 'm6:db:rollback:01', [
      success(itemA!.id, itemA!.netAmountMinor, 'EXT-A'),
      { ...success(itemB!.id, itemB!.netAmountMinor, 'EXT-B'), expectedVersion: 99 }
    ]))).rejects.toThrow(/version is stale/i);
    expect((await pool.query('SELECT id FROM settlement_payment_results')).rowCount).toBe(0);
    expect((await pool.query("SELECT count(*)::int count FROM player_earnings WHERE status='PAID'")).rows[0]).toEqual({ count: 0 });
    expect((await pool.query('SELECT status,row_version FROM settlement_batches WHERE id=$1', [batch.id])).rows[0]).toEqual({ status: 'APPROVED', row_version: 3 });
  });

  test('database rejects missing evidence, partial success, and a second success result', async () => {
    const { store, batch } = await approvedBatch();
    const item = batch.items[0]!;
    await expect(directResult(item.id, '00000000-0000-0000-0000-000000006451', 'SUCCEEDED', item.netAmountMinor - 1, null, null, 'm6:direct:bad-amount'))
      .rejects.toThrow(/amount|evidence|constraint/i);
    await expect(directResult(item.id, '00000000-0000-0000-0000-000000006452', 'FAILED', 0, null, null, 'm6:direct:no-evidence'))
      .rejects.toThrow(/evidence|reference|note|constraint/i);

    await store.recordPaymentResults(batch.id, paymentInput(3, 'm6:db:success:01', [success(item.id, item.netAmountMinor, 'EXT-OK')]));
    await expect(directResult(item.id, '00000000-0000-0000-0000-000000006453', 'SUCCEEDED', item.netAmountMinor, 'EXT-DUP', null, 'm6:direct:duplicate'))
      .rejects.toThrow(/success|unique|duplicate/i);
  });
});

async function approvedBatch() {
  const store = new PostgresSettlementStore(pool);
  const created = await createSettlementBatch({ store, input: batchInput() });
  const submitted = await store.submit(created.id, mutation(1));
  const batch = await store.approve(created.id, mutation(submitted.version), {
    manualDualReviewFromMinor: 1_000_000, l4ReviewFromMinor: 1_000_000
  });
  return { store, batch };
}

function paymentInput(expectedBatchVersion: number, requestIdempotencyKey: string, results: SettlementPaymentResultsInput['results']): SettlementPaymentResultsInput {
  return { expectedBatchVersion, requestIdempotencyKey, results, actorStaffId: staffId, now };
}

function success(settlementItemId: string, amountMinor: number, externalBatchReference: string): SettlementPaymentResultsInput['results'][number] {
  return { settlementItemId, expectedVersion: 1, result: 'SUCCEEDED', amountMinor, currency: 'CNY', externalBatchReference, note: null };
}

function directResult(itemId: string, id: string, result: 'SUCCEEDED' | 'FAILED', amount: number, reference: string | null, note: string | null, key: string) {
  return pool.query(`INSERT INTO settlement_payment_results
    (id,settlement_item_id,result,amount_minor,currency,external_batch_reference,note,idempotency_key,recorded_by_staff_id,recorded_at)
    VALUES ($1,$2,$3,$4,'CNY',$5,$6,$7,$8,$9)`, [id, itemId, result, amount, reference, note, key, staffId, now]);
}

async function seed(): Promise<void> {
  await pool.query(`INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
    ($1,'Player A','ACTIVE',1,now(),now()),($2,'Player B','ACTIVE',1,now(),now()),
    ($3,'Customer','ACTIVE',1,now(),now()),($4,'Operator','ACTIVE',1,now(),now())`,
  [playerA, playerB, customerId, staffId]);
  await pool.query(`INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
    VALUES ($1,$1,'L4_ADMIN_OWNER','ACTIVE','MANUAL',1,now(),now())`, [staffId]);
  await insertOrder(orderA, 'P-6421', playerA);
  await insertOrder(orderB, 'P-6422', playerB);
  await insertEarning(earningA, orderA, playerA, 20_000);
  await insertEarning(earningB, orderB, playerB, 10_000);
}

function insertOrder(id: string, publicId: string, playerId: string) {
  return pool.query(`INSERT INTO orders
    (id,public_id,customer_id,player_id,status,row_version,currency,amount_minor,guild_id,channel_id,panel_message_id,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'COMPLETED',8,'CNY',30000,'900000000000000001',$5,$6,'2026-07-19T11:00:00.000Z','2026-07-19T11:00:00.000Z')`,
  [id, publicId, customerId, playerId, `channel-${publicId}`, `panel-${publicId}`]);
}

function insertEarning(id: string, orderId: string, playerId: string, amount: number) {
  return pool.query(`INSERT INTO player_earnings
    (id,order_id,player_user_id,base_units,unit_payout_minor,amount_minor,currency,status,row_version,confirmed_by_staff_id,confirmed_at,created_at,updated_at)
    VALUES ($1,$2,$3,1,$4,$4,'CNY','CONFIRMED',1,$5,'2026-07-19T12:00:00.000Z','2026-07-19T11:00:00.000Z','2026-07-19T11:00:00.000Z')`,
  [id, orderId, playerId, amount, staffId]);
}
