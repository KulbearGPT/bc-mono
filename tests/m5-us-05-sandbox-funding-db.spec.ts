import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { AdapterError } from '@blackcat/api/payment-adapter';
import { PostgresSandboxFundingStore, SandboxFundingError, hmacCode } from '@blackcat/api/sandbox-funding';
import { provisionSandboxFunding } from '@blackcat/api/sandbox-funding-provision';
import type { AuditRecord } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const staffId = '00000000-0000-0000-0000-000000005001';
const userId = '00000000-0000-0000-0000-000000005002';
const orderId = '00000000-0000-0000-0000-000000005003';
const reservationId = '00000000-0000-0000-0000-000000005004';
const now = new Date('2026-07-19T12:00:00.000Z');
let tempRoot = '';
let dataDir = '';
let pool: Pool;
let port = 0;
let accountSequence = 0;

describe('M5-US-05 sandbox funding PostgreSQL integration', () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'blackcat-sandbox-funding-'));
    dataDir = join(tempRoot, 'data');
    port = 61_000 + (process.pid % 300);
    await execFile('initdb', ['-D', dataDir, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${tempRoot}`, '-l', join(tempRoot, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', tempRoot, '-p', String(port), 'sandbox_funding']);
    for (const directory of (await readdir('database/prisma/migrations')).sort()) {
      const path = `database/prisma/migrations/${directory}/migration.sql`;
      await execFile('psql', ['-h', tempRoot, '-p', String(port), '-d', 'sandbox_funding', '-v', 'ON_ERROR_STOP=1', '-f', path]);
    }
    pool = new Pool({ host: tempRoot, port, database: 'sandbox_funding', application_name: 'sandbox_funding_test' });
    await seedBaseFacts();
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (dataDir) await execFile('pg_ctl', ['-D', dataDir, 'stop', '-m', 'fast']).catch(() => undefined);
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it('declares persistent, immutable and idempotent Sandbox funding facts', async () => {
    const sql = await readFile('database/prisma/migrations/000009_sandbox_funding/migration.sql', 'utf8');
    for (const name of ['sandbox_provider_accounts', 'sandbox_adjustments_append_only', 'sandbox_transactions_append_only',
      'sandbox_adjustment_account_idempotency_unique', 'sandbox_transaction_idempotency_unique',
      'sandbox_adjustment_amount_positive', 'sandbox_transaction_currency_cny']) expect(sql).toContain(name);
  });

  it('grants the runtime role least-privilege read/write access to all Sandbox funding tables', async () => {
    const runtimePool = new Pool({
      host: tempRoot,
      port,
      database: 'sandbox_funding',
      user: 'blackcat_app',
      password: 'blackcat_app',
      application_name: 'sandbox_funding_runtime_role_test'
    });
    const accountId = '00000000-0000-0000-0000-000000005090';
    try {
      await runtimePool.query(`INSERT INTO sandbox_provider_accounts
        (id,external_user_id,display_name,currency,status,version,created_at,updated_at)
        VALUES ($1,'sandbox-runtime-role','[SANDBOX] runtime role','CNY','ACTIVE',1,now(),now())`, [accountId]);
      await runtimePool.query(`INSERT INTO sandbox_provider_balance_adjustments
        (id,account_id,direction,amount_minor,balance_before_minor,balance_after_minor,reason_code,idempotency_key,created_by_staff_id,created_at)
        VALUES (gen_random_uuid(),$1,'CREDIT',500,0,500,'SANDBOX_TEST_SETUP','runtime-role-adjustment',$2,now())`, [accountId, staffId]);
      await runtimePool.query(`INSERT INTO sandbox_provider_transactions
        (id,account_id,operation,business_source,business_source_id,business_reference,fund_reservation_id,fund_reservation_version,
         direction,amount_minor,currency,status,provider_reference,idempotency_key,created_at)
        VALUES (gen_random_uuid(),$1,'DEBIT','ORDER',$2,$3,$4,1,'DEBIT',100,'CNY','SUCCEEDED',
          'runtime-role-provider-ref','runtime-role-debit',now())`, [accountId, orderId, orderId, reservationId]);
      const visible = await runtimePool.query(`SELECT
        (SELECT count(*)::int FROM sandbox_provider_accounts WHERE id=$1) accounts,
        (SELECT count(*)::int FROM sandbox_provider_balance_adjustments WHERE account_id=$1) adjustments,
        (SELECT count(*)::int FROM sandbox_provider_transactions WHERE account_id=$1) transactions`, [accountId]);
      expect(visible.rows[0]).toEqual({ accounts: 1, adjustments: 1, transactions: 1 });
      await runtimePool.query(`UPDATE sandbox_provider_accounts
        SET binding_code_consumed_at=now(),version=version+1,updated_at=now() WHERE id=$1`, [accountId]);
      await expect(runtimePool.query('DELETE FROM sandbox_provider_accounts WHERE id=$1', [accountId]))
        .rejects.toThrow(/permission denied/u);
      await expect(runtimePool.query('DELETE FROM sandbox_provider_balance_adjustments WHERE account_id=$1', [accountId]))
        .rejects.toThrow(/permission denied/u);
      await expect(runtimePool.query('UPDATE sandbox_provider_transactions SET status=status WHERE account_id=$1', [accountId]))
        .rejects.toThrow(/permission denied/u);
    } finally {
      await runtimePool.end();
    }
  });

  it('atomically consumes only a keyed binding hash and persists balance across store instances', async () => {
    const accountId = await createAccount('binding', 1_000, hmacCode('s'.repeat(32), 'one-time-secret'));
    const first = new PostgresSandboxFundingStore(pool);
    const second = new PostgresSandboxFundingStore(pool);
    await expect(first.consumeBindingCodeHash(hmacCode('s'.repeat(32), 'one-time-secret'), now)).resolves.toMatchObject({ id: accountId });
    await expect(second.consumeBindingCodeHash(hmacCode('s'.repeat(32), 'one-time-secret'), now)).resolves.toBeNull();
    await expect(second.getBalance(accountId)).resolves.toMatchObject({ providerBalanceMinor: 1_000, reservedMinor: 0, availableMinor: 1_000 });
    const stored = await pool.query('SELECT binding_code_hash,binding_code_consumed_at FROM sandbox_provider_accounts WHERE id=$1', [accountId]);
    expect(stored.rows[0]).toMatchObject({ binding_code_hash: hmacCode('s'.repeat(32), 'one-time-secret') });
    expect(JSON.stringify(stored.rows[0])).not.toContain('one-time-secret');
  });

  it('persists idempotent debit/refund results across adapters and preserves minor-unit balance', async () => {
    const accountId = await createAccount('transactions', 1_000);
    await mapUser('transactions');
    const first = new PostgresSandboxFundingStore(pool);
    const second = new PostgresSandboxFundingStore(pool);
    const debitInput = { idempotencyKey: 'sandbox-db-debit-0001', fundReservationId: reservationId, fundReservationVersion: 1,
      externalUserId: 'sandbox-transactions', amount: { amountMinor: 250, currency: 'CNY' as const }, businessSource: 'ORDER' as const, businessReference: orderId };
    const debit = await first.createDebit(debitInput);
    expect(await second.createDebit(debitInput)).toMatchObject({ providerRef: debit.providerRef, fundReservationId: reservationId,
      fundReservationVersion: 1, businessReference: orderId });
    expect((await second.getBalance(accountId)).providerBalanceMinor).toBe(750);
    const refundInput = { idempotencyKey: 'sandbox-db-refund-0001', originalTransactionRef: debit.providerRef!, amount: { amountMinor: 250, currency: 'CNY' as const },
      reasonCode: 'TEST_REFUND', businessReference: orderId };
    const refund = await second.createRefund(refundInput);
    expect(await first.createRefund(refundInput)).toEqual(refund);
    expect((await first.getBalance(accountId)).providerBalanceMinor).toBe(1_000);
    const otherAccountId = await createAccount('transactions-other', 1_000);
    await expect(second.createDebit({ ...debitInput, externalUserId: 'sandbox-transactions-other' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(first.createRefund({ ...refundInput, reasonCode: 'OTHER_REASON' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(first.createRefund({
      ...refundInput,
      businessReference: '00000000-0000-0000-0000-000000005099'
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await second.getBalance(otherAccountId)).providerBalanceMinor).toBe(1_000);
  });

  it('converges concurrent identical debit and refund retries on one committed transaction each', async () => {
    const accountId = await createAccount('concurrent', 1_000);
    await mapUser('concurrent');
    const first = new PostgresSandboxFundingStore(pool);
    const second = new PostgresSandboxFundingStore(pool);
    const debitInput = {
      idempotencyKey: 'sandbox-db-debit-concurrent',
      fundReservationId: reservationId,
      fundReservationVersion: 1,
      externalUserId: 'sandbox-concurrent',
      amount: { amountMinor: 250, currency: 'CNY' as const },
      businessSource: 'ORDER' as const,
      businessReference: orderId
    };
    const debitBlocker = await pool.connect();
    await debitBlocker.query('BEGIN');
    await debitBlocker.query('SELECT id FROM sandbox_provider_accounts WHERE id=$1 FOR UPDATE', [accountId]);
    const debitRequests = [
      first.createDebit(debitInput),
      second.createDebit(debitInput)
    ] as const;
    await waitForLockWaiters(2);
    await debitBlocker.query('COMMIT');
    debitBlocker.release();
    const [firstDebit, secondDebit] = await Promise.all(debitRequests);
    expect(secondDebit.providerRef).toBe(firstDebit.providerRef);
    expect((await pool.query(`SELECT count(*)::int count FROM sandbox_provider_transactions
      WHERE idempotency_key=$1`, [debitInput.idempotencyKey])).rows[0].count).toBe(1);

    const refundInput = {
      idempotencyKey: 'sandbox-db-refund-concurrent',
      originalTransactionRef: firstDebit.providerRef!,
      amount: { amountMinor: 250, currency: 'CNY' as const },
      reasonCode: 'TEST_REFUND',
      businessReference: orderId
    };
    const refundBlocker = await pool.connect();
    await refundBlocker.query('BEGIN');
    await refundBlocker.query('SELECT id FROM sandbox_provider_transactions WHERE provider_reference=$1 FOR UPDATE', [firstDebit.providerRef]);
    const refundRequests = [
      first.createRefund(refundInput),
      second.createRefund(refundInput)
    ] as const;
    await waitForLockWaiters(2);
    await refundBlocker.query('COMMIT');
    refundBlocker.release();
    const [firstRefund, secondRefund] = await Promise.all(refundRequests);
    expect(secondRefund).toEqual(firstRefund);
    expect((await pool.query(`SELECT count(*)::int count FROM sandbox_provider_transactions
      WHERE idempotency_key=$1`, [refundInput.idempotencyKey])).rows[0].count).toBe(1);
    expect((await second.getBalance(accountId)).providerBalanceMinor).toBe(1_000);
  });

  it('serializes one idempotency key across different accounts and original transactions', async () => {
    const firstAccountId = await createAccount('global-key-first', 1_000);
    const secondAccountId = await createAccount('global-key-second', 1_000);
    const first = new PostgresSandboxFundingStore(pool);
    const second = new PostgresSandboxFundingStore(pool);
    const sharedDebitKey = 'sandbox-db-debit-global-key';
    const debits = await Promise.allSettled([
      first.createDebit({
        idempotencyKey: sharedDebitKey,
        fundReservationId: reservationId,
        fundReservationVersion: 1,
        externalUserId: 'sandbox-global-key-first',
        amount: { amountMinor: 100, currency: 'CNY' },
        businessSource: 'ORDER',
        businessReference: orderId
      }),
      second.createDebit({
        idempotencyKey: sharedDebitKey,
        fundReservationId: reservationId,
        fundReservationVersion: 1,
        externalUserId: 'sandbox-global-key-second',
        amount: { amountMinor: 100, currency: 'CNY' },
        businessSource: 'ORDER',
        businessReference: orderId
      })
    ]);
    expect(debits.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejectedDebit = debits.find((result) => result.status === 'rejected');
    expect(rejectedDebit).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' })
    });
    expect((rejectedDebit as PromiseRejectedResult).reason).toBeInstanceOf(AdapterError);

    const firstDebit = await first.createDebit({
      idempotencyKey: 'sandbox-db-debit-global-refund-first',
      fundReservationId: reservationId,
      fundReservationVersion: 1,
      externalUserId: 'sandbox-global-key-first',
      amount: { amountMinor: 100, currency: 'CNY' },
      businessSource: 'ORDER',
      businessReference: orderId
    });
    const secondDebit = await second.createDebit({
      idempotencyKey: 'sandbox-db-debit-global-refund-second',
      fundReservationId: reservationId,
      fundReservationVersion: 1,
      externalUserId: 'sandbox-global-key-second',
      amount: { amountMinor: 100, currency: 'CNY' },
      businessSource: 'ORDER',
      businessReference: orderId
    });
    const refunds = await Promise.allSettled([
      first.createRefund({
        idempotencyKey: 'sandbox-db-refund-global-key',
        originalTransactionRef: firstDebit.providerRef!,
        amount: { amountMinor: 100, currency: 'CNY' },
        reasonCode: 'TEST_REFUND',
        businessReference: orderId
      }),
      second.createRefund({
        idempotencyKey: 'sandbox-db-refund-global-key',
        originalTransactionRef: secondDebit.providerRef!,
        amount: { amountMinor: 100, currency: 'CNY' },
        reasonCode: 'TEST_REFUND',
        businessReference: orderId
      })
    ]);
    expect(refunds.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(refunds.find((result) => result.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' })
    });
    expect((await pool.query(
      'SELECT count(*)::int count FROM sandbox_provider_transactions WHERE idempotency_key = ANY($1::text[])',
      [[sharedDebitKey, 'sandbox-db-refund-global-key']]
    )).rows[0].count).toBe(2);
    expect((await first.getBalance(firstAccountId)).providerBalanceMinor).toBeGreaterThanOrEqual(800);
    expect((await second.getBalance(secondAccountId)).providerBalanceMinor).toBeGreaterThanOrEqual(800);
  });

  it('fails closed on repeated provisioning without rotating codes or resetting balances', async () => {
    const bindingSecret = 'provisioning-secret-that-is-long-enough';
    const first = await provisionSandboxFunding({
      pool,
      bindingSecret,
      businessEnvironment: 'SANDBOX'
    });
    expect(first.map((fixture) => fixture.key)).toEqual(['NORMAL', 'LOW', 'SUSPENDED']);
    const before = await provisionedFixtureSnapshot();

    await expect(provisionSandboxFunding({
      pool,
      bindingSecret,
      businessEnvironment: 'SANDBOX'
    })).rejects.toThrow(/already provisioned/u);

    expect(await provisionedFixtureSnapshot()).toEqual(before);
  });

  it('blocks active reservations and stale versions with zero balance writes', async () => {
    const activeId = await createAccount('active', 1_000);
    await mapUser('active');
    const store = new PostgresSandboxFundingStore(pool);
    const before = await adjustmentCount(activeId);
    await expect(store.stageTargetBalance(target(activeId, 2_000, 1, 'active-reservation-key')))
      .rejects.toBeInstanceOf(SandboxFundingError);
    expect(await adjustmentCount(activeId)).toBe(before);

    const staleId = await createAccount('stale', 1_000);
    await expect(store.stageTargetBalance(target(staleId, 2_000, 2, 'stale-version-key')))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await adjustmentCount(staleId)).toBe(1);
  });

  it('writes no adjustment for an unchanged target and atomically commits one adjustment with one success audit for a change', async () => {
    const accountId = await createAccount('target', 1_000);
    const store = new PostgresSandboxFundingStore(pool);
    const unchanged = await store.stageTargetBalance(target(accountId, 1_000, 1, 'unchanged-target-key'));
    await unchanged.commit(audit('00000000-0000-0000-0000-000000005011', accountId));
    expect(await adjustmentCount(accountId)).toBe(1);

    const changed = await store.stageTargetBalance(target(accountId, 2_000, 1, 'changed-target-key'));
    await changed.commit(audit('00000000-0000-0000-0000-000000005012', accountId));
    expect(changed.data).toMatchObject({ providerBalanceMinor: 2_000, version: 2 });
    expect(await adjustmentCount(accountId)).toBe(2);
    const audits = await pool.query('SELECT count(*)::int count FROM audit_logs WHERE target_id=$1', [accountId]);
    expect(audits.rows[0].count).toBe(2);
    await expect(pool.query('UPDATE sandbox_provider_balance_adjustments SET reason_code=reason_code WHERE account_id=$1', [accountId])).rejects.toThrow(/append-only/u);
  });
});

async function seedBaseFacts() {
  await pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Sandbox Staff','ACTIVE',now(),now())`, [userId]);
  await pool.query(`INSERT INTO staff_accounts (id,user_id,level,status,role_source,mfa_enrolled,permissions_version,created_at,updated_at)
    VALUES ($1,$2,'L4_ADMIN_OWNER','ACTIVE','MANUAL',true,1,now(),now())`, [staffId, userId]);
  await pool.query(`INSERT INTO orders (id,public_id,customer_id,status,row_version,currency,amount_minor,guild_id,channel_id,panel_message_id,created_at,updated_at)
    VALUES ($1,'P-SANDBOX',$2,'CANCELLED',1,'CNY',250,'900000000000005001','900000000000005002','900000000000005003',now(),now())`, [orderId, userId]);
  await pool.query(`INSERT INTO fund_reservations (id,user_id,source_type,order_id,mode,provider,amount_minor,currency,status,row_version,idempotency_key,created_at,updated_at)
    VALUES ($1,$2,'ORDER',$3,'LOCAL_RESERVATION_FALLBACK','sandbox-provider',250,'CNY','PENDING',1,'sandbox-base-reservation',now(),now())`, [reservationId, userId, orderId]);
}

async function createAccount(suffix: string, balanceMinor: number, bindingCodeHash: string | null = null): Promise<string> {
  const id = `00000000-0000-0000-0000-${String(5100 + accountSequence++).padStart(12, '0')}`;
  await pool.query(`INSERT INTO sandbox_provider_accounts (id,external_user_id,display_name,currency,status,version,binding_code_hash,created_at,updated_at)
    VALUES ($1,$2,$3,'CNY','ACTIVE',1,$4,now(),now())`, [id, `sandbox-${suffix}`, `[SANDBOX] ${suffix}`, bindingCodeHash]);
  await pool.query(`INSERT INTO sandbox_provider_balance_adjustments
    (id,account_id,direction,amount_minor,balance_before_minor,balance_after_minor,reason_code,idempotency_key,created_by_staff_id,created_at)
    VALUES (gen_random_uuid(),$1,'CREDIT',$2,0,$2,'SANDBOX_TEST_SETUP',$3,$4,now())`, [id, balanceMinor, `seed-${suffix}`, staffId]);
  return id;
}

async function mapUser(suffix: string) {
  await pool.query(`DELETE FROM external_accounts WHERE user_id=$1`, [userId]);
  await pool.query(`INSERT INTO external_accounts (id,user_id,provider,external_user_id,status,active_user_provider_key,verified_at,created_at,updated_at)
    VALUES (gen_random_uuid(),$1,'sandbox-provider',$2,'ACTIVE',$3,now(),now(),now())`, [userId, `sandbox-${suffix}`, `${userId}:sandbox-provider`]);
}

function target(accountId: string, amount: number, version: number, key: string) {
  return { accountId, currency: 'CNY' as const, targetProviderBalanceMinor: amount, expectedVersion: version,
    reasonCode: 'SANDBOX_TEST_SETUP' as const, idempotencyKey: key, createdByStaffId: staffId, now };
}

function audit(id: string, accountId: string): AuditRecord {
  return { id, actorId: userId, actorStaffId: staffId, actorLevel: 'L4_ADMIN_OWNER', actorSource: 'DASHBOARD', clientId: 'DASHBOARD',
    interactionId: null, permissionCode: 'sandbox_funding.manage', action: 'SET_SANDBOX_TARGET_BALANCE', targetType: 'sandbox_provider_account',
    targetId: accountId, outcome: 'SUCCEEDED', reason: null, requestId: `req_${id.slice(-4)}`, approvalRequestId: null, occurredAt: now.toISOString() };
}

async function adjustmentCount(accountId: string): Promise<number> {
  const result = await pool.query('SELECT count(*)::int count FROM sandbox_provider_balance_adjustments WHERE account_id=$1', [accountId]);
  return result.rows[0].count;
}

async function provisionedFixtureSnapshot() {
  const result = await pool.query(`
SELECT
  account.external_user_id,
  account.binding_code_hash,
  account.binding_code_consumed_at,
  account.version,
  (
    COALESCE((SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END)
      FROM sandbox_provider_balance_adjustments WHERE account_id=account.id),0)
    + COALESCE((SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END)
      FROM sandbox_provider_transactions WHERE account_id=account.id AND status='SUCCEEDED'),0)
  )::text AS provider_balance_minor
FROM sandbox_provider_accounts account
WHERE account.external_user_id = ANY($1::text[])
ORDER BY account.external_user_id
  `, [['sandbox-low', 'sandbox-normal', 'sandbox-suspended']]);
  return result.rows;
}

async function waitForLockWaiters(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: number }>(`SELECT count(*)::int count
      FROM pg_stat_activity
      WHERE datname=current_database()
        AND application_name='sandbox_funding_test'
        AND wait_event_type='Lock'`);
    if (result.rows[0]!.count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} concurrent Sandbox funding lock waiters.`);
}
