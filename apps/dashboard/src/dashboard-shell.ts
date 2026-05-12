export interface DashboardCapabilities {
  permissions: string[];
  staffId?: string;
  level?: string;
  thresholds?: { giftApprovalLimitMinor: number | null; refundLimitMinor: number | null; l4DirectExecutionFromMinor: number; currency: string };
  stepUp?: { requiredForSensitiveActions: boolean; validUntil: string | null };
  mfa?: { enrolled: boolean; method: 'TOTP' | null };
}

export interface DashboardNavigationItem {
  id: 'overview' | 'support' | 'security' | 'operations' | 'access';
  label: string;
  href: string;
}

const navigationRules: Array<DashboardNavigationItem & { permission: string }> = [
  { id: 'overview', label: '运营概览', href: '/', permission: 'dashboard.view' },
  { id: 'support', label: '客服工作台', href: '/support', permission: 'staff_task.read' },
  { id: 'security', label: '账户安全', href: '/security', permission: 'mfa.manage_self' },
  { id: 'operations', label: '系统运营', href: '/operations', permission: 'audit.read' },
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
  const write = (method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown, idempotencyKey?: string) => {
    const csrfToken = readCookie(cookie(), 'p0_csrf');
    return request(path, {
      method,
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-client-source': 'DASHBOARD',
        'x-csrf-token': csrfToken ?? '',
        'idempotency-key': idempotencyKey ?? `dashboard:${crypto.randomUUID()}`
      },
      body: JSON.stringify(body)
    });
  };
  return {
    get(path: string) {
      return request(path, { credentials: 'include', headers: { accept: 'application/json', 'x-client-source': 'DASHBOARD' } });
    },
    post(path: string, body: unknown, idempotencyKey?: string) {
      return write('POST', path, body, idempotencyKey);
    },
    put(path: string, body: unknown, idempotencyKey?: string) { return write('PUT', path, body, idempotencyKey); },
    patch(path: string, body: unknown, idempotencyKey?: string) { return write('PATCH', path, body, idempotencyKey); }
  };
}

function readCookie(cookie: string, name: string): string | null {
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}
