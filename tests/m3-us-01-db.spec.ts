import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresGiftStore, type GiftRequestRecord, type GiftReservationRecord, type GiftStaffTaskRecord } from '@blackcat/api/gifts';
import { InMemoryAuditSink, type AuditRecord } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T12:00:00.000Z');
const customerId = '00000000-0000-0000-0000-000000003201';
const playerId = '00000000-0000-0000-0000-000000003202';
const staffId = '00000000-0000-0000-0000-000000003203';
const orderId = '00000000-0000-0000-0000-000000003204';
const catalogItemId = '00000000-0000-0000-0000-000000003205';
const catalogVersionId = '00000000-0000-0000-0000-000000003206';
let tmpRoot = '';
let dataDir = '';
let socketDir = '';
let port = 0;
let pool: Pool;

describe('M3-US-01 PostgreSQL gift creation transaction', () => {
  beforeAll(async () => {
    port = 60_500 + (process.pid % 200);
    tmpRoot = await mkdtemp(join(tmpdir(), 'blackcat-m3-gifts-'));
    dataDir = join(tmpRoot, 'data');
    socketDir = tmpRoot;
    await execFile('initdb', ['-D', dataDir, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${socketDir}`, '-l', join(tmpRoot, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', socketDir, '-p', String(port), 'blackcat_m3_gifts']);
    await execFile('psql', ['-h', socketDir, '-p', String(port), '-d', 'blackcat_m3_gifts', '-v', 'ON_ERROR_STOP=1', '-f', 'database/prisma/migrations/000001_p0_baseline/migration.sql']);
    pool = new Pool({ host: socketDir, port, database: 'blackcat_m3_gifts', application_name: 'blackcat_m3_gifts_test' });
    await seed();
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (dataDir) await execFile('pg_ctl', ['-D', dataDir, 'stop', '-m', 'fast']).catch(() => undefined);
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  test('commits the request, active reservation lifecycle, and review task together', async () => {
    const store = new PostgresGiftStore(pool);
    await store.commitCreate({
      request: request(), reservation: reservation(), staffTask: task(), providerBalanceMinor: 1_000_000,
      expectedOrderVersion: 7, now,
      auditRecord: audit(), auditSink: new InMemoryAuditSink()
    });
    const result = await pool.query(`
SELECT
  (SELECT count(*) FROM gift_requests WHERE id = $1)::int AS requests,
  (SELECT count(*) FROM fund_reservations WHERE gift_request_id = $1)::int AS reservations,
  (SELECT count(*) FROM fund_reservation_events WHERE fund_reservation_id = $2)::int AS events,
  (SELECT count(*) FROM staff_tasks WHERE gift_request_id = $1)::int AS tasks,
  (SELECT count(*) FROM external_transactions WHERE gift_request_id = $1)::int AS captures,
  (SELECT count(*) FROM outbox_events WHERE aggregate_id = $1)::int AS broadcasts`, [request().id, reservation().id]);
    expect(result.rows[0]).toEqual({ requests: 1, reservations: 1, events: 2, tasks: 1, captures: 0, broadcasts: 0 });
  });

  test('rolls back every business row when the staff task insert fails', async () => {
    const store = new PostgresGiftStore(pool);
    const badRequest = request('00000000-0000-0000-0000-000000003220');
    const badReservation = reservation('00000000-0000-0000-0000-000000003221', badRequest.id);
    const badTask = { ...task('00000000-0000-0000-0000-000000003222', badRequest.id), publicId: task().publicId };
    await expect(store.commitCreate({ request: badRequest, reservation: badReservation, staffTask: badTask,
      providerBalanceMinor: 1_000_000, expectedOrderVersion: 7, now,
      auditRecord: audit(), auditSink: new InMemoryAuditSink() })).rejects.toThrow();
    const result = await pool.query(`SELECT
      (SELECT count(*) FROM gift_requests WHERE id = $1)::int AS requests,
      (SELECT count(*) FROM fund_reservations WHERE id = $2)::int AS reservations`, [badRequest.id, badReservation.id]);
    expect(result.rows[0]).toEqual({ requests: 0, reservations: 0 });
  });

  test('rejects a stale order or changed receiver inside the transaction', async () => {
    const store = new PostgresGiftStore(pool);
    const staleRequest = request('00000000-0000-0000-0000-000000003230');
    const staleReservation = reservation('00000000-0000-0000-0000-000000003231', staleRequest.id);
    const staleTask = task('00000000-0000-0000-0000-000000003232', staleRequest.id);
    await pool.query(`UPDATE orders SET row_version = 8 WHERE id = $1`, [orderId]);
    try {
      await expect(store.commitCreate({ request: staleRequest, reservation: staleReservation, staffTask: staleTask,
        providerBalanceMinor: 1_000_000, expectedOrderVersion: 7, now,
        auditRecord: audit(), auditSink: new InMemoryAuditSink() })).rejects.toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
      const result = await pool.query(`SELECT count(*)::int AS count FROM gift_requests WHERE id = $1`, [staleRequest.id]);
      expect(result.rows[0].count).toBe(0);
    } finally {
      await pool.query(`UPDATE orders SET row_version = 7 WHERE id = $1`, [orderId]);
    }
  });
});

function request(id = '00000000-0000-0000-0000-000000003210'): GiftRequestRecord {
  return { id, publicId: `G-${id.slice(-4)}`, orderId, giftCatalogVersionId: catalogVersionId, senderId: customerId,
    receiverId: playerId, status: 'PENDING_REVIEW', version: 1, giftCodeSnapshot: 'STAR_BOX',
    giftNameSnapshot: '星光礼盒', priceMinor: 199900, currency: 'CNY', broadcastTemplateSnapshot: '{sender_name}',
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

function reservation(id = '00000000-0000-0000-0000-000000003211', giftRequestId = request().id): GiftReservationRecord {
  return { id, userId: customerId, sourceType: 'GIFT', orderId: null, giftRequestId,
    mode: 'LOCAL_RESERVATION_FALLBACK', provider: 'mock-provider', providerHoldRef: null, amountMinor: 199900,
    currency: 'CNY', status: 'ACTIVE', version: 1, idempotencyKey: `gift:${giftRequestId}`,
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), activatedAt: now.toISOString(), settledAt: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

function task(id = '00000000-0000-0000-0000-000000003212', giftRequestId = request().id): GiftStaffTaskRecord {
  return { id, publicId: 'T-GIFT-3212', type: 'GIFT_REVIEW', reasonCode: 'GIFT_REQUESTED', status: 'OPEN', version: 1,
    orderId, giftRequestId, voiceChannelId: '900000000000000005', contextSnapshot: { orderId, orderPublicId: 'P-3204',
      channelId: '900000000000000003', voiceChannelId: '900000000000000005', senderId: customerId, receiverId: playerId,
      giftCode: 'STAR_BOX', giftName: '星光礼盒', priceMinor: 199900, currency: 'CNY', reservationId: reservation().id },
    createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

function audit(): AuditRecord {
  return { id: crypto.randomUUID(), actorId: customerId, actorStaffId: null, actorLevel: null, actorSource: 'DISCORD_BOT',
    clientId: 'DISCORD_BOT', interactionId: '900000000000000006', permissionCode: 'gift.request',
    action: 'CREATE_GIFT_REQUEST', targetType: 'gift_request', targetId: request().id, outcome: 'SUCCEEDED', reason: null,
    requestId: crypto.randomUUID(), approvalRequestId: null, occurredAt: now.toISOString(), beforeSnapshot: null, afterSnapshot: null };
}

async function seed() {
  await pool.query(`
INSERT INTO users (id, display_name, status, row_version, created_at, updated_at) VALUES
('${customerId}', 'Customer', 'ACTIVE', 1, now(), now()),
('${playerId}', 'Player', 'ACTIVE', 1, now(), now()),
('${staffId}', 'Admin', 'ACTIVE', 1, now(), now());
INSERT INTO staff_accounts (id, user_id, level, status, role_source, permissions_version, created_at, updated_at)
VALUES ('${staffId}', '${staffId}', 'L4_ADMIN_OWNER', 'ACTIVE', 'MANUAL', 1, now(), now());
INSERT INTO orders (id, public_id, customer_id, player_id, active_customer_slot_id, active_player_slot_id, status, row_version,
currency, amount_minor, guild_id, channel_id, panel_message_id, voice_channel_id, created_at, updated_at)
VALUES ('${orderId}', 'P-3204', '${customerId}', '${playerId}', '${customerId}', '${playerId}', 'IN_SERVICE', 7,
'CNY', 12000, '900000000000000001', '900000000000000003', '900000000000000004', '900000000000000005', now(), now());
INSERT INTO gift_catalog_items (id, code, created_at, updated_at)
VALUES ('${catalogItemId}', 'STAR_BOX', now(), now());
INSERT INTO gift_catalog_versions (id, gift_catalog_item_id, version, status, active_gift_key, name, price_minor, currency,
broadcast_template, created_by_staff_id, activated_at, created_at)
VALUES ('${catalogVersionId}', '${catalogItemId}', 1, 'ACTIVE', '${catalogItemId}', '星光礼盒', 199900, 'CNY',
'{sender_name}', '${staffId}', now(), now());`);
}
