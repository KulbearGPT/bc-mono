import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import {
  InMemoryDashboardAuthStore,
  type DiscordOAuthProvider
} from '@blackcat/api/dashboard-auth';
import { type StaffDirectory } from '@blackcat/api/security';
import { registerSecureWriteRoute } from '@blackcat/api/security';

const env = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://unused',
  API_PORT: '0',
  API_BASE_URL: 'https://api.example.test',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};

const staff = {
  staffId: '00000000-0000-0000-0000-000000000111',
  userId: '00000000-0000-0000-0000-000000000011',
  level: 'L1_SUPPORT' as const,
  permissionsVersion: 1,
  status: 'ACTIVE' as const
};

const directory: StaffDirectory = {
  resolveByDiscord({ discordUserId, guildId }) {
    return discordUserId === '111111111111111111' && guildId === '999999999999999999'
      ? staff
      : null;
  }
};

const oauth: DiscordOAuthProvider = {
  getAuthorizationUrl({ state }) {
    return `https://discord.com/oauth2/authorize?state=${state}`;
  },
  async exchangeCode(code) {
    if (code !== 'valid-code') throw new Error('invalid code');
    return { discordUserId: '111111111111111111' };
  }
};

function cookieValue(setCookie: string | string[] | undefined, name: string): string {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  const match = values.join('\n').match(new RegExp(`${name}=([^;]+)`));
  if (!match?.[1]) throw new Error(`${name} cookie missing`);
  return decodeURIComponent(match[1]);
}

async function login() {
  const authStore = new InMemoryDashboardAuthStore();
  const server = buildApiServer({
    env,
    security: { staffDirectory: directory, dashboardSessions: authStore },
    dashboardAuth: {
      store: authStore,
      oauth,
      staffDirectory: directory,
      guildId: '999999999999999999',
      dashboardUrl: 'https://dashboard.example.test'
    }
  });
  registerSecureWriteRoute(server, server.securityOptions!, {
    method: 'POST',
    url: '/__m4/dashboard/write-probe',
    permission: 'staff_task.claim',
    action: 'DASHBOARD_WRITE_PROBE',
    targetType: 'staff_task',
    acceptedSources: ['DASHBOARD'],
    handler: () => ({ updated: true })
  });
  const begin = await server.inject({ method: 'GET', url: '/api/v1/auth/discord' });
  const state = cookieValue(begin.headers['set-cookie'], 'p0_oauth_state');
  const callback = await server.inject({
    method: 'GET',
    url: `/api/v1/auth/discord/callback?code=valid-code&state=${state}`,
    headers: { cookie: `p0_oauth_state=${encodeURIComponent(state)}` }
  });
  return { server, authStore, begin, callback };
}

describe('M4-US-01 dashboard OAuth2, session, capabilities and CSRF', () => {
  test('completes Discord OAuth with state validation and secure cookies', async () => {
    const { begin, callback } = await login();
    expect(begin.statusCode).toBe(302);
    expect(begin.headers.location).toContain('https://discord.com/oauth2/authorize?state=');
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('https://dashboard.example.test/');
    const cookies = String(callback.headers['set-cookie']);
    expect(cookies).toContain('p0_session=');
    expect(cookies).toContain('p0_csrf=');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('Secure');
    expect(cookies).toContain('SameSite=Lax');
  });

  test('rejects callback state mismatch and non-staff Discord users', async () => {
    const store = new InMemoryDashboardAuthStore();
    const server = buildApiServer({
      env,
      security: { staffDirectory: directory, dashboardSessions: store },
      dashboardAuth: {
        store,
        oauth: { ...oauth, exchangeCode: async () => ({ discordUserId: '222222222222222222' }) },
        staffDirectory: directory,
        guildId: '999999999999999999',
        dashboardUrl: 'https://dashboard.example.test'
      }
    });
    const mismatch = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/discord/callback?code=valid-code&state=forged',
      headers: { cookie: 'p0_oauth_state=other' }
    });
    expect(mismatch.statusCode).toBe(401);

    const begin = await server.inject({ method: 'GET', url: '/api/v1/auth/discord' });
    const state = cookieValue(begin.headers['set-cookie'], 'p0_oauth_state');
    const nonStaff = await server.inject({
      method: 'GET',
      url: `/api/v1/auth/discord/callback?code=valid-code&state=${state}`,
      headers: { cookie: `p0_oauth_state=${state}` }
    });
    expect(nonStaff.statusCode).toBe(403);
  });

  test('derives capabilities from the server session and ignores browser role claims', async () => {
    const { server, callback } = await login();
    const session = cookieValue(callback.headers['set-cookie'], 'p0_session');
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/me/capabilities',
      headers: {
        cookie: `p0_session=${session}`,
        'x-client-source': 'DASHBOARD',
        'x-actor-level': 'L4_ADMIN_OWNER',
        'x-actor-discord-user-id': '999999999999999999'
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        staffId: staff.staffId,
        level: 'L1_SUPPORT',
        scope: 'SELF',
        permissionsVersion: 1
      }
    });
    expect(response.json().data.permissions).toContain('staff_task.claim');
    expect(response.json().data.permissions).not.toContain('access.manage');
  });

  test('requires matching CSRF for dashboard writes and revokes stale permission versions', async () => {
    const { server, authStore, callback } = await login();
    const session = cookieValue(callback.headers['set-cookie'], 'p0_session');
    const csrf = cookieValue(callback.headers['set-cookie'], 'p0_csrf');
    const cookie = `p0_session=${session}; p0_csrf=${csrf}`;

    const missingCsrf = await server.inject({
      method: 'POST',
      url: '/__m4/dashboard/write-probe',
      headers: { cookie, 'x-client-source': 'DASHBOARD', 'idempotency-key': 'dashboard:probe:missing' }
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ error: { code: 'CSRF_REQUIRED' } });

    const allowed = await server.inject({
      method: 'POST',
      url: '/__m4/dashboard/write-probe',
      headers: {
        cookie,
        'x-csrf-token': csrf,
        'x-client-source': 'DASHBOARD',
        'idempotency-key': 'dashboard:probe:allowed'
      }
    });
    expect(allowed.statusCode).toBe(200);

    authStore.setCurrentPermissionsVersion(staff.staffId, 2);
    const stale = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/me/capabilities',
      headers: { cookie, 'x-client-source': 'DASHBOARD' }
    });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ error: { code: 'SESSION_REVOKED' } });
  });

  test('protects the dashboard summary with the same session capability', async () => {
    const { server, callback } = await login();
    const anonymous = await server.inject({ method: 'GET', url: '/api/v1/admin/dashboard/summary' });
    expect(anonymous.statusCode).toBe(401);
    const session = cookieValue(callback.headers['set-cookie'], 'p0_session');
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/dashboard/summary',
      headers: { cookie: `p0_session=${session}`, 'x-client-source': 'DASHBOARD' }
    });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json().data.metrics)).toHaveLength(8);
  });
});
