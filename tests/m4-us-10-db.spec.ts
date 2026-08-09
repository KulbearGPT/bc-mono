import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresBotConfigStore } from '@blackcat/api/bot-config';
import type { AuditRecord, AuditSink } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const guildId = '900000000000002000';
const staffUserId = '00000000-0000-0000-0000-000000020001';
const staffId = '00000000-0000-0000-0000-000000020002';
const eventId = '00000000-0000-0000-0000-000000020003';
const staffRoleId = '900000000000002201';
const now = new Date('2026-07-18T20:30:00.000Z');
let root = '';
let data = '';
let pool: Pool;

const audit: AuditRecord = {
  id: '00000000-0000-0000-0000-000000020004', actorId: staffUserId, actorStaffId: staffId,
  actorLevel: 'L3_OPERATIONS', actorSource: 'DISCORD_BOT', clientId: 'DISCORD_BOT', interactionId: '900000000000002999',
  permissionCode: 'bot_config.operational.manage', action: 'UPDATE_BOT_CONFIG', targetType: 'guild_bot_config', targetId: guildId,
  outcome: 'SUCCEEDED', reason: 'Approved configuration change.', requestId: 'req_m4_us_10_db', approvalRequestId: null,
  occurredAt: now.toISOString()
};

describe('M4-US-10 PostgreSQL Bot configuration', () => {
  beforeAll(async () => {
    const port = 63000 + (process.pid % 100);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m4-bot-config-')); data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m4_bot_config']);
    await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m4_bot_config', '-v', 'ON_ERROR_STOP=1', '-f', 'database/prisma/migrations/000001_p0_baseline/migration.sql']);
    pool = new Pool({ host: root, port, database: 'blackcat_m4_bot_config' });
    await pool.query("INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES ($1,'Config operator','ACTIVE',1,$2,$2)", [staffUserId, now]);
    await pool.query("INSERT INTO staff_accounts(id,user_id,level,status,role_source,permissions_version,created_at,updated_at) VALUES ($1,$2,'L3_OPERATIONS','ACTIVE','MANUAL',1,$3,$3)", [staffId, staffUserId, now]);
    await pool.query("INSERT INTO guild_bot_configs(guild_id,version,config_json,updated_by_staff_id,updated_at) VALUES ($1,1,'{\"gift_broadcast_channel_id\":\"900000000000002100\",\"auto_dispatch_enabled\":true}'::jsonb,$2,$3)", [guildId, staffId, now]);
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('AT-CFG-008 atomically commits current config, immutable event, and success audit', async () => {
    const store = new PostgresBotConfigStore(pool);
    const staged = await store.stageUpdate({ guildId, expectedVersion: 1, changes: {
      gift_broadcast_channel_id: '900000000000002101', staff_l3_role_id: staffRoleId
    }, reason: 'Approved configuration change.', actorStaffId: staffId, source: 'DISCORD_BOT', now, eventId });
    await staged.commit(audit, unreachableAuditSink);
    expect(await store.get(guildId)).toMatchObject({ version: 2, values: { gift_broadcast_channel_id: '900000000000002101', auto_dispatch_enabled: true }, updatedByStaffId: staffId });
    const facts = await pool.query(`SELECT
      (SELECT count(*)::int FROM guild_bot_config_events WHERE guild_id=$1 AND version=2) event_count,
      (SELECT count(*)::int FROM audit_logs WHERE request_id='req_m4_us_10_db' AND outcome='SUCCEEDED') audit_count` , [guildId]);
    expect(facts.rows[0]).toEqual({ event_count: 1, audit_count: 1 });
    const event = await pool.query('SELECT changes_json,previous_values_json,actor_staff_id,source FROM guild_bot_config_events WHERE id=$1', [eventId]);
    expect(event.rows[0]).toMatchObject({ changes_json: { gift_broadcast_channel_id: '900000000000002101' }, previous_values_json: { gift_broadcast_channel_id: '900000000000002100' }, actor_staff_id: staffId, source: 'DISCORD_BOT' });
    const mapping = await pool.query('SELECT discord_role_id,target_level,enabled,retired_at FROM discord_role_mappings WHERE guild_id=$1 AND target_level=\'L3_OPERATIONS\'', [guildId]);
    expect(mapping.rows).toEqual([{ discord_role_id: staffRoleId, target_level: 'L3_OPERATIONS', enabled: true, retired_at: null }]);
    const reconciliation = await pool.query("SELECT payload,status FROM outbox_events WHERE event_type='ROLE_RECONCILIATION' AND aggregate_id=$1", [mapping.rows.length ? (await pool.query('SELECT id FROM discord_role_mappings WHERE guild_id=$1 AND target_level=\'L3_OPERATIONS\'', [guildId])).rows[0].id : null]);
    expect(reconciliation.rows[0]).toMatchObject({ status: 'PENDING', payload: { guildId, targetLevel: 'L3_OPERATIONS' } });
    await expect(pool.query('DELETE FROM guild_bot_config_events WHERE id=$1', [eventId])).rejects.toThrow(/immutable|permission/i);
  });

  test('AT-CFG-007 rejects stale staged commits without an event or audit', async () => {
    const store = new PostgresBotConfigStore(pool);
    const stale = await store.stageUpdate({ guildId, expectedVersion: 2, changes: { new_orders_enabled: false }, reason: 'Stale change.', actorStaffId: staffId, source: 'DISCORD_BOT', now: new Date(now.getTime() + 1000), eventId: '00000000-0000-0000-0000-000000020005' });
    const winner = await store.stageUpdate({ guildId, expectedVersion: 2, changes: { readiness_timeout_minutes: 10 }, reason: 'Winning change.', actorStaffId: staffId, source: 'DISCORD_BOT', now: new Date(now.getTime() + 2000), eventId: '00000000-0000-0000-0000-000000020006' });
    await winner.commit({ ...audit, id: '00000000-0000-0000-0000-000000020007', requestId: 'req_m4_us_10_winner' }, unreachableAuditSink);
    await expect(stale.commit({ ...audit, id: '00000000-0000-0000-0000-000000020008', requestId: 'req_m4_us_10_stale' }, unreachableAuditSink)).rejects.toMatchObject({ code: 'CONFIG_VERSION_CONFLICT' });
    const facts = await pool.query(`SELECT
      (SELECT count(*)::int FROM guild_bot_config_events WHERE id='00000000-0000-0000-0000-000000020005') stale_events,
      (SELECT count(*)::int FROM audit_logs WHERE request_id='req_m4_us_10_stale') stale_audits`);
    expect(facts.rows[0]).toEqual({ stale_events: 0, stale_audits: 0 });
    expect(await store.get(guildId)).toMatchObject({ version: 3, values: { auto_dispatch_enabled: true, readiness_timeout_minutes: 10 } });
  });
});

const unreachableAuditSink: AuditSink = { append: () => { throw new Error('PostgreSQL staged write must use the transaction client.'); } };
