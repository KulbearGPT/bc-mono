export type OperationsLoadStatus = 'LOADING' | 'READY' | 'ERROR';
export type OperationsViewKind = 'LOADING' | 'EMPTY' | 'ERROR' | 'FORBIDDEN' | 'READY';

export interface OperationsErrorEnvelope {
  requestId: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: ReadonlyArray<unknown>;
  };
}

export interface OperationsErrorView {
  code: string;
  message: string;
  retryable: boolean;
  requestId: string;
  requestIdLabel: string;
}

export interface AuditLogRow {
  id: string;
  actorId: string | null;
  actorLevel: string | null;
  actorSource: string;
  clientId: string;
  interactionId: string | null;
  permissionCode: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  requestId: string;
  approvalRequestId: string | null;
  occurredAt: string;
}

export interface FailedJobRow {
  id: string;
  type: string;
  status: string;
  attempts: number;
  lastError: string | null;
  runAfter: string;
  version: number;
}

const manuallyRetryableJobTypes = new Set(['GIFT_ANNOUNCEMENT', 'DISPATCH_MESSAGE', 'CHANNEL_ARCHIVE', 'PANEL_SYNC']);

export interface PolicySettingRow {
  key: string;
  integerValue: number;
  currency: string | null;
  version: number;
}

interface ListViewInput<T> {
  permissions: string[];
  status: OperationsLoadStatus;
  items?: ReadonlyArray<T>;
  nextCursor?: string | null;
  requestId?: string | null;
}

interface OperationsWriteRequest {
  method: 'POST' | 'PUT';
  path: string;
  body: Record<string, unknown>;
}

export function buildOperationsError(input: OperationsErrorEnvelope): OperationsErrorView {
  return {
    code: input.error.code,
    message: input.error.message,
    retryable: input.error.retryable,
    requestId: input.requestId,
    requestIdLabel: `请求编号：${input.requestId}`
  };
}

export function buildAuditLogView(input: ListViewInput<AuditLogRow>) {
  const state = resolveListState(input, 'audit.read');
  return {
    endpoint: '/api/v1/admin/audit-logs',
    requiredPermission: 'audit.read',
    kind: state.kind,
    rows: state.exposeRows ? (input.items ?? []).map((row) => ({ ...row, readOnly: true as const })) : [],
    pagination: state.pagination,
    error: state.error
  };
}

export function buildFailedJobsView(
  input: ListViewInput<FailedJobRow> & { retryingJobIds?: ReadonlyArray<string> }
) {
  const state = resolveListState(input, 'job.read');
  const permissions = new Set(input.permissions);
  const retrying = new Set(input.retryingJobIds ?? []);
  return {
    endpoint: '/api/v1/admin/jobs',
    requiredPermission: 'job.read',
    kind: state.kind,
    rows: state.exposeRows
      ? (input.items ?? []).map((row) => {
        const visible = permissions.has('job.retry');
        const submitting = retrying.has(row.id);
        const enabled = visible && row.status === 'FAILED' && manuallyRetryableJobTypes.has(row.type) && !submitting;
        return {
          ...row,
          retry: {
            visible,
            enabled,
            state: submitting ? 'SUBMITTING' as const : enabled ? 'IDLE' as const : 'UNAVAILABLE' as const
          }
        };
      })
      : [],
    pagination: state.pagination,
    error: state.error
  };
}

export function buildPolicySettingsView(input: ListViewInput<PolicySettingRow>) {
  const state = resolveListState(input, 'policy.read');
  const canManage = input.permissions.includes('policy.manage');
  return {
    endpoint: '/api/v1/admin/policy-settings',
    requiredPermission: 'policy.read',
    kind: state.kind,
    rows: state.exposeRows
      ? (input.items ?? []).map((row) => ({
        ...row,
        edit: { visible: canManage, enabled: canManage }
      }))
      : [],
    error: state.error
  };
}

export function buildRetryJobRequest(
  job: FailedJobRow,
  reasonCode: string,
  note: string | null = null
): OperationsWriteRequest {
  const reason = requireText(reasonCode, 'reasonCode');
  return {
    method: 'POST',
    path: `/api/v1/admin/jobs/${encodeURIComponent(requireText(job.id, 'job.id'))}/retry`,
    body: {
      expectedVersion: requireVersion(job.version),
      reasonCode: reason,
      note: optionalText(note)
    }
  };
}

export function buildPanelRepairControl(permissions: ReadonlyArray<string>, submitting: boolean) {
  const visible = permissions.includes('job.retry');
  return { visible, enabled: visible && !submitting };
}

export function buildPanelRepairRequest(
  orderId: string,
  reasonCode: string,
  note: string | null = null
): OperationsWriteRequest {
  const normalizedOrderId = requireText(orderId, 'orderId');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(normalizedOrderId)) {
    throw new TypeError('orderId must be a valid UUID.');
  }
  return {
    method: 'POST',
    path: `/api/v1/admin/orders/${encodeURIComponent(normalizedOrderId)}/panel-repair`,
    body: {
      reasonCode: requireText(reasonCode, 'reasonCode'),
      note: optionalText(note)
    }
  };
}

export function buildUpdatePolicySettingRequest(
  setting: PolicySettingRow,
  update: { integerValue: number; currency: string | null; reasonCode: string }
): OperationsWriteRequest {
  if (!Number.isSafeInteger(update.integerValue) || update.integerValue < 0) {
    throw new TypeError('integerValue must be a non-negative safe integer.');
  }
  return {
    method: 'PUT',
    path: `/api/v1/admin/policy-settings/${encodeURIComponent(requireText(setting.key, 'setting.key'))}`,
    body: {
      expectedVersion: requireVersion(setting.version),
      integerValue: update.integerValue,
      currency: update.currency,
      reasonCode: requireText(update.reasonCode, 'reasonCode')
    }
  };
}

function resolveListState<T>(input: ListViewInput<T>, permission: string) {
  const permitted = input.permissions.includes(permission);
  const items = input.items ?? [];
  const kind: OperationsViewKind = !permitted
    ? 'FORBIDDEN'
    : input.status === 'ERROR'
      ? 'ERROR'
      : input.status === 'LOADING'
        ? 'LOADING'
        : items.length === 0
          ? 'EMPTY'
          : 'READY';
  const exposeRows = kind === 'READY' || kind === 'EMPTY';
  return {
    kind,
    exposeRows,
    pagination: {
      hasNext: permitted && exposeRows && Boolean(input.nextCursor),
      nextCursor: permitted && exposeRows ? input.nextCursor ?? null : null
    },
    error: kind === 'ERROR'
      ? buildOperationsError({
        requestId: input.requestId ?? 'unknown',
        error: { code: 'REQUEST_FAILED', message: '请求失败，请向技术支持提供请求编号。', retryable: true }
      })
      : null
  };
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} is required.`);
  return normalized;
}

function optionalText(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized || null;
}

function requireVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('version must be a positive safe integer.');
  return value;
}
