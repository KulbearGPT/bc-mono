import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import {
  InMemoryServiceCatalogStore,
  registerCatalogRoutes,
  type ServiceCatalogRecord
} from '@blackcat/api/catalog';
import {
  InMemoryCommissionStore,
  registerCommissionRoutes,
  type CommissionRecord
} from '@blackcat/api/commissions';
import {
  InMemoryPlayerEarningStore,
  registerPlayerEarningRoutes,
  type PlayerEarningRecord
} from '@blackcat/api/player-earnings';
import type { StaffDirectory } from '@blackcat/api/security';

const env = {
  NODE_ENV: 'test',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};
const createdAt = '2026-07-18T12:00:00.000Z';
const staffDirectory: StaffDirectory = {
  resolveByDiscord: () => ({
    staffId: '00000000-0000-0000-0000-000000009001',
    userId: '00000000-0000-0000-0000-000000009001',
    level: 'L3_OPERATIONS',
    status: 'ACTIVE',
    permissionsVersion: 1
  })
};

function headers() {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DASHBOARD',
    'x-actor-discord-user-id': '900000000000000091',
    'x-actor-guild-id': '900000000000000001'
  };
}

function catalog(idSuffix: string, timestamp = createdAt): ServiceCatalogRecord {
  return {
    id: `00000000-0000-0000-0000-${idSuffix}`,
    offeringKey: `GAME|SERVICE-${idSuffix}|NA`,
    game: 'GAME',
    service: `SERVICE-${idSuffix}`,
    region: 'NA',
    billingUnitMinutes: 60,
    minimumUnits: 1,
    customerUnitPriceMinor: 6000,
    playerUnitPayoutMinor: 4200,
    currency: 'CAT',
    status: 'ACTIVE',
    version: 1,
    createdByStaffId: '00000000-0000-0000-0000-000000009001',
    createdAt: timestamp,
    activatedAt: timestamp,
    retiredAt: null
  };
}

function commission(idSuffix: string, status: CommissionRecord['status'] = 'PENDING'): CommissionRecord {
  return {
    id: `00000000-0000-0000-0000-${idSuffix}`,
    referralAttributionId: '00000000-0000-0000-0000-000000009101',
    sourceCustomerId: '00000000-0000-0000-0000-000000009102',
    beneficiaryId: '00000000-0000-0000-0000-000000009103',
    programType: 'PLAYER_LIFETIME',
    rewardMode: 'PERCENT_LIFETIME',
    sourceType: 'ORDER',
    sourceId: '00000000-0000-0000-0000-000000009104',
    baseAmountMinor: 10000,
    rateBps: 200,
    amountMinor: 200,
    currency: 'CAT',
    status,
    adjustments: [],
    netAmountMinor: 200,
    version: 1,
    confirmedAt: null,
    paidAt: null,
    createdAt,
    updatedAt: createdAt
  };
}

function earning(idSuffix: string, playerId: string, status: PlayerEarningRecord['status'] = 'PENDING'): PlayerEarningRecord {
  return {
    id: `00000000-0000-0000-0000-${idSuffix}`,
    playerId,
    orderId: '00000000-0000-0000-0000-000000009201',
    baseUnits: 2,
    unitPayoutMinor: 4200,
    amountMinor: 8400,
    currency: 'CAT',
    status,
    version: 1,
    confirmedByStaffId: null,
    confirmedAt: null,
    paidAt: null,
    adjustments: [],
    netAmountMinor: 8400,
    createdAt,
    updatedAt: createdAt
  };
}

function fixture() {
  const catalogStore = new InMemoryServiceCatalogStore({
    records: [catalog('000000009301'), catalog('000000009303'), catalog('000000009302')]
  });
  const commissionStore = new InMemoryCommissionStore({
    commissions: [commission('000000009401'), commission('000000009403'), commission('000000009402'), commission('000000009499', 'PAID')],
    commissionGuildIds: Object.fromEntries(['000000009401','000000009403','000000009402','000000009499']
      .map((suffix) => [`00000000-0000-0000-0000-${suffix}`, '900000000000000001']))
  });
  const playerA = '00000000-0000-0000-0000-000000009501';
  const playerB = '00000000-0000-0000-0000-000000009502';
  const earningStore = new InMemoryPlayerEarningStore({
    earnings: [
      earning('000000009601', playerA),
      earning('000000009603', playerA),
      earning('000000009602', playerA),
      earning('000000009699', playerB)
    ]
  });
  const server = buildApiServer({ env, security: { staffDirectory } });
  registerCatalogRoutes(server, { store: catalogStore });
  registerCommissionRoutes(server, { store: commissionStore });
  registerPlayerEarningRoutes(server, { store: earningStore });
  return { server, playerA };
}

async function readIds(server: ReturnType<typeof buildApiServer>, url: string) {
  const response = await server.inject({ method: 'GET', url, headers: headers() });
  expect(response.statusCode).toBe(200);
  const data = response.json().data as { items: Array<{ id: string }>; nextCursor: string | null };
  return { ids: data.items.map((item) => item.id), nextCursor: data.nextCursor };
}

describe('M4-US-03 existing business list cursor pagination', () => {
  test('paginates service catalog versions in stable createdAt/id order', async () => {
    const { server } = fixture();
    const first = await readIds(server, '/api/v1/admin/service-catalog?limit=2');
    expect(first).toEqual({
      ids: ['00000000-0000-0000-0000-000000009303', '00000000-0000-0000-0000-000000009302'],
      nextCursor: expect.any(String)
    });

    const second = await readIds(server, `/api/v1/admin/service-catalog?limit=2&cursor=${first.nextCursor}`);
    expect(second).toEqual({ ids: ['00000000-0000-0000-0000-000000009301'], nextCursor: null });
  });

  test('paginates commissions after applying the status filter', async () => {
    const { server } = fixture();
    const first = await readIds(server, '/api/v1/admin/commissions?status=PENDING&limit=2');
    expect(first).toEqual({
      ids: ['00000000-0000-0000-0000-000000009403', '00000000-0000-0000-0000-000000009402'],
      nextCursor: expect.any(String)
    });

    const second = await readIds(server, `/api/v1/admin/commissions?status=PENDING&limit=2&cursor=${first.nextCursor}`);
    expect(second).toEqual({ ids: ['00000000-0000-0000-0000-000000009401'], nextCursor: null });
  });

  test('paginates player earnings after applying player and status filters', async () => {
    const { server, playerA } = fixture();
    const first = await readIds(server, `/api/v1/admin/player-earnings?playerId=${playerA}&status=PENDING&limit=2`);
    expect(first).toEqual({
      ids: ['00000000-0000-0000-0000-000000009603', '00000000-0000-0000-0000-000000009602'],
      nextCursor: expect.any(String)
    });

    const second = await readIds(server, `/api/v1/admin/player-earnings?playerId=${playerA}&status=PENDING&limit=2&cursor=${first.nextCursor}`);
    expect(second).toEqual({ ids: ['00000000-0000-0000-0000-000000009601'], nextCursor: null });
  });

  test('rejects malformed cursors on all three list routes', async () => {
    const { server } = fixture();
    for (const url of [
      '/api/v1/admin/service-catalog?cursor=not-a-cursor',
      '/api/v1/admin/commissions?cursor=not-a-cursor',
      '/api/v1/admin/player-earnings?cursor=not-a-cursor'
    ]) {
      const response = await server.inject({ method: 'GET', url, headers: headers() });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
  });

  test('rejects a decoded cursor whose database key is not a UUID', async () => {
    const { server } = fixture();
    const cursor = Buffer.from(JSON.stringify({ createdAt, id: 'not-a-uuid' })).toString('base64url');
    for (const url of [
      `/api/v1/admin/service-catalog?cursor=${cursor}`,
      `/api/v1/admin/commissions?cursor=${cursor}`,
      `/api/v1/admin/player-earnings?cursor=${cursor}`
    ]) {
      const response = await server.inject({ method: 'GET', url, headers: headers() });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
  });
});
