import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const migrations = [
  '000001_p0_baseline',
  '000002_m6_settlements',
  '000003_m6_settlement_review',
  '000004_m6_weekly_reports',
  '000005_m6_weekly_report_review_fixes',
  '000006_m6_customer_profiles',
  '000007_settlement_security_remediation',
  '000008_m6_profile_note_guild',
  '000009_internal_usd_wallet',
  '000010_cat_wallet_onboarding'
] as const;

export async function applyCurrentMigrations(input: { host: string; port: number; database: string }): Promise<void> {
  for (const migration of migrations) {
    await execFile('psql', ['-h', input.host, '-p', String(input.port), '-d', input.database,
      '-v', 'ON_ERROR_STOP=1', '-f', `database/prisma/migrations/${migration}/migration.sql`]);
  }
}
