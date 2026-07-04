import { createHmac } from 'node:crypto';
import { buildApiServer } from '../../../apps/api/src/server.ts';
import { InMemoryDashboardAuthStore, type DiscordOAuthProvider } from '../../../apps/api/src/dashboard-auth.ts';
import { InMemoryDashboardMetricsStore } from '../../../apps/api/src/dashboard-metrics.ts';
import { InMemoryAuditSink, registerSecureReadRoute, registerSecureWriteRoute, type StaffDirectory } from '../../../apps/api/src/security.ts';

const host = '127.0.0.1';
const port = 3000;
const dashboardUrl = 'http://127.0.0.1:5173';
const guildId = '999999999999999999';
const staff = {
  staffId: '00000000-0000-0000-0000-000000000111',
  userId: '00000000-0000-0000-0000-000000000011',
  level: 'L1_SUPPORT' as const,
  permissionsVersion: 1,
  status: 'ACTIVE' as const
};
const supervisor = {
  staffId: '00000000-0000-0000-0000-000000000112',
  userId: '00000000-0000-0000-0000-000000000012',
  level: 'L2_SUPERVISOR' as const,
  permissionsVersion: 1,
  status: 'ACTIVE' as const
};
const operator = {
  staffId: '00000000-0000-0000-0000-000000000113',
  userId: '00000000-0000-0000-0000-000000000013',
  level: 'L3_OPERATIONS' as const,
  permissionsVersion: 1,
  status: 'ACTIVE' as const
};
const owner = {
  staffId: '00000000-0000-0000-0000-000000000114',
  userId: '00000000-0000-0000-0000-000000000014',
  level: 'L4_ADMIN_OWNER' as const,
  permissionsVersion: 1,
  status: 'ACTIVE' as const
};
const mfaCandidate = {
  staffId: '00000000-0000-0000-0000-000000000115',
  userId: '00000000-0000-0000-0000-000000000015',
  level: 'L1_SUPPORT' as const,
  permissionsVersion: 1,
  status: 'ACTIVE' as const
};
const actors = { l1: staff, l2: supervisor, l3: operator, l4: owner, mfa: mfaCandidate } as const;

const authStore = new InMemoryDashboardAuthStore();
const auditSink = new InMemoryAuditSink();
const faults = new Set<string>();
let clockOffsetMs = 0;
let nextOAuthIsNonStaff = false;
const fixtureNow = () => new Date(Date.now() + clockOffsetMs);
type Job = { id: string; type: string; status: 'FAILED' | 'COMPLETED'; attempts: number; lastError: string | null; runAfter: string; version: number };
const initialJob: Job = { id: '00000000-0000-0000-0000-000000000401', type: 'PANEL_SYNC', status: 'FAILED', attempts: 1, lastError: 'Discord timeout', runAfter: '2026-08-05T00:00:00.000Z', version: 1 };
const nonRetryableJob: Job = { id: '00000000-0000-0000-0000-000000000402', type: 'SETTLEMENT_EXECUTION', status: 'FAILED', attempts: 1, lastError: 'External transfer is manual', runAfter: '2026-08-05T00:00:00.000Z', version: 1 };
const jobs = new Map<string, Job>();
const policySetting = { key: 'L2_REFUND_LIMIT_MINOR', integerValue: 50_000, currency: 'CAT' as string | null, version: 1 };
type StaffTask = {
  id: string; publicId: string; type: string; status: 'OPEN' | 'CLAIMED' | 'ESCALATED'; version: number;
  claimedBy: string | null; orderId: string | null; channelId: string | null; voiceChannelId: string | null; guildId: string; createdAt: string; notes: string[];
};
const initialTask: StaffTask = {
    id: '00000000-0000-0000-0000-000000000201', publicId: 'T-E2E-001', type: 'ORDER_ASSIST', status: 'OPEN', version: 1,
    claimedBy: null, orderId: '00000000-0000-0000-0000-000000000301', channelId: '1200000000000000011', voiceChannelId: null,
    guildId, createdAt: '2026-08-05T00:00:00.000Z', notes: []
};
const tasks = new Map<string, StaffTask>();
const orderRecord = { id: '00000000-0000-0000-0000-000000000301', publicId: 'P-E2E-001', version: 3, status: 'ACCEPTED', customerDiscordId: 'customer-e2e', amountMinor: 4_000, currency: 'USD', createdAt: '2026-08-05T00:00:00.000Z' };
let orderResolutionCount = 0;
const orderParticipants: Array<Record<string, unknown>> = [];
let reservationAmountMinor = 4_000;
const userRecord = { id: '00000000-0000-0000-0000-000000000501', discordUserId: 'customer-e2e', status: 'ACTIVE', operationalStatus: 'ACTIVE', version: 2, createdAt: '2026-08-01T00:00:00.000Z' };
const riskEvents: Array<{ type: string; severity: string; source: string; notes: string }> = [];
const walletBalance = { ledgerBalanceMinor: 10_000, reservedMinor: 2_500, availableMinor: 7_500, currency: 'CAT' as const, calculatedAt: '2026-08-05T00:00:00.000Z', version: 1 };
const walletEntries: Array<{ id: string; entryType: string; direction: 'CREDIT' | 'DEBIT'; amountMinor: number; currency: 'CAT'; sourceType: string; sourceId: string; occurredAt: string }> = [];
const playerRecord = { id: 'profile-e2e', playerId: '00000000-0000-0000-0000-000000000601', displayName: 'E2E 陪玩', reviewStatus: 'PENDING_REVIEW', availability: 'OFFLINE', version: 1, gameTags: [] as string[], serviceTags: [] as string[], languageTags: [] as string[], gameTagIds: [] as string[], serviceTagIds: [] as string[], languageTagIds: [] as string[], createdAt: '2026-08-02T00:00:00.000Z' };
const compensationRules: Array<{ serviceOfferingId: string; type: 'PERCENT_BPS' | 'FIXED_MINOR'; value: number; currency: 'CAT' | null; version: number }> = [];
const initialBusinessTags = [
  { id: 'tag-game-valorant', code: 'VALORANT', type: 'GAME', displayName: '无畏契约', enabled: true, version: 1 },
  { id: 'tag-service-escort', code: 'ESCORT', type: 'SERVICE', displayName: '护航', enabled: true, version: 1 },
  { id: 'tag-language-zh', code: 'ZH_CN', type: 'LANGUAGE', displayName: '中文', enabled: true, version: 1 },
  { id: 'tag-region-na', code: 'NA', type: 'REGION', displayName: '北美', enabled: true, version: 1 },
  { id: 'tag-gift-celebration', code: 'CELEBRATION', type: 'GIFT_CATEGORY', displayName: '庆祝', enabled: true, version: 1 },
  { id: 'tag-game-retired', code: 'RETIRED_GAME', type: 'GAME', displayName: '已停用游戏', enabled: false, version: 2 }
] as Array<{ id: string; code: string; type: string; displayName: string; enabled: boolean; version: number }>;
const businessTags: Array<{ id: string; code: string; type: string; displayName: string; enabled: boolean; version: number }> = [];
const initialCatalog = { id: '00000000-0000-0000-0000-000000000701', serviceOfferingId: 'offering-e2e-valorant', game: 'VALORANT', gameDisplayName: '无畏契约', service: 'ESCORT', serviceDisplayName: '护航', region: 'NA', regionDisplayName: '北美', status: 'ACTIVE', enabled: true, billingUnitMinutes: 60, minimumUnits: 1, customerUnitPriceMinor: 4000, playerUnitPriceMinor: 2400, defaultPlayerPayoutBps: 6000, currency: 'CAT', version: 1, historicalReferenceCount: 1 };
const alternateOrderCatalog = { ...initialCatalog, id: 'catalog-e2e-chat', serviceOfferingId: 'offering-e2e-chat', service: 'CHAT', serviceDisplayName: '聊天陪伴', customerUnitPriceMinor: 2500, playerUnitPriceMinor: 1500 };
const catalogRecords: Array<Record<string, unknown>> = [];
const initialPackages = [
  { id: 'package-active-v1', code: 'E2E_PACK', displayName: 'E2E 套餐', description: '历史启用版本', status: 'ACTIVE', version: 1, currency: 'CAT', game: 'VALORANT', defaultCustomerPriceMinor: 4000, slots: [{ id: 'slot-v1', position: 1, serviceCatalogVersionId: initialCatalog.id, unitCount: 1, game: 'VALORANT', service: 'ESCORT' }] },
  { id: 'package-draft-v2', code: 'E2E_PACK', displayName: 'E2E 套餐新版', description: '待发布版本', status: 'DRAFT', version: 2, currency: 'CAT', game: 'VALORANT', defaultCustomerPriceMinor: 8000, slots: [{ id: 'slot-v2', position: 1, serviceCatalogVersionId: initialCatalog.id, unitCount: 2, game: 'VALORANT', service: 'ESCORT' }] }
];
const packageRecords: Array<Record<string, unknown>> = [];
const initialGift = { id: '00000000-0000-0000-0000-000000000703', name: 'E2E 星光礼物', giftCategoryTagId: 'tag-gift-celebration', category: 'CELEBRATION', priceMinor: 1000, currency: 'CAT', broadcastTemplate: '{sender} 送给 {receiver} 星光礼物', status: 'ACTIVE', enabled: true, version: 1, historicalRequestCount: 1 };
const giftRecords: Array<Record<string, unknown>> = [];
const giftRequestRecords: Array<Record<string, unknown>> = [];
const earningRecord = { id: '00000000-0000-0000-0000-000000000706', playerId: '00000000-0000-0000-0000-000000000601', status: 'PENDING', amountMinor: 2400, currency: 'USD', version: 1, confirmedAt: null as string | null, paidAt: null as string | null };
let earningPaymentWrites = 0;
const roleMapping = { guildId, discordRoleId: 'role-e2e-l4', targetLevel: 'L4_ADMIN_OWNER', enabled: true, version: 1, reconciliationQueued: false };

function resetState() {
  clockOffsetMs = 0;
  nextOAuthIsNonStaff = false;
  tasks.clear();
  tasks.set(initialTask.id, { ...initialTask, notes: [] });
  jobs.clear();
  jobs.set(initialJob.id, { ...initialJob });
  jobs.set(nonRetryableJob.id, { ...nonRetryableJob });
  Object.assign(policySetting, { integerValue: 50_000, currency: 'CAT', version: 1 });
  Object.assign(orderRecord, { version: 3, status: 'ACCEPTED', amountMinor: 4_000 });
  orderResolutionCount = 0;
  orderParticipants.length = 0;
  reservationAmountMinor = 4_000;
  Object.assign(userRecord, { status: 'ACTIVE', operationalStatus: 'ACTIVE', version: 2 });
  riskEvents.length = 0;
  Object.assign(walletBalance, { ledgerBalanceMinor: 10_000, reservedMinor: 2_500, availableMinor: 7_500, version: 1 });
  walletEntries.length = 0;
  Object.assign(playerRecord, { reviewStatus: 'PENDING_REVIEW', availability: 'OFFLINE', version: 1, gameTags: [], serviceTags: [], languageTags: [], gameTagIds: [], serviceTagIds: [], languageTagIds: [] });
  compensationRules.length = 0;
  businessTags.splice(0, businessTags.length, ...initialBusinessTags.map((tag) => ({ ...tag })));
  catalogRecords.splice(0, catalogRecords.length, { ...initialCatalog });
  packageRecords.splice(0, packageRecords.length, ...initialPackages.map((item) => ({ ...item, slots: item.slots.map((slot) => ({ ...slot })) })));
  giftRecords.splice(0, giftRecords.length, { ...initialGift });
  giftRequestRecords.splice(0, giftRequestRecords.length, { id: '00000000-0000-0000-0000-000000000704', publicId: 'G-E2E-001', status: 'CAPTURED', amountMinor: 1000, currency: 'CAT', giftCatalogId: initialGift.id, giftCatalogVersionId: initialGift.id, giftName: initialGift.name, giftCode: 'STARLIGHT', broadcastTemplate: initialGift.broadcastTemplate, orderId: orderRecord.id, orderPublicId: orderRecord.publicId, senderDisplayName: 'E2E 用户', senderDiscordUserId: userRecord.discordUserId, receiverDisplayName: playerRecord.displayName, receiverDiscordUserId: 'player-discord-e2e', verifiedByStaffId: 'staff-l2', verifiedAt: '2026-08-05T01:04:00.000Z', approvedByStaffId: 'staff-l2', approvedAt: '2026-08-05T01:05:00.000Z', capturedAt: '2026-08-05T01:06:00.000Z', createdAt: '2026-08-05T01:00:00.000Z', updatedAt: '2026-08-05T01:06:00.000Z', rowVersion: 3 });
  Object.assign(earningRecord, { status: 'PENDING', version: 1, confirmedAt: null, paidAt: null });
  earningPaymentWrites = 0;
  Object.assign(roleMapping, { discordRoleId: 'role-e2e-l4', enabled: true, version: 1, reconciliationQueued: false });
  auditSink.records.length = 0;
  faults.clear();
  for (const actor of Object.values(actors)) authStore.setCurrentPermissionsVersion(actor.staffId, actor.permissionsVersion);
}

function decodeBase32(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of value.toUpperCase().replace(/=+$/u, '')) bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function generateTotp(secret: string, at = new Date()): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

const actorTotpSecrets = new Map<string, string>();
for (const actor of [operator, owner]) {
  const enrollment = authStore.beginMfaEnrollment({ staffId: actor.staffId, accountName: `${actor.level}@e2e` });
  const secret = new URL(enrollment.provisioningUri).searchParams.get('secret');
  if (!secret) throw new Error('E2E MFA enrollment did not return a TOTP secret.');
  authStore.verifyMfaEnrollment({ staffId: actor.staffId, enrollmentId: enrollment.enrollmentId, proof: generateTotp(secret) });
  actorTotpSecrets.set(actor.level === 'L3_OPERATIONS' ? 'l3' : 'l4', secret);
}
resetState();

const directory: StaffDirectory = {
  resolveByDiscord(input) {
    return input.discordUserId === '111111111111111111' && input.guildId === guildId ? staff : null;
  }
};

const oauth: DiscordOAuthProvider = {
  getAuthorizationUrl({ state }) { return `${dashboardUrl}/__e2e/oauth?state=${encodeURIComponent(state)}`; },
  async exchangeCode(code) {
    if (code === 'dashboard-e2e-nonstaff-code') return { discordUserId: '222222222222222222' };
    if (code === 'dashboard-e2e-code') return { discordUserId: '111111111111111111' };
    throw new Error('invalid E2E OAuth code');
  }
};

const server = buildApiServer({
  env: {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused', API_PORT: String(port), API_BASE_URL: `http://${host}:${port}`,
    BOT_SERVICE_TOKEN: 'dashboard-e2e-bot-token', PAGINATION_CURSOR_SIGNING_SECRET: 'dashboard-e2e-pagination-secret-which-is-long-enough'
  },
  security: { staffDirectory: directory, dashboardSessions: authStore, auditSink, businessEnvironment: 'SANDBOX' },
  dashboardAuth: { store: authStore, oauth, staffDirectory: directory, guildId, dashboardUrl, secureCookies: false, now: fixtureNow },
  dashboardMetrics: { store: new InMemoryDashboardMetricsStore({ facts: { todayOrderCount: 1, inProgressOrderCount: 1, pendingStaffTaskCount: 1, completedOrderNetConsumptionMinor: 12_500, giftNetConsumptionMinor: 0, activeReservedMinor: 4_000, dispatchAcceptedCount: 19, dispatchStartedCount: 20, exceptionCount: 0 } }) }
});

server.get('/__e2e/oauth', async (request, reply) => {
  const { state } = request.query as { state?: string };
  const code = nextOAuthIsNonStaff ? 'dashboard-e2e-nonstaff-code' : 'dashboard-e2e-code';
  nextOAuthIsNonStaff = false;
  return reply.redirect(`/api/v1/auth/discord/callback?code=${code}&state=${encodeURIComponent(state ?? '')}`);
});
server.get('/__e2e/login-nonstaff', async (_request, reply) => { nextOAuthIsNonStaff = true; return reply.redirect('/api/v1/auth/discord'); });
server.get('/__e2e/login/:actor', async (request, reply) => {
  const actor = (request.params as { actor: string }).actor;
  const selected = actors[actor as keyof typeof actors];
  if (!selected) return reply.code(404).send({ error: 'unknown E2E actor' });
  const session = authStore.createSession(selected);
  reply.header('set-cookie', [
    `p0_session=${encodeURIComponent(session.sessionToken)}; Path=/; HttpOnly; SameSite=Lax`,
    `p0_csrf=${encodeURIComponent(session.csrfToken)}; Path=/; SameSite=Lax`
  ]);
  return reply.redirect(`${dashboardUrl}/`);
});

registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/staff-tasks', permission: 'staff_task.read', action: 'LIST_E2E_STAFF_TASKS', targetType: 'staff_task', acceptedSources: ['DASHBOARD'],
  handler: (_request, actor) => ({ items: Array.from(tasks.values()).filter((task) => task.guildId === actor.guildId).map(({ notes: _notes, ...task }) => task), nextCursor: null })
});

registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/users/:userId/profile-summary', permission: 'customer_profile.read', action: 'GET_E2E_PROFILE_SUMMARY', targetType: 'customer_profile', acceptedSources: ['DASHBOARD'],
  handler: (request) => ({ user: { id: userRecord.id, discordUserId: userRecord.discordUserId, status: userRecord.status }, balance: { ...walletBalance }, statistics: { window: (request.query as { window?: string }).window, completedOrderCount: 2, orderConsumptionMinor: 8_000, giftConsumptionMinor: 1_000, currency: 'CAT' }, preferences: { language: 'zh-CN' }, internalNotes: [], riskFlags: [] })
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/users/:userId/orders', permission: 'customer_profile.read', action: 'LIST_E2E_PROFILE_ORDERS', targetType: 'customer_profile', acceptedSources: ['DASHBOARD'],
  handler: () => ({ items: [{ id: orderRecord.id, publicId: orderRecord.publicId, status: orderRecord.status, amountMinor: orderRecord.amountMinor, currency: 'USD', createdAt: orderRecord.createdAt }], nextCursor: null })
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/users/:userId/wallet', permission: 'wallet.read', action: 'GET_E2E_WALLET', targetType: 'wallet', acceptedSources: ['DASHBOARD'], handler: () => ({ ...walletBalance })
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/users/:userId/wallet/entries', permission: 'wallet.read', action: 'LIST_E2E_WALLET_ENTRIES', targetType: 'wallet_entry', acceptedSources: ['DASHBOARD'], handler: () => [...walletEntries]
});

registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/users/:userId/top-ups', permission: 'wallet.top_up', action: 'CREATE_E2E_TOP_UP', targetType: 'wallet_entry', acceptedSources: ['DASHBOARD'],
  handler: (request) => {
    const body = request.body as { paidAmountUsdCents?: unknown; paidCurrency?: unknown; paymentMethod?: unknown; receiptNumber?: unknown; paidAt?: unknown; note?: unknown; reasonCode?: unknown };
    if (!Number.isSafeInteger(body.paidAmountUsdCents) || Number(body.paidAmountUsdCents) <= 0 || body.paidCurrency !== 'USD' || !body.receiptNumber || !body.paidAt || !body.note || !body.reasonCode) throw new Error('INVALID_TOP_UP');
    const amountMinor = Number(body.paidAmountUsdCents);
    const entry = { id: `wallet-${walletEntries.length + 1}`, entryType: 'MANUAL_TOP_UP', direction: 'CREDIT' as const, amountMinor, currency: 'CAT' as const, sourceType: 'STAFF_TOP_UP', sourceId: String(body.receiptNumber), occurredAt: String(body.paidAt) };
    walletEntries.push(entry); walletBalance.ledgerBalanceMinor += amountMinor; walletBalance.availableMinor += amountMinor; walletBalance.version += 1;
    return entry;
  }
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/service-packages/:packageId', permission: 'catalog.read', action: 'GET_E2E_PACKAGE', targetType: 'service_package', acceptedSources: ['DASHBOARD'],
  handler: (request) => packageRecords.find((item) => item.id === (request.params as { packageId: string }).packageId) ?? initialPackages[0]
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/service-packages', permission: 'catalog.manage', action: 'CREATE_E2E_PACKAGE', targetType: 'service_package', acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'CROSS_GAME_PACKAGE' ? { statusCode: 422, code: 'CROSS_GAME_PACKAGE', message: 'All package slots must use one game.' } : null,
  handler: (request) => {
    const body = request.body as { code?: unknown; displayName?: unknown; description?: unknown; currency?: unknown; activate?: unknown; slots?: Array<{ serviceCatalogVersionId?: unknown; unitCount?: unknown }> };
    if (typeof body.code !== 'string' || typeof body.displayName !== 'string' || body.currency !== 'CAT' || !Array.isArray(body.slots) || !body.slots.length) throw new Error('INVALID_PACKAGE');
    const games = new Set(body.slots.map((slot) => slot.serviceCatalogVersionId === 'catalog-other-game' ? 'OTHER_GAME' : catalogRecords.find((item) => item.id === slot.serviceCatalogVersionId)?.game));
    if (games.size !== 1 || games.has(undefined)) throw new Error('CROSS_GAME_PACKAGE');
    const total = body.slots.reduce((sum, slot) => sum + Number(catalogRecords.find((item) => item.id === slot.serviceCatalogVersionId)?.customerUnitPriceMinor ?? 3000) * Number(slot.unitCount), 0);
    const priorVersions = packageRecords.filter((item) => item.code === body.code);
    const record = { id: `package-created-${packageRecords.length}`, code: body.code, displayName: body.displayName, description: body.description, status: body.activate ? 'ACTIVE' : 'DRAFT', version: priorVersions.length + 1, currency: 'CAT', game: [...games][0], defaultCustomerPriceMinor: total, slots: body.slots.map((slot, index) => ({ id: `slot-created-${index}`, position: index + 1, ...slot })) };
    if (body.activate) for (const prior of priorVersions) if (prior.status === 'ACTIVE') prior.status = 'RETIRED';
    packageRecords.push(record); return record;
  }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'PATCH', url: '/api/v1/admin/service-packages/:packageId', permission: 'catalog.manage', action: 'UPDATE_E2E_PACKAGE_STATUS', targetType: 'service_package', acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'PACKAGE_CONFLICT' ? { statusCode: 409, code: 'VERSION_CONFLICT', message: 'The package status changed.' } : null,
  handler: (request) => {
    const record = packageRecords.find((item) => item.id === (request.params as { packageId: string }).packageId);
    const body = request.body as { expectedStatus?: unknown; action?: unknown };
    if (!record || record.status !== body.expectedStatus) throw new Error('PACKAGE_CONFLICT');
    if (body.action === 'ACTIVATE' && record.status === 'DRAFT') { for (const prior of packageRecords) if (prior.code === record.code && prior.status === 'ACTIVE') prior.status = 'RETIRED'; record.status = 'ACTIVE'; return { ...record }; }
    if (body.action === 'RETIRE' && record.status === 'ACTIVE') { record.status = 'RETIRED'; return { ...record }; }
    throw new Error('PACKAGE_CONFLICT');
  }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/users/:userId/external-refund-debits', permission: 'wallet.external_refund', action: 'CREATE_E2E_EXTERNAL_REFUND', targetType: 'wallet_entry', acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'STALE_WALLET' ? { statusCode: 409, code: 'VERSION_CONFLICT', message: 'The wallet version changed.' } : null,
  handler: (request) => {
    const body = request.body as { amountMinor?: unknown; expectedWalletVersion?: unknown; externalTransactionId?: unknown; refundedAt?: unknown; note?: unknown };
    if (body.expectedWalletVersion !== walletBalance.version) throw new Error('STALE_WALLET');
    if (!Number.isSafeInteger(body.amountMinor) || Number(body.amountMinor) <= 0 || Number(body.amountMinor) > walletBalance.availableMinor) throw new Error('INVALID_REFUND');
    const amountMinor = Number(body.amountMinor);
    const entry = { id: `wallet-${walletEntries.length + 1}`, entryType: 'EXTERNAL_REFUND_DEBIT', direction: 'DEBIT' as const, amountMinor, currency: 'CAT' as const, sourceType: 'EXTERNAL_REFUND', sourceId: String(body.externalTransactionId), occurredAt: String(body.refundedAt) };
    walletEntries.push(entry); walletBalance.ledgerBalanceMinor -= amountMinor; walletBalance.availableMinor -= amountMinor; walletBalance.version += 1;
    return entry;
  }
});

registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/staff-tasks/:taskId/claim', permission: 'staff_task.claim', action: 'CLAIM_E2E_STAFF_TASK', targetType: 'staff_task',
  targetId: (request) => String((request.params as { taskId: string }).taskId), acceptedSources: ['DASHBOARD'],
  handler: (request, actor) => {
    const task = tasks.get(String((request.params as { taskId: string }).taskId));
    const body = request.body as { expectedVersion?: unknown };
    if (!task || task.status !== 'OPEN' || body.expectedVersion !== task.version) throw new Error('STALE_TASK');
    task.status = 'CLAIMED'; task.claimedBy = actor.actorStaffId!; task.version += 1;
    return { id: task.id, status: task.status, version: task.version };
  }
});

registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/e2e-sensitive-action', permission: 'access.manage', action: 'E2E_SENSITIVE_ACTION', targetType: 'security_probe', acceptedSources: ['DASHBOARD'], requiresRecentStepUp: true,
  handler: () => ({ executed: true })
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/discord-role-mappings', permission: 'access.read', action: 'LIST_E2E_ROLE_MAPPINGS', targetType: 'discord_role_mapping', acceptedSources: ['DASHBOARD'], requiresRecentStepUp: true,
  handler: () => ({ items: [{ ...roleMapping }] })
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'PUT', url: '/api/v1/admin/discord-role-mappings/:level', permission: 'access.manage', action: 'UPDATE_E2E_ROLE_MAPPING', targetType: 'discord_role_mapping', acceptedSources: ['DASHBOARD'], requiresRecentStepUp: true,
  handler: (request) => {
    const body = request.body as { guildId?: unknown; discordRoleId?: unknown; expectedVersion?: unknown; reasonCode?: unknown };
    if ((request.params as { level: string }).level !== roleMapping.targetLevel || body.guildId !== guildId || body.expectedVersion !== roleMapping.version || typeof body.discordRoleId !== 'string' || typeof body.reasonCode !== 'string') throw new Error('STALE_ROLE_MAPPING');
    roleMapping.discordRoleId = body.discordRoleId; roleMapping.version += 1; roleMapping.reconciliationQueued = true; return { ...roleMapping };
  }
});

registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/staff-tasks/:taskId/notes', permission: 'staff_task.verify', action: 'ADD_E2E_STAFF_TASK_NOTE', targetType: 'staff_task',
  targetId: (request) => String((request.params as { taskId: string }).taskId), acceptedSources: ['DASHBOARD'],
  handler: (request, actor) => {
    const task = tasks.get(String((request.params as { taskId: string }).taskId));
    const body = request.body as { body?: unknown };
    if (!task || task.status !== 'CLAIMED' || task.claimedBy !== actor.actorStaffId || typeof body.body !== 'string' || !body.body.trim()) throw new Error('TASK_NOTE_REJECTED');
    task.notes.push(body.body.trim());
    return { id: task.id, noteCount: task.notes.length };
  }
});

registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/orders/:orderId', permission: 'order.read', action: 'GET_E2E_ORDER_CONTEXT', targetType: 'order', acceptedSources: ['DASHBOARD'],
  handler: (request) => {
    const query = request.query as { timelineCursor?: string };
    const timeline = query.timelineCursor
      ? { items: [{ id: 'evt-2', type: 'FUND_RESERVED', status: 'COMPLETED', direction: 'DEBIT', amountMinor: 4000, currency: 'USD', occurredAt: '2026-08-05T00:01:00.000Z' }], nextCursor: null }
      : { items: [{ id: 'evt-1', type: 'ORDER_ACCEPTED', status: 'COMPLETED', direction: 'INFO', amountMinor: null, currency: null, occurredAt: '2026-08-05T00:00:00.000Z' }], nextCursor: 'timeline-2' };
    return { order: { ...orderRecord, game: 'valorant', gameDisplayName: '无畏契约', service: 'escort', serviceDisplayName: '护航' }, readiness: { customer: 'READY', player: 'PENDING', bothReady: false }, automation: { state: 'RUNNING', reasonCode: null }, matching: { stage: 'ACCEPTED', nextStep: 'WAIT_FOR_READINESS' }, timeline };
  }
});

registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/orders/:orderId/resolve', permission: 'order.resolve', action: 'RESOLVE_E2E_ORDER', targetType: 'order', targetId: () => orderRecord.id, acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'STALE_ORDER' ? { statusCode: 409, code: 'VERSION_CONFLICT', message: 'The order version changed.' } : error instanceof Error && error.message === 'INVALID_RESOLUTION' ? { statusCode: 422, code: 'RESOLUTION_REJECTED', message: 'The resolution amount exceeds the allowed order facts.' } : null,
  handler: (request) => {
    const body = request.body as { expectedVersion?: unknown; targetStatus?: unknown; refund?: { amountMinor?: unknown; currency?: unknown }; playerEarning?: { amountMinor?: unknown; currency?: unknown } };
    if (body.expectedVersion !== orderRecord.version || orderRecord.status !== 'ACCEPTED') throw new Error('STALE_ORDER');
    if (body.targetStatus !== 'CANCELLED' || body.refund?.currency !== 'USD' || body.playerEarning?.currency !== 'USD' || !Number.isSafeInteger(body.refund.amountMinor) || Number(body.refund.amountMinor) > orderRecord.amountMinor) throw new Error('INVALID_RESOLUTION');
    orderRecord.status = 'CANCELLED';
    orderRecord.version += 1;
    orderResolutionCount += 1;
    return { order: { ...orderRecord }, reservationStatus: 'RELEASED', refundEntryCount: 1, earningEntryCount: Number(body.playerEarning?.amountMinor) > 0 ? 1 : 0 };
  }
});

const businessLists = [
  { url: '/api/v1/admin/orders', permission: 'order.read', target: 'order', items: [orderRecord, { id: '00000000-0000-0000-0000-000000000302', publicId: 'P-E2E-002', version: 1, status: 'COMPLETED', customerDiscordId: 'customer-second', amountMinor: 6_000, currency: 'USD', createdAt: '2026-08-04T00:00:00.000Z' }] },
  { url: '/api/v1/admin/users', permission: 'user.read', target: 'user', items: [userRecord] },
  { url: '/api/v1/admin/players', permission: 'player.read', target: 'player', items: [playerRecord] },
  { url: '/api/v1/admin/service-catalog', permission: 'catalog.read', target: 'service_catalog', items: catalogRecords },
  { url: '/api/v1/admin/service-packages', permission: 'catalog.read', target: 'service_package', items: packageRecords },
  { url: '/api/v1/admin/gift-catalog', permission: 'gift_catalog.read', target: 'gift_catalog', items: giftRecords },
  { url: '/api/v1/admin/gift-requests', permission: 'gift_request.read', target: 'gift_request', items: giftRequestRecords },
  { url: '/api/v1/admin/commissions', permission: 'commission.read', target: 'commission', items: [{ id: '00000000-0000-0000-0000-000000000705', publicId: 'C-E2E-001', sourceUserDisplay: '用户 ••••0011', status: 'PENDING', amountMinor: 200, currency: 'USD' }] },
  { url: '/api/v1/admin/player-earnings', permission: 'earnings.read', target: 'player_earning', items: [earningRecord] }
] as const;

for (const definition of businessLists) {
  registerSecureReadRoute(server, server.securityOptions!, {
    method: 'GET', url: definition.url, permission: definition.permission, action: `LIST_E2E_${definition.target.toUpperCase()}`, targetType: definition.target, acceptedSources: ['DASHBOARD'],
    handler: (request) => {
      if (faults.has(definition.target)) throw new Error(`E2E_${definition.target.toUpperCase()}_FAILURE`);
      const query = request.query as { query?: string; status?: string; reviewStatus?: string; cursor?: string };
      let items = definition.items.filter((item) => (!['service_catalog', 'gift_catalog'].includes(definition.target) || !('status' in item) || item.status !== 'ARCHIVED') && (!query.status || !('status' in item) || item.status === query.status) && (!query.reviewStatus || !('reviewStatus' in item) || item.reviewStatus === query.reviewStatus));
      if (query.query) items = items.filter((item) => JSON.stringify(item).toLowerCase().includes(query.query!.toLowerCase()));
      if (definition.target === 'order' && !query.query && !query.status) {
        return query.cursor ? { items: items.slice(1), nextCursor: null } : { items: items.slice(0, 1), nextCursor: 'order-page-2' };
      }
      return { items, nextCursor: null };
    }
  });
}

registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/business-tags', permission: 'dashboard.view', action: 'LIST_E2E_BUSINESS_TAGS', targetType: 'business_tag', acceptedSources: ['DASHBOARD'],
  handler: (request) => (request.query as { enabled?: string }).enabled === 'true' ? businessTags.filter((tag) => tag.enabled) : businessTags
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/business-tags', permission: 'catalog.manage', action: 'CREATE_E2E_BUSINESS_TAG', targetType: 'business_tag', acceptedSources: ['DASHBOARD'], successStatusCode: 201,
  handler: (request) => {
    const body = request.body as { type?: unknown; code?: unknown; displayName?: unknown };
    const code = String(body.code ?? '').trim().toUpperCase();
    if (!['GAME', 'SERVICE', 'REGION', 'LANGUAGE', 'GIFT_CATEGORY'].includes(String(body.type)) || !/^[A-Z][A-Z0-9_]{1,79}$/u.test(code) || typeof body.displayName !== 'string') throw new Error('INVALID_TAG');
    if (businessTags.some((tag) => tag.type === body.type && tag.code === code)) throw new Error('DUPLICATE_TAG');
    const tag = { id: `tag-created-${businessTags.length}`, type: String(body.type), code, displayName: body.displayName.trim(), enabled: true, version: 1 };
    businessTags.push(tag); return tag;
  }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'PATCH', url: '/api/v1/admin/business-tags/:tagId', permission: 'catalog.manage', action: 'UPDATE_E2E_BUSINESS_TAG', targetType: 'business_tag', acceptedSources: ['DASHBOARD'],
  handler: (request) => {
    const tag = businessTags.find((item) => item.id === (request.params as { tagId: string }).tagId);
    const body = request.body as { expectedVersion?: unknown; displayName?: unknown; enabled?: unknown };
    if (!tag || tag.version !== body.expectedVersion || typeof body.displayName !== 'string' || typeof body.enabled !== 'boolean') throw new Error('STALE_TAG');
    tag.displayName = body.displayName.trim(); tag.enabled = body.enabled; tag.version += 1; return { ...tag };
  }
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/gift-catalog/:giftId', permission: 'gift_catalog.read', action: 'GET_E2E_GIFT', targetType: 'gift_catalog', acceptedSources: ['DASHBOARD'],
  handler: (request) => giftRecords.find((item) => item.id === (request.params as { giftId: string }).giftId) ?? initialGift
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/gift-catalog', permission: 'gift_catalog.manage', action: 'CREATE_E2E_GIFT', targetType: 'gift_catalog', acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'INVALID_GIFT' ? { statusCode: 422, code: 'VALIDATION_ERROR', message: 'Gift price or category is invalid.' } : null,
  handler: (request) => {
    const body = request.body as { name?: unknown; giftCategoryTagId?: unknown; price?: { amountMinor?: unknown; currency?: unknown }; broadcastTemplate?: unknown; enabled?: unknown };
    if (typeof body.name !== 'string' || body.giftCategoryTagId !== 'tag-gift-celebration' || body.price?.currency !== 'CAT' || !Number.isSafeInteger(body.price.amountMinor) || Number(body.price.amountMinor) <= 0 || typeof body.broadcastTemplate !== 'string') throw new Error('INVALID_GIFT');
    const record = { ...initialGift, id: `gift-created-${giftRecords.length}`, name: body.name, priceMinor: Number(body.price.amountMinor), broadcastTemplate: body.broadcastTemplate, status: body.enabled ? 'ACTIVE' : 'DRAFT', enabled: body.enabled === true, version: 1, historicalRequestCount: 0 };
    giftRecords.push(record); return record;
  }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'PATCH', url: '/api/v1/admin/gift-catalog/:giftId', permission: 'gift_catalog.manage', action: 'UPDATE_E2E_GIFT', targetType: 'gift_catalog', acceptedSources: ['DASHBOARD'],
  handler: (request) => {
    const record = giftRecords.find((item) => item.id === (request.params as { giftId: string }).giftId);
    const body = request.body as { expectedVersion?: unknown; action?: unknown; replacement?: { name?: unknown; price?: { amountMinor?: unknown; currency?: unknown }; broadcastTemplate?: unknown } | null };
    if (!record || record.version !== body.expectedVersion) throw new Error('STALE_GIFT');
    if (body.action === 'ARCHIVE') { record.status = 'ARCHIVED'; record.enabled = false; record.version = Number(record.version) + 1; return { ...record }; }
    if (body.action === 'CREATE_REPLACEMENT_VERSION' && body.replacement) {
      if (body.replacement.price?.currency !== 'CAT' || !Number.isSafeInteger(body.replacement.price.amountMinor) || Number(body.replacement.price.amountMinor) <= 0) throw new Error('INVALID_GIFT');
      record.status = 'RETIRED'; record.enabled = false;
      const replacement = { ...initialGift, id: `gift-replacement-${giftRecords.length}`, name: String(body.replacement.name), priceMinor: Number(body.replacement.price.amountMinor), broadcastTemplate: String(body.replacement.broadcastTemplate), version: Number(record.version) + 1, historicalRequestCount: 0 };
      giftRecords.push(replacement); return replacement;
    }
    if (body.action === 'ENABLE' || body.action === 'DISABLE') { record.enabled = body.action === 'ENABLE'; record.status = body.action === 'ENABLE' ? 'ACTIVE' : 'DRAFT'; record.version = Number(record.version) + 1; return { ...record }; }
    throw new Error('INVALID_GIFT_ACTION');
  }
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/gift-requests/:giftRequestId', permission: 'gift_request.read', action: 'GET_E2E_GIFT_REQUEST', targetType: 'gift_request', acceptedSources: ['DASHBOARD'],
  handler: (request) => giftRequestRecords.find((item) => item.id === (request.params as { giftRequestId: string }).giftRequestId) ?? giftRequestRecords[0]
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'PATCH', url: '/api/v1/admin/player-earnings/:earningId', permission: 'earnings.manage', action: 'UPDATE_E2E_EARNING', targetType: 'player_earning', acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'STALE_EARNING' ? { statusCode: 409, code: 'VERSION_CONFLICT', message: 'The earning version changed.' } : null,
  handler: (request) => {
    const body = request.body as { expectedVersion?: unknown; action?: unknown; reasonCode?: unknown };
    if ((request.params as { earningId: string }).earningId !== earningRecord.id || body.expectedVersion !== earningRecord.version || typeof body.reasonCode !== 'string') throw new Error('STALE_EARNING');
    if (body.action === 'CONFIRM' && earningRecord.status === 'PENDING') { earningRecord.status = 'CONFIRMED'; earningRecord.confirmedAt = '2026-08-05T02:00:00.000Z'; earningRecord.version += 1; return { ...earningRecord }; }
    if (body.action === 'MARK_PAID' && earningRecord.status === 'CONFIRMED') { earningRecord.status = 'PAID'; earningRecord.paidAt = '2026-08-05T03:00:00.000Z'; earningRecord.version += 1; earningPaymentWrites += 1; return { ...earningRecord }; }
    throw new Error('STALE_EARNING');
  }
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/service-catalog/:catalogId', permission: 'catalog.read', action: 'GET_E2E_CATALOG', targetType: 'service_catalog', acceptedSources: ['DASHBOARD'],
  handler: (request) => catalogRecords.find((item) => item.id === (request.params as { catalogId: string }).catalogId) ?? initialCatalog
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/service-catalog', permission: 'catalog.manage', action: 'CREATE_E2E_CATALOG', targetType: 'service_catalog', acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'INVALID_CATALOG' ? { statusCode: 422, code: 'VALIDATION_ERROR', message: 'Catalog pricing and tags are invalid.' } : null,
  handler: (request) => {
    const body = request.body as { gameTagId?: unknown; serviceTagId?: unknown; regionTagId?: unknown; billingUnitMinutes?: unknown; minimumUnits?: unknown; customerUnitPrice?: { amountMinor?: unknown; currency?: unknown }; playerUnitPayout?: { amountMinor?: unknown; currency?: unknown }; defaultPlayerPayoutBps?: unknown; enabled?: unknown };
    if (body.gameTagId !== 'tag-game-valorant' || body.serviceTagId !== 'tag-service-escort' || (body.regionTagId && body.regionTagId !== 'tag-region-na') || body.customerUnitPrice?.currency !== 'CAT' || body.playerUnitPayout?.currency !== 'CAT' || !Number.isSafeInteger(body.customerUnitPrice.amountMinor) || Number(body.customerUnitPrice.amountMinor) <= 0 || !Number.isSafeInteger(body.playerUnitPayout.amountMinor) || Number(body.playerUnitPayout.amountMinor) <= 0) throw new Error('INVALID_CATALOG');
    const version = { ...initialCatalog, id: `catalog-created-${catalogRecords.length}`, serviceOfferingId: `offering-created-${catalogRecords.length}`, version: 1, status: body.enabled ? 'ACTIVE' : 'DRAFT', enabled: body.enabled === true, customerUnitPriceMinor: Number(body.customerUnitPrice.amountMinor), playerUnitPriceMinor: Number(body.playerUnitPayout.amountMinor), defaultPlayerPayoutBps: Number(body.defaultPlayerPayoutBps) };
    catalogRecords.push(version); return version;
  }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'PATCH', url: '/api/v1/admin/service-catalog/:catalogId', permission: 'catalog.manage', action: 'UPDATE_E2E_CATALOG', targetType: 'service_catalog', acceptedSources: ['DASHBOARD'],
  handler: (request) => {
    const record = catalogRecords.find((item) => item.id === (request.params as { catalogId: string }).catalogId);
    const body = request.body as { expectedVersion?: unknown; action?: unknown; replacement?: Record<string, unknown> | null };
    if (!record || record.version !== body.expectedVersion) throw new Error('STALE_CATALOG');
    if (body.action === 'ARCHIVE') { record.status = 'ARCHIVED'; record.enabled = false; record.version = Number(record.version) + 1; return { ...record }; }
    if (body.action === 'SUPERSEDE' && body.replacement) {
      record.status = 'RETIRED'; record.enabled = false;
      const replacement = { ...initialCatalog, id: `catalog-superseded-${catalogRecords.length}`, serviceOfferingId: record.serviceOfferingId, version: Number(record.version) + 1, status: 'ACTIVE', enabled: true, customerUnitPriceMinor: Number((body.replacement.customerUnitPrice as { amountMinor?: unknown })?.amountMinor), playerUnitPriceMinor: Number((body.replacement.playerUnitPayout as { amountMinor?: unknown })?.amountMinor) };
      catalogRecords.push(replacement); return replacement;
    }
    if (body.action === 'ENABLE' || body.action === 'DISABLE') { record.enabled = body.action === 'ENABLE'; record.status = body.action === 'ENABLE' ? 'ACTIVE' : 'DRAFT'; record.version = Number(record.version) + 1; return { ...record }; }
    throw new Error('INVALID_CATALOG_ACTION');
  }
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/players/:playerId', permission: 'player.read', action: 'GET_E2E_PLAYER', targetType: 'player', acceptedSources: ['DASHBOARD'], handler: () => ({ ...playerRecord })
});

function validatePlayerTags(body: { gameTagIds?: unknown; serviceTagIds?: unknown; languageTagIds?: unknown }) {
  const groups = [['GAME', body.gameTagIds], ['SERVICE', body.serviceTagIds], ['LANGUAGE', body.languageTagIds]] as const;
  for (const [type, values] of groups) {
    if (!Array.isArray(values)) throw new Error('INVALID_PLAYER_TAGS');
    for (const id of values) if (!businessTags.some((tag) => tag.id === id && tag.type === type && tag.enabled)) throw new Error('INVALID_PLAYER_TAGS');
  }
}

for (const action of ['approve', 'reject'] as const) {
  registerSecureWriteRoute(server, server.securityOptions!, {
    method: 'POST', url: `/api/v1/admin/players/:playerId/${action}`, permission: 'player.approve', action: `${action.toUpperCase()}_E2E_PLAYER`, targetType: 'player', targetId: () => playerRecord.playerId, acceptedSources: ['DASHBOARD'],
    mapError: (error) => error instanceof Error && error.message === 'STALE_PLAYER' ? { statusCode: 409, code: 'VERSION_CONFLICT', message: 'The player version changed.' } : error instanceof Error && error.message === 'INVALID_PLAYER_TAGS' ? { statusCode: 422, code: 'INVALID_TAG_SELECTION', message: 'The selected tags are invalid.' } : null,
    handler: (request) => {
      const body = request.body as { expectedVersion?: unknown; gameTagIds?: unknown; serviceTagIds?: unknown; languageTagIds?: unknown; reasonCode?: unknown; note?: unknown };
      if (body.expectedVersion !== playerRecord.version || playerRecord.reviewStatus !== 'PENDING_REVIEW') throw new Error('STALE_PLAYER');
      if (typeof body.reasonCode !== 'string') throw new Error('INVALID_PLAYER_ACTION');
      if (action === 'approve') {
        validatePlayerTags(body);
        playerRecord.reviewStatus = 'APPROVED';
        playerRecord.gameTagIds = [...body.gameTagIds as string[]]; playerRecord.serviceTagIds = [...body.serviceTagIds as string[]]; playerRecord.languageTagIds = [...body.languageTagIds as string[]];
        playerRecord.gameTags = businessTags.filter((tag) => playerRecord.gameTagIds.includes(tag.id)).map((tag) => tag.code);
        playerRecord.serviceTags = businessTags.filter((tag) => playerRecord.serviceTagIds.includes(tag.id)).map((tag) => tag.code);
        playerRecord.languageTags = businessTags.filter((tag) => playerRecord.languageTagIds.includes(tag.id)).map((tag) => tag.code);
      } else {
        if (typeof body.note !== 'string' || !body.note.trim()) throw new Error('INVALID_PLAYER_ACTION');
        playerRecord.reviewStatus = 'REJECTED';
      }
      playerRecord.version += 1;
      return { ...playerRecord };
    }
  });
}

registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'PUT', url: '/api/v1/admin/players/:playerId/tags', permission: 'player.tags.manage', action: 'UPDATE_E2E_PLAYER_TAGS', targetType: 'player', targetId: () => playerRecord.playerId, acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'INVALID_PLAYER_TAGS' ? { statusCode: 422, code: 'INVALID_TAG_SELECTION', message: 'The selected tags are invalid.' } : null,
  handler: (request) => {
    const body = request.body as { expectedVersion?: unknown; gameTagIds?: unknown; serviceTagIds?: unknown; languageTagIds?: unknown };
    if (body.expectedVersion !== playerRecord.version || playerRecord.reviewStatus !== 'APPROVED') throw new Error('STALE_PLAYER');
    validatePlayerTags(body);
    playerRecord.gameTagIds = [...body.gameTagIds as string[]]; playerRecord.serviceTagIds = [...body.serviceTagIds as string[]]; playerRecord.languageTagIds = [...body.languageTagIds as string[]];
    playerRecord.gameTags = businessTags.filter((tag) => playerRecord.gameTagIds.includes(tag.id)).map((tag) => tag.code);
    playerRecord.serviceTags = businessTags.filter((tag) => playerRecord.serviceTagIds.includes(tag.id)).map((tag) => tag.code);
    playerRecord.languageTags = businessTags.filter((tag) => playerRecord.languageTagIds.includes(tag.id)).map((tag) => tag.code); playerRecord.version += 1;
    return { ...playerRecord };
  }
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/players/:playerId/compensation', permission: 'player.read', action: 'LIST_E2E_PLAYER_COMPENSATION', targetType: 'player_compensation', acceptedSources: ['DASHBOARD'], handler: () => ({ items: compensationRules })
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'PUT', url: '/api/v1/admin/players/:playerId/compensation', permission: 'player.tags.manage', action: 'UPDATE_E2E_PLAYER_COMPENSATION', targetType: 'player_compensation', acceptedSources: ['DASHBOARD'],
  handler: (request) => {
    const body = request.body as { rules?: Array<{ serviceOfferingId?: unknown; type?: unknown; value?: unknown; currency?: unknown }>; reasonCode?: unknown };
    if (!Array.isArray(body.rules) || typeof body.reasonCode !== 'string') throw new Error('INVALID_COMPENSATION');
    const next = body.rules.map((rule) => {
      if (rule.serviceOfferingId !== 'offering-e2e-valorant' || !['PERCENT_BPS', 'FIXED_MINOR'].includes(String(rule.type)) || !Number.isInteger(rule.value) || Number(rule.value) <= 0) throw new Error('INVALID_COMPENSATION');
      return { serviceOfferingId: String(rule.serviceOfferingId), type: rule.type as 'PERCENT_BPS' | 'FIXED_MINOR', value: Number(rule.value), currency: rule.type === 'FIXED_MINOR' ? 'CAT' as const : null, version: 1 };
    });
    compensationRules.splice(0, compensationRules.length, ...next);
    return { items: compensationRules };
  }
});

registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/orders/:orderId/participants', permission: 'order.read', action: 'READ_E2E_ORDER_PARTICIPANTS', targetType: 'order', acceptedSources: ['DASHBOARD'],
  handler: () => ({ items: orderParticipants.map((item) => ({ ...item })), derivedTotalMinor: orderParticipants.filter((item) => item.status === 'ACTIVE').reduce((sum, item) => sum + Number(item.linePriceMinor), 0), nextCursor: null })
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/orders/:orderId/requirements', permission: 'order.read', action: 'READ_E2E_ORDER_REQUIREMENTS', targetType: 'order', acceptedSources: ['DASHBOARD'],
  handler: () => ({ items: [], derivedTotalMinor: orderRecord.amountMinor, nextCursor: null })
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/orders/:orderId/participant-candidates', permission: 'order.read', action: 'READ_E2E_ORDER_PARTICIPANT_CANDIDATES', targetType: 'order', acceptedSources: ['DASHBOARD'],
  handler: () => ({ items: Array.from({ length: 9 }, (_, index) => ({ playerId: `player-e2e-${index + 1}`, discordUserId: `discord-player-${index + 1}`, displayName: `E2E 陪玩 ${index + 1}`, projects: [initialCatalog, alternateOrderCatalog] })), nextCursor: null })
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/orders/:orderId/participants', permission: 'order.resolve', action: 'ADD_E2E_ORDER_PARTICIPANT', targetType: 'order_participant', acceptedSources: ['DASHBOARD'], successStatusCode: 201,
  mapError: (error) => error instanceof Error && error.message === 'ORDER_CAPTURED' ? { statusCode: 409, code: 'ORDER_IMMUTABLE', message: 'Captured orders cannot be changed.' } : error instanceof Error && error.message === 'STALE_PARTICIPANT_ORDER' ? { statusCode: 409, code: 'VERSION_CONFLICT', message: 'The order version changed.' } : null,
  handler: (request) => {
    const body = request.body as { playerId?: unknown; serviceCatalogVersionId?: unknown; unitCount?: unknown; linePriceMinor?: unknown; expectedOrderVersion?: unknown };
    if (orderRecord.status === 'COMPLETED') throw new Error('ORDER_CAPTURED');
    if (body.expectedOrderVersion !== orderRecord.version) throw new Error('STALE_PARTICIPANT_ORDER');
    const catalog = [initialCatalog, alternateOrderCatalog].find((item) => item.id === body.serviceCatalogVersionId);
    if (!catalog || !Number.isSafeInteger(body.unitCount) || Number(body.unitCount) < 1 || !Number.isSafeInteger(body.linePriceMinor) || Number(body.linePriceMinor) < 1) throw new Error('INVALID_PARTICIPANT');
    const index = orderParticipants.length + 1;
    const record = { id: `participant-e2e-${index}`, playerId: String(body.playerId), discordUserId: `discord-${body.playerId}`, discordTag: `player${index}#0001`, displayName: `E2E 陪玩 ${index}`, serviceCatalogVersionId: catalog.id, game: catalog.game, gameDisplayName: catalog.gameDisplayName, service: catalog.service, serviceDisplayName: catalog.serviceDisplayName, region: catalog.region, regionDisplayName: catalog.regionDisplayName, billingUnitMinutes: catalog.billingUnitMinutes, unitCount: Number(body.unitCount), linePriceMinor: Number(body.linePriceMinor), compensationType: 'PERCENT_BPS', compensationValue: 6000, compensationSource: 'CATALOG_DEFAULT', expectedEarningMinor: Math.floor(Number(body.linePriceMinor) * 0.6), status: 'ACTIVE', readiness: 'NOT_READY', version: 1 };
    orderParticipants.push(record); orderRecord.version += 1; orderRecord.amountMinor = orderParticipants.filter((item) => item.status === 'ACTIVE').reduce((sum, item) => sum + Number(item.linePriceMinor), 0); reservationAmountMinor = orderRecord.amountMinor; return { participant: record, order: { ...orderRecord }, reservationAmountMinor };
  }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'PATCH', url: '/api/v1/admin/orders/:orderId/participants/:participantId', permission: 'order.resolve', action: 'UPDATE_E2E_ORDER_PARTICIPANT', targetType: 'order_participant', acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'ORDER_CAPTURED' ? { statusCode: 409, code: 'ORDER_IMMUTABLE', message: 'Captured orders cannot be changed.' } : error instanceof Error && error.message === 'STALE_PARTICIPANT_ORDER' ? { statusCode: 409, code: 'VERSION_CONFLICT', message: 'The order or participant version changed.' } : null,
  handler: (request) => {
    const participant = orderParticipants.find((item) => item.id === (request.params as { participantId: string }).participantId);
    const body = request.body as { expectedOrderVersion?: unknown; expectedParticipantVersion?: unknown; action?: unknown; serviceCatalogVersionId?: unknown; unitCount?: unknown; linePriceMinor?: unknown };
    if (orderRecord.status === 'COMPLETED') throw new Error('ORDER_CAPTURED');
    if (!participant || body.expectedOrderVersion !== orderRecord.version || body.expectedParticipantVersion !== participant.version) throw new Error('STALE_PARTICIPANT_ORDER');
    if (body.action === 'REMOVE') participant.status = 'REMOVED';
    else if (body.action === 'CHANGE_PRICE' && Number.isSafeInteger(body.linePriceMinor) && Number(body.linePriceMinor) > 0) participant.linePriceMinor = Number(body.linePriceMinor);
    else if (body.action === 'CHANGE_PROJECT') { const catalog = [initialCatalog, alternateOrderCatalog].find((item) => item.id === body.serviceCatalogVersionId); if (!catalog) throw new Error('INVALID_PARTICIPANT'); Object.assign(participant, { serviceCatalogVersionId: catalog.id, service: catalog.service, serviceDisplayName: catalog.serviceDisplayName, unitCount: Number(body.unitCount), linePriceMinor: Number(body.linePriceMinor) }); }
    else throw new Error('INVALID_PARTICIPANT');
    participant.version = Number(participant.version) + 1; orderRecord.version += 1; orderRecord.amountMinor = orderParticipants.filter((item) => item.status === 'ACTIVE').reduce((sum, item) => sum + Number(item.linePriceMinor), 0); reservationAmountMinor = orderRecord.amountMinor; return { participant: { ...participant }, order: { ...orderRecord }, reservationAmountMinor };
  }
});

registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/users/:userId', permission: 'user.read', action: 'GET_E2E_USER', targetType: 'user', acceptedSources: ['DASHBOARD'],
  handler: () => ({ ...userRecord, riskEvents: [...riskEvents] })
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/users/:userId/consumptions', permission: 'user.read', action: 'LIST_E2E_USER_CONSUMPTIONS', targetType: 'user', acceptedSources: ['DASHBOARD'],
  handler: () => ({ items: [{ id: 'consumption-e2e', type: 'ORDER', amountMinor: 4000, currency: 'USD', occurredAt: '2026-08-05T00:00:00.000Z' }], nextCursor: null })
});

registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'PUT', url: '/api/v1/admin/users/:userId/operational-status', permission: 'user.status.manage', action: 'UPDATE_E2E_USER_STATUS', targetType: 'user', targetId: () => userRecord.id, acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'STALE_USER' ? { statusCode: 409, code: 'VERSION_CONFLICT', message: 'The user version changed.' } : null,
  handler: (request) => {
    const body = request.body as { expectedVersion?: unknown; status?: unknown; reasonCode?: unknown };
    if (body.expectedVersion !== userRecord.version) throw new Error('STALE_USER');
    if (!['ACTIVE', 'PAUSED', 'SUSPENDED'].includes(String(body.status)) || typeof body.reasonCode !== 'string') throw new Error('INVALID_USER_STATUS');
    userRecord.operationalStatus = String(body.status);
    userRecord.version += 1;
    return { ...userRecord };
  }
});

registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/users/:userId/risk-events', permission: 'user.risk.manage', action: 'CREATE_E2E_RISK_EVENT', targetType: 'risk_event', acceptedSources: ['DASHBOARD'],
  handler: (request) => {
    const body = request.body as { type?: unknown; severity?: unknown; source?: unknown; notes?: unknown };
    if (![body.type, body.severity, body.source, body.notes].every((value) => typeof value === 'string' && value.length > 0)) throw new Error('INVALID_RISK_EVENT');
    const event = { type: String(body.type), severity: String(body.severity), source: String(body.source), notes: String(body.notes) };
    riskEvents.push(event);
    return { id: `risk-${riskEvents.length}`, ...event };
  }
});

for (const [url, payload] of [
  ['/api/v1/admin/support-shifts/me', null],
  ['/api/v1/admin/support/summary', { items: [{ staffId: staff.staffId, displayName: 'E2E L1', clockedIn: false, shiftSeconds: 0, handledTaskCount: 0, overdueTaskCount: 0, ratingCount: 0, averageRating: null }] }]
] as const) {
  registerSecureReadRoute(server, server.securityOptions!, { method: 'GET', url, permission: 'staff_task.read', action: `READ_E2E_${url.split('/').at(-1)}`, targetType: 'support', acceptedSources: ['DASHBOARD'], handler: () => payload });
}

registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/audit-logs', permission: 'audit.read', action: 'LIST_E2E_AUDIT_LOGS', targetType: 'audit_log', acceptedSources: ['DASHBOARD'],
  handler: (request) => {
    const cursor = (request.query as { cursor?: string }).cursor;
    const records = auditSink.records.map((record, index) => ({ id: `audit-${index + 1}`, actorId: record.actorStaffId ?? null, actorLevel: record.actorLevel ?? null, actorSource: record.actorSource ?? 'DASHBOARD', clientId: record.clientId ?? 'DASHBOARD', interactionId: record.interactionId ?? null, permissionCode: record.permissionCode ?? '', action: record.action, targetType: record.targetType, targetId: record.targetId ?? '', reason: record.reason ?? null, requestId: record.requestId, approvalRequestId: null, occurredAt: typeof record.occurredAt === 'string' ? record.occurredAt : new Date(record.occurredAt).toISOString() }));
    return cursor ? { items: records.slice(1), nextCursor: null } : { items: records.slice(0, 1), nextCursor: records.length > 1 ? 'audit-page-2' : null };
  }
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/jobs', permission: 'job.read', action: 'LIST_E2E_JOBS', targetType: 'job', acceptedSources: ['DASHBOARD'],
  handler: () => ({ items: Array.from(jobs.values()).filter((job) => job.status === 'FAILED'), nextCursor: null })
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/policy-settings', permission: 'policy.read', action: 'LIST_E2E_POLICIES', targetType: 'policy_setting', acceptedSources: ['DASHBOARD'], handler: () => ({ items: [{ ...policySetting }], nextCursor: null })
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'PUT', url: '/api/v1/admin/policy-settings/:key', permission: 'policy.manage', action: 'UPDATE_E2E_POLICY', targetType: 'policy_setting', acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'STALE_POLICY' ? { statusCode: 409, code: 'VERSION_CONFLICT', message: 'The policy version changed.' } : error instanceof Error && error.message === 'INVALID_POLICY' ? { statusCode: 422, code: 'VALIDATION_ERROR', message: 'The policy value is invalid.' } : null,
  handler: (request) => {
    const body = request.body as { expectedVersion?: unknown; integerValue?: unknown; currency?: unknown; reasonCode?: unknown };
    if (body.expectedVersion !== policySetting.version) throw new Error('STALE_POLICY');
    if (!Number.isSafeInteger(body.integerValue) || Number(body.integerValue) < 0 || body.currency !== 'CAT' || typeof body.reasonCode !== 'string') throw new Error('INVALID_POLICY');
    policySetting.integerValue = Number(body.integerValue); policySetting.version += 1; return { ...policySetting };
  }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/orders/:orderId/panel-repair', permission: 'job.retry', action: 'CREATE_E2E_PANEL_REPAIR', targetType: 'job', acceptedSources: ['DASHBOARD'],
  handler: (request) => {
    const id = `panel-repair-${jobs.size + 1}`;
    jobs.set(id, { id, type: 'PANEL_SYNC', status: 'FAILED', attempts: 0, lastError: null, runAfter: new Date().toISOString(), version: 1 });
    return { id, type: 'PANEL_SYNC', status: 'QUEUED' };
  }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/jobs/:jobId/retry', permission: 'job.retry', action: 'RETRY_E2E_JOB', targetType: 'job', targetId: (request) => String((request.params as { jobId: string }).jobId), acceptedSources: ['DASHBOARD'],
  handler: (request) => {
    const job = jobs.get(String((request.params as { jobId: string }).jobId));
    const body = request.body as { expectedVersion?: unknown; reasonCode?: unknown };
    if (!job || job.status !== 'FAILED' || body.expectedVersion !== job.version || typeof body.reasonCode !== 'string') throw new Error('JOB_RETRY_REJECTED');
    job.status = 'COMPLETED'; job.attempts += 1; job.lastError = null; job.version += 1;
    return { id: job.id, status: job.status, version: job.version };
  }
});

server.post('/__e2e/revoke-session', async () => { authStore.setCurrentPermissionsVersion(staff.staffId, 2); return { ok: true }; });
server.post('/__e2e/reset', async () => { resetState(); return { ok: true }; });
server.post('/__e2e/fault/:name', async (request) => { faults.add((request.params as { name: string }).name); return { ok: true }; });
server.post('/__e2e/advance-time', async (request) => { clockOffsetMs += Number((request.body as { milliseconds?: unknown })?.milliseconds ?? 0); return { now: fixtureNow().toISOString() }; });
server.post('/__e2e/capture-order', async () => { orderRecord.status = 'COMPLETED'; return { ...orderRecord }; });
server.get('/__e2e/totp/:actor', async (request, reply) => {
  const secret = actorTotpSecrets.get((request.params as { actor: string }).actor);
  return secret ? { proof: generateTotp(secret, fixtureNow()) } : reply.code(404).send({ error: 'unknown E2E TOTP actor' });
});
server.get('/__e2e/state', async () => ({ tasks: Array.from(tasks.values()), order: orderRecord, orderResolutionCount, orderParticipants, reservationAmountMinor, user: userRecord, riskEvents, walletBalance, walletEntries, player: playerRecord, compensationRules, businessTags, catalogRecords, packageRecords, giftRecords, giftRequestRecords, earningRecord, earningPaymentWrites, roleMapping, jobs: Array.from(jobs.values()), policySetting, auditCount: auditSink.records.length, audits: auditSink.records }));

await server.listen({ host, port });
