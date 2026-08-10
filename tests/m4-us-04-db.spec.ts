import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const schemaPath = resolve(process.cwd(), 'database/prisma/schema.prisma');
const migrationPath = resolve(
  process.cwd(),
  'database/prisma/migrations/000001_p0_baseline/migration.sql'
);
const verifyScriptPath = resolve(process.cwd(), 'scripts/verify-m0-us-02-migration.sh');

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

describe('M4-US-04 durable MFA and step-up persistence', () => {
  test('Prisma models protect secrets and bind enrollment and step-up state to owners', async () => {
    const schema = await readText(schemaPath);

    expect(schema).toContain('model StaffMfaCredential');
    expect(schema).toContain('model StaffMfaEnrollment');
    expect(schema).toContain('model StaffMfaRecoveryCode');
    expect(schema).toContain('model StaffStepUpChallenge');
    expect(schema).toMatch(/secretCiphertext\s+String\s+@map\("secret_ciphertext"\)/);
    expect(schema).not.toMatch(/plain(?:text)?Secret|secretPlaintext/i);
    expect(schema).toMatch(/staffAccountId\s+String\s+@map\("staff_account_id"\)/);
    expect(schema).toMatch(/staffSessionId\s+String\s+@map\("staff_session_id"\)/);
    expect(schema).toMatch(/codeHash\s+String\s+@unique\s+@map\("code_hash"\)/);
    expect(schema).toMatch(/consumedAt\s+DateTime\?\s+@map\("consumed_at"\)/);
    expect(schema).toMatch(/stepUpAt\s+DateTime\?\s+@map\("step_up_at"\)/);
    expect(schema.match(/failedAttempts\s+Int\s+@default\(0\)\s+@map\("failed_attempts"\)/g)).toHaveLength(3);
    expect(schema).toMatch(/model StaffGiftAssistChallenge[\s\S]+failedAttempts\s+Int\s+@default\(0\)/u);
  });

  test('migration constrains expiry, active credentials, and single-use security records', async () => {
    const migration = await readText(migrationPath);

    expect(migration).toContain('staff_mfa_enrollment_expiry_chk');
    expect(migration).toContain('staff_step_up_challenge_expiry_chk');
    expect(migration).toContain('staff_step_up_challenge_attempts_chk');
    expect(migration).toContain('staff_mfa_credentials_staff_account_id_key');
    expect(migration).toContain('staff_mfa_enrollments_owner_state_idx');
    expect(migration).toContain('trg_staff_mfa_recovery_code_single_use');
    expect(migration).toContain('trg_staff_step_up_challenge_single_use');
    expect(migration).toContain('trg_staff_mfa_enrollment_single_verification');
    expect(migration).toContain('trg_staff_session_step_up_atomic_audit');
    expect(migration).toContain('ATOMIC_SECURITY_STATE_AUDIT');
    expect(migration).toContain('REVOKE DELETE ON TABLE staff_mfa_credentials');
    expect(migration).toContain(
      'REVOKE UPDATE (staff_account_id, method, secret_ciphertext, verified_at, created_at) ON staff_mfa_credentials'
    );
    expect(migration).toContain(
      'REVOKE UPDATE (credential_id, code_hash, created_at) ON staff_mfa_recovery_codes'
    );
  });

  test('migration verification exercises ownership, expiry, and replay protections', async () => {
    const verifyScript = await readText(verifyScriptPath);

    expect(verifyScript).toContain('mfa-enrollment-expiry-rejected');
    expect(verifyScript).toContain('mfa-enrollment-owner-missing-rejected');
    expect(verifyScript).toContain('mfa-recovery-code-replay-rejected');
    expect(verifyScript).toContain('step-up-cross-owner-binding-rejected');
    expect(verifyScript).toContain('step-up-replay-rejected');
    expect(verifyScript).toContain('mfa-secret-update-rejected');
    expect(verifyScript).toContain('atomic-security-audit-ok');
  });
});
