import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildApiServer, getHealthPayload, getReadinessPayload } from '@blackcat/api/server';
import { discoverSapphirePieces } from '@blackcat/bot/piece-manifest';
import { buildDashboardManifest } from '../apps/dashboard/src/manifest';
import { validateRuntimeEnv } from '@blackcat/platform/env';

describe('M0-US-01 local workspace skeleton', () => {
  test('root dev command starts all prototype processes with checked-in defaults', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    expect(packageJson.scripts.dev).toContain('dotenv -e .env.example');
    expect(packageJson.scripts.dev).toContain('@blackcat/api');
    expect(packageJson.scripts.dev).toContain('@blackcat/bot');
    expect(packageJson.scripts.dev).toContain('@blackcat/dashboard');
    expect(packageJson.dependencies.pg).toBeDefined();
  });

  test('validates required production configuration with explicit errors', () => {
    const result = validateRuntimeEnv(
      {
        NODE_ENV: 'production',
        DATABASE_URL: '',
        API_PORT: 'not-a-port',
        API_BASE_URL: '',
        BOT_SERVICE_TOKEN: ''
      },
      { allowMissingDiscordToken: true }
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'DATABASE_URL', code: 'REQUIRED' }),
        expect.objectContaining({ field: 'API_PORT', code: 'INVALID_PORT' }),
        expect.objectContaining({ field: 'API_BASE_URL', code: 'REQUIRED' })
      ])
    );
    expect(result.errors).not.toContainEqual(expect.objectContaining({ field: 'DISCORD_BOT_TOKEN' }));
  });

  test('health is liveness-only and readiness reports dependency state', async () => {
    const health = getHealthPayload('req_test_health');
    const readiness = await getReadinessPayload(
      {
        NODE_ENV: 'development',
        DATABASE_URL: '',
        API_PORT: '3000',
        API_BASE_URL: 'http://localhost:3000',
        BOT_SERVICE_TOKEN: 'dev-service-token'
      },
      { discordTokenPresent: false }
    );

    expect(health).toMatchObject({
      requestId: 'req_test_health',
      data: { status: 'OK' }
    });
    expect(readiness.data.status).toBe('NOT_READY');
    expect(readiness.data.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'database', status: 'MISSING_CONFIG' }),
        expect.objectContaining({ name: 'discord', status: 'TOKEN_NOT_CONFIGURED' })
      ])
    );
  });

  test('API exposes OpenAPI operationId-aligned health and readiness endpoints', async () => {
    const server = buildApiServer({
      env: {
        NODE_ENV: 'development',
        DATABASE_URL: '',
        API_PORT: '0',
        API_BASE_URL: 'http://localhost:3000',
        BOT_SERVICE_TOKEN: 'dev-service-token'
      }
    });

    const healthResponse = await server.inject({ method: 'GET', url: '/health' });
    const readyResponse = await server.inject({ method: 'GET', url: '/ready' });

    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.json()).toMatchObject({ data: { status: 'OK' } });
    expect(readyResponse.statusCode).toBe(503);
    expect(readyResponse.json()).toMatchObject({ data: { status: 'NOT_READY' } });
  });

  test('readiness checks the configured database login and baseline schema, not only the TCP port', async () => {
    const serverSource = await readFile(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8');

    expect(serverSource).toContain("from 'pg'");
    expect(serverSource).toContain("to_regclass('public.users')");
    expect(serverSource).toContain('blackcat_ready_probe');
  });

  test('readiness reports NOT_READY when database URL is configured but unreachable', async () => {
    const server = buildApiServer({
      env: {
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://blackcat_app:blackcat_app@127.0.0.1:9/blackcat',
        API_PORT: '0',
        API_BASE_URL: 'http://localhost:3000',
        BOT_SERVICE_TOKEN: 'dev-service-token'
      },
      dependencyTimeoutMs: 100
    });

    const readyResponse = await server.inject({ method: 'GET', url: '/ready' });

    expect(readyResponse.statusCode).toBe(503);
    expect(readyResponse.json()).toMatchObject({
      data: {
        status: 'NOT_READY'
      }
    });
    expect(readyResponse.json().data.dependencies).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'database', status: 'UNREACHABLE' })])
    );
  });

  test('Sapphire adapter has a verifiable Piece manifest', async () => {
    const manifest = await discoverSapphirePieces();

    expect(manifest.framework).toBe('@sapphire/framework');
    expect(manifest.pieces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'commands', name: 'service-center' }),
        expect.objectContaining({ kind: 'listeners', name: 'ready' })
      ])
    );
  });

  test('dashboard process has a minimal shell manifest', () => {
    expect(buildDashboardManifest()).toEqual({
      appName: 'Blackcat Companion Dashboard',
      framework: 'react-vite',
      routes: [{ path: '/', label: 'Operations home' }]
    });
  });
});
