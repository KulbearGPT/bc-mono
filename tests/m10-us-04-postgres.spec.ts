import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresOrderParticipantStore } from '@blackcat/api/order-participants';
import { PostgresServiceLifecycleStore, confirmOrder } from '@blackcat/api/service-lifecycle';

const execFile = promisify(execFileCallback);
const database = 'blackcat_m10_lifecycle';
const guildId = '999999999999999999';
const customerId = '00000000-0000-0000-0000-000000104001';
const customerDiscordId = '111111111111111111';
const staffUserId = '00000000-0000-0000-0000-000000104002';
const staffId = '00000000-0000-0000-0000-000000104003';
const orderId = '00000000-0000-0000-0000-000000104004';
const catalogId = '00000000-0000-0000-0000-000000104005';
const reservationId = '00000000-0000-0000-0000-000000104006';
const walletId = '00000000-0000-0000-0000-000000104007';
const now = new Date('2026-08-04T13:00:00.000Z');
let root = '';
let data = '';
let port = 0;
let pool: Pool;

describe('M10-US-04 PostgreSQL multi-player capture', () => {
  beforeAll(async () => {
    port = 62_700 + (process.pid % 100);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m10-lifecycle-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), database]);
    for (const migration of (await readdir('database/prisma/migrations')).sort()) {
      await execFile('psql', ['-h', root, '-p', String(port), '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', `database/prisma/migrations/${migration}/migration.sql`]);
    }
    pool = new Pool({ host: root, port, database, max: 4 });
    await seed();
  }, 40_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('blocks an unready late player, then captures the latest total into nine participant earnings', async () => {
    const lifecycle = new PostgresServiceLifecycleStore({ pool });
    await expect(confirmOrder({
      store: lifecycle,
      orderId,
      expectedVersion: 9,
      confirmation: 'CONFIRM_COMPLETED',
      actor: { guildId, discordUserId: customerDiscordId },
      idempotencyKey: 'm10-us-04:postgres:blocked',
      referralsEnabled: false,
      now
    })).rejects.toThrowError(expect.objectContaining({ code: 'CONFLICT' }));

    let untouched = await pool.query(`SELECT orders.status::text, reservation.status::text reservation_status,
      (SELECT count(*)::int FROM wallet_entries WHERE source_id=$2) capture_count,
      (SELECT count(*)::int FROM player_earnings WHERE order_id=$1) earning_count
      FROM orders JOIN fund_reservations reservation ON reservation.order_id=orders.id WHERE orders.id=$1`, [orderId, reservationId]);
    expect(untouched.rows[0]).toEqual({ status: 'PENDING_CONFIRMATION', reservation_status: 'ACTIVE', capture_count: 0, earning_count: 0 });

    await pool.query(`UPDATE order_participants SET ready_at=$2,row_version=row_version+1,updated_at=$2
      WHERE order_id=$1 AND ready_at IS NULL`, [orderId, now]);
    const completed = await confirmOrder({
      store: lifecycle,
      orderId,
      expectedVersion: 9,
      confirmation: 'CONFIRM_COMPLETED',
      actor: { guildId, discordUserId: customerDiscordId },
      idempotencyKey: 'm10-us-04:postgres:capture',
      referralsEnabled: false,
      now
    });
    expect(completed).toMatchObject({ status: 'COMPLETED', capturedMinor: 900, playerEarningMinor: 450 });

    const facts = await pool.query(`SELECT orders.status::text,orders.amount_minor::text,
      reservation.status::text reservation_status,
      (SELECT amount_minor::text FROM wallet_entries WHERE source_id=$2 AND entry_type='ORDER_CAPTURE_DEBIT') captured_minor,
      (SELECT count(*)::int FROM player_earnings WHERE order_id=$1) earning_count,
      (SELECT COALESCE(sum(amount_minor),0)::text FROM player_earnings WHERE order_id=$1) earning_total,
      (SELECT count(DISTINCT order_participant_id)::int FROM player_earnings WHERE order_id=$1) linked_participant_count,
      (SELECT count(*)::int FROM outbox_events WHERE order_id=$1 AND event_type='CHANNEL_ARCHIVE') channel_cleanup_jobs
      FROM orders JOIN fund_reservations reservation ON reservation.order_id=orders.id WHERE orders.id=$1`, [orderId, reservationId]);
    expect(facts.rows[0]).toEqual({
      status: 'COMPLETED', amount_minor: '900', reservation_status: 'CAPTURED', captured_minor: '900',
      earning_count: 9, earning_total: '450', linked_participant_count: 9, channel_cleanup_jobs: 1
    });

    const participants = new PostgresOrderParticipantStore(pool);
    await expect(participants.update({
      orderId,
      participantId: participantId(1),
      actorStaffId: staffId,
      actorLevel: 'L2_SUPERVISOR',
      guildId,
      expectedOrderVersion: 10,
      expectedParticipantVersion: 1,
      action: 'REMOVE',
      serviceCatalogVersionId: null,
      unitCount: null,
      linePriceMinor: null,
      reasonCode: 'REMOVE_AFTER_CAPTURE',
      idempotencyKey: 'm10-us-04:postgres:immutable',
      now
    })).rejects.toThrowError(expect.objectContaining({ code: 'BUSINESS_RULE_ERROR' }));
  });
});

function playerId(index: number) { return `00000000-0000-0000-0000-${String(104100 + index).padStart(12, '0')}`; }
function participantId(index: number) { return `00000000-0000-0000-0000-${String(104200 + index).padStart(12, '0')}`; }

async function seed() {
  const users = Array.from({ length: 9 }, (_, index) => `('${playerId(index + 1)}','陪玩猫${index + 1}','ACTIVE',1,now(),now())`).join(',');
  const participants = Array.from({ length: 9 }, (_, index) => {
    const number = index + 1;
    const readyAt = number === 9 ? 'NULL' : 'now()';
    return `('${participantId(number)}','${orderId}','${playerId(number)}','${catalogId}','ACTIVE',1,'陪玩猫${number}','DELTA','三角洲行动','${number % 2 ? 'TECH' : 'CHAT'}','${number % 2 ? '技术护航' : '聊天陪伴'}','NA','美服',60,1,100,100,'PERCENT_BPS',5000,'CATALOG_DEFAULT',50,${readyAt},'${staffId}',now(),now())`;
  }).join(',');
  await pool.query(`
    INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES
      ('${customerId}','老板猫','ACTIVE',1,now(),now()),('${staffUserId}','店长猫','ACTIVE',1,now(),now()),${users};
    INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,username,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000104008','${customerId}','${guildId}','${customerDiscordId}','老板猫#1024',now(),now());
    INSERT INTO staff_accounts(id,user_id,level,status,role_source,permissions_version,created_at,updated_at) VALUES
      ('${staffId}','${staffUserId}','L2_SUPERVISOR','ACTIVE','MANUAL',1,now(),now());
    INSERT INTO service_offerings(id,code,game_code,game_name,service_code,service_name,region_code,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000104009','DELTA-TECH-NA','DELTA','三角洲行动','TECH','技术护航','NA',now(),now());
    INSERT INTO service_catalog_versions(id,service_offering_id,version,status,billing_unit_minutes,minimum_units,customer_unit_price_minor,player_unit_payout_minor,default_player_payout_bps,currency,created_by_staff_id,created_at) VALUES
      ('${catalogId}','00000000-0000-0000-0000-000000104009',1,'ACTIVE',60,1,100,50,5000,'CAT','${staffId}',now());
    INSERT INTO orders(id,public_id,customer_id,player_id,active_customer_slot_id,active_player_slot_id,status,row_version,amount_minor,expected_player_earning_minor,currency,guild_id,channel_id,panel_message_id,customer_ready_at,player_ready_at,service_started_at,completion_requested_at,confirmation_due_at,created_at,updated_at) VALUES
      ('${orderId}','P-M10-CAPTURE','${customerId}','${playerId(1)}','${customerId}','${playerId(1)}','PENDING_CONFIRMATION',9,900,450,'CAT','${guildId}','222222222222222222','333333333333333333',now(),now(),now(),now(),now()+interval '30 minutes',now(),now());
    INSERT INTO wallet_accounts(id,user_id,currency,status,row_version,created_at,updated_at) VALUES
      ('${walletId}','${customerId}','CAT','ACTIVE',1,now(),now());
    INSERT INTO wallet_entries(id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at,created_at) VALUES
      ('00000000-0000-0000-0000-000000104010','${walletId}','TOP_UP_CREDIT','CREDIT',2000,'CAT','TOP_UP','00000000-0000-0000-0000-000000104011','m10-us-04:seed:credit',now(),now());
    INSERT INTO fund_reservations(id,user_id,source_type,order_id,mode,amount_minor,currency,status,row_version,idempotency_key,expires_at,activated_at,created_at,updated_at) VALUES
      ('${reservationId}','${customerId}','ORDER','${orderId}','LOCAL_RESERVATION',900,'CAT','ACTIVE',3,'m10-us-04:seed:reservation',now()+interval '30 minutes',now(),now(),now());
    INSERT INTO fund_reservation_events(id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,idempotency_key,actor_source,created_at) VALUES
      ('00000000-0000-0000-0000-000000104012','${reservationId}',1,'CREATED',NULL,'ACTIVE',900,1,'m10-us-04:seed:reservation:event','SYSTEM_JOB',now());
    INSERT INTO order_participants(id,order_id,player_id,service_catalog_version_id,status,row_version,player_display_name_snapshot,game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,region_code_snapshot,region_display_name_snapshot,billing_unit_minutes_snapshot,unit_count,customer_unit_price_minor_snapshot,line_price_minor,compensation_type_snapshot,compensation_value_snapshot,compensation_source,expected_earning_minor,ready_at,added_by_staff_id,created_at,updated_at) VALUES ${participants};
  `);
}
