import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { InMemoryAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';
import {
  InMemoryOrderStore,
  getOrder,
  prepareCancelOrder,
  previewOrderCancellation,
  type OrderRecord
} from '@blackcat/api/orders';
import { buildOrderAvailableActions } from '@blackcat/api/order-actions';
import { InMemoryStaffTaskStore } from '@blackcat/api/staff-tasks';

const now = new Date('2026-08-10T10:00:00.000Z');
const orderId = '00000000-0000-0000-0000-000000002001';
const customerId = '00000000-0000-0000-0000-000000002002';

describe('M20-US-02 trusted order actions', () => {
  test('offers a server-owned cancellation action for every customer non-terminal state', () => {
    const immediate = ['DRAFT', 'PENDING_DISPATCH'] as const;
    const reviewed = ['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION', 'EXCEPTION'] as const;

    for (const status of immediate) {
      expect(keys(status, 'CUSTOMER')).toContain('CUSTOMER_CANCEL_ORDER');
    }
    for (const status of reviewed) {
      expect(keys(status, 'CUSTOMER')).toContain('CUSTOMER_REQUEST_CANCELLATION');
    }
    for (const status of ['COMPLETED', 'CANCELLED'] as const) {
      expect(keys(status, 'CUSTOMER')).not.toEqual(
        expect.arrayContaining(['CUSTOMER_CANCEL_ORDER', 'CUSTOMER_REQUEST_CANCELLATION'])
      );
    }
    expect(
      buildOrderAvailableActions({
        status: 'IN_SERVICE',
        role: 'CUSTOMER',
        hasOpenCancellationAssist: true
      }).map((action) => action.key)
    ).toContain('CUSTOMER_VIEW_CANCELLATION_STATUS');
  });

  test('separates customer, player, and staff write actions', () => {
    const customer = keys('IN_SERVICE', 'CUSTOMER');
    const player = keys('IN_SERVICE', 'PLAYER');
    const staff = keys('IN_SERVICE', 'STAFF');

    expect(customer).toContain('CUSTOMER_SEND_GIFT');
    expect(customer).not.toContain('PLAYER_REQUEST_COMPLETION');
    expect(player).toContain('PLAYER_REQUEST_COMPLETION');
    expect(player).not.toContain('CUSTOMER_REQUEST_CANCELLATION');
    expect(staff).toEqual(expect.arrayContaining(['STAFF_OPEN_ORDER', 'STAFF_REFRESH_ORDER']));
    expect(staff).not.toContain('PLAYER_REQUEST_COMPLETION');
  });

  test('projects customer availableActions from getOrder and detects an open cancellation task', async () => {
    const record = order({ status: 'IN_SERVICE' });
    const staffTasks = new InMemoryStaffTaskStore({ tasks: [] });
    staffTasks.createOrderTask({
      order: record,
      type: 'CANCELLATION_ASSIST',
      reasonCode: 'CUSTOMER_CANCEL_AFTER_ACCEPT',
      actor: actor(),
      now
    });
    const result = await getOrder({
      accountStore: accounts(),
      orderStore: new InMemoryOrderStore({ orders: [record] }),
      staffTaskStore: staffTasks,
      actor: actor(),
      orderId
    });

    expect(result.availableActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'CUSTOMER_VIEW_CANCELLATION_STATUS',
          role: 'CUSTOMER',
          enabled: true
        })
      ])
    );
    expect(result.availableActions.map((action) => action.key)).not.toContain('PLAYER_REQUEST_COMPLETION');
  });

  test('routes EXCEPTION cancellation through idempotent staff review without changing order state', async () => {
    const record = order({ status: 'EXCEPTION', version: 7 });
    const orderStore = new InMemoryOrderStore({ orders: [record] });
    const staffTaskStore = new InMemoryStaffTaskStore({ tasks: [] });
    const preview = await previewOrderCancellation({
      accountStore: accounts(),
      orderStore,
      actor: actor(),
      orderId,
      input: { expectedVersion: 7, reasonCode: 'CUSTOMER_REQUEST' },
      now
    });

    expect(preview).toMatchObject({ automaticallyProcessable: false, staffTaskRequired: true });
    const first = await prepareCancelOrder({
      accountStore: accounts(),
      orderStore,
      staffTaskStore,
      actor: actor(),
      orderId,
      input: {
        expectedVersion: 7,
        previewId: preview.previewId,
        reasonCode: 'CUSTOMER_REQUEST'
      },
      idempotencyKey: 'discord:m20:exception-cancel',
      now
    });

    expect(first.data).toMatchObject({ status: 'EXCEPTION', version: 7, fundAction: 'NONE' });
    expect(first.data.staffTaskId).toBeTruthy();
    expect(staffTaskStore.tasks).toHaveLength(1);
  });

  test('publishes the structured action contract and keeps OpenAPI mirrors identical', async () => {
    const [output, docs] = await Promise.all([
      readFile('outputs/P0开发交付包/02-API/openapi.yaml', 'utf8'),
      readFile('docs/P0开发交付包/02-API/openapi.yaml', 'utf8')
    ]);
    expect(output).toContain('OrderAvailableAction:');
    expect(output).toContain('availableActions:');
    expect(output).toContain('CUSTOMER_REQUEST_CANCELLATION');
    expect(output).toContain('PLAYER_REQUEST_COMPLETION');
    expect(output).toBe(docs);
  });
});

function keys(status: OrderRecord['status'], role: 'CUSTOMER' | 'PLAYER' | 'STAFF'): string[] {
  return buildOrderAvailableActions({ status, role }).map((action) => action.key);
}

function actor() {
  return {
    actorUserId: customerId,
    actorStaffId: null,
    actorLevel: null,
    actorSource: 'DISCORD_BOT' as const,
    clientId: 'discord-bot',
    guildId: '999999999999999999',
    discordUserId: '111111111111111111',
    interactionId: '777777777777777777',
    permissionsVersion: null
  };
}

function accounts() {
  return new InMemoryAccountStore({ bindings: [binding()], reservations: [] });
}

function binding(): AccountBindingRecord {
  return {
    userId: customerId,
    displayName: 'Customer',
    userStatus: 'ACTIVE',
    userVersion: 1,
    discordAccountId: '00000000-0000-0000-0000-000000002003',
    guildId: '999999999999999999',
    discordUserId: '111111111111111111',
    externalAccountId: '00000000-0000-0000-0000-000000002004',
    provider: 'mock-provider',
    externalUserId: 'mock-user',
    externalUserDisplay: 'mock-***',
    externalAccountStatus: 'ACTIVE',
    boundAt: now.toISOString()
  };
}

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: orderId,
    publicId: 'P-M20-ACTIONS',
    customerId,
    guildId: '999999999999999999',
    playerId: '00000000-0000-0000-0000-000000002005',
    status: 'DRAFT',
    version: 1,
    serviceCatalogId: null,
    catalogVersion: null,
    game: null,
    service: null,
    region: null,
    billingUnitMinutes: null,
    unitCount: null,
    customerUnitPriceMinor: null,
    playerUnitPayoutMinor: null,
    amountMinor: 0,
    playerEarningMinor: 0,
    currency: 'CAT',
    notes: null,
    channelSpec: {
      channelId: '222222222222222222',
      panelMessageId: '333333333333333333',
      voiceChannelId: null
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}
