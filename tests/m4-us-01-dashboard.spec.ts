import { describe, expect, test } from 'vitest';
import {
  buildDashboardNavigation,
  buildDashboardState,
  createDashboardApiClient
} from '@blackcat/dashboard/dashboard-shell';

describe('M4-US-01 dashboard shell', () => {
  test('shows sign-in for 401 and a permission explanation for 403', () => {
    expect(buildDashboardState({ status: 401 })).toEqual({ kind: 'SIGNED_OUT' });
    expect(buildDashboardState({ status: 403 })).toEqual({ kind: 'FORBIDDEN' });
  });

  test('builds navigation only from server capabilities', () => {
    const navigation = buildDashboardNavigation({
      permissions: ['dashboard.view', 'staff_task.read', 'staff_task.claim']
    });
    expect(navigation.map((item) => item.id)).toEqual(['overview', 'support']);
    expect(navigation.map((item) => item.id)).not.toContain('access');
  });

  test('uses credentialed cookies and a transient CSRF cookie without localStorage', async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const client = createDashboardApiClient({
      cookie: () => 'p0_csrf=csrf-token',
      fetch: async (input, init) => {
        requests.push({ input: String(input), init });
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }
    });
    await client.get('/api/v1/admin/me/capabilities');
    await client.post('/api/v1/admin/probe', { ok: true });
    expect(requests[0]?.init?.credentials).toBe('include');
    expect(new Headers(requests[1]?.init?.headers).get('x-csrf-token')).toBe('csrf-token');
    expect(JSON.stringify(requests)).not.toContain('localStorage');
  });
});
