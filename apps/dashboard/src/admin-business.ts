export type AdminBusinessPageId =
  | 'orders'
  | 'users'
  | 'players'
  | 'serviceCatalog'
  | 'giftCatalog'
  | 'giftRequests'
  | 'commissions'
  | 'playerEarnings';

export type AdminPageStatus = 'LOADING' | 'READY' | 'ERROR';

export interface AdminBusinessNavigationItem {
  id: AdminBusinessPageId;
  label: string;
  href: string;
}

export interface AdminBusinessAction {
  id: string;
  label: string;
  requiresReason: boolean;
  scope: 'COLLECTION' | 'ITEM';
}

export interface AdminActionRequest {
  method: 'POST' | 'PUT' | 'PATCH';
  path: string;
  body: Record<string, unknown>;
}

export interface AdminBusinessDetailState {
  kind: 'LOADING' | 'READY' | 'ERROR' | 'FORBIDDEN';
  page: 'orders' | 'users' | 'players' | 'giftRequests';
  requestId: string | null;
  data: Record<string, unknown> | null;
  consumptions?: {
    kind: 'LOADING' | 'READY' | 'EMPTY' | 'ERROR';
    requestId: string | null;
    items: ReadonlyArray<Record<string, unknown>>;
    nextCursor: string | null;
  };
  timelinePage?: {
    kind: 'READY' | 'LOADING' | 'ERROR';
    requestId: string | null;
  };
}

export interface AdminTimelineRow { id: string; type: string; status: string; direction: string; amountMinor: number | null; currency: string | null; occurredAt: string }

export interface AdminBusinessPageInput {
  page: AdminBusinessPageId;
  permissions: string[];
  status: AdminPageStatus;
  items?: ReadonlyArray<Record<string, unknown>>;
  nextCursor?: string | null;
  requestId?: string | null;
}

export interface AdminBusinessPageModel {
  page: AdminBusinessPageId;
  title: string;
  endpoint: string;
  kind: 'LOADING' | 'EMPTY' | 'ERROR' | 'FORBIDDEN' | 'READY';
  items: ReadonlyArray<Record<string, unknown>>;
  filters: ReadonlyArray<{ id: string; label: string }>;
  actions: AdminBusinessAction[];
  pagination: { hasNext: boolean; nextCursor: string | null };
  requestId: string | null;
  requiredPermission: string;
}

interface AdminPageDefinition {
  id: AdminBusinessPageId;
  label: string;
  href: string;
  endpoint: string;
  readPermission: string;
  filters: ReadonlyArray<{ id: string; label: string }>;
  actions: ReadonlyArray<AdminBusinessAction & { permission: string }>;
}

const pageDefinitions: readonly AdminPageDefinition[] = [
  {
    id: 'orders', label: '订单', href: '/admin/orders', endpoint: '/api/v1/admin/orders', readPermission: 'order.read',
    filters: [{ id: 'query', label: '订单号或用户标识' }, { id: 'status', label: '订单状态' }], actions: []
  },
  {
    id: 'users', label: '用户', href: '/admin/users', endpoint: '/api/v1/admin/users', readPermission: 'user.read',
    filters: [{ id: 'query', label: 'Discord ID 或业务用户 ID' }],
    actions: [
      { id: 'CREATE_RISK_EVENT', label: '记录风险事件', permission: 'user.risk.manage', requiresReason: false, scope: 'ITEM' },
      { id: 'SET_OPERATIONAL_STATUS', label: '更新运营状态', permission: 'user.status.manage', requiresReason: true, scope: 'ITEM' }
    ]
  },
  {
    id: 'players', label: '陪玩', href: '/admin/players', endpoint: '/api/v1/admin/players', readPermission: 'player.read',
    filters: [{ id: 'reviewStatus', label: '准入状态' }],
    actions: []
  },
  {
    id: 'serviceCatalog', label: '服务目录', href: '/admin/service-catalog', endpoint: '/api/v1/admin/service-catalog', readPermission: 'catalog.read',
    filters: [],
    actions: [
      { id: 'CREATE_SERVICE_VERSION', label: '创建服务版本', permission: 'catalog.manage', requiresReason: true, scope: 'COLLECTION' },
      { id: 'UPDATE_VERSION', label: '更新版本状态', permission: 'catalog.manage', requiresReason: true, scope: 'ITEM' }
    ]
  },
  {
    id: 'giftCatalog', label: '礼物目录', href: '/admin/gift-catalog', endpoint: '/api/v1/admin/gift-catalog', readPermission: 'gift_catalog.read',
    filters: [],
    actions: [
      { id: 'CREATE_GIFT', label: '创建礼物', permission: 'gift_catalog.manage', requiresReason: true, scope: 'COLLECTION' },
      { id: 'UPDATE_GIFT_VERSION', label: '更新礼物版本', permission: 'gift_catalog.manage', requiresReason: true, scope: 'ITEM' }
    ]
  },
  {
    id: 'giftRequests', label: '礼物请求', href: '/admin/gift-requests', endpoint: '/api/v1/admin/gift-requests', readPermission: 'gift_request.read',
    filters: [{ id: 'status', label: '礼物状态' }], actions: []
  },
  {
    id: 'commissions', label: '返佣', href: '/admin/commissions', endpoint: '/api/v1/admin/commissions', readPermission: 'commission.read',
    filters: [{ id: 'status', label: '返佣状态' }],
    actions: []
  },
  {
    id: 'playerEarnings', label: '陪玩收益', href: '/admin/player-earnings', endpoint: '/api/v1/admin/player-earnings', readPermission: 'earnings.read',
    filters: [{ id: 'playerId', label: '陪玩 ID' }, { id: 'status', label: '收益状态' }],
    actions: [
      { id: 'CONFIRM', label: '确认收益', permission: 'earnings.manage', requiresReason: true, scope: 'ITEM' },
      { id: 'MARK_PAID', label: '标记已支付', permission: 'earnings.manage', requiresReason: true, scope: 'ITEM' }
    ]
  }
];

export function buildAdminBusinessNavigation(permissions: string[]): AdminBusinessNavigationItem[] {
  const allowed = new Set(permissions);
  return pageDefinitions
    .filter((page) => allowed.has(page.readPermission))
    .map(({ id, label, href }) => ({ id, label, href }));
}

export function resolveAdminBusinessPage(pathname: string): AdminBusinessPageId | null {
  return pageDefinitions.find((page) => page.href === pathname)?.id ?? null;
}

export function buildAdminBusinessPage(input: AdminBusinessPageInput): AdminBusinessPageModel {
  const definition = requirePageDefinition(input.page);
  const permissions = new Set(input.permissions);
  const permitted = permissions.has(definition.readPermission);
  const sourceItems = input.items ?? [];
  const kind = !permitted
    ? 'FORBIDDEN'
    : input.status === 'ERROR'
      ? 'ERROR'
      : input.status === 'LOADING'
        ? 'LOADING'
        : sourceItems.length === 0
          ? 'EMPTY'
          : 'READY';
  const mayExposeItems = kind === 'READY' || kind === 'EMPTY';

  return {
    page: definition.id,
    title: definition.label,
    endpoint: definition.endpoint,
    kind,
    items: mayExposeItems ? sourceItems : [],
    filters: definition.filters,
    actions: permitted
      ? definition.actions
        .filter((action) => permissions.has(action.permission))
        .map(({ permission: _permission, ...action }) => action)
      : [],
    pagination: {
      hasNext: permitted && Boolean(input.nextCursor),
      nextCursor: permitted ? input.nextCursor ?? null : null
    },
    requestId: kind === 'ERROR' ? input.requestId ?? null : null,
    requiredPermission: definition.readPermission
  };
}

export function buildAdminResourceQuery(input: {
  cursor?: string | null;
  limit?: number;
  query?: string | null;
  status?: string | null;
  reviewStatus?: string | null;
  playerId?: string | null;
}): string {
  const params = new URLSearchParams();
  appendTrimmed(params, 'cursor', input.cursor);
  if (input.limit !== undefined) {
    const limit = Number.isFinite(input.limit) ? Math.min(100, Math.max(1, Math.trunc(input.limit))) : 50;
    params.set('limit', String(limit));
  }
  appendTrimmed(params, 'query', input.query);
  appendTrimmed(params, 'status', input.status);
  appendTrimmed(params, 'reviewStatus', input.reviewStatus);
  appendTrimmed(params, 'playerId', input.playerId);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function formatMinorCurrency(amountMinor: number, currency: string, locale = 'zh-CN'): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new TypeError('Amounts must use safe integer minor units.');
  }
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountMinor / (10 ** fractionDigits));
}

export function buildAdminDetailRequest(
  page: AdminBusinessPageId,
  item: Record<string, unknown>
): string {
  if (!['orders', 'users', 'players', 'giftRequests'].includes(page)) {
    throw new TypeError(`${page} does not expose a detail endpoint.`);
  }
  const id = page === 'players' ? requireText(item.playerId, 'playerId') : requireText(item.id, 'id');
  const resource = page === 'orders' ? 'orders' : page === 'users' ? 'users' : page === 'players' ? 'players' : 'gift-requests';
  return `/api/v1/admin/${resource}/${encodeURIComponent(id)}`;
}

export function buildAdminOrderTimelineRequest(orderId: string, cursor: string): string {
  const params = new URLSearchParams({ timelineCursor: requireText(cursor, 'timelineCursor'), timelineLimit: '25' });
  return `/api/v1/admin/orders/${encodeURIComponent(requireText(orderId, 'orderId'))}?${params.toString()}`;
}

export function readAdminOrderTimeline(data: Record<string, unknown>): { items: AdminTimelineRow[]; nextCursor: string | null } {
  const timeline = data.timeline;
  if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) return { items: [], nextCursor: null };
  const record = timeline as { items?: unknown; nextCursor?: unknown };
  const items = Array.isArray(record.items) ? record.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))).map((item) => ({
    id: typeof item.id === 'string' ? item.id : '', type: typeof item.type === 'string' ? item.type : 'UNKNOWN', status: typeof item.status === 'string' ? item.status : 'UNKNOWN',
    direction: typeof item.direction === 'string' ? item.direction : 'INFO', amountMinor: Number.isSafeInteger(item.amountMinor) ? Number(item.amountMinor) : null,
    currency: typeof item.currency === 'string' ? item.currency : null, occurredAt: typeof item.occurredAt === 'string' ? item.occurredAt : ''
  })) : [];
  return { items, nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : null };
}

export function buildAdminUserConsumptionRequest(userId: string, cursor: string | null = null): string {
  return `/api/v1/admin/users/${encodeURIComponent(requireText(userId, 'userId'))}/consumptions${buildAdminResourceQuery({ cursor, limit: 25 })}`;
}

export function buildAdminActionRequest(input: {
  actionId: string;
  item?: Record<string, unknown>;
  fields: Record<string, string | boolean>;
}): AdminActionRequest {
  if (input.actionId === 'SET_OPERATIONAL_STATUS') {
    const item = requireItem(input.item);
    const status = requireEnum(input.fields.status, ['ACTIVE', 'PAUSED', 'SUSPENDED'], 'status');
    const reasonCode = requireReasonCode(input.fields.reasonCode);
    return {
      method: 'PUT', path: `/api/v1/admin/users/${encodeURIComponent(item.id)}/operational-status`,
      body: { expectedVersion: item.version, status, reasonCode, note: optionalText(input.fields.note) }
    };
  }
  if (input.actionId === 'CREATE_GIFT') {
    return {
      method: 'POST', path: '/api/v1/admin/gift-catalog',
      body: buildGiftCatalogCreateBody(input.fields, requireReasonCode(input.fields.reasonCode))
    };
  }
  if (input.actionId === 'CREATE_SERVICE_VERSION') {
    const reasonCode = requireReasonCode(input.fields.reasonCode);
    return { method: 'POST', path: '/api/v1/admin/service-catalog', body: buildServiceCatalogCreateBody(input.fields, reasonCode) };
  }
  if (input.actionId === 'UPDATE_GIFT_VERSION') {
    const item = requireItem(input.item);
    const action = requireEnum(input.fields.action, ['ENABLE', 'DISABLE', 'CREATE_REPLACEMENT_VERSION'], 'action');
    const reasonCode = requireReasonCode(input.fields.reasonCode);
    return {
      method: 'PATCH', path: `/api/v1/admin/gift-catalog/${encodeURIComponent(item.id)}`,
      body: { expectedVersion: item.version, action, reasonCode, replacement: action === 'CREATE_REPLACEMENT_VERSION' ? buildGiftCatalogCreateBody(input.fields, reasonCode) : null }
    };
  }
  if (input.actionId === 'UPDATE_VERSION') {
    const item = requireItem(input.item);
    const action = requireEnum(input.fields.action, ['ENABLE', 'DISABLE', 'SUPERSEDE'], 'action');
    const reasonCode = requireReasonCode(input.fields.reasonCode);
    return {
      method: 'PATCH', path: `/api/v1/admin/service-catalog/${encodeURIComponent(item.id)}`,
      body: { expectedVersion: item.version, action, reasonCode, replacement: action === 'SUPERSEDE' ? buildServiceCatalogCreateBody(input.fields, reasonCode) : null }
    };
  }
  if (input.actionId === 'CREATE_RISK_EVENT') {
    const item = requireItem(input.item);
    return {
      method: 'POST', path: `/api/v1/admin/users/${encodeURIComponent(item.id)}/risk-events`,
      body: {
        type: requireEnum(input.fields.type, ['PLAYER_NO_SHOW', 'CUSTOMER_NO_SHOW', 'DUPLICATE_ACCOUNT_SIGNAL', 'REFERRAL_ABUSE_SIGNAL', 'PAYMENT_ANOMALY'], 'type'),
        severity: requireEnum(input.fields.severity, ['LOW', 'MEDIUM', 'HIGH'], 'severity'),
        source: requireEnum(input.fields.source, ['STAFF_REVIEW', 'CUSTOMER_REPORT', 'PLAYER_REPORT', 'SYSTEM_SIGNAL'], 'source'),
        notes: requireText(input.fields.notes, 'notes', 2_000),
        orderId: optionalText(input.fields.orderId)
      }
    };
  }
  if (input.actionId === 'CONFIRM' || input.actionId === 'MARK_PAID') {
    const item = requireItem(input.item);
    const reasonCode = requireReasonCode(input.fields.reasonCode);
    return {
      method: 'PATCH', path: `/api/v1/admin/player-earnings/${encodeURIComponent(item.id)}`,
      body: { expectedVersion: item.version, action: input.actionId, reasonCode }
    };
  }
  throw new TypeError(`Action ${input.actionId} does not have a complete form and API mapping.`);
}

function requirePageDefinition(page: AdminBusinessPageId): AdminPageDefinition {
  const definition = pageDefinitions.find((candidate) => candidate.id === page);
  if (!definition) throw new TypeError(`Unsupported admin business page: ${page}`);
  return definition;
}

function appendTrimmed(params: URLSearchParams, key: string, value: string | null | undefined): void {
  const normalized = value?.trim();
  if (normalized) params.set(key, normalized);
}

function requireItem(item: Record<string, unknown> | undefined): { id: string; version: number } {
  if (!item) throw new TypeError('An item is required for this action.');
  const id = requireText(item.id, 'id');
  if (!Number.isSafeInteger(item.version) || Number(item.version) < 1) throw new TypeError('A valid item version is required.');
  return { id, version: Number(item.version) };
}

function requireReasonCode(value: string | boolean | undefined): string {
  const reasonCode = requireText(value, 'reasonCode');
  if (!/^[A-Z0-9_]{3,100}$/.test(reasonCode)) throw new TypeError('reasonCode must contain 3-100 uppercase letters, numbers, or underscores.');
  return reasonCode;
}

function requireText(value: unknown, field: string, maxLength = Number.POSITIVE_INFINITY): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) throw new TypeError(`${field} is required.`);
  return value.trim();
}

function optionalText(value: string | boolean | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireEnum<T extends string>(value: string | boolean | undefined, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new TypeError(`${field} is invalid.`);
  return value as T;
}

function requirePositiveInteger(value: string | boolean | undefined, field: string): number {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${field} must be a positive integer.`);
  return parsed;
}

function requireIntegerInRange(value: string | boolean | undefined, field: string, minimum: number, maximum: number): number {
  const parsed = requirePositiveInteger(value, field);
  if (parsed < minimum || parsed > maximum) throw new TypeError(`${field} must be between ${minimum} and ${maximum}.`);
  return parsed;
}

function requireCurrency(value: string | boolean | undefined): string {
  const currency = requireText(value, 'currency');
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError('currency must be a three-letter uppercase code.');
  return currency;
}

function buildServiceCatalogCreateBody(fields: Record<string, string | boolean>, reasonCode: string) {
  const currency = requireCurrency(fields.currency);
  return {
    game: requireText(fields.game, 'game', 100),
    service: requireText(fields.service, 'service', 100),
    region: optionalText(fields.region),
    billingUnitMinutes: requireIntegerInRange(fields.billingUnitMinutes, 'billingUnitMinutes', 1, 1_440),
    minimumUnits: requireIntegerInRange(fields.minimumUnits, 'minimumUnits', 1, 1_440),
    customerUnitPrice: { amountMinor: requirePositiveInteger(fields.customerAmountMinor, 'customerAmountMinor'), currency },
    playerUnitPayout: { amountMinor: requirePositiveInteger(fields.playerAmountMinor, 'playerAmountMinor'), currency },
    enabled: fields.enabled === true,
    reasonCode
  };
}

function buildGiftCatalogCreateBody(fields: Record<string, string | boolean>, reasonCode: string) {
  return {
    name: requireText(fields.name, 'name', 100),
    price: { amountMinor: requirePositiveInteger(fields.amountMinor, 'amountMinor'), currency: requireCurrency(fields.currency) },
    enabled: fields.enabled === true,
    broadcastTemplate: requireText(fields.broadcastTemplate, 'broadcastTemplate', 500),
    reasonCode
  };
}
