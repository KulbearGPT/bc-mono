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

const authStore = new InMemoryDashboardAuthStore();
const auditSink = new InMemoryAuditSink();
const jobs = new Map<string, { id: string; type: string; status: 'FAILED' | 'COMPLETED'; attempts: number; lastError: string | null; runAfter: string; version: number }>([
  ['00000000-0000-0000-0000-000000000401', { id: '00000000-0000-0000-0000-000000000401', type: 'PANEL_SYNC', status: 'FAILED', attempts: 1, lastError: 'Discord timeout', runAfter: '2026-08-05T00:00:00.000Z', version: 1 }]
]);
const tasks = new Map<string, {
  id: string; publicId: string; type: string; status: 'OPEN' | 'CLAIMED' | 'ESCALATED'; version: number;
  claimedBy: string | null; orderId: string | null; channelId: string | null; voiceChannelId: string | null; guildId: string; createdAt: string; notes: string[];
}>([
  ['00000000-0000-0000-0000-000000000201', {
    id: '00000000-0000-0000-0000-000000000201', publicId: 'T-E2E-001', type: 'ORDER_ASSIST', status: 'OPEN', version: 1,
    claimedBy: null, orderId: '00000000-0000-0000-0000-000000000301', channelId: '1200000000000000011', voiceChannelId: null,
    guildId, createdAt: '2026-08-05T00:00:00.000Z', notes: []
  }]
]);

const directory: StaffDirectory = {
  resolveByDiscord(input) {
    return input.discordUserId === '111111111111111111' && input.guildId === guildId ? staff : null;
  }
};

const oauth: DiscordOAuthProvider = {
  getAuthorizationUrl({ state }) { return `${dashboardUrl}/__e2e/oauth?state=${encodeURIComponent(state)}`; },
  async exchangeCode(code) {
    if (code !== 'dashboard-e2e-code') throw new Error('invalid E2E OAuth code');
    return { discordUserId: '111111111111111111' };
  }
};

const server = buildApiServer({
  env: {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused', API_PORT: String(port), API_BASE_URL: `http://${host}:${port}`,
    BOT_SERVICE_TOKEN: 'dashboard-e2e-bot-token', PAGINATION_CURSOR_SIGNING_SECRET: 'dashboard-e2e-pagination-secret-which-is-long-enough'
  },
  security: { staffDirectory: directory, dashboardSessions: authStore, auditSink, businessEnvironment: 'SANDBOX' },
  dashboardAuth: { store: authStore, oauth, staffDirectory: directory, guildId, dashboardUrl, secureCookies: false },
  dashboardMetrics: { store: new InMemoryDashboardMetricsStore({ facts: { todayOrderCount: 1, inProgressOrderCount: 1, pendingStaffTaskCount: 1, completedOrderNetConsumptionMinor: 12_500, giftNetConsumptionMinor: 0, activeReservedMinor: 4_000, dispatchAcceptedCount: 19, dispatchStartedCount: 20, exceptionCount: 0 } }) }
});

server.get('/__e2e/oauth', async (request, reply) => {
  const { state } = request.query as { state?: string };
  return reply.redirect(`/api/v1/auth/discord/callback?code=dashboard-e2e-code&state=${encodeURIComponent(state ?? '')}`);
});
server.get('/__e2e/login/:actor', async (request, reply) => {
  const actor = (request.params as { actor: string }).actor;
  const selected = actor === 'l2' ? supervisor : staff;
  const session = authStore.createSession(selected);
  reply.header('set-cookie', [
    `p0_session=${encodeURIComponent(session.sessionToken)}; Path=/; HttpOnly; SameSite=Lax`,
    `p0_csrf=${encodeURIComponent(session.csrfToken)}; Path=/; SameSite=Lax`
  ]);
  return reply.redirect(`${dashboardUrl}/`);
});

registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/staff-tasks', permission: 'staff_task.read', action: 'LIST_E2E_STAFF_TASKS', targetType: 'staff_task', acceptedSources: ['DASHBOARD'],
  handler: () => ({ items: Array.from(tasks.values()).map(({ notes: _notes, ...task }) => task), nextCursor: null })
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
  handler: () => ({ order: { publicId: 'P-E2E-001', status: 'ACCEPTED', game: 'valorant', gameDisplayName: '无畏契约', service: 'escort', serviceDisplayName: '护航', amountMinor: 4_000, currency: 'USD' }, readiness: { customer: 'READY', player: 'PENDING', bothReady: false }, automation: { state: 'RUNNING', reasonCode: null }, matching: { stage: 'ACCEPTED', nextStep: 'WAIT_FOR_READINESS' } })
});

for (const [url, payload] of [
  ['/api/v1/admin/support-shifts/me', null],
  ['/api/v1/admin/support/summary', { items: [{ staffId: staff.staffId, displayName: 'E2E L1', clockedIn: false, shiftSeconds: 0, handledTaskCount: 0, overdueTaskCount: 0, ratingCount: 0, averageRating: null }] }]
] as const) {
  registerSecureReadRoute(server, server.securityOptions!, { method: 'GET', url, permission: 'staff_task.read', action: `READ_E2E_${url.split('/').at(-1)}`, targetType: 'support', acceptedSources: ['DASHBOARD'], handler: () => payload });
}

registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/audit-logs', permission: 'audit.read', action: 'LIST_E2E_AUDIT_LOGS', targetType: 'audit_log', acceptedSources: ['DASHBOARD'],
  handler: () => ({ items: [], nextCursor: null })
});
registerSecureReadRoute(server, server.securityOptions!, {
  method: 'GET', url: '/api/v1/admin/jobs', permission: 'job.read', action: 'LIST_E2E_JOBS', targetType: 'job', acceptedSources: ['DASHBOARD'],
  handler: () => ({ items: Array.from(jobs.values()).filter((job) => job.status === 'FAILED'), nextCursor: null })
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
server.get('/__e2e/state', async () => ({ tasks: Array.from(tasks.values()), auditCount: auditSink.records.length }));

await server.listen({ host, port });
