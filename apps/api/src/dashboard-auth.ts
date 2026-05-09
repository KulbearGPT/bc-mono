import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { StaffDirectoryQueryClient } from './security.js';
import {
  registerSecureReadRoute,
  type DashboardSessionResolver,
  type StaffAccount,
  type StaffDirectory,
  type StaffLevel
} from './security.js';

export interface DiscordOAuthProvider {
  getAuthorizationUrl(input: { state: string }): string;
  exchangeCode(code: string): Promise<{ discordUserId: string }>;
}

export interface DashboardAuthStore extends DashboardSessionResolver {
  createOAuthState(now?: Date): string;
  consumeOAuthState(state: string, now?: Date): boolean;
  createSession(staff: StaffAccount, now?: Date):
    | { sessionToken: string; csrfToken: string }
    | Promise<{ sessionToken: string; csrfToken: string }>;
  revoke(sessionToken: string): void | Promise<void>;
}

export class DiscordHttpOAuthProvider implements DiscordOAuthProvider {
  constructor(private readonly options: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    fetch?: typeof fetch;
  }) {}

  getAuthorizationUrl({ state }: { state: string }): string {
    const url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      response_type: 'code',
      redirect_uri: this.options.redirectUri,
      scope: 'identify',
      state,
      prompt: 'none'
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string): Promise<{ discordUserId: string }> {
    const request = this.options.fetch ?? fetch;
    const tokenResponse = await request('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.options.redirectUri
      })
    });
    if (!tokenResponse.ok) throw new Error('Discord token exchange failed.');
    const token = await tokenResponse.json() as { access_token?: unknown };
    if (typeof token.access_token !== 'string') throw new Error('Discord access token is missing.');
    const userResponse = await request('https://discord.com/api/v10/users/@me', {
      headers: { authorization: `Bearer ${token.access_token}` }
    });
    if (!userResponse.ok) throw new Error('Discord user lookup failed.');
    const user = await userResponse.json() as { id?: unknown };
    if (typeof user.id !== 'string') throw new Error('Discord user id is missing.');
    return { discordUserId: user.id };
  }
}

interface StoredSession {
  sessionHash: string;
  staff: StaffAccount;
  permissionsVersion: number;
  csrfToken: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export class InMemoryDashboardAuthStore implements DashboardAuthStore {
  private readonly oauthStates = new Map<string, Date>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly currentPermissionsVersions = new Map<string, number>();

  createOAuthState(now = new Date()): string {
    const state = randomToken();
    this.oauthStates.set(hash(state), new Date(now.getTime() + 10 * 60_000));
    return state;
  }

  consumeOAuthState(state: string, now = new Date()): boolean {
    const key = hash(state);
    const expiresAt = this.oauthStates.get(key);
    this.oauthStates.delete(key);
    return Boolean(expiresAt && expiresAt > now);
  }

  createSession(staff: StaffAccount, now = new Date()) {
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const sessionHash = hash(sessionToken);
    this.currentPermissionsVersions.set(staff.staffId, staff.permissionsVersion);
    this.sessions.set(sessionHash, {
      sessionHash,
      staff: { ...staff },
      permissionsVersion: staff.permissionsVersion,
      csrfToken,
      expiresAt: new Date(now.getTime() + 8 * 60 * 60_000),
      revokedAt: null
    });
    return { sessionToken, csrfToken };
  }

  resolve(sessionToken: string, now = new Date()) {
    const session = this.sessions.get(hash(sessionToken));
    if (!session) return { ok: false as const, reason: 'AUTH_REQUIRED' as const };
    const currentVersion = this.currentPermissionsVersions.get(session.staff.staffId);
    if (
      session.revokedAt ||
      session.expiresAt <= now ||
      currentVersion !== session.permissionsVersion ||
      session.staff.status !== 'ACTIVE'
    ) {
      session.revokedAt ??= now;
      return { ok: false as const, reason: 'SESSION_REVOKED' as const };
    }
    return { ok: true as const, staff: { ...session.staff }, csrfToken: session.csrfToken };
  }

  verifyCsrf(sessionToken: string, csrfToken: string): boolean {
    const session = this.sessions.get(hash(sessionToken));
    if (!session || session.revokedAt) return false;
    return safeEqual(session.csrfToken, csrfToken);
  }

  revoke(sessionToken: string): void {
    const session = this.sessions.get(hash(sessionToken));
    if (session) session.revokedAt = new Date();
  }

  setCurrentPermissionsVersion(staffId: string, version: number): void {
    this.currentPermissionsVersions.set(staffId, version);
  }
}

export class PostgresDashboardAuthStore implements DashboardAuthStore {
  private readonly oauthStates = new Map<string, Date>();

  constructor(private readonly options: { client: StaffDirectoryQueryClient; csrfSecret: string }) {}

  createOAuthState(now = new Date()): string {
    const state = randomToken();
    this.oauthStates.set(hash(state), new Date(now.getTime() + 10 * 60_000));
    return state;
  }

  consumeOAuthState(state: string, now = new Date()): boolean {
    const key = hash(state);
    const expiresAt = this.oauthStates.get(key);
    this.oauthStates.delete(key);
    return Boolean(expiresAt && expiresAt > now);
  }

  async createSession(staff: StaffAccount, now = new Date()) {
    const sessionToken = randomToken();
    const csrfToken = csrfFor(sessionToken, this.options.csrfSecret);
    await this.options.client.query(
      `INSERT INTO staff_sessions
        (id, staff_account_id, session_hash, permissions_version, expires_at, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6::timestamptz, $6::timestamptz)`,
      [crypto.randomUUID(), staff.staffId, hash(sessionToken), staff.permissionsVersion, new Date(now.getTime() + 8 * 60 * 60_000).toISOString(), now.toISOString()]
    );
    return { sessionToken, csrfToken };
  }

  async resolve(sessionToken: string, now = new Date()) {
    const result = await this.options.client.query<{
      session_permissions_version: number;
      expires_at: Date | string;
      revoked_at: Date | string | null;
      staff_id: string;
      user_id: string;
      level: StaffLevel;
      staff_permissions_version: number;
      status: StaffAccount['status'];
    }>(
      `SELECT session.permissions_version AS session_permissions_version,
              session.expires_at,
              session.revoked_at,
              staff.id AS staff_id,
              staff.user_id,
              staff.level,
              staff.permissions_version AS staff_permissions_version,
              staff.status
         FROM staff_sessions AS session
         JOIN staff_accounts AS staff ON staff.id = session.staff_account_id
        WHERE session.session_hash = $1
        LIMIT 1`,
      [hash(sessionToken)]
    );
    const row = result.rows[0];
    if (!row) return { ok: false as const, reason: 'AUTH_REQUIRED' as const };
    if (
      row.revoked_at ||
      new Date(row.expires_at) <= now ||
      row.session_permissions_version !== row.staff_permissions_version ||
      row.status !== 'ACTIVE'
    ) {
      await this.options.client.query(
        'UPDATE staff_sessions SET revoked_at = COALESCE(revoked_at, $2::timestamptz), updated_at = $2::timestamptz WHERE session_hash = $1',
        [hash(sessionToken), now.toISOString()]
      );
      return { ok: false as const, reason: 'SESSION_REVOKED' as const };
    }
    return {
      ok: true as const,
      staff: {
        staffId: row.staff_id,
        userId: row.user_id,
        level: row.level,
        permissionsVersion: row.staff_permissions_version,
        status: row.status
      },
      csrfToken: csrfFor(sessionToken, this.options.csrfSecret)
    };
  }

  verifyCsrf(sessionToken: string, csrfToken: string): boolean {
    return safeEqual(csrfFor(sessionToken, this.options.csrfSecret), csrfToken);
  }

  async revoke(sessionToken: string): Promise<void> {
    await this.options.client.query(
      'UPDATE staff_sessions SET revoked_at = COALESCE(revoked_at, now()), updated_at = now() WHERE session_hash = $1',
      [hash(sessionToken)]
    );
  }
}

export interface DashboardAuthOptions {
  store: DashboardAuthStore;
  oauth: DiscordOAuthProvider;
  staffDirectory: StaffDirectory;
  guildId: string;
  dashboardUrl: string;
  secureCookies?: boolean;
  now?: () => Date;
}

const permissionsByLevel: Record<StaffLevel, string[]> = {
  L1_SUPPORT: [
    'staff.session.active',
    'dashboard.view',
    'staff_task.read',
    'staff_task.claim',
    'staff_task.verify',
    'audit.read'
  ],
  L2_SUPERVISOR: ['gift.approve', 'gift.reject', 'refund.execute', 'order.resolve'],
  L3_OPERATIONS: ['catalog.manage', 'earnings.manage', 'commission.manage', 'referral.manage'],
  L4_ADMIN_OWNER: ['access.manage']
};

export function registerDashboardAuthRoutes(server: FastifyInstance, options: DashboardAuthOptions): void {
  const now = options.now ?? (() => new Date());
  const secureCookies = options.secureCookies ?? true;

  server.get('/api/v1/auth/discord', async (_request, reply) => {
    const state = options.store.createOAuthState(now());
    reply.header('set-cookie', serializeCookie('p0_oauth_state', state, { httpOnly: true, maxAge: 600, secure: secureCookies }));
    return reply.redirect(options.oauth.getAuthorizationUrl({ state }));
  });

  server.get('/api/v1/auth/discord/callback', async (request, reply) => {
    const query = request.query as { code?: unknown; state?: unknown };
    const cookies = parseCookies(request);
    if (
      typeof query.code !== 'string' ||
      typeof query.state !== 'string' ||
      !cookies.p0_oauth_state ||
      !safeEqual(query.state, cookies.p0_oauth_state) ||
      !options.store.consumeOAuthState(query.state, now())
    ) {
      return authError(reply, 401, 'OAUTH_STATE_INVALID', 'The OAuth state is invalid or expired.');
    }

    let discordUserId: string;
    try {
      ({ discordUserId } = await options.oauth.exchangeCode(query.code));
    } catch {
      return authError(reply, 401, 'OAUTH_EXCHANGE_FAILED', 'Discord authorization could not be completed.');
    }
    const staff = await options.staffDirectory.resolveByDiscord({ discordUserId, guildId: options.guildId });
    if (!staff || staff.status !== 'ACTIVE') {
      return authError(reply, 403, 'STAFF_ACCOUNT_REQUIRED', 'An active staff account is required.');
    }
    const session = await options.store.createSession(staff, now());
    reply.header('set-cookie', [
      serializeCookie('p0_session', session.sessionToken, { httpOnly: true, maxAge: 28_800, secure: secureCookies }),
      serializeCookie('p0_csrf', session.csrfToken, { httpOnly: false, maxAge: 28_800, secure: secureCookies }),
      serializeCookie('p0_oauth_state', '', { httpOnly: true, maxAge: 0, secure: secureCookies })
    ]);
    return reply.redirect(new URL('/', options.dashboardUrl).toString());
  });

  server.post('/api/v1/auth/logout', async (request, reply) => {
    const cookies = parseCookies(request);
    const sessionToken = cookies.p0_session;
    const csrfHeader = request.headers['x-csrf-token'];
    if (!sessionToken || !cookies.p0_csrf || csrfHeader !== cookies.p0_csrf || !(await options.store.verifyCsrf(sessionToken, cookies.p0_csrf))) {
      return authError(reply, 403, 'CSRF_REQUIRED', 'A valid CSRF token is required.');
    }
    if (sessionToken) await options.store.revoke(sessionToken);
    reply.header('set-cookie', [
      serializeCookie('p0_session', '', { httpOnly: true, maxAge: 0, secure: secureCookies }),
      serializeCookie('p0_csrf', '', { httpOnly: false, maxAge: 0, secure: secureCookies })
    ]);
    reply.code(204).send();
  });

  if (!server.securityOptions) throw new Error('Dashboard auth routes require security options.');
  registerSecureReadRoute(server, server.securityOptions, {
    method: 'GET',
    url: '/api/v1/admin/me/capabilities',
    permission: 'staff.session.active',
    action: 'GET_CURRENT_STAFF_CAPABILITIES',
    targetType: 'staff_session',
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    handler: (_request, actor) => buildCapabilities(actor.actorStaffId!, actor.actorLevel!, actor.permissionsVersion!)
  });
  registerSecureReadRoute(server, server.securityOptions, {
    method: 'GET',
    url: '/api/v1/admin/dashboard/summary',
    permission: 'dashboard.view',
    action: 'GET_DASHBOARD_SUMMARY',
    targetType: 'dashboard',
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    handler: () => buildEmptySummary(now())
  });
}

function buildCapabilities(staffId: string, level: StaffLevel, permissionsVersion: number) {
  const ranks: StaffLevel[] = ['L1_SUPPORT', 'L2_SUPERVISOR', 'L3_OPERATIONS', 'L4_ADMIN_OWNER'];
  const rank = ranks.indexOf(level);
  return {
    staffId,
    level,
    scope: level === 'L1_SUPPORT' ? 'SELF' : level === 'L2_SUPERVISOR' ? 'TEAM' : level === 'L3_OPERATIONS' ? 'BUSINESS' : 'ALL',
    permissions: ranks.slice(0, rank + 1).flatMap((item) => permissionsByLevel[item]),
    thresholds: {
      giftApprovalLimitMinor: level === 'L1_SUPPORT' ? null : 200_000,
      refundLimitMinor: level === 'L1_SUPPORT' ? null : 50_000,
      l4DirectExecutionFromMinor: 500_000,
      currency: 'CNY'
    },
    stepUp: { requiredForSensitiveActions: level === 'L3_OPERATIONS' || level === 'L4_ADMIN_OWNER', validUntil: null },
    permissionsVersion
  };
}

function buildEmptySummary(current: Date) {
  const start = new Date(current);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86_400_000);
  return {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    currency: 'CNY',
    metrics: {
      todayOrderCount: 0,
      inServiceOrderCount: 0,
      pendingStaffTaskCount: 0,
      completedNetConsumptionMinor: 0,
      giftNetConsumptionMinor: 0,
      reservedMinor: 0,
      dispatchSuccessRate: 0,
      exceptionCount: 0
    }
  };
}

function serializeCookie(name: string, value: string, options: { httpOnly: boolean; maxAge: number; secure: boolean }): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${options.maxAge}; SameSite=Lax${options.secure ? '; Secure' : ''}${options.httpOnly ? '; HttpOnly' : ''}`;
}

function parseCookies(request: FastifyRequest): Record<string, string> {
  const header = request.headers.cookie ?? '';
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=' as const)).filter(([key, value]) => key && value !== undefined).map(([key, value]) => [key, decodeURIComponent(value)]));
}

function authError(reply: FastifyReply, status: number, code: string, message: string) {
  reply.code(status);
  return { requestId: `req_${crypto.randomUUID()}`, error: { code, message, retryable: false, details: [] } };
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function csrfFor(sessionToken: string, secret: string): string {
  return createHash('sha256').update(`${secret}:${sessionToken}`).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
