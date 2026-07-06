import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAdminDirectoryStore } from '@blackcat/api/admin-directory';
import type { AuditSink, StaffDirectory } from '@blackcat/api/security';
import type { OrderRecord } from '@blackcat/api/orders';

const env = { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'token' };
const levels = new Map([
  ['111111111111111111', 'L1_SUPPORT'],
  ['444444444444444444', 'L1_SUPPORT'],
  ['222222222222222222', 'L2_SUPERVISOR'],
  ['333333333333333333', 'L3_OPERATIONS']
] as const);
const directory: StaffDirectory = { resolveByDiscord({ discordUserId }) {
  const level = levels.get(discordUserId);
  return level ? { staffId: `00000000-0000-0000-0000-${discordUserId.slice(-12)}`, userId: `10000000-0000-0000-0000-${discordUserId.slice(-12)}`, level, permissionsVersion: 1, status: 'ACTIVE' } : null;
} };

function headers(discordUserId: string, key = 'dashboard:admin:read') {
  return { authorization: 'Bearer token', 'x-client-source': 'DASHBOARD', 'x-actor-discord-user-id': discordUserId,
    'x-actor-guild-id': '999999999999999999', 'x-step-up': 'valid', 'idempotency-key': key };
}

function fixture(options: { auditSink?: AuditSink } = {}) {
  const store = new InMemoryAdminDirectoryStore({
    orders: [
      adminOrder({ id: '00000000-0000-0000-0000-000000001001', publicId: 'P-1001', status: 'ACCEPTED', customerId: '00000000-0000-0000-0000-000000002001', amountMinor: 12000, createdAt: '2026-07-18T01:00:00Z' }),
      adminOrder({ id: '00000000-0000-0000-0000-000000001002', publicId: 'P-1002', status: 'IN_SERVICE', customerId: '00000000-0000-0000-0000-000000002002', amountMinor: 24000, createdAt: '2026-07-18T02:00:00Z' })
    ],
    users: [
      { id: '00000000-0000-0000-0000-000000002001', displayName: '用户 A', status: 'ACTIVE', discordUserId: '700000000000000001', discordUsername: 'customer_a', externalAccountDisplay: 'mock-***-001', activeOrderId: '00000000-0000-0000-0000-000000001001', riskFlags: [], version: 1, createdAt: '2026-07-17T00:00:00Z', updatedAt: '2026-07-18T00:00:00Z' },
      { id: '00000000-0000-0000-0000-000000002002', displayName: '用户 B', status: 'ACTIVE', externalAccountDisplay: null, activeOrderId: '00000000-0000-0000-0000-000000001002', riskFlags: ['PAYMENT_ANOMALY'], version: 2, createdAt: '2026-07-18T00:00:00Z', updatedAt: '2026-07-18T00:00:00Z' }
    ],
    players: [{ playerId: '00000000-0000-0000-0000-000000003001', userId: '00000000-0000-0000-0000-000000002002', displayName: '陪玩 B', discordUserId: '700000000000000002', discordUsername: 'player_b', reviewStatus: 'ACTIVE', availability: 'AVAILABLE', discordPresence: 'ONLINE', gameTags: ['VALORANT'], serviceTags: ['FUN'], languageTags: ['CN'], gameTagDetails: [{ code: 'VALORANT', displayName: '瓦洛兰特' }], serviceTagDetails: [{ code: 'FUN', displayName: '娱乐陪玩' }], languageTagDetails: [{ code: 'CN', displayName: '中文' }], activeOrderId: '00000000-0000-0000-0000-000000001002', version: 3, createdAt: '2026-07-17T00:00:00Z', updatedAt: '2026-07-18T00:00:00Z' }],
    consumptions: [
      { id: '00000000-0000-0000-0000-000000004001', userId: '00000000-0000-0000-0000-000000002001', guildId: '999999999999999999', type: 'ORDER', sourceId: '00000000-0000-0000-0000-000000001001', amountMinor: 12000, currency: 'CAT', status: 'SUCCEEDED', occurredAt: '2026-07-18T03:00:00Z', reversalOf: null },
      { id: '00000000-0000-0000-0000-000000004002', userId: '00000000-0000-0000-0000-000000002001', guildId: '999999999999999999', type: 'GIFT', sourceId: '00000000-0000-0000-0000-000000006001', amountMinor: 5200, currency: 'CAT', status: 'SUCCEEDED', occurredAt: '2026-07-18T04:00:00Z', reversalOf: null },
      { id: '00000000-0000-0000-0000-000000004000', userId: '00000000-0000-0000-0000-000000002001', guildId: '999999999999999999', type: 'ADMIN_CORRECTION', sourceId: '00000000-0000-0000-0000-000000009001', amountMinor: -300, currency: 'CAT', status: 'REVERSED', occurredAt: '2026-07-18T02:30:00Z', reversalOf: null }
    ],
    gifts: [{ id: '00000000-0000-0000-0000-000000005001', giftCatalogVersionId: '00000000-0000-0000-0000-000000005101', code: 'ROCKET', name: '火箭', priceMinor: 5200, currency: 'CAT', status: 'ACTIVE', enabled: true, version: 1, broadcastTemplate: '{sender} 送出 {gift}', giftCategoryTagId: null, giftCategoryTagDetails: null, createdByStaffId: '00000000-0000-0000-0000-333333333333', createdAt: '2026-07-18T00:00:00Z', activatedAt: '2026-07-18T00:00:00Z', retiredAt: null, archivedAt: null }],
    giftRequests: [{ id: '00000000-0000-0000-0000-000000006001', publicId: 'G-1001', orderId: '00000000-0000-0000-0000-000000001001', orderPublicId: 'P-1001', orderStatus: 'ACCEPTED', orderParticipantId: null, giftCatalogVersionId: '00000000-0000-0000-0000-000000005101', senderId: '00000000-0000-0000-0000-000000002001', senderDisplayName: '用户 A', senderDiscordUserId: '700000000000000001', senderDiscordUsername: 'customer_a', receiverId: '00000000-0000-0000-0000-000000003001', receiverDisplayName: '陪玩 B', receiverDiscordUserId: '700000000000000002', receiverDiscordUsername: 'player_b', status: 'PENDING_REVIEW', rowVersion: 4, giftCode: 'ROCKET', giftName: '火箭', amountMinor: 5200, currency: 'CAT', broadcastTemplate: '{sender} 送出 {gift}', reservationId: '00000000-0000-0000-0000-000000006101', reservationStatus: 'ACTIVE', reservationExpiresAt: '2026-07-18T03:30:00Z', announcementStatus: 'NOT_QUEUED', verifiedByStaffId: null, verifiedAt: null, verificationNote: null, approvedByStaffId: null, approvedAt: null, capturedAt: null, announcedAt: null, broadcastChannelId: null, broadcastMessageId: null, rejectedReason: null, failureCode: null, expiresAt: '2026-07-18T03:30:00Z', withdrawnAt: null, createdAt: '2026-07-18T03:00:00Z', updatedAt: '2026-07-18T03:00:00Z' }],
    visibleOrderIdsByStaffId: {
      '00000000-0000-0000-0000-111111111111': ['00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000001002']
    },
    visibleGiftRequestIdsByStaffId: {
      '00000000-0000-0000-0000-111111111111': ['00000000-0000-0000-0000-000000006001']
    }
  });
  const server = buildApiServer({ env, security: { auditSink: options.auditSink, staffDirectory: directory, stepUpVerifier: { verify: ({ request }) => request.headers['x-step-up'] === 'valid' } }, adminDirectory: {
    store,
    customerScope: { canReadCustomer: async () => true }
  } });
  return { server, store };
}

describe('M4-US-03 admin directory API', () => {
  test('keeps admin gift contracts distinct from user-facing gift views', async () => {
    const [outputContract, docsContract, productionEntry] = await Promise.all([
      readFile('outputs/P0开发交付包/02-API/openapi.yaml', 'utf8'),
      readFile('docs/P0开发交付包/02-API/openapi.yaml', 'utf8'),
      readFile('apps/api/src/index.ts', 'utf8')
    ]);
    expect(docsContract).toBe(outputContract);
    expect(outputContract).toMatch(/operationId: getAdminGiftRequest[\s\S]*?'200':\n\s+\$ref: '#\/components\/responses\/AdminGiftRequestResponse'/);
    expect(outputContract).toMatch(/AdminGiftCatalogItem:[\s\S]*?required: \[id, giftCatalogVersionId, code, name, priceMinor, currency, status, enabled, version, broadcastTemplate/);
    expect(outputContract).toMatch(/GiftCatalogPageEnvelope:[\s\S]*?AdminGiftCatalogItem/);
    expect(outputContract).toMatch(/GiftRequestPageEnvelope:[\s\S]*?AdminGiftRequest/);
    expect(outputContract).toMatch(/operationId: getAdminOrder[\s\S]*?x-required-permissions: \[staff_task\.read\]\n\s+x-minimum-staff-level: L1_SUPPORT/);
    expect(outputContract).toMatch(/operationId: listAdminUsers[\s\S]*?x-required-permissions: \[user\.read\]\n\s+x-minimum-staff-level: L2_SUPERVISOR/);
    expect(outputContract).toMatch(/operationId: listAdminUserConsumptions[\s\S]*?x-minimum-staff-level: L2_SUPERVISOR/);
    expect(outputContract).toMatch(/AdminConsumptionMirrorType:\n\s+type: string\n\s+enum: \[ORDER, GIFT, REFUND_REVERSAL, ADMIN_CORRECTION\]/);
    expect(outputContract).toMatch(/AdminGiftRequest:[\s\S]*?required: \[id, publicId, orderId, orderPublicId[\s\S]*?rowVersion: \{\$ref: '#\/components\/schemas\/Version'\}/);
    expect(outputContract).toMatch(/GiftCatalogItemResponse:[\s\S]*?example: \{requestId: req_gift_catalog, data: \{id: [^,]+, code: [^,]+, name: [^,]+, priceMinor: \d+, currency: CAT, enabled: true, version: 1, broadcastTemplate: [^,]+, createdAt: '[^']+'\}\}/);
    expect(productionEntry).toContain('auditSink: new PostgresAuditSink({ client: databasePool })');
    expect(productionEntry).not.toContain('auditSink: new InMemoryAuditSink()');
  });

  test('paginates orders and supports status/query filters', async () => {
    const { server } = fixture();
    const first = await server.inject({ method: 'GET', url: '/api/v1/admin/orders?limit=1', headers: headers('111111111111111111') });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ data: { items: [{ publicId: 'P-1002' }], nextCursor: expect.any(String) } });
    const filtered = await server.inject({ method: 'GET', url: '/api/v1/admin/orders?status=ACCEPTED&query=1001', headers: headers('111111111111111111') });
    expect(filtered.json().data.items).toEqual([expect.objectContaining({ publicId: 'P-1001' })]);
    const invalid = await server.inject({ method: 'GET', url: '/api/v1/admin/orders?status=NOT_A_STATUS', headers: headers('111111111111111111') });
    expect(invalid.statusCode).toBe(400);
  });

  test('uses resource-bound keyset cursors across every admin directory list', async () => {
    const { server, store } = fixture();
    store.players.push({ playerId: '00000000-0000-0000-0000-000000003000', reviewStatus: 'ACTIVE', availability: 'AVAILABLE', discordPresence: 'OFFLINE', gameTags: [], serviceTags: [], activeOrderId: null, version: 1, createdAt: '2026-07-16T00:00:00Z' });
    store.gifts.push({ id: '00000000-0000-0000-0000-000000005000', code: 'OLDER', name: 'Older gift', priceMinor: 100, currency: 'CAT', enabled: true, version: 1, broadcastTemplate: '{sender} sent {gift}', createdAt: '2026-07-17T00:00:00Z' });
    store.giftRequests.push({ id: '00000000-0000-0000-0000-000000006000', publicId: 'G-1000', orderId: '00000000-0000-0000-0000-000000001001', senderId: '00000000-0000-0000-0000-000000002001', receiverId: '00000000-0000-0000-0000-000000003001', status: 'PENDING_REVIEW', rowVersion: 1, giftName: 'Older gift', amountMinor: 100, currency: 'CAT', announcementStatus: 'NOT_QUEUED', createdAt: '2026-07-17T03:00:00Z' });

    await expectStableSecondPage('/api/v1/admin/orders?limit=1', 'publicId', 'P-1002', 'P-1001', () => {
      store.orders.push(adminOrder({ id: '00000000-0000-0000-0000-000000001003', publicId: 'P-1003', createdAt: '2026-07-18T05:00:00Z' }));
    });
    await expectStableSecondPage('/api/v1/admin/users?limit=1', 'id', '00000000-0000-0000-0000-000000002002', '00000000-0000-0000-0000-000000002001', () => {
      store.users.push({ id: '00000000-0000-0000-0000-000000002999', displayName: 'New user', status: 'ACTIVE', externalAccountDisplay: null, activeOrderId: null, riskFlags: [], version: 1, createdAt: '2026-07-19T00:00:00Z' });
    });
    await expectStableSecondPage('/api/v1/admin/users/00000000-0000-0000-0000-000000002001/consumptions?limit=1', 'id', '00000000-0000-0000-0000-000000004002', '00000000-0000-0000-0000-000000004001', () => {
      store.consumptions.push({ id: '00000000-0000-0000-0000-000000004003', userId: '00000000-0000-0000-0000-000000002001', guildId: '999999999999999999', type: 'ORDER', sourceId: '00000000-0000-0000-0000-000000001003', amountMinor: 100, currency: 'CAT', status: 'SUCCEEDED', occurredAt: '2026-07-18T05:00:00Z', reversalOf: null });
    });
    await expectStableSecondPage('/api/v1/admin/players?limit=1', 'playerId', '00000000-0000-0000-0000-000000003001', '00000000-0000-0000-0000-000000003000', () => {
      store.players.push({ playerId: '00000000-0000-0000-0000-000000003999', reviewStatus: 'ACTIVE', availability: 'AVAILABLE', discordPresence: 'ONLINE', gameTags: [], serviceTags: [], activeOrderId: null, version: 1, createdAt: '2026-07-19T00:00:00Z' });
    });
    await expectStableSecondPage('/api/v1/admin/gift-catalog?limit=1', 'id', '00000000-0000-0000-0000-000000005001', '00000000-0000-0000-0000-000000005000', () => {
      store.gifts.push({ id: '00000000-0000-0000-0000-000000005999', code: 'NEWER', name: 'Newer gift', priceMinor: 100, currency: 'CAT', enabled: true, version: 1, broadcastTemplate: '{sender} sent {gift}', createdAt: '2026-07-18T05:00:00Z' });
    });
    await expectStableSecondPage('/api/v1/admin/gift-requests?limit=1', 'publicId', 'G-1001', 'G-1000', () => {
      store.giftRequests.push({ id: '00000000-0000-0000-0000-000000006999', publicId: 'G-1999', orderId: '00000000-0000-0000-0000-000000001003', senderId: '00000000-0000-0000-0000-000000002001', receiverId: '00000000-0000-0000-0000-000000003001', status: 'PENDING_REVIEW', rowVersion: 1, giftName: 'Newer gift', amountMinor: 100, currency: 'CAT', announcementStatus: 'NOT_QUEUED', createdAt: '2026-07-18T05:00:00Z' });
    });

    async function expectStableSecondPage(url: string, key: string, expectedFirst: string, expectedSecond: string, insertAhead: () => void) {
      const first = await server.inject({ method: 'GET', url, headers: headers('333333333333333333') });
      expect(first.statusCode).toBe(200);
      expect(first.json().data.items[0]?.[key]).toBe(expectedFirst);
      const nextCursor = first.json().data.nextCursor as string;
      expect(nextCursor).toEqual(expect.any(String));
      insertAhead();
      const second = await server.inject({ method: 'GET', url: `${url}&cursor=${encodeURIComponent(nextCursor)}`, headers: headers('333333333333333333') });
      expect(second.statusCode).toBe(200);
      expect(second.json().data.items[0]?.[key]).toBe(expectedSecond);
    }
  });

  test('rejects forged, malformed, and cross-resource cursors', async () => {
    const { server } = fixture();
    const first = await server.inject({ method: 'GET', url: '/api/v1/admin/orders?limit=1', headers: headers('333333333333333333') });
    const orderCursor = first.json().data.nextCursor as string;
    const forgedCursor = `${orderCursor.slice(0, -1)}${orderCursor.endsWith('A') ? 'B' : 'A'}`;

    for (const url of [
      `/api/v1/admin/orders?cursor=${encodeURIComponent(forgedCursor)}`,
      '/api/v1/admin/orders?cursor=not-a-cursor',
      `/api/v1/admin/users?cursor=${encodeURIComponent(orderCursor)}`
    ]) {
      const response = await server.inject({ method: 'GET', url, headers: headers('333333333333333333') });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
  });

  test('never accepts a non-staff bot actor on an admin order route', async () => {
    const { server } = fixture();
    const response = await server.inject({ method: 'GET', url: '/api/v1/admin/orders', headers: {
      authorization: 'Bearer token', 'x-client-source': 'DISCORD_BOT', 'x-actor-discord-user-id': '999999999999999998', 'x-actor-guild-id': '999999999999999999'
    } });
    expect(response.statusCode).toBe(403);
  });

  test('does not expose orders outside an L1 staff member\'s claimed task scope', async () => {
    const { server } = fixture();
    const response = await server.inject({ method: 'GET', url: '/api/v1/admin/orders', headers: headers('444444444444444444') });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toEqual([]);
  });

  test('returns redacted users and staff-scoped consumption without referral data', async () => {
    const { server } = fixture();
    const l1Denied = await server.inject({ method: 'GET', url: '/api/v1/admin/users/00000000-0000-0000-0000-000000002001', headers: headers('111111111111111111') });
    const user = await server.inject({ method: 'GET', url: '/api/v1/admin/users/00000000-0000-0000-0000-000000002001', headers: headers('222222222222222222') });
    const history = await server.inject({ method: 'GET', url: '/api/v1/admin/users/00000000-0000-0000-0000-000000002001/consumptions?type=ORDER', headers: headers('222222222222222222') });
    expect(l1Denied.statusCode).toBe(403);
    expect(user.statusCode).toBe(200);
    expect(history.statusCode).toBe(200);
    expect(history.json().data.userId).toBe('00000000-0000-0000-0000-000000002001');
    expect(history.json().data.items).toHaveLength(1);
    expect(history.json().data.items[0]).toMatchObject({ type: 'ORDER' });
    expect(`${user.body}${history.body}`).not.toMatch(/beneficiary|referral|rateBps|commission/i);
  });

  test('keeps admin corrections distinct and filterable in consumption mirrors', async () => {
    const { server } = fixture();
    const history = await server.inject({ method: 'GET', url: '/api/v1/admin/users/00000000-0000-0000-0000-000000002001/consumptions?type=ADMIN_CORRECTION', headers: headers('222222222222222222') });
    expect(history.statusCode).toBe(200);
    expect(history.json().data.items).toEqual([expect.objectContaining({ type: 'ADMIN_CORRECTION', amountMinor: -300 })]);
  });

  test('allows L2 player reads while L1 cannot open the player directory', async () => {
    const { server } = fixture();
    const denied = await server.inject({ method: 'GET', url: '/api/v1/admin/players', headers: headers('111111111111111111') });
    const allowed = await server.inject({ method: 'GET', url: '/api/v1/admin/players/00000000-0000-0000-0000-000000003001', headers: headers('222222222222222222') });
    const filtered = await server.inject({ method: 'GET', url: '/api/v1/admin/players?reviewStatus=PENDING_REVIEW', headers: headers('222222222222222222') });
    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ data: { playerId: '00000000-0000-0000-0000-000000003001', userId: '00000000-0000-0000-0000-000000002002', displayName: '陪玩 B', discordUserId: '700000000000000002', discordUsername: 'player_b', availability: 'AVAILABLE', gameTagDetails: [{ code: 'VALORANT', displayName: '瓦洛兰特' }], createdAt: '2026-07-17T00:00:00Z', updatedAt: '2026-07-18T00:00:00Z' } });
    expect(filtered.json().data.items).toEqual([]);
  });

  test('returns sufficient server facts for the user detail card', async () => {
    const { server } = fixture();
    const response = await server.inject({ method: 'GET', url: '/api/v1/admin/users/00000000-0000-0000-0000-000000002001', headers: headers('222222222222222222') });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { displayName: '用户 A', discordUserId: '700000000000000001', discordUsername: 'customer_a', status: 'ACTIVE', version: 1, createdAt: '2026-07-17T00:00:00Z', updatedAt: '2026-07-18T00:00:00Z' } });
  });

  test('lists gift operations for support and version-manages catalog only for stepped-up L3', async () => {
    const { server, store } = fixture();
    const requests = await server.inject({ method: 'GET', url: '/api/v1/admin/gift-requests', headers: headers('111111111111111111') });
    const requestDetail = await server.inject({ method: 'GET', url: '/api/v1/admin/gift-requests/00000000-0000-0000-0000-000000006001', headers: headers('111111111111111111') });
    const outOfScopeRequests = await server.inject({ method: 'GET', url: '/api/v1/admin/gift-requests', headers: headers('444444444444444444') });
    const l2Catalog = await server.inject({ method: 'GET', url: '/api/v1/admin/gift-catalog', headers: headers('222222222222222222') });
    const l2CatalogDetail = await server.inject({ method: 'GET', url: '/api/v1/admin/gift-catalog/00000000-0000-0000-0000-000000005001', headers: headers('222222222222222222') });
    const l2Denied = await server.inject({ method: 'POST', url: '/api/v1/admin/gift-catalog', headers: headers('222222222222222222', 'dashboard:gift:create:l2'), payload: { name: '花束', price: { amountMinor: 1800, currency: 'CAT' }, enabled: true, broadcastTemplate: '{sender} 送出 {gift}', reasonCode: 'INITIAL_VERSION' } });
    const created = await server.inject({ method: 'POST', url: '/api/v1/admin/gift-catalog', headers: headers('333333333333333333', 'dashboard:gift:create:l3'), payload: { name: '花束', price: { amountMinor: 1800, currency: 'CAT' }, enabled: true, broadcastTemplate: '{sender} 送出 {gift}', reasonCode: 'INITIAL_VERSION' } });
    const updated = await server.inject({ method: 'PATCH', url: '/api/v1/admin/gift-catalog/00000000-0000-0000-0000-000000005001', headers: headers('333333333333333333', 'dashboard:gift:update:l3'), payload: { expectedVersion: 1, action: 'DISABLE', reasonCode: 'TEMPORARILY_UNAVAILABLE' } });
    const stale = await server.inject({ method: 'PATCH', url: '/api/v1/admin/gift-catalog/00000000-0000-0000-0000-000000005001', headers: headers('333333333333333333', 'dashboard:gift:update:stale'), payload: { expectedVersion: 1, action: 'ENABLE', reasonCode: 'RESTOCKED' } });
    expect(requests.json().data.items).toEqual([expect.objectContaining({ rowVersion: 4 })]);
    expect(requestDetail.json()).toMatchObject({ data: { rowVersion: 4, orderPublicId: 'P-1001', giftCatalogVersionId: '00000000-0000-0000-0000-000000005101', senderDisplayName: '用户 A', senderDiscordUserId: '700000000000000001', receiverDisplayName: '陪玩 B', receiverDiscordUserId: '700000000000000002', reservationStatus: 'ACTIVE', expiresAt: '2026-07-18T03:30:00Z', updatedAt: '2026-07-18T03:00:00Z' } });
    expect(outOfScopeRequests.json().data.items).toEqual([]);
    expect(l2Catalog.json().data.items).toHaveLength(1);
    expect(l2CatalogDetail.statusCode).toBe(200);
    expect(l2CatalogDetail.json()).toMatchObject({ data: { giftCatalogVersionId: '00000000-0000-0000-0000-000000005101', status: 'ACTIVE', createdByStaffId: '00000000-0000-0000-0000-333333333333', activatedAt: '2026-07-18T00:00:00Z' } });
    expect(l2Denied.statusCode).toBe(403);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ data: { giftCatalogVersionId: expect.any(String), status: 'ACTIVE', createdByStaffId: '00000000-0000-0000-0000-333333333333', activatedAt: expect.any(String), retiredAt: null, archivedAt: null } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ data: { giftCatalogVersionId: expect.any(String), status: 'DRAFT', enabled: false, version: 2, createdByStaffId: '00000000-0000-0000-0000-333333333333', activatedAt: null, retiredAt: null, archivedAt: null } });
    expect(stale.statusCode).toBe(409);
    expect(store.gifts).toHaveLength(2);
  });

  test('rolls back every in-memory admin mutation when its success audit cannot be appended', async () => {
    const auditSink: AuditSink = { append: async () => { throw new Error('audit unavailable'); } };
    const { server, store } = fixture({ auditSink });

    const userStatus = await server.inject({ method: 'PUT', url: '/api/v1/admin/users/00000000-0000-0000-0000-000000002001/operational-status',
      headers: headers('333333333333333333', 'dashboard:user:audit-failure'), payload: { expectedVersion: 1, status: 'SUSPENDED', reasonCode: 'RISK_REVIEW', note: 'must roll back' } });
    const createdGift = await server.inject({ method: 'POST', url: '/api/v1/admin/gift-catalog',
      headers: headers('333333333333333333', 'dashboard:gift:create:audit-failure'), payload: { name: '花束', price: { amountMinor: 1800, currency: 'CAT' }, enabled: true, broadcastTemplate: '{sender} 送出 {gift}', reasonCode: 'INITIAL_VERSION' } });
    const updatedGift = await server.inject({ method: 'PATCH', url: '/api/v1/admin/gift-catalog/00000000-0000-0000-0000-000000005001',
      headers: headers('333333333333333333', 'dashboard:gift:update:audit-failure'), payload: { expectedVersion: 1, action: 'DISABLE', reasonCode: 'TEMPORARILY_UNAVAILABLE' } });

    for (const response of [userStatus, createdGift, updatedGift]) {
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: 'COMMIT_FAILED' } });
    }
    expect(store.users[0]).toMatchObject({ status: 'ACTIVE', version: 1 });
    expect(store.gifts).toEqual([expect.objectContaining({ id: '00000000-0000-0000-0000-000000005001', enabled: true, version: 1 })]);
  });

  test('requires stepped-up L3 and optimistic version for user status changes', async () => {
    const { server } = fixture();
    const denied = await server.inject({ method: 'PUT', url: '/api/v1/admin/users/00000000-0000-0000-0000-000000002001/operational-status', headers: headers('222222222222222222', 'dashboard:user:status:l2'), payload: { expectedVersion: 1, status: 'SUSPENDED', reasonCode: 'RISK_REVIEW', note: '人工复核' } });
    const changed = await server.inject({ method: 'PUT', url: '/api/v1/admin/users/00000000-0000-0000-0000-000000002001/operational-status', headers: headers('333333333333333333', 'dashboard:user:status:l3'), payload: { expectedVersion: 1, status: 'SUSPENDED', reasonCode: 'RISK_REVIEW', note: '人工复核' } });
    expect(denied.statusCode).toBe(403);
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ data: { status: 'SUSPENDED', version: 2 } });
  });
});

function adminOrder(overrides: Partial<OrderRecord>): OrderRecord {
  const createdAt = overrides.createdAt ?? '2026-07-18T01:00:00Z';
  return {
    id: '00000000-0000-0000-0000-000000001001', publicId: 'P-1001', customerId: '00000000-0000-0000-0000-000000002001',
    playerId: '00000000-0000-0000-0000-000000003001', status: 'ACCEPTED', version: 1, orderType: 'IMMEDIATE',
    serviceCatalogId: null, catalogVersion: null, unitCount: 2, billingUnitMinutes: 60, customerUnitPriceMinor: 6000,
    playerUnitPayoutMinor: 4000, currency: 'CAT', amountMinor: 12000, playerEarningMinor: 8000, game: 'VALORANT',
    service: '娱乐陪玩', region: 'NA', language: '中文', scheduledStartAt: null, notes: null,
    channelSpec: { channelId: null, panelMessageId: null, voiceChannelId: null }, automationState: 'RUNNING', automationVersion: 1,
    automationScope: null, automationPausedByStaffId: null, automationStaffTaskId: null, automationReasonCode: null,
    automationPausedAt: null, automationResumedAt: null, automationExpiresAt: null, customerReadyAt: null, playerReadyAt: null,
    readyDeadlineAt: null, startedAt: null, completionRequestedAt: null, completedAt: null, cancelledAt: null,
    createdAt, updatedAt: createdAt, ...overrides
  };
}
