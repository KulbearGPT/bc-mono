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
}

export interface AdminActionRequest {
  method: 'POST' | 'PUT' | 'PATCH';
  path: string;
  body: Record<string, unknown>;
}

export function buildAddOrderParticipantRequest(orderId:string,fields:{playerId:unknown;serviceCatalogVersionId:unknown;unitCount:unknown;linePriceMinor:unknown;expectedOrderVersion:unknown;reasonCode:unknown}):AdminActionRequest{return{method:'POST',path:`/api/v1/admin/orders/${encodeURIComponent(requireText(orderId,'orderId'))}/participants`,body:{playerId:requireText(fields.playerId,'playerId'),serviceCatalogVersionId:requireText(fields.serviceCatalogVersionId,'serviceCatalogVersionId'),unitCount:requirePositiveInteger(fields.unitCount,'unitCount'),linePriceMinor:requirePositiveInteger(fields.linePriceMinor,'linePriceMinor'),expectedOrderVersion:requirePositiveInteger(fields.expectedOrderVersion,'expectedOrderVersion'),reasonCode:requireReasonCode(fields.reasonCode)}};}

export function buildUpdateOrderParticipantRequest(orderId:string,participantId:string,fields:{action:unknown;serviceCatalogVersionId?:unknown;unitCount?:unknown;linePriceMinor?:unknown;expectedOrderVersion:unknown;expectedParticipantVersion:unknown;reasonCode:unknown}):AdminActionRequest{const action=requireEnum(fields.action,['CHANGE_PROJECT','CHANGE_PRICE','REMOVE'],'action');return{method:'PATCH',path:`/api/v1/admin/orders/${encodeURIComponent(requireText(orderId,'orderId'))}/participants/${encodeURIComponent(requireText(participantId,'participantId'))}`,body:{expectedOrderVersion:requirePositiveInteger(fields.expectedOrderVersion,'expectedOrderVersion'),expectedParticipantVersion:requirePositiveInteger(fields.expectedParticipantVersion,'expectedParticipantVersion'),action,serviceCatalogVersionId:action==='CHANGE_PROJECT'?requireText(fields.serviceCatalogVersionId,'serviceCatalogVersionId'):null,unitCount:action==='CHANGE_PROJECT'?requirePositiveInteger(fields.unitCount,'unitCount'):null,linePriceMinor:action==='REMOVE'?null:requirePositiveInteger(fields.linePriceMinor,'linePriceMinor'),reasonCode:requireReasonCode(fields.reasonCode)}};}

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
      { id: 'ARCHIVE_SERVICE', label: '删除', permission: 'catalog.manage', requiresReason: true, scope: 'ITEM' }
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
      { id: 'ARCHIVE_GIFT', label: '删除', permission: 'gift_catalog.manage', requiresReason: true, scope: 'ITEM' }
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
  players:{sortOptions:[{id:'createdAt',label:'创建时间'},{id:'updatedAt',label:'更新时间'},{id:'displayName',label:'展示名称'}],defaultSort,columns:[{key:'displayName',label:'展示名称'},{key:'reviewStatus',label:'准入状态'},{key:'availability',label:'接单状态'},{key:'discordPresence',label:'Discord 在线状态'},{key:'createdAt',label:'创建时间'}]},
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

export function formatMinorCurrency(amountMinor: number, currency: string, locale = 'zh-CN'): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new TypeError('Amounts must use safe integer minor units.');
  }
  if(currency==='CAT')return `${(amountMinor/10).toLocaleString(locale,{minimumFractionDigits:1,maximumFractionDigits:1})} 猫条`;
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'code' });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountMinor / (10 ** fractionDigits));
}

export function buildAdminDetailRequest(
  page: AdminBusinessPageId,
  item: Record<string, unknown>
): string {
  if (!['orders', 'users', 'players', 'giftRequests', 'giftCatalog', 'serviceCatalog', 'servicePackages'].includes(page)) {
    throw new TypeError(`${page} does not expose a detail endpoint.`);
  }
  const id = page === 'players' ? requireText(item.playerId, 'playerId') : requireText(item.id, 'id');
  const resource = page === 'orders' ? 'orders' : page === 'users' ? 'users' : page === 'players' ? 'players' : page === 'giftRequests' ? 'gift-requests' : page === 'giftCatalog' ? 'gift-catalog' : page === 'serviceCatalog' ? 'service-catalog' : 'service-packages';
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
  if (input.actionId === 'CANCEL_ORDER_RESOLUTION') {
    const item = requireItem(input.item);
    requireEnum(input.item?.status, ['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION', 'EXCEPTION'], 'status');
    const currency = requireCurrency(input.fields.currency);
    return {
      method: 'POST', path: `/api/v1/admin/orders/${encodeURIComponent(item.id)}/resolve`,
      body: {
        expectedVersion: item.version,
        targetStatus: 'CANCELLED',
        reasonCode: requireReasonCode(input.fields.reasonCode),
        refund: { amountMinor: requireNonNegativeInteger(input.fields.refundAmountMinor, 'refundAmountMinor'), currency },
        playerEarning: { amountMinor: requireNonNegativeInteger(input.fields.playerEarningMinor, 'playerEarningMinor'), currency },
        evidenceNote: requireText(input.fields.evidenceNote, 'evidenceNote', 2_000),
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    };
  }
  if(input.actionId==='APPROVE_COMPANION'){const item=requirePlayerItem(input.item);return{method:'POST',path:`/api/v1/admin/players/${encodeURIComponent(item.id)}/approve`,body:{expectedVersion:item.version,
    gameTagIds:splitTags(input.fields.gameTagIds),serviceTagIds:splitTags(input.fields.serviceTagIds),languageTagIds:splitOptionalTags(input.fields.languageTagIds),reasonCode:requireReasonCode(input.fields.reasonCode)}};}
  if(input.actionId==='EDIT_COMPANION_TAGS'){const item=requirePlayerItem(input.item);return{method:'PUT',path:`/api/v1/admin/players/${encodeURIComponent(item.id)}/tags`,body:{expectedVersion:item.version,
    gameTagIds:splitTags(input.fields.gameTagIds),serviceTagIds:splitTags(input.fields.serviceTagIds),languageTagIds:splitOptionalTags(input.fields.languageTagIds),reasonCode:requireReasonCode(input.fields.reasonCode)}};}
  if(input.actionId==='EDIT_PLAYER_COMPENSATION'){const item=requirePlayerItem(input.item);if(typeof input.fields.compensationChangesJson==='string'){const changes=parseCompensationChanges(input.fields.compensationChangesJson);return{method:'PUT',path:`/api/v1/admin/players/${encodeURIComponent(item.id)}/compensation`,body:{rules:changes,reasonCode:requireReasonCode(input.fields.reasonCode)}};}const serviceOfferingId=requireText(input.fields.serviceOfferingId,'serviceOfferingId');const type=requireEnum(input.fields.compensationType,['PERCENT_BPS','FIXED_MINOR'],'compensationType');
    const value=type==='PERCENT_BPS'?requirePercentageBps(input.fields.percentage):requirePositiveInteger(input.fields.fixedAmountMinor,'fixedAmountMinor');
    return{method:'PUT',path:`/api/v1/admin/players/${encodeURIComponent(item.id)}/compensation/${encodeURIComponent(serviceOfferingId)}`,body:{expectedVersion:optionalPositiveInteger(input.fields.compensationVersion),type,value,currency:type==='FIXED_MINOR'?'CAT':null,reasonCode:requireReasonCode(input.fields.reasonCode)}};}
  if(input.actionId==='REJECT_COMPANION'){const item=requirePlayerItem(input.item);return{method:'POST',path:`/api/v1/admin/players/${encodeURIComponent(item.id)}/reject`,body:{expectedVersion:item.version,
    reasonCode:requireReasonCode(input.fields.reasonCode),note:requireText(input.fields.note,'note',1000)}};}
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
  if(input.actionId==='CREATE_PACKAGE_VERSION'||input.actionId==='COPY_PACKAGE_VERSION')return{method:'POST',path:'/api/v1/admin/service-packages',body:buildServicePackageCreateBody(input.fields,requireReasonCode(input.fields.reasonCode))};
  if(input.actionId==='UPDATE_PACKAGE_STATUS'){const expectedStatus=requireEnum(input.item?.status as string,['DRAFT','ACTIVE','RETIRED'],'status');const item=requireItem(input.item);const action=requireEnum(input.fields.action,['ACTIVATE','RETIRE'],'action');return{method:'PATCH',path:`/api/v1/admin/service-packages/${encodeURIComponent(item.id)}`,body:{expectedStatus,action,reasonCode:requireReasonCode(input.fields.reasonCode)}};}
  if (input.actionId === 'UPDATE_GIFT_VERSION') {
    const item = requireItem(input.item);
    const action = requireEnum(input.fields.action, ['ENABLE', 'DISABLE', 'CREATE_REPLACEMENT_VERSION'], 'action');
    const reasonCode = requireReasonCode(input.fields.reasonCode);
    return {
      method: 'PATCH', path: `/api/v1/admin/gift-catalog/${encodeURIComponent(item.id)}`,
      body: { expectedVersion: item.version, action, reasonCode, replacement: action === 'CREATE_REPLACEMENT_VERSION' ? buildGiftCatalogCreateBody(input.fields, reasonCode) : null }
    };
  }
  if(input.actionId==='ARCHIVE_GIFT'){const item=requireItem(input.item);return{method:'PATCH',path:`/api/v1/admin/gift-catalog/${encodeURIComponent(item.id)}`,body:{expectedVersion:item.version,action:'ARCHIVE',reasonCode:requireReasonCode(input.fields.reasonCode),replacement:null}};}
  if (input.actionId === 'UPDATE_VERSION') {
    const item = requireItem(input.item);
    const action = requireEnum(input.fields.action, ['ENABLE', 'DISABLE', 'SUPERSEDE'], 'action');
    const reasonCode = requireReasonCode(input.fields.reasonCode);
    return {
      method: 'PATCH', path: `/api/v1/admin/service-catalog/${encodeURIComponent(item.id)}`,
      body: { expectedVersion: item.version, action, reasonCode, replacement: action === 'SUPERSEDE' ? buildServiceCatalogCreateBody(input.fields, reasonCode) : null }
    };
  }
  if(input.actionId==='ARCHIVE_SERVICE'){const item=requireItem(input.item);return{method:'PATCH',path:`/api/v1/admin/service-catalog/${encodeURIComponent(item.id)}`,body:{expectedVersion:item.version,action:'ARCHIVE',reasonCode:requireReasonCode(input.fields.reasonCode),replacement:null}};}
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

function parseCompensationChanges(value:string){let entries:unknown;try{entries=JSON.parse(value);}catch{throw new Error('compensationChangesJson is invalid.');}if(!Array.isArray(entries)||!entries.length)throw new Error('至少需要一条分成改动。');return entries.map((entry)=>{if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new Error('compensation change is invalid.');const item=entry as Record<string,unknown>;const type=requireEnum(item.type as string,['PERCENT_BPS','FIXED_MINOR'],'compensationType');return{serviceOfferingId:requireText(item.serviceOfferingId as string,'serviceOfferingId'),expectedVersion:optionalPositiveInteger(item.expectedVersion as string),type,value:type==='PERCENT_BPS'?requirePercentageBps(item.percentage as string):requirePositiveInteger(item.fixedAmountMinor as string,'fixedAmountMinor'),currency:type==='FIXED_MINOR'?'CAT':null};});}

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
function requirePlayerItem(item:Record<string,unknown>|undefined):{id:string;version:number}{if(!item)throw new TypeError('A player item is required.');const id=requireText(item.playerId??item.id,'playerId');
  if(!Number.isSafeInteger(item.version)||Number(item.version)<1)throw new TypeError('A valid player version is required.');return{id,version:Number(item.version)};}
function splitTags(value:string|boolean|undefined):string[]{if(typeof value!=='string')throw new TypeError('Tags are required.');const tags=Array.from(new Set(value.split(',').map(item=>item.trim()).filter(Boolean)));
  if(!tags.length)throw new TypeError('At least one tag is required.');return tags;}
function splitOptionalDiscordIds(value:string|boolean|undefined):string[]{if(value===undefined||value==='')return[];if(typeof value!=='string')throw new TypeError('Player selection is invalid.');const ids=value.split(',').map(item=>item.trim()).filter(Boolean);
  if(ids.length>3)throw new TypeError('Manual dispatch supports at most three players.');if(new Set(ids).size!==ids.length)throw new TypeError('Player selection contains duplicates.');return ids;}

function requireReasonCode(value: unknown): string {
  const reasonCode = requireText(value, 'reasonCode');
  if (!/^[A-Z0-9_]{3,100}$/.test(reasonCode)) throw new TypeError('reasonCode must contain 3-100 uppercase letters, numbers, or underscores.');
  return reasonCode;
}
function splitOptionalTags(value:string|boolean|undefined):string[]{return value===undefined?[]:splitTags(value);}

function requireText(value: unknown, field: string, maxLength = Number.POSITIVE_INFINITY): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) throw new TypeError(`${field} is required.`);
  return value.trim();
}

function optionalText(value: string | boolean | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new TypeError(`${field} is invalid.`);
  return value as T;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${field} must be a positive integer.`);
  return parsed;
}
function requireNonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${field} must be a non-negative integer.`);
  return parsed;
}
function optionalPositiveInteger(value:string|boolean|undefined):number|null{if(value===undefined||value==='')return null;return requirePositiveInteger(value,'compensationVersion');}
function requirePercentageBps(value:string|boolean|undefined):number{const parsed=typeof value==='string'?Number(value):Number.NaN;if(!Number.isFinite(parsed)||parsed<=0||parsed>100)throw new TypeError('percentage must be between 0 and 100.');const bps=Math.round(parsed*100);if(!Number.isSafeInteger(bps)||bps<1||bps>10000)throw new TypeError('percentage must be between 0 and 100.');return bps;}

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
  const customerAmountMinor = requirePositiveInteger(fields.customerAmountMinor, 'customerAmountMinor');
  const defaultPlayerPayoutBps = requirePercentageBps(fields.defaultPlayerPayoutPercent);
  return {
    gameTagId: requireText(fields.gameTagId, 'gameTagId', 100),
    serviceTagId: requireText(fields.serviceTagId, 'serviceTagId', 100),
    regionTagId: optionalText(fields.regionTagId),
    billingUnitMinutes: requireIntegerInRange(fields.billingUnitMinutes, 'billingUnitMinutes', 1, 1_440),
    minimumUnits: requireIntegerInRange(fields.minimumUnits, 'minimumUnits', 1, 1_440),
    customerUnitPrice: { amountMinor: customerAmountMinor, currency },
    playerUnitPayout: { amountMinor: Math.floor(customerAmountMinor * defaultPlayerPayoutBps / 10000), currency },
    defaultPlayerPayoutBps,
    enabled: fields.enabled === true,
    reasonCode
  };
}

function buildGiftCatalogCreateBody(fields: Record<string, string | boolean>, reasonCode: string) {
  return {
    name: requireText(fields.name, 'name', 100), giftCategoryTagId: requireText(fields.giftCategoryTagId,'giftCategoryTagId',100),
    price: { amountMinor: requirePositiveInteger(fields.amountMinor, 'amountMinor'), currency: requireCurrency(fields.currency) },
    enabled: fields.enabled === true,
    broadcastTemplate: requireText(fields.broadcastTemplate, 'broadcastTemplate', 500),
    reasonCode
  };
}

function buildServicePackageCreateBody(fields:Record<string,string|boolean>,reasonCode:string){let slots:unknown;try{slots=JSON.parse(requireText(fields.slotsJson,'slotsJson',20_000));}catch{throw new TypeError('请至少配置一个有效套餐席位。');}if(!Array.isArray(slots)||slots.length<1||slots.length>25)throw new TypeError('套餐席位数量必须在 1 到 25 之间。');return{code:requireText(fields.code,'code',100).toUpperCase(),displayName:requireText(fields.displayName,'displayName',100),description:requireText(fields.description,'description',1000),currency:'CAT',activate:fields.activate===true,slots:slots.map((slot,index)=>{if(!slot||typeof slot!=='object'||Array.isArray(slot))throw new TypeError(`第 ${index+1} 个席位无效。`);const value=slot as Record<string,unknown>;return{serviceCatalogVersionId:requireText(value.serviceCatalogVersionId as string,'serviceCatalogVersionId'),unitCount:requirePositiveInteger(String(value.unitCount),'unitCount'),customerNoteTemplate:optionalText(typeof value.customerNoteTemplate==='string'?value.customerNoteTemplate:undefined)};}),reasonCode};}
