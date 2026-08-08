import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresOperationsStore } from '@blackcat/api/operations';
import { InMemoryAuditSink, type AuditRecord, type StaffLevel } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T21:00:00.000Z');
const guildId = '900000000000006000';
const ids = {
  l1User: '00000000-0000-0000-0000-000000006011', l1Staff: '00000000-0000-0000-0000-000000006012',
  l2User: '00000000-0000-0000-0000-000000006021', l2Staff: '00000000-0000-0000-0000-000000006022',
  l3User: '00000000-0000-0000-0000-000000006031', l3Staff: '00000000-0000-0000-0000-000000006032',
  l4User: '00000000-0000-0000-0000-000000006041', l4Staff: '00000000-0000-0000-0000-000000006042',
  failedJob: '00000000-0000-0000-0000-000000006051', completedJob: '00000000-0000-0000-0000-000000006052',
  aggregate: '00000000-0000-0000-0000-000000006053'
};

let root = '';
let data = '';
let pool: Pool;

describe('M4-US-06 PostgreSQL operations', () => {
  beforeAll(async () => {
    const port = 61_700 + (process.pid % 200);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m4-operations-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m4_operations']);
    for (const directory of (await readdir('database/prisma/migrations')).sort()) {
      await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m4_operations', '-v', 'ON_ERROR_STOP=1', '-f', join('database/prisma/migrations', directory, 'migration.sql')]);
    }
    pool = new Pool({ host: root, port, database: 'blackcat_m4_operations' });
    await seed();
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('enforces self, Guild team, business, and all-system audit scopes', async () => {
    const store = new PostgresOperationsStore(pool);
    const list = (actorStaffId: string, actorLevel: StaffLevel) => store.listAuditLogs({
      actorStaffId, actorLevel, guildId, cursor: null, limit: 20
    });
    const [l1, l2, l3, l4] = await Promise.all([
      list(ids.l1Staff, 'L1_SUPPORT'), store.listAuditLogs({ actorStaffId: ids.l2Staff, actorLevel: 'L2_SUPERVISOR', guildId: null, cursor: null, limit: 20 }),
      list(ids.l3Staff, 'L3_OPERATIONS'), list(ids.l4Staff, 'L4_ADMIN_OWNER')
    ]);

    expect(l1.items.map((item) => item.action)).toEqual(['L1_ACTION']);
    expect(l2.items.map((item) => item.action)).toEqual(['L2_ACTION', 'L1_ACTION']);
    expect(l3.items.map((item) => item.action)).toEqual(['L3_ACTION', 'L2_ACTION', 'L1_ACTION']);
    expect(l4.items.map((item) => item.action)).toEqual(['SECURITY_ACTION', 'SYSTEM_ACTION', 'L3_ACTION', 'L2_ACTION', 'L1_ACTION']);
  });

  test('lists only failed delivery jobs and retries without replaying business payload or attempts', async () => {
    const store = new PostgresOperationsStore(pool);
    const listed = await store.listFailedJobs({ cursor: null, limit: 10, actorLevel: 'L2_SUPERVISOR', type: 'DISPATCH_MESSAGE' });
    expect(listed.items).toEqual([expect.objectContaining({ id: ids.failedJob, status: 'FAILED', attempts: 4, version: 4 })]);

    const write = await store.retryJob({ jobId: ids.failedJob, expectedVersion: 4, actorStaffId: ids.l2Staff, now });
    await write.commit(audit({ actorId: ids.l2User, actorStaffId: ids.l2Staff, actorLevel: 'L2_SUPERVISOR', action: 'RETRY_JOB', targetId: ids.failedJob }), new InMemoryAuditSink());
    const row = await pool.query(`SELECT status::text,row_version,attempt_count,payload FROM outbox_events WHERE id=$1`, [ids.failedJob]);
    expect(row.rows[0]).toEqual({ status: 'PENDING', row_version: 5, attempt_count: 4, payload: { operation: 'CREATE_PRIVATE_CHANNEL' } });
    const auditRow = await pool.query(`SELECT before_snapshot,after_snapshot,reason FROM audit_logs WHERE action='RETRY_JOB'`);
    expect(auditRow.rows[0]).toMatchObject({ before_snapshot: { status: 'FAILED', attempts: 4, version: 4 }, after_snapshot: { status: 'PENDING', attempts: 4, version: 5 }, reason: 'M4_US_06_TEST' });
  });

  test('persists one redacted channel failure and its audit atomically', async () => {
    const store = new PostgresOperationsStore(pool);
    const input = { requestId: 'req_channel_failure_db', guildId, discordUserId: '900000000000006099', interactionId: '900000000000006098', now };
    const first = await store.recordChannelCreationFailure(input);
    const replay = await store.recordChannelCreationFailure(input);
    await first.commit(audit({ actorId: ids.l1User, actorStaffId: null, actorLevel: null, actorSource: 'DISCORD_BOT', action: 'RECORD_CHANNEL_CREATION_FAILURE', targetId: first.data.id }), new InMemoryAuditSink());
    await replay.commit(audit({ actorId: ids.l1User, actorStaffId: null, actorLevel: null, actorSource: 'DISCORD_BOT', action: 'RECORD_CHANNEL_CREATION_FAILURE', targetId: replay.data.id }), new InMemoryAuditSink());
    const rows = await pool.query(`SELECT event_type,status::text,last_error,payload FROM outbox_events WHERE event_type='CHANNEL_CREATE_FAILURE'`);
    expect(rows.rows).toEqual([{ event_type: 'CHANNEL_CREATE_FAILURE', status: 'FAILED', last_error: 'CHANNEL_CREATE_FAILED; requestId=req_channel_failure_db',
      payload: { guildId, discordUserId: '900000000000006099', interactionId: '900000000000006098' } }]);
    const audits = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM audit_logs WHERE action='RECORD_CHANNEL_CREATION_FAILURE'`);
    expect(audits.rows[0]?.count).toBe('1');
  });

  test('appends policy versions atomically and rejects stale concurrent updates', async () => {
    const store = new PostgresOperationsStore(pool);
    const first = await store.updatePolicySetting({ key: 'CUSTOMER_NO_SHOW_REVIEW_MINUTES', expectedVersion: 0, integerValue: 5, currency: null, actorStaffId: ids.l3Staff, now });
    await first.commit(audit({ action: 'UPDATE_POLICY_SETTING', targetId: 'CUSTOMER_NO_SHOW_REVIEW_MINUTES' }), new InMemoryAuditSink());
    const stale = await store.updatePolicySetting({ key: 'CUSTOMER_NO_SHOW_REVIEW_MINUTES', expectedVersion: 1, integerValue: 7, currency: null, actorStaffId: ids.l3Staff, now });
    const winner = await store.updatePolicySetting({ key: 'CUSTOMER_NO_SHOW_REVIEW_MINUTES', expectedVersion: 1, integerValue: 9, currency: null, actorStaffId: ids.l3Staff, now });
    const results = await Promise.allSettled([
      stale.commit(audit({ action: 'UPDATE_POLICY_SETTING', targetId: 'CUSTOMER_NO_SHOW_REVIEW_MINUTES' }), new InMemoryAuditSink()),
      winner.commit(audit({ action: 'UPDATE_POLICY_SETTING', targetId: 'CUSTOMER_NO_SHOW_REVIEW_MINUTES' }), new InMemoryAuditSink())
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const versions = await pool.query(`SELECT version,value,active_setting_key FROM policy_setting_versions WHERE key='CUSTOMER_NO_SHOW_REVIEW_MINUTES' ORDER BY version`);
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows.map((row) => row.version)).toEqual([1, 2]);
    expect(versions.rows.filter((row) => row.active_setting_key)).toHaveLength(1);
  });

  test('rolls back a policy version when the same transaction cannot persist its audit', async () => {
    const store = new PostgresOperationsStore(pool);
    const before = await store.getPolicySettings();
    const write = await store.updatePolicySetting({ key: 'PLAYER_START_GRACE_MINUTES', expectedVersion: 0, integerValue: 15, currency: null, actorStaffId: ids.l3Staff, now });
    await expect(write.commit(audit({ actorStaffId: crypto.randomUUID(), action: 'UPDATE_POLICY_SETTING', targetId: 'PLAYER_START_GRACE_MINUTES' }), new InMemoryAuditSink())).rejects.toThrow();
    expect(await store.getPolicySettings()).toEqual(before);
  });
});

function audit(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: crypto.randomUUID(), actorId: ids.l3User, actorStaffId: ids.l3Staff, actorLevel: 'L3_OPERATIONS', actorSource: 'DASHBOARD', clientId: 'DASHBOARD', interactionId: null,
    permissionCode: 'policy.manage', action: 'M4_US_06', targetType: 'operations', targetId: ids.aggregate, outcome: 'SUCCEEDED', reason: 'M4_US_06_TEST', requestId: `req_${crypto.randomUUID()}`,
    approvalRequestId: null, occurredAt: now.toISOString(), ...overrides
  };
}

async function seed() {
  await pool.query(`
    INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
      ('${ids.l1User}','L1','ACTIVE',1,now(),now()),('${ids.l2User}','L2','ACTIVE',1,now(),now()),
      ('${ids.l3User}','L3','ACTIVE',1,now(),now()),('${ids.l4User}','L4','ACTIVE',1,now(),now());
    INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at) VALUES
      ('${ids.l1Staff}','${ids.l1User}','L1_SUPPORT','ACTIVE','MANUAL',1,now(),now()),
      ('${ids.l2Staff}','${ids.l2User}','L2_SUPERVISOR','ACTIVE','MANUAL',1,now(),now()),
      ('${ids.l3Staff}','${ids.l3User}','L3_OPERATIONS','ACTIVE','MANUAL',1,now(),now()),
      ('${ids.l4Staff}','${ids.l4User}','L4_ADMIN_OWNER','ACTIVE','MANUAL',1,now(),now());
    INSERT INTO discord_accounts (id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES
      (gen_random_uuid(),'${ids.l1User}','${guildId}','900000000000006011',now(),now(),now()),
      (gen_random_uuid(),'${ids.l2User}','${guildId}','900000000000006021',now(),now(),now()),
      (gen_random_uuid(),'${ids.l3User}','${guildId}','900000000000006031',now(),now(),now()),
      (gen_random_uuid(),'${ids.l4User}','${guildId}','900000000000006041',now(),now(),now());
    INSERT INTO audit_logs (id,actor_user_id,actor_staff_id,actor_level,actor_source,client_id,permission_code,action,target_type,target_id,outcome,request_id,created_at) VALUES
      (gen_random_uuid(),'${ids.l1User}','${ids.l1Staff}','L1_SUPPORT','DASHBOARD','DASHBOARD','audit.fixture','L1_ACTION','ORDER','${ids.aggregate}','SUCCEEDED','req_l1','2026-07-18T20:01:00Z'),
      (gen_random_uuid(),'${ids.l2User}','${ids.l2Staff}','L2_SUPERVISOR','DASHBOARD','DASHBOARD','audit.fixture','L2_ACTION','ORDER','${ids.aggregate}','SUCCEEDED','req_l2','2026-07-18T20:02:00Z'),
      (gen_random_uuid(),'${ids.l3User}','${ids.l3Staff}','L3_OPERATIONS','DASHBOARD','DASHBOARD','audit.fixture','L3_ACTION','ORDER','${ids.aggregate}','SUCCEEDED','req_l3','2026-07-18T20:03:00Z'),
      (gen_random_uuid(),NULL,NULL,NULL,'SYSTEM_JOB','OUTBOX_WORKER','audit.fixture','SYSTEM_ACTION','ORDER','${ids.aggregate}','SUCCEEDED','req_system','2026-07-18T20:04:00Z'),
      (gen_random_uuid(),'${ids.l4User}','${ids.l4Staff}','L4_ADMIN_OWNER','DASHBOARD','DASHBOARD','access.manage','SECURITY_ACTION','STAFF_ACCOUNT','${ids.l4Staff}','SUCCEEDED','req_security','2026-07-18T20:05:00Z');
    INSERT INTO outbox_events (id,event_type,aggregate_type,aggregate_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,last_error,created_at,updated_at) VALUES
      ('${ids.failedJob}','DISPATCH_MESSAGE','ORDER','${ids.aggregate}','m4-us-06-failed','{"operation":"CREATE_PRIVATE_CHANNEL"}','FAILED',4,4,4,now(),'requestId=req_channel_failure',now(),now()),
      ('${ids.completedJob}','DISPATCH_MESSAGE','ORDER','${ids.aggregate}','m4-us-06-complete','{}','COMPLETED',2,1,4,now(),NULL,now(),now());
  `);
}
