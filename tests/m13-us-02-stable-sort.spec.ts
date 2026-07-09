import { describe, expect, test } from 'vitest';
import {
  collectionSortFields,
  paginateAdminCollection,
  type AdminCollectionPageInput
} from '@blackcat/api/admin-collection-sort';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAdminDirectoryStore } from '@blackcat/api/admin-directory';
import type { StaffDirectory } from '@blackcat/api/security';
import { readFile } from 'node:fs/promises';

type Row = { id: string; name: string | null; amount: number | null; createdAt: string };

const rows: Row[] = [
  { id: '00000000-0000-0000-0000-000000000003', name: null, amount: null, createdAt: '2026-08-03T00:00:00.000Z' },
  { id: '00000000-0000-0000-0000-000000000002', name: 'Beta', amount: 10, createdAt: '2026-08-02T00:00:00.000Z' },
  { id: '00000000-0000-0000-0000-000000000001', name: 'Alpha', amount: 10, createdAt: '2026-08-01T00:00:00.000Z' }
];

function page(overrides: Partial<AdminCollectionPageInput<Row>> = {}) {
  return paginateAdminCollection(rows, {
    resource: 'orders',
    cursor: null,
    limit: 2,
    sortBy: 'amountMinor',
    sortDirection: 'asc',
    binding: { actorGuildId: 'guild-a', actorScope: 'L3_OPERATIONS', filters: { status: 'ACTIVE' } },
    idOf: (row) => row.id,
    valueOf: (row) => row.amount,
    ...overrides
  });
}

describe('M13-US-02 stable server-side collection sorting', () => {
  test('publishes the frozen sort whitelist for all seven resources', () => {
    expect(collectionSortFields).toEqual({
      orders: ['createdAt', 'updatedAt', 'amountMinor'],
      users: ['createdAt', 'updatedAt', 'displayName'],
      players: ['createdAt', 'updatedAt', 'displayName'],
      service_catalog: ['createdAt', 'offeringName', 'customerUnitPriceMinor', 'version'],
      service_packages: ['createdAt', 'displayName', 'defaultCustomerPriceMinor', 'version'],
      gift_catalog: ['createdAt', 'name', 'priceMinor', 'version'],
      gift_requests: ['createdAt', 'updatedAt', 'amountMinor', 'expiresAt']
    });
  });

  test('uses the unique id as a deterministic tie-breaker and always places null last', () => {
    expect(page().items.map((row) => row.id)).toEqual([
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002'
    ]);
    expect(page({ limit: 3, sortDirection: 'desc' }).items.map((row) => row.id)).toEqual([
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000003'
    ]);
  });

  test('continues a keyset page without duplicates or skips when a row is inserted', () => {
    const first = page({ limit: 1 });
    expect(first.nextCursor).toEqual(expect.any(String));
    const changed = [...rows, { id: '00000000-0000-0000-0000-000000000004', name: 'Inserted', amount: 5, createdAt: '2026-08-04T00:00:00.000Z' }];
    const second = paginateAdminCollection(changed, {
      resource: 'orders', cursor: first.nextCursor, limit: 3, sortBy: 'amountMinor', sortDirection: 'asc',
      binding: { actorGuildId: 'guild-a', actorScope: 'L3_OPERATIONS', filters: { status: 'ACTIVE' } },
      idOf: (row) => row.id, valueOf: (row) => row.amount
    });
    expect(second.items.map((row) => row.id)).toEqual([
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000003'
    ]);
  });

  test('rejects tampered, cross-resource, cross-sort and cross-filter cursors', () => {
    const cursor = page({ limit: 1 }).nextCursor!;
    for (const override of [
      { cursor: `${cursor.slice(0, -1)}x` },
      { cursor, resource: 'gift_requests' as const },
      { cursor, sortBy: 'createdAt' },
      { cursor, binding: { actorGuildId: 'guild-a', actorScope: 'L3_OPERATIONS', filters: { status: 'PAUSED' } } }
    ]) {
      expect(() => page(override)).toThrow(/cursor is invalid/i);
    }
  });

  test('validates sort queries at the API boundary and binds cursors to filters', async () => {
    const staffDirectory: StaffDirectory = { resolveByDiscord: () => ({ staffId: '00000000-0000-0000-0000-000000009001', userId: '00000000-0000-0000-0000-000000009002', level: 'L2_SUPERVISOR', status: 'ACTIVE', permissionsVersion: 1 }) };
    const store = new InMemoryAdminDirectoryStore({ orders: [], players: [], consumptions: [], gifts: [], giftRequests: [], users: [
      { id: '00000000-0000-0000-0000-000000000011', displayName: 'Zulu', status: 'ACTIVE', externalAccountDisplay: null, activeOrderId: null, riskFlags: [], version: 1, createdAt: '2026-08-01T00:00:00.000Z' },
      { id: '00000000-0000-0000-0000-000000000012', displayName: 'Alpha', status: 'ACTIVE', externalAccountDisplay: null, activeOrderId: null, riskFlags: [], version: 1, createdAt: '2026-08-02T00:00:00.000Z' }
    ] });
    const server = buildApiServer({ env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost', BOT_SERVICE_TOKEN: 'token' }, security: { staffDirectory }, adminDirectory: { store } });
    const headers = { authorization: 'Bearer token', 'x-client-source': 'DASHBOARD', 'x-actor-discord-user-id': '900000000000000001', 'x-actor-guild-id': '900000000000000002' };
    const first = await server.inject({ method: 'GET', url: '/api/v1/admin/users?sortBy=displayName&sortDirection=asc&limit=1', headers });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.items[0].displayName).toBe('Alpha');
    const cursor = first.json().data.nextCursor as string;
    const rebound = await server.inject({ method: 'GET', url: `/api/v1/admin/users?sortBy=displayName&sortDirection=asc&query=Zulu&limit=1&cursor=${cursor}`, headers });
    expect(rebound.statusCode).toBe(400);
    const invalid = await server.inject({ method: 'GET', url: '/api/v1/admin/users?sortBy=amountMinor', headers });
    expect(invalid.statusCode).toBe(400);
  });

  test('ships database indexes for the sortable keyset projections', async () => {
    const [schema,migration]=await Promise.all([readFile('database/prisma/schema.prisma','utf8'),readFile('database/prisma/migrations/000034_m13_collection_sort_indexes/migration.sql','utf8')]);
    for(const index of ['users_display_name_id_idx','player_profiles_updated_at_id_idx','service_catalog_versions_price_id_idx','service_package_versions_name_id_idx','orders_guild_amount_id_idx','gift_catalog_versions_price_item_idx','gift_requests_expires_at_id_idx']){
      expect(schema).toContain(index);expect(migration).toContain(index);
    }
  });
});
