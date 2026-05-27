import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const fixtures = [
  { key: 'NORMAL', displayName: '[SANDBOX] 普通余额账户', status: 'ACTIVE', targetMinor: 100_000 },
  { key: 'LOW', displayName: '[SANDBOX] 余额不足账户', status: 'ACTIVE', targetMinor: 100 },
  { key: 'SUSPENDED', displayName: '[SANDBOX] 停用账户', status: 'SUSPENDED', targetMinor: 100_000 }
] as const;

export async function provisionSandboxFunding(input: {
  pool: Pool;
  bindingSecret: string;
  businessEnvironment: string | undefined;
}): Promise<Array<{ key: string; externalUserId: string; bindingCode: string }>> {
  if (input.businessEnvironment !== 'SANDBOX') throw new Error('Sandbox funding provisioning is forbidden unless BUSINESS_ENV=SANDBOX.');
  if (input.bindingSecret.length < 32) throw new Error('SANDBOX_BINDING_CODE_SECRET must be at least 32 characters.');
  const staff = await input.pool.query<{ id: string }>(`SELECT id FROM staff_accounts
    WHERE level='L4_ADMIN_OWNER' AND status='ACTIVE' ORDER BY created_at LIMIT 1`);
  if (!staff.rows[0]) throw new Error('An active L4 owner is required before Sandbox funding provisioning.');
  const results: Array<{ key: string; externalUserId: string; bindingCode: string }> = [];
  for (const fixture of fixtures) {
    const client = await input.pool.connect();
    try {
      await client.query('BEGIN');
      const externalUserId = `sandbox-${fixture.key.toLowerCase()}`;
      const bindingCode = randomBytes(24).toString('base64url');
      const bindingCodeHash = createHmac('sha256', input.bindingSecret).update(bindingCode).digest('hex');
      const account = await client.query<{ id: string }>(`INSERT INTO sandbox_provider_accounts
        (id,external_user_id,display_name,currency,status,version,binding_code_hash,binding_code_consumed_at,created_at,updated_at)
        VALUES ($1,$2,$3,'CNY',$4::"SandboxProviderAccountStatus",1,$5,NULL,now(),now())
        ON CONFLICT (external_user_id) DO UPDATE SET display_name=EXCLUDED.display_name,status=EXCLUDED.status,
          binding_code_hash=EXCLUDED.binding_code_hash,binding_code_consumed_at=NULL,updated_at=now()
        RETURNING id`, [randomUUID(), externalUserId, fixture.displayName, fixture.status, bindingCodeHash]);
      const accountId = account.rows[0]!.id;
      await client.query('SELECT id FROM sandbox_provider_accounts WHERE id=$1 FOR UPDATE', [accountId]);
      const balance = await client.query<{ amount: string }>(`SELECT (
        COALESCE((SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END) FROM sandbox_provider_balance_adjustments WHERE account_id=$1),0)
        + COALESCE((SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END) FROM sandbox_provider_transactions WHERE account_id=$1 AND status='SUCCEEDED'),0)
      )::text amount`, [accountId]);
      const before = Number(balance.rows[0]!.amount);
      const delta = fixture.targetMinor - before;
      if (delta !== 0) {
        await client.query(`INSERT INTO sandbox_provider_balance_adjustments
          (id,account_id,direction,amount_minor,balance_before_minor,balance_after_minor,reason_code,idempotency_key,created_by_staff_id,created_at)
          VALUES ($1,$2,$3::"SandboxProviderAdjustmentDirection",$4,$5,$6,'SANDBOX_TEST_SETUP',$7,$8,now())`,
        [randomUUID(), accountId, delta > 0 ? 'CREDIT' : 'DEBIT', Math.abs(delta), before, fixture.targetMinor,
          `provision:${fixture.key}:${randomUUID()}`, staff.rows[0].id]);
        await client.query('UPDATE sandbox_provider_accounts SET version=version+1,updated_at=now() WHERE id=$1', [accountId]);
      }
      await client.query('COMMIT');
      results.push({ key: fixture.key, externalUserId, bindingCode });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return results;
}

if (process.argv[1]?.endsWith('sandbox-funding-provision.ts')) {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const bindingSecret = process.env.SANDBOX_BINDING_CODE_SECRET?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  if (!bindingSecret) throw new Error('SANDBOX_BINDING_CODE_SECRET is required.');
  const pool = new Pool({ connectionString: databaseUrl, application_name: 'sandbox_funding_provision' });
  try {
    const accounts = await provisionSandboxFunding({ pool, bindingSecret, businessEnvironment: process.env.BUSINESS_ENV });
    process.stdout.write(`${JSON.stringify({ warning: 'ONE_TIME_CODES_WILL_NOT_BE_SHOWN_AGAIN', accounts }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}
