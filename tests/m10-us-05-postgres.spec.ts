import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresGiftStore, type GiftRequestRecord, type GiftReservationRecord, type GiftStaffTaskRecord } from '@blackcat/api/gifts';
import type { AuditRecord } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const database = 'blackcat_m10_gifts';
const guildId = '999999999999999999';
const customerId = '00000000-0000-0000-0000-000000105001';
const staffUserId = '00000000-0000-0000-0000-000000105002';
const staffId = '00000000-0000-0000-0000-000000105003';
const orderId = '00000000-0000-0000-0000-000000105004';
const catalogId = '00000000-0000-0000-0000-000000105005';
const now = new Date('2026-08-04T14:00:00.000Z');
let root = '';
let data = '';
let port = 0;
let pool: Pool;

describe('M10-US-05 PostgreSQL multi-recipient gifts', () => {
  beforeAll(async () => {
    port = 62_800 + (process.pid % 100);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m10-gifts-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), database]);
    for (const migration of (await readdir('database/prisma/migrations')).sort()) {
      await execFile('psql', ['-h', root, '-p', String(port), '-d', database, '-v', 'ON_ERROR_STOP=1',
        '-f', `database/prisma/migrations/${migration}/migration.sql`]);
    }
    pool = new Pool({ host: root, port, database, max: 4 });
    await seed();
  }, 40_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('atomically creates nine receiver-derived gift, reservation, task and expiry facts', async () => {
    const store = new PostgresGiftStore(pool);
    const items = Array.from({ length: 9 }, (_, index) => giftItem(index + 1, 'success'));
    await store.commitCreateBatch({ items, ledgerBalanceMinor: 100_000, expectedOrderVersion: 7,
      expectedGuildId: guildId, now, auditRecord: audit('00000000-0000-0000-0000-000000105900'),
      auditSink: { append: async () => undefined } });

    const facts = await pool.query(`SELECT
      (SELECT count(*)::int FROM gift_requests WHERE order_id=$1) gift_count,
      (SELECT count(DISTINCT order_participant_id)::int FROM gift_requests WHERE order_id=$1) participant_count,
      (SELECT count(*)::int FROM fund_reservations reservation JOIN gift_requests gift ON gift.id=reservation.gift_request_id WHERE gift.order_id=$1) reservation_count,
      (SELECT COALESCE(sum(reservation.amount_minor),0)::text FROM fund_reservations reservation JOIN gift_requests gift ON gift.id=reservation.gift_request_id WHERE gift.order_id=$1) reserved_total,
      (SELECT count(*)::int FROM staff_tasks WHERE order_id=$1 AND type='GIFT_REVIEW') task_count,
      (SELECT count(*)::int FROM outbox_events WHERE aggregate_type='GIFT_REQUEST' AND event_type='GIFT_EXPIRY') expiry_count,
      (SELECT count(*)::int FROM audit_logs WHERE target_id::text=$1::text) audit_count`, [orderId]);
    expect(facts.rows[0]).toEqual({ gift_count: 9, participant_count: 9, reservation_count: 9,
      reserved_total: '1800', task_count: 9, expiry_count: 9, audit_count: 1 });
  });

  test('rolls the entire batch back when one participant-to-receiver binding is invalid', async () => {
    const store = new PostgresGiftStore(pool);
    const before = await pool.query<{ count: number }>('SELECT count(*)::int count FROM gift_requests');
    const items = [giftItem(1, 'invalid'), giftItem(2, 'invalid')];
    items[1]!.request.receiverId = playerId(3);
    await expect(store.commitCreateBatch({ items, ledgerBalanceMinor: 100_000, expectedOrderVersion: 7,
      expectedGuildId: guildId, now, auditRecord: audit('00000000-0000-0000-0000-000000105901'),
      auditSink: { append: async () => undefined } })).rejects.toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    const after = await pool.query<{ count: number }>('SELECT count(*)::int count FROM gift_requests');
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});

function playerId(index: number) { return `00000000-0000-0000-0000-${String(105100 + index).padStart(12, '0')}`; }
function participantId(index: number) { return `00000000-0000-0000-0000-${String(105200 + index).padStart(12, '0')}`; }
function factId(kind: number, index: number, suffix: string) {
  const seed = suffix === 'success' ? 105300 : 105600;
  return `00000000-0000-0000-0000-${String(seed + kind * 20 + index).padStart(12, '0')}`;
}

function giftItem(index: number, suffix: string): { request: GiftRequestRecord; reservation: GiftReservationRecord; staffTask: GiftStaffTaskRecord } {
  const requestId = factId(1, index, suffix);
  const reservationId = factId(2, index, suffix);
  const createdAt = now.toISOString();
  const request: GiftRequestRecord = { id: requestId, publicId: `G-${suffix.slice(0, 1).toUpperCase()}-${index}`,
    orderId, participantId: participantId(index), giftCatalogVersionId: catalogId, senderId: customerId,
    receiverId: playerId(index), status: 'PENDING_REVIEW', version: 1, giftCodeSnapshot: 'CAT_TREE',
    giftNameSnapshot: '猫爬架', priceMinor: 200, currency: 'CAT',
    broadcastTemplateSnapshot: '{sender_name}送给{receiver_name}一个{gift_name}', expiresAt: new Date(now.getTime() + 1_800_000).toISOString(),
    createdAt, updatedAt: createdAt };
  const reservation: GiftReservationRecord = { id: reservationId, userId: customerId, sourceType: 'GIFT', orderId: null,
    giftRequestId: requestId, mode: 'LOCAL_RESERVATION', provider: null, providerHoldRef: null, amountMinor: 200,
    currency: 'CAT', status: 'ACTIVE', version: 2, idempotencyKey: `m10-us-05:${suffix}:${index}`,
    expiresAt: request.expiresAt, activatedAt: createdAt, settledAt: null, createdAt, updatedAt: createdAt };
  const staffTask: GiftStaffTaskRecord = { id: factId(3, index, suffix), publicId: `T-${suffix.slice(0, 1).toUpperCase()}-${index}`,
    type: 'GIFT_REVIEW', reasonCode: 'GIFT_REQUESTED', status: 'OPEN', version: 1, orderId,
    giftRequestId: requestId, voiceChannelId: '333333333333333333', contextSnapshot: { orderId, orderPublicId: 'P-M10-GIFT',
      channelId: '222222222222222222', voiceChannelId: '333333333333333333', senderId: customerId,
      receiverId: playerId(index), giftCode: 'CAT_TREE', giftName: '猫爬架', priceMinor: 200, currency: 'CAT', reservationId },
    createdAt, updatedAt: createdAt };
  return { request, reservation, staffTask };
}

function audit(id: string): AuditRecord {
  return { id, actorId: customerId, actorStaffId: null, actorLevel: null, actorSource: 'DISCORD_BOT', clientId: 'DISCORD_BOT',
    interactionId: '444444444444444444', permissionCode: 'gift.request', action: 'CREATE_GIFT_REQUEST', targetType: 'order',
    targetId: orderId, outcome: 'SUCCEEDED', reason: null, requestId: `req_${id}`, approvalRequestId: null,
    occurredAt: now.toISOString(), changes: [] };
}

async function seed() {
  const users = Array.from({ length: 9 }, (_, index) => `('${playerId(index + 1)}','陪玩猫${index + 1}','ACTIVE',1,now(),now())`).join(',');
  const participants = Array.from({ length: 9 }, (_, index) => `('${participantId(index + 1)}','${orderId}','${playerId(index + 1)}','00000000-0000-0000-0000-000000105008','ACTIVE',1,'陪玩猫${index + 1}','DELTA','三角洲行动','TECH','技术护航','NA','美服',60,1,100,100,'PERCENT_BPS',5000,'CATALOG_DEFAULT',50,now(),'${staffId}',now(),now())`).join(',');
  await pool.query(`
    INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES
      ('${customerId}','老板猫','ACTIVE',1,now(),now()),('${staffUserId}','店长猫','ACTIVE',1,now(),now()),${users};
    INSERT INTO staff_accounts(id,user_id,level,status,role_source,permissions_version,created_at,updated_at) VALUES
      ('${staffId}','${staffUserId}','L2_SUPERVISOR','ACTIVE','MANUAL',1,now(),now());
    INSERT INTO service_offerings(id,code,game_code,game_name,service_code,service_name,region_code,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000105007','DELTA-TECH-NA','DELTA','三角洲行动','TECH','技术护航','NA',now(),now());
    INSERT INTO service_catalog_versions(id,service_offering_id,version,status,billing_unit_minutes,minimum_units,customer_unit_price_minor,player_unit_payout_minor,default_player_payout_bps,currency,created_by_staff_id,created_at) VALUES
      ('00000000-0000-0000-0000-000000105008','00000000-0000-0000-0000-000000105007',1,'ACTIVE',60,1,100,50,5000,'CAT','${staffId}',now());
    INSERT INTO orders(id,public_id,customer_id,player_id,active_customer_slot_id,active_player_slot_id,status,row_version,amount_minor,expected_player_earning_minor,currency,guild_id,channel_id,panel_message_id,voice_channel_id,created_at,updated_at) VALUES
      ('${orderId}','P-M10-GIFT','${customerId}','${playerId(1)}','${customerId}','${playerId(1)}','IN_SERVICE',7,900,450,'CAT','${guildId}','222222222222222222','222222222222222223','333333333333333333',now(),now());
    INSERT INTO order_participants(id,order_id,player_id,service_catalog_version_id,status,row_version,player_display_name_snapshot,game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,region_code_snapshot,region_display_name_snapshot,billing_unit_minutes_snapshot,unit_count,customer_unit_price_minor_snapshot,line_price_minor,compensation_type_snapshot,compensation_value_snapshot,compensation_source,expected_earning_minor,ready_at,added_by_staff_id,created_at,updated_at) VALUES ${participants};
    INSERT INTO gift_catalog_items(id,code,created_at,updated_at) VALUES ('00000000-0000-0000-0000-000000105009','CAT_TREE',now(),now());
    INSERT INTO gift_catalog_versions(id,gift_catalog_item_id,version,status,active_gift_key,name,price_minor,currency,broadcast_template,created_by_staff_id,activated_at,created_at) VALUES
      ('${catalogId}','00000000-0000-0000-0000-000000105009',1,'ACTIVE','00000000-0000-0000-0000-000000105009','猫爬架',200,'CAT','{sender_name}送给{receiver_name}一个{gift_name}','${staffId}',now(),now());
    INSERT INTO wallet_accounts(id,user_id,currency,status,row_version,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000105010','${customerId}','CAT','ACTIVE',1,now(),now());
    INSERT INTO wallet_entries(id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at,created_at) VALUES
      ('00000000-0000-0000-0000-000000105011','00000000-0000-0000-0000-000000105010','TOP_UP_CREDIT','CREDIT',100000,'CAT','TOP_UP','00000000-0000-0000-0000-000000105012','m10-us-05:seed:credit',now(),now());
  `);
}
