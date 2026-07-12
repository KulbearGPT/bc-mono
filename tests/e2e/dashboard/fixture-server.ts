import { createHmac } from 'node:crypto';
import multipart from '@fastify/multipart';
import { buildApiServer } from '../../../apps/api/src/server.ts';
import { InMemoryDashboardAuthStore, type DiscordOAuthProvider } from '../../../apps/api/src/dashboard-auth.ts';
import { InMemoryDashboardMetricsStore } from '../../../apps/api/src/dashboard-metrics.ts';
import { InMemoryAuditSink, registerSecureReadRoute, registerSecureWriteRoute, type StaffDirectory } from '../../../apps/api/src/security.ts';
import {InMemoryBotConfigStore} from '../../../apps/api/src/bot-config.ts';

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
const ownerReviewer = {
  staffId: '00000000-0000-0000-0000-000000000116', userId: '00000000-0000-0000-0000-000000000016', level: 'L4_ADMIN_OWNER' as const, permissionsVersion: 1, status: 'ACTIVE' as const
};
const mfaCandidate = {
  staffId: '00000000-0000-0000-0000-000000000115',
  userId: '00000000-0000-0000-0000-000000000015',
  level: 'L1_SUPPORT' as const,
  permissionsVersion: 1,
  status: 'ACTIVE' as const
};
const actors = { l1: staff, l2: supervisor, l3: operator, l4: owner, l4b: ownerReviewer, mfa: mfaCandidate } as const;

const authStore = new InMemoryDashboardAuthStore();
const auditSink = new InMemoryAuditSink();
const faults = new Set<string>();
let clockOffsetMs = 0;
let nextOAuthIsNonStaff = false;
const fixtureNow = () => new Date(Date.now() + clockOffsetMs);
type FixtureFeature = 'CORE_ORDER' | 'GIFTS' | 'REFERRALS' | 'M6';
const enabledFixtureFeatures: FixtureFeature[] = ['CORE_ORDER', 'GIFTS', 'REFERRALS', 'M6'];
const fixtureFeaturePolicy = { phase: 'OFF' as const, enabledFeatures: enabledFixtureFeatures, isEnabled: (feature: FixtureFeature) => enabledFixtureFeatures.includes(feature) };
type Job = { id: string; type: string; status: 'FAILED' | 'COMPLETED'; attempts: number; lastError: string | null; runAfter: string; version: number };
const initialJob: Job = { id: '00000000-0000-0000-0000-000000000401', type: 'PANEL_SYNC', status: 'FAILED', attempts: 1, lastError: 'Discord timeout', runAfter: '2026-08-05T00:00:00.000Z', version: 1 };
const nonRetryableJob: Job = { id: '00000000-0000-0000-0000-000000000402', type: 'SETTLEMENT_EXECUTION', status: 'FAILED', attempts: 1, lastError: 'External transfer is manual', runAfter: '2026-08-05T00:00:00.000Z', version: 1 };
const jobs = new Map<string, Job>();
const policySetting = { key: 'L2_REFUND_LIMIT_MINOR', integerValue: 50_000, currency: 'CAT' as string | null, version: 1 };
type StaffTask = {
  id: string; publicId: string; type: string; status: 'OPEN' | 'CLAIMED' | 'VERIFIED' | 'APPROVED' | 'REJECTED' | 'ESCALATED' | 'RESOLVED'; version: number;
  claimedBy: string | null; orderId: string | null; channelId: string | null; voiceChannelId: string | null; guildId: string; createdAt: string; notes: string[];
  giftRequestId?: string | null; resolutionCode?: string; resolutionNote?: string; resolvedBy?: string;
};
const initialTask: StaffTask = {
    id: '00000000-0000-0000-0000-000000000201', publicId: 'T-E2E-001', type: 'ORDER_ASSIST', status: 'OPEN', version: 1,
    claimedBy: null, orderId: '00000000-0000-0000-0000-000000000301', channelId: '1200000000000000011', voiceChannelId: null,
    guildId, createdAt: '2026-08-05T00:00:00.000Z', notes: []
};
const tasks = new Map<string, StaffTask>();
function projectSupportTask(task: StaffTask) {
  const order = bulkOrders.find((item) => item.id === task.orderId) ?? (task.orderId === orderRecord.id ? orderRecord : null);
  return {
    ...task,
    links: {
      orderChannel: task.channelId ? `https://discord.com/channels/${guildId}/${task.channelId}` : null,
      voiceChannel: task.voiceChannelId ? `https://discord.com/channels/${guildId}/${task.voiceChannelId}` : null
    },
    triage: {
      orderPublicId: order?.publicId ?? null,
      customerDisplayName: order?.customerDiscordId ?? null,
      gameDisplayName: '无畏契约', serviceDisplayName: '护航',
      amountMinor: order?.amountMinor ?? null, currency: order?.currency ?? null,
      reasonLabel: task.type === 'SERVICE_INTERRUPTION' ? '服务中断待处理' : task.type === 'CANCELLATION_ASSIST' ? '客户取消待处理' : '订单需要客服协助',
      waitStartedAt: task.createdAt,
      nextActionLabel: task.status === 'OPEN' ? '认领并联系双方' : '继续跟进并记录结果'
    },
    responseStatus: task.status === 'OPEN' ? 'PENDING' : 'MET',
    responseDueAt: task.status === 'OPEN' ? '2026-08-05T00:05:00.000Z' : null,
    firstRespondedAt: task.status === 'OPEN' ? null : '2026-08-05T00:01:00.000Z'
  };
}
const orderRecord = { id: '00000000-0000-0000-0000-000000000301', publicId: 'P-E2E-001', version: 3, status: 'ACCEPTED', customerDiscordId: 'customer-e2e', amountMinor: 4_000, currency: 'USD', createdAt: '2026-08-05T00:00:00.000Z' };
type BulkOrder = {
  id: string; publicId: string; version: number; status: string; customerDiscordId: string; amountMinor: number; currency: 'USD'; createdAt: string;
  guildId: string; playerEarningMinor: number; reservationStatus: 'ACTIVE' | 'CAPTURED' | 'RELEASED' | 'DISPUTED'; resolutionCount: number;
  refundMinor: number; earningMinor: number; resolutionReason: string | null;
};
const bulkOrders: BulkOrder[] = [];
let orderResolutionCount = 0;
const orderParticipants: Array<Record<string, unknown>> = [];
let reservationAmountMinor = 4_000;
const automationControl = {
  state: 'RUNNING' as 'RUNNING' | 'PAUSED', version: 1, pausedByStaffId: null as string | null,
  reasonCode: null as string | null, scope: null as string | null, expiresAt: null as string | null,
  resumeValidatedOrderVersion: null as number | null
};
let reservationCreateCount = 1;
const userRecord = { id: '00000000-0000-0000-0000-000000000501', discordUserId: 'customer-e2e', status: 'ACTIVE', operationalStatus: 'ACTIVE', version: 2, createdAt: '2026-08-01T00:00:00.000Z' };
const bulkUsers: Array<{ id: string; discordUserId: string; status: string; operationalStatus: string; version: number; createdAt: string }> = [];
const riskEvents: Array<{ type: string; severity: string; source: string; notes: string }> = [];
const walletBalance = { ledgerBalanceMinor: 10_000, reservedMinor: 2_500, availableMinor: 7_500, currency: 'USD' as const, calculatedAt: '2026-08-05T00:00:00.000Z', version: 1 };
const walletEntries: Array<{ id: string; entryType: string; direction: 'CREDIT' | 'DEBIT'; amountMinor: number; currency: 'USD'; sourceType: string; sourceId: string; reversalOfEntryId?:string|null; occurredAt: string }> = [];
const receiptAttachments: Array<{ id: string; evidenceId: string; mediaType: string; originalFileName: string; private: true }> = [];
const profileNotes: Array<{ id: string; text: string; createdAt: string; authorStaffId: string }> = [];
const playerRecord = { id: 'profile-e2e', playerId: '00000000-0000-0000-0000-000000000601', displayName: 'E2E 陪玩', reviewStatus: 'PENDING_REVIEW', availability: 'OFFLINE', version: 1, gameTags: [] as string[], serviceTags: [] as string[], languageTags: [] as string[], gameTagIds: [] as string[], serviceTagIds: [] as string[], languageTagIds: [] as string[], createdAt: '2026-08-02T00:00:00.000Z' };
const bulkPlayers: Array<Record<string, unknown>> = [];
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
let giftReservationCaptureCount = 0;
let giftReservationReleaseCount = 0;
const roleMapping = { guildId, discordRoleId: 'role-e2e-l4', targetLevel: 'L4_ADMIN_OWNER', enabled: true, version: 1, reconciliationQueued: false };
const settlementBatches: Array<Record<string, unknown>> = [];
const weeklyReports: Array<Record<string, unknown>> = [];
const outboxMessages: Array<{ id: string; status: 'PENDING' | 'COMPLETED'; attempts: number }> = [];
let workerRunning = true;
let workerSideEffectCount = 0;
let apiRuntimeEpoch = 1;
let workerRuntimeEpoch = 1;

function resetState() {
  clockOffsetMs = 0;
  nextOAuthIsNonStaff = false;
  enabledFixtureFeatures.splice(0, enabledFixtureFeatures.length, 'CORE_ORDER', 'GIFTS', 'REFERRALS', 'M6');
  tasks.clear();
  tasks.set(initialTask.id, { ...initialTask, notes: [] });
  jobs.clear();
  jobs.set(initialJob.id, { ...initialJob });
  jobs.set(nonRetryableJob.id, { ...nonRetryableJob });
  Object.assign(policySetting, { integerValue: 50_000, currency: 'CAT', version: 1 });
  Object.assign(orderRecord, { version: 3, status: 'ACCEPTED', amountMinor: 4_000 });
  bulkOrders.length = 0;
  orderResolutionCount = 0;
  orderParticipants.length = 0;
  reservationAmountMinor = 4_000;
  Object.assign(automationControl, { state: 'RUNNING', version: 1, pausedByStaffId: null, reasonCode: null, scope: null, expiresAt: null, resumeValidatedOrderVersion: null });
  reservationCreateCount = 1;
  Object.assign(userRecord, { status: 'ACTIVE', operationalStatus: 'ACTIVE', version: 2 });
  bulkUsers.length = 0;
  riskEvents.length = 0;
  Object.assign(walletBalance, { ledgerBalanceMinor: 10_000, reservedMinor: 2_500, availableMinor: 7_500, version: 1 });
  walletEntries.length = 0;
  receiptAttachments.length = 0;
  profileNotes.length = 0;
  Object.assign(playerRecord, { reviewStatus: 'PENDING_REVIEW', availability: 'OFFLINE', version: 1, gameTags: [], serviceTags: [], languageTags: [], gameTagIds: [], serviceTagIds: [], languageTagIds: [] });
  bulkPlayers.length = 0;
  compensationRules.length = 0;
  businessTags.splice(0, businessTags.length, ...initialBusinessTags.map((tag) => ({ ...tag })));
  catalogRecords.splice(0, catalogRecords.length, { ...initialCatalog });
  packageRecords.splice(0, packageRecords.length, ...initialPackages.map((item) => ({ ...item, slots: item.slots.map((slot) => ({ ...slot })) })));
  giftRecords.splice(0, giftRecords.length, { ...initialGift });
  giftRequestRecords.splice(0, giftRequestRecords.length, { id: '00000000-0000-0000-0000-000000000704', publicId: 'G-E2E-001', status: 'CAPTURED', amountMinor: 1000, currency: 'CAT', giftCatalogId: initialGift.id, giftCatalogVersionId: initialGift.id, giftName: initialGift.name, giftCode: 'STARLIGHT', broadcastTemplate: initialGift.broadcastTemplate, orderId: orderRecord.id, orderPublicId: orderRecord.publicId, senderDisplayName: 'E2E 用户', senderDiscordUserId: userRecord.discordUserId, receiverDisplayName: playerRecord.displayName, receiverDiscordUserId: 'player-discord-e2e', verifiedByStaffId: 'staff-l2', verifiedAt: '2026-08-05T01:04:00.000Z', approvedByStaffId: 'staff-l2', approvedAt: '2026-08-05T01:05:00.000Z', capturedAt: '2026-08-05T01:06:00.000Z', createdAt: '2026-08-05T01:00:00.000Z', updatedAt: '2026-08-05T01:06:00.000Z', rowVersion: 3 });
  Object.assign(earningRecord, { status: 'PENDING', version: 1, confirmedAt: null, paidAt: null });
  earningPaymentWrites = 0;
  giftReservationCaptureCount = 0;
  giftReservationReleaseCount = 0;
  Object.assign(roleMapping, { discordRoleId: 'role-e2e-l4', enabled: true, version: 1, reconciliationQueued: false });
  settlementBatches.length = 0;
  weeklyReports.splice(0, weeklyReports.length, { id: 'weekly-report-e2e-1', publicId: 'R-E2E-001', status: 'CURRENT', periodStart: '2026-07-27T00:00:00.000Z', periodEnd: '2026-08-03T00:00:00.000Z', currency: 'USD', currentRevision: 1, metrics: { orderRevenueMinor: 10_000, giftRevenueMinor: 2_000, adjustmentsMinor: -500, netPayableMinor: 11_500 } });
  outboxMessages.length = 0; workerRunning = true; workerSideEffectCount = 0; apiRuntimeEpoch = 1; workerRuntimeEpoch = 1;
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
for (const [key, actor] of [['l3', operator], ['l4', owner], ['l4b', ownerReviewer]] as const) {
  const enrollment = authStore.beginMfaEnrollment({ staffId: actor.staffId, accountName: `${actor.level}@e2e` });
  const secret = new URL(enrollment.provisioningUri).searchParams.get('secret');
  if (!secret) throw new Error('E2E MFA enrollment did not return a TOTP secret.');
  authStore.verifyMfaEnrollment({ staffId: actor.staffId, enrollmentId: enrollment.enrollmentId, proof: generateTotp(secret) });
  actorTotpSecrets.set(key, secret);
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

const botConfigStore=new InMemoryBotConfigStore({snapshots:[{guildId,version:1,values:{dispatch_channel_id:'1200000000000000041',dispatch_timeout_minutes:5,new_orders_enabled:true,gift_broadcast_template:'{sender} 送给 {receiver} {gift}',staff_l4_role_id:'1200000000000000099'},updatedByStaffId:null,updatedAt:'2026-08-05T00:00:00.000Z'}]});

const server = buildApiServer({
  env: {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused', API_PORT: String(port), API_BASE_URL: `http://${host}:${port}`,
    BOT_SERVICE_TOKEN: 'dashboard-e2e-bot-token', PAGINATION_CURSOR_SIGNING_SECRET: 'dashboard-e2e-pagination-secret-which-is-long-enough'
  },
  security: { staffDirectory: directory, dashboardSessions: authStore, auditSink, businessEnvironment: 'SANDBOX', pilotFeaturePolicy: fixtureFeaturePolicy },
  dashboardAuth: { store: authStore, oauth, staffDirectory: directory, guildId, dashboardUrl, secureCookies: false, now: fixtureNow },
  dashboardMetrics: { store: new InMemoryDashboardMetricsStore({ facts: { todayOrderCount: 1, inProgressOrderCount: 1, pendingStaffTaskCount: 1, completedOrderNetConsumptionMinor: 12_500, giftNetConsumptionMinor: 0, activeReservedMinor: 4_000, dispatchAcceptedCount: 19, dispatchStartedCount: 20, exceptionCount: 0 } }) },
  botConfig:{store:botConfigStore,validationSecret:'dashboard-e2e-bot-config-validation-secret-0001',discord:{async validateObject(){return{ok:true as const};},async sendTestMessage(){return{messageId:'bot-config-test-message-1'};}}}
});
server.register(multipart, { limits: { fileSize: 1_048_576, files: 1, fields: 2 } });

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
  handler: (_request, actor) => ({ items: Array.from(tasks.values()).filter((task) => task.guildId === actor.guildId).map(({ notes: _notes, ...task }) => projectSupportTask(task)), nextCursor: null })
});

registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/users/:userId/profile-summary', permission: 'customer_profile.read', action: 'GET_E2E_PROFILE_SUMMARY', targetType: 'customer_profile', acceptedSources: ['DASHBOARD'],
  handler: (request) => ({ user: { id: userRecord.id, userId: userRecord.id, discordUserId: userRecord.discordUserId, status: userRecord.status }, balance: { ...walletBalance }, statistics: { window: (request.query as { window?: string }).window, completedOrderCount: 2, orderSpendMinor: 8_000, giftSpendMinor: 1_000, totalConsumptionMinor: 9_000, currency: 'USD' }, preferences: { language: 'zh-CN' }, internalNotes: profileNotes.map(({ authorStaffId: _authorStaffId, ...note }) => note), riskFlags: [] })
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/users/:userId/profile-notes', permission: 'customer_profile.note.append', action: 'APPEND_E2E_PROFILE_NOTE', targetType: 'customer_profile_note', acceptedSources: ['DASHBOARD'], successStatusCode: 201,
  handler: (request, actor) => { const body = String((request.body as { body?: unknown })?.body ?? '').trim(); if (!body || body.length > 2000) throw new Error('INVALID_PROFILE_NOTE');
    const note = { id: `profile-note-${profileNotes.length + 1}`, text: body, createdAt: fixtureNow().toISOString(), authorStaffId: actor.actorStaffId! }; profileNotes.unshift(note); return { id: note.id, text: note.text, createdAt: note.createdAt }; }
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/users/:userId/orders', permission: 'customer_profile.read', action: 'LIST_E2E_PROFILE_ORDERS', targetType: 'customer_profile', acceptedSources: ['DASHBOARD'],
  handler: (request) => (request.query as { cursor?: string }).cursor ? { items: [{ id: 'profile-order-2', publicId: 'P-PROFILE-002', status: 'COMPLETED', amountMinor: 2500, currency: 'USD', createdAt: '2026-08-04T00:00:00.000Z' }], nextCursor: null } : { items: [{ id: orderRecord.id, publicId: orderRecord.publicId, status: orderRecord.status, amountMinor: orderRecord.amountMinor, currency: 'USD', createdAt: orderRecord.createdAt }], nextCursor: 'profile-orders-2' }
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/users/:userId/wallet', permission: 'wallet.read', action: 'GET_E2E_WALLET', targetType: 'wallet', acceptedSources: ['DASHBOARD'], handler: () => { if (faults.has('wallet')) throw new Error('E2E_WALLET_FAILURE'); return { ...walletBalance }; }
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/users/:userId/wallet/entries', permission: 'wallet.read', action: 'LIST_E2E_WALLET_ENTRIES', targetType: 'wallet_entry', acceptedSources: ['DASHBOARD'], handler: () => { if (faults.has('wallet')) throw new Error('E2E_WALLET_FAILURE'); return [...walletEntries]; }
});

registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/users/:userId/top-ups', permission: 'wallet.top_up', action: 'CREATE_E2E_TOP_UP', targetType: 'wallet_entry', acceptedSources: ['DASHBOARD'],
  handler: (request) => {
    const body = request.body as { paidAmountUsdCents?: unknown; paidCurrency?: unknown; paymentMethod?: unknown; receiptNumber?: unknown; paidAt?: unknown; note?: unknown; reasonCode?: unknown };
    if (!Number.isSafeInteger(body.paidAmountUsdCents) || Number(body.paidAmountUsdCents) <= 0 || body.paidCurrency !== 'USD' || !body.receiptNumber || !body.paidAt || !body.note || !body.reasonCode) throw new Error('INVALID_TOP_UP');
    const amountMinor = Number(body.paidAmountUsdCents);
    const entry = { id: `wallet-${walletEntries.length + 1}`, entryType: 'MANUAL_TOP_UP', direction: 'CREDIT' as const, amountMinor, currency: 'USD' as const, sourceType: 'STAFF_TOP_UP', sourceId: String(body.receiptNumber), occurredAt: String(body.paidAt) };
    walletEntries.push(entry); walletBalance.ledgerBalanceMinor += amountMinor; walletBalance.availableMinor += amountMinor; walletBalance.version += 1;
    return entry;
  }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/users/:userId/receipt-attachments', permission: 'wallet.top_up', action: 'CREATE_E2E_RECEIPT_ATTACHMENT', targetType: 'receipt_attachment', acceptedSources: ['DASHBOARD'], successStatusCode: 201,
  handler: async (request) => { let evidenceId = ''; let mediaType = ''; let originalFileName = ''; for await (const part of request.parts()) { if (part.type === 'field' && part.fieldname === 'evidenceId') evidenceId = String(part.value); if (part.type === 'file') { mediaType = part.mimetype; originalFileName = part.filename; for await (const _chunk of part.file) { /* consume private fixture bytes */ } } } if (!evidenceId || !mediaType) throw new Error('INVALID_RECEIPT'); const attachment = { id: `receipt-attachment-${receiptAttachments.length + 1}`, evidenceId, mediaType, originalFileName, private: true as const }; receiptAttachments.push(attachment); return attachment; }
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
    const entry = { id: `wallet-${walletEntries.length + 1}`, entryType: 'EXTERNAL_REFUND_DEBIT', direction: 'DEBIT' as const, amountMinor, currency: 'USD' as const, sourceType: 'EXTERNAL_REFUND', sourceId: String(body.externalTransactionId), occurredAt: String(body.refundedAt) };
    walletEntries.push(entry); walletBalance.ledgerBalanceMinor -= amountMinor; walletBalance.availableMinor -= amountMinor; walletBalance.version += 1;
    return entry;
  }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method:'POST',url:'/api/v1/admin/users/:userId/wallet-adjustments',permission:'wallet.adjust',action:'CREATE_E2E_WALLET_ADJUSTMENT',targetType:'wallet_entry',acceptedSources:['DASHBOARD'],successStatusCode:201,
  mapError:(error)=>error instanceof Error&&error.message==='STALE_WALLET'?{statusCode:409,code:'VERSION_CONFLICT',message:'The wallet version changed.'}:null,
  handler:(request)=>{const body=request.body as {entryType?:unknown;amountMinor?:unknown;reversalOfEntryId?:unknown;reason?:unknown;expectedWalletVersion?:unknown};
    if(body.expectedWalletVersion!==walletBalance.version)throw new Error('STALE_WALLET');const original=walletEntries.find((entry)=>entry.id===body.reversalOfEntryId);if(!original)throw new Error('MISSING_ORIGINAL');
    const amountMinor=Number(body.amountMinor);const direction=body.entryType==='ADJUSTMENT_CREDIT'?'CREDIT':'DEBIT';if(!Number.isSafeInteger(amountMinor)||amountMinor<=0||!String(body.reason??'').trim()||direction==='DEBIT'&&amountMinor>walletBalance.availableMinor)throw new Error('INVALID_ADJUSTMENT');
    const entry={id:`wallet-${walletEntries.length+1}`,entryType:String(body.entryType),direction,amountMinor,currency:'USD' as const,sourceType:'WALLET_ADJUSTMENT',sourceId:`adjustment-${walletEntries.length+1}`,reversalOfEntryId:original.id,occurredAt:'2026-08-05T11:00:00.000Z'};walletEntries.push(entry);
    const delta=direction==='CREDIT'?amountMinor:-amountMinor;walletBalance.ledgerBalanceMinor+=delta;walletBalance.availableMinor+=delta;walletBalance.version+=1;return entry;}
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
  method: 'POST', url: '/api/v1/admin/staff-tasks/:taskId/resolve', permission: 'staff_task.resolve', action: 'RESOLVE_E2E_STAFF_TASK', targetType: 'staff_task',
  targetId: (request) => String((request.params as { taskId: string }).taskId), acceptedSources: ['DASHBOARD'],
  handler: (request, actor) => {
    const task = tasks.get(String((request.params as { taskId: string }).taskId));
    const body = request.body as { expectedVersion?: unknown; resolutionCode?: unknown; notes?: unknown };
    if (!task || task.status !== 'CLAIMED' || body.expectedVersion !== task.version || body.resolutionCode !== 'UNDERLYING_ACTION_COMPLETED' || typeof body.notes !== 'string' || !body.notes.trim()) throw new Error('TASK_RESOLUTION_REJECTED');
    task.status = 'RESOLVED'; task.version += 1; task.resolutionCode = body.resolutionCode; task.resolutionNote = body.notes.trim(); task.resolvedBy = actor.actorStaffId!;
    return { id: task.id, status: task.status, version: task.version, resolvedBy: task.resolvedBy };
  }
});

registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/staff-tasks/:taskId/verify', permission: 'staff_task.verify', action: 'VERIFY_E2E_GIFT_TASK', targetType: 'staff_task', acceptedSources: ['DASHBOARD'],
  handler: (request, actor) => {
    const task = tasks.get(String((request.params as { taskId: string }).taskId));
    const body = request.body as { expectedVersion?: unknown; verificationMethod?: unknown; notes?: unknown };
    const gift = giftRequestRecords.find((item) => item.id === task?.giftRequestId);
    if (!task || task.type !== 'GIFT_REVIEW' || task.status !== 'CLAIMED' || task.claimedBy !== actor.actorStaffId || task.version !== body.expectedVersion || !['ORDER_CHANNEL', 'DIRECT_MESSAGE', 'VOICE'].includes(String(body.verificationMethod)) || typeof body.notes !== 'string' || !body.notes.trim() || !gift || gift.status !== 'PENDING_REVIEW') throw new Error('GIFT_VERIFICATION_REJECTED');
    task.status = 'VERIFIED'; task.version += 1; gift.verifiedByStaffId = actor.actorStaffId; gift.verifiedAt = fixtureNow().toISOString(); gift.verificationNote = body.notes.trim(); gift.rowVersion = Number(gift.rowVersion) + 1;
    return { status: task.status, giftRequestId: gift.id, executionCredential: { payloadHash: 'e2e-gift-payload-hash', expiresAt: new Date(fixtureNow().getTime() + 900_000).toISOString() } };
  }
});

registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/gift-requests/:giftRequestId/approve', permission: 'gift.approve', action: 'APPROVE_E2E_GIFT_REQUEST', targetType: 'gift_request', acceptedSources: ['DASHBOARD'],
  handler: (request, actor) => {
    const id = String((request.params as { giftRequestId: string }).giftRequestId);
    const gift = giftRequestRecords.find((item) => item.id === id);
    const task = Array.from(tasks.values()).find((item) => item.giftRequestId === id);
    const body = request.body as { expectedVersion?: unknown; reason?: unknown };
    if (!gift || !task || task.status !== 'VERIFIED' || gift.status !== 'PENDING_REVIEW' || gift.rowVersion !== body.expectedVersion || typeof body.reason !== 'string' || !body.reason.trim()) throw new Error('GIFT_APPROVAL_REJECTED');
    gift.status = 'CAPTURED'; gift.reservationStatus = 'CAPTURED'; gift.approvedByStaffId = actor.actorStaffId; gift.approvedAt = fixtureNow().toISOString(); gift.capturedAt = fixtureNow().toISOString(); gift.rowVersion = Number(gift.rowVersion) + 1;
    task.status = 'APPROVED'; task.version += 1; giftReservationCaptureCount += 1;
    return { status: 'CAPTURED', giftRequestId: id, reservation: { status: 'CAPTURED' }, chargeOutcome: { status: 'SUCCEEDED' } };
  }
});

registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/gift-requests/:giftRequestId/reject', permission: 'gift.reject', action: 'REJECT_E2E_GIFT_REQUEST', targetType: 'gift_request', acceptedSources: ['DASHBOARD'],
  handler: (request, actor) => {
    const id = String((request.params as { giftRequestId: string }).giftRequestId);
    const gift = giftRequestRecords.find((item) => item.id === id);
    const task = Array.from(tasks.values()).find((item) => item.giftRequestId === id);
    const body = request.body as { expectedVersion?: unknown; reason?: unknown };
    if (!gift || !task || task.status !== 'VERIFIED' || gift.status !== 'PENDING_REVIEW' || gift.rowVersion !== body.expectedVersion || typeof body.reason !== 'string' || !body.reason.trim()) throw new Error('GIFT_REJECTION_REJECTED');
    gift.status = 'REJECTED'; gift.reservationStatus = 'RELEASED'; gift.rejectedReason = body.reason.trim(); gift.rowVersion = Number(gift.rowVersion) + 1;
    task.status = 'REJECTED'; task.version += 1; task.resolvedBy = actor.actorStaffId!; giftReservationReleaseCount += 1;
    return { status: 'REJECTED', reason: gift.rejectedReason };
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

registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/settlement-batches', permission: 'settlement.read', action: 'LIST_E2E_SETTLEMENTS', targetType: 'settlement_batch', acceptedSources: ['DASHBOARD'], handler: () => ({ items: settlementBatches })
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/settlement-batches/preview', permission: 'settlement.manage', action: 'PREVIEW_E2E_SETTLEMENT', targetType: 'settlement_batch', acceptedSources: ['DASHBOARD'],
  handler: (request) => { const body = request.body as { periodStart?: unknown }; return String(body.periodStart).startsWith('2099') ? { items: [], metrics: { netPayableMinor: 0 } } : { id: 'settlement-preview', publicId: 'PREVIEW', status: 'PREVIEW', periodStart: body.periodStart, periodEnd: (request.body as Record<string, unknown>).periodEnd, currency: 'USD', netAmountMinor: 4000, items: [{ id: 'preview-item', netAmountMinor: 4000 }] }; }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/settlement-batches', permission: 'settlement.manage', action: 'CREATE_E2E_SETTLEMENT', targetType: 'settlement_batch', acceptedSources: ['DASHBOARD'], successStatusCode: 201,
  handler: (request, actor) => { const body = request.body as { periodStart?: unknown; periodEnd?: unknown; cutoffAt?: unknown; currency?: unknown }; if (body.currency !== 'CAT' && body.currency !== 'USD') throw new Error('INVALID_SETTLEMENT'); const high = String(body.periodStart).includes('2026-09'); const index = settlementBatches.length + 1; const record = { id: `settlement-e2e-${index}`, publicId: `S-E2E-${String(index).padStart(3, '0')}`, status: 'DRAFT', periodStart: body.periodStart, periodEnd: body.periodEnd, cutoffAt: body.cutoffAt, currency: body.currency, netAmountMinor: high ? 600_000 : 4_000, version: 1, createdByStaffId: actor.actorStaffId, approvedByStaffId: null, sourceLocked: false, replacementBatchId: null, items: [{ id: `settlement-item-${index}-1`, playerDisplayName: 'E2E 陪玩 A', netAmountMinor: high ? 350_000 : 2500, paymentStatus: 'UNREGISTERED', version: 1 }, { id: `settlement-item-${index}-2`, playerDisplayName: 'E2E 陪玩 B', netAmountMinor: high ? 250_000 : 1500, paymentStatus: 'UNREGISTERED', version: 1 }] }; settlementBatches.push(record); return record; }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/settlement-batches/:batchId/submit', permission: 'settlement.manage', action: 'SUBMIT_E2E_SETTLEMENT', targetType: 'settlement_batch', acceptedSources: ['DASHBOARD'],
  handler: (request) => { const batch = settlementBatches.find((item) => item.id === (request.params as { batchId: string }).batchId); const body = request.body as { expectedVersion?: unknown }; if (!batch || batch.status !== 'DRAFT' || batch.version !== body.expectedVersion) throw new Error('STALE_SETTLEMENT'); batch.status = 'PENDING_REVIEW'; batch.version = Number(batch.version) + 1; batch.sourceLocked = true; return { ...batch }; }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/settlement-batches/:batchId/approve', permission: 'settlement.approve', action: 'APPROVE_E2E_SETTLEMENT', targetType: 'settlement_batch', acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'SELF_APPROVAL' ? { statusCode: 403, code: 'SEPARATION_OF_DUTIES', message: 'The creator cannot approve this high-value batch.' } : null,
  handler: (request, actor) => { const batch = settlementBatches.find((item) => item.id === (request.params as { batchId: string }).batchId); const body = request.body as { expectedVersion?: unknown }; if (!batch || batch.status !== 'PENDING_REVIEW' || batch.version !== body.expectedVersion) throw new Error('STALE_SETTLEMENT'); if (Number(batch.netAmountMinor) >= 500_000 && batch.createdByStaffId === actor.actorStaffId) throw new Error('SELF_APPROVAL'); batch.status = 'APPROVED'; batch.version = Number(batch.version) + 1; batch.approvedByStaffId = actor.actorStaffId; return { ...batch }; }
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/settlement-batches/:batchId/exports/:exportType', permission: 'settlement.manage', action: 'EXPORT_E2E_SETTLEMENT', targetType: 'settlement_batch', acceptedSources: ['DASHBOARD'],
  handler: (request) => { const batch = settlementBatches.find((item) => item.id === (request.params as { batchId: string }).batchId); if (!batch) throw new Error('MISSING_SETTLEMENT'); if (batch.status === 'APPROVED') { batch.status = 'EXPORTED'; batch.version = Number(batch.version) + 1; } return `settlement_item_id,player,amount_minor,currency\n${(batch.items as Array<Record<string, unknown>>).map((item) => `${item.id},${item.playerDisplayName},${item.netAmountMinor},${batch.currency}`).join('\n')}\nTOTAL,,${batch.netAmountMinor},${batch.currency}\n`; },
  rawResponse: (payload, reply) => { reply.header('content-disposition', 'attachment; filename="settlement-transfer-list.csv"'); reply.type('text/csv; charset=utf-8'); return reply.send(`\uFEFF${String(payload)}`); }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/settlement-batches/:batchId/payment-results', permission: 'settlement.manage', action: 'REGISTER_E2E_SETTLEMENT_PAYMENTS', targetType: 'settlement_batch', acceptedSources: ['DASHBOARD'],
  handler: (request) => { const batch = settlementBatches.find((item) => item.id === (request.params as { batchId: string }).batchId); const body = request.body as { expectedBatchVersion?: unknown; results?: Array<{ settlementItemId?: unknown; expectedVersion?: unknown; result?: unknown; note?: unknown }> }; if (!batch || batch.version !== body.expectedBatchVersion || !Array.isArray(body.results)) throw new Error('STALE_SETTLEMENT'); for (const result of body.results) { const item = (batch.items as Array<Record<string, unknown>>).find((value) => value.id === result.settlementItemId); if (!item || item.version !== result.expectedVersion || item.paymentStatus !== 'UNREGISTERED') throw new Error('STALE_SETTLEMENT_PAYMENT'); item.paymentStatus = result.result; item.paymentNote = result.note; item.version = Number(item.version) + 1; } batch.status = (batch.items as Array<Record<string, unknown>>).every((item) => item.paymentStatus === 'SUCCEEDED') ? 'PAID' : 'PARTIALLY_PAID'; batch.version = Number(batch.version) + 1; return { ...batch }; }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/settlement-batches/:batchId/void', permission: 'settlement.void', action: 'VOID_E2E_SETTLEMENT', targetType: 'settlement_batch', acceptedSources: ['DASHBOARD'], requiresRecentStepUp: true,
  mapError: (error) => error instanceof Error && error.message === 'INVALID_REPLACEMENT' ? { statusCode: 422, code: 'INVALID_REPLACEMENT', message: 'Replacement must be same Guild/currency and acyclic.' } : null,
  handler: (request) => { const batch = settlementBatches.find((item) => item.id === (request.params as { batchId: string }).batchId); const body = request.body as { expectedVersion?: unknown; replacementBatchId?: unknown; replacement?: { guildId?: unknown; currency?: unknown } }; const replacement = settlementBatches.find((item) => item.id === body.replacementBatchId); if (!batch || batch.version !== body.expectedVersion || !['APPROVED', 'EXPORTED'].includes(String(batch.status))) throw new Error('STALE_SETTLEMENT'); if (!replacement || replacement.id === batch.id || replacement.currency !== batch.currency || body.replacement?.guildId !== guildId || body.replacement?.currency !== batch.currency || replacement.replacementBatchId === batch.id) throw new Error('INVALID_REPLACEMENT'); batch.status = 'VOID'; batch.replacementBatchId = replacement.id; batch.version = Number(batch.version) + 1; return { ...batch }; }
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/weekly-reports', permission: 'weekly_report.read', action: 'LIST_E2E_WEEKLY_REPORTS', targetType: 'weekly_report', acceptedSources: ['DASHBOARD'], handler: () => ({ items: weeklyReports })
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/weekly-reports/:reportId/export', permission: 'weekly_report.read', action: 'EXPORT_E2E_WEEKLY_REPORT', targetType: 'weekly_report', acceptedSources: ['DASHBOARD'], handler: () => 'period_start,period_end,order_revenue_minor,gift_revenue_minor,adjustments_minor,net_payable_minor,currency\n2026-07-27,2026-08-03,10000,2000,-500,11500,USD\n', rawResponse: (payload, reply) => { reply.type('text/csv; charset=utf-8'); return reply.send(`\uFEFF${String(payload)}`); }
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
    const requestedId = String((request.params as { orderId: string }).orderId);
    const currentOrder = bulkOrders.find((item) => item.id === requestedId) ?? orderRecord;
    const timeline = query.timelineCursor
      ? { items: [{ id: 'evt-2', type: 'FUND_RESERVED', status: 'COMPLETED', direction: 'DEBIT', amountMinor: 4000, currency: 'USD', occurredAt: '2026-08-05T00:01:00.000Z' }], nextCursor: null }
      : { items: [{ id: 'evt-1', type: 'ORDER_ACCEPTED', status: 'COMPLETED', direction: 'INFO', amountMinor: null, currency: null, occurredAt: '2026-08-05T00:00:00.000Z' }], nextCursor: 'timeline-2' };
    const automation = bulkOrders.length
      ? { state: 'PAUSED', version: 1, pausedByStaffId: null, reasonCode: 'SUPPORT_REVIEW', scope: 'ALL', expiresAt: null }
      : { ...automationControl };
    return { order: { ...currentOrder, game: 'valorant', gameDisplayName: '无畏契约', service: 'escort', serviceDisplayName: '护航' }, readiness: { customer: 'READY', player: currentOrder.status === 'IN_SERVICE' ? 'READY' : 'PENDING', bothReady: currentOrder.status === 'IN_SERVICE' }, automation, matching: { stage: currentOrder.status, nextStep: currentOrder.status === 'IN_SERVICE' ? 'SUPPORT_RESOLUTION' : 'WAIT_FOR_READINESS' }, timeline };
  }
});
registerSecureReadRoute(server,server.securityOptions!,{
  method:'GET',url:'/api/v1/admin/orders/:orderId/transcript',permission:'order.read',action:'LIST_E2E_ORDER_TRANSCRIPT',targetType:'order',acceptedSources:['DASHBOARD'],
  handler:(request)=>{const query=request.query as {cursor?:string};const rows=[
    {eventId:'e2e-transcript-1',messageId:'1533615770179866746',eventType:'CREATED',authorDisplayName:'老板小陈',content:'玩到一半突然掉线，麻烦客服协助。',replyToMessageId:null,attachmentMetadata:[{name:'disconnect.png',contentType:'image/png'}],occurredAt:'2026-08-05T01:10:00.000Z',deleted:false},
    {eventId:'e2e-transcript-2',messageId:'1533615770179866747',eventType:'CREATED',authorDisplayName:'陪玩阿青',content:'收到，我先暂停计时并等客服处理。',replyToMessageId:'1533615770179866746',attachmentMetadata:[],occurredAt:'2026-08-05T01:10:30.000Z',deleted:false},
    {eventId:'e2e-transcript-3',messageId:'1533615770179866748',eventType:'DELETED',authorDisplayName:'老板小陈',content:'旧消息',replyToMessageId:null,attachmentMetadata:[],occurredAt:'2026-08-05T01:11:00.000Z',deleted:true}
  ];const offset=query.cursor?2:0;return{items:rows.slice(offset,offset+2),nextCursor:offset===0?'transcript-page-2':null};}
});

registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/orders/:orderId/resolve', permission: 'order.resolve', action: 'RESOLVE_E2E_ORDER', targetType: 'order', targetId: (request) => String((request.params as { orderId: string }).orderId), acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'STALE_ORDER' ? { statusCode: 409, code: 'VERSION_CONFLICT', message: 'The order version changed.' } : error instanceof Error && error.message === 'TERMINAL_ORDER' ? { statusCode: 409, code: 'ORDER_STATE_CONFLICT', message: 'The order cannot be resolved from its current state.' } : error instanceof Error && error.message === 'INVALID_RESOLUTION' ? { statusCode: 422, code: 'RESOLUTION_REJECTED', message: 'The resolution amount exceeds the allowed order facts.' } : null,
  handler: (request) => {
    const orderId = String((request.params as { orderId: string }).orderId);
    const bulkOrder = bulkOrders.find((item) => item.id === orderId);
    const currentOrder = bulkOrder ?? (orderId === orderRecord.id ? orderRecord : null);
    const body = request.body as { expectedVersion?: unknown; targetStatus?: unknown; refund?: { amountMinor?: unknown; currency?: unknown }; playerEarning?: { amountMinor?: unknown; currency?: unknown } };
    if (!currentOrder || body.expectedVersion !== currentOrder.version) throw new Error('STALE_ORDER');
    if (!['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION', 'EXCEPTION'].includes(currentOrder.status)) throw new Error('TERMINAL_ORDER');
    if (body.targetStatus !== 'CANCELLED' || body.refund?.currency !== 'USD' || body.playerEarning?.currency !== 'USD' || !Number.isSafeInteger(body.refund.amountMinor) || Number(body.refund.amountMinor) > currentOrder.amountMinor) throw new Error('INVALID_RESOLUTION');
    currentOrder.status = 'CANCELLED';
    currentOrder.version += 1;
    if (bulkOrder) { bulkOrder.reservationStatus = 'RELEASED'; bulkOrder.resolutionCount += 1; bulkOrder.refundMinor = Number(body.refund.amountMinor); bulkOrder.earningMinor = Number(body.playerEarning?.amountMinor ?? 0); bulkOrder.resolutionReason = String((request.body as { reasonCode?: unknown }).reasonCode ?? ''); }
    else orderResolutionCount += 1;
    return { order: { ...currentOrder }, reservationStatus: 'RELEASED', refundEntryCount: 1, earningEntryCount: Number(body.playerEarning?.amountMinor) > 0 ? 1 : 0 };
  }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/orders/:orderId/refund', permission: 'refund.execute', action: 'REFUND_E2E_ORDER', targetType: 'order', targetId: (request) => String((request.params as { orderId: string }).orderId), acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'STALE_ORDER' ? { statusCode: 409, code: 'VERSION_CONFLICT', message: 'The order version changed.' } : error instanceof Error && error.message === 'INVALID_REFUND' ? { statusCode: 422, code: 'REFUND_REJECTED', message: 'The refund exceeds the remaining refundable order facts.' } : null,
  handler: (request) => {
    const orderId = String((request.params as { orderId: string }).orderId);
    const order = bulkOrders.find((item) => item.id === orderId);
    const body = request.body as { expectedVersion?: unknown; amount?: { amountMinor?: unknown; currency?: unknown }; reasonCode?: unknown; evidenceNote?: unknown };
    if (!order || body.expectedVersion !== order.version) throw new Error('STALE_ORDER');
    const amountMinor = Number(body.amount?.amountMinor);
    if (!['COMPLETED', 'EXCEPTION'].includes(order.status) || body.amount?.currency !== 'USD' || !Number.isSafeInteger(amountMinor) || amountMinor < 1 || amountMinor > order.amountMinor - order.refundMinor || typeof body.reasonCode !== 'string' || typeof body.evidenceNote !== 'string' || !body.evidenceNote.trim()) throw new Error('INVALID_REFUND');
    order.refundMinor += amountMinor;
    return { orderId: order.id, refundTransactionId: `refund-${order.id}-${order.refundMinor}`, amountMinor, currency: 'USD', status: 'SUCCEEDED', orderStatus: order.status };
  }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/orders/:orderId/automation/pause', permission: 'order.pause', action: 'PAUSE_E2E_ORDER_AUTOMATION', targetType: 'order', acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'STALE_AUTOMATION' ? { statusCode: 409, code: 'VERSION_CONFLICT', message: 'The current order facts changed.' } : null,
  handler: (request, actor) => {
    const body = request.body as { expectedVersion?: unknown; reasonCode?: unknown; note?: unknown; scope?: unknown };
    const claimed = Array.from(tasks.values()).some((task) => task.orderId === orderRecord.id && task.status === 'CLAIMED' && task.claimedBy === actor.actorStaffId);
    if (body.expectedVersion !== orderRecord.version || automationControl.state !== 'RUNNING' || body.reasonCode !== 'STAFF_TAKEOVER' || typeof body.note !== 'string' || !body.note.trim() || !['ALL', 'DISPATCH', 'LIFECYCLE', 'CANCELLATION'].includes(String(body.scope)) || (actor.actorLevel === 'L1_SUPPORT' && !claimed)) throw new Error('STALE_AUTOMATION');
    orderRecord.version += 1;
    Object.assign(automationControl, { state: 'PAUSED', version: automationControl.version + 1, pausedByStaffId: actor.actorStaffId!, reasonCode: body.reasonCode, scope: body.scope });
    return { orderId: orderRecord.id, orderVersion: orderRecord.version, resumeAction: null, automation: { ...automationControl }, reservationAmountMinor };
  }
});
registerSecureWriteRoute(server, server.securityOptions!, {
  method: 'POST', url: '/api/v1/admin/orders/:orderId/automation/resume', permission: 'order.resume', action: 'RESUME_E2E_ORDER_AUTOMATION', targetType: 'order', acceptedSources: ['DASHBOARD'],
  mapError: (error) => error instanceof Error && error.message === 'STALE_AUTOMATION' ? { statusCode: 409, code: 'VERSION_CONFLICT', message: 'Current order and reservation facts must be revalidated.' } : null,
  handler: (request) => {
    const body = request.body as { expectedVersion?: unknown; reasonCode?: unknown; note?: unknown; resumeAction?: unknown };
    if (body.expectedVersion !== orderRecord.version || automationControl.state !== 'PAUSED' || body.reasonCode !== 'BLOCKER_RESOLVED' || body.resumeAction !== 'RESTART_READINESS_TIMEOUT' || typeof body.note !== 'string' || !body.note.trim() || reservationAmountMinor <= 0) throw new Error('STALE_AUTOMATION');
    automationControl.resumeValidatedOrderVersion = orderRecord.version;
    orderRecord.version += 1;
    Object.assign(automationControl, { state: 'RUNNING', version: automationControl.version + 1, pausedByStaffId: null, reasonCode: null, scope: null, expiresAt: null });
    return { orderId: orderRecord.id, orderVersion: orderRecord.version, resumeAction: body.resumeAction, automation: { ...automationControl }, reservationAmountMinor };
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
      const query = request.query as { query?: string; status?: string; reviewStatus?: string; cursor?: string; limit?: string };
      const sourceItems: readonly Record<string, unknown>[] = definition.target === 'order' && bulkOrders.length ? bulkOrders : definition.target === 'user' && bulkUsers.length ? bulkUsers : definition.target === 'player' && bulkPlayers.length ? bulkPlayers : definition.items;
      let items = sourceItems.filter((item) => (!['service_catalog', 'gift_catalog'].includes(definition.target) || !('status' in item) || item.status !== 'ARCHIVED') && (!query.status || !('status' in item) || item.status === query.status) && (!query.reviewStatus || !('reviewStatus' in item) || item.reviewStatus === query.reviewStatus));
      if (query.query) items = items.filter((item) => JSON.stringify(item).toLowerCase().includes(query.query!.toLowerCase()));
      if (definition.target === 'order' && !query.query && !query.status) {
        if (bulkOrders.length) {
          const limit = Math.min(50, Math.max(1, Number(query.limit) || 25));
          const offset = query.cursor?.startsWith('bulk-order:') ? Number(query.cursor.slice('bulk-order:'.length)) : 0;
          const nextOffset = offset + limit;
          return { items: items.slice(offset, nextOffset), nextCursor: nextOffset < items.length ? `bulk-order:${nextOffset}` : null };
        }
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
registerSecureWriteRoute(server,server.securityOptions!,{
  method:'PUT',url:'/api/v1/admin/players/:playerId/operational-status',permission:'player.status.manage',action:'SET_E2E_PLAYER_OPERATIONAL_STATUS',targetType:'player',targetId:()=>playerRecord.playerId,acceptedSources:['DASHBOARD'],
  mapError:(error)=>error instanceof Error&&error.message==='STALE_PLAYER'?{statusCode:409,code:'VERSION_CONFLICT',message:'The player version changed.'}:null,
  handler:(request)=>{const body=request.body as {expectedVersion?:unknown;reviewStatus?:unknown;reasonCode?:unknown;note?:unknown};if(body.expectedVersion!==playerRecord.version||!['APPROVED','ACTIVE','PAUSED','SUSPENDED'].includes(playerRecord.reviewStatus))throw new Error('STALE_PLAYER');if(!['ACTIVE','PAUSED','SUSPENDED'].includes(String(body.reviewStatus))||typeof body.reasonCode!=='string')throw new Error('INVALID_PLAYER_STATUS');playerRecord.reviewStatus=String(body.reviewStatus);if(playerRecord.reviewStatus!=='ACTIVE')playerRecord.availability='OFFLINE';playerRecord.version+=1;return{...playerRecord};}
});

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
  handler: () => { const active=new Set(orderParticipants.filter((participant)=>participant.status==='ACTIVE').map((participant)=>String(participant.playerId)));const target=['APPROVED','ACTIVE'].includes(playerRecord.reviewStatus)?[{playerId:playerRecord.playerId,discordUserId:'discord-target-player',displayName:playerRecord.displayName,projects:[initialCatalog]}]:[];return { items: [...target,...Array.from({ length: 9 }, (_, index) => ({ playerId: `player-e2e-${index + 1}`, discordUserId: `discord-player-${index + 1}`, displayName: `E2E 陪玩 ${index + 1}`, projects: [initialCatalog, alternateOrderCatalog] }))].filter((candidate)=>!active.has(candidate.playerId)), nextCursor: null }; }
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
    const body = request.body as { expectedOrderVersion?: unknown; expectedParticipantVersion?: unknown; action?: unknown; playerId?: unknown; serviceCatalogVersionId?: unknown; unitCount?: unknown; linePriceMinor?: unknown };
    if (orderRecord.status === 'COMPLETED') throw new Error('ORDER_CAPTURED');
    if (!participant || body.expectedOrderVersion !== orderRecord.version || body.expectedParticipantVersion !== participant.version) throw new Error('STALE_PARTICIPANT_ORDER');
    if (body.action === 'REMOVE') participant.status = 'REMOVED';
    else if (body.action === 'CHANGE_PRICE' && Number.isSafeInteger(body.linePriceMinor) && Number(body.linePriceMinor) > 0) participant.linePriceMinor = Number(body.linePriceMinor);
    else if (body.action === 'CHANGE_PROJECT') { const catalog = [initialCatalog, alternateOrderCatalog].find((item) => item.id === body.serviceCatalogVersionId); if (!catalog) throw new Error('INVALID_PARTICIPANT'); Object.assign(participant, { serviceCatalogVersionId: catalog.id, service: catalog.service, serviceDisplayName: catalog.serviceDisplayName, unitCount: Number(body.unitCount), linePriceMinor: Number(body.linePriceMinor) }); }
    else if (body.action === 'REASSIGN' && typeof body.playerId === 'string' && !orderParticipants.some((item)=>item!==participant&&item.status==='ACTIVE'&&item.playerId===body.playerId)) Object.assign(participant,{playerId:body.playerId,discordUserId:`discord-${body.playerId}`,discordTag:`${body.playerId}#0001`,displayName:`E2E 陪玩 ${body.playerId.split('-').at(-1)}`,readiness:'NOT_READY',compensationType:'PERCENT_BPS',compensationValue:6000,compensationSource:'CATALOG_DEFAULT',expectedEarningMinor:Math.floor(Number(participant.linePriceMinor)*0.6)});
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
  handler: (request) => (request.query as { cursor?: string }).cursor ? { items: [{ id: 'consumption-e2e-2', type: 'GIFT', sourceId: 'gift-2', amountMinor: 1000, currency: 'USD', occurredAt: '2026-08-04T00:00:00.000Z' }], nextCursor: null } : { items: [{ id: 'consumption-e2e', type: 'ORDER', sourceId: orderRecord.id, amountMinor: 4000, currency: 'USD', occurredAt: '2026-08-05T00:00:00.000Z' }], nextCursor: 'profile-consumptions-2' }
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
server.post('/__e2e/setup/gift-review', async () => {
  const giftRequestId = '00000000-0000-0000-0000-000000000704';
  tasks.clear();
  tasks.set('00000000-0000-0000-0000-000000000204', {
    id: '00000000-0000-0000-0000-000000000204', publicId: 'T-GIFT-E2E-001', type: 'GIFT_REVIEW', status: 'OPEN', version: 1,
    claimedBy: null, orderId: orderRecord.id, giftRequestId, channelId: '1200000000000000011', voiceChannelId: null,
    guildId, createdAt: '2026-08-05T01:00:00.000Z', notes: []
  });
  giftRequestRecords.splice(0, giftRequestRecords.length, {
    id: giftRequestId, publicId: 'G-E2E-REVIEW', status: 'PENDING_REVIEW', amountMinor: 1000, currency: 'CAT',
    giftCatalogId: initialGift.id, giftCatalogVersionId: initialGift.id, giftName: initialGift.name, giftCode: 'STARLIGHT', broadcastTemplate: initialGift.broadcastTemplate,
    orderId: orderRecord.id, orderPublicId: orderRecord.publicId, senderDisplayName: 'E2E 用户', senderDiscordUserId: userRecord.discordUserId,
    receiverDisplayName: playerRecord.displayName, receiverDiscordUserId: 'player-discord-e2e', reservationStatus: 'ACTIVE', verifiedByStaffId: null,
    verifiedAt: null, verificationNote: null, approvedByStaffId: null, approvedAt: null, capturedAt: null,
    createdAt: '2026-08-05T01:00:00.000Z', updatedAt: '2026-08-05T01:00:00.000Z', rowVersion: 1
  });
  return { ok: true };
});
server.post('/__e2e/orders/bulk', async (request, reply) => {
  const requestedCount = Number((request.body as { count?: unknown })?.count);
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1 || requestedCount > 50) return reply.code(400).send({ error: 'count must be an integer from 1 to 50' });
  const tailStatuses = ['PENDING_DISPATCH', 'IN_SERVICE', 'PENDING_CONFIRMATION', 'COMPLETED', 'CANCELLED', 'EXCEPTION'] as const;
  bulkOrders.splice(0, bulkOrders.length, ...Array.from({ length: requestedCount }, (_, offset): BulkOrder => {
    const index = offset + 1;
    const status = index <= 12 ? 'ACCEPTED' : tailStatuses[Math.floor((index - 13) / 4) % tailStatuses.length]!;
    const reservationStatus: BulkOrder['reservationStatus'] = status === 'COMPLETED' ? 'CAPTURED' : status === 'CANCELLED' ? 'RELEASED' : status === 'EXCEPTION' || status === 'PENDING_CONFIRMATION' ? 'DISPUTED' : 'ACTIVE';
    const amountMinor = 1_000 + index * 125;
    return { id: `10000000-0000-0000-0000-${String(index).padStart(12, '0')}`, publicId: `P-BULK-${String(index).padStart(3, '0')}`, version: 1 + (index % 3), status, customerDiscordId: `bulk-customer-${String(index).padStart(3, '0')}`, amountMinor, playerEarningMinor: Math.floor(amountMinor * 0.6), currency: 'USD', createdAt: new Date(Date.UTC(2026, 7, 5, 0, 0, 0) - offset * 60_000).toISOString(), guildId, reservationStatus, resolutionCount: 0, refundMinor: 0, earningMinor: 0, resolutionReason: null };
  }));
  const cancellation = bulkOrders.find((order) => order.status === 'ACCEPTED')!;
  const interruption = bulkOrders.find((order) => order.status === 'IN_SERVICE')!;
  tasks.set('20000000-0000-0000-0000-000000000001', { id: '20000000-0000-0000-0000-000000000001', publicId: 'T-BULK-CANCEL', type: 'CANCELLATION_ASSIST', status: 'OPEN', version: 1, claimedBy: null, orderId: cancellation.id, channelId: '1200000000000000021', voiceChannelId: null, guildId, createdAt: '2026-08-05T01:00:00.000Z', notes: [] });
  tasks.set('20000000-0000-0000-0000-000000000002', { id: '20000000-0000-0000-0000-000000000002', publicId: 'T-BULK-INTERRUPT', type: 'SERVICE_INTERRUPTION', status: 'OPEN', version: 1, claimedBy: null, orderId: interruption.id, channelId: '1200000000000000022', voiceChannelId: '1200000000000000032', guildId, createdAt: '2026-08-05T01:05:00.000Z', notes: [] });
  return reply.code(201).send({ orders: bulkOrders.map((order) => ({ ...order })) });
});
server.post('/__e2e/users/bulk', async (request, reply) => {
  const customers = (request.body as { customers?: unknown })?.customers;
  if (!Array.isArray(customers) || customers.length < 1 || customers.length > 50) return reply.code(400).send({ error: 'customers must contain 1 to 50 rows' });
  const parsed = customers.map((customer) => customer as Partial<(typeof bulkUsers)[number]>);
  if (parsed.some((customer) => typeof customer.id !== 'string' || typeof customer.discordUserId !== 'string' || typeof customer.status !== 'string' || typeof customer.operationalStatus !== 'string' || !Number.isSafeInteger(customer.version) || typeof customer.createdAt !== 'string')) return reply.code(400).send({ error: 'invalid customer row' });
  bulkUsers.splice(0, bulkUsers.length, ...parsed as (typeof bulkUsers));
  return reply.code(201).send({ users: bulkUsers.map((user) => ({ ...user })) });
});
server.post('/__e2e/players/bulk', async (request, reply) => {
  const count = Number((request.body as { count?: unknown })?.count);
  if (!Number.isSafeInteger(count) || count < 1 || count > 30) return reply.code(400).send({ error: 'count must be an integer from 1 to 30' });
  const others = Array.from({ length: count - 1 }, (_, offset) => ({ id: `daily-profile-${offset + 1}`, playerId: `30000000-0000-0000-0000-${String(offset + 1).padStart(12, '0')}`, displayName: `待审陪玩 ${String(offset + 1).padStart(2, '0')}`, reviewStatus: 'PENDING_REVIEW', availability: 'OFFLINE', version: 1, gameTags: [], serviceTags: [], languageTags: [], gameTagIds: [], serviceTagIds: [], languageTagIds: [], createdAt: new Date(Date.UTC(2026, 7, 2, 0, offset)).toISOString() }));
  bulkPlayers.splice(0, bulkPlayers.length, ...others.slice(0, 5), playerRecord, ...others.slice(5));
  return reply.code(201).send({ players: bulkPlayers.map((player) => ({ ...player })) });
});
server.post('/__e2e/fault/:name', async (request) => { faults.add((request.params as { name: string }).name); return { ok: true }; });
server.post('/__e2e/features/core-only', async () => { enabledFixtureFeatures.splice(0, enabledFixtureFeatures.length, 'CORE_ORDER'); return { enabledFeatures: enabledFixtureFeatures }; });
server.post('/__e2e/advance-time', async (request) => { clockOffsetMs += Number((request.body as { milliseconds?: unknown })?.milliseconds ?? 0); return { now: fixtureNow().toISOString() }; });
server.post('/__e2e/capture-order', async () => { orderRecord.status = 'COMPLETED'; return { ...orderRecord }; });
server.post('/__e2e/set-replacement-cycle', async () => { if (settlementBatches[0] && settlementBatches[1]) settlementBatches[1].replacementBatchId = settlementBatches[0].id; return { ok: true }; });
server.post('/__e2e/worker/stop', async () => { workerRunning = false; return { workerRunning }; });
server.post('/__e2e/outbox/enqueue', async () => { if (!outboxMessages.some((item) => item.id === 'outbox-e2e-1')) outboxMessages.push({ id: 'outbox-e2e-1', status: 'PENDING', attempts: 0 }); return { items: outboxMessages }; });
server.post('/__e2e/worker/start', async () => { workerRunning = true; for (const item of outboxMessages) if (item.status === 'PENDING') { item.status = 'COMPLETED'; item.attempts += 1; workerSideEffectCount += 1; } return { workerRunning, items: outboxMessages }; });
server.post('/__e2e/restart-runtimes', async () => { apiRuntimeEpoch += 1; workerRuntimeEpoch += 1; workerRunning = true; return { apiRuntimeEpoch, workerRuntimeEpoch }; });
server.get('/__e2e/totp/:actor', async (request, reply) => {
  const secret = actorTotpSecrets.get((request.params as { actor: string }).actor);
  return secret ? { proof: generateTotp(secret, fixtureNow()) } : reply.code(404).send({ error: 'unknown E2E TOTP actor' });
});
server.get('/__e2e/state', async () => ({ tasks: Array.from(tasks.values()), order: orderRecord, bulkOrders, orderResolutionCount, orderParticipants, reservationAmountMinor, reservationCreateCount, automationControl, user: userRecord, bulkUsers, riskEvents, walletBalance, walletEntries, receiptAttachments, profileNotes, player: playerRecord, bulkPlayers, compensationRules, businessTags, catalogRecords, packageRecords, giftRecords, giftRequestRecords, giftReservationCaptureCount, giftReservationReleaseCount, earningRecord, earningPaymentWrites, roleMapping, settlementBatches, weeklyReports, outboxMessages, workerRunning, workerSideEffectCount, apiRuntimeEpoch, workerRuntimeEpoch, jobs: Array.from(jobs.values()), policySetting, auditCount: auditSink.records.length, audits: auditSink.records }));

await server.listen({ host, port });
