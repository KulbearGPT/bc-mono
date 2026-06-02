import { describe, expect, test } from 'vitest';
import {
  CatalogError,
  InMemoryServiceCatalogStore,
  createServiceCatalogVersion,
  estimateService,
  listServices,
  updateServiceCatalogVersion,
  type ServiceCatalogRecord
} from '@blackcat/api/catalog';
import type { ActorContext } from '@blackcat/api/security';

const now = new Date('2026-07-17T15:00:00.000Z');

const l2Actor: ActorContext = {
  actorUserId: '00000000-0000-0000-0000-00000000d002',
  actorStaffId: '00000000-0000-0000-0000-00000000e002',
  actorLevel: 'L2_SUPERVISOR',
  actorSource: 'DASHBOARD',
  clientId: 'DASHBOARD',
  guildId: null,
  discordUserId: null,
  interactionId: null,
  permissionsVersion: 1
};

const l3Actor: ActorContext = {
  ...l2Actor,
  actorUserId: '00000000-0000-0000-0000-00000000d003',
  actorStaffId: '00000000-0000-0000-0000-00000000e003',
  actorLevel: 'L3_OPERATIONS',
  permissionsVersion: 2
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
    createdByStaffId: '00000000-0000-0000-0000-00000000e003',
    createdAt: now.toISOString(),
    activatedAt: now.toISOString(),
    retiredAt: null,
    ...overrides
  };
}

describe('M1-US-01 service catalog and dual price snapshots', () => {
  test('lists only active services with complete dual prices and never exposes player payout', async () => {
    const store = new InMemoryServiceCatalogStore({
      records: [
        service(),
        service({
          id: '00000000-0000-0000-0000-00000000c002',
          offeringKey: 'LOL|RANKED|NA',
          game: 'LOL',
          service: 'RANKED',
          status: 'RETIRED',
          version: 1
        }),
        service({
          id: '00000000-0000-0000-0000-00000000c003',
          offeringKey: 'APEX|ENTERTAINMENT|NA',
          game: 'APEX',
          playerUnitPayoutMinor: null,
          status: 'ACTIVE',
          version: 1
        })
      ]
    });

    const result = await listServices({ store, filters: { region: 'NA' } });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({
      id: '00000000-0000-0000-0000-00000000c001',
      game: 'VALORANT',
      service: 'ENTERTAINMENT',
      region: 'NA',
      billingUnitMinutes: 60,
      minimumUnits: 1,
      customerUnitPriceMinor: 6000,
      currency: 'CAT',
      version: 1
    });
    expect(JSON.stringify(result.items)).not.toContain('playerUnitPayout');
  });

  test('estimates from the selected catalog version and rejects unavailable versions', async () => {
    const store = new InMemoryServiceCatalogStore({
      records: [
        service(),
        service({
          id: '00000000-0000-0000-0000-00000000c004',
          offeringKey: 'VALORANT|ENTERTAINMENT|NA',
          customerUnitPriceMinor: 7200,
          playerUnitPayoutMinor: 5000,
          status: 'ACTIVE',
          version: 2
        }),
        service({
          id: '00000000-0000-0000-0000-00000000c005',
          offeringKey: 'VALORANT|COACHING|NA',
          service: 'COACHING',
          status: 'RETIRED',
          version: 1
        })
      ]
    });

    const estimate = await estimateService({
      store,
      serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
      unitCount: 2,
      now
    });

    expect(estimate).toMatchObject({
      serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
      catalogVersion: 1,
      unitCount: 2,
      billingUnitMinutes: 60,
      amountMinor: 12000,
      playerEarningMinor: 8400,
      currency: 'CAT'
    });
    await expect(
      estimateService({
        store,
        serviceCatalogId: '00000000-0000-0000-0000-00000000c005',
        unitCount: 1,
        now
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'SERVICE_NOT_AVAILABLE' }));
  });

  test('requires L3 to create enabled catalog versions with both prices', async () => {
    const store = new InMemoryServiceCatalogStore({ records: [] });

    await expect(
      createServiceCatalogVersion({
        store,
        actor: l2Actor,
        input: {
          game: 'VALORANT',
          service: 'ENTERTAINMENT',
          region: 'NA',
          billingUnitMinutes: 60,
          minimumUnits: 1,
          customerUnitPrice: { amountMinor: 6000, currency: 'CAT' },
          playerUnitPayout: { amountMinor: 4200, currency: 'CAT' },
          enabled: true,
          reasonCode: 'INITIAL_CATALOG_VERSION'
        },
        now
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));

    await expect(
      createServiceCatalogVersion({
        store,
        actor: l3Actor,
        input: {
          game: 'VALORANT',
          service: 'ENTERTAINMENT',
          region: 'NA',
          billingUnitMinutes: 60,
          minimumUnits: 1,
          customerUnitPrice: { amountMinor: 6000, currency: 'CAT' },
          playerUnitPayout: null,
          enabled: true,
          reasonCode: 'INITIAL_CATALOG_VERSION'
        },
        now
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }));

    const created = await createServiceCatalogVersion({
      store,
      actor: l3Actor,
      input: {
        game: 'VALORANT',
        service: 'ENTERTAINMENT',
        region: 'NA',
        billingUnitMinutes: 60,
        minimumUnits: 1,
        customerUnitPrice: { amountMinor: 6000, currency: 'CAT' },
        playerUnitPayout: { amountMinor: 4200, currency: 'CAT' },
        enabled: true,
        reasonCode: 'INITIAL_CATALOG_VERSION'
      },
      now
    });

    expect(created).toMatchObject({
      game: 'VALORANT',
      service: 'ENTERTAINMENT',
      region: 'NA',
      customerUnitPriceMinor: 6000,
      playerUnitPayoutMinor: 4200,
      enabled: true,
      version: 1
    });
  });

  test('creates replacement versions without overwriting old price snapshots', async () => {
    const store = new InMemoryServiceCatalogStore({ records: [service()] });

    const replacement = await updateServiceCatalogVersion({
      store,
      actor: l3Actor,
      serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
      input: {
        expectedVersion: 1,
        action: 'SUPERSEDE',
        reasonCode: 'PRICE_CHANGE',
        replacement: {
          game: 'VALORANT',
          service: 'ENTERTAINMENT',
          region: 'NA',
          billingUnitMinutes: 60,
          minimumUnits: 1,
          customerUnitPrice: { amountMinor: 7200, currency: 'CAT' },
          playerUnitPayout: { amountMinor: 5000, currency: 'CAT' },
          enabled: true,
          reasonCode: 'PRICE_CHANGE'
        }
      },
      now
    });
    const oldVersion = await store.getById('00000000-0000-0000-0000-00000000c001');

    expect(oldVersion).toMatchObject({
      version: 1,
      customerUnitPriceMinor: 6000,
      playerUnitPayoutMinor: 4200,
      status: 'RETIRED'
    });
    expect(replacement).toMatchObject({
      version: 2,
      customerUnitPriceMinor: 7200,
      playerUnitPayoutMinor: 5000,
      enabled: true
    });
  });
});
