import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { validateProductionEnv } from '../scripts/verify-production-env.mjs';

const execFile = promisify(execFileCallback);
describe('M5-US-02 production-like recovery candidate', () => {
  test('rejects placeholders and shared migration credentials without requiring Provider configuration', () => {
    const valid = productionEnv();
    expect(validateProductionEnv(valid)).toEqual([]);
    expect(validateProductionEnv({ ...valid, BOT_SERVICE_TOKEN: 'change-me' })).toContain('BOT_SERVICE_TOKEN must not use a placeholder value.');
    expect(validateProductionEnv({ ...valid, MIGRATION_DATABASE_URL: valid.DATABASE_URL })).toContain('Application and migration database credentials must be separate.');
    expect(Object.keys(valid)).not.toContain('PAYMENT_PROVIDER_BASE_URL');
  });

  test('defines isolated migration, healthy runtime services, and an enabled Worker runtime', async () => {
    const compose = await readFile('docker-compose.production.yml', 'utf8');
    for (const service of ['postgres:', 'migrate:', 'api:', 'worker:', 'bot:', 'dashboard:']) expect(compose).toContain(service);
    expect(compose).toContain('condition: service_completed_successfully');
    expect(compose).toContain('restart: unless-stopped');
    expect(compose).toContain('npm run worker -w @blackcat/api');
    expect(compose).toContain("test -f /tmp/blackcat-worker-ready");
    expect(compose).not.toContain('worker-runtime-pending');
    expect(compose).not.toContain('release is blocked');
    expect(compose).not.toContain('change-me');
  });

  test('baseline restore probe preserves representative immutable facts', async () => {
    const result = await execFile('bash', ['scripts/verify-backup-restore.sh'], { timeout: 90_000 });
    expect(result.stdout).toContain('backup-restore-ok');
    expect(result.stdout).toContain('restored_users=1');
    expect(result.stdout).toContain('restored_audits=1');
    expect(result.stdout).toContain('audit-delete-rejected');
  }, 95_000);
});

function productionEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production', DATABASE_URL: 'postgresql://blackcat_app:app-secret@postgres:5432/blackcat',
    MIGRATION_DATABASE_URL: 'postgresql://blackcat_migrate:migrate-secret@postgres:5432/blackcat',
    API_BASE_URL: 'https://api.example.test', BOT_SERVICE_TOKEN: 'b'.repeat(48),
    BOT_CONFIG_VALIDATION_SECRET: 'c'.repeat(48), DASHBOARD_CSRF_SECRET: 'd'.repeat(48),
    DASHBOARD_MFA_ENCRYPTION_KEY: 'e'.repeat(48), DISCORD_BOT_TOKEN: 'i'.repeat(48),
    DISCORD_OAUTH_CLIENT_ID: 'client-id', DISCORD_OAUTH_CLIENT_SECRET: 'f'.repeat(48),
    DISCORD_OAUTH_REDIRECT_URI: 'https://api.example.test/api/v1/auth/discord/callback', DISCORD_GUILD_ID: '900000000000000000'
  };
}
