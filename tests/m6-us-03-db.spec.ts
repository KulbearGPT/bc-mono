import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresWeeklyReportStore,
  generateWeeklyReports,
  type WeeklyReportGenerationInput
} from '@blackcat/api/weekly-reports';
import type { AuditRecord } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const guildId = '900000000000006300';
const playerA = '00000000-0000-0000-0000-000000006301';
const playerB = '00000000-0000-0000-0000-000000006302';
const customerId = '00000000-0000-0000-0000-000000006303';
const staffUserId = '00000000-0000-0000-0000-000000006304';
const staffId = '00000000-0000-0000-0000-000000006305';
let root = '';
let data = '';
let pool: Pool;

function generation(): WeeklyReportGenerationInput {
  return { guildId, scheduleKey: 'weekly-cny', periodStart: '2026-07-12T16:00:00.000Z',
    periodEnd: '2026-07-19T16:00:00.000Z', cutoffAt: '2026-07-19T16:00:00.000Z', timeZone: 'Asia/Shanghai', currency: 'CNY' };
}

describe('M6-US-03 PostgreSQL weekly reports', () => {
  beforeAll(async () => {
    const port = 61_600 + (process.pid % 200);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m6-reports-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m6_reports']);
    for (const migration of [
      'database/prisma/migrations/000001_p0_baseline/migration.sql',
      'database/prisma/migrations/000002_m6_settlements/migration.sql',
      'database/prisma/migrations/000003_m6_settlement_review/migration.sql',
      'database/prisma/migrations/000004_m6_weekly_reports/migration.sql',
      'database/prisma/migrations/000005_m6_weekly_report_review_fixes/migration.sql'
    ]) {
      await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m6_reports', '-v', 'ON_ERROR_STOP=1', '-f', migration]);
    }
    pool = new Pool({ host: root, port, database: 'blackcat_m6_reports', max: 8 });
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE weekly_report_revisions,weekly_report_summaries,player_weekly_reports,
      settlement_payment_results,settlement_item_entries,settlement_items,settlement_batches,
      outbox_events,gift_requests,gift_catalog_versions,gift_catalog_items,player_earning_adjustments,
      player_earnings,orders,discord_accounts,staff_accounts,users RESTART IDENTITY CASCADE`);
    await seed();
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('atomically and idempotently creates all personal reports, one summary, and notifications', async () => {
    const store = new PostgresWeeklyReportStore(pool);
    const [first, replay] = await Promise.all([
      generateWeeklyReports({ store, input: generation() }),
      generateWeeklyReports({ store, input: generation() })
    ]);
    expect(replay).toEqual(first);
    expect(first.playerReports).toHaveLength(2);
    expect((await pool.query('SELECT count(*)::int count FROM player_weekly_reports')).rows[0]).toEqual({ count: 2 });
    expect((await pool.query('SELECT count(*)::int count FROM weekly_report_summaries')).rows[0]).toEqual({ count: 1 });
    expect((await pool.query("SELECT count(*)::int count FROM outbox_events WHERE event_type='WEEKLY_REPORT_NOTIFY'")).rows[0]).toEqual({ count: 2 });
    expect(first.playerReports.find((report) => report.playerUserId === playerA)?.metrics).toMatchObject({
      completedOrderCount: 2, orderEarningMinor: 12_000, giftEarningMinor: 2_000,
      adjustmentMinor: -500, pendingMinor: 0, settlementReadyMinor: 7_500, batchedMinor: 4_000
    });
    expect(first.playerReports.find((report) => report.playerUserId === playerB)?.metrics.pendingMinor).toBe(8_000);
  });

  test('rolls back personal reports and notifications if summary insertion fails', async () => {
    await pool.query(`CREATE FUNCTION fail_weekly_summary() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected summary failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_weekly_summary BEFORE INSERT ON weekly_report_summaries FOR EACH ROW EXECUTE FUNCTION fail_weekly_summary()`);
    await expect(generateWeeklyReports({ store: new PostgresWeeklyReportStore(pool), input: generation() }))
      .rejects.toThrow(/injected summary failure/i);
    expect((await pool.query('SELECT count(*)::int count FROM player_weekly_reports')).rows[0]).toEqual({ count: 0 });
    expect((await pool.query("SELECT count(*)::int count FROM outbox_events WHERE event_type='WEEKLY_REPORT_NOTIFY'")).rows[0]).toEqual({ count: 0 });
    await pool.query('DROP TRIGGER test_fail_weekly_summary ON weekly_report_summaries; DROP FUNCTION fail_weekly_summary()');
  });

  test('stores CNY and Guild scope and rejects duplicate or cross-currency facts', async () => {
    const store = new PostgresWeeklyReportStore(pool);
    await generateWeeklyReports({ store, input: generation() });
    const rows = await pool.query('SELECT DISTINCT guild_id,currency,time_zone FROM player_weekly_reports');
    expect(rows.rows).toEqual([{ guild_id: guildId, currency: 'CNY', time_zone: 'Asia/Shanghai' }]);
    await expect(pool.query(`INSERT INTO weekly_report_summaries
      (id,report_key,guild_id,schedule_key,period_start,period_end,cutoff_at,time_zone,currency,status,
       active_player_count,completed_order_count,cancelled_order_count,exception_count,service_minutes,
       gross_amount_minor,adjustment_minor,pending_minor,net_payable_minor,detail_snapshot,current_revision,updated_at)
      VALUES (gen_random_uuid(),'usd-report',$1,'weekly-usd',$2,$3,$3,'Asia/Shanghai','USD','READY',0,0,0,0,0,0,0,0,0,'{}',1,$3)`,
    [guildId, generation().periodStart, generation().periodEnd])).rejects.toThrow(/currency|check constraint/i);
  });

  test('appends revisions transactionally with audit and forbids old snapshot mutation', async () => {
    const store = new PostgresWeeklyReportStore(pool);
    const generated = await generateWeeklyReports({ store, input: generation() });
    const report = generated.playerReports[0]!;
    const snapshot = { ...report.metrics, adjustmentMinor: 500, settlementReadyMinor: report.metrics.settlementReadyMinor + 500 };
    const staged = await store.stageRevision(report.id, { reportType: 'PLAYER', expectedRevision: 1, reason: 'MANUAL_CORRECTION',
      snapshot, actorStaffId: staffId, idempotencyKey: 'm6:rpt:db:revision:0001', now: new Date('2026-07-19T18:00:00.000Z') });
    await staged.commit(audit(report.id));
    expect(await store.get(report.id)).toMatchObject({ currentRevision: 2, metrics: snapshot, revisions: [{ revision: 2 }] });
    expect((await pool.query("SELECT count(*)::int count FROM audit_logs WHERE action='CREATE_WEEKLY_REPORT_REVISION'")).rows[0]).toEqual({ count: 1 });
    await expect(pool.query('UPDATE weekly_report_revisions SET reason=$2 WHERE player_weekly_report_id=$1', [report.id, 'overwrite']))
      .rejects.toThrow(/append-only/i);
    await expect(pool.query('UPDATE player_weekly_reports SET order_earning_minor=1 WHERE id=$1', [report.id]))
      .rejects.toThrow(/immutable|permission|snapshot/i);
    await expect(pool.query('DELETE FROM player_weekly_reports WHERE id=$1', [report.id])).rejects.toThrow(/cannot be deleted|permission/i);
  });

  test('rejects stale concurrent revisions and keeps the first immutable version', async () => {
    const store = new PostgresWeeklyReportStore(pool);
    const report = (await generateWeeklyReports({ store, input: generation() })).playerReports[0]!;
    const inputs = ['a', 'b'].map((suffix) => store.stageRevision(report.id, { reportType: 'PLAYER', expectedRevision: 1,
      reason: `CORRECTION_${suffix}`, snapshot: { ...report.metrics, adjustmentMinor: suffix === 'a' ? 1 : 2 },
      actorStaffId: staffId, idempotencyKey: `m6:rpt:db:revision:${suffix}:0001`, now: new Date('2026-07-19T18:00:00.000Z') }));
    const staged = await Promise.all(inputs);
    const results = await Promise.allSettled(staged.map((item) => item.commit(audit(report.id))));
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect((await pool.query('SELECT revision FROM weekly_report_revisions WHERE player_weekly_report_id=$1', [report.id])).rows).toEqual([{ revision: 2 }]);
  });

  test('rejects a persisted revision idempotency key reused with another fingerprint', async () => {
    const store = new PostgresWeeklyReportStore(pool);
    const report = (await generateWeeklyReports({ store, input: generation() })).playerReports[0]!;
    const base = { reportType: 'PLAYER' as const, expectedRevision: 1, reason: 'FIRST_CORRECTION',
      snapshot: { ...report.metrics, adjustmentMinor: 1 }, actorStaffId: staffId,
      idempotencyKey: 'm6:rpt:db:fingerprint:0001', now: new Date('2026-07-19T18:00:00.000Z') };
    const first = await store.appendRevision(report.id, base);
    const replay = await store.appendRevision(report.id, base);
    expect(replay).toEqual(await store.get(report.id));
    expect(replay).toEqual(first);
    await expect(store.appendRevision(report.id, { ...base, reason: 'DIFFERENT_CORRECTION' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('includes a current-period adjustment for an earning whose order is outside the period', async () => {
    const oldOrder = '00000000-0000-0000-0000-000000006340';
    const oldEarning = '00000000-0000-0000-0000-000000006341';
    await insertOrder(oldOrder, 'P-OLD', playerA, 'COMPLETED', 60);
    await pool.query('UPDATE orders SET service_started_at=$2,completed_at=$3,updated_at=$3 WHERE id=$1',
      [oldOrder, '2026-07-01T10:00:00.000Z', '2026-07-01T11:00:00.000Z']);
    await insertEarning(oldEarning, oldOrder, playerA, 6_000, 'CONFIRMED');
    await pool.query("UPDATE player_earnings SET status='PAID',created_at=$2,updated_at=$2 WHERE id=$1",
      [oldEarning, '2026-07-01T11:00:00.000Z']);
    await pool.query(`INSERT INTO player_earning_adjustments
      (id,player_earning_id,type,amount_minor,currency,reason,idempotency_key,created_at)
      VALUES (gen_random_uuid(),$1,'CORRECTION_DEBIT',700,'CNY','late refund','m6:rpt:old-adj','2026-07-18T15:00:00.000Z')`, [oldEarning]);
    const report = (await generateWeeklyReports({ store: new PostgresWeeklyReportStore(pool), input: generation() }))
      .playerReports.find((item) => item.playerUserId === playerA)!;
    expect(report.metrics).toMatchObject({ adjustmentMinor: -1_200, pendingMinor: 700,
      settlementReadyMinor: 7_500, batchedMinor: 4_000 });
    expect((report.detailSnapshot.facts as Array<{ orderId: string; includeOrderActivity?: boolean }>))
      .toContainEqual(expect.objectContaining({ orderId: oldOrder, includeOrderActivity: false }));
  });

  test('replays every personal report when more than 99 players are active', async () => {
    await seedBulkPlayers(100);
    const store = new PostgresWeeklyReportStore(pool);
    const first = await generateWeeklyReports({ store, input: generation() });
    const replay = await generateWeeklyReports({ store, input: generation() });
    expect(first.playerReports).toHaveLength(102);
    expect(replay.playerReports).toHaveLength(102);
    expect(replay).toEqual(first);
  });

  test('marks an order whose end precedes its start as NEEDS_REVIEW', async () => {
    const orderId = '00000000-0000-0000-0000-000000006350';
    await insertOrder(orderId, 'P-BAD-TIME', playerA, 'COMPLETED', 60);
    await pool.query('UPDATE orders SET service_started_at=$2,completed_at=$3,updated_at=$3 WHERE id=$1',
      [orderId, '2026-07-18T13:00:00.000Z', '2026-07-18T12:00:00.000Z']);
    await insertEarning('00000000-0000-0000-0000-000000006351', orderId, playerA, 1_000, 'CONFIRMED');
    const report = (await generateWeeklyReports({ store: new PostgresWeeklyReportStore(pool), input: generation() }))
      .playerReports.find((item) => item.playerUserId === playerA)!;
    expect(report.status).toBe('NEEDS_REVIEW');
    expect(report.detailSnapshot).toMatchObject({ issues: expect.arrayContaining(['INVALID_SERVICE_BOUNDARY_ORDER']) });
  });
});

function audit(targetId: string): AuditRecord {
  return { id: crypto.randomUUID(), actorId: staffUserId, actorStaffId: staffId, actorLevel: 'L3_OPERATIONS', actorSource: 'DASHBOARD',
    clientId: 'dashboard', interactionId: null, permissionCode: 'weekly_report.manage', action: 'CREATE_WEEKLY_REPORT_REVISION',
    targetType: 'weekly_report', targetId, outcome: 'SUCCEEDED', reason: 'MANUAL_CORRECTION', requestId: 'req_m6_rpt_db',
    approvalRequestId: null, occurredAt: '2026-07-19T18:00:00.000Z' };
}

async function seed(): Promise<void> {
  await pool.query(`INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
    ($1,'Player A','ACTIVE',1,now(),now()),($2,'Player B','ACTIVE',1,now(),now()),
    ($3,'Customer','ACTIVE',1,now(),now()),($4,'Staff','ACTIVE',1,now(),now())`, [playerA, playerB, customerId, staffUserId]);
  await pool.query(`INSERT INTO discord_accounts (id,user_id,guild_id,discord_user_id,created_at,updated_at) VALUES
    (gen_random_uuid(),$1,$3,'player-a',now(),now()),(gen_random_uuid(),$2,$3,'player-b',now(),now())`, [playerA, playerB, guildId]);
  await pool.query(`INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
    VALUES ($1,$2,'L3_OPERATIONS','ACTIVE','MANUAL',1,now(),now())`, [staffId, staffUserId]);
  await insertOrder('00000000-0000-0000-0000-000000006311', 'P-6311', playerA, 'COMPLETED', 120);
  await insertOrder('00000000-0000-0000-0000-000000006313', 'P-6313', playerA, 'COMPLETED', 30);
  await insertOrder('00000000-0000-0000-0000-000000006312', 'P-6312', playerB, 'COMPLETED', 60);
  await insertEarning('00000000-0000-0000-0000-000000006321', '00000000-0000-0000-0000-000000006311', playerA, 8_000, 'CONFIRMED');
  await insertEarning('00000000-0000-0000-0000-000000006323', '00000000-0000-0000-0000-000000006313', playerA, 4_000, 'CONFIRMED');
  await insertEarning('00000000-0000-0000-0000-000000006322', '00000000-0000-0000-0000-000000006312', playerB, 8_000, 'PENDING');
  await pool.query(`INSERT INTO player_earning_adjustments
    (id,player_earning_id,type,amount_minor,currency,reason,idempotency_key,created_at)
    VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000006321','CORRECTION_DEBIT',500,'CNY','refund','m6:rpt:adj','2026-07-18T13:00:00.000Z')`);
  await seedGift();
  await seedSettlementMembership();
}

function insertOrder(id: string, publicId: string, playerId: string, status: 'COMPLETED' | 'CANCELLED', minutes: number) {
  const end = '2026-07-18T12:00:00.000Z';
  const start = new Date(Date.parse(end) - minutes * 60_000).toISOString();
  return pool.query(`INSERT INTO orders
    (id,public_id,customer_id,player_id,status,row_version,currency,amount_minor,guild_id,service_started_at,completed_at,cancelled_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,8,'CNY',30000,$6,$7,$8,$9,'2026-07-18T09:00:00.000Z',$8)`,
  [id, publicId, customerId, playerId, status, guildId, start, end, status === 'CANCELLED' ? end : null]);
}

function insertEarning(id: string, orderId: string, playerId: string, amount: number, status: 'PENDING' | 'CONFIRMED') {
  return pool.query(`INSERT INTO player_earnings
    (id,order_id,player_user_id,base_units,unit_payout_minor,amount_minor,currency,status,row_version,confirmed_by_staff_id,confirmed_at,created_at,updated_at)
    VALUES ($1,$2,$3,1,$4,$4,'CNY',$5,1,$6,$7,'2026-07-18T12:00:00.000Z','2026-07-18T12:00:00.000Z')`,
  [id, orderId, playerId, amount, status, status === 'CONFIRMED' ? staffId : null, status === 'CONFIRMED' ? '2026-07-18T12:30:00.000Z' : null]);
}

async function seedGift(): Promise<void> {
  await pool.query(`INSERT INTO gift_catalog_items (id,code,created_at,updated_at) VALUES (gen_random_uuid(),'ROSE',now(),now())`);
  await pool.query(`INSERT INTO gift_catalog_versions (id,gift_catalog_item_id,version,status,name,price_minor,currency,broadcast_template,created_by_staff_id,created_at)
    SELECT gen_random_uuid(),id,1,'ACTIVE','Rose',2000,'CNY','gift',$1,now() FROM gift_catalog_items WHERE code='ROSE'`, [staffId]);
  await pool.query(`INSERT INTO gift_requests (id,public_id,order_id,gift_catalog_version_id,sender_id,receiver_id,status,row_version,
      gift_code_snapshot,gift_name_snapshot,price_minor,currency,broadcast_template_snapshot,captured_at,expires_at,created_at,updated_at)
    SELECT gen_random_uuid(),'GFT-6301','00000000-0000-0000-0000-000000006311',id,$1,$2,'ANNOUNCED',5,
      'ROSE','Rose',2000,'CNY','gift','2026-07-18T14:00:00.000Z','2026-07-19T14:00:00.000Z','2026-07-18T13:00:00.000Z','2026-07-18T14:00:00.000Z'
    FROM gift_catalog_versions LIMIT 1`, [customerId, playerA]);
}

async function seedSettlementMembership(): Promise<void> {
  await pool.query(`INSERT INTO settlement_batches
    (id,public_id,source,period_start,period_end,cutoff_at,time_zone,currency,gross_amount_minor,adjustment_amount_minor,net_amount_minor,updated_at)
    VALUES ('00000000-0000-0000-0000-000000006330','SET-6330','MANUAL',$1,$2,$2,'Asia/Shanghai','CNY',4000,0,4000,$2)`,
  [generation().periodStart, generation().periodEnd]);
  await pool.query(`INSERT INTO settlement_items
    (id,settlement_batch_id,player_user_id,player_display_name,gross_amount_minor,adjustment_amount_minor,net_amount_minor,currency,updated_at)
    VALUES ('00000000-0000-0000-0000-000000006331','00000000-0000-0000-0000-000000006330',$1,'Player A',4000,0,4000,'CNY',$2)`,
  [playerA, generation().periodEnd]);
  await pool.query(`INSERT INTO settlement_item_entries
    (id,settlement_item_id,entry_type,player_earning_id,amount_minor,currency,occurred_at)
    VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000006331','PLAYER_EARNING','00000000-0000-0000-0000-000000006323',4000,'CNY','2026-07-18T12:30:00.000Z')`);
  await pool.query(`UPDATE settlement_batches SET snapshot_finalized_at=$1
    WHERE id='00000000-0000-0000-0000-000000006330'`, [generation().periodEnd]);
}

async function seedBulkPlayers(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const suffix = String(7000 + index).padStart(12, '0');
    const playerId = `00000000-0000-0000-0000-${suffix}`;
    const orderId = `10000000-0000-0000-0000-${suffix}`;
    const earningId = `20000000-0000-0000-0000-${suffix}`;
    await pool.query(`INSERT INTO users (id,display_name,status,row_version,created_at,updated_at)
      VALUES ($1,$2,'ACTIVE',1,now(),now())`, [playerId, `Bulk ${index}`]);
    await insertOrder(orderId, `P-BULK-${index}`, playerId, 'COMPLETED', 30);
    await insertEarning(earningId, orderId, playerId, 1_000, 'CONFIRMED');
  }
}
