import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresWalletStore } from '@blackcat/api/wallet';
import type { AuditRecord } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const userId = '00000000-0000-0000-0000-000000007421';
const staffUserId = '00000000-0000-0000-0000-000000007422';
const staffId = '00000000-0000-0000-0000-000000007423';
const now = new Date('2026-07-21T17:00:00.000Z');
let root = ''; let data = ''; let pool: Pool;

function topUpInput(key: string) { return { userId, amountMinor: 500_000, paymentChannel: 'ZELLE', externalTransactionId: `pi_${key}`,
  paidAt: now.toISOString(), note: 'receipt checked',reasonCode:'MANUAL_TOP_UP', idempotencyKey: key, actorStaffId: staffId,
  actorLevel: 'L2_SUPERVISOR' as const, now }; }
function audit(id: string, broken = false): AuditRecord { return { id, actorId: staffUserId, actorStaffId: staffId, actorLevel: 'L2_SUPERVISOR',
  actorSource: 'DASHBOARD', clientId: 'DASHBOARD', interactionId: null, permissionCode: 'wallet.top_up', action: 'CREATE_ADMIN_TOP_UP',
  targetType: 'top_up', targetId: userId, outcome: 'SUCCEEDED', reason: null, requestId: `req_${id}`, approvalRequestId: null,
  occurredAt: now.toISOString(), changes: [{ targetType: 'top_up', targetId: userId,
    changeType: broken ? 'BROKEN' as 'APPEND' : 'APPEND', beforeSnapshot: null, afterSnapshot: { amountMinor: 500_000 }, changedFields: ['amountMinor'] }] }; }

describe('M7-US-04 PostgreSQL wallet transaction', () => {
  beforeAll(async () => {
    const port = 61_900 + (process.pid % 100);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m7-wallet-')); data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m7_wallet']);
    for (const directory of (await readdir('database/prisma/migrations')).sort()) await execFile('psql',
      ['-h', root, '-p', String(port), '-d', 'blackcat_m7_wallet', '-v', 'ON_ERROR_STOP=1', '-f', join('database/prisma/migrations', directory, 'migration.sql')]);
    pool = new Pool({ host: root, port, database: 'blackcat_m7_wallet', max: 4 });
  }, 40_000);
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users CASCADE');
    await pool.query(`INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
      ($1,'Customer','ACTIVE',1,$3,$3),($2,'Staff','ACTIVE',1,$3,$3)`, [userId, staffUserId, now]);
    await pool.query(`INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
      VALUES ($1,$2,'L2_SUPERVISOR','ACTIVE','MANUAL',1,$3,$3)`, [staffId, staffUserId, now]);
  });
  afterAll(async () => { await pool?.end().catch(() => undefined); if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true }); });

  test('commits immediate credit, evidence, entry and audit changes in one transaction', async () => {
    const store = new PostgresWalletStore({ pool });
    const staged = await store.stageCreateTopUp(topUpInput('m7:db:topup:0001'));
    await staged.commit(audit('00000000-0000-0000-0000-000000007424'));
    expect(await store.getBalance({ userId, now })).toMatchObject({ ledgerBalanceMinor: 500_000, availableMinor: 500_000, currency: 'CAT', version: 2 });
    const facts = await pool.query(`SELECT (SELECT count(*) FROM top_ups)::int topups,(SELECT count(*) FROM wallet_entries)::int entries,
      (SELECT count(*) FROM audit_logs)::int audits,(SELECT count(*) FROM audit_log_changes)::int changes`);
    expect(facts.rows[0]).toEqual({ topups: 1, entries: 1, audits: 1, changes: 1 });
  });

  test('rolls back account, credit and evidence when the audit change cannot be inserted', async () => {
    const store = new PostgresWalletStore({ pool });
    const staged = await store.stageCreateTopUp(topUpInput('m7:db:topup:0002'));
    await expect(staged.commit(audit('00000000-0000-0000-0000-000000007425', true))).rejects.toThrow();
    const facts = await pool.query(`SELECT (SELECT count(*) FROM wallet_accounts)::int wallets,(SELECT count(*) FROM top_ups)::int topups,
      (SELECT count(*) FROM wallet_entries)::int entries,(SELECT count(*) FROM audit_logs)::int audits`);
    expect(facts.rows[0]).toEqual({ wallets: 0, topups: 0, entries: 0, audits: 0 });
  });

  test('locks available balance for external refund debit and rolls it back with failed audit', async () => {
    const store = new PostgresWalletStore({ pool });
    await (await store.stageCreateTopUp(topUpInput('m7:db:topup:0003'))).commit(audit('00000000-0000-0000-0000-000000007426'));
    const input = { userId,amountMinor:500_001,paymentChannel:'ZELLE',externalTransactionId:'re_m7_1',refundedAt:now.toISOString(),
      note:'offline refund complete',expectedWalletVersion:2,idempotencyKey:'m7:db:refund:0001',actorStaffId:staffId,actorLevel:'L2_SUPERVISOR' as const,now };
    await expect(store.stageCreateExternalRefundDebit(input)).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE_BALANCE' });
    const staged=await store.stageCreateExternalRefundDebit({...input,amountMinor:100,idempotencyKey:'m7:db:refund:0002'});
    await expect(staged.commit(audit('00000000-0000-0000-0000-000000007427',true))).rejects.toThrow();
    expect(await store.getBalance({userId,now})).toMatchObject({ledgerBalanceMinor:500_000,availableMinor:500_000,version:2});
    expect((await pool.query('SELECT count(*)::int count FROM external_refund_debits')).rows[0].count).toBe(0);
  });

  test('paginates wallet entries with a stable bound cursor', async () => {
    const store = new PostgresWalletStore({ pool });
    for (const [index, key] of ['m16:db:page:0001', 'm16:db:page:0002', 'm16:db:page:0003'].entries()) {
      const staged = await store.stageCreateTopUp({
        ...topUpInput(key),
        now: new Date(now.getTime() + index * 1_000),
        paidAt: new Date(now.getTime() + index * 1_000).toISOString()
      });
      await staged.commit(audit(`00000000-0000-0000-0000-00000000743${index}`));
    }

    const first = await store.listEntries({ userId, cursor: null, limit: 2 });
    const second = await store.listEntries({ userId, cursor: first.nextCursor, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((entry) => entry.id)).size).toBe(3);
  });
});
