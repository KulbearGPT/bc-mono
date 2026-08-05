import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import {
  InMemoryDashboardAuthStore,
  type DashboardAuthStore,
  type DiscordOAuthProvider
} from '@blackcat/api/dashboard-auth';
import {
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
  type StaffAccount,
  type StaffDirectory
} from '@blackcat/api/security';
import { InMemoryAccountStore } from '@blackcat/api/accounts';
import {
  InMemoryOrderStore,
  type ExternalTransactionMirrorRecord,
  type OrderRecord
} from '@blackcat/api/orders';
import { TestWalletFunding } from './support/wallet-fixture';
import {
  InMemoryGiftStore,
  type GiftRequestRecord,
  type GiftReservationRecord,
  type GiftStaffTaskRecord
} from '@blackcat/api/gifts';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};
const initialNow = new Date('2026-07-18T15:00:00.000Z');
const guildId = '999999999999999999';
const discordUserId = '444444444444444444';
const staffId = '00000000-0000-0000-0000-000000004404';
const staffUserId = '00000000-0000-0000-0000-000000004405';

type Session = { sessionToken: string; csrfToken: string };
type RecoveryAwareMfaState = {
  data: {
    method: 'TOTP';
    enrolled: true;
    verifiedAt: string;
    recoveryCodes?: string[];
  };
};
const oauth: DiscordOAuthProvider = {
  getAuthorizationUrl: ({ state }) => `https://discord.com/oauth2/authorize?state=${state}`,
  exchangeCode: async () => ({ discordUserId })
};

function staff(level: StaffAccount['level']): StaffAccount {
  return { staffId, userId: staffUserId, level, permissionsVersion: 1, status: 'ACTIVE' };
}

function directoryFor(level: StaffAccount['level']): StaffDirectory {
  return { resolveByDiscord: () => staff(level) };
}

function mutableClock(start = initialNow) {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set(value: Date | string) {
      current = new Date(value);
    },
    advance(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds);
    }
  };
}

function sessionHeaders(session: Session, idempotencyKey?: string) {
  return {
    cookie: `p0_session=${session.sessionToken}; p0_csrf=${session.csrfToken}`,
    'x-csrf-token': session.csrfToken,
    'x-client-source': 'DASHBOARD',
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
  };
}

async function createSession(store: DashboardAuthStore, account: StaffAccount, now: Date): Promise<Session> {
  return await store.createSession(account, now);
}

function authFixture(level: StaffAccount['level'] = 'L3_OPERATIONS') {
  const clock = mutableClock();
  const authStore = new InMemoryDashboardAuthStore();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const directory = directoryFor(level);
  const server = buildApiServer({
    env,
    security: {
      auditSink: new InMemoryAuditSink(),
      idempotencyStore,
      staffDirectory: directory,
      dashboardSessions: authStore
    },
    dashboardAuth: {
      store: authStore,
      oauth,
      staffDirectory: directory,
      guildId,
      dashboardUrl: 'https://dashboard.example.test',
      secureCookies: false,
      now: clock.now
    }
  });
  return { server, authStore, clock, idempotencyStore };
}

async function beginEnrollment(fixture: ReturnType<typeof authFixture>, session: Session, key: string) {
  return fixture.server.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/mfa/enrollment',
    headers: sessionHeaders(session, key),
    payload: { method: 'TOTP' }
  });
}

function totpSecret(provisioningUri: string): string {
  const secret = new URL(provisioningUri).searchParams.get('secret');
  if (!secret) throw new Error('TOTP provisioning URI did not contain a secret.');
  return secret;
}

function generateTotp(base32Secret: string, at: Date, periodSeconds = 30, digits = 6): string {
  const counter = Math.floor(at.getTime() / 1000 / periodSeconds);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(base32Secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function decodeBase32(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = value.toUpperCase().replace(/=+$/u, '').replace(/\s+/gu, '');
  let bits = '';
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error(`Invalid base32 character: ${character}`);
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

async function enrollTotp(
  fixture: ReturnType<typeof authFixture>,
  session: Session,
  keyPrefix: string
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const enrollment = await beginEnrollment(fixture, session, `${keyPrefix}:enroll`);
  expect(enrollment.statusCode).toBe(201);
  const enrollmentData = enrollment.json().data as {
    enrollmentId: string;
    provisioningUri: string;
    expiresAt: string;
  };
  expect(enrollmentData).toMatchObject({ enrollmentId: expect.any(String), provisioningUri: expect.stringMatching(/^otpauth:\/\/totp\//u) });
  expect(new Date(enrollmentData.expiresAt).getTime()).toBeGreaterThan(fixture.clock.now().getTime());
  const secret = totpSecret(enrollmentData.provisioningUri);
  const activation = await fixture.server.inject({
    method: 'POST',
    url: `/api/v1/admin/auth/mfa/enrollment/${enrollmentData.enrollmentId}/verify`,
    headers: sessionHeaders(session, `${keyPrefix}:verify`),
    payload: { proof: generateTotp(secret, fixture.clock.now()) }
  });
  expect(activation.statusCode).toBe(200);
  expect(activation.json()).toMatchObject({ data: { method: 'TOTP', enrolled: true, verifiedAt: fixture.clock.now().toISOString() } });
  const capabilities = await fixture.server.inject({
    method: 'GET',
    url: '/api/v1/admin/me/capabilities',
    headers: sessionHeaders(session)
  });
  expect(capabilities.json()).toMatchObject({ data: { mfa: { enrolled: true, method: 'TOTP' } } });
  return { secret, recoveryCodes: (activation.json() as RecoveryAwareMfaState).data.recoveryCodes ?? [] };
}

async function completeTotpStepUp(
  fixture: ReturnType<typeof authFixture>,
  session: Session,
  secret: string,
  keyPrefix: string
) {
  const begun = await fixture.server.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/step-up',
    headers: sessionHeaders(session, `${keyPrefix}:begin`),
    payload: { purpose: 'HIGH_RISK_BUSINESS_ACTION' }
  });
  expect(begun.statusCode).toBe(201);
  const challenge = begun.json().data as { challengeId: string; method: string; expiresAt: string };
  expect(challenge).toMatchObject({ challengeId: expect.any(String), method: 'TOTP', expiresAt: expect.any(String) });
  const completed = await fixture.server.inject({
    method: 'POST',
    url: `/api/v1/admin/auth/step-up/${challenge.challengeId}/complete`,
    headers: sessionHeaders(session, `${keyPrefix}:complete`),
    payload: { method: 'TOTP', proof: generateTotp(secret, fixture.clock.now()) }
  });
  expect(completed.statusCode).toBe(200);
  return { challenge, completed };
}

describe('M4-US-04 MFA enrollment and session step-up API', () => {
  test('limits an unenrolled L3 session to MFA onboarding until enrollment succeeds', async () => {
    const fixture = authFixture();
    const session = await createSession(fixture.authStore, staff('L3_OPERATIONS'), fixture.clock.now());
    const before = await fixture.server.inject({ method: 'GET', url: '/api/v1/admin/me/capabilities', headers: sessionHeaders(session) });
    expect(before.json()).toMatchObject({ data: { level: 'L1_SUPPORT', mfa: { enrolled: false, method: null } } });
    expect(before.json().data.permissions).not.toContain('catalog.manage');

    await enrollTotp(fixture, session, 'm4:mfa:elevation');
    const after = await fixture.server.inject({ method: 'GET', url: '/api/v1/admin/me/capabilities', headers: sessionHeaders(session) });
    expect(after.json()).toMatchObject({ data: { level: 'L3_OPERATIONS', mfa: { enrolled: true, method: 'TOTP' } } });
    expect(after.json().data.permissions).toContain('catalog.manage');
  });

  test('enrolls TOTP only after a valid proof and keeps an invalid attempt inactive', async () => {
    const fixture = authFixture();
    const session = await createSession(fixture.authStore, staff('L3_OPERATIONS'), fixture.clock.now());
    const enrollment = await beginEnrollment(fixture, session, 'm4:mfa:invalid-then-valid');
    expect(enrollment.statusCode).toBe(201);
    const data = enrollment.json().data as { enrollmentId: string; provisioningUri: string };
    const secret = totpSecret(data.provisioningUri);
    const validProof = generateTotp(secret, fixture.clock.now());
    const invalidProof = validProof === '000000' ? '000001' : '000000';

    const invalid = await fixture.server.inject({
      method: 'POST',
      url: `/api/v1/admin/auth/mfa/enrollment/${data.enrollmentId}/verify`,
      headers: sessionHeaders(session, 'm4:mfa:invalid-proof'),
      payload: { proof: invalidProof }
    });
    expect([400, 409]).toContain(invalid.statusCode);
    expect(invalid.json()).toMatchObject({ error: { code: 'MFA_PROOF_INVALID' } });

    const valid = await fixture.server.inject({
      method: 'POST',
      url: `/api/v1/admin/auth/mfa/enrollment/${data.enrollmentId}/verify`,
      headers: sessionHeaders(session, 'm4:mfa:valid-proof'),
      payload: { proof: validProof }
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ data: { method: 'TOTP', enrolled: true, verifiedAt: initialNow.toISOString() } });
  });

  test('completes a challenge once, replays the same idempotent response, and exposes a 15-minute validUntil', async () => {
    const fixture = authFixture();
    const session = await createSession(fixture.authStore, staff('L3_OPERATIONS'), fixture.clock.now());
    const { secret } = await enrollTotp(fixture, session, 'm4:step-up:single-use');
    const begun = await fixture.server.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/step-up',
      headers: sessionHeaders(session, 'm4:step-up:begin'),
      payload: { purpose: 'HIGH_RISK_BUSINESS_ACTION' }
    });
    expect(begun.statusCode).toBe(201);
    const challengeId = begun.json().data.challengeId as string;
    const request = {
      method: 'POST' as const,
      url: `/api/v1/admin/auth/step-up/${challengeId}/complete`,
      headers: sessionHeaders(session, 'm4:step-up:complete'),
      payload: { method: 'TOTP', proof: generateTotp(secret, fixture.clock.now()) }
    };
    const completed = await fixture.server.inject(request);
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      data: {
        verifiedAt: initialNow.toISOString(),
        validUntil: new Date(initialNow.getTime() + 15 * 60_000).toISOString()
      }
    });

    const idempotentReplay = await fixture.server.inject(request);
    expect(idempotentReplay.statusCode).toBe(200);
    expect(idempotentReplay.headers['x-idempotency-replayed']).toBe('true');
    expect(idempotentReplay.json()).toEqual(completed.json());

    const secondConsumption = await fixture.server.inject({
      ...request,
      headers: sessionHeaders(session, 'm4:step-up:second-consumption')
    });
    expect(secondConsumption.statusCode).toBe(409);
    expect(secondConsumption.json()).toMatchObject({ error: { code: 'STEP_UP_CHALLENGE_CONSUMED' } });

    const capabilities = await fixture.server.inject({
      method: 'GET',
      url: '/api/v1/admin/me/capabilities',
      headers: sessionHeaders(session)
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      data: { stepUp: { requiredForSensitiveActions: true, validUntil: completed.json().data.validUntil } }
    });
    const storedRecords = Array.from(((fixture.idempotencyStore as unknown as { records: Map<string, unknown> }).records).values());
    expect(JSON.stringify(storedRecords)).not.toContain(generateTotp(secret, fixture.clock.now()));
    expect(JSON.stringify(storedRecords)).not.toContain('recoveryCodes');
  });

  test('rejects an expired challenge and clears capabilities after the 15-minute window', async () => {
    const fixture = authFixture();
    const session = await createSession(fixture.authStore, staff('L3_OPERATIONS'), fixture.clock.now());
    const { secret } = await enrollTotp(fixture, session, 'm4:step-up:expiry');
    const begun = await fixture.server.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/step-up',
      headers: sessionHeaders(session, 'm4:step-up:expiry:begin'),
      payload: { purpose: 'HIGH_RISK_BUSINESS_ACTION' }
    });
    expect(begun.statusCode).toBe(201);
    const challenge = begun.json().data as { challengeId: string; expiresAt: string };
    fixture.clock.set(new Date(new Date(challenge.expiresAt).getTime() + 1));
    const expired = await fixture.server.inject({
      method: 'POST',
      url: `/api/v1/admin/auth/step-up/${challenge.challengeId}/complete`,
      headers: sessionHeaders(session, 'm4:step-up:expiry:complete'),
      payload: { method: 'TOTP', proof: generateTotp(secret, fixture.clock.now()) }
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toMatchObject({ error: { code: 'STEP_UP_CHALLENGE_EXPIRED' } });

    fixture.clock.set(initialNow);
    const active = await completeTotpStepUp(fixture, session, secret, 'm4:step-up:window');
    fixture.clock.set(new Date(new Date(active.completed.json().data.validUntil).getTime() + 1));
    const capabilities = await fixture.server.inject({
      method: 'GET',
      url: '/api/v1/admin/me/capabilities',
      headers: sessionHeaders(session)
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().data.stepUp.validUntil).toBeNull();
  });

  test('consumes a recovery code only once when recovery codes are supported', async () => {
    const fixture = authFixture();
    const session = await createSession(fixture.authStore, staff('L3_OPERATIONS'), fixture.clock.now());
    const { recoveryCodes } = await enrollTotp(fixture, session, 'm4:recovery');
    if (recoveryCodes.length === 0) return;

    const begin = async (key: string) => fixture.server.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/step-up',
      headers: sessionHeaders(session, key),
      payload: { purpose: 'HIGH_RISK_BUSINESS_ACTION' }
    });
    const firstChallenge = await begin('m4:recovery:first:begin');
    expect(firstChallenge.statusCode).toBe(201);
    const first = await fixture.server.inject({
      method: 'POST',
      url: `/api/v1/admin/auth/step-up/${firstChallenge.json().data.challengeId}/complete`,
      headers: sessionHeaders(session, 'm4:recovery:first:complete'),
      payload: { method: 'RECOVERY_CODE', proof: recoveryCodes[0] }
    });
    expect(first.statusCode).toBe(200);

    const secondChallenge = await begin('m4:recovery:second:begin');
    expect(secondChallenge.statusCode).toBe(201);
    const reused = await fixture.server.inject({
      method: 'POST',
      url: `/api/v1/admin/auth/step-up/${secondChallenge.json().data.challengeId}/complete`,
      headers: sessionHeaders(session, 'm4:recovery:second:complete'),
      payload: { method: 'RECOVERY_CODE', proof: recoveryCodes[0] }
    });
    expect([400, 409]).toContain(reused.statusCode);
    expect(reused.json()).toMatchObject({ error: { code: 'MFA_PROOF_INVALID' } });
  });

  test('locks a step-up challenge after five invalid proofs', async () => {
    const fixture = authFixture();
    const session = await createSession(fixture.authStore, staff('L3_OPERATIONS'), fixture.clock.now());
    const { secret } = await enrollTotp(fixture, session, 'm4:attempt-limit:enrollment');
    const validProof = generateTotp(secret, fixture.clock.now());
    const invalidProof = validProof === '000000' ? '000001' : '000000';
    const begun = await fixture.server.inject({
      method: 'POST', url: '/api/v1/admin/auth/step-up',
      headers: sessionHeaders(session, 'm4:attempt-limit:begin'),
      payload: { purpose: 'HIGH_RISK_BUSINESS_ACTION' }
    });
    const challengeId = begun.json().data.challengeId as string;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await fixture.server.inject({
        method: 'POST', url: `/api/v1/admin/auth/step-up/${challengeId}/complete`,
        headers: sessionHeaders(session, `m4:attempt-limit:${attempt}`),
        payload: { method: 'TOTP', proof: invalidProof }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe(attempt === 5 ? 'MFA_ATTEMPTS_EXCEEDED' : 'MFA_PROOF_INVALID');
    }
    const locked = await fixture.server.inject({
      method: 'POST', url: `/api/v1/admin/auth/step-up/${challengeId}/complete`,
      headers: sessionHeaders(session, 'm4:attempt-limit:locked'),
      payload: { method: 'TOTP', proof: invalidProof }
    });
    expect(locked.json()).toMatchObject({ error: { code: 'STEP_UP_CHALLENGE_CONSUMED' } });
  });
});

const giftRequestId = '00000000-0000-0000-0000-000000004410';
const giftTaskId = '00000000-0000-0000-0000-000000004411';
const giftOrderId = '00000000-0000-0000-0000-000000004412';
const refundOrderId = '00000000-0000-0000-0000-000000004420';
const customerId = '00000000-0000-0000-0000-000000004421';

class PolicyOrderStore extends InMemoryOrderStore {
  readonly approvalRequests: Array<Record<string, unknown>> = [];
  readonly refunds: Array<{
    id: string;
    orderId: string;
    sourceTransactionId: string;
    amountMinor: number;
    currency: string;
    status: string;
    idempotencyKey: string;
  }> = [];
}

function policyOrder(id: string, amountMinor: number, status: OrderRecord['status']): OrderRecord {
  return {
    id,
    publicId: id === giftOrderId ? 'P-GIFT-4404' : 'P-REFUND-4404',
    customerId,
    playerId: '00000000-0000-0000-0000-000000004422',
    status,
    version: id === giftOrderId ? 7 : 9,
    serviceCatalogId: null,
    catalogVersion: null,
    game: 'VALORANT',
    service: 'ENTERTAINMENT',
    region: 'NA',
    billingUnitMinutes: 60,
    unitCount: 2,
    customerUnitPriceMinor: Math.floor(amountMinor / 2),
    playerUnitPayoutMinor: 4200,
    amountMinor,
    playerEarningMinor: 8400,
    currency: 'CAT',
    notes: null,
    channelSpec: {
      channelId: '900000000000000003',
      panelMessageId: '900000000000000004',
      voiceChannelId: '900000000000000005'
    },
    createdAt: initialNow.toISOString(),
    updatedAt: initialNow.toISOString()
  };
}

function verifiedGiftRequest(priceMinor = 200100): GiftRequestRecord {
  return {
    id: giftRequestId,
    publicId: 'G-4404',
    orderId: giftOrderId,
    giftCatalogVersionId: '00000000-0000-0000-0000-000000004413',
    senderId: customerId,
    receiverId: '00000000-0000-0000-0000-000000004422',
    status: 'PENDING_REVIEW',
    version: 2,
    giftCodeSnapshot: 'STAR',
    giftNameSnapshot: '星光礼盒',
    priceMinor,
    currency: 'CAT',
    broadcastTemplateSnapshot: '{sender_name} 送出 {gift_name}',
    verifiedByStaffId: staffId,
    verifiedAt: initialNow.toISOString(),
    verificationNote: 'Confirmed by customer.',
    verificationPayloadHash: 'refreshed-by-fixture',
    executionCredentialExpiresAt: new Date(initialNow.getTime() + 15 * 60_000).toISOString(),
    approvedByStaffId: null,
    approvedAt: null,
    rejectedReason: null,
    expiresAt: new Date(initialNow.getTime() + 30 * 60_000).toISOString(),
    createdAt: initialNow.toISOString(),
    updatedAt: initialNow.toISOString()
  };
}

function giftReservation(priceMinor = 200100): GiftReservationRecord {
  return {
    id: '00000000-0000-0000-0000-000000004414',
    userId: customerId,
    sourceType: 'GIFT',
    orderId: null,
    giftRequestId,
    mode: 'LOCAL_RESERVATION',
    provider: 'mock-provider',
    providerHoldRef: null,
    amountMinor: priceMinor,
    currency: 'CAT',
    status: 'ACTIVE',
    version: 2,
    idempotencyKey: 'gift:m4-us-04',
    expiresAt: new Date(initialNow.getTime() + 30 * 60_000).toISOString(),
    activatedAt: initialNow.toISOString(),
    settledAt: null,
    createdAt: initialNow.toISOString(),
    updatedAt: initialNow.toISOString()
  };
}

function giftTask(priceMinor = 200100): GiftStaffTaskRecord {
  return {
    id: giftTaskId,
    publicId: 'T-GIFT-4404',
    type: 'GIFT_REVIEW',
    reasonCode: 'GIFT_REQUESTED',
    status: 'VERIFIED',
    version: 2,
    orderId: giftOrderId,
    giftRequestId,
    claimedBy: staffId,
    voiceChannelId: '900000000000000005',
    contextSnapshot: {
      orderId: giftOrderId,
      orderPublicId: 'P-GIFT-4404',
      channelId: '900000000000000003',
      voiceChannelId: '900000000000000005',
      senderId: customerId,
      receiverId: '00000000-0000-0000-0000-000000004422',
      giftCode: 'STAR',
      giftName: '星光礼盒',
      priceMinor,
      currency: 'CAT',
      reservationId: giftReservation(priceMinor).id
    },
    createdAt: initialNow.toISOString(),
    updatedAt: initialNow.toISOString()
  };
}

function refundChargeMirror(providerRef: string | null): ExternalTransactionMirrorRecord {
  return {
    id: '00000000-0000-0000-0000-000000004423',
    provider: 'mock-provider',
    type: 'ORDER_CHARGE',
    userId: customerId,
    orderId: refundOrderId,
    fundReservationId: '00000000-0000-0000-0000-000000004424',
    externalRef: providerRef,
    idempotencyKey: 'provider:m4-us-04:order-charge',
    amountMinor: 200000,
    currency: 'CAT',
    status: 'SUCCEEDED',
    createdAt: initialNow.toISOString()
  };
}

function policyFixture() {
  const clock = mutableClock();
  const authStore = new InMemoryDashboardAuthStore();
  const directory = directoryFor('L3_OPERATIONS');
  const walletFunding = new TestWalletFunding();
  const orderStore = new PolicyOrderStore({
    orders: [policyOrder(giftOrderId, 12000, 'IN_SERVICE'), policyOrder(refundOrderId, 200000, 'COMPLETED')],
    externalTransactions: [refundChargeMirror('internal-wallet-order-charge')]
  });
  const giftStore = new InMemoryGiftStore({
    catalog: [],
    requests: [verifiedGiftRequest()],
    reservations: [giftReservation()],
    staffTasks: [giftTask()],
    externalUserIds: { [customerId]: 'mock-user-ok' }
  });
  giftStore.refreshVerificationHash(giftRequestId, initialNow);
  const server = buildApiServer({
    env,
    security: {
      auditSink: new InMemoryAuditSink(),
      idempotencyStore: new InMemoryIdempotencyStore(),
      staffDirectory: directory,
      dashboardSessions: authStore
    },
    dashboardAuth: {
      store: authStore,
      oauth,
      staffDirectory: directory,
      guildId,
      dashboardUrl: 'https://dashboard.example.test',
      secureCookies: false,
      now: clock.now
    },
    gift: {
      store: giftStore,
      orderStore,
      accountStore: new InMemoryAccountStore({}),
      walletFunding,
      broadcastChannelId: '900000000000000020',
      now: clock.now
    },
    adminOrders: {
      orderStore,
      now: clock.now
    }
  });
  return { server, authStore, clock, orderStore, giftStore };
}

describe('M4-US-04 amount policy integration', () => {
  test('AT-GFT-005 leaves money and broadcast untouched until the same staff member reaches L3 and steps up', async () => {
    const fixture = policyFixture();
    const l2 = await createSession(fixture.authStore, staff('L2_SUPERVISOR'), fixture.clock.now());
    const pending = await fixture.server.inject({
      method: 'POST',
      url: `/api/v1/admin/gift-requests/${giftRequestId}/approve`,
      headers: sessionHeaders(l2, 'm4:gift:l2:pending'),
      payload: { expectedVersion: 2, reason: 'Verified high-value gift.' }
    });
    expect(pending.statusCode).toBe(202);
    expect(pending.json()).toMatchObject({ data: { code: 'APPROVAL_PENDING', requiredLevel: 'L3_OPERATIONS', actionExecuted: false } });
    expect(fixture.giftStore.captures).toHaveLength(0);
    expect(fixture.giftStore.broadcasts).toHaveLength(0);

    const l3 = await createSession(fixture.authStore, staff('L3_OPERATIONS'), fixture.clock.now());
    const { secret } = await enrollTotp(fixture, l3, 'm4:gift:l3:mfa');
    await completeTotpStepUp(fixture, l3, secret, 'm4:gift:l3:step-up');
    const executed = await fixture.server.inject({
      method: 'POST',
      url: `/api/v1/admin/gift-requests/${giftRequestId}/approve`,
      headers: sessionHeaders(l3, 'm4:gift:l3:execute'),
      payload: { expectedVersion: 3, reason: 'Same staff member completed L3 step-up.' }
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ data: { giftRequestId, status: 'CAPTURED', reservation: { status: 'CAPTURED' } } });
    expect(fixture.giftStore.captures).toHaveLength(1);
  });

  test('AT-RBAC-004 and AT-RBAC-005 enforce 50000/50100 refund boundaries without premature wallet writes', async () => {
    const fixture = policyFixture();
    const l2 = await createSession(fixture.authStore, staff('L2_SUPERVISOR'), fixture.clock.now());
    const direct = await fixture.server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${refundOrderId}/refund`,
      headers: sessionHeaders(l2, 'm4:refund:l2:50000'),
      payload: {
        expectedVersion: 9,
        amount: { amountMinor: 50000, currency: 'CAT' },
        reasonCode: 'USER_REQUEST',
        evidenceNote: 'L2 boundary refund.',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });
    expect(direct.statusCode).toBe(200);
    expect(direct.json()).toMatchObject({ data: { amountMinor: 50000, status: 'SUCCEEDED', orderStatus: 'COMPLETED' } });

    const pendingKey = 'm4:refund:l2:50100';
    const pending = await fixture.server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${refundOrderId}/refund`,
      headers: sessionHeaders(l2, pendingKey),
      payload: {
        expectedVersion: 9,
        amount: { amountMinor: 50100, currency: 'CAT' },
        reasonCode: 'USER_REQUEST',
        evidenceNote: 'L2 must request L3 execution.',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });
    expect(pending.statusCode).toBe(202);
    expect(pending.json()).toMatchObject({ data: { code: 'APPROVAL_PENDING', requiredLevel: 'L3_OPERATIONS', actionExecuted: false } });
    expect(fixture.orderStore.orders.find(({ id }) => id === refundOrderId)).toMatchObject({ status: 'COMPLETED', version: 9 });
    expect(fixture.orderStore.approvalRequests).toHaveLength(1);

    const l3 = await createSession(fixture.authStore, staff('L3_OPERATIONS'), fixture.clock.now());
    const { secret } = await enrollTotp(fixture, l3, 'm4:refund:l3:mfa');
    await completeTotpStepUp(fixture, l3, secret, 'm4:refund:l3:step-up');
    const executed = await fixture.server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${refundOrderId}/refund`,
      headers: sessionHeaders(l3, 'm4:refund:l3:execute'),
      payload: {
        expectedVersion: 9,
        amount: { amountMinor: 50100, currency: 'CAT' },
        reasonCode: 'USER_REQUEST',
        evidenceNote: 'Same staff member completed L3 step-up.',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ data: { amountMinor: 50100, status: 'SUCCEEDED', orderStatus: 'COMPLETED' } });

    const exceedsRemaining = await fixture.server.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${refundOrderId}/refund`,
      headers: sessionHeaders(l3, 'm4:refund:l3:cumulative-overflow'),
      payload: {
        expectedVersion: 9,
        amount: { amountMinor: 100000, currency: 'CAT' },
        reasonCode: 'USER_REQUEST',
        evidenceNote: 'This would exceed the remaining refundable amount.',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });
    expect(exceedsRemaining.statusCode).toBe(422);
    expect(exceedsRemaining.json()).toMatchObject({ error: { code: 'BUSINESS_RULE_VIOLATION' } });
    expect(fixture.orderStore.refunds).toHaveLength(2);
  });
});
