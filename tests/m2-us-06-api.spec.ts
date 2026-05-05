import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildApiServer } from '@blackcat/api/server';
import {
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
  type StaffDirectory
} from '@blackcat/api/security';
import { MockFundingAdapter } from '@blackcat/api/payment-adapter';
import { InMemoryOrderStore, type ExternalTransactionMirrorRecord, type OrderRecord } from '@blackcat/api/orders';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};
const now = new Date('2026-07-18T06:00:00.000Z');
const guildId = '999999999999999999';
const orderId = '00000000-0000-0000-0000-00000000b601';
const customerId = '00000000-0000-0000-0000-00000000a601';
const staffL1DiscordUserId = '222222222222222221';
const staffL2DiscordUserId = '222222222222222222';
const staffL3DiscordUserId = '222222222222222223';
const staffL4DiscordUserId = '222222222222222224';

const staffDirectory: StaffDirectory = {
  resolveByDiscord({ discordUserId, guildId: inputGuildId }) {
    if (inputGuildId !== guildId) {
      return null;
    }
    if (discordUserId === staffL1DiscordUserId) {
      return {
        staffId: '00000000-0000-0000-0000-000000000611',
        userId: '00000000-0000-0000-0000-000000000611',
        level: 'L1_SUPPORT',
        permissionsVersion: 1,
        status: 'ACTIVE'
      };
    }
    if (discordUserId === staffL2DiscordUserId) {
      return {
        staffId: '00000000-0000-0000-0000-000000000622',
        userId: '00000000-0000-0000-0000-000000000622',
        level: 'L2_SUPERVISOR',
        permissionsVersion: 1,
        status: 'ACTIVE'
      };
    }
    if (discordUserId === staffL3DiscordUserId) {
      return {
        staffId: '00000000-0000-0000-0000-000000000633',
        userId: '00000000-0000-0000-0000-000000000633',
        level: 'L3_OPERATIONS',
        permissionsVersion: 1,
        status: 'ACTIVE'
      };
    }
    if (discordUserId === staffL4DiscordUserId) {
      return {
        staffId: '00000000-0000-0000-0000-000000000644',
        userId: '00000000-0000-0000-0000-000000000644',
        level: 'L4_ADMIN_OWNER',
        permissionsVersion: 1,
        status: 'ACTIVE'
      };
    }
    return null;
  }
};

describe('M2-US-06 admin refund action API', () => {
  test('runtime API entrypoint wires the Postgres admin action store', async () => {
    const source = await readFile('apps/api/src/index.ts', 'utf8');

    expect(source).toContain("import { PostgresAdminOrderActionStore } from './admin-order-actions.js';");
    expect(source).toContain('const adminOrderActionStore = new PostgresAdminOrderActionStore({ pool: databasePool });');
    expect(source).toMatch(/adminOrders:\s*{\s*orderStore: adminOrderActionStore,/s);
  });

  test('refundOrder rejects L1 support before any provider refund is created', async () => {
    const { server, fundingAdapter } = buildRefundServer();

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/refund`,
      headers: dashboardHeaders(staffL1DiscordUserId, { 'idempotency-key': 'dashboard:refund:l1-denied' }),
      payload: {
        expectedVersion: 9,
        amount: { amountMinor: 5000, currency: 'CNY' },
        reasonCode: 'USER_REQUEST',
        evidenceNote: '客服记录：用户确认需要退款。',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });

    expect(response.statusCode).toBe(403);
    expect(() => fundingAdapter.getTransaction({ lookupType: 'IDEMPOTENCY_KEY', lookupValue: 'dashboard:refund:l1-denied:provider' })).toThrow();
  });

  test('refundOrder lets L2 execute a refund at or below 50000 minor and leaves the completed order intact', async () => {
    const { server, orderStore } = buildRefundServer();

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/refund`,
      headers: dashboardHeaders(staffL2DiscordUserId, { 'idempotency-key': 'dashboard:refund:l2-small' }),
      payload: {
        expectedVersion: 9,
        amount: { amountMinor: 50000, currency: 'CNY' },
        reasonCode: 'USER_REQUEST',
        evidenceNote: '客服记录：已完成订单售后部分退款。',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        orderId,
        amountMinor: 50000,
        currency: 'CNY',
        status: 'SUCCEEDED',
        orderStatus: 'COMPLETED'
      }
    });
    expect(response.json().data.refundTransactionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(orderStore.orders[0]).toMatchObject({ status: 'COMPLETED', version: 9 });
  });

  test('refundOrder routes an L2 refund above 50000 minor into approval without calling the provider', async () => {
    const { server, orderStore, fundingAdapter } = buildRefundServer();

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/refund`,
      headers: dashboardHeaders(staffL2DiscordUserId, { 'idempotency-key': 'dashboard:refund:l2-approval' }),
      payload: {
        expectedVersion: 9,
        amount: { amountMinor: 50001, currency: 'CNY' },
        reasonCode: 'USER_REQUEST',
        evidenceNote: '退款金额超过 L2 直接执行额度，提交审批。',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      data: {
        code: 'APPROVAL_PENDING',
        requiredLevel: 'L3_OPERATIONS',
        actionExecuted: false
      }
    });
    expect(response.json().data.approvalRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(orderStore.approvalRequests).toEqual([
      expect.objectContaining({
        action: 'REFUND_EXECUTE',
        targetId: orderId,
        requiredLevel: 'L3_OPERATIONS',
        amountMinor: 50001
      })
    ]);
    expect(() => fundingAdapter.getTransaction({ lookupType: 'IDEMPOTENCY_KEY', lookupValue: 'dashboard:refund:l2-approval:provider' })).toThrow();
  });

  test('refundOrder requires recent step-up before L3 executes a sensitive refund', async () => {
    const { server } = buildRefundServer();

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/refund`,
      headers: dashboardHeaders(staffL3DiscordUserId, { 'idempotency-key': 'dashboard:refund:l3-no-stepup' }),
      payload: {
        expectedVersion: 9,
        amount: { amountMinor: 50001, currency: 'CNY' },
        reasonCode: 'USER_REQUEST',
        evidenceNote: 'L3 直接执行前应完成近期二次验证。',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });

    expect(response.statusCode).toBe(428);
    expect(response.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
  });

  test('refundOrder lets L3 execute above the L2 limit after recent MFA step-up', async () => {
    const { server } = buildRefundServer({
      stepUpVerifier: { verify: () => true }
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/refund`,
      headers: dashboardHeaders(staffL3DiscordUserId, { 'idempotency-key': 'dashboard:refund:l3-stepup-ok' }),
      payload: {
        expectedVersion: 9,
        amount: { amountMinor: 50001, currency: 'CNY' },
        reasonCode: 'USER_REQUEST',
        evidenceNote: 'L3 已完成近期 MFA step-up。',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { amountMinor: 50001, status: 'SUCCEEDED' } });
  });

  test.each([
    { actor: staffL3DiscordUserId, amountMinor: 499999, expectedStatus: 200, expectedLevel: undefined },
    { actor: staffL3DiscordUserId, amountMinor: 500000, expectedStatus: 202, expectedLevel: 'L4_ADMIN_OWNER' },
    { actor: staffL4DiscordUserId, amountMinor: 500000, expectedStatus: 200, expectedLevel: undefined }
  ])('routes the high-value boundary for $actor at $amountMinor', async ({ actor, amountMinor, expectedStatus, expectedLevel }) => {
    const order = completedOrder({ amountMinor: 600000 });
    const { server } = buildRefundServer({ order, stepUpVerifier: { verify: () => true } });
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/refund`,
      headers: dashboardHeaders(actor, { 'idempotency-key': `dashboard:refund:boundary:${actor}:${amountMinor}` }),
      payload: {
        expectedVersion: 9,
        amount: { amountMinor, currency: 'CNY' },
        reasonCode: 'USER_REQUEST',
        evidenceNote: '高额退款等级边界测试。',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });

    expect(response.statusCode).toBe(expectedStatus);
    if (expectedLevel) {
      expect(response.json()).toMatchObject({ data: { requiredLevel: expectedLevel, actionExecuted: false } });
    } else {
      expect(response.json()).toMatchObject({ data: { amountMinor, status: 'SUCCEEDED' } });
    }
  });

  test('refundOrder resolves an UNKNOWN provider response through idempotent transaction lookup before committing', async () => {
    let lookupCount = 0;
    const { server } = buildRefundServer({
      fundingAdapterFactory(provider) {
        return {
          createRefund(input) {
            const committed = provider.createRefund(input);
            return { ...committed, status: 'UNKNOWN' as const };
          },
          getTransaction(input) {
            lookupCount += 1;
            return provider.getTransaction(input);
          }
        };
      }
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/refund`,
      headers: dashboardHeaders(staffL2DiscordUserId, { 'idempotency-key': 'dashboard:refund:unknown-recovery' }),
      payload: {
        expectedVersion: 9,
        amount: { amountMinor: 5000, currency: 'CNY' },
        reasonCode: 'USER_REQUEST',
        evidenceNote: 'Provider 首次返回 UNKNOWN，按幂等键恢复查询。',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { amountMinor: 5000, status: 'SUCCEEDED' } });
    expect(lookupCount).toBe(1);
  });

  test('resolveOrder atomically records a resolution and adjustments without overwriting original charge facts', async () => {
    const { server, orderStore } = buildRefundServer({
      order: completedOrder({ status: 'EXCEPTION', version: 11 })
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/resolve`,
      headers: dashboardHeaders(staffL2DiscordUserId, { 'idempotency-key': 'dashboard:resolve:partial-interruption' }),
      payload: {
        expectedVersion: 11,
        targetStatus: 'CANCELLED',
        reasonCode: 'SERVICE_INTERRUPTED',
        refund: { amountMinor: 50000, currency: 'CNY' },
        playerEarning: { amountMinor: 20000, currency: 'CNY' },
        evidenceNote: '客服核对：服务中断，部分退款并保留部分陪玩收益。',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        orderId,
        targetStatus: 'CANCELLED',
        refundAmountMinor: 50000,
        playerEarningMinor: 20000,
        currency: 'CNY',
        approvalRequestId: null
      }
    });
    expect(orderStore.orders[0]).toMatchObject({
      status: 'CANCELLED',
      version: 12,
      amountMinor: 120000,
      playerEarningMinor: 84000
    });
    expect(orderStore.resolutions).toEqual([
      expect.objectContaining({
        orderId,
        targetStatus: 'CANCELLED',
        refundAmountMinor: 50000,
        playerEarningMinor: 20000,
        reasonCode: 'SERVICE_INTERRUPTED'
      })
    ]);
    expect(orderStore.playerEarningAdjustments).toEqual([
      expect.objectContaining({
        orderId,
        type: 'REVERSAL_DEBIT',
        amountMinor: 64000,
        reason: 'SERVICE_INTERRUPTED'
      })
    ]);
    expect(orderStore.commissionAdjustments).toEqual([
      expect.objectContaining({
        orderId,
        type: 'REVERSAL_DEBIT',
        amountMinor: 50000,
        reason: 'SERVICE_INTERRUPTED'
      })
    ]);
  });

  test('resolveOrder rejects refund or earning amounts above the immutable order snapshot before provider work', async () => {
    const { server, orderStore, fundingAdapter } = buildRefundServer({
      order: completedOrder({ status: 'EXCEPTION', version: 11 })
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/resolve`,
      headers: dashboardHeaders(staffL2DiscordUserId, { 'idempotency-key': 'dashboard:resolve:out-of-range' }),
      payload: {
        expectedVersion: 11,
        targetStatus: 'CANCELLED',
        reasonCode: 'SERVICE_INTERRUPTED',
        refund: { amountMinor: 120001, currency: 'CNY' },
        playerEarning: { amountMinor: 84001, currency: 'CNY' },
        evidenceNote: '非法金额不得产生部分写入。',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });

    expect(response.statusCode).toBe(422);
    expect(orderStore.orders[0]).toMatchObject({ status: 'EXCEPTION', version: 11 });
    expect(orderStore.resolutions).toEqual([]);
    expect(orderStore.playerEarningAdjustments).toEqual([]);
    expect(orderStore.commissionAdjustments).toEqual([]);
    expect(() => fundingAdapter.getTransaction({ lookupType: 'IDEMPOTENCY_KEY', lookupValue: 'dashboard:resolve:out-of-range:provider' })).toThrow();
  });

  test('resolveOrder leaves local facts untouched when the provider refund fails', async () => {
    const { server, orderStore } = buildRefundServer({
      order: completedOrder({ status: 'EXCEPTION', version: 11 }),
      fundingAdapter: {
        createRefund() {
          throw new Error('provider timeout');
        }
      }
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/resolve`,
      headers: dashboardHeaders(staffL2DiscordUserId, { 'idempotency-key': 'dashboard:resolve:provider-failure' }),
      payload: {
        expectedVersion: 11,
        targetStatus: 'CANCELLED',
        reasonCode: 'SERVICE_INTERRUPTED',
        refund: { amountMinor: 50000, currency: 'CNY' },
        playerEarning: { amountMinor: 20000, currency: 'CNY' },
        evidenceNote: 'Provider 失败时不得提交本地结案。',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });

    expect(response.statusCode).toBe(503);
    expect(orderStore.orders[0]).toMatchObject({ status: 'EXCEPTION', version: 11 });
    expect(orderStore.resolutions).toEqual([]);
    expect(orderStore.playerEarningAdjustments).toEqual([]);
    expect(orderStore.commissionAdjustments).toEqual([]);
  });

  test('refundOrder rejects an unsupported database reason code before provider work', async () => {
    const { server, fundingAdapter } = buildRefundServer();
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/refund`,
      headers: dashboardHeaders(staffL2DiscordUserId, { 'idempotency-key': 'dashboard:refund:invalid-reason' }),
      payload: {
        expectedVersion: 9,
        amount: { amountMinor: 5000, currency: 'CNY' },
        reasonCode: 'UNSUPPORTED_REASON',
        evidenceNote: '不受支持的原因不得到达 Provider。',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(() => fundingAdapter.getTransaction({ lookupType: 'IDEMPOTENCY_KEY', lookupValue: 'dashboard:refund:invalid-reason:provider' })).toThrow();
  });

  test('reassignOrder lets L2 replace the assigned player with an auditable reason', async () => {
    const { server, orderStore } = buildRefundServer({
      order: completedOrder({ status: 'ACCEPTED', version: 5 })
    });
    const nextPlayerId = '00000000-0000-0000-0000-00000000a699';

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/reassign`,
      headers: dashboardHeaders(staffL2DiscordUserId, { 'idempotency-key': 'dashboard:reassign:l2' }),
      payload: {
        expectedVersion: 5,
        playerId: nextPlayerId,
        reasonCode: 'PLAYER_NO_SHOW',
        note: '原陪玩未到，客服转派。'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        id: orderId,
        status: 'ACCEPTED',
        version: 6
      }
    });
    expect(orderStore.orders[0]).toMatchObject({
      playerId: nextPlayerId,
      version: 6,
      status: 'ACCEPTED'
    });
    expect(orderStore.events).toEqual([
      expect.objectContaining({
        eventType: 'DETAILS_UPDATED',
        payload: expect.objectContaining({
          reasonCode: 'PLAYER_NO_SHOW',
          previousPlayerId: '00000000-0000-0000-0000-00000000a602',
          nextPlayerId
        })
      })
    ]);
  });

  test('reassignOrder rejects an in-service reassignment so a replacement cannot inherit active billing and readiness', async () => {
    const { server, orderStore } = buildRefundServer({
      order: completedOrder({ status: 'IN_SERVICE', version: 5 })
    });
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${orderId}/reassign`,
      headers: dashboardHeaders(staffL2DiscordUserId, { 'idempotency-key': 'dashboard:reassign:in-service' }),
      payload: {
        expectedVersion: 5,
        playerId: '00000000-0000-0000-0000-00000000a699',
        reasonCode: 'SERVICE_INTERRUPTED',
        note: '服务中订单必须先进入异常并停止原服务。'
      }
    });

    expect(response.statusCode).toBe(422);
    expect(orderStore.orders[0]).toMatchObject({ status: 'IN_SERVICE', version: 5 });
    expect(orderStore.events).toHaveLength(0);
  });
});

function buildRefundServer(input: {
  order?: OrderRecord;
  fundingAdapter?: Pick<MockFundingAdapter, 'createRefund'>;
  fundingAdapterFactory?: (provider: MockFundingAdapter) => Pick<MockFundingAdapter, 'createRefund' | 'getTransaction'>;
  stepUpVerifier?: { verify(input: { actor: { actorStaffId: string | null } }): boolean };
} = {}) {
  const auditSink = new InMemoryAuditSink();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const provider = new MockFundingAdapter({ now });
  const configuredOrder = input.order ?? completedOrder();
  const original = provider.createReservationDebit({
    idempotencyKey: 'provider:order-charge:m2-us-06',
    fundReservationId: '00000000-0000-0000-0000-00000000f601',
    fundReservationVersion: 1,
    externalUserId: 'mock-user-ok',
    amount: { amountMinor: configuredOrder.amountMinor, currency: 'CNY' },
    businessSource: 'ORDER',
    businessReference: orderId
  });
  const orderStore = new AdminActionMemoryOrderStore({
    orders: [configuredOrder],
    externalTransactions: [orderChargeMirror(original.providerRef, configuredOrder.amountMinor)]
  });
  const server = buildApiServer({
    env,
    security: { auditSink, idempotencyStore, staffDirectory, stepUpVerifier: input.stepUpVerifier },
    adminOrders: {
      orderStore,
      fundingAdapter: input.fundingAdapterFactory?.(provider) ?? input.fundingAdapter ?? provider,
      providerKey: 'mock-provider',
      now: () => now
    }
  });

  return { server, orderStore, fundingAdapter: provider };
}

class AdminActionMemoryOrderStore extends InMemoryOrderStore {
  readonly approvalRequests: Array<Record<string, unknown>> = [];
  readonly resolutions: Array<Record<string, unknown>> = [];
  readonly playerEarningAdjustments: Array<Record<string, unknown>> = [];
  readonly commissionAdjustments: Array<Record<string, unknown>> = [];
}

function completedOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: orderId,
    publicId: 'P-M2-REFUND',
    customerId,
    playerId: '00000000-0000-0000-0000-00000000a602',
    status: 'COMPLETED',
    version: 9,
    serviceCatalogId: '00000000-0000-0000-0000-00000000c601',
    catalogVersion: 3,
    game: 'VALORANT',
    service: 'ENTERTAINMENT',
    region: 'NA',
    billingUnitMinutes: 60,
    unitCount: 2,
    customerUnitPriceMinor: 60000,
    playerUnitPayoutMinor: 42000,
    amountMinor: 120000,
    playerEarningMinor: 84000,
    currency: 'CNY',
    notes: '已完成订单售后',
    channelSpec: {
      channelId: '120000000000000001',
      panelMessageId: '120000000000000002',
      voiceChannelId: '120000000000000003'
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}

function orderChargeMirror(externalRef: string | null, amountMinor = 120000): ExternalTransactionMirrorRecord {
  return {
    id: '00000000-0000-0000-0000-00000000e601',
    provider: 'mock-provider',
    type: 'ORDER_CHARGE',
    userId: customerId,
    orderId,
    fundReservationId: '00000000-0000-0000-0000-00000000f601',
    externalRef,
    idempotencyKey: 'provider:order-charge:m2-us-06',
    amountMinor,
    currency: 'CNY',
    status: 'SUCCEEDED',
    createdAt: now.toISOString()
  };
}

function dashboardHeaders(discordUserId: string, extra: Record<string, string> = {}) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DASHBOARD',
    'x-actor-discord-user-id': discordUserId,
    'x-actor-guild-id': guildId,
    'x-discord-interaction-id': '777777777777777777',
    ...extra
  };
}
