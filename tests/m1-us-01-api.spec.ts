import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildApiServer } from '@blackcat/api/server';
import {
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
  type StaffDirectory
} from '@blackcat/api/security';
import {
  InMemoryServiceCatalogStore,
  PostgresServiceCatalogStore,
  registerCatalogRoutes,
  type CatalogQueryClient,
  type ServiceCatalogRecord
} from '@blackcat/api/catalog';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};

const now = new Date('2026-07-17T15:00:00.000Z');

const staffDirectory: StaffDirectory = {
  resolveByDiscord({ discordUserId, guildId }) {
    if (guildId !== '999999999999999999') {
      return null;
    }
    if (discordUserId === '111111111111111111') {
      return {
        staffId: '00000000-0000-0000-0000-000000000111',
        userId: '00000000-0000-0000-0000-000000000011',
        level: 'L1_SUPPORT',
        permissionsVersion: 1,
        status: 'ACTIVE'
      };
    }
    if (discordUserId === '222222222222222222') {
      return {
        staffId: '00000000-0000-0000-0000-000000000222',
        userId: '00000000-0000-0000-0000-000000000022',
        level: 'L2_SUPERVISOR',
        permissionsVersion: 2,
        status: 'ACTIVE'
      };
    }
    if (discordUserId === '333333333333333333') {
      return {
        staffId: '00000000-0000-0000-0000-000000000333',
        userId: '00000000-0000-0000-0000-000000000033',
        level: 'L3_OPERATIONS',
        permissionsVersion: 3,
        status: 'ACTIVE'
      };
    }
    return null;
  }
};

function service(overrides: Partial<ServiceCatalogRecord> = {}): ServiceCatalogRecord {
  return {
    id: '00000000-0000-0000-0000-00000000c001',
    offeringKey: 'VALORANT|ENTERTAINMENT|NA',
    game: 'VALORANT',
    service: 'ENTERTAINMENT',
    region: 'NA',
    billingUnitMinutes: 60,
    minimumUnits: 1,
    customerUnitPriceMinor: 6000,
    playerUnitPayoutMinor: 4200,
    currency: 'CAT',
    status: 'ACTIVE',
    version: 1,
    createdByStaffId: '00000000-0000-0000-0000-000000000333',
    createdAt: now.toISOString(),
    activatedAt: now.toISOString(),
    retiredAt: null,
    ...overrides
  };
}

function buildCatalogServer(records: ServiceCatalogRecord[] = [service()]) {
  const auditSink = new InMemoryAuditSink();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const store = new InMemoryServiceCatalogStore({ records });
  const server = buildApiServer({
    env,
    security: {
      auditSink,
      idempotencyStore,
      staffDirectory
    }
  });

  registerCatalogRoutes(server, { store, now: () => now });

  return { server, store, auditSink, idempotencyStore };
}

function botHeaders(discordUserId: string, extra: Record<string, string> = {}) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': discordUserId,
    'x-actor-guild-id': '999999999999999999',
    'x-discord-interaction-id': '777777777777777777',
    ...extra
  };
}

function dashboardHeaders(discordUserId: string, extra: Record<string, string> = {}) {
  return {
    ...botHeaders(discordUserId, extra),
    'x-client-source': 'DASHBOARD'
  };
}

describe('M1-US-01 service catalog API contract', () => {
  test('customer-facing list and estimate accept a trusted non-staff Discord actor', async () => {
    const { server } = buildCatalogServer();

    const list = await server.inject({
      method: 'GET',
      url: '/api/v1/services',
      headers: botHeaders('444444444444444444')
    });
    const estimate = await server.inject({
      method: 'POST',
      url: '/api/v1/services/00000000-0000-0000-0000-00000000c001/estimate',
      headers: botHeaders('444444444444444444', { 'idempotency-key': 'discord:customer:estimate1' }),
      payload: { unitCount: 1 }
    });

    expect(list.statusCode).toBe(200);
    expect(estimate.statusCode).toBe(200);
    expect(list.body).not.toContain('playerUnitPayout');
    expect(estimate.body).not.toContain('playerEarningMinor');
  });

  test('customer-facing estimate scopes idempotency by Discord actor even when the user is not staff-bound', async () => {
    const { server } = buildCatalogServer();
    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/services/00000000-0000-0000-0000-00000000c001/estimate',
      headers: botHeaders('444444444444444444', { 'idempotency-key': 'discord:customer:sharedkey' }),
      payload: { unitCount: 1 }
    });
    const secondUser = await server.inject({
      method: 'POST',
      url: '/api/v1/services/00000000-0000-0000-0000-00000000c001/estimate',
      headers: botHeaders('555555555555555555', { 'idempotency-key': 'discord:customer:sharedkey' }),
      payload: { unitCount: 1 }
    });

    expect(first.statusCode).toBe(200);
    expect(secondUser.statusCode).toBe(200);
    expect(secondUser.headers['x-idempotency-replayed']).toBeUndefined();
  });

  test('listServices returns active customer catalog items without player payout fields', async () => {
    const { server } = buildCatalogServer([
      service(),
      service({
        id: '00000000-0000-0000-0000-00000000c002',
        offeringKey: 'LOL|RANKED|NA',
        game: 'LOL',
        service: 'RANKED',
        status: 'RETIRED'
      }),
      service({
        id: '00000000-0000-0000-0000-00000000c003',
        offeringKey: 'APEX|ENTERTAINMENT|NA',
        game: 'APEX',
        playerUnitPayoutMinor: null
      })
    ]);

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/services?region=NA',
      headers: botHeaders('111111111111111111')
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        items: [
          {
            id: '00000000-0000-0000-0000-00000000c001',
            game: 'VALORANT',
            service: 'ENTERTAINMENT',
            region: 'NA',
            customerUnitPriceMinor: 6000,
            currency: 'CAT',
            version: 1
          }
        ]
      }
    });
    expect(response.body).not.toContain('playerUnitPayout');
  });

  test('estimateService is idempotent and omits internal player earning snapshots from the public response', async () => {
    const { server } = buildCatalogServer();

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/services/00000000-0000-0000-0000-00000000c001/estimate',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:estimate:0001' }),
      payload: { unitCount: 2 }
    });
    const replay = await server.inject({
      method: 'POST',
      url: '/api/v1/services/00000000-0000-0000-0000-00000000c001/estimate',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:estimate:0001' }),
      payload: { unitCount: 2 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
        catalogVersion: 1,
        unitCount: 2,
        billingUnitMinutes: 60,
        amountMinor: 12000,
        currency: 'CAT'
      }
    });
    expect(response.body).not.toContain('playerEarningMinor');
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['x-idempotency-replayed']).toBe('true');
  });

  test('admin catalog read requires L2 and includes player payout snapshots', async () => {
    const { server, auditSink } = buildCatalogServer();

    const denied = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/service-catalog',
      headers: botHeaders('111111111111111111')
    });
    const allowed = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/service-catalog',
      headers: botHeaders('222222222222222222')
    });

    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      data: {
        items: [
          {
            id: '00000000-0000-0000-0000-00000000c001',
            customerUnitPriceMinor: 6000,
            playerUnitPayoutMinor: 4200,
            enabled: true,
            version: 1
          }
        ],
        nextCursor: null
      }
    });
    expect(auditSink.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorLevel: 'L1_SUPPORT',
          permissionCode: 'catalog.read',
          outcome: 'REJECTED'
        }),
        expect.objectContaining({
          actorLevel: 'L2_SUPERVISOR',
          permissionCode: 'catalog.read',
          outcome: 'SUCCEEDED'
        })
      ])
    );
  });

  test('admin catalog read supports the DASHBOARD client source through the same staff permission mapping', async () => {
    const { server } = buildCatalogServer();

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/service-catalog',
      headers: dashboardHeaders('222222222222222222')
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        items: [expect.objectContaining({ playerUnitPayoutMinor: 4200 })]
      }
    });
  });

  test('createServiceCatalogVersion requires L3 and commits only after a success audit record is available', async () => {
    const { server, store, auditSink } = buildCatalogServer([]);
    const payload = {
      game: 'VALORANT',
      service: 'ENTERTAINMENT',
      region: 'NA',
      billingUnitMinutes: 60,
      minimumUnits: 1,
      customerUnitPrice: { amountMinor: 6000, currency: 'CAT' },
      playerUnitPayout: { amountMinor: 4200, currency: 'CAT' },
      enabled: true,
      reasonCode: 'INITIAL_CATALOG_VERSION'
    };

    const denied = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/service-catalog',
      headers: botHeaders('222222222222222222', { 'idempotency-key': 'discord:catalog:create:l2' }),
      payload
    });
    const allowed = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/service-catalog',
      headers: botHeaders('333333333333333333', { 'idempotency-key': 'discord:catalog:create:l3' }),
      payload
    });

    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(201);
    expect(allowed.json()).toMatchObject({
      data: {
        game: 'VALORANT',
        service: 'ENTERTAINMENT',
        customerUnitPriceMinor: 6000,
        playerUnitPayoutMinor: 4200,
        enabled: true,
        version: 1
      }
    });
    expect(await store.list()).toHaveLength(1);
    expect(auditSink.records.at(-1)).toMatchObject({
      actorLevel: 'L3_OPERATIONS',
      permissionCode: 'catalog.manage',
      outcome: 'SUCCEEDED',
      reason: 'INITIAL_CATALOG_VERSION',
      targetType: 'service_catalog_version'
    });
  });

  test('createServiceCatalogVersion rolls back catalog records when success audit commit fails', async () => {
    const failingAuditSink = {
      append() {
        throw new Error('audit unavailable');
      }
    };
    const store = new InMemoryServiceCatalogStore({ records: [] });
    const server = buildApiServer({
      env,
      security: {
        auditSink: failingAuditSink,
        idempotencyStore: new InMemoryIdempotencyStore(),
        staffDirectory
      }
    });
    registerCatalogRoutes(server, { store, now: () => now, auditSink: failingAuditSink });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/service-catalog',
      headers: botHeaders('333333333333333333', { 'idempotency-key': 'discord:catalog:create:auditfail' }),
      payload: {
        game: 'VALORANT',
        service: 'ENTERTAINMENT',
        region: 'NA',
        billingUnitMinutes: 60,
        minimumUnits: 1,
        customerUnitPrice: { amountMinor: 6000, currency: 'CAT' },
        playerUnitPayout: { amountMinor: 4200, currency: 'CAT' },
        enabled: true,
        reasonCode: 'INITIAL_CATALOG_VERSION'
      }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'COMMIT_FAILED' } });
    expect(await store.list()).toHaveLength(0);
  });

  test('buildApiServer can wire catalog routes for the running API process', async () => {
    const server = buildApiServer({
      env,
      security: {
        auditSink: new InMemoryAuditSink(),
        idempotencyStore: new InMemoryIdempotencyStore(),
        staffDirectory
      },
      catalog: {
        store: new InMemoryServiceCatalogStore({ records: [service()] }),
        now: () => now
      }
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/services',
      headers: botHeaders('444444444444444444')
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        items: [expect.objectContaining({ id: '00000000-0000-0000-0000-00000000c001' })]
      }
    });
  });
});

describe('M1-US-01 Postgres service catalog store', () => {
  test('maps joined service_offerings and service_catalog_versions rows into catalog records', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client: CatalogQueryClient = {
      async query<Row>(sql: string, values?: unknown[]) {
        queries.push({ sql, values });
        return {
          rows: [
            {
              id: '00000000-0000-0000-0000-00000000c001',
              service_offering_id: '00000000-0000-0000-0000-00000000f001',
              game_code: 'VALORANT',
              game_name: '无畏契约',
              service_code: 'ENTERTAINMENT',
              service_name: '娱乐陪玩',
              region_code: 'NA',
              billing_unit_minutes: 60,
              minimum_units: 1,
              customer_unit_price_minor: '6000',
              player_unit_payout_minor: '4200',
              currency: 'CAT',
              status: 'ACTIVE',
              version: 3,
              created_by_staff_id: '00000000-0000-0000-0000-000000000333',
              created_at: now,
              activated_at: now,
              retired_at: null
            }
          ] as Row[]
        };
      }
    };
    const store = new PostgresServiceCatalogStore({ client });

    await expect(store.list()).resolves.toEqual([
      service({
        version: 3,
        game: 'VALORANT',
        service: 'ENTERTAINMENT',
        createdAt: now.toISOString()
      })
    ]);
    expect(queries[0]?.sql).toContain('FROM service_catalog_versions');
    expect(queries[0]?.sql).toContain('JOIN service_offerings');
  });

  test('saves through service_offerings and service_catalog_versions without updating historical prices in place', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client: CatalogQueryClient = {
      async query<Row>(sql: string, values?: unknown[]) {
        queries.push({ sql, values });
        return {
          rows: [
            {
              id: values?.[0],
              service_offering_id: '00000000-0000-0000-0000-00000000f001',
              game_code: 'VALORANT',
              game_name: 'VALORANT',
              service_code: 'ENTERTAINMENT',
              service_name: 'ENTERTAINMENT',
              region_code: 'NA',
              billing_unit_minutes: 60,
              minimum_units: 1,
              customer_unit_price_minor: '7200',
              player_unit_payout_minor: '5000',
              currency: 'CAT',
              status: 'ACTIVE',
              version: 2,
              created_by_staff_id: '00000000-0000-0000-0000-000000000333',
              created_at: now,
              activated_at: now,
              retired_at: null
            }
          ] as Row[]
        };
      }
    };
    const store = new PostgresServiceCatalogStore({ client });

    const saved = await store.save(
      service({
        id: '00000000-0000-0000-0000-00000000c010',
        customerUnitPriceMinor: 7200,
        playerUnitPayoutMinor: 5000,
        version: 2
      })
    );

    expect(saved).toMatchObject({
      id: '00000000-0000-0000-0000-00000000c010',
      customerUnitPriceMinor: 7200,
      playerUnitPayoutMinor: 5000,
      version: 2
    });
    expect(queries.map((query) => query.sql).join('\n')).toContain('ON CONFLICT (code)');
    expect(queries.map((query) => query.sql).join('\n')).not.toMatch(/UPDATE\s+service_catalog_versions\s+SET\s+customer_unit_price_minor/i);
  });

  test('uses a dedicated pooled transaction client for catalog/audit commits', async () => {
    const poolQueries: string[] = [];
    const transactionQueries: string[] = [];
    let released = false;
    const transactionClient: CatalogQueryClient & { release: () => void } = {
      async query<Row>(sql: string, values?: unknown[]) {
        transactionQueries.push(sql);
        if (sql.includes('RETURNING id, service_offering_id')) {
          return {
            rows: [
              {
                id: values?.[0],
                service_offering_id: '00000000-0000-0000-0000-00000000f001',
                game_code: 'VALORANT',
                game_name: 'VALORANT',
                service_code: 'ENTERTAINMENT',
                service_name: 'ENTERTAINMENT',
                region_code: 'NA',
                billing_unit_minutes: 60,
                minimum_units: 1,
                customer_unit_price_minor: '6000',
                player_unit_payout_minor: '4200',
                currency: 'CAT',
                status: 'ACTIVE',
                version: 3,
                created_by_staff_id: '00000000-0000-0000-0000-000000000333',
                created_at: now,
                activated_at: now,
                retired_at: null
              }
            ] as Row[]
          };
        }
        return { rows: [] as Row[] };
      },
      release() {
        released = true;
      }
    };
    const pool = {
      async query<Row>(sql: string) {
        poolQueries.push(sql);
        return { rows: [] as Row[] };
      },
      async connect() {
        return transactionClient;
      }
    };
    const store = new PostgresServiceCatalogStore({ pool });

    await store.commit({
      records: [service({ version: 3 })],
      auditRecord: {
        id: '00000000-0000-0000-0000-00000000a001',
        actorId: '00000000-0000-0000-0000-000000000033',
        actorStaffId: '00000000-0000-0000-0000-000000000333',
        actorLevel: 'L3_OPERATIONS',
        actorSource: 'DISCORD_BOT',
        clientId: 'DISCORD_BOT',
        interactionId: '777777777777777777',
        permissionCode: 'catalog.manage',
        action: 'CREATE_SERVICE_CATALOG_VERSION',
        targetType: 'service_catalog_version',
        targetId: '00000000-0000-0000-0000-00000000c001',
        outcome: 'SUCCEEDED',
        reason: 'INITIAL_CATALOG_VERSION',
        requestId: 'req_pool_commit',
        approvalRequestId: null,
        occurredAt: now.toISOString()
      },
      auditSink: new InMemoryAuditSink()
    });

    expect(poolQueries).toHaveLength(0);
    expect(transactionQueries[0]).toBe('BEGIN');
    expect(transactionQueries).toContain('COMMIT');
    expect(released).toBe(true);
  });
});

describe('M1-US-01 OpenAPI operationId consistency', () => {
  test('documents the implemented service catalog operations with stable operationIds', async () => {
    const openapi = await readFile('docs/P0开发交付包/02-API/openapi.yaml', 'utf8');

    expect(readOperationId(openapi, '/api/v1/services', 'get')).toBe('listServices');
    expect(readOperationId(openapi, '/api/v1/services/{serviceCatalogId}/estimate', 'post')).toBe('estimateService');
    expect(readOperationId(openapi, '/api/v1/admin/service-catalog', 'get')).toBe('listServiceCatalogVersions');
    expect(readOperationId(openapi, '/api/v1/admin/service-catalog', 'post')).toBe('createServiceCatalogVersion');
    expect(readOperationId(openapi, '/api/v1/admin/service-catalog/{serviceCatalogId}', 'patch')).toBe('updateServiceCatalogVersion');
    expect(countOperationId(openapi, 'listServices')).toBe(1);
    expect(countOperationId(openapi, 'estimateService')).toBe(1);
    expect(countOperationId(openapi, 'createServiceCatalogVersion')).toBe(1);
    expect(openapi).toMatch(/\/api\/v1\/services:\n[\s\S]*?operationId: listServices\n[\s\S]*?x-operation-aliases: \[listServiceCatalog\]/);
    expect(openapi).toMatch(/\/api\/v1\/admin\/service-catalog:\n[\s\S]*?operationId: listServiceCatalogVersions\n[\s\S]*?x-operation-aliases: \[listAdminServiceCatalog\]/);
  });
});

function readOperationId(openapi: string, path: string, method: string): string | null {
  const pathIndex = openapi.indexOf(`  ${path}:`);
  if (pathIndex === -1) {
    return null;
  }
  const nextPathIndex = openapi.indexOf('\n  /', pathIndex + 1);
  const pathBlock = openapi.slice(pathIndex, nextPathIndex === -1 ? undefined : nextPathIndex);
  const methodIndex = pathBlock.indexOf(`\n    ${method}:`);
  if (methodIndex === -1) {
    return null;
  }
  const nextMethodMatch = pathBlock.slice(methodIndex + 1).match(/\n    [a-z]+:/);
  const methodBlock = pathBlock.slice(methodIndex, nextMethodMatch ? methodIndex + 1 + nextMethodMatch.index! : undefined);
  return methodBlock.match(/\n      operationId: ([A-Za-z0-9_]+)/)?.[1] ?? null;
}

function countOperationId(openapi: string, operationId: string): number {
  return openapi.match(new RegExp(`operationId: ${operationId}\\b`, 'g'))?.length ?? 0;
}
