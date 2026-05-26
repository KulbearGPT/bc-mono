export type ModuleState<T> = { kind: 'LOADING'; data?: T } | { kind: 'READY'; data: T } | { kind: 'EMPTY'; data?: T }
  | { kind: 'ERROR'; requestId: string | null; data?: T } | { kind: 'FORBIDDEN'; requestId: string | null; data?: T };
export type PageModule = { kind: 'LOADING' | 'READY' | 'EMPTY' | 'ERROR' | 'FORBIDDEN'; items: Array<Record<string, unknown>>; nextCursor: string | null; requestId?: string | null };
export interface CustomerProfileModules {
  identity: ModuleState<Record<string, unknown>>;
  balance: ModuleState<Record<string, unknown>>;
  statistics: ModuleState<Record<string, unknown>>;
  orders: PageModule;
  consumptions: PageModule;
  preferences: ModuleState<Record<string, unknown>>;
  internal: ModuleState<Record<string, unknown>> & { notes?: Array<Record<string, unknown>>; riskFlags?: string[] };
}
export interface CustomerProfileView { modules: CustomerProfileModules; hasVisibleContent: boolean }

export function buildCustomerProfileRequests(userId: string, window: 'DAYS_30' | 'DAYS_90' | 'ALL') { const encoded = encodeURIComponent(userId); return {
  summary: `/api/v1/admin/users/${encoded}/profile-summary?window=${window}`,
  orders: `/api/v1/admin/users/${encoded}/orders?limit=25`, consumptions: `/api/v1/admin/users/${encoded}/consumptions?limit=25` }; }
export function buildCustomerProfileView(modules: CustomerProfileModules): CustomerProfileView { return { modules,
  hasVisibleContent: Object.values(modules).some((module) => module.kind === 'READY' || module.kind === 'EMPTY' || (module.kind === 'ERROR' && 'data' in module && module.data)) }; }
export function appendCursor(path: string, cursor: string) { return `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`; }
export function formatProfileMoney(value: unknown, currency: unknown) { if (!Number.isSafeInteger(value)) return '—'; return new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency: typeof currency === 'string' ? currency : 'USD', currencyDisplay:'code', minimumFractionDigits: 2 }).format(Number(value) / 100); }
