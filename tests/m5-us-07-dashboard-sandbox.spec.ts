import { describe, expect, it, vi } from 'vitest';
import { buildCapabilities } from '@blackcat/api/dashboard-auth';
import { createPilotFeaturePolicy } from '@blackcat/api/pilot-features';
import { buildApiServer } from '@blackcat/api/server';
import { buildAdminBusinessNavigation } from '@blackcat/dashboard/admin-business';
import { buildDashboardNavigation } from '@blackcat/dashboard/dashboard-shell';
import { buildSettlementNavigation } from '@blackcat/dashboard/settlements';
import {
  buildTargetBalanceRequest,
  canManageSandboxFunding,
  getSandboxBanner,
  hasFeature,
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

  it('publishes presentation-only STAFF and OWNER roles without changing internal levels', async () => {
    await expect(buildCapabilities('staff-2', 'L2_SUPERVISOR', 1)).resolves.toMatchObject({ level: 'L2_SUPERVISOR', displayRole: 'STAFF' });
    await expect(buildCapabilities('staff-4', 'L4_ADMIN_OWNER', 1)).resolves.toMatchObject({ level: 'L4_ADMIN_OWNER', displayRole: 'OWNER' });
    await expect(buildCapabilities('staff-1', 'L1_SUPPORT', 1)).resolves.toMatchObject({ level: 'L1_SUPPORT', displayRole: null });
    await expect(buildCapabilities('staff-3', 'L3_OPERATIONS', 1)).resolves.toMatchObject({ level: 'L3_OPERATIONS', displayRole: null });
  });

  it('keeps hidden admin gift and M6 routes behind the same API policy', async () => {
    const store = { listGiftCatalog: vi.fn(), listUserConsumptions: vi.fn() };
    const server = buildApiServer({
      env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'test-token' },
      security: {
        pilotFeaturePolicy: createPilotFeaturePolicy('CORE_ORDER'),
        dashboardSessions: {
          resolve: () => ({ ok: true as const, staff: { staffId: '00000000-0000-0000-0000-000000000010', userId: '00000000-0000-0000-0000-000000000011',
            level: 'L4_ADMIN_OWNER' as const, permissionsVersion: 1, status: 'ACTIVE' as const }, csrfToken: 'csrf' }),
          verifyCsrf: () => true
        }
      },
      adminDirectory: { store: store as never }
    });
    const headers = { cookie: 'p0_session=owner', 'x-client-source': 'DASHBOARD' };
    const gift = await server.inject({ method: 'GET', url: '/api/v1/admin/gift-catalog', headers });
    const m6 = await server.inject({ method: 'GET', url: '/api/v1/admin/users/00000000-0000-0000-0000-000000000099/consumptions', headers });
    expect([gift.statusCode, m6.statusCode]).toEqual([409, 409]);
    expect(gift.json()).toMatchObject({ error: { code: 'FEATURE_DISABLED' } });
    expect(m6.json()).toMatchObject({ error: { code: 'FEATURE_DISABLED' } });
    expect(store.listGiftCatalog).not.toHaveBeenCalled();
    expect(store.listUserConsumptions).not.toHaveBeenCalled();
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
