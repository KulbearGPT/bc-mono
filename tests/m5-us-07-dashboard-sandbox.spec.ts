import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCapabilities } from '@blackcat/api/dashboard-auth';
import { createPilotFeaturePolicy } from '@blackcat/api/pilot-features';
import { buildApiServer, registerDashboardAssets } from '@blackcat/api/server';
import { buildAdminBusinessNavigation } from '@blackcat/dashboard/admin-business';
import { buildDashboardNavigation } from '@blackcat/dashboard/dashboard-shell';
import { buildSettlementNavigation } from '@blackcat/dashboard/settlements';
import {
  buildTargetBalanceRequest,
  canManageSandboxFunding,
  getSandboxBanner,
  hasFeature,
  resolveDashboardBusinessEnvironment,
  setSandboxTargetBalance,
  type DashboardCapabilities
} from '@blackcat/dashboard/sandbox-funding';

describe('M5-US-07 Sandbox Dashboard', () => {
  const capabilities: DashboardCapabilities = {
    permissions: ['sandbox_funding.manage'],
    enabledFeatures: ['CORE_ORDER'],
    businessEnvironment: 'SANDBOX',
    displayRole: 'OWNER'
  };

  it('derives the banner, owner control and feature visibility only from capabilities', () => {
    expect(getSandboxBanner(capabilities.businessEnvironment)).toBe('SANDBOX 测试环境 · 测试余额不代表真实资金');
    expect(canManageSandboxFunding(capabilities)).toBe(true);
    expect(hasFeature(capabilities, 'GIFTS')).toBe(false);
    expect(hasFeature(capabilities, 'REFERRALS')).toBe(false);
    expect(hasFeature(capabilities, 'M6')).toBe(false);
    expect(canManageSandboxFunding({ ...capabilities, displayRole: 'STAFF' })).toBe(false);
    expect(getSandboxBanner('PRODUCTION')).toBeNull();
  });

  it('lets authenticated capabilities override the public environment only with a closed enum value', () => {
    expect(resolveDashboardBusinessEnvironment('SANDBOX', 'PRODUCTION')).toBe('PRODUCTION');
    expect(resolveDashboardBusinessEnvironment('SANDBOX', 'SANDBOX')).toBe('SANDBOX');
    expect(resolveDashboardBusinessEnvironment('SANDBOX', 'malformed')).toBe('SANDBOX');
    expect(resolveDashboardBusinessEnvironment(undefined, 'malformed')).toBeUndefined();
  });

  it('submits only server-owned target fields', () => {
    const request = buildTargetBalanceRequest({ currency: 'CNY', version: 3 }, 100_000);
    expect(request).toEqual({
      currency: 'CNY',
      targetProviderBalanceMinor: 100_000,
      expectedVersion: 3,
      reasonCode: 'SANDBOX_TEST_SETUP'
    });
    expect(request).not.toHaveProperty('availableMinor');
    expect(request).not.toHaveProperty('reservedMinor');
    expect(request).not.toHaveProperty('deltaMinor');
    expect(() => buildTargetBalanceRequest({ currency: 'CNY', version: 3 }, -1)).toThrow(/non-negative/u);
  });

  it('hides disabled navigation and exposes the Sandbox balance page only to OWNER', () => {
    expect(buildAdminBusinessNavigation(
      ['order.read', 'gift_catalog.read', 'gift_request.read', 'commission.read'],
      capabilities.enabledFeatures
    ).map((item) => item.id)).toEqual(['orders']);
    expect(buildSettlementNavigation(['settlement.read', 'weekly_report.read'], capabilities.enabledFeatures)).toEqual([]);
    expect(buildDashboardNavigation(capabilities).map((item) => item.id)).toContain('sandboxFunding');
    expect(buildDashboardNavigation({ ...capabilities, displayRole: 'STAFF' }).map((item) => item.id)).not.toContain('sandboxFunding');
  });

  it('reloads the authoritative account after a 409 and requires an intentional retry', async () => {
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: account(4) }), { status: 200 }));
    const post = vi.fn().mockResolvedValue(new Response(JSON.stringify({ requestId: 'req_conflict', error: { code: 'VERSION_CONFLICT' } }), { status: 409 }));
    await expect(setSandboxTargetBalance({ get, post }, 'user-1', account(3), 100_000)).resolves.toEqual({
      kind: 'CONFLICT',
      account: account(4),
      errorCode: 'VERSION_CONFLICT',
      requestId: 'req_conflict'
    });
    expect(post).toHaveBeenCalledWith(
      '/api/v1/admin/sandbox-funding/accounts/user-1/target-balance',
      buildTargetBalanceRequest(account(3), 100_000)
    );
    expect(get).toHaveBeenCalledWith('/api/v1/admin/sandbox-funding/accounts/user-1');
  });

  it('rejects a loaded-account and requested-user mismatch before any network write', async () => {
    const get = vi.fn();
    const post = vi.fn();

    await expect(setSandboxTargetBalance(
      { get, post },
      'user-2',
      account(3),
      100_000
    )).rejects.toThrow(/loaded account userId/u);

    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('injects the runtime Sandbox environment into public Dashboard HTML before authentication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blackcat-m5-us-07-'));
    const server = buildApiServer({
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: '',
        API_PORT: '0',
        API_BASE_URL: 'http://localhost:3000',
        BOT_SERVICE_TOKEN: 'test-token'
      }
    });
    try {
      await mkdir(join(root, 'assets'));
      await writeFile(
        join(root, 'index.html'),
        '<div id="root" data-business-environment="__BLACKCAT_BUSINESS_ENV__"></div>'
      );
      await registerDashboardAssets(server, root, { businessEnvironment: 'SANDBOX' });

      const response = await server.inject({
        method: 'GET',
        url: '/',
        headers: { accept: 'text/html' }
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('data-business-environment="SANDBOX"');
      expect(response.body).not.toContain('__BLACKCAT_BUSINESS_ENV__');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes presentation-only STAFF and OWNER roles without changing internal levels', async () => {
    await expect(buildCapabilities('staff-2', 'L2_SUPERVISOR', 1)).resolves.toMatchObject({ level: 'L2_SUPERVISOR', displayRole: 'STAFF' });
    await expect(buildCapabilities('staff-4', 'L4_ADMIN_OWNER', 1)).resolves.toMatchObject({ level: 'L4_ADMIN_OWNER', displayRole: 'OWNER' });
    await expect(buildCapabilities('staff-1', 'L1_SUPPORT', 1)).resolves.toMatchObject({ level: 'L1_SUPPORT', displayRole: null });
    await expect(buildCapabilities('staff-3', 'L3_OPERATIONS', 1)).resolves.toMatchObject({ level: 'L3_OPERATIONS', displayRole: null });
  });

  it('keeps gifts hidden while CORE_ORDER still exposes scoped admin consumption history', async () => {
    const store = {
      listGiftCatalog: vi.fn(),
      listUserConsumptions: vi.fn().mockResolvedValue({ items: [], nextCursor: null })
    };
    const server = buildApiServer({
      env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'test-token' },
      security: {
        pilotFeaturePolicy: createPilotFeaturePolicy('CORE_ORDER'),
        dashboardGuildId: '999999999999999999',
        dashboardSessions: {
          resolve: () => ({ ok: true as const, staff: { staffId: '00000000-0000-0000-0000-000000000010', userId: '00000000-0000-0000-0000-000000000011',
            level: 'L4_ADMIN_OWNER' as const, permissionsVersion: 1, status: 'ACTIVE' as const }, csrfToken: 'csrf' }),
          verifyCsrf: () => true
        }
      },
      adminDirectory: {
        store: store as never,
        customerScope: { canReadCustomer: vi.fn().mockResolvedValue(true) }
      }
    });
    const headers = { cookie: 'p0_session=owner', 'x-client-source': 'DASHBOARD' };
    const gift = await server.inject({ method: 'GET', url: '/api/v1/admin/gift-catalog', headers });
    const consumptions = await server.inject({ method: 'GET', url: '/api/v1/admin/users/00000000-0000-0000-0000-000000000099/consumptions', headers });
    expect([gift.statusCode, consumptions.statusCode]).toEqual([409, 200]);
    expect(gift.json()).toMatchObject({ error: { code: 'FEATURE_DISABLED' } });
    expect(store.listGiftCatalog).not.toHaveBeenCalled();
    expect(store.listUserConsumptions).toHaveBeenCalledOnce();
  });
});

function account(version: number) {
  return {
    userId: 'user-1',
    providerBalanceMinor: 80_000,
    reservedMinor: 5_000,
    availableMinor: 75_000,
    currency: 'CNY' as const,
    fetchedAt: '2026-07-19T12:00:00.000Z',
    version
  };
}
