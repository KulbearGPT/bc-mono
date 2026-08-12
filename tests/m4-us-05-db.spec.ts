import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Pool } from 'pg';
import { PostgresAccessStore, enqueuePeriodicRoleReconciliation } from '@blackcat/api/access';
import { InMemoryAuditSink, type AuditRecord } from '@blackcat/api/security';
import { startIsolatedPostgres, type IsolatedPostgres } from './support/isolated-postgres';

const now = new Date('2026-07-18T20:00:00.000Z');
const guildId = '900000000000005000';
const role = {
  l1: '900000000000005101',
  l2: '900000000000005102',
  l3: '900000000000005103',
  l4: '900000000000005104'
};
const ids = {
  ownerUser: '00000000-0000-0000-0000-000000005501',
  ownerStaff: '00000000-0000-0000-0000-000000005502',
  targetUser: '00000000-0000-0000-0000-000000005503',
  targetStaff: '00000000-0000-0000-0000-000000005504',
  newcomerUser: '00000000-0000-0000-0000-000000005505',
  ownerDiscord: '900000000000005201',
  targetDiscord: '900000000000005202',
  newcomerDiscord: '900000000000005203',
  targetSession: '00000000-0000-0000-0000-000000005506'
};

let isolated: IsolatedPostgres;
let pool: Pool;

describe('M4-US-05 PostgreSQL Role mapping and access', () => {
  beforeAll(async () => {
    isolated = await startIsolatedPostgres('a7_role_access');
    pool = isolated.pool;
    await seed();
  }, 30_000);

  afterAll(async () => isolated.stop());

  test('bootstraps the first L4 exactly once and refuses retained bootstrap configuration', async () => {
    const store = new PostgresAccessStore(pool);
    const bootstrapped = await store.bootstrapOwner({ guildId, discordUserId: ids.ownerDiscord, now });
    expect(bootstrapped).toMatchObject({ staffId: ids.ownerStaff, level: 'L4_ADMIN_OWNER', status: 'ACTIVE', permissionsVersion: 7 });
    await pool.query(`UPDATE staff_accounts SET role_source = 'MANUAL', level = 'L3_OPERATIONS' WHERE id = $1`, [ids.ownerStaff]);
    await expect(store.bootstrapOwner({ guildId, discordUserId: ids.ownerDiscord, now })).rejects.toMatchObject({ code: 'BOOTSTRAP_ALREADY_USED' });
    await pool.query(`UPDATE staff_accounts SET role_source = 'BOOTSTRAP', level = 'L4_ADMIN_OWNER' WHERE id = $1`, [ids.ownerStaff]);
    const auditRows = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM audit_logs WHERE action = 'BOOTSTRAP_L4_OWNER'`);
    expect(auditRows.rows[0]?.count).toBe('1');
  });

  test('persists automatic access, source replay, advanced approval, and immediate downgrade revocation', async () => {
    const store = new PostgresAccessStore(pool);
    const sink = new InMemoryAuditSink();

    const l1 = await store.syncRoles(sync(ids.newcomerDiscord, [role.l1], 'db:auto-l1'));
    await l1.commit(audit({ action: 'SYNC_DISCORD_ROLES', actorStaffId: null, actorId: null, actorLevel: null, actorSource: 'DISCORD_BOT' }), sink);
    expect(l1.data).toMatchObject({ effectiveLevel: 'L1_SUPPORT', permissionsVersion: 1 });

    const replay = await store.syncRoles(sync(ids.newcomerDiscord, [role.l1], 'db:auto-l1'));
    await replay.commit(audit({ action: 'SYNC_DISCORD_ROLES', actorStaffId: null, actorId: null, actorLevel: null, actorSource: 'DISCORD_BOT' }), sink);
    expect(replay.data).toEqual(l1.data);
    const replayCount = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM staff_role_sync_events WHERE source_event_id = 'db:auto-l1'`);
    expect(replayCount.rows[0]?.count).toBe('1');

    const pending = await store.syncRoles(sync(ids.targetDiscord, [role.l2, role.l3], 'db:l3-pending'));
    await pending.commit(audit({ action: 'SYNC_DISCORD_ROLES', actorStaffId: null, actorId: null, actorLevel: null, actorSource: 'DISCORD_BOT' }), sink);
    expect(pending.data).toMatchObject({ code: 'ROLE_ELEVATION_PENDING', effectiveLevel: 'L2_SUPERVISOR', requestedLevel: 'L3_OPERATIONS' });

    const approval = await store.approveElevation({ targetStaffId: ids.targetStaff, actorStaffId: ids.ownerStaff, expectedPermissionsVersion: 2, requestedLevel: 'L3_OPERATIONS', now });
    await approval.commit(audit({ action: 'APPROVE_STAFF_ROLE_ELEVATION', targetId: ids.targetStaff }), sink);
    expect(approval.data).toMatchObject({ level: 'L3_OPERATIONS', requestedLevel: null, permissionsVersion: 3, sessionsRevoked: true });

    await pool.query(`INSERT INTO staff_sessions (id,staff_account_id,session_hash,permissions_version,expires_at,created_at,updated_at)
      VALUES ($1,$2,'m4-us-05-target-session',3,$3,now(),now())`, [ids.targetSession, ids.targetStaff, new Date(now.getTime() + 86_400_000)]);
    const downgrade = await store.syncRoles(sync(ids.targetDiscord, [role.l1], 'db:downgrade-l1'));
    await downgrade.commit(audit({ action: 'SYNC_DISCORD_ROLES', actorStaffId: null, actorId: null, actorLevel: null, actorSource: 'DISCORD_BOT' }), sink);
    expect(downgrade.data).toMatchObject({ effectiveLevel: 'L1_SUPPORT', permissionsVersion: 4, sessionsRevoked: true });

    const persisted = await pool.query(`SELECT level::text, requested_level::text, permissions_version FROM staff_accounts WHERE id = $1`, [ids.targetStaff]);
    expect(persisted.rows[0]).toEqual({ level: 'L1_SUPPORT', requested_level: null, permissions_version: 4 });
    const session = await pool.query(`SELECT revoked_at FROM staff_sessions WHERE id = $1`, [ids.targetSession]);
    expect(session.rows[0]?.revoked_at).toEqual(now);
    const decisions = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM approval_decisions WHERE decided_by_staff_id = $1`, [ids.ownerStaff]);
    expect(decisions.rows[0]?.count).toBe('1');
  });

  test('persists gateway/manual retries, exposes failure evidence, and deduplicates periodic reconciliation', async () => {
    const store = new PostgresAccessStore(pool);
    const sink = new InMemoryAuditSink();
    const refreshedAt = new Date(now.getTime() + 30_000);
    const refreshed = await store.syncRoles({ ...sync(ids.targetDiscord, [role.l1], 'db:refresh-observation'), observedAt: refreshedAt });
    await refreshed.commit(audit({ action: 'SYNC_DISCORD_ROLES', actorStaffId: null, actorId: null, actorLevel: null, actorSource: 'DISCORD_BOT', occurredAt: refreshedAt.toISOString() }), sink);
    const manualAt = new Date(now.getTime() + 60_000);
    const manual = await store.queueStaffReconciliation({ targetStaffId: ids.targetStaff, guildId, now: manualAt });
    await manual.commit(audit({ action: 'RECONCILE_STAFF_DISCORD_ROLE', targetId: ids.targetStaff, occurredAt: manualAt.toISOString() }), sink);
    await pool.query(`UPDATE outbox_events SET status='FAILED',last_error='Discord API timeout',updated_at=$2 WHERE id=$1`, [manual.data.jobId, manualAt]);

    const staff = await store.listStaff({ guildId, cursor: null, limit: 100 });
    expect(staff.items.find((item) => item.staffId === ids.targetStaff)).toMatchObject({
      roleSyncedAt: refreshedAt.toISOString(),
      observedDiscordRoleIds: [role.l1],
      lastRoleSyncStatus: 'APPLIED',
      roleSyncQueueStatus: 'FAILED',
      lastRoleSyncError: 'Discord API timeout'
    });

    const gatewayAt = new Date(now.getTime() + 120_000);
    const queued = await store.queueRoleSync({ ...sync(ids.targetDiscord, [role.l2], 'db:durable-gateway'), observedAt: gatewayAt });
    await queued.commit(audit({ action: 'QUEUE_DISCORD_ROLE_SYNC', actorStaffId: null, actorId: null, actorLevel: null, actorSource: 'DISCORD_BOT', occurredAt: gatewayAt.toISOString() }), sink);
    expect(queued.data).toMatchObject({ queued: true, persistent: true, staffId: ids.targetStaff });
    const persisted = await pool.query(`SELECT status::text,payload FROM outbox_events WHERE id=$1`, [queued.data.jobId]);
    expect(persisted.rows[0]).toMatchObject({ status: 'PENDING', payload: { mode: 'OBSERVED_MEMBER', staffId: ids.targetStaff } });

    const periodicAt = new Date('2026-07-18T20:05:00.000Z');
    expect(await enqueuePeriodicRoleReconciliation({ client: pool, guildId, now: periodicAt, intervalMs: 300_000 })).toBe(true);
    expect(await enqueuePeriodicRoleReconciliation({ client: pool, guildId, now: periodicAt, intervalMs: 300_000 })).toBe(false);
  });

  test('rolls back a mapping change when its transactional audit cannot be inserted', async () => {
    const store = new PostgresAccessStore(pool);
    const before = await store.listMappings();
    const write = await store.updateMapping({ guildId, discordRoleId: '900000000000005112', targetLevel: 'L2_SUPERVISOR', expectedVersion: 1, enabled: true, actorStaffId: ids.ownerStaff, now });
    await expect(write.commit(audit({ id: crypto.randomUUID(), actorStaffId: crypto.randomUUID(), targetType: 'discord_role_mapping' }), new InMemoryAuditSink())).rejects.toThrow();
    expect(await store.listMappings()).toEqual(before);
  });

  test('queues Role reconciliation atomically with a successful mapping version', async () => {
    const store = new PostgresAccessStore(pool);
    const write = await store.updateMapping({ guildId, discordRoleId: '900000000000005112', targetLevel: 'L2_SUPERVISOR', expectedVersion: 1, enabled: true, actorStaffId: ids.ownerStaff, now });
    await write.commit(audit({ action: 'UPDATE_DISCORD_ROLE_MAPPING', targetType: 'discord_role_mapping' }), new InMemoryAuditSink());
    const next = await store.updateMapping({ guildId, discordRoleId: '900000000000005113', targetLevel: 'L3_OPERATIONS', expectedVersion: 2, enabled: true, actorStaffId: ids.ownerStaff, now: new Date(now.getTime() + 1_000) });
    await next.commit(audit({ action: 'UPDATE_DISCORD_ROLE_MAPPING', targetType: 'discord_role_mapping', occurredAt: new Date(now.getTime() + 1_000).toISOString() }), new InMemoryAuditSink());
    expect(new Set((await store.listMappings()).map((mapping) => mapping.version))).toEqual(new Set([3]));
    const queued = await pool.query(`SELECT event_type, aggregate_type, payload, status::text FROM outbox_events WHERE event_type = 'ROLE_RECONCILIATION' AND aggregate_type = 'discord_role_mapping' AND payload->>'trigger' IS DISTINCT FROM 'PERIODIC' ORDER BY created_at`);
    expect(queued.rows).toEqual([
      { event_type: 'ROLE_RECONCILIATION', aggregate_type: 'discord_role_mapping', payload: { guildId, targetLevel: 'L2_SUPERVISOR', mappingVersion: 2 }, status: 'PENDING' },
      { event_type: 'ROLE_RECONCILIATION', aggregate_type: 'discord_role_mapping', payload: { guildId, targetLevel: 'L3_OPERATIONS', mappingVersion: 3 }, status: 'PENDING' }
    ]);
  });

  test('serializes concurrent Guild mapping generations', async () => {
    const store = new PostgresAccessStore(pool);
    const first = await store.updateMapping({ guildId, discordRoleId: '900000000000005114', targetLevel: 'L1_SUPPORT', expectedVersion: 3, enabled: true, actorStaffId: ids.ownerStaff, now: new Date(now.getTime() + 2_000) });
    const second = await store.updateMapping({ guildId, discordRoleId: '900000000000005115', targetLevel: 'L4_ADMIN_OWNER', expectedVersion: 3, enabled: true, actorStaffId: ids.ownerStaff, now: new Date(now.getTime() + 2_000) });
    const results = await Promise.allSettled([
      first.commit(audit({ action: 'UPDATE_DISCORD_ROLE_MAPPING', targetType: 'discord_role_mapping', occurredAt: new Date(now.getTime() + 2_000).toISOString() }), new InMemoryAuditSink()),
      second.commit(audit({ action: 'UPDATE_DISCORD_ROLE_MAPPING', targetType: 'discord_role_mapping', occurredAt: new Date(now.getTime() + 2_000).toISOString() }), new InMemoryAuditSink())
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(new Set((await store.listMappings()).map((mapping) => mapping.version))).toEqual(new Set([4]));
  });
});

function sync(discordUserId: string, observedRoleIds: string[], sourceEventId: string) {
  return { guildId, discordUserId, observedRoleIds, mappingVersion: 1, source: 'GUILD_MEMBER_UPDATE', sourceEventId, observedAt: now };
}

function audit(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: crypto.randomUUID(), actorId: ids.ownerUser, actorStaffId: ids.ownerStaff, actorLevel: 'L4_ADMIN_OWNER', actorSource: 'DASHBOARD', clientId: 'DASHBOARD', interactionId: null,
    permissionCode: 'access.manage', action: 'ACCESS_TEST_WRITE', targetType: 'staff_account', targetId: ids.targetStaff, outcome: 'SUCCEEDED', reason: 'TEST', requestId: `req_${crypto.randomUUID()}`,
    approvalRequestId: null, occurredAt: now.toISOString(), ...overrides
  };
}

async function seed() {
  await pool.query(`
    INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
      ('${ids.ownerUser}','Owner','ACTIVE',1,now(),now()),
      ('${ids.targetUser}','Target','ACTIVE',1,now(),now()),
      ('${ids.newcomerUser}','Newcomer','ACTIVE',1,now(),now());
    INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at) VALUES
      ('${ids.ownerStaff}','${ids.ownerUser}','L3_OPERATIONS','ACTIVE','MANUAL',6,now(),now()),
      ('${ids.targetStaff}','${ids.targetUser}','L2_SUPERVISOR','ACTIVE','DISCORD_ROLE',2,now(),now());
    INSERT INTO discord_accounts (id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000005511','${ids.ownerUser}','${guildId}','${ids.ownerDiscord}',now(),now(),now()),
      ('00000000-0000-0000-0000-000000005512','${ids.targetUser}','${guildId}','${ids.targetDiscord}',now(),now(),now()),
      ('00000000-0000-0000-0000-000000005513','${ids.newcomerUser}','${guildId}','${ids.newcomerDiscord}',now(),now(),now());
    INSERT INTO discord_role_mappings (id,guild_id,discord_role_id,target_level,version,enabled,active_mapping_key,active_level_key,created_by_staff_id,created_at) VALUES
      ('00000000-0000-0000-0000-000000005521','${guildId}','${role.l1}','L1_SUPPORT',1,true,'${guildId}:${role.l1}','${guildId}:L1_SUPPORT','${ids.ownerStaff}',now()),
      ('00000000-0000-0000-0000-000000005522','${guildId}','${role.l2}','L2_SUPERVISOR',1,true,'${guildId}:${role.l2}','${guildId}:L2_SUPERVISOR','${ids.ownerStaff}',now()),
      ('00000000-0000-0000-0000-000000005523','${guildId}','${role.l3}','L3_OPERATIONS',1,true,'${guildId}:${role.l3}','${guildId}:L3_OPERATIONS','${ids.ownerStaff}',now()),
      ('00000000-0000-0000-0000-000000005524','${guildId}','${role.l4}','L4_ADMIN_OWNER',1,true,'${guildId}:${role.l4}','${guildId}:L4_ADMIN_OWNER','${ids.ownerStaff}',now());
  `);
}
