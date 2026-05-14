import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { MockFundingAdapter, signMockWebhook } from '@blackcat/api/payment-adapter';
import { validateProductionEnv } from '../scripts/verify-production-env.mjs';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T21:00:00.000Z');

describe('M5-US-02 production-like recovery candidate', () => {
  test('rejects placeholders, missing Provider configuration, and shared migration credentials', () => {
    const valid = productionEnv();
    expect(validateProductionEnv(valid)).toEqual([]);
    expect(validateProductionEnv({ ...valid, BOT_SERVICE_TOKEN: 'change-me' })).toContain('BOT_SERVICE_TOKEN must not use a placeholder value.');
    expect(validateProductionEnv({ ...valid, PAYMENT_PROVIDER_BASE_URL: '' })).toContain('PAYMENT_PROVIDER_BASE_URL is required.');
    expect(validateProductionEnv({ ...valid, MIGRATION_DATABASE_URL: valid.DATABASE_URL })).toContain('Application and migration database credentials must be separate.');
  });

  test('AT-WHK-003 rejects invalid and expired signatures without applying an event', async () => {
    const adapter = new MockFundingAdapter({ now });
    const server = buildApiServer({
      env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'test-token' },
      paymentWebhook: { fundingAdapter: adapter, providerKey: 'mock-provider', now: () => now }
    });
    const body = JSON.stringify({ eventId: 'evt-invalid', resourceType: 'TRANSACTION', eventType: 'DEBIT_UPDATED',
      providerRef: 'mock_txn_1', transactionStatus: 'SUCCEEDED', occurredAt: now.toISOString() });
    const invalid = await server.inject({ method: 'POST', url: '/api/v1/webhooks/payment/mock-provider',
      headers: { 'content-type': 'application/octet-stream', 'x-mock-timestamp': now.toISOString(), 'x-mock-signature': '00'.repeat(32) }, payload: body });
    const expiredHeaders = signMockWebhook({ rawBody: body, receivedAt: new Date(now.getTime() - 301_000) }).headers;
    const expired = await server.inject({ method: 'POST', url: '/api/v1/webhooks/payment/mock-provider',
      headers: { 'content-type': 'application/octet-stream', ...expiredHeaders }, payload: body });

    expect([invalid.statusCode, expired.statusCode]).toEqual([401, 401]);
    expect(invalid.json().error).toMatchObject({ code: 'SIGNATURE_INVALID', retryable: false });
    expect(expired.json().error).toMatchObject({ code: 'REPLAY_REJECTED', retryable: false });
    expect(JSON.stringify([invalid.json(), expired.json()])).not.toContain('mock-webhook-secret');
  });

  test('defines isolated migration, healthy runtime services, and restart policies', async () => {
    const compose = await readFile('docker-compose.production.yml', 'utf8');
    for (const service of ['postgres:', 'migrate:', 'api:', 'worker:', 'bot:', 'dashboard:']) expect(compose).toContain(service);
    expect(compose).toContain('condition: service_completed_successfully');
    expect(compose).toContain('restart: unless-stopped');
    expect(compose).toContain('profiles: ["worker-runtime-pending"]');
    expect(compose).toContain('release is blocked');
    expect(compose).not.toContain('npm run worker');
    expect(compose).not.toContain('change-me');
  });

  test('AT-REC-005 restores an isolated database with immutable facts intact', async () => {
    const result = await execFile('bash', ['scripts/verify-backup-restore.sh'], { timeout: 30_000 });
    expect(result.stdout).toContain('backup-restore-ok');
    expect(result.stdout).toContain('restored_users=1');
    expect(result.stdout).toContain('restored_audits=1');
    expect(result.stdout).toContain('audit-delete-rejected');
  }, 35_000);
});

function productionEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production', DATABASE_URL: 'postgresql://blackcat_app:app-secret@postgres:5432/blackcat',
    MIGRATION_DATABASE_URL: 'postgresql://blackcat_migrate:migrate-secret@postgres:5432/blackcat',
    API_BASE_URL: 'https://api.example.test', BOT_SERVICE_TOKEN: 'b'.repeat(48),
    BOT_CONFIG_VALIDATION_SECRET: 'c'.repeat(48), DASHBOARD_CSRF_SECRET: 'd'.repeat(48),
    DASHBOARD_MFA_ENCRYPTION_KEY: 'e'.repeat(48), DISCORD_BOT_TOKEN: 'i'.repeat(48),
    DISCORD_OAUTH_CLIENT_ID: 'client-id', DISCORD_OAUTH_CLIENT_SECRET: 'f'.repeat(48),
    DISCORD_OAUTH_REDIRECT_URI: 'https://api.example.test/api/v1/auth/discord/callback', DISCORD_GUILD_ID: '900000000000000000',
    PAYMENT_PROVIDER_BASE_URL: 'https://sandbox.provider.test', PAYMENT_PROVIDER_SERVICE_TOKEN: 'g'.repeat(48),
    PAYMENT_PROVIDER_WEBHOOK_SECRET: 'h'.repeat(48), PAYMENT_PROVIDER_KEY: 'supplier-sandbox'
  };
}
