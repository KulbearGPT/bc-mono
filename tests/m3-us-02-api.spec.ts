import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore, type StaffAccount, type StaffDirectory } from '@blackcat/api/security';
import { InMemoryAccountStore } from '@blackcat/api/accounts';
import { InMemoryOrderStore, type OrderRecord } from '@blackcat/api/orders';
import { MockFundingAdapter } from '@blackcat/api/payment-adapter';
import { InMemoryGiftStore, registerGiftRoutes, type GiftRequestRecord, type GiftReservationRecord, type GiftStaffTaskRecord } from '@blackcat/api/gifts';

const now = new Date('2026-07-18T13:00:00.000Z');
const giftRequestId = '00000000-0000-0000-0000-000000003410';
const taskId = '00000000-0000-0000-0000-000000003411';
const staffId = '00000000-0000-0000-0000-000000003412';
const discordId = '900000000000000012';

function staff(level: StaffAccount['level']): StaffAccount {
  return { staffId, userId: staffId, level, status: 'ACTIVE', permissionsVersion: 1 };
}

function headers(key: string) {
  return { authorization: 'Bearer valid-bot-token', 'x-client-source': 'DASHBOARD',
    'x-actor-discord-user-id': discordId, 'x-actor-guild-id': '900000000000000001',
    'x-discord-interaction-id': '900000000000000013', 'idempotency-key': key };
}

function request(priceMinor = 200000, overrides: Partial<GiftRequestRecord> = {}): GiftRequestRecord {
  return { id: giftRequestId, publicId: 'G-3410', orderId: order().id,
    giftCatalogVersionId: '00000000-0000-0000-0000-000000003413', senderId: order().customerId,
    receiverId: order().playerId!, status: 'PENDING_REVIEW', version: 1, giftCodeSnapshot: 'STAR',
    giftNameSnapshot: '星光礼盒', priceMinor, currency: 'CNY', broadcastTemplateSnapshot: '{sender_name}',
    verifiedByStaffId: null, verifiedAt: null, verificationNote: null, verificationPayloadHash: null,
    executionCredentialExpiresAt: null, approvedByStaffId: null, approvedAt: null, rejectedReason: null,
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(), ...overrides };
}

function reservation(priceMinor = 200000): GiftReservationRecord {
  return { id: '00000000-0000-0000-0000-000000003414', userId: order().customerId, sourceType: 'GIFT', orderId: null,
    giftRequestId, mode: 'LOCAL_RESERVATION_FALLBACK', provider: 'mock-provider', providerHoldRef: null,
    amountMinor: priceMinor, currency: 'CNY', status: 'ACTIVE', version: 2, idempotencyKey: 'gift:3410',
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), activatedAt: now.toISOString(), settledAt: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

function task(status: GiftStaffTaskRecord['status'] = 'CLAIMED'): GiftStaffTaskRecord {
  return { id: taskId, publicId: 'T-GIFT-3411', type: 'GIFT_REVIEW', reasonCode: 'GIFT_REQUESTED', status, version: 2,
    orderId: order().id, giftRequestId, claimedBy: staffId, voiceChannelId: order().channelSpec.voiceChannelId,
    contextSnapshot: { orderId: order().id, orderPublicId: order().publicId, channelId: order().channelSpec.channelId,
      voiceChannelId: order().channelSpec.voiceChannelId, senderId: order().customerId, receiverId: order().playerId!,
      giftCode: 'STAR', giftName: '星光礼盒', priceMinor: 200000, currency: 'CNY', reservationId: reservation().id },
    createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

function order(): OrderRecord {
  return { id: '00000000-0000-0000-0000-000000003401', publicId: 'P-3401', customerId: '00000000-0000-0000-0000-000000003402',
    playerId: '00000000-0000-0000-0000-000000003403', status: 'IN_SERVICE', version: 7, serviceCatalogId: null,
    catalogVersion: null, game: 'VALORANT', service: 'ENTERTAINMENT', region: 'NA', billingUnitMinutes: 60, unitCount: 2,
    customerUnitPriceMinor: 6000, playerUnitPayoutMinor: 4200, amountMinor: 12000, playerEarningMinor: 8400,
    currency: 'CNY', notes: null, channelSpec: { channelId: '900000000000000003', panelMessageId: '900000000000000004', voiceChannelId: '900000000000000005' },
    createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

function fixture(level: StaffAccount['level'], priceMinor = 200000, input: { stepUp?: boolean; claimedBy?: string; verified?: boolean } = {}) {
  let effectiveLevel = level;
  let stepUp = input.stepUp ?? false;
  const verified = input.verified ?? false;
  const req = request(priceMinor, verified ? {
    status: 'PENDING_REVIEW', version: 2, verifiedByStaffId: staffId, verifiedAt: now.toISOString(), verificationNote: 'Confirmed by DM',
    verificationPayloadHash: 'will-be-replaced', executionCredentialExpiresAt: new Date(now.getTime() + 15 * 60_000).toISOString()
  } : {});
  const store = new InMemoryGiftStore({ catalog: [], requests: [req], reservations: [reservation(priceMinor)],
    staffTasks: [{ ...task(verified ? 'VERIFIED' : 'CLAIMED'), claimedBy: input.claimedBy ?? staffId }],
    externalUserIds: { [order().customerId]: 'mock-user-ok' } });
  if (verified) store.refreshVerificationHash(giftRequestId, now);
  const directory: StaffDirectory = { resolveByDiscord: () => staff(effectiveLevel) };
  const adapter = new MockFundingAdapter({ now, reservations: [{ fundReservationId: reservation().id, version: 2 }] });
  const server = buildApiServer({ env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    security: { auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore(), staffDirectory: directory,
      stepUpVerifier: { verify: () => stepUp } } });
  registerGiftRoutes(server, { store, orderStore: new InMemoryOrderStore({ orders: [order()] }),
    accountStore: new InMemoryAccountStore({}), fundingAdapter: adapter, providerKey: 'mock-provider',
    broadcastChannelId: '900000000000000020', now: () => now });
  return { server, store, adapter, setLevel: (value: StaffAccount['level']) => { effectiveLevel = value; }, setStepUp: (value: boolean) => { stepUp = value; } };
}

describe('M3-US-02 gift review and authorization', () => {
  test('lets L1 verify only a task claimed by the same staff member', async () => {
    const { server, store } = fixture('L1_SUPPORT');
    const response = await server.inject({ method: 'POST', url: `/api/v1/admin/staff-tasks/${taskId}/verify`, headers: headers('gift:verify:3410'),
      payload: { expectedVersion: 2, verificationMethod: 'DIRECT_MESSAGE', notes: 'Confirmed gift, target, amount and intent.' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { status: 'VERIFIED', giftRequestId, executionCredential: { payloadHash: expect.any(String), expiresAt: expect.any(String) } } });
    expect(store.requests[0]).toMatchObject({ status: 'PENDING_REVIEW', version: 2, verifiedByStaffId: staffId, verificationPayloadHash: expect.any(String) });

    const denied = fixture('L1_SUPPORT', 200000, { claimedBy: '00000000-0000-0000-0000-00000000ffff' });
    const deniedResponse = await denied.server.inject({ method: 'POST', url: `/api/v1/admin/staff-tasks/${taskId}/verify`, headers: headers('gift:verify:other'),
      payload: { expectedVersion: 2, verificationMethod: 'DIRECT_MESSAGE', notes: 'Confirmed.' } });
    expect(deniedResponse.statusCode).toBe(409);
  });

  test('blocks L1 from approval and directly authorizes L2 at exactly 200000', async () => {
    const l1 = fixture('L1_SUPPORT', 200000, { verified: true });
    const forbidden = await l1.server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${giftRequestId}/approve`, headers: headers('gift:approve:l1-denied'),
      payload: { expectedVersion: 2, reason: 'Verified request' } });
    expect(forbidden.statusCode).toBe(403);

    const l2 = fixture('L2_SUPERVISOR', 200000, { verified: true });
    const approved = await l2.server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${giftRequestId}/approve`, headers: headers('gift:approve:l2-boundary'),
      payload: { expectedVersion: 2, reason: 'Verified request' } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ data: { status: 'CAPTURED', giftRequestId,
      reservation: { status: 'CAPTURED' }, chargeOutcome: { status: 'SUCCEEDED' } } });
    expect(l2.store.captures).toHaveLength(1);
  });

  test('routes 200100 from L2 to an immutable L3 approval without capture', async () => {
    const { server, store, setLevel, setStepUp } = fixture('L2_SUPERVISOR', 200100, { verified: true });
    const response = await server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${giftRequestId}/approve`, headers: headers('gift:approve:l3-route'),
      payload: { expectedVersion: 2, reason: 'Verified high-value request' } });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ data: { code: 'APPROVAL_PENDING', actionExecuted: false, requiredLevel: 'L3_OPERATIONS', approvalRequestId: expect.any(String) } });
    expect(store.approvals).toEqual([expect.objectContaining({ action: 'GIFT_APPROVE', requiredLevel: 'L3_OPERATIONS', payloadHash: expect.any(String) })]);
    expect(store.captures).toHaveLength(0);
    setLevel('L3_OPERATIONS');
    setStepUp(true);
    const continued = await server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${giftRequestId}/approve`, headers: headers('gift:approve:l3-continue'),
      payload: { expectedVersion: 3, reason: 'Reviewed escalation and approved.' } });
    expect(continued.statusCode).toBe(200);
    expect(continued.json()).toMatchObject({ data: { status: 'CAPTURED', giftRequestId } });
    expect(store.captures).toHaveLength(1);
  });

  test('requires recent step-up for L3 direct authorization and rejects stale payload credentials', async () => {
    const noStepUp = fixture('L3_OPERATIONS', 200100, { verified: true, stepUp: false });
    const blocked = await noStepUp.server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${giftRequestId}/approve`, headers: headers('gift:approve:l3-no-step'),
      payload: { expectedVersion: 2, reason: 'Verified' } });
    expect(blocked.statusCode).toBe(428);

    const stale = fixture('L3_OPERATIONS', 200100, { verified: true, stepUp: true });
    stale.store.requests[0]!.priceMinor = 200200;
    const rejected = await stale.server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${giftRequestId}/approve`, headers: headers('gift:approve:stale'),
      payload: { expectedVersion: 2, reason: 'Verified' } });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ error: { code: 'EXECUTION_CREDENTIAL_STALE' } });
  });

  test('routes 500000 to L4 and allows L4 direct authorization only with step-up', async () => {
    const l3 = fixture('L3_OPERATIONS', 500000, { verified: true, stepUp: true });
    const escalated = await l3.server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${giftRequestId}/approve`, headers: headers('gift:approve:l4-route'),
      payload: { expectedVersion: 2, reason: 'Verified very high-value request.' } });
    expect(escalated.statusCode).toBe(202);
    expect(escalated.json()).toMatchObject({ data: { requiredLevel: 'L4_ADMIN_OWNER', actionExecuted: false } });

    const l4 = fixture('L4_ADMIN_OWNER', 500000, { verified: true, stepUp: true });
    const approved = await l4.server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${giftRequestId}/approve`, headers: headers('gift:approve:l4-direct'),
      payload: { expectedVersion: 2, reason: 'Owner verified and authorized.' } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ data: { status: 'CAPTURED', giftRequestId } });
    expect(l4.store.captures).toHaveLength(1);
  });

  test('rejects a verified request with a reason and never captures or broadcasts', async () => {
    const { server, store } = fixture('L2_SUPERVISOR', 200000, { verified: true });
    const response = await server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${giftRequestId}/reject`, headers: headers('gift:reject:3410'),
      payload: { expectedVersion: 2, reason: 'Customer changed their mind.' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { status: 'REJECTED', reason: 'Customer changed their mind.' } });
    expect(store.captures).toHaveLength(0);
    expect(store.broadcasts).toHaveLength(0);
    expect(store.reservations[0]).toMatchObject({ status: 'RELEASED', version: 3 });
  });

  test('resumes the same provider debit after an approved database commit temporarily fails', async () => {
    const { server, store, adapter } = fixture('L2_SUPERVISOR', 200000, { verified: true });
    const commit = store.commitCapture.bind(store);
    let failOnce = true;
    store.commitCapture = (input) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('temporary database failure');
      }
      return commit(input);
    };
    const first = await server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${giftRequestId}/approve`,
      headers: headers('gift:approve:db-failure'), payload: { expectedVersion: 2, reason: 'Verified request' } });
    expect(first.statusCode).toBe(500);

    const retry = await server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${giftRequestId}/approve`,
      headers: headers('gift:approve:db-recovery'), payload: { expectedVersion: 2, reason: 'Verified request' } });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ data: { status: 'CAPTURED', giftRequestId } });
    expect(store.captures).toHaveLength(1);
    expect(adapter.getProviderBalance({ externalUserId: 'mock-user-ok' }).providerBalanceMinor).toBe(800000);
  });
});
