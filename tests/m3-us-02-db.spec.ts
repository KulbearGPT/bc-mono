import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresGiftStore } from '@blackcat/api/gifts';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T13:00:00.000Z');
const customerId = '00000000-0000-0000-0000-000000003501';
const playerId = '00000000-0000-0000-0000-000000003502';
const staffId = '00000000-0000-0000-0000-000000003503';
const orderId = '00000000-0000-0000-0000-000000003504';
const giftId = '00000000-0000-0000-0000-000000003505';
const reservationId = '00000000-0000-0000-0000-000000003506';
const taskId = '00000000-0000-0000-0000-000000003507';
let root = '';
let data = '';
let port = 0;
let pool: Pool;

describe('M3-US-02 PostgreSQL gift review authorization', () => {
  beforeAll(async () => {
    port = 60_700 + (process.pid % 200);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m3-gift-review-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m3_gift_review']);
    await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m3_gift_review', '-v', 'ON_ERROR_STOP=1', '-f', 'database/prisma/migrations/000001_p0_baseline/migration.sql']);
    pool = new Pool({ host: root, port, database: 'blackcat_m3_gift_review' });
    await seed();
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('persists verification credential then creates immutable L3 escalation at 200100', async () => {
    const store = new PostgresGiftStore(pool);
    const verified = await store.verifyTask({ taskId, expectedVersion: 2, actorStaffId: staffId,
      verificationMethod: 'DIRECT_MESSAGE', notes: 'Confirmed gift, target, amount and intent.', now });
    expect(verified.executionCredential.payloadHash).toMatch(/^[a-f0-9]{64}$/);

    const result = await store.authorizeGift({ giftRequestId: giftId, expectedVersion: 2, actorStaffId: staffId,
      actorLevel: 'L2_SUPERVISOR', reason: 'Verified high-value gift.', now });
    expect(result).toMatchObject({ code: 'APPROVAL_PENDING', requiredLevel: 'L3_OPERATIONS', actionExecuted: false });
    const persisted = await pool.query(`SELECT gr.status, gr.row_version, gr.verification_payload_hash,
      st.status AS task_status, ar.action, ar.required_level, ar.payload_hash
      FROM gift_requests gr JOIN staff_tasks st ON st.gift_request_id = gr.id
      JOIN approval_requests ar ON ar.target_id = gr.id WHERE gr.id = $1`, [giftId]);
    expect(persisted.rows[0]).toMatchObject({ status: 'PENDING_APPROVAL', row_version: 3, task_status: 'PENDING_APPROVAL',
      action: 'GIFT_APPROVE', required_level: 'L3_OPERATIONS', verification_payload_hash: expect.any(String), payload_hash: expect.any(String) });
    await expect(store.authorizeGift({ giftRequestId: giftId, expectedVersion: 2, actorStaffId: staffId,
      actorLevel: 'L3_OPERATIONS', reason: 'Stale retry.', now })).rejects.toThrowError(expect.objectContaining({ code: 'EXECUTION_CREDENTIAL_STALE' }));
  });
});

async function seed() {
  const itemId = '00000000-0000-0000-0000-000000003508';
  const versionId = '00000000-0000-0000-0000-000000003509';
  await pool.query(`
INSERT INTO users (id, display_name, status, row_version, created_at, updated_at) VALUES
('${customerId}', 'Customer', 'ACTIVE', 1, now(), now()), ('${playerId}', 'Player', 'ACTIVE', 1, now(), now()),
('${staffId}', 'Supervisor', 'ACTIVE', 1, now(), now());
INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
VALUES ('${staffId}','${staffId}','L2_SUPERVISOR','ACTIVE','MANUAL',1,now(),now());
INSERT INTO orders (id,public_id,customer_id,player_id,active_customer_slot_id,active_player_slot_id,status,row_version,
currency,amount_minor,guild_id,channel_id,panel_message_id,voice_channel_id,created_at,updated_at)
VALUES ('${orderId}','P-3504','${customerId}','${playerId}','${customerId}','${playerId}','IN_SERVICE',7,
'CNY',12000,'900000000000000001','900000000000000003','900000000000000004','900000000000000005',now(),now());
INSERT INTO gift_catalog_items (id,code,created_at,updated_at) VALUES ('${itemId}','STAR',now(),now());
INSERT INTO gift_catalog_versions (id,gift_catalog_item_id,version,status,active_gift_key,name,price_minor,currency,broadcast_template,created_by_staff_id,activated_at,created_at)
VALUES ('${versionId}','${itemId}',1,'ACTIVE','${itemId}','星光礼盒',200100,'CNY','{sender_name}','${staffId}',now(),now());
INSERT INTO gift_requests (id,public_id,order_id,gift_catalog_version_id,sender_id,receiver_id,status,row_version,gift_code_snapshot,gift_name_snapshot,price_minor,currency,broadcast_template_snapshot,expires_at,created_at,updated_at)
VALUES ('${giftId}','G-3505','${orderId}','${versionId}','${customerId}','${playerId}','PENDING_REVIEW',1,'STAR','星光礼盒',200100,'CNY','{sender_name}',now()+interval '30 minutes',now(),now());
INSERT INTO fund_reservations (id,user_id,source_type,gift_request_id,mode,provider,amount_minor,currency,status,row_version,idempotency_key,expires_at,created_at,updated_at)
VALUES ('${reservationId}','${customerId}','GIFT','${giftId}','LOCAL_RESERVATION_FALLBACK','mock-provider',200100,'CNY','PENDING',1,'gift:3505',now()+interval '30 minutes',now(),now());
INSERT INTO fund_reservation_events (id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,idempotency_key,actor_user_id,actor_source,created_at)
VALUES ('00000000-0000-0000-0000-000000003510','${reservationId}',1,'CREATED',NULL,'PENDING',200100,1,'gift:3505:created','${customerId}','DISCORD_BOT',now());
INSERT INTO fund_reservation_events (id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,idempotency_key,actor_user_id,actor_source,created_at)
VALUES ('00000000-0000-0000-0000-000000003511','${reservationId}',2,'ACTIVATED','PENDING','ACTIVE',0,2,'gift:3505:activated','${customerId}','DISCORD_BOT',now());
INSERT INTO staff_tasks (id,public_id,type,reason_code,status,row_version,order_id,gift_request_id,claimed_by_staff_id,voice_channel_id,context_snapshot,claimed_at,created_at,updated_at)
VALUES ('${taskId}','T-GIFT-3507','GIFT_REVIEW','GIFT_REQUESTED','CLAIMED',2,'${orderId}','${giftId}','${staffId}','900000000000000005',
'{"orderId":"${orderId}","reservationId":"${reservationId}"}'::jsonb,now(),now(),now());`);
}
