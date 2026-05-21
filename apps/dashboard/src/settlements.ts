export type SettlementSection = 'settlements' | 'reports';
export type SettlementAction = 'PREVIEW' | 'CREATE' | 'SUBMIT' | 'APPROVE' | 'EXPORT' | 'PAYMENT_RESULTS' | 'VOID';
export interface SettlementPageModel {
  section: SettlementSection; kind: 'LOADING' | 'READY' | 'EMPTY' | 'ERROR' | 'FORBIDDEN';
  items: Array<Record<string, unknown>>; actions: SettlementAction[]; requestId: string | null; alert: string | null;
}

export function buildSettlementNavigation(permissions: string[]) {
  return [
    permissions.includes('settlement.read') ? { id: 'settlements', label: '结算', href: '/settlements' } : null,
    permissions.includes('weekly_report.read') ? { id: 'reports', label: '周报', href: '/reports' } : null,
    permissions.includes('customer_profile.read') ? { id: 'profiles', label: '客户 Profile', href: '/admin/users' } : null
  ].filter((item): item is { id: string; label: string; href: string } => item !== null);
}

export function buildSettlementPage(input: { section: SettlementSection; permissions: string[]; status: 'LOADING' | 'READY' | 'ERROR';
  items: Array<Record<string, unknown>>; requestId?: string | null }): SettlementPageModel {
  const readPermission = input.section === 'settlements' ? 'settlement.read' : 'weekly_report.read';
  const actions: SettlementAction[] = [];
  if (input.section === 'settlements') {
    if (input.permissions.includes('settlement.manage')) actions.push('PREVIEW', 'CREATE', 'SUBMIT', 'EXPORT', 'PAYMENT_RESULTS');
    if (input.permissions.includes('settlement.approve')) actions.push('APPROVE');
    if (input.permissions.includes('settlement.void')) actions.push('VOID');
  }
  const failed = input.items.flatMap((item) => Array.isArray(item.items) ? item.items : [])
    .filter((item) => item && typeof item === 'object' && (item as Record<string, unknown>).paymentStatus === 'FAILED').length;
  return { section: input.section, kind: !input.permissions.includes(readPermission) ? 'FORBIDDEN' : input.status === 'ERROR' ? 'ERROR'
    : input.status === 'LOADING' ? 'LOADING' : input.items.length ? 'READY' : 'EMPTY', items: input.status === 'READY' ? input.items : [],
    actions, requestId: input.requestId ?? null, alert: failed ? `${failed} 个支付项目失败，可单独重试。` : null };
}

export function buildSettlementRequest(input: { action: SettlementAction; batchId?: string; version?: number; fields: Record<string, unknown> }) {
  if (input.action === 'PREVIEW' || input.action === 'CREATE') {
    const body = { ...periodFields(input.fields), source: 'MANUAL', playerUserIds: null };
    return { method: 'POST' as const, path: input.action === 'PREVIEW' ? '/api/v1/admin/settlement-batches/preview' : '/api/v1/admin/settlement-batches', body };
  }
  const batchId = required(input.batchId, 'batchId');
  if (input.action === 'EXPORT') return { method: 'GET' as const, path: `/api/v1/admin/settlement-batches/${encodeURIComponent(batchId)}/exports/${requiredString(input.fields.exportType, 'exportType')}`, body: null };
  if (input.action === 'PAYMENT_RESULTS') {
    const results = Array.isArray(input.fields.results) ? input.fields.results.map((value) => {
      const result = value as Record<string, unknown>; return { ...result,
        externalBatchReference: optionalString(result.externalBatchReference), note: optionalString(result.note) };
    }) : [];
    return { method: 'POST' as const, path: `/api/v1/admin/settlement-batches/${encodeURIComponent(batchId)}/payment-results`,
      body: { expectedBatchVersion: requiredVersion(input.version), results } };
  }
  const suffix = input.action === 'SUBMIT' ? 'submit' : input.action === 'APPROVE' ? 'approve' : 'void';
  const body: Record<string, unknown> = {
    expectedVersion: requiredVersion(input.version),
    reasonCode: requiredString(input.fields.reasonCode, 'reasonCode')
  };
  if (input.action === 'VOID') {
    const replacementBatchId = optionalString(input.fields.replacementBatchId);
    const replacement = optionalObject(input.fields.replacement, 'replacement');
    if (Boolean(replacementBatchId) !== Boolean(replacement)) {
      throw new TypeError('replacementBatchId and replacement must be provided together.');
    }
    if (replacementBatchId && replacement) Object.assign(body, { replacementBatchId, replacement });
  }
  return { method: 'POST' as const, path: `/api/v1/admin/settlement-batches/${encodeURIComponent(batchId)}/${suffix}`,
    body };
}

function periodFields(fields: Record<string, unknown>) { return { periodStart: requiredString(fields.periodStart, 'periodStart'),
  periodEnd: requiredString(fields.periodEnd, 'periodEnd'), cutoffAt: requiredString(fields.cutoffAt, 'cutoffAt'),
  timeZone: requiredString(fields.timeZone, 'timeZone'), currency: requiredString(fields.currency, 'currency') }; }
function required<T>(value: T | undefined, name: string): T { if (value === undefined || value === null || value === '') throw new TypeError(`${name} is required.`); return value; }
function requiredString(value: unknown, name: string) { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`); return value.trim(); }
function optionalString(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function optionalObject(value: unknown, name: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return { ...(value as Record<string, unknown>) };
}
function requiredVersion(value: number | undefined) { if (!Number.isInteger(value) || Number(value) < 1) throw new TypeError('version is required.'); return Number(value); }
