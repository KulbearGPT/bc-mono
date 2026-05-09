export interface DashboardCapabilities {
  permissions: string[];
}

export interface DashboardNavigationItem {
  id: 'overview' | 'support' | 'operations' | 'access';
  label: string;
  href: string;
}

const navigationRules: Array<DashboardNavigationItem & { permission: string }> = [
  { id: 'overview', label: '运营概览', href: '/', permission: 'dashboard.view' },
  { id: 'support', label: '客服工作台', href: '/support', permission: 'staff_task.read' },
  { id: 'operations', label: '业务管理', href: '/operations', permission: 'catalog.manage' },
  { id: 'access', label: '权限管理', href: '/access', permission: 'access.manage' }
];

export function buildDashboardNavigation(capabilities: DashboardCapabilities): DashboardNavigationItem[] {
  const permissions = new Set(capabilities.permissions);
  return navigationRules
    .filter((item) => permissions.has(item.permission))
    .map(({ permission: _permission, ...item }) => item);
}

export function buildDashboardState(input: { status: number; capabilities?: DashboardCapabilities }) {
  if (input.status === 401) return { kind: 'SIGNED_OUT' as const };
  if (input.status === 403) return { kind: 'FORBIDDEN' as const };
  if (input.status >= 400 || !input.capabilities) return { kind: 'ERROR' as const };
  return {
    kind: 'READY' as const,
    navigation: buildDashboardNavigation(input.capabilities)
  };
}

export function createDashboardApiClient(options: {
  fetch?: typeof fetch;
  cookie?: () => string;
} = {}) {
  const request = options.fetch ?? fetch;
  const cookie = options.cookie ?? (() => document.cookie);
  return {
    get(path: string) {
      return request(path, { credentials: 'include', headers: { accept: 'application/json' } });
    },
    post(path: string, body: unknown) {
      const csrfToken = readCookie(cookie(), 'p0_csrf');
      return request(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken ?? '' },
        body: JSON.stringify(body)
      });
    }
  };
}

function readCookie(cookie: string, name: string): string | null {
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}
