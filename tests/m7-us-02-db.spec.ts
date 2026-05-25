import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import {
  IMMUTABLE_RECORD_TABLES,
  assertAllowedRecordMutation
} from '@blackcat/database/immutable-records';

const execFile = promisify(execFileCallback);
const userId = '00000000-0000-0000-0000-000000007201';
const staffUserId = '00000000-0000-0000-0000-000000007202';
const staffId = '00000000-0000-0000-0000-000000007203';
const walletId = '00000000-0000-0000-0000-000000007204';
const entryId = '00000000-0000-0000-0000-000000007205';
const topUpId = '00000000-0000-0000-0000-000000007206';
const auditId = '00000000-0000-0000-0000-000000007207';
let root = '';
let data = '';
let pool: Pool;

describe('M7-US-02 immutable internal USD wallet persistence', () => {
  beforeAll(async () => {
    const migration = await readFile(
      'database/prisma/migrations/000009_internal_usd_wallet/migration.sql',
      'utf8'
    );
    expect(migration).toContain('CREATE TABLE "wallet_accounts"');

    const port = 61_500 + (process.pid % 200);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m7-wallet-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', [
      '-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start'
    ]);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m7_wallet']);
    const migrationRoot = 'database/prisma/migrations';
    for (const directory of (await readdir(migrationRoot)).sort()) {
      await execFile('psql', [
        '-h', root, '-p', String(port), '-d', 'blackcat_m7_wallet', '-v', 'ON_ERROR_STOP=1',
        '-f', join(migrationRoot, directory, 'migration.sql')
      ]);
    }
    pool = new Pool({ host: root, port, database: 'blackcat_m7_wallet', max: 4 });
  }, 40_000);

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE audit_log_changes,audit_logs,receipt_attachments,
      external_refund_debits,top_ups,wallet_entries,wallet_accounts,staff_accounts,users
      RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO users (id,display_name,updated_at) VALUES
      ($1,'Wallet Customer',now()),($2,'Wallet Staff',now())`, [userId, staffUserId]);
    await pool.query(`INSERT INTO staff_accounts
      (id,user_id,level,status,role_source,updated_at)
      VALUES ($1,$2,'L2_SUPERVISOR','ACTIVE','MANUAL',now())`, [staffId, staffUserId]);
    await pool.query(`INSERT INTO wallet_accounts
      (id,user_id,currency,status,row_version,updated_at)
      VALUES ($1,$2,'USD','ACTIVE',1,now())`, [walletId, userId]);
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('keeps the runtime and published Prisma wallet contracts identical', async () => {
    const [runtime, output, docs] = await Promise.all([
      readFile('database/prisma/schema.prisma', 'utf8'),
      readFile('outputs/P0开发交付包/03-数据模型/schema.prisma', 'utf8'),
      readFile('docs/P0开发交付包/03-数据模型/schema.prisma', 'utf8')
    ]);
    expect(runtime).toBe(output);
    expect(docs).toBe(output);
    for (const model of [
      'WalletAccount', 'WalletEntry', 'TopUp', 'ExternalRefundDebit',
      'ReceiptAttachment', 'AuditLogChange'
    ]) expect(runtime).toContain(`model ${model}`);
  });

  test('enforces USD, positive amounts, unique payment references, and non-negative ledger funds', async () => {
    await pool.query(`INSERT INTO wallet_entries
      (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,
       idempotency_key,occurred_at)
      VALUES ($1,$2,'TOP_UP_CREDIT','CREDIT',500000,'USD','TOP_UP',$3,'m7:topup:1',now())`,
    [entryId, walletId, topUpId]);
    await pool.query(`INSERT INTO top_ups
      (id,wallet_account_id,wallet_entry_id,amount_minor,currency,payment_channel,
       external_transaction_id,paid_at,note,created_by_staff_id)
      VALUES ($1,$2,$3,500000,'USD','PAYPAL','txn-1',now(),'receipt checked',$4)`,
    [topUpId, walletId, entryId, staffId]);

    const secondEntryId = '00000000-0000-0000-0000-000000007208';
    await pool.query(`INSERT INTO wallet_entries
      (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,
       idempotency_key,occurred_at)
      VALUES ($1,$2,'TOP_UP_CREDIT','CREDIT',1,'USD','TOP_UP',$3,'m7:topup:2',now())`,
    [secondEntryId, walletId, '00000000-0000-0000-0000-000000007209']);
    await expect(pool.query(`INSERT INTO top_ups
      (id,wallet_account_id,wallet_entry_id,amount_minor,currency,payment_channel,
       external_transaction_id,paid_at,note,created_by_staff_id)
      VALUES ($1,$2,$3,1,'USD','PAYPAL','txn-1',now(),'duplicate',$4)`,
    ['00000000-0000-0000-0000-000000007209', walletId, secondEntryId, staffId]))
      .rejects.toThrow(/unique|duplicate/i);

    await expect(pool.query(`INSERT INTO wallet_entries
      (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,
       idempotency_key,occurred_at)
      VALUES (gen_random_uuid(),$1,'ADJUSTMENT_CREDIT','CREDIT',1,'CNY','ADJUSTMENT',
       gen_random_uuid(),'m7:bad-currency',now())`, [walletId]))
      .rejects.toThrow(/USD|currency|check constraint/i);
    await expect(pool.query(`INSERT INTO wallet_entries
      (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,
       idempotency_key,occurred_at)
      VALUES (gen_random_uuid(),$1,'ADJUSTMENT_DEBIT','DEBIT',500002,'USD','ADJUSTMENT',
       gen_random_uuid(),'m7:overdraft',now())`, [walletId]))
      .rejects.toThrow(/negative|insufficient/i);
  });

  test('makes wallet evidence, entries, audit headers, and audit changes append-only', async () => {
    await pool.query(`INSERT INTO wallet_entries
      (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,
       idempotency_key,occurred_at)
      VALUES ($1,$2,'TOP_UP_CREDIT','CREDIT',500000,'USD','TOP_UP',$3,'m7:immutable',now())`,
    [entryId, walletId, topUpId]);
    await pool.query(`INSERT INTO top_ups
      (id,wallet_account_id,wallet_entry_id,amount_minor,currency,payment_channel,
       external_transaction_id,paid_at,note,created_by_staff_id)
      VALUES ($1,$2,$3,500000,'USD','STRIPE','txn-immutable',now(),'checked',$4)`,
    [topUpId, walletId, entryId, staffId]);
    await pool.query(`INSERT INTO audit_logs
      (id,actor_staff_id,actor_level,actor_source,client_id,permission_code,action,target_type,
       target_id,outcome,request_id)
      VALUES ($1,$2,'L2_SUPERVISOR','DASHBOARD','dashboard','wallet.top_up',
       'wallet.top_up.create','TOP_UP',$3,'SUCCEEDED','request-m7-1')`, [auditId, staffId, topUpId]);
    await pool.query(`INSERT INTO audit_log_changes
      (id,audit_log_id,sequence,target_type,target_id,change_type,after_snapshot,changed_fields)
      VALUES (gen_random_uuid(),$1,1,'TOP_UP',$2,'CREATE','{}',$json$["id"]$json$)`,
    [auditId, topUpId]);

    for (const statement of [
      `UPDATE wallet_entries SET amount_minor=1 WHERE id='${entryId}'`,
      `DELETE FROM wallet_entries WHERE id='${entryId}'`,
      `UPDATE top_ups SET note='changed' WHERE id='${topUpId}'`,
      `DELETE FROM audit_logs WHERE id='${auditId}'`,
      `UPDATE audit_log_changes SET target_type='OTHER' WHERE audit_log_id='${auditId}'`
    ]) await expect(pool.query(statement)).rejects.toThrow(/append-only/i);

    expect(IMMUTABLE_RECORD_TABLES).toEqual(expect.arrayContaining([
      'wallet_entries', 'top_ups', 'external_refund_debits',
      'receipt_attachments', 'audit_logs', 'audit_log_changes'
    ]));
    expect(() => assertAllowedRecordMutation('wallet_entries', 'updateStatus'))
      .toThrow(/immutable status/i);
  });
});
