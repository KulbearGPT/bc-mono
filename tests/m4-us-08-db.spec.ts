import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresTransactionTimelineStore } from '@blackcat/api/transaction-timeline';

const execFile = promisify(execFileCallback);
const ids = {
  staffUser: '00000000-0000-0000-0000-000000008001', staff: '00000000-0000-0000-0000-000000008002',
  customer: '00000000-0000-0000-0000-000000008003', player: '00000000-0000-0000-0000-000000008004',
  order: '00000000-0000-0000-0000-000000008005', reservation: '00000000-0000-0000-0000-000000008006',
  giftItem: '00000000-0000-0000-0000-000000008007', giftVersion: '00000000-0000-0000-0000-000000008008',
  gift: '00000000-0000-0000-0000-000000008009', giftTransaction: '00000000-0000-0000-0000-000000008010',
  giftConsumption: '00000000-0000-0000-0000-000000008011', program: '00000000-0000-0000-0000-000000008012',
  attribution: '00000000-0000-0000-0000-000000008013', commission: '00000000-0000-0000-0000-000000008014'
};
let root = '';
let data = '';
let pool: Pool;

describe('M4-US-08 PostgreSQL transaction timeline', () => {
  beforeAll(async () => {
    const port = 61_900 + (process.pid % 100);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m4-timeline-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m4_timeline']);
    await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m4_timeline', '-v', 'ON_ERROR_STOP=1', '-f', 'database/prisma/migrations/000001_p0_baseline/migration.sql']);
    pool = new Pool({ host: root, port, database: 'blackcat_m4_timeline' });
    await seed();
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('projects order and gift money facts with real reservation totals', async () => {
    const store = new PostgresTransactionTimelineStore(pool);
    const detail = await store.getAdminOrder({ orderId: ids.order, actorStaffId: ids.staff, actorLevel: 'L3_OPERATIONS', cursor: null, limit: 50 });
    expect(detail?.fundReservation).toMatchObject({ ownerUserId: ids.customer, amountMinor: 12000, capturedMinor: 9000, releasedMinor: 3000 });
    expect(detail?.transactions).toEqual([expect.objectContaining({ id: ids.giftTransaction, amountMinor: 3000 })]);
    expect(detail?.timeline.items.map((item) => item.type)).toEqual(expect.arrayContaining([
      'FUND_RESERVATION_EVENT', 'EXTERNAL_TRANSACTION', 'CONSUMPTION', 'COMMISSION', 'COMMISSION_ADJUSTMENT'
    ]));
    expect(detail?.timeline.items.find((item) => item.id === ids.commission)).toMatchObject({ amountMinor: 60, direction: 'CREDIT' });
    expect(JSON.stringify(detail)).not.toMatch(/beneficiary|referred|rateBps|attribution/);
  });

  test('redacts commission facts below operations level', async () => {
    const store = new PostgresTransactionTimelineStore(pool);
    const detail = await store.getAdminOrder({ orderId: ids.order, actorStaffId: ids.staff, actorLevel: 'L2_SUPERVISOR', cursor: null, limit: 50 });
    expect(detail?.timeline.items.some((item) => item.type.startsWith('COMMISSION'))).toBe(false);
  });
});

async function seed() {
  await pool.query(`
    INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
      ('${ids.staffUser}','Operator','ACTIVE',1,now(),now()),('${ids.customer}','Customer','ACTIVE',1,now(),now()),('${ids.player}','Player','ACTIVE',1,now(),now());
    INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
      VALUES ('${ids.staff}','${ids.staffUser}','L3_OPERATIONS','ACTIVE','MANUAL',1,now(),now());
    INSERT INTO discord_accounts (id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at)
      VALUES (gen_random_uuid(),'${ids.staffUser}','900000000000008000','900000000000008002',now(),now(),now());
    INSERT INTO orders (id,public_id,customer_id,player_id,status,row_version,currency,amount_minor,guild_id,created_at,updated_at)
      VALUES ('${ids.order}','P-8005','${ids.customer}','${ids.player}','COMPLETED',4,'CNY',12000,'900000000000008000','2026-07-18T19:00:00Z','2026-07-18T21:00:00Z');
    INSERT INTO order_events (id,order_id,sequence,event_type,from_status,to_status,actor_user_id,actor_source,payload,created_at) VALUES
      (gen_random_uuid(),'${ids.order}',1,'CREATED',NULL,'DRAFT','${ids.customer}','DISCORD_BOT','{}','2026-07-18T19:00:00Z'),
      (gen_random_uuid(),'${ids.order}',2,'COMPLETED','IN_SERVICE','COMPLETED','${ids.staffUser}','DASHBOARD','{}','2026-07-18T21:00:00Z');
    INSERT INTO fund_reservations (id,user_id,source_type,order_id,mode,provider,amount_minor,currency,status,row_version,idempotency_key,created_at,updated_at)
      VALUES ('${ids.reservation}','${ids.customer}','ORDER','${ids.order}','PROVIDER_NATIVE_HOLD','mock',12000,'CNY','RELEASED',3,'timeline:reservation','2026-07-18T19:10:00Z','2026-07-18T21:00:00Z');
    INSERT INTO fund_reservation_events (id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,idempotency_key,actor_source,created_at) VALUES
      (gen_random_uuid(),'${ids.reservation}',1,'CREATED',NULL,'ACTIVE',12000,1,'timeline:reservation:created','SYSTEM_JOB','2026-07-18T19:10:00Z'),
      (gen_random_uuid(),'${ids.reservation}',2,'CAPTURED','ACTIVE','PARTIALLY_SETTLED',9000,2,'timeline:reservation:captured','SYSTEM_JOB','2026-07-18T20:50:00Z'),
      (gen_random_uuid(),'${ids.reservation}',3,'RELEASED','PARTIALLY_SETTLED','RELEASED',3000,3,'timeline:reservation:released','SYSTEM_JOB','2026-07-18T21:00:00Z');
    INSERT INTO gift_catalog_items (id,code,created_at,updated_at) VALUES ('${ids.giftItem}','FLOWER','2026-07-18T18:00:00Z','2026-07-18T18:00:00Z');
    INSERT INTO gift_catalog_versions (id,gift_catalog_item_id,version,status,active_gift_key,name,price_minor,currency,broadcast_template,created_by_staff_id,activated_at,created_at)
      VALUES ('${ids.giftVersion}','${ids.giftItem}',1,'ACTIVE','${ids.giftItem}','Flower',3000,'CNY','{sender} sent {gift}','${ids.staff}','2026-07-18T18:00:00Z','2026-07-18T18:00:00Z');
    INSERT INTO gift_requests (id,public_id,order_id,gift_catalog_version_id,sender_id,receiver_id,status,row_version,gift_code_snapshot,gift_name_snapshot,price_minor,currency,broadcast_template_snapshot,captured_at,expires_at,created_at,updated_at)
      VALUES ('${ids.gift}','G-8009','${ids.order}','${ids.giftVersion}','${ids.customer}','${ids.player}','CAPTURED',4,'FLOWER','Flower',3000,'CNY','{sender} sent {gift}','2026-07-18T20:10:00Z','2026-07-18T21:10:00Z','2026-07-18T20:00:00Z','2026-07-18T20:10:00Z');
    INSERT INTO external_transactions (id,provider,type,user_id,gift_request_id,external_ref,idempotency_key,amount_minor,currency,status,request_id,initiated_at,settled_at,created_at,updated_at)
      VALUES ('${ids.giftTransaction}','mock','GIFT_CHARGE','${ids.customer}','${ids.gift}','gift-8010','timeline:gift:transaction',3000,'CNY','SUCCEEDED','req_gift_8010','2026-07-18T20:05:00Z','2026-07-18T20:10:00Z','2026-07-18T20:05:00Z','2026-07-18T20:10:00Z');
    INSERT INTO consumption_entries (id,user_id,entry_type,direction,gift_request_id,external_transaction_id,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at)
      VALUES ('${ids.giftConsumption}','${ids.customer}','GIFT_CHARGE','DEBIT','${ids.gift}','${ids.giftTransaction}',3000,'CNY','GIFT','${ids.gift}','timeline:gift:consumption','2026-07-18T20:10:00Z');
    INSERT INTO referral_program_versions (id,program_type,version,status,active_program_key,award_mode,rate_bps,currency,eligible_order_spend,eligible_gift_spend,created_by_staff_id,activated_at,created_at)
      VALUES ('${ids.program}','PLAYER_LIFETIME',1,'ACTIVE','PLAYER_LIFETIME','NET_SPEND_BPS',200,'CNY',true,true,'${ids.staff}','2026-07-18T18:00:00Z','2026-07-18T18:00:00Z');
    INSERT INTO referral_attributions (id,program_version_id,beneficiary_user_id,referred_user_id,status,row_version,active_attribution_key,source_type,bound_by_staff_id,eligibility_checked_at,bound_at,created_at)
      VALUES ('${ids.attribution}','${ids.program}','${ids.player}','${ids.customer}','ACTIVE',1,'${ids.customer}','ADMIN_MANUAL','${ids.staff}','2026-07-18T18:00:00Z','2026-07-18T18:00:00Z','2026-07-18T18:00:00Z');
    INSERT INTO commissions (id,referral_attribution_id,beneficiary_user_id,source_consumption_entry_id,program_type_snapshot,program_version_snapshot,award_mode_snapshot,base_amount_minor,rate_bps,amount_minor,currency,status,row_version,created_at,updated_at)
      VALUES ('${ids.commission}','${ids.attribution}','${ids.player}','${ids.giftConsumption}','PLAYER_LIFETIME',1,'NET_SPEND_BPS',3000,200,60,'CNY','PENDING',1,'2026-07-18T20:11:00Z','2026-07-18T20:11:00Z');
    INSERT INTO commission_adjustments (id,commission_id,type,amount_minor,currency,reason,idempotency_key,created_by_staff_id,created_at)
      VALUES (gen_random_uuid(),'${ids.commission}','CORRECTION_CREDIT',10,'CNY','Correction','timeline:commission:adjustment','${ids.staff}','2026-07-18T20:12:00Z');
  `);
}
