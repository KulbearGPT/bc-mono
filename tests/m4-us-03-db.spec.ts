import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresAdminDirectoryStore } from '@blackcat/api/admin-directory';
import { InMemoryAuditSink, PostgresAuditSink, type AuditRecord } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const ids = {
  staff: '00000000-0000-0000-0000-000000004301',
  customer: '00000000-0000-0000-0000-000000004302',
  player: '00000000-0000-0000-0000-000000004303',
  playerProfile: '00000000-0000-0000-0000-000000004304',
  order: '00000000-0000-0000-0000-000000004305',
  gift: '00000000-0000-0000-0000-000000004306',
  giftVersion: '00000000-0000-0000-0000-000000004315',
  giftRequest: '00000000-0000-0000-0000-000000004307',
  outbox: '00000000-0000-0000-0000-000000004308',
  audit: '00000000-0000-0000-0000-000000004309'
};

let root = '';
let data = '';
let pool: Pool;

describe('M4-US-03 PostgreSQL admin directory', () => {
  beforeAll(async () => {
    const port = 61_100 + (process.pid % 200);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m4-admin-directory-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m4_admin_directory']);
    await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m4_admin_directory', '-v', 'ON_ERROR_STOP=1', '-f', 'database/prisma/migrations/000001_p0_baseline/migration.sql']);
    await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m4_admin_directory', '-v', 'ON_ERROR_STOP=1', '-f', 'database/prisma/migrations/000013_business_tags/migration.sql']);
    pool = new Pool({ host: root, port, database: 'blackcat_m4_admin_directory' });
    await seed();
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('searches users by Discord ID and returns the staff detail projection once', async () => {
    const store = new PostgresAdminDirectoryStore(pool);
    const result = await store.listUsers({ cursor: null, limit: 10, query: '900000000000004302' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: ids.customer, displayName: 'Customer', discordUserId: '900000000000004302', discordUsername: null, activeOrderId: ids.order, version: 1 });
    expect(result.items[0]?.createdAt).toEqual(expect.any(String));
    expect(result.items[0]?.updatedAt).toEqual(expect.any(String));
  });

  test('keeps the second user page stable when a new first-page row is inserted', async () => {
    const store = new PostgresAdminDirectoryStore(pool);
    const first = await store.listUsers({ cursor: null, limit: 1 });
    expect(first.items.map((item) => item.id)).toEqual([ids.player]);

    await pool.query(`INSERT INTO users (id,display_name,status,row_version,created_at,updated_at)
      VALUES ('00000000-0000-0000-0000-000000004399','New first row','ACTIVE',1,now(),now())`);
    const second = await store.listUsers({ cursor: first.nextCursor, limit: 1 });

    expect(second.items.map((item) => item.id)).toEqual([ids.customer]);
  });

  test('applies player and consumption filters in PostgreSQL', async () => {
    const store = new PostgresAdminDirectoryStore(pool);
    const players = await store.listPlayers({ cursor: null, limit: 10, reviewStatus: 'ACTIVE' });
    const absent = await store.listPlayers({ cursor: null, limit: 10, reviewStatus: 'PENDING_REVIEW' });
    const consumptions = await store.listUserConsumptions({ cursor: null, limit: 10, userId: ids.customer, type: 'ORDER' });
    const corrections = await store.listUserConsumptions({ cursor: null, limit: 10, userId: ids.customer, type: 'ADMIN_CORRECTION' });
    const giftRequests = await store.listGiftRequests({ cursor: null, limit: 10, actorStaffId: ids.staff, actorLevel: 'L3_OPERATIONS' });
    const giftRequest = await store.getGiftRequest({ giftRequestId: ids.giftRequest, actorStaffId: ids.staff, actorLevel: 'L3_OPERATIONS' });
    const giftCatalog = await store.getGiftCatalog(ids.gift);
    expect(players.items).toEqual([expect.objectContaining({ playerId: ids.playerProfile, userId: ids.player, displayName: 'Player', activeOrderId: ids.order, gameTagDetails: expect.any(Array), serviceTagDetails: expect.any(Array), languageTagDetails: expect.any(Array), version: 1 })]);
    expect(absent.items).toEqual([]);
    expect(consumptions.items).toEqual([expect.objectContaining({ type: 'ORDER', amountMinor: 12000 })]);
    expect(corrections.items).toEqual([expect.objectContaining({ type: 'ADMIN_CORRECTION', amountMinor: -300 })]);
    expect(giftRequests.items).toEqual([expect.objectContaining({ id: ids.giftRequest, rowVersion: 4, announcementStatus: 'FAILED' })]);
    expect(giftRequest).toMatchObject({ id: ids.giftRequest, rowVersion: 4, announcementStatus: 'FAILED', orderPublicId: 'P-4305', orderStatus: 'IN_SERVICE', giftCode: 'ROCKET', senderDisplayName: 'Customer', receiverDisplayName: 'Player', senderDiscordUserId: '900000000000004302', reservationStatus: null, verifiedByStaffId: null, capturedAt: expect.any(String), expiresAt: expect.any(String), updatedAt: expect.any(String) });
    expect(giftCatalog).toMatchObject({ id: ids.gift, giftCatalogVersionId: ids.giftVersion, status: 'ACTIVE', createdByStaffId: ids.staff, activatedAt: expect.any(String), archivedAt: null });
  });

  test('persists generic audit records with the established audit_logs field semantics', async () => {
    const sink = new PostgresAuditSink({ client: pool });
    const record = audit({ id: ids.audit, permissionCode: 'audit.read', action: 'READ_ADMIN_AUDIT', targetType: 'audit_log', targetId: ids.audit,
      reason: 'SUPPORT_REVIEW', requestId: 'req_m4_persistent_audit', beforeSnapshot: { status: 'BEFORE' }, afterSnapshot: { status: 'AFTER' } });

    await sink.append(record);

    const result = await pool.query(`SELECT actor_user_id, actor_staff_id, actor_level::text, actor_source::text, client_id,
      interaction_id, permission_code, action, target_type, target_id, outcome::text, before_snapshot, after_snapshot,
      reason, request_id, approval_request_id, created_at FROM audit_logs WHERE id = $1`, [ids.audit]);
    expect(result.rows[0]).toEqual({
      actor_user_id: ids.staff, actor_staff_id: ids.staff, actor_level: 'L3_OPERATIONS', actor_source: 'DASHBOARD', client_id: 'DASHBOARD',
      interaction_id: null, permission_code: 'audit.read', action: 'READ_ADMIN_AUDIT', target_type: 'audit_log', target_id: ids.audit,
      outcome: 'SUCCEEDED', before_snapshot: { status: 'BEFORE' }, after_snapshot: { status: 'AFTER' }, reason: 'SUPPORT_REVIEW',
      request_id: 'req_m4_persistent_audit', approval_request_id: null, created_at: new Date(record.occurredAt)
    });

    const unknownSource = audit({ id: '00000000-0000-0000-0000-000000004310', actorId: null, actorStaffId: null,
      actorLevel: null, actorSource: 'UNKNOWN', clientId: 'UNKNOWN', outcome: 'REJECTED', reason: 'INVALID_CLIENT_SOURCE' });
    await sink.append(unknownSource);
    const rejected = await pool.query(`SELECT actor_source::text, client_id, outcome::text, reason FROM audit_logs WHERE id = $1`, [unknownSource.id]);
    expect(rejected.rows[0]).toEqual({ actor_source: 'UNKNOWN', client_id: 'UNKNOWN', outcome: 'REJECTED', reason: 'INVALID_CLIENT_SOURCE' });
  });

  test('scopes L1 order lists to personally claimed tasks', async () => {
    const store = new PostgresAdminDirectoryStore(pool);
    const visible = await store.listOrders({ cursor: null, limit: 10, actorStaffId: ids.staff, actorLevel: 'L1_SUPPORT' });
    const hidden = await store.listOrders({ cursor: null, limit: 10, actorStaffId: '00000000-0000-0000-0000-000000004399', actorLevel: 'L1_SUPPORT' });
    expect(visible.items).toEqual([expect.objectContaining({ id: ids.order })]);
    expect(hidden.items).toEqual([]);
  });

  test('rolls back all three admin mutations when the transactional audit insert fails', async () => {
    const store = new PostgresAdminDirectoryStore(pool);
    const auditSink = new InMemoryAuditSink();
    const invalidStaffId = '00000000-0000-0000-0000-000000004399';

    const userWrite = await store.setUserStatus({ userId: ids.customer, expectedVersion: 1, status: 'SUSPENDED',
      reasonCode: 'RISK_REVIEW', note: 'must roll back', actorStaffId: ids.staff, now: new Date('2026-07-18T11:00:00Z') });
    await expect(userWrite.commit(audit({ actorStaffId: invalidStaffId, targetType: 'user', targetId: ids.customer }), auditSink)).rejects.toThrow();
    const user = await pool.query(`SELECT status::text, row_version FROM users WHERE id = $1`, [ids.customer]);
    expect(user.rows[0]).toEqual({ status: 'ACTIVE', row_version: 1 });

    const itemCountBefore = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM gift_catalog_items`);
    const createWrite = await store.createGiftCatalog({ name: 'Bouquet', amountMinor: 1800, currency: 'CAT', enabled: true,
      broadcastTemplate: '{sender} sent {gift}', reasonCode: 'INITIAL_VERSION', actorStaffId: ids.staff, now: new Date('2026-07-18T11:10:00Z') });
    await expect(createWrite.commit(audit({ actorStaffId: invalidStaffId, targetType: 'gift_catalog', targetId: createWrite.data.id }), auditSink)).rejects.toThrow();
    const itemCountAfter = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM gift_catalog_items`);
    expect(itemCountAfter.rows[0]).toEqual(itemCountBefore.rows[0]);

    const updateWrite = await store.updateGiftCatalog({ giftCatalogId: ids.gift, expectedVersion: 1, action: 'DISABLE', replacement: null,
      reasonCode: 'TEMPORARILY_UNAVAILABLE', actorStaffId: ids.staff, now: new Date('2026-07-18T11:20:00Z') });
    await expect(updateWrite.commit(audit({ actorStaffId: invalidStaffId, targetType: 'gift_catalog', targetId: ids.gift }), auditSink)).rejects.toThrow();
    const versions = await pool.query(`SELECT version, status::text FROM gift_catalog_versions WHERE gift_catalog_item_id = $1 ORDER BY version`, [ids.gift]);
    expect(versions.rows).toEqual([{ version: 1, status: 'ACTIVE' }]);
    expect(auditSink.records).toEqual([]);
  });

  test('updates a gift by appending one version in a transaction', async () => {
    const store = new PostgresAdminDirectoryStore(pool);
    const write = await store.updateGiftCatalog({ giftCatalogId: ids.gift, expectedVersion: 1, action: 'DISABLE', replacement: null,
      reasonCode: 'TEMPORARILY_UNAVAILABLE', actorStaffId: ids.staff, now: new Date('2026-07-18T12:00:00Z') });
    await write.commit(audit({ targetType: 'gift_catalog', targetId: ids.gift }), new InMemoryAuditSink());
    const updated = write.data;
    expect(updated).toMatchObject({ id: ids.gift, enabled: false, version: 2 });
    const versions = await pool.query(`SELECT version, status::text FROM gift_catalog_versions WHERE gift_catalog_item_id = $1 ORDER BY version`, [ids.gift]);
    expect(versions.rows).toEqual([{ version: 1, status: 'RETIRED' }, { version: 2, status: 'DRAFT' }]);
    const catalog = await store.listGiftCatalog({ cursor: null, limit: 10 });
    expect(catalog.items).toEqual([expect.objectContaining({ id: ids.gift, enabled: false, version: 2 })]);
  });
});

function audit(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: crypto.randomUUID(), actorId: ids.staff, actorStaffId: ids.staff, actorLevel: 'L3_OPERATIONS', actorSource: 'DASHBOARD',
    clientId: 'DASHBOARD', interactionId: null, permissionCode: 'gift_catalog.manage', action: 'M4_ADMIN_WRITE',
    targetType: 'gift_catalog', targetId: ids.gift, outcome: 'SUCCEEDED', reason: 'TEST', requestId: `req_${crypto.randomUUID()}`,
    approvalRequestId: null, occurredAt: new Date('2026-07-18T12:00:00Z').toISOString(), ...overrides
  };
}

async function seed() {
  await pool.query(`INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
    ('${ids.staff}','Operator','ACTIVE',1,now(),now()),
    ('${ids.customer}','Customer','ACTIVE',1,now(),now()),
    ('${ids.player}','Player','ACTIVE',1,now(),now());
    INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
    VALUES ('${ids.staff}','${ids.staff}','L3_OPERATIONS','ACTIVE','MANUAL',1,now(),now());
    INSERT INTO discord_accounts (id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at)
    VALUES ('00000000-0000-0000-0000-000000004311','${ids.customer}','900000000000004300','900000000000004302',now(),now(),now());
    INSERT INTO external_accounts (id,user_id,provider,external_user_id,status,active_user_provider_key,verified_at,created_at,updated_at) VALUES
    ('00000000-0000-0000-0000-000000004312','${ids.customer}','mock-a','external-a','ACTIVE','${ids.customer}:mock-a',now(),now(),now()),
    ('00000000-0000-0000-0000-000000004313','${ids.customer}','mock-b','external-b','ACTIVE','${ids.customer}:mock-b',now(),now(),now());
    INSERT INTO player_profiles (id,user_id,review_status,row_version,availability,discord_presence,created_at,updated_at)
    VALUES ('${ids.playerProfile}','${ids.player}','ACTIVE',1,'AVAILABLE','ONLINE',now(),now());
    INSERT INTO orders (id,public_id,customer_id,player_id,active_customer_slot_id,active_player_slot_id,status,row_version,currency,amount_minor,guild_id,channel_id,panel_message_id,created_at,updated_at)
    VALUES ('${ids.order}','P-4305','${ids.customer}','${ids.player}','${ids.customer}','${ids.player}','IN_SERVICE',2,'CAT',12000,'900000000000004300','900000000000004303','900000000000004304',now(),now());
    INSERT INTO staff_tasks (id,public_id,type,reason_code,status,row_version,order_id,claimed_by_staff_id,context_snapshot,claimed_at,created_at,updated_at)
    VALUES ('00000000-0000-0000-0000-000000004316','T-4316','ORDER_ASSIST','CUSTOMER_ASSIST','CLAIMED',1,'${ids.order}','${ids.staff}','{}',now(),now(),now());
    INSERT INTO consumption_entries (id,user_id,entry_type,source_type,source_id,idempotency_key,order_id,amount_minor,currency,direction,occurred_at,created_at)
    VALUES ('00000000-0000-0000-0000-000000004314','${ids.customer}','ORDER_CHARGE','ORDER','${ids.order}','m4:admin:order:4305','${ids.order}',12000,'CAT','DEBIT',now(),now()),
      ('00000000-0000-0000-0000-000000004318','${ids.customer}','ADMIN_CORRECTION','ADMIN','00000000-0000-0000-0000-000000004319','m4:admin:correction:4318',NULL,300,'CAT','CREDIT',now(),now());
    INSERT INTO gift_catalog_items (id,code,created_at,updated_at) VALUES ('${ids.gift}','ROCKET',now(),now());
    INSERT INTO gift_catalog_versions (id,gift_catalog_item_id,version,status,active_gift_key,name,price_minor,currency,broadcast_template,created_by_staff_id,activated_at,created_at)
    VALUES ('00000000-0000-0000-0000-000000004315','${ids.gift}',1,'ACTIVE','${ids.gift}','Rocket',5200,'CAT','{sender} sent {gift}','${ids.staff}',now(),now());
    INSERT INTO gift_requests (id,public_id,order_id,gift_catalog_version_id,sender_id,receiver_id,status,row_version,gift_code_snapshot,gift_name_snapshot,price_minor,currency,broadcast_template_snapshot,captured_at,expires_at,created_at,updated_at)
    VALUES ('${ids.giftRequest}','G-4307','${ids.order}','00000000-0000-0000-0000-000000004315','${ids.customer}','${ids.player}','CAPTURED',4,'ROCKET','Rocket',5200,'CAT','{sender} sent {gift}',now(),now() + interval '1 hour',now(),now());
    INSERT INTO outbox_events (id,event_type,aggregate_type,aggregate_id,gift_request_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,last_error,created_at,updated_at)
    VALUES ('${ids.outbox}','GIFT_ANNOUNCEMENT','GIFT_REQUEST','${ids.giftRequest}','${ids.giftRequest}','gift:announcement:${ids.giftRequest}:v1','{}','FAILED',4,8,8,now(),'Discord unavailable',now(),now());`);
}
