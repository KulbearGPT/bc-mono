export {
  buildAddOrderParticipantRequest,
  buildAdminActionRequest,
  buildUpdateAdminOrderNoteRequest,
  buildUpdateAdminOrderRequirementRequest,
  buildUpdateOrderParticipantRequest
} from './admin-business-actions.js';
export type { AdminActionRequest } from './admin-business-actions.js';
export { catInputToMinor, formatMinorCurrency, minorToCatInput } from './cat-money.js';

export type AdminBusinessPageId =
  | 'orders'
  | 'users'
  | 'players'
  | 'serviceCatalog'
  | 'servicePackages'
  | 'giftCatalog'
  | 'giftRequests'
  | 'commissions'
  | 'playerEarnings';

export type AdminPageStatus = 'LOADING' | 'READY' | 'ERROR';
export type AdminCollectionPageId = Extract<AdminBusinessPageId,'orders'|'users'|'players'|'serviceCatalog'|'servicePackages'|'giftCatalog'|'giftRequests'>;
export type AdminCollectionView = 'CARD' | 'TABLE';
export type AdminSortDirection = 'asc' | 'desc';
export interface AdminCollectionState {view:AdminCollectionView;sortBy:string;sortDirection:AdminSortDirection;filters:Record<string,string>}
export interface AdminCollectionConfig {sortOptions:ReadonlyArray<{id:string;label:string}>;defaultSort:{sortBy:string;sortDirection:AdminSortDirection};columns:ReadonlyArray<{key:string;label:string}>}

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
  enabled?: boolean;
  requiredPermission?: string;
  disabledReason?: string;
}

export interface AdminBusinessDetailState {
  kind: 'LOADING' | 'READY' | 'ERROR' | 'FORBIDDEN';
  page: 'orders' | 'users' | 'players' | 'serviceCatalog' | 'servicePackages' | 'giftCatalog' | 'giftRequests';
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
  transcriptPage?: {
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
  feature?: 'GIFTS' | 'REFERRALS';
}

const pageDefinitions: readonly AdminPageDefinition[] = [
  {
    id: 'orders', label: '订单', href: '/admin/orders', endpoint: '/api/v1/admin/orders', readPermission: 'order.read',
    filters: [{ id: 'query', label: '订单号或用户标识' }, { id: 'status', label: '订单状态' }],
    actions: [
      { id: 'REFUND_ORDER', label: '独立退款', permission: 'refund.execute', requiresReason: true, scope: 'ITEM' },
      { id: 'CANCEL_ORDER_RESOLUTION', label: '取消订单', permission: 'order.resolve', requiresReason: true, scope: 'ITEM' }
    ]
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
    actions: [
      { id: 'APPROVE_COMPANION', label: '批准陪玩申请', permission: 'player.approve', requiresReason: true, scope: 'ITEM' },
      { id: 'REJECT_COMPANION', label: '拒绝陪玩申请', permission: 'player.approve', requiresReason: true, scope: 'ITEM' },
      { id: 'SET_PLAYER_OPERATIONAL_STATUS', label: '管理接单资格', permission: 'player.status.manage', requiresReason: true, scope: 'ITEM' },
      { id: 'EDIT_COMPANION_TAGS', label: '编辑支持范围', permission: 'player.tags.manage', requiresReason: true, scope: 'ITEM' },
      { id: 'EDIT_PLAYER_COMPENSATION', label: '设置项目分成', permission: 'player.tags.manage', requiresReason: true, scope: 'ITEM' }
    ]
  },
  {
    id: 'serviceCatalog', label: '服务目录', href: '/admin/service-catalog', endpoint: '/api/v1/admin/service-catalog', readPermission: 'catalog.read',
    filters: [],
    actions: [
      { id: 'CREATE_SERVICE_VERSION', label: '创建服务版本', permission: 'catalog.manage', requiresReason: true, scope: 'COLLECTION' },
      { id: 'UPDATE_VERSION', label: '编辑服务项目', permission: 'catalog.manage', requiresReason: true, scope: 'ITEM' },
      { id: 'ARCHIVE_SERVICE', label: '归档服务项目', permission: 'catalog.manage', requiresReason: true, scope: 'ITEM' }
    ]
  },
  {
    id: 'servicePackages', label: '服务套餐', href: '/admin/service-packages', endpoint: '/api/v1/admin/service-packages', readPermission: 'catalog.read',
    filters: [],
    actions: [
      { id: 'CREATE_PACKAGE_VERSION', label: '创建套餐版本', permission: 'catalog.manage', requiresReason: true, scope: 'COLLECTION' },
      { id: 'COPY_PACKAGE_VERSION', label: '编辑套餐（创建新版本）', permission: 'catalog.manage', requiresReason: true, scope: 'ITEM' },
      { id: 'UPDATE_PACKAGE_STATUS', label: '发布或退役', permission: 'catalog.manage', requiresReason: true, scope: 'ITEM' }
    ]
  },
  {
    id: 'giftCatalog', label: '礼物目录', href: '/admin/gift-catalog', endpoint: '/api/v1/admin/gift-catalog', readPermission: 'gift_catalog.read',
    feature: 'GIFTS',
    filters: [],
    actions: [
      { id: 'CREATE_GIFT', label: '创建礼物', permission: 'gift_catalog.manage', requiresReason: true, scope: 'COLLECTION' },
      { id: 'UPDATE_GIFT_VERSION', label: '编辑礼物', permission: 'gift_catalog.manage', requiresReason: true, scope: 'ITEM' },
      { id: 'ARCHIVE_GIFT', label: '归档礼物', permission: 'gift_catalog.manage', requiresReason: true, scope: 'ITEM' }
    ]
  },
  {
    id: 'giftRequests', label: '礼物请求', href: '/admin/gift-requests', endpoint: '/api/v1/admin/gift-requests', readPermission: 'gift_request.read',
    feature: 'GIFTS',
    filters: [{ id: 'status', label: '礼物状态' }], actions: []
  },
  {
    id: 'commissions', label: '返佣', href: '/admin/commissions', endpoint: '/api/v1/admin/commissions', readPermission: 'commission.read',
    feature: 'REFERRALS',
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

const defaultSort={sortBy:'createdAt',sortDirection:'desc' as const};
export const adminCollectionConfigs:Record<AdminCollectionPageId,AdminCollectionConfig>={
  orders:{sortOptions:[{id:'createdAt',label:'创建时间'},{id:'updatedAt',label:'更新时间'},{id:'amountMinor',label:'订单金额'}],defaultSort,columns:[{key:'publicId',label:'订单号'},{key:'status',label:'状态'},{key:'customerDisplayName',label:'客户'},{key:'playerDisplayNames',label:'陪玩'},{key:'serviceSummary',label:'服务'},{key:'amountMinor',label:'订单金额'},{key:'updatedAt',label:'最近更新'}]},
  users:{sortOptions:[{id:'createdAt',label:'创建时间'},{id:'updatedAt',label:'更新时间'},{id:'displayName',label:'展示名称'}],defaultSort,columns:[{key:'displayName',label:'展示名称'},{key:'status',label:'状态'},{key:'discordUserId',label:'Discord 用户 ID'},{key:'activeOrderId',label:'当前订单'},{key:'createdAt',label:'创建时间'}]},
  players:{sortOptions:[{id:'createdAt',label:'创建时间'},{id:'updatedAt',label:'更新时间'},{id:'displayName',label:'展示名称'}],defaultSort,columns:[{key:'displayName',label:'展示名称'},{key:'reviewStatus',label:'准入状态'},{key:'discordPresence',label:'Discord 在线状态（参考）'},{key:'createdAt',label:'创建时间'}]},
  serviceCatalog:{sortOptions:[{id:'createdAt',label:'创建时间'},{id:'offeringName',label:'项目名称'},{id:'customerUnitPriceMinor',label:'客户单价'},{id:'version',label:'版本'}],defaultSort,columns:[{key:'gameDisplayName',label:'游戏'},{key:'serviceDisplayName',label:'服务'},{key:'status',label:'状态'},{key:'customerUnitPriceMinor',label:'客户单价'},{key:'version',label:'版本'},{key:'createdAt',label:'创建时间'}]},
  servicePackages:{sortOptions:[{id:'createdAt',label:'创建时间'},{id:'displayName',label:'套餐名称'},{id:'defaultCustomerPriceMinor',label:'套餐价格'},{id:'version',label:'版本'}],defaultSort,columns:[{key:'displayName',label:'套餐名称'},{key:'status',label:'状态'},{key:'defaultCustomerPriceMinor',label:'套餐价格'},{key:'version',label:'版本'},{key:'createdAt',label:'创建时间'}]},
  giftCatalog:{sortOptions:[{id:'createdAt',label:'创建时间'},{id:'name',label:'礼物名称'},{id:'priceMinor',label:'礼物价格'},{id:'version',label:'版本'}],defaultSort,columns:[{key:'name',label:'礼物名称'},{key:'status',label:'状态'},{key:'priceMinor',label:'礼物价格'},{key:'version',label:'版本'},{key:'createdAt',label:'创建时间'}]},
  giftRequests:{sortOptions:[{id:'createdAt',label:'创建时间'},{id:'updatedAt',label:'更新时间'},{id:'amountMinor',label:'礼物金额'},{id:'expiresAt',label:'过期时间'}],defaultSort,columns:[{key:'publicId',label:'请求编号'},{key:'giftName',label:'礼物名称'},{key:'status',label:'状态'},{key:'senderDisplayName',label:'赠送用户'},{key:'receiverDisplayName',label:'目标陪玩'},{key:'amountMinor',label:'礼物金额'},{key:'expiresAt',label:'过期时间'}]}
};

export function isAdminCollectionPage(page:AdminBusinessPageId):page is AdminCollectionPageId{return Object.hasOwn(adminCollectionConfigs,page);}
export function readAdminCollectionState(page:AdminCollectionPageId,search:string):AdminCollectionState{const config=adminCollectionConfigs[page];const definition=requirePageDefinition(page);const params=new URLSearchParams(search);const view=params.get('view')==='TABLE'?'TABLE':'CARD';const requestedSort=params.get('sortBy');const sortBy=config.sortOptions.some(option=>option.id===requestedSort)?requestedSort!:config.defaultSort.sortBy;const sortDirection=params.get('sortDirection')==='asc'||params.get('sortDirection')==='desc'?params.get('sortDirection') as AdminSortDirection:config.defaultSort.sortDirection;const filters:Record<string,string>={};for(const filter of definition.filters){const value=params.get(filter.id)?.trim();if(value)filters[filter.id]=value;}return{view,sortBy,sortDirection,filters};}
export function buildAdminCollectionUrl(page:AdminCollectionPageId,state:AdminCollectionState):string{const params=new URLSearchParams({view:state.view,sortBy:state.sortBy,sortDirection:state.sortDirection});const allowed=new Set(requirePageDefinition(page).filters.map(filter=>filter.id));for(const[key,value]of Object.entries(state.filters)){if(allowed.has(key)&&value.trim())params.set(key,value.trim());}return`${requirePageDefinition(page).href}?${params.toString()}`;}

export function buildAdminBusinessNavigation(permissions: string[], enabledFeatures?: string[]): AdminBusinessNavigationItem[] {
  const allowed = new Set(permissions);
  return pageDefinitions
    .filter((page) => allowed.has(page.readPermission) && (!enabledFeatures || !page.feature || enabledFeatures.includes(page.feature)))
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
      ? definition.actions.map(({ permission, ...action }) => {
        const enabled = permissions.has(permission);
        return {
          ...action,
          enabled,
          requiredPermission: permission,
          disabledReason: enabled ? undefined : `需要权限 ${permission}；请通过现有客服任务提交主管处理。`
        };
      })
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
  sortBy?: string | null;
  sortDirection?: AdminSortDirection | null;
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
  appendTrimmed(params, 'sortBy', input.sortBy);
  appendTrimmed(params, 'sortDirection', input.sortDirection);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function buildAdminDetailRequest(
  page: AdminBusinessPageId,
  item: Record<string, unknown>
): string {
  if (!['orders', 'users', 'players', 'giftRequests', 'giftCatalog', 'serviceCatalog', 'servicePackages'].includes(page)) {
    throw new TypeError(`${page} does not expose a detail endpoint.`);
  }
  const id = page === 'players' ? requireReadText(item.playerId, 'playerId') : requireReadText(item.id, 'id');
  const resource = page === 'orders' ? 'orders' : page === 'users' ? 'users' : page === 'players' ? 'players' : page === 'giftRequests' ? 'gift-requests' : page === 'giftCatalog' ? 'gift-catalog' : page === 'serviceCatalog' ? 'service-catalog' : 'service-packages';
  return `/api/v1/admin/${resource}/${encodeURIComponent(id)}`;
}

export function buildAdminOrderTimelineRequest(orderId: string, cursor: string): string {
  const params = new URLSearchParams({ timelineCursor: requireReadText(cursor, 'timelineCursor'), timelineLimit: '25' });
  return `/api/v1/admin/orders/${encodeURIComponent(requireReadText(orderId, 'orderId'))}?${params.toString()}`;
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
  return `/api/v1/admin/users/${encodeURIComponent(requireReadText(userId, 'userId'))}/consumptions${buildAdminResourceQuery({ cursor, limit: 25 })}`;
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

function requireReadText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required.`);
  return value.trim();
}
