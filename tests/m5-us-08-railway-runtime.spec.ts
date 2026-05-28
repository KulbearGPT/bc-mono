import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApiServer, registerDashboardAssets } from '@blackcat/api/server';
import {
  requireProductionServiceEnv,
  startProcessHealthServer
} from '@blackcat/platform/process-health';
import { validateRuntimeEnv } from '@blackcat/platform/env';
import { isSandboxProvisionEntrypoint } from '@blackcat/api/sandbox-funding-provision';
import { validateProductionEnv } from '../scripts/verify-production-env.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('M5-US-08 Railway runtime contract', () => {
  it('runs migration only for web and uses exact health paths', async () => {
    const web = JSON.parse(await readFile('railway/web.json', 'utf8'));
    const bot = JSON.parse(await readFile('railway/bot.json', 'utf8'));
    const worker = JSON.parse(await readFile('railway/worker.json', 'utf8'));
    expect(web.deploy).toMatchObject({
      preDeployCommand: 'npm run db:migrate:deploy',
      startCommand: 'npm run start:web',
      healthcheckPath: '/ready',
      restartPolicyType: 'ON_FAILURE'
    });
    expect(bot.deploy).toMatchObject({ startCommand: 'npm run start:bot', healthcheckPath: '/health', restartPolicyType: 'ON_FAILURE' });
    expect(worker.deploy).toMatchObject({ startCommand: 'npm run start:worker', healthcheckPath: '/health', restartPolicyType: 'ON_FAILURE' });
    expect(bot.deploy).not.toHaveProperty('preDeployCommand');
    expect(worker.deploy).not.toHaveProperty('preDeployCommand');
  });

  it('serves SPA navigation without capturing API, health or asset routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blackcat-dashboard-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<main id="pilot-dashboard">pilot</main>');
    const server = buildApiServer({ env: testEnv() });
    await registerDashboardAssets(server, root);
    expect((await server.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } })).body).toContain('pilot-dashboard');
    expect((await server.inject({ method: 'GET', url: '/orders', headers: { accept: 'text/html' } })).body).toContain('pilot-dashboard');
    expect((await server.inject({ method: 'GET', url: '/api/v1/not-found', headers: { accept: 'text/html' } })).body).not.toContain('pilot-dashboard');
    expect((await server.inject({ method: 'GET', url: '/assets/missing.js', headers: { accept: 'text/html' } })).body).not.toContain('pilot-dashboard');
    expect((await server.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({ data: { status: 'OK' } });
    await server.close();
  });

  it('reports process readiness on /health and nothing else', async () => {
    let ready = false;
    const health = await startProcessHealthServer({ port: 0, isReady: () => ready });
    const address = health.server.address();
    if (!address || typeof address === 'string') throw new Error('health server address unavailable');
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/health`)).status).toBe(503);
    ready = true;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/ready`)).status).toBe(404);
    await health.close();
  });

  it('fails closed for missing Bot/Worker production inputs without exposing values', () => {
    expect(() => requireProductionServiceEnv('bot', { NODE_ENV: 'production', PORT: '3001' })).toThrow(/DISCORD_BOT_TOKEN/u);
    expect(() => requireProductionServiceEnv('worker', { NODE_ENV: 'production', PORT: '3002' })).toThrow(/DATABASE_URL/u);
    expect(() => requireProductionServiceEnv('bot', {
      NODE_ENV: 'production', PORT: '3001', DISCORD_BOT_TOKEN: 'secret',
      API_BASE_URL: 'http://api.railway.internal:3000', BOT_SERVICE_TOKEN: 'service'
    })).not.toThrow();
  });

  it('makes the actual Bot and Worker entrypoints exit non-zero on incomplete production environments', () => {
    for (const [entrypoint, expected] of [
      ['apps/bot/src/index.ts', 'DISCORD_BOT_TOKEN'],
      ['apps/api/src/worker.ts', 'DATABASE_URL']
    ] as const) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', entrypoint], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, NODE_ENV: 'production', PORT: '3999' },
        encoding: 'utf8',
        timeout: 10_000
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(expected);
    }
  });

  it('keeps the local Bot entrypoint usable without a Discord token', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/bot/src/index.ts'], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'development',
        BUSINESS_ENV: 'SANDBOX',
        DATABASE_URL: 'postgresql://blackcat_app:blackcat_app@localhost:5432/blackcat',
        API_BASE_URL: 'http://localhost:3000',
        BOT_SERVICE_TOKEN: 'local-service'
      },
      encoding: 'utf8',
      timeout: 10_000
    });
    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('bot.discord.login.skipped');
    expect(output).not.toContain('production configuration is missing');
  });

  it('accepts Railway private API HTTP while keeping public URLs HTTPS', () => {
    const env = productionEnv();
    expect(validateProductionEnv(env)).toEqual([]);
    expect(validateProductionEnv({ ...env, API_BASE_URL: 'http://public.example.com' })).toContain('API_BASE_URL must use HTTPS or Railway private HTTP.');
    expect(validateProductionEnv({ ...env, DISCORD_OAUTH_REDIRECT_URI: 'http://dashboard.example.com/callback' })).toContain('DISCORD_OAUTH_REDIRECT_URI must use HTTPS.');
    expect(validateProductionEnv({ ...env, BUSINESS_ENV: 'PRODUCTION', FUNDING_ADAPTER: 'SANDBOX' }))
      .toContain('FUNDING_ADAPTER=SANDBOX is forbidden when BUSINESS_ENV=PRODUCTION.');
  });

  it('uses Railway PORT for the web listener while retaining API_PORT compatibility', () => {
    expect(validateRuntimeEnv({ ...testEnv(), API_PORT: '3000', PORT: '4321' }).values.apiPort).toBe(4321);
    expect(validateRuntimeEnv({ ...testEnv(), API_PORT: '4321' }).values.apiPort).toBe(4321);
  });

  it('builds one compiled Node 22 image with no watch or tsx runtime', async () => {
    const dockerfile = await readFile('Dockerfile', 'utf8');
    const dockerignore = await readFile('.dockerignore', 'utf8');
    const rootPackage = JSON.parse(await readFile('package.json', 'utf8'));
    const platformPackage = JSON.parse(await readFile('modules/platform/package.json', 'utf8'));
    expect(dockerfile).toContain('FROM node:22-alpine AS build');
    expect(dockerfile).toContain('RUN npm run build:railway');
    expect(dockerfile).toContain('RUN npm prune --omit=dev');
    expect(dockerfile).not.toMatch(/tsx|vite --host|watch/u);
    expect(dockerignore).toContain('**/*.tsbuildinfo');
    expect(rootPackage.scripts).toMatchObject({
      'start:web': 'node apps/api/dist/index.js',
      'start:bot': 'node apps/bot/dist/index.js',
      'start:worker': 'node apps/api/dist/worker.js',
      'sandbox:provision:prod': 'NODE_ENV=production node apps/api/dist/sandbox-funding-provision.js'
    });
    expect(rootPackage.dependencies).toHaveProperty('prisma');
    expect(rootPackage.devDependencies).not.toHaveProperty('prisma');
    expect(platformPackage.exports['./process-health']).toEqual({
      types: './src/process-health.ts',
      import: './dist/process-health.js'
    });
  });

  it('executes the compiled sandbox provisioning script as a production entrypoint', () => {
    expect(isSandboxProvisionEntrypoint(
      'file:///app/apps/api/dist/sandbox-funding-provision.js',
      '/app/apps/api/dist/sandbox-funding-provision.js'
    )).toBe(true);
    expect(isSandboxProvisionEntrypoint(
      'file:///app/apps/api/dist/sandbox-funding-provision.js',
      '/app/apps/api/dist/worker.js'
    )).toBe(false);
  });

  it('does not serve Dashboard HTML for the exact API prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blackcat-dashboard-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<main id="pilot-dashboard">pilot</main>');
    const server = buildApiServer({ env: testEnv() });
    await registerDashboardAssets(server, root);
    expect((await server.inject({ method: 'GET', url: '/api', headers: { accept: 'text/html' } })).body).not.toContain('pilot-dashboard');
    await server.close();
  });
});

function testEnv() {
  return { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'test-token' };
}

function productionEnv() {
  const secret = 'x'.repeat(32);
  return {
    NODE_ENV: 'production', BUSINESS_ENV: 'SANDBOX', FUNDING_ADAPTER: 'SANDBOX', PILOT_PHASE: 'CORE_ORDER',
    DATABASE_URL: 'postgresql://app@db.internal/app', MIGRATION_DATABASE_URL: 'postgresql://migrate@db.internal/app',
    API_BASE_URL: 'http://web.railway.internal:3000', BOT_SERVICE_TOKEN: secret, BOT_CONFIG_VALIDATION_SECRET: secret,
    DASHBOARD_CSRF_SECRET: secret, DASHBOARD_MFA_ENCRYPTION_KEY: secret, SANDBOX_BINDING_CODE_SECRET: secret,
    DISCORD_BOT_TOKEN: secret, DISCORD_OAUTH_CLIENT_ID: 'discord-client', DISCORD_OAUTH_CLIENT_SECRET: secret,
    DISCORD_OAUTH_REDIRECT_URI: 'https://dashboard.example.com/api/v1/auth/discord/callback', DISCORD_GUILD_ID: '123456789012345678',
    DASHBOARD_URL: 'https://dashboard.example.com'
  };
}
