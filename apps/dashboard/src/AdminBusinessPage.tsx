import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  adminCollectionConfigs,
  formatMinorCurrency,
  isAdminCollectionPage,
  readAdminOrderTimeline,
  type AdminBusinessAction,
  type AdminBusinessDetailState,
  type AdminBusinessPageModel,
  type AdminCollectionView,
  type AdminSortDirection
} from './admin-business.js';
import type { BusinessTagGroups, BusinessTagRecord } from './business-tags.js';
import { dashboardFieldLabel } from './table-labels.js';

export function AdminBusinessPage(props: {
  model: AdminBusinessPageModel;
  onRetry?: () => void;
  onClearFilters?: () => void;
  onNextPage?: (cursor: string) => void;
  onFilter?: (filters: Record<string, string>) => void;
  view?: AdminCollectionView;
  sortBy?: string;
  sortDirection?: AdminSortDirection;
  activeFilters?: Record<string,string>;
  onViewChange?: (view:AdminCollectionView)=>void;
  onSortChange?: (sortBy:string,sortDirection:AdminSortDirection)=>void;
  onAction?: (action: AdminBusinessAction, item?: Record<string, unknown>) => void;
  activeAction?: { action: AdminBusinessAction; item?: Record<string, unknown> } | null;
  actionStatus?: 'IDLE' | 'SUBMITTING' | 'ERROR';
  actionError?: string | null;
  onCancelAction?: () => void;
  onSubmitAction?: (action: AdminBusinessAction, item: Record<string, unknown> | undefined, fields: Record<string, string | boolean>) => void;
  detail?: AdminBusinessDetailState | null;
  onOpenDetail?: (item: Record<string, unknown>) => void;
  onCloseDetail?: () => void;
  onNextConsumptions?: (cursor: string) => void;
  onNextTimeline?: (cursor: string) => void;
  onNextTranscript?: (cursor:string)=>void;
  businessTagOptions?: BusinessTagGroups;
  serviceCatalogOptions?: Array<Record<string, unknown>>;
  referenceDataError?: string | null;
  participantPlayerOptions?: Array<Record<string,unknown>>;
  participantMutationError?: string|null;
  onAddOrderParticipant?: (fields:Record<string,unknown>)=>void;
  onUpdateOrderParticipant?: (fields:Record<string,unknown>)=>void;
  onUpdateOrderNote?: (fields:Record<string,unknown>)=>void;
  onUpdateOrderRequirement?: (fields:Record<string,unknown>)=>void;
}) {
  const { model } = props;
  const collectionConfig=isAdminCollectionPage(model.page)?adminCollectionConfigs[model.page]:null;
  const view=props.view??'CARD';
  if (model.kind === 'FORBIDDEN') {
    return <section className="dashboard-page" aria-labelledby="admin-page-title"><header className="page-heading"><div><span className="page-eyebrow">BUSINESS OPS</span><h1 id="admin-page-title">无权访问</h1><p>当前账号缺少此工作区所需权限：{model.requiredPermission}</p></div></header></section>;
  }

  return (
    <section className="dashboard-page" aria-labelledby="admin-page-title">
      <header className="page-heading">
        <div><span className="page-eyebrow">BUSINESS OPS</span><h1 id="admin-page-title">{model.title}</h1><p>查看业务事实并执行当前权限范围内的操作。</p></div>
        <div className="page-actions">
          {props.onAction && model.actions.filter((action) => action.scope === 'COLLECTION').map((action) => (
            <button className="button-primary" key={action.id} type="button" disabled={action.enabled === false} title={action.disabledReason} onClick={() => props.onAction?.(action)}>{action.label}</button>
          ))}
        </div>
      </header>

      {collectionConfig?<AdminCollectionToolbar model={model} config={collectionConfig} view={view} sortBy={props.sortBy??collectionConfig.defaultSort.sortBy} sortDirection={props.sortDirection??collectionConfig.defaultSort.sortDirection} activeFilters={props.activeFilters??{}} onFilter={props.onFilter} onClearFilters={props.onClearFilters} onViewChange={props.onViewChange} onSortChange={props.onSortChange}/>:model.filters.length>0&&<form className="content-panel filter-bar" aria-label="列表筛选" onSubmit={(event)=>submitFilters(event,props.onFilter)}>{model.filters.map((filter)=><input key={filter.id} name={filter.id} aria-label={filter.label} placeholder={filter.label}/>) }<button className="button-primary" type="submit">筛选</button><button type="button" onClick={props.onClearFilters}>清除</button></form>}

      {model.page === 'playerEarnings' && ['READY', 'EMPTY'].includes(model.kind) && <EarningOperationNotice model={model} />}
      {props.referenceDataError && <div className="status-notice state-card--error" role="alert">{props.referenceDataError}</div>}

      {model.kind === 'LOADING' && <div className="state-card" aria-busy="true">正在载入...</div>}
      {model.kind === 'ERROR' && (
        <div className="state-card state-card--error" role="alert"><p>数据暂时无法载入。{model.requestId ? ` request_id: ${model.requestId}` : ''}</p><button type="button" onClick={props.onRetry}>重试</button></div>
      )}
      {model.kind === 'EMPTY' && <div className="state-card"><p>当前筛选下没有记录。</p><button type="button" onClick={props.onClearFilters}>清除筛选</button></div>}
      {model.kind === 'READY' && (collectionConfig?(view==='TABLE'?<AdminBusinessTable model={model} columns={collectionConfig.columns} onAction={props.onAction} onOpenDetail={props.onOpenDetail} businessTagOptions={props.businessTagOptions}/>:model.page==='orders'?<OrderDiscussionGrid model={model} onAction={props.onAction} onOpenDetail={props.onOpenDetail}/>:<BusinessDiscussionGrid model={model} onAction={props.onAction} onOpenDetail={props.onOpenDetail}/>):<AdminBusinessTable model={model} columns={[]} onAction={props.onAction} onOpenDetail={props.onOpenDetail} businessTagOptions={props.businessTagOptions}/>)}

      {props.detail && <DashboardOverlay label="业务对象详情" onClose={props.onCloseDetail}><AdminDetailRegion detail={props.detail} onClose={props.onCloseDetail} onNextConsumptions={props.onNextConsumptions} onNextTimeline={props.onNextTimeline} onNextTranscript={props.onNextTranscript} serviceCatalogOptions={props.serviceCatalogOptions} participantPlayerOptions={props.participantPlayerOptions} participantMutationError={props.participantMutationError} onAddOrderParticipant={props.onAddOrderParticipant} onUpdateOrderParticipant={props.onUpdateOrderParticipant} onUpdateOrderNote={props.onUpdateOrderNote} onUpdateOrderRequirement={props.onUpdateOrderRequirement} /></DashboardOverlay>}
      {props.activeAction && <DashboardOverlay label={`${props.activeAction.action.label}操作`} onClose={props.onCancelAction}><AdminActionPanel active={props.activeAction} status={props.actionStatus ?? 'IDLE'} error={props.actionError} businessTagOptions={props.businessTagOptions} serviceCatalogOptions={props.serviceCatalogOptions}
        onCancel={props.onCancelAction} onSubmit={props.onSubmitAction} /></DashboardOverlay>}

      {model.pagination.hasNext && model.pagination.nextCursor && (
        <div className="pagination-bar"><button type="button" onClick={() => props.onNextPage?.(model.pagination.nextCursor!)}>下一页</button></div>
      )}
    </section>
  );
}

function AdminCollectionToolbar(props:{model:AdminBusinessPageModel;config:(typeof adminCollectionConfigs)[keyof typeof adminCollectionConfigs];view:AdminCollectionView;sortBy:string;sortDirection:AdminSortDirection;activeFilters:Record<string,string>;onFilter?:(filters:Record<string,string>)=>void;onClearFilters?:()=>void;onViewChange?:(view:AdminCollectionView)=>void;onSortChange?:(sortBy:string,direction:AdminSortDirection)=>void}){
  return <section className="content-panel collection-toolbar" aria-label="集合浏览工具栏">
    <form className="collection-toolbar__filters" aria-label="列表筛选" key={JSON.stringify(props.activeFilters)} onSubmit={(event)=>submitFilters(event,props.onFilter)}>
      {props.model.filters.map((filter)=><input key={filter.id} name={filter.id} aria-label={filter.label} placeholder={filter.label} defaultValue={props.activeFilters[filter.id]??''}/>)}
      {props.model.filters.length>0&&<><button className="button-primary" type="submit">筛选</button><button type="button" onClick={props.onClearFilters}>清除</button></>}
    </form>
    <div className="collection-toolbar__controls">
      <label><span>排序字段</span><select aria-label="排序字段" value={props.sortBy} onChange={(event)=>props.onSortChange?.(event.currentTarget.value,props.sortDirection)}>{props.config.sortOptions.map((option)=><option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      <label><span>排序方向</span><select aria-label="排序方向" value={props.sortDirection} onChange={(event)=>props.onSortChange?.(props.sortBy,event.currentTarget.value as AdminSortDirection)}><option value="desc">降序</option><option value="asc">升序</option></select></label>
      <div className="collection-view-switch" role="group" aria-label="视图模式"><button type="button" aria-pressed={props.view==='CARD'} onClick={()=>props.onViewChange?.('CARD')}>卡片</button><button type="button" aria-pressed={props.view==='TABLE'} onClick={()=>props.onViewChange?.('TABLE')}>表格</button></div>
    </div>
  </section>;
}

function DashboardOverlay(props: { label: string; onClose?: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose?.();
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', closeOnEscape);
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [props.onClose]);

  const overlay = <div className="dashboard-overlay" onMouseDown={(event) => {
    if (event.target === event.currentTarget) props.onClose?.();
  }}>
    <div ref={dialogRef} className="dashboard-overlay__dialog" role="dialog" aria-modal="true" aria-label={props.label} tabIndex={-1}>
      {props.children}
    </div>
  </div>;
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body);
}

function EarningOperationNotice({ model }: { model: AdminBusinessPageModel }) {
  const canManage = model.actions.some((action) => action.enabled !== false && (action.id === 'CONFIRM' || action.id === 'MARK_PAID'));
  return <div className={`status-notice earning-operation-notice${canManage ? '' : ' earning-operation-notice--readonly'}`} role="status">
    {canManage
      ? <>操作规则：待确认收益可“确认收益”，已确认收益可“标记已支付”；已支付或已冲正记录只读。</>
      : <>当前为只读视图：确认收益和标记已支付需要 L3+ 的收益管理权限；Discord Role 不会替代内部有效授权。</>}
  </div>;
}

const adminDetailPages: ReadonlyArray<AdminBusinessPageModel['page']> = ['orders', 'users', 'players', 'serviceCatalog', 'servicePackages', 'giftCatalog', 'giftRequests'];

function CollectionItemActions(props: {
  page: AdminBusinessPageModel['page'];
  item: Record<string, unknown>;
  actions: AdminBusinessAction[];
  variant: 'CARD' | 'TABLE';
  className: string;
  onAction?: (action: AdminBusinessAction, item?: Record<string, unknown>) => void;
  onOpenDetail?: (item: Record<string, unknown>) => void;
}) {
  const hasDetail = Boolean(props.onOpenDetail) && adminDetailPages.includes(props.page);
  const actions = props.actions.filter((action) => playerActionApplies(action, props.item));
  if (!hasDetail && actions.length === 0) return null;
  return <div className={`${props.className} collection-item-actions collection-item-actions--${props.variant.toLowerCase()}`} role="group" aria-label="可用操作">
    {hasDetail && <button type="button" onClick={() => props.onOpenDetail?.(props.item)}>查看详情</button>}
    {actions.map((action) => <button className={isDangerousAdminAction(action) ? 'table-action--danger' : undefined} key={action.id} type="button" disabled={action.enabled === false} title={action.disabledReason} onClick={() => props.onAction?.(action, props.item)}>{action.label}</button>)}
  </div>;
}

function isDangerousAdminAction(action: AdminBusinessAction): boolean {
  return action.id === 'CANCEL_ORDER_RESOLUTION' || action.id.startsWith('ARCHIVE_');
}

function OrderDiscussionGrid(props: {
  model: AdminBusinessPageModel;
  onAction?: (action: AdminBusinessAction, item?: Record<string, unknown>) => void;
  onOpenDetail?: (item: Record<string, unknown>) => void;
}) {
  const itemActions = props.onAction ? props.model.actions.filter((action) => action.scope === 'ITEM') : [];
  return <div className="order-discussion-grid">{props.model.items.map((item, index) => {
    const publicId = textValue(item.publicId) || `#${index + 1}`;
    const participants=Array.isArray(item.participants)?item.participants.filter((value):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value))&&value.status!=='REMOVED'):[];
    const firstParticipant=participants[0];
    const game = textValue(firstParticipant?.gameDisplayName) || textValue(firstParticipant?.game) || textValue(item.gameDisplayName) || textValue(item.game) || '未指定游戏';
    const service = textValue(firstParticipant?.serviceDisplayName) || textValue(firstParticipant?.service) || textValue(item.serviceDisplayName) || textValue(item.service) || '未指定服务';
    const region = participants.length?Array.from(new Set(participants.map((participant)=>textValue(participant.regionDisplayName)||textValue(participant.region)||'不限区服'))).join('、'):textValue(item.regionDisplayName) || textValue(item.region);
    const billing = participants.length?participants.map((participant)=>`${textValue(participant.displayName)||'陪玩'} ${textValue(participant.unitCount)||'—'} 单位`).join(' · '):orderBillingSummary(item);
    const status = textValue(item.status);
    const customerName=textValue(item.customerDisplayName)||textValue(item.customerDiscordTag)||'客户资料待补充';
    const playerNames=participants.map((participant)=>textValue(participant.displayName)||textValue(participant.discordTag)).filter(Boolean).join('、')||textValue(item.playerDisplayNames)||'待接单';
    const operational=orderOperationalState(status);
    return <article className="order-discussion-card" key={textValue(item.id) || publicId}>
      <header className="order-discussion-card__header">
        <div><span className="order-discussion-card__label">订单 {publicId}</span><h2>{game} · {service}{participants.length>1?` +${participants.length-1} 个项目`:''}</h2></div>
        <span className={`order-status order-status--${status.toLowerCase()}`}>{orderStatusLabel(status)}</span>
      </header>
      <CollectionItemActions page={props.model.page} item={item} actions={itemActions} variant="CARD" className="order-discussion-card__actions" onAction={props.onAction} onOpenDetail={props.onOpenDetail} />
      <div className="order-discussion-card__summary">
        <p>{[region, billing].filter(Boolean).join(' · ') || '项目资料待补充'}</p>
        <div className="order-discussion-card__next"><span>下一步</span><strong>{operational.nextAction}</strong></div>
      </div>
      <dl className="order-discussion-card__facts">
        <OrderFact label="客户" value={customerName} />
        <OrderFact label="陪玩" value={playerNames} muted={playerNames==='待接单'} />
        <OrderFact label="订单价格" value={orderPrice(item)} strong />
        <OrderFact label="当前阻塞" value={operational.blocker} muted={operational.blocker==='无'} />
      </dl>
      <footer className="order-discussion-card__footer">
        <span title={formatOrderDate(item.updatedAt)}>更新于 {formatRelativeDate(item.updatedAt)} · {formatOrderDate(item.updatedAt)}</span>
      </footer>
    </article>;
  })}</div>;
}

function OrderFact({ label, value, muted = false, strong = false }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return <div><dt>{label}</dt><dd className={`${muted ? 'is-muted' : ''}${strong ? ' is-strong' : ''}`.trim()} title={value}>{value}</dd></div>;
}

function BusinessDiscussionGrid(props: {
  model: AdminBusinessPageModel;
  onAction?: (action: AdminBusinessAction, item?: Record<string, unknown>) => void;
  onOpenDetail?: (item: Record<string, unknown>) => void;
}) {
  const itemActions = props.onAction ? props.model.actions.filter((action) => action.scope === 'ITEM') : [];
  return <div className="business-discussion-grid">{props.model.items.map((item, index) => {
    const card = businessCardContent(props.model.page, item, index);
    return <article className="business-discussion-card" key={textValue(item.id) || `${props.model.page}-${index}`}>
      <header className="business-discussion-card__header"><div><span className="business-discussion-card__label">{card.eyebrow}</span><h2>{card.title}</h2></div><span className={`business-discussion-card__status business-discussion-card__status--${card.status.toLowerCase()}`}>{card.statusLabel}</span></header>
      <CollectionItemActions page={props.model.page} item={item} actions={itemActions} variant="CARD" className="business-discussion-card__actions" onAction={props.onAction} onOpenDetail={props.onOpenDetail} />
      <div className="business-discussion-card__summary"><p>{card.summary}</p></div>
      <dl className="business-discussion-card__facts">{card.facts.map((fact) => <OrderFact key={fact.label} {...fact} />)}</dl>
      <footer className="business-discussion-card__footer"><span title={textValue(item.id)}>内部编号 · {compactIdentifier(item.id)}</span></footer>
    </article>;
  })}</div>;
}

function businessCardContent(page: AdminBusinessPageModel['page'], item: Record<string, unknown>, index: number): { eyebrow: string; title: string; summary: string; status: string; statusLabel: string; facts: Array<{ label: string; value: string; muted?: boolean; strong?: boolean }> } {
  if(page==='users'){const status=textValue(item.status)||'ACTIVE';return{eyebrow:`用户档案 · ${compactIdentifier(item.id)}`,title:textValue(item.displayName)||textValue(item.discordUsername)||`用户 ${index+1}`,summary:textValue(item.discordUsername)?`Discord · ${textValue(item.discordUsername)}`:'Discord 资料待补充',status,statusLabel:catalogStatusLabel(status),facts:[{label:'Discord 用户 ID',value:textValue(item.discordUserId)||'—'},{label:'当前订单',value:compactIdentifier(item.activeOrderId),muted:!item.activeOrderId},{label:'风险标记',value:Array.isArray(item.riskFlags)&&item.riskFlags.length?`${item.riskFlags.length} 项`:'无'},{label:'创建时间',value:formatOrderDate(item.createdAt)}]};}
  if (page === 'players') {
    const status = textValue(item.reviewStatus) || (item.active === false ? 'INACTIVE' : 'ACTIVE');
    return { eyebrow: `陪玩档案 · ${compactIdentifier(item.playerId || item.id)}`, title: textValue(item.displayName) || textValue(item.discordTag) || `陪玩 ${index + 1}`, summary: [textValue(item.discordTag), textValue(item.gameTags), textValue(item.serviceTags)].filter(Boolean).join(' · ') || '支持范围待配置', status, statusLabel: playerStatusLabel(status), facts: [{ label: 'Discord Tag', value: textValue(item.discordTag) || '—' }, { label: '陪玩编号', value: compactIdentifier(item.playerId || item.id) }, { label: '新接单资格', value: ['ACTIVE','APPROVED'].includes(status) ? '可进入候选池' : status==='PAUSED'?'已暂停':status==='SUSPENDED'?'已停用':'尚未准入' }, { label: '版本', value: scalarValue(item.version) }] };
  }
  if (page === 'serviceCatalog') {
    const game = textValue(item.gameDisplayName) || textValue(item.game) || '未指定游戏';
    const service = textValue(item.serviceDisplayName) || textValue(item.service) || '未指定服务';
    const status = textValue(item.status) || (item.enabled === false ? 'INACTIVE' : 'ACTIVE');
    const minutes = numberValue(item.billingUnitMinutes);
    return { eyebrow: `服务版本 · ${textValue(item.code) || compactIdentifier(item.id)}`, title: `${game} · ${service}`, summary: [textValue(item.regionDisplayName) || textValue(item.region) || '不限区服', minutes ? `每单位 ${minutes} 分钟` : '计费单位待配置'].join(' · '), status, statusLabel: catalogStatusLabel(status), facts: [{ label: '客户单价', value: priceValue(item.customerUnitPriceMinor, item.currency), strong: typeof item.customerUnitPriceMinor === 'number' }, { label: '服务代码', value: textValue(item.service) || textValue(item.code) || '—' }, { label: '计费单位', value: minutes ? `${minutes} 分钟` : '—' }, { label: '版本', value: scalarValue(item.version) }] };
  }
  if(page==='giftCatalog'){const status=textValue(item.status)||(item.enabled===false?'INACTIVE':'ACTIVE');return{eyebrow:`礼物版本 · ${textValue(item.code)||compactIdentifier(item.id)}`,title:textValue(item.name)||`礼物 ${index+1}`,summary:textValue(item.giftCategoryTagDetails)||'礼物目录',status,statusLabel:catalogStatusLabel(status),facts:[{label:'礼物价格',value:priceValue(item.priceMinor,item.currency),strong:typeof item.priceMinor==='number'},{label:'稳定代码',value:textValue(item.code)||'—'},{label:'版本',value:scalarValue(item.version)},{label:'创建时间',value:formatOrderDate(item.createdAt)}]};}
  if(page==='giftRequests'){const status=textValue(item.status)||'PENDING_REVIEW';return{eyebrow:`礼物请求 · ${textValue(item.publicId)||compactIdentifier(item.id)}`,title:textValue(item.giftName)||`礼物请求 ${index+1}`,summary:[textValue(item.senderDisplayName)||'未知用户',textValue(item.receiverDisplayName)||'未知陪玩'].join(' → '),status,statusLabel:catalogStatusLabel(status),facts:[{label:'礼物金额',value:priceValue(item.amountMinor,item.currency),strong:typeof item.amountMinor==='number'},{label:'订单号',value:textValue(item.orderPublicId)||compactIdentifier(item.orderId)},{label:'过期时间',value:formatOrderDate(item.expiresAt)},{label:'创建时间',value:formatOrderDate(item.createdAt)}]};}
  const status = textValue(item.status) || 'DRAFT';
  const slots = Array.isArray(item.slots) ? item.slots : [];
  return { eyebrow: `服务套餐 · ${textValue(item.code) || compactIdentifier(item.id)}`, title: textValue(item.displayName) || textValue(item.code) || `套餐 ${index + 1}`, summary: textValue(item.description) || '套餐说明待补充', status, statusLabel: catalogStatusLabel(status), facts: [{ label: '默认陪玩席位', value: slots.length ? `${slots.length} 个独立席位` : '席位待配置' }, { label: '套餐价格', value: priceValue(item.defaultCustomerPriceMinor, item.currency), strong: typeof item.defaultCustomerPriceMinor === 'number' }, { label: '稳定代码', value: textValue(item.code) || '—' }, { label: '版本', value: scalarValue(item.version) }] };
}

function priceValue(amount: unknown, currency: unknown): string { return typeof amount === 'number' && typeof currency === 'string' ? formatMinorCurrency(amount, currency) : '由目录汇总'; }
function playerStatusLabel(status: string): string { return ({ PENDING_REVIEW: '待审核', APPROVED: '已批准', REJECTED: '已拒绝', ACTIVE: '可接新单', PAUSED: '已暂停', SUSPENDED: '已停用', INACTIVE: '已停用' } as Record<string, string>)[status] ?? status; }
function catalogStatusLabel(status: string): string { return ({ DRAFT: '草稿', ACTIVE: '已启用', RETIRED: '已退役', INACTIVE: '已停用' } as Record<string, string>)[status] ?? status; }

function orderBillingSummary(item: Record<string, unknown>): string {
  const minutes = numberValue(item.billingUnitMinutes);
  const units = numberValue(item.unitCount);
  if (minutes && units) return `${units} 个计费单位 · 共 ${minutes * units} 分钟`;
  if (minutes) return `每单位 ${minutes} 分钟`;
  if (units) return `${units} 个计费单位`;
  return '';
}

function orderPrice(item: Record<string, unknown>): string {
  return typeof item.amountMinor === 'number' && typeof item.currency === 'string'
    ? formatMinorCurrency(item.amountMinor, item.currency)
    : '待确认';
}

function compactIdentifier(value: unknown): string {
  const id = textValue(value);
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id || '—';
}

function formatOrderDate(value: unknown): string {
  if (typeof value !== 'string') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function orderStatusLabel(status: string): string {
  return ({ DRAFT: '草稿', PENDING_DISPATCH: '等待陪玩报名', ACCEPTED: '已接单', IN_SERVICE: '服务中', PENDING_CONFIRMATION: '等待客户确认', COMPLETED: '已完成', CANCELLED: '已取消', EXCEPTION: '需要处理' } as Record<string, string>)[status] ?? (status || '未知状态');
}

function orderOperationalState(status:string):{blocker:string;nextAction:string}{
  return ({
    DRAFT:{blocker:'订单尚未提交',nextAction:'核对项目与价格后提交订单'},
    PENDING_DISPATCH:{blocker:'尚无陪玩接单',nextAction:'继续等待候选或联系客户'},
    ACCEPTED:{blocker:'等待所有有效陪玩就绪',nextAction:'确认各有效陪玩已完成就绪'},
    IN_SERVICE:{blocker:'无',nextAction:'关注服务进度与异常反馈'},
    PENDING_CONFIRMATION:{blocker:'等待客户确认完成',nextAction:'提醒客户确认或登记问题'},
    COMPLETED:{blocker:'无',nextAction:'无需处理'},
    CANCELLED:{blocker:'订单已取消',nextAction:'核对预留资金已释放'},
    EXCEPTION:{blocker:'订单存在异常',nextAction:'查看时间线并处理异常'}
  } as Record<string,{blocker:string;nextAction:string}>)[status]??{blocker:'状态待核对',nextAction:'查看详情并确认订单状态'};
}

function formatRelativeDate(value:unknown):string{
  if(typeof value!=='string')return '未知时间';const timestamp=new Date(value).getTime();if(Number.isNaN(timestamp))return value;
  const seconds=Math.round((timestamp-Date.now())/1000);const absolute=Math.abs(seconds);
  const [amount,unit]:[number,Intl.RelativeTimeFormatUnit]=absolute<60?[seconds,'second']:absolute<3600?[Math.round(seconds/60),'minute']:absolute<86400?[Math.round(seconds/3600),'hour']:[Math.round(seconds/86400),'day'];
  return new Intl.RelativeTimeFormat('zh-CN',{numeric:'auto'}).format(amount,unit);
}

function AdminBusinessTable(props: {
  model: AdminBusinessPageModel;
  columns:ReadonlyArray<{key:string;label:string}>;
  onAction?: (action: AdminBusinessAction, item?: Record<string, unknown>) => void;
  onOpenDetail?: (item: Record<string, unknown>) => void;
  businessTagOptions?: BusinessTagGroups;
}) {
  const columns=props.columns.length?props.columns:props.model.page==='commissions'?[{key:'id',label:'编号'},{key:'status',label:'状态'},{key:'sourceUserDisplay',label:'来源用户'},{key:'sourceType',label:'来源类型'},{key:'amountMinor',label:'金额'},{key:'createdAt',label:'创建时间'}]:[{key:'id',label:'编号'},{key:'playerId',label:'陪玩编号'},{key:'status',label:'状态'},{key:'amountMinor',label:'金额'},{key:'createdAt',label:'创建时间'}];
  const itemActions = props.onAction ? props.model.actions.filter((action) => action.scope === 'ITEM') : [];
  const hasDetail = Boolean(props.onOpenDetail) && adminDetailPages.includes(props.model.page);
  const hasOperations = hasDetail || props.model.items.some((item) => itemActions.some((action) => playerActionApplies(action, item)));
  return (
    <div className="content-panel content-panel--flush collection-table-view">
      <div className="table-scroll collection-desktop-table"><table className="data-table">
        <thead><tr>{hasOperations && <th className="data-column--actions" scope="col" title="actions">操作</th>}{columns.map((column) => <th className={column.key.toLowerCase() === 'id' ? 'data-column--id' : undefined} key={column.key} scope="col" title={column.key}>{column.label||dashboardFieldLabel(column.key)}</th>)}</tr></thead>
        <tbody>{props.model.items.map((item, index) => (
          <tr key={typeof item.id === 'string' ? item.id : index}>
            {hasOperations && <td className="table-actions">
              <CollectionItemActions page={props.model.page} item={item} actions={itemActions} variant="TABLE" className="table-actions__group" onAction={props.onAction} onOpenDetail={props.onOpenDetail} />
            </td>}
            {columns.map((column) => <td className={column.key.toLowerCase() === 'id' ? 'data-column--id' : undefined} key={column.key}>{displayValue(column.key, item[column.key], item.currency, props.businessTagOptions)}</td>)}
          </tr>
        ))}</tbody>
      </table></div>
      <div className="collection-row-list">{props.model.items.map((item,index)=><article className="collection-list-row" key={typeof item.id==='string'?item.id:index} tabIndex={0}><dl>{columns.map((column)=><div key={column.key}><dt>{column.label}</dt><dd>{displayValue(column.key,item[column.key],item.currency,props.businessTagOptions)}</dd></div>)}</dl>{hasOperations&&<CollectionItemActions page={props.model.page} item={item} actions={itemActions} variant="TABLE" className="table-actions__group" onAction={props.onAction} onOpenDetail={props.onOpenDetail} />}</article>)}</div>
    </div>
  );
}

function playerActionApplies(action:AdminBusinessAction,item:Record<string,unknown>):boolean{if(action.id==='REFUND_ORDER')return ['COMPLETED','EXCEPTION'].includes(textValue(item.status));if(action.id==='CANCEL_ORDER_RESOLUTION')return ['ACCEPTED','IN_SERVICE','PENDING_CONFIRMATION','EXCEPTION'].includes(textValue(item.status));if(action.id==='APPROVE_COMPANION'||action.id==='REJECT_COMPANION')return item.reviewStatus==='PENDING_REVIEW';if(action.id==='SET_PLAYER_OPERATIONAL_STATUS')return ['APPROVED','ACTIVE','PAUSED','SUSPENDED'].includes(textValue(item.reviewStatus));if(action.id==='EDIT_COMPANION_TAGS')return item.reviewStatus!=='PENDING_REVIEW'&&item.reviewStatus!=='REJECTED';if(action.id==='UPDATE_PACKAGE_STATUS')return item.status==='DRAFT'||item.status==='ACTIVE';if(action.id==='CONFIRM')return item.status==='PENDING';if(action.id==='MARK_PAID')return item.status==='CONFIRMED';return true;}

function AdminActionPanel(props: {
  active: { action: AdminBusinessAction; item?: Record<string, unknown> };
  status: 'IDLE' | 'SUBMITTING' | 'ERROR';
  error?: string | null;
  onCancel?: () => void;
  onSubmit?: (action: AdminBusinessAction, item: Record<string, unknown> | undefined, fields: Record<string, string | boolean>) => void;
  businessTagOptions?: BusinessTagGroups;
  serviceCatalogOptions?: Array<Record<string, unknown>>;
}) {
  const action = props.active.action;
  const [pendingCompensation,setPendingCompensation]=useState<{fields:Record<string,string|boolean>;changes:Array<{offering:Record<string,unknown>;draft:Record<string,string>}>}|null>(null);
  const handleSubmit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const fields=collectActionFields(event.currentTarget);if(action.id==='EDIT_PLAYER_COMPENSATION'&&typeof fields.compensationChangesJson==='string'){try{const drafts=JSON.parse(fields.compensationChangesJson) as Array<Record<string,string>>;const changes=drafts.map((draft)=>({draft,offering:(props.serviceCatalogOptions??[]).find((item)=>textValue(item.serviceOfferingId)===draft.serviceOfferingId)})).filter((change):change is {offering:Record<string,unknown>;draft:Record<string,string>}=>Boolean(change.offering));if(changes.length){setPendingCompensation({fields,changes});return;}}catch{/* API builder will report malformed drafts. */}}props.onSubmit?.(action,props.active.item,fields);};
  return <>
    <aside className="action-panel" aria-label={`${action.label}操作面板`}>
      <div className="panel-heading"><div><span className="page-eyebrow">ACTION</span><h2>{action.label}</h2></div><button type="button" disabled={props.status === 'SUBMITTING'} onClick={props.onCancel}>关闭</button></div>
      <form className="form-grid" aria-label={`${action.label}操作表单`} onSubmit={handleSubmit}>
        <ActionFields action={action} item={props.active.item} businessTagOptions={props.businessTagOptions} serviceCatalogOptions={props.serviceCatalogOptions} />
        {action.requiresReason && (action.id === 'CANCEL_ORDER_RESOLUTION'
          ? <label className="field"><span>取消原因</span><select name="reasonCode" required defaultValue="USER_REQUEST"><option value="USER_REQUEST">客户请求</option><option value="DISPATCH_TIMEOUT">派单超时</option><option value="PLAYER_NO_SHOW">陪玩未到场</option><option value="CUSTOMER_NO_SHOW">客户未到场</option><option value="SERVICE_INTERRUPTED">服务中断</option><option value="COMPLETION_DISPUTE">完成争议</option><option value="PAYMENT_FAILURE">资金处理失败</option><option value="REFUND_FAILURE">退款处理失败</option><option value="ADMIN_CORRECTION">管理员纠正</option></select></label>
          : action.id === 'REFUND_ORDER' ? null
          : <label className="field"><span>原因码</span><input name="reasonCode" required pattern="[A-Z0-9_]{3,100}" placeholder="OPERATIONS_DECISION" /></label>)}
        {props.error && <p className="form-message form-message--error" role="alert">{props.error}</p>}
        <div className="form-actions">
          <button className="button-primary" type="submit" disabled={props.status === 'SUBMITTING'}>{props.status === 'SUBMITTING' ? '提交中...' : '提交'}</button>
          <button type="button" disabled={props.status === 'SUBMITTING'} onClick={props.onCancel}>取消</button>
        </div>
      </form>
    </aside>
    {pendingCompensation&&<DashboardOverlay label="确认项目分成改动" onClose={()=>setPendingCompensation(null)}><CompensationChangeConfirmation changes={pendingCompensation.changes} onCancel={()=>setPendingCompensation(null)} onConfirm={()=>{const pending=pendingCompensation;setPendingCompensation(null);props.onSubmit?.(action,props.active.item,pending.fields);}}/></DashboardOverlay>}
  </>;
}

function CompensationChangeConfirmation(props:{changes:Array<{offering:Record<string,unknown>;draft:Record<string,string>}>;onCancel:()=>void;onConfirm:()=>void}){return <aside className="action-panel compensation-confirmation" aria-label="分成改动确认"><div className="panel-heading"><div><span className="page-eyebrow">CONFIRM CHANGE</span><h2>确认分成改动（{props.changes.length} 项）</h2></div><button type="button" onClick={props.onCancel}>返回编辑</button></div><p>确认后会一次性写入全部项目；任一项目版本冲突或校验失败时，所有改动都不会保存。</p><div className="compensation-confirmation__changes">{props.changes.map(({offering,draft})=>{const rule=offering.compensationRule as Record<string,unknown>|undefined;return <dl className="compensation-confirmation__facts" key={draft.serviceOfferingId}><div><dt>项目</dt><dd>{compensationProjectName(offering)}</dd></div><div><dt>原分成</dt><dd>{compensationRuleText(rule,offering)}</dd></div><div><dt>新分成</dt><dd>{compensationDraftText(draft,offering)}</dd></div><div><dt>修改方式</dt><dd>{draft.type==='FIXED_MINOR'?'每计费单位固定收益':'按客户价格比例'}</dd></div></dl>;})}</div><div className="form-actions"><button className="button-primary" type="button" onClick={props.onConfirm}>确认并保存全部</button><button type="button" onClick={props.onCancel}>取消</button></div></aside>}

function ActionFields({ action, item, businessTagOptions, serviceCatalogOptions }: { action: AdminBusinessAction; item?:Record<string,unknown>; businessTagOptions?: BusinessTagGroups;serviceCatalogOptions?:Array<Record<string,unknown>> }) {
  if(action.id==='REFUND_ORDER')return <StandaloneRefundFields item={item}/>;
  if(action.id==='CANCEL_ORDER_RESOLUTION')return <OrderCancellationResolutionFields item={item}/>;
  if(action.id==='APPROVE_COMPANION')return <><TagSelect name="gameTagIds" label="支持游戏" items={businessTagOptions?.GAME??[]} multiple/><TagSelect name="serviceTagIds" label="支持服务/种类" items={businessTagOptions?.SERVICE??[]} multiple/><TagSelect name="languageTagIds" label="服务语言（可选）" items={businessTagOptions?.LANGUAGE??[]} multiple required={false}/></>;
  if(action.id==='EDIT_COMPANION_TAGS')return <><TagSelect name="gameTagIds" label="支持游戏" items={businessTagOptions?.GAME??[]} multiple selectedCodes={stringList(item?.gameTags)}/><TagSelect name="serviceTagIds" label="支持服务/种类" items={businessTagOptions?.SERVICE??[]} multiple selectedCodes={stringList(item?.serviceTags)}/><TagSelect name="languageTagIds" label="服务语言（可选）" items={businessTagOptions?.LANGUAGE??[]} multiple required={false} selectedCodes={stringList(item?.languageTags)}/></>;
  if(action.id==='EDIT_PLAYER_COMPENSATION')return <PlayerCompensationFields offerings={serviceCatalogOptions??[]}/>;
  if(action.id==='REJECT_COMPANION')return <label className="field field--full"><span>拒绝说明</span><textarea name="note" required rows={4} maxLength={1000}/></label>;
  if (action.id === 'SET_OPERATIONAL_STATUS'||action.id==='SET_PLAYER_OPERATIONAL_STATUS') return <>
    <label className="field"><span>目标状态</span><select name="status" required defaultValue="PAUSED"><option value="ACTIVE">恢复</option><option value="PAUSED">暂停</option><option value="SUSPENDED">停用</option></select></label>
    <label className="field field--full"><span>处理说明</span><textarea name="note" rows={3} maxLength={1000} /></label>{action.id==='SET_PLAYER_OPERATIONAL_STATUS'?<p className="field-help field--full">此状态由员工控制候选池与新订单申请资格；Discord 在线状态仅供诊断。</p>:null}
  </>;
  if (action.id === 'CREATE_GIFT') return <GiftCatalogFields options={businessTagOptions}/>;
  if (action.id === 'CREATE_SERVICE_VERSION') return <ServiceCatalogFields options={businessTagOptions}/>;
  if(action.id==='CREATE_PACKAGE_VERSION'||action.id==='COPY_PACKAGE_VERSION')return <ServicePackageFields key={textValue(item?.id)||'new-package'} catalogs={serviceCatalogOptions??[]} item={action.id==='COPY_PACKAGE_VERSION'?item:undefined}/>;
  if(action.id==='UPDATE_PACKAGE_STATUS')return <PackageStatusFields item={item}/>;
  if (action.id === 'UPDATE_GIFT_VERSION') return <VersionActionFields action={action} replacementAction="CREATE_REPLACEMENT_VERSION" replacementFields={<GiftCatalogFields options={businessTagOptions} item={item}/>} />;
  if (action.id === 'UPDATE_VERSION') return <VersionActionFields action={action} replacementAction="SUPERSEDE" replacementFields={<ServiceCatalogFields options={businessTagOptions} item={item}/>} />;
  if(action.id==='ARCHIVE_SERVICE'||action.id==='ARCHIVE_GIFT')return <div className="field field--full archive-warning"><strong>确认归档当前版本？</strong><p>归档后当前版本不再出现在新业务目录中；历史订单、礼物记录和金额快照保持不变。</p></div>;
  if (action.id === 'CREATE_RISK_EVENT') return <>
    <label className="field"><span>事件类型</span><select name="type" required defaultValue="PAYMENT_ANOMALY"><option value="PAYMENT_ANOMALY">支付异常</option><option value="DUPLICATE_ACCOUNT_SIGNAL">重复账号信号</option><option value="REFERRAL_ABUSE_SIGNAL">返佣滥用信号</option><option value="PLAYER_NO_SHOW">陪玩未到场</option><option value="CUSTOMER_NO_SHOW">用户未到场</option></select></label>
    <label className="field"><span>严重程度</span><select name="severity" required defaultValue="MEDIUM"><option value="LOW">低</option><option value="MEDIUM">中</option><option value="HIGH">高</option></select></label>
    <label className="field"><span>来源</span><select name="source" required defaultValue="STAFF_REVIEW"><option value="STAFF_REVIEW">员工复核</option><option value="CUSTOMER_REPORT">用户反馈</option><option value="PLAYER_REPORT">陪玩反馈</option><option value="SYSTEM_SIGNAL">系统信号</option></select></label>
    <label className="field"><span>关联订单 ID（可选）</span><input name="orderId" maxLength={100} /></label>
    <label className="field field--full"><span>说明</span><textarea name="notes" required rows={4} maxLength={2000} /></label>
  </>;
  return null;
}

function StandaloneRefundFields({item}:{item?:Record<string,unknown>}) {
  const currency=textValue(item?.currency)||'CAT';
  const amountMinor=numberValue(item?.refundableAmountMinor)??numberValue(item?.amountMinor)??0;
  return <>
    <div className="field field--full context-note"><strong>订单保持原状态</strong><p>这是独立资金退款，只追加退款与关联冲正，不会取消订单或覆盖原账目。</p></div>
    <input type="hidden" name="currency" value={currency}/>
    <label className="field"><span>退款金额（minor units）</span><input name="amountMinor" type="number" required min={1} max={amountMinor} step={1}/><small>当前最多可提交 {amountMinor} {currency}，最终以服务端可退款事实为准。</small></label>
    <label className="field"><span>退款原因</span><select name="reasonCode" required defaultValue="PARTIAL_SERVICE_REFUND"><option value="PARTIAL_SERVICE_REFUND">部分服务退款</option><option value="QUALITY_COMPLAINT">服务质量投诉</option><option value="SERVICE_INTERRUPTED">服务中断</option><option value="ADMIN_CORRECTION">管理员纠正</option></select></label>
    <label className="field field--full"><span>核对证据与处理说明</span><textarea name="evidenceNote" required rows={4} maxLength={2000} placeholder="说明客户诉求、服务进度、双方沟通和退款依据。"/></label>
  </>;
}

function OrderCancellationResolutionFields({item}:{item?:Record<string,unknown>}) {
  const currency=textValue(item?.currency)||'CAT';
  const amountMinor=numberValue(item?.amountMinor)??0;
  const playerEarningMinor=numberValue(item?.playerEarningMinor)??0;
  return <>
    <div className="field field--full archive-warning"><strong>确认取消并结案？</strong><p>该操作会原子处理预留、退款、陪玩收益和审计；订单进入 CANCELLED 后不能恢复。</p></div>
    <input type="hidden" name="currency" value={currency}/>
    <label className="field"><span>退回客户（minor units）</span><input name="refundAmountMinor" type="number" required min={0} max={amountMinor} step={1} defaultValue={amountMinor}/><small>最多 {amountMinor} {currency}；未扣款订单将按此金额释放预留。</small></label>
    <label className="field"><span>保留陪玩收益（minor units）</span><input name="playerEarningMinor" type="number" required min={0} max={playerEarningMinor} step={1} defaultValue={0}/><small>最多 {playerEarningMinor} {currency}；依据已完成服务量人工核对。</small></label>
    <label className="field field--full"><span>核对证据与处理说明</span><textarea name="evidenceNote" required rows={4} maxLength={2000} placeholder="说明已核对的订单频道、服务进度与退款/收益依据。"/></label>
  </>;
}

function PlayerCompensationFields({offerings}:{offerings:Array<Record<string,unknown>>}){
  const firstId=textValue(offerings[0]?.serviceOfferingId);
  const[selected,setSelected]=useState(firstId);
  const [compensationDrafts,setCompensationDrafts]=useState<Record<string,CompensationDraft>>(()=>createCompensationDrafts(offerings));
  useEffect(()=>{if(!offerings.length){setSelected('');return;}if(!offerings.some((item)=>textValue(item.serviceOfferingId)===selected))setSelected(textValue(offerings[0].serviceOfferingId));setCompensationDrafts((current)=>mergeCompensationDrafts(current,offerings));},[offerings,selected]);
  const selectedOffering=offerings.find((item)=>textValue(item.serviceOfferingId)===selected);
  const rule=selectedOffering?.compensationRule as Record<string,unknown>|undefined;
  const draft=compensationDrafts[selected]??compensationDraft(selectedOffering);
  const updateDraft=(next:Partial<CompensationDraft>)=>setCompensationDrafts((current)=>({...current,[selected]:{...draft,...next}}));
  const changedDrafts=offerings.flatMap((item)=>{const serviceOfferingId=textValue(item.serviceOfferingId);const itemDraft=compensationDrafts[serviceOfferingId]??compensationDraft(item);return compensationDraftChanged(itemDraft,item.compensationRule as Record<string,unknown>|undefined)?[{serviceOfferingId,expectedVersion:typeof (item.compensationRule as Record<string,unknown>|undefined)?.version==='number'?String((item.compensationRule as Record<string,unknown>).version):'',...itemDraft}]:[];});
  return <>
    <section className="field field--full player-compensation-browser" aria-labelledby="player-compensation-title">
      <div className="player-compensation-browser__heading"><div><span id="player-compensation-title">陪玩项目分成</span><p>全部项目与当前规则同时展示；选择一项后在下方编辑。</p></div><strong>{offerings.length} 个项目</strong></div>
      {offerings.length===0?<p className="player-compensation-empty">当前没有已启用的服务项目。</p>:<div className="player-compensation-list" role="radiogroup" aria-label="选择要编辑的陪玩项目">{offerings.map((item)=>{
        const id=textValue(item.serviceOfferingId);const itemRule=item.compensationRule as Record<string,unknown>|undefined;const itemDraft=compensationDrafts[id]??compensationDraft(item);const active=selected===id;const changed=compensationDraftChanged(itemDraft,itemRule);
        return <label className={`player-compensation-item${active?' player-compensation-item--selected':''}`} key={id}>
          <input type="radio" name="serviceOfferingId" value={id} checked={active} required onChange={()=>setSelected(id)}/>
          <span className="player-compensation-item__content"><span className="player-compensation-item__project"><strong>{compensationProjectName(item)}</strong><small>{[item.regionDisplayName??item.region,typeof item.billingUnitMinutes==='number'?`${item.billingUnitMinutes} 分钟/单位`:null].filter(Boolean).join(' · ')||'不限区服'}</small></span><span className="player-compensation-item__rule"><small>{changed?'草稿已缓存':itemRule?'当前个人分成':'当前生效分成'}</small><strong>{changed?compensationDraftText(itemDraft,item):compensationRuleText(itemRule,item)}</strong><span>项目默认分成 {defaultCompensationText(item)}</span></span><span className="player-compensation-item__action">{active?'正在编辑':changed?'有草稿':'编辑'}</span></span>
        </label>;
      })}</div>}
    </section>
    <input type="hidden" name="compensationChangesJson" value={JSON.stringify(changedDrafts)}/>
    {selectedOffering&&<><div className="field field--full player-compensation-editor-heading"><span>编辑 {compensationProjectName(selectedOffering)}</span><small>本次将保存全部已缓存的项目草稿</small></div>
      <input type="hidden" name="compensationVersion" value={typeof rule?.version==='number'?rule.version:''}/>
      <label className="field"><span>分成方式</span><select name="compensationType" value={draft.type} onChange={(event)=>updateDraft({type:event.currentTarget.value as CompensationDraft['type']})}><option value="PERCENT_BPS">按客户价格比例</option><option value="FIXED_MINOR">每计费单位固定金额</option></select></label>
      {draft.type==='PERCENT_BPS'?<label className="field"><span>分成比例（%）</span><input name="percentage" type="number" required min="0.01" max="100" step="0.01" placeholder="例如 60" value={draft.percentage} onChange={(event)=>updateDraft({percentage:event.currentTarget.value})}/></label>:<label className="field"><span>每单位固定收益（minor units）</span><input name="fixedAmountMinor" type="number" required min="1" step="1" value={draft.fixedAmountMinor} onChange={(event)=>updateDraft({fixedAmountMinor:event.currentTarget.value})}/></label>}
      <p className="field-help field--full">输入会即时缓存到本窗口的项目草稿；点击提交后仍需在确认窗口确认，才会保存。修改不会追溯已接单订单。</p></>}
  </>;
}

function compensationProjectName(item:Record<string,unknown>):string{return [item.gameDisplayName??item.game,item.serviceDisplayName??item.service].filter(Boolean).join(' · ')||'未命名项目';}
function defaultCompensationText(item:Record<string,unknown>):string{return typeof item.defaultPlayerPayoutBps==='number'?`${(item.defaultPlayerPayoutBps/100).toFixed(2)}%`:'未配置';}
function compensationRuleText(rule:Record<string,unknown>|undefined,item:Record<string,unknown>):string{if(rule?.type==='PERCENT_BPS'&&typeof rule.value==='number')return `${(rule.value/100).toFixed(2)}%`;if(rule?.type==='FIXED_MINOR'&&typeof rule.value==='number')return `${formatMinorCurrency(rule.value,textValue(rule.currency)||textValue(item.currency)||'CAT')}/单位`;return defaultCompensationText(item);}
type CompensationDraft={type:'PERCENT_BPS'|'FIXED_MINOR';percentage:string;fixedAmountMinor:string};
function compensationDraft(item?:Record<string,unknown>):CompensationDraft{const rule=item?.compensationRule as Record<string,unknown>|undefined;return{type:rule?.type==='FIXED_MINOR'?'FIXED_MINOR':'PERCENT_BPS',percentage:rule?.type==='PERCENT_BPS'&&typeof rule.value==='number'?String(rule.value/100):'',fixedAmountMinor:rule?.type==='FIXED_MINOR'&&typeof rule.value==='number'?String(rule.value):''};}
function createCompensationDrafts(offerings:Array<Record<string,unknown>>):Record<string,CompensationDraft>{return Object.fromEntries(offerings.map((item)=>[textValue(item.serviceOfferingId),compensationDraft(item)]));}
function mergeCompensationDrafts(current:Record<string,CompensationDraft>,offerings:Array<Record<string,unknown>>):Record<string,CompensationDraft>{const next={...current};for(const item of offerings){const id=textValue(item.serviceOfferingId);if(!next[id])next[id]=compensationDraft(item);}return next;}
function compensationDraftChanged(draft:CompensationDraft,rule:Record<string,unknown>|undefined):boolean{if(draft.type!==textValue(rule?.type||'PERCENT_BPS'))return Boolean(draft.percentage||draft.fixedAmountMinor||rule);const current=draft.type==='PERCENT_BPS'&&typeof rule?.value==='number'?String(rule.value/100):draft.type==='FIXED_MINOR'&&typeof rule?.value==='number'?String(rule.value):'';return (draft.type==='PERCENT_BPS'?draft.percentage:draft.fixedAmountMinor)!==current;}
function compensationDraftText(draft:CompensationDraft|Record<string,string|boolean>,item:Record<string,unknown>):string{const type='compensationType'in draft?draft.compensationType:draft.type;if(type==='FIXED_MINOR'){const value=typeof draft.fixedAmountMinor==='string'?draft.fixedAmountMinor:'';return value?`${formatMinorCurrency(Number(value),textValue(item.currency)||'CAT')}/单位`:'未填写';}const value=typeof draft.percentage==='string'?draft.percentage:'';return value?`${value}%`:'未填写';}

function GiftCatalogFields({options,item}:{options?:BusinessTagGroups;item?:Record<string,unknown>}) {
  return <>
    <label className="field"><span>礼物名称</span><input name="name" required maxLength={100} defaultValue={textValue(item?.name)} /></label>
    <TagSelect name="giftCategoryTagId" label="礼物分类" items={options?.GIFT_CATEGORY??[]} selectedValue={textValue(item?.giftCategoryTagId)}/>
    <label className="field"><span>价格（minor units）</span><input name="amountMinor" type="number" required min={1} step={1} defaultValue={numberValue(item?.priceMinor)} /></label>
    <label className="field"><span>币种</span><select name="currency" required defaultValue="CAT"><option value="CAT">猫条（CAT）</option></select></label>
    <label className="checkbox-field"><input name="enabled" type="checkbox" defaultChecked={item?.enabled!==false} /><span>立即启用</span></label>
    <label className="field field--full"><span>播报模板</span><textarea name="broadcastTemplate" required rows={3} maxLength={500} defaultValue={textValue(item?.broadcastTemplate)} /></label>
  </>;
}

function ServiceCatalogFields({options,item}:{options?:BusinessTagGroups;item?:Record<string,unknown>}) {
  return <>
    <TagSelect name="gameTagId" label="游戏" items={options?.GAME??[]} selectedCodes={[textValue(item?.game)]}/>
    <TagSelect name="serviceTagId" label="服务/种类" items={options?.SERVICE??[]} selectedCodes={[textValue(item?.service)]}/>
    <TagSelect name="regionTagId" label="地区（可选）" items={options?.REGION??[]} required={false} selectedCodes={[textValue(item?.region)]}/>
    <label className="field"><span>计费单位（分钟）</span><input name="billingUnitMinutes" type="number" required min={1} max={1440} step={1} defaultValue={numberValue(item?.billingUnitMinutes)} /></label>
    <label className="field"><span>最少单位数</span><input name="minimumUnits" type="number" required min={1} max={1440} step={1} defaultValue={numberValue(item?.minimumUnits)} /></label>
    <label className="field"><span>用户单价（minor units）</span><input name="customerAmountMinor" type="number" required min={1} step={1} defaultValue={numberValue(item?.customerUnitPriceMinor)} /></label>
    <label className="field"><span>默认陪玩分成（%）</span><input name="defaultPlayerPayoutPercent" type="number" required min="0.01" max="100" step="0.01" defaultValue={typeof item?.defaultPlayerPayoutBps==='number'?item.defaultPlayerPayoutBps/100:60} /></label>
    <label className="field"><span>币种</span><select name="currency" required defaultValue="CAT"><option value="CAT">猫条（CAT）</option></select></label>
    <label className="checkbox-field"><input name="enabled" type="checkbox" defaultChecked={item?.enabled!==false} /><span>立即启用</span></label>
  </>;
}

function ServicePackageFields({catalogs,item}:{catalogs:Array<Record<string,unknown>>;item?:Record<string,unknown>}){
  const initialSlots=packageEditorSlots(item);
  const games=packageEditorGames(catalogs);
  const initialCatalog=catalogs.find(catalog=>textValue(catalog.id)===initialSlots[0]?.serviceCatalogVersionId);
  const[selectedGame,setSelectedGame]=useState(()=>textValue(item?.game)||textValue(initialCatalog?.game)||games[0]?.[0]||'');
  const[slots,setSlots]=useState<Array<{key:string;serviceCatalogVersionId:string;unitCount:number;customerNoteTemplate:string}>>(()=>initialSlots);
  const effectiveSelectedGame=games.some(([code])=>code===selectedGame)?selectedGame:games[0]?.[0]||'';
  const availableCatalogs=catalogs.filter(catalog=>textValue(catalog.game)===effectiveSelectedGame);
  const derivedTotalMinor=slots.reduce<number|null>((total,slot)=>{const catalog=catalogs.find(item=>textValue(item.id)===slot.serviceCatalogVersionId);const unitPrice=numberValue(catalog?.customerUnitPriceMinor);return total===null||unitPrice===undefined||!Number.isSafeInteger(slot.unitCount)||slot.unitCount<1?null:total+unitPrice*slot.unitCount;},0);
  const serialized=JSON.stringify(slots.map(({serviceCatalogVersionId,unitCount,customerNoteTemplate})=>({serviceCatalogVersionId,unitCount,customerNoteTemplate:customerNoteTemplate.trim()||null})));
  return <>
  {item&&<p className="field-help field--full">将基于当前版本创建一份可编辑的新版本；历史订单与原版本不会被改写。</p>}
  <label className="field"><span>套餐所属游戏</span><select value={effectiveSelectedGame} onChange={(event)=>{const game=event.currentTarget.value;setSelectedGame(game);setSlots(current=>current.map(slot=>catalogs.some(catalog=>textValue(catalog.id)===slot.serviceCatalogVersionId&&textValue(catalog.game)===game)?slot:{...slot,serviceCatalogVersionId:''}));}}>{games.map(([code,name])=><option key={code} value={code}>{name}</option>)}</select><small>一个套餐只能包含同一游戏的服务项目，归属由 API 根据席位校验并固化。</small></label>
  <label className="field"><span>稳定代码</span><input name="code" required maxLength={100} pattern="[A-Z0-9_]{2,100}" placeholder="DELTA_ESCORT" defaultValue={textValue(item?.code)}/></label>
  <label className="field"><span>展示名称</span><input name="displayName" required maxLength={100} placeholder="三角洲护航" defaultValue={textValue(item?.displayName)}/></label>
  <label className="field field--full"><span>套餐说明</span><textarea name="description" required rows={3} maxLength={1000} placeholder="两只技术猫猫护航，也可以把其中一席换成聊天陪伴。" defaultValue={textValue(item?.description)}/></label>
  <div className="field"><span>套餐总价（自动计算）</span><output aria-live="polite"><strong>{derivedTotalMinor===null?'选择有效服务项目后显示':formatMinorCurrency(derivedTotalMinor,'CAT')}</strong></output><small>按每个席位的服务目录单价 × 计费单位数汇总；最终金额由 API 校验并固化。</small></div>
  <label className="checkbox-field"><input name="activate" type="checkbox"/><span>创建后立即发布</span></label>
  <input type="hidden" name="slotsJson" value={serialized}/>
  <fieldset className="field field--full package-slot-editor"><legend>默认陪玩席位（按顺序）</legend>{slots.map((slot,index)=><div className="package-slot-row" key={slot.key}><strong>{index+1} 号位</strong><label><span>服务项目</span><select required value={slot.serviceCatalogVersionId} onChange={(event)=>{const value=event.currentTarget.value;setSlots(current=>current.map(item=>item.key===slot.key?{...item,serviceCatalogVersionId:value}:item));}}><option value="">请选择</option>{availableCatalogs.map(catalog=><option key={String(catalog.id)} value={String(catalog.id)}>{`${String(catalog.gameDisplayName??catalog.game)} · ${String(catalog.serviceDisplayName??catalog.service)}${catalog.regionDisplayName?` · ${String(catalog.regionDisplayName)}`:''}`}</option>)}</select></label><label><span>计费单位数</span><input type="number" min="1" step="1" value={slot.unitCount} onChange={(event)=>{const value=Number(event.currentTarget.value);setSlots(current=>current.map(item=>item.key===slot.key?{...item,unitCount:value}:item));}}/></label><label><span>默认偏好</span><input maxLength={500} value={slot.customerNoteTemplate} placeholder="例如：负责技术护航" onChange={(event)=>{const value=event.currentTarget.value;setSlots(current=>current.map(item=>item.key===slot.key?{...item,customerNoteTemplate:value}:item));}}/></label><button type="button" disabled={slots.length===1} onClick={()=>setSlots(current=>current.filter(item=>item.key!==slot.key))}>移除此席位</button></div>)}<button type="button" disabled={slots.length>=25} onClick={()=>setSlots(current=>[...current,{key:crypto.randomUUID(),serviceCatalogVersionId:'',unitCount:1,customerNoteTemplate:''}])}>添加陪玩席位</button><p className="field-help">每个席位都会生成一条独立需求，可分别匹配项目和陪玩。</p></fieldset>
</>}
function packageEditorSlots(item?:Record<string,unknown>):Array<{key:string;serviceCatalogVersionId:string;unitCount:number;customerNoteTemplate:string}>{const raw=Array.isArray(item?.slots)?item.slots:[];const slots=raw.map((slot)=>{const value=slot&&typeof slot==='object'&&!Array.isArray(slot)?slot as Record<string,unknown>:{};return{key:crypto.randomUUID(),serviceCatalogVersionId:textValue(value.serviceCatalogVersionId),unitCount:numberValue(value.unitCount)??1,customerNoteTemplate:textValue(value.customerNoteTemplate)};}).filter((slot)=>slot.serviceCatalogVersionId);return slots.length?slots:[{key:crypto.randomUUID(),serviceCatalogVersionId:'',unitCount:1,customerNoteTemplate:''}];}
function packageEditorGames(catalogs:Array<Record<string,unknown>>):Array<[string,string]>{const games=new Map<string,string>();for(const catalog of catalogs){const code=textValue(catalog.game);if(code&&!games.has(code))games.set(code,textValue(catalog.gameDisplayName)||code);}return [...games.entries()];}
function PackageStatusFields({item}:{item?:Record<string,unknown>}){const status=String(item?.status??'');return <div className="field field--full"><strong>{status==='DRAFT'?'发布这个草稿版本？':'退役这个启用版本？'}</strong><input type="hidden" name="action" value={status==='DRAFT'?'ACTIVATE':'RETIRE'}/><p>{status==='DRAFT'?'发布后，同套餐之前的启用版本会自动退役；历史订单仍保留原版本。':'退役后 Bot 不再向新订单展示该套餐，历史订单不受影响。'}</p></div>}

function TagSelect(props:{name:string;label:string;items:BusinessTagRecord[];multiple?:boolean;required?:boolean;selectedCodes?:string[];selectedValue?:string}){if(props.multiple)return <fieldset className="field tag-checklist"><legend>{props.label}</legend>{props.items.map((item)=><label className="checkbox-field" key={item.id}><input type="checkbox" name={props.name} value={item.id} defaultChecked={props.selectedCodes?.includes(item.code)}/><span>{item.displayName} · {item.code}</span></label>)}</fieldset>;const selected=props.selectedValue||props.items.find((item)=>props.selectedCodes?.includes(item.code))?.id||'';return <label className="field"><span>{props.label}</span><select name={props.name} required={props.required??true} defaultValue={selected}><option value="" disabled={props.required??true}>请选择</option>{props.items.map((item)=><option key={item.id} value={item.id}>{item.displayName} · {item.code}</option>)}</select></label>}
function stringList(value:unknown):string[]{return Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[];}
function textValue(value:unknown):string{return typeof value==='string'?value:'';}
function numberValue(value:unknown):number|undefined{return typeof value==='number'&&Number.isFinite(value)?value:undefined;}
function scalarValue(value:unknown):string{return typeof value==='string'&&value?value:typeof value==='number'&&Number.isFinite(value)?String(value):'—';}

function VersionActionFields(props: { action: AdminBusinessAction; replacementAction: string; replacementFields: ReactNode }) {
  const [action, setAction] = useState(props.replacementAction);
  return <>
    <label className="field"><span>操作</span><select name="action" required value={action} onChange={(event) => setAction(event.currentTarget.value)}><option value={props.replacementAction}>保存修改（创建新版本）</option><option value="ENABLE">启用</option><option value="DISABLE">停用</option></select></label>
    {action === props.replacementAction && props.replacementFields}
  </>;
}

function collectActionFields(form: HTMLFormElement): Record<string, string | boolean> {
  const fields: Record<string, string | boolean> = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (typeof value === 'string') fields[key] = typeof fields[key] === 'string' ? `${fields[key]},${value}` : value;
  }
  const enabled = form.elements.namedItem('enabled');
  if (enabled instanceof HTMLInputElement) fields.enabled = enabled.checked;
  const activate=form.elements.namedItem('activate');
  if(activate instanceof HTMLInputElement)fields.activate=activate.checked;
  return fields;
}

function AdminDetailRegion(props: { detail: AdminBusinessDetailState; onClose?: () => void; onNextConsumptions?: (cursor: string) => void; onNextTimeline?: (cursor: string) => void;onNextTranscript?:(cursor:string)=>void;serviceCatalogOptions?:Array<Record<string,unknown>>;participantPlayerOptions?:Array<Record<string,unknown>>;participantMutationError?:string|null;onAddOrderParticipant?:(fields:Record<string,unknown>)=>void;onUpdateOrderParticipant?:(fields:Record<string,unknown>)=>void;onUpdateOrderNote?:(fields:Record<string,unknown>)=>void;onUpdateOrderRequirement?:(fields:Record<string,unknown>)=>void }) {
  const { detail } = props;
  return (
    <aside className="content-panel detail-panel" aria-label="业务对象详情">
      <div className="panel-heading"><h2>详情</h2><button type="button" onClick={props.onClose}>关闭</button></div>
      {detail.kind === 'LOADING' && <p aria-busy="true">正在载入详情...</p>}
      {detail.kind === 'FORBIDDEN' && <p role="alert">{detail.page === 'orders' ? '当前订单不在你的任务权限范围内。' : '当前账号无权查看此详情。'}{detail.requestId ? ` request_id: ${detail.requestId}` : ''}</p>}
      {detail.kind === 'ERROR' && <p role="alert">详情暂时无法载入。{detail.requestId ? ` request_id: ${detail.requestId}` : ''}</p>}
      {detail.kind === 'READY' && detail.data && <>{detail.page === 'orders' ? <OrderTimelineRegion data={detail.data} pageState={detail.timelinePage} transcriptState={detail.transcriptPage} onNext={props.onNextTimeline} onNextTranscript={props.onNextTranscript} serviceCatalogOptions={props.serviceCatalogOptions??[]} participantPlayerOptions={props.participantPlayerOptions??[]} mutationError={props.participantMutationError} onAdd={props.onAddOrderParticipant} onUpdate={props.onUpdateOrderParticipant} onUpdateOrderNote={props.onUpdateOrderNote} onUpdateRequirement={props.onUpdateOrderRequirement} /> : <StructuredAdminDetail page={detail.page} data={detail.data} />}{detail.page === 'users' && detail.consumptions && <UserConsumptionRegion consumptions={detail.consumptions} onNext={props.onNextConsumptions} />}</>}
    </aside>
  );
}

function StructuredAdminDetail({ page, data }: { page: Exclude<AdminBusinessDetailState['page'], 'orders'>; data: Record<string, unknown> }) {
  if (page === 'users') return <CustomerDetail data={data} />;
  if (page === 'players') return <PlayerProfileDetail data={data} />;
  if (page === 'serviceCatalog') return <CatalogDetail data={data} />;
  if (page === 'servicePackages') return <PackageDetail data={data} />;
  if (page === 'giftCatalog') return <GiftCatalogDetail data={data} />;
  if (page === 'giftRequests') return <GiftRequestDetail data={data} />;
  return <dl className="definition-list">{Object.entries(data).map(([key, value]) => <div key={key}><dt><strong>{dashboardFieldLabel(key)}</strong></dt><dd>{displayValue(key, value, data.currency)}</dd></div>)}</dl>;
}

function DetailStatus({ status }: { status: string }) {
  return <span className={`entity-detail__status entity-detail__status--${status.toLowerCase()}`}>{catalogStatusLabel(status)}</span>;
}

function DetailFacts({ facts }: { facts: Array<{ label: string; value: string; strong?: boolean; mono?: boolean }> }) {
  return <dl className="entity-detail__facts">{facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd className={`${fact.strong ? 'is-strong' : ''} ${fact.mono ? 'is-mono' : ''}`.trim()}>{fact.value}</dd></div>)}</dl>;
}

function DetailTags({ values, empty = '未配置' }: { values: unknown; empty?: string }) {
  const tags = Array.isArray(values) ? values.map((value) => value && typeof value === 'object' && !Array.isArray(value) ? textValue((value as Record<string, unknown>).displayName) || textValue((value as Record<string, unknown>).code) : textValue(value)).filter(Boolean) : textValue(values).split(',').map((item) => item.trim()).filter(Boolean);
  return tags.length ? <div className="entity-detail__tags">{tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : <p className="entity-detail__empty">{empty}</p>;
}

function CustomerDetail({ data }: { data: Record<string, unknown> }) {
  const status = textValue(data.status);
  const riskFlags = Array.isArray(data.riskFlags) ? data.riskFlags : textValue(data.riskFlags) ? [textValue(data.riskFlags)] : [];
  return <div className="entity-detail customer-detail">
    <header className="entity-detail__hero"><div><span className="entity-detail__eyebrow">客户概览</span><h3>{textValue(data.displayName) || '未命名客户'}</h3><p>{textValue(data.discordUsername) ? `Discord · ${textValue(data.discordUsername)}` : 'Discord 身份未绑定'}</p></div>{status && <DetailStatus status={status} />}</header>
    <div className="entity-detail__layout"><section className="entity-detail__section"><div className="entity-detail__section-heading"><div><span>ACCOUNT</span><h4>账户与运营</h4></div></div><DetailFacts facts={[{ label: '客户编号', value: textValue(data.id) || '—', mono: true }, { label: 'Discord 用户编号', value: textValue(data.discordUserId) || '—', mono: true }, { label: '外部账户摘要', value: textValue(data.externalAccountDisplay) || '—' }, { label: '进行中订单', value: textValue(data.activeOrderId) || '无' }, { label: '风险标记', value: riskFlags.length ? `${riskFlags.length} 项` : '无' }, { label: '数据版本', value: scalarValue(data.version) }, { label: '创建时间', value: scalarValue(data.createdAt) }, { label: '更新时间', value: scalarValue(data.updatedAt) }]} />{riskFlags.length > 0 && <DetailTags values={riskFlags} />}</section>
      <aside className="entity-detail__aside"><span className="entity-detail__aside-label">CUSTOMER PROFILE</span><h4>查看完整客户资料</h4><p>余额、订单、消费与风险模块会在独立档案中按权限展示。</p>{typeof data.id === 'string' && <a className="entity-detail__link" href={`/admin/users/${encodeURIComponent(data.id)}/profile`}>打开完整客户档案 <span aria-hidden="true">→</span></a>}</aside></div>
  </div>;
}

function PlayerProfileDetail({ data }: { data: Record<string, unknown> }) {
  const status = textValue(data.reviewStatus);
  return <div className="entity-detail player-profile-detail">
    <header className="entity-detail__hero"><div><span className="entity-detail__eyebrow">陪玩档案</span><h3>{textValue(data.displayName) || '未命名陪玩'}</h3><p>{textValue(data.discordUsername) ? `Discord · ${textValue(data.discordUsername)}` : 'Discord 身份未绑定'}</p></div>{status && <DetailStatus status={status} />}</header>
    <div className="entity-detail__layout"><section className="entity-detail__section"><div className="entity-detail__section-heading"><div><span>SERVICE RANGE</span><h4>支持范围</h4></div></div><div className="entity-detail__tag-groups"><div><h5>游戏</h5><DetailTags values={data.gameTagDetails ?? data.gameTags} /></div><div><h5>服务</h5><DetailTags values={data.serviceTagDetails ?? data.serviceTags} /></div><div><h5>语言</h5><DetailTags values={data.languageTagDetails ?? data.languageTags} /></div></div></section>
      <section className="entity-detail__section"><div className="entity-detail__section-heading"><div><span>IDENTITY</span><h4>账号与状态</h4></div></div><DetailFacts facts={[{ label: '陪玩编号', value: textValue(data.playerId) || '—', mono: true }, { label: '用户编号', value: textValue(data.userId) || '—', mono: true }, { label: 'Discord 用户编号', value: textValue(data.discordUserId) || '—', mono: true }, { label: '审核状态', value: status || '—' }, { label: '旧状态（仅诊断）', value: textValue(data.availability) || '—' }, { label: 'Discord 在线状态（仅诊断）', value: textValue(data.discordPresence) || '—' }, { label: '进行中订单', value: textValue(data.activeOrderId) || '无' }, { label: '数据版本', value: scalarValue(data.version) }, { label: '创建时间', value: scalarValue(data.createdAt) }, { label: '更新时间', value: scalarValue(data.updatedAt) }]} /></section></div>
  </div>;
}

function CatalogDetail({ data }: { data: Record<string, unknown> }) {
  const status = textValue(data.status) || (data.enabled === false ? 'INACTIVE' : 'ACTIVE');
  const currency = textValue(data.currency) || 'CAT';
  const game = textValue(data.gameDisplayName) || textValue(data.game) || '未指定游戏';
  const service = textValue(data.serviceDisplayName) || textValue(data.service) || '未指定服务';
  const payoutBps = numberValue(data.defaultPlayerPayoutBps);
  return <div className="entity-detail catalog-detail">
    <header className="entity-detail__hero entity-detail__hero--catalog"><div><span className="entity-detail__eyebrow">服务项目</span><h3>{game} <span>·</span> {service}</h3><p>{textValue(data.regionDisplayName) || textValue(data.region) || '不限区服'} · 版本 {scalarValue(data.version)}</p></div><DetailStatus status={status} /></header>
    <section className="entity-detail__price-strip" aria-label="价格与计费概览"><div><span>客户单价</span><strong>{priceValue(data.customerUnitPriceMinor, currency)}</strong></div><div><span>计费单位</span><strong>{numberValue(data.billingUnitMinutes) ? `${numberValue(data.billingUnitMinutes)} 分钟` : '—'}</strong></div><div><span>最低购买</span><strong>{numberValue(data.minimumUnits) ? `${numberValue(data.minimumUnits)} 单位` : '—'}</strong></div></section>
    <div className="entity-detail__layout"><section className="entity-detail__section"><div className="entity-detail__section-heading"><div><span>PRICING</span><h4>价格与计费</h4></div></div><DetailFacts facts={[{ label: '客户单位价格', value: priceValue(data.customerUnitPriceMinor, currency), strong: true }, { label: '默认陪玩分成', value: payoutBps == null ? '未配置' : `${payoutBps / 100}%` }, { label: '结算币种', value: currency }, { label: '最低购买单位', value: numberValue(data.minimumUnits) ? `${numberValue(data.minimumUnits)} 单位` : '—' }]} /></section>
      <section className="entity-detail__section"><div className="entity-detail__section-heading"><div><span>IDENTIFIERS</span><h4>目录标识与审计</h4></div></div><DetailFacts facts={[{ label: '稳定代码', value: textValue(data.offeringKey) || textValue(data.code) || '—', mono: true }, { label: '服务项目编号', value: textValue(data.serviceOfferingId) || '—', mono: true }, { label: '目录版本编号', value: textValue(data.id) || '—', mono: true }, { label: '创建员工', value: textValue(data.createdByStaffId) || '—', mono: true }, { label: '创建时间', value: scalarValue(data.createdAt) }, { label: '激活时间', value: scalarValue(data.activatedAt) }, { label: '退役时间', value: scalarValue(data.retiredAt) }]} /></section></div>
  </div>;
}

function PackageDetail({ data }: { data: Record<string, unknown> }) {
  const status = textValue(data.status) || 'DRAFT';
  const currency = textValue(data.currency) || 'CAT';
  const slots = Array.isArray(data.slots) ? data.slots.filter((slot): slot is Record<string, unknown> => Boolean(slot && typeof slot === 'object' && !Array.isArray(slot))) : [];
  return <div className="entity-detail package-detail">
    <header className="entity-detail__hero entity-detail__hero--package"><div><span className="entity-detail__eyebrow">套餐概览</span><h3>{textValue(data.displayName) || textValue(data.code) || '未命名套餐'}</h3><p>{textValue(data.gameDisplayName) || textValue(data.game) || '游戏归属待确认'} · {slots.length} 个独立席位 · 版本 {scalarValue(data.version)}</p></div><DetailStatus status={status} /></header>
    <section className="entity-detail__package-intro"><div><span>套餐说明</span><p>{textValue(data.description) || '暂未填写套餐说明。'}</p></div><div><span>套餐价格</span><strong>{priceValue(data.defaultCustomerPriceMinor, currency)}</strong><small>由 API 按席位目录价格汇总</small></div></section>
    <section className="entity-detail__section entity-detail__section--slots"><div className="entity-detail__section-heading"><div><span>LINEUP</span><h4>套餐席位</h4></div><strong>{slots.length} 个席位</strong></div>{slots.length ? <div className="package-detail__slots">{slots.map((slot, index) => { const position = numberValue(slot.position) ?? index + 1; return <article className="package-detail__slot" aria-label={`${position} 号位`} key={textValue(slot.id) || `${index}`}><div className="package-detail__slot-index"><span>{position}</span><small>号位</small></div><div className="package-detail__slot-main"><h5>{textValue(slot.serviceDisplayName) || textValue(slot.service) || '未指定服务'}</h5><p>{[textValue(slot.gameDisplayName) || textValue(slot.game), textValue(slot.regionDisplayName) || textValue(slot.region) || '不限区服'].filter(Boolean).join(' · ')}</p><div className="package-detail__slot-meta"><span>{numberValue(slot.unitCount) ?? '—'} 个计费单位</span><span>{numberValue(slot.billingUnitMinutes) ?? '—'} 分钟 / 单位</span></div>{textValue(slot.customerNoteTemplate) && <blockquote>{textValue(slot.customerNoteTemplate)}</blockquote>}</div></article>; })}</div> : <p className="entity-detail__empty">尚未配置套餐席位。</p>}</section>
    <section className="entity-detail__section entity-detail__section--identifiers"><div className="entity-detail__section-heading"><div><span>VERSION</span><h4>版本与审计</h4></div></div><DetailFacts facts={[{ label: '稳定套餐代码', value: textValue(data.code) || '—', mono: true }, { label: '套餐版本编号', value: textValue(data.id) || '—', mono: true }, { label: '数据版本', value: scalarValue(data.version) }, { label: '状态', value: catalogStatusLabel(status) }, { label: '创建员工', value: textValue(data.createdByStaffId) || '—', mono: true }, { label: '创建时间', value: scalarValue(data.createdAt) }, { label: '激活时间', value: scalarValue(data.activatedAt) }, { label: '退役时间', value: scalarValue(data.retiredAt) }]} /></section>
  </div>;
}

function GiftCatalogDetail({ data }: { data: Record<string, unknown> }) {
  const status = textValue(data.status);
  const category = data.giftCategoryTagDetails && typeof data.giftCategoryTagDetails === 'object' ? data.giftCategoryTagDetails as Record<string, unknown> : null;
  return <div className="entity-detail gift-catalog-detail">
    <header className="entity-detail__hero"><div><span className="entity-detail__eyebrow">礼物目录版本</span><h3>{textValue(data.name) || '未命名礼物'}</h3><p>{textValue(data.code) || '—'} · 版本 {scalarValue(data.version)}</p></div>{status && <DetailStatus status={status} />}</header>
    <section className="entity-detail__price-strip" aria-label="礼物价格概览"><div><span>客户价格</span><strong>{priceValue(data.priceMinor, textValue(data.currency) || 'CAT')}</strong></div><div><span>礼物分类</span><strong>{textValue(category?.displayName) || '未分类'}</strong></div><div><span>启用状态</span><strong>{data.enabled === true ? '已启用' : data.enabled === false ? '未启用' : '—'}</strong></div></section>
    <div className="entity-detail__layout"><section className="entity-detail__section"><div className="entity-detail__section-heading"><div><span>CONTENT</span><h4>播报与分类</h4></div></div><DetailFacts facts={[{label:'礼物分类代码',value:textValue(category?.code)||'—',mono:true},{label:'分类编号',value:textValue(data.giftCategoryTagId)||'—',mono:true},{label:'播报模板',value:textValue(data.broadcastTemplate)||'—'}]} /></section>
      <section className="entity-detail__section"><div className="entity-detail__section-heading"><div><span>VERSION</span><h4>版本与审计</h4></div></div><DetailFacts facts={[{label:'礼物目录编号',value:textValue(data.id)||'—',mono:true},{label:'礼物版本编号',value:textValue(data.giftCatalogVersionId)||'—',mono:true},{label:'创建员工',value:textValue(data.createdByStaffId)||'—',mono:true},{label:'创建时间',value:scalarValue(data.createdAt)},{label:'激活时间',value:scalarValue(data.activatedAt)},{label:'退役时间',value:scalarValue(data.retiredAt)},{label:'归档时间',value:scalarValue(data.archivedAt)}]} /></section></div>
  </div>;
}

function GiftRequestDetail({ data }: { data: Record<string, unknown> }) {
  const status = textValue(data.status);
  return <div className="entity-detail gift-request-detail">
    <header className="entity-detail__hero"><div><span className="entity-detail__eyebrow">送礼审核</span><h3>礼物请求 {textValue(data.publicId) || '—'}</h3><p>{textValue(data.giftName) || '未命名礼物'} · {priceValue(data.amountMinor, textValue(data.currency) || 'CAT')}</p></div>{status && <DetailStatus status={status} />}</header>
    <section className="entity-detail__price-strip" aria-label="礼物请求概览"><div><span>来源订单</span><strong>{textValue(data.orderPublicId) || '—'}</strong></div><div><span>预留状态</span><strong>{textValue(data.reservationStatus) || '无预留'}</strong></div><div><span>播报状态</span><strong>{textValue(data.announcementStatus) || '—'}</strong></div></section>
    <div className="entity-detail__layout"><section className="entity-detail__section"><div className="entity-detail__section-heading"><div><span>PARTIES</span><h4>用户与目标陪玩</h4></div></div><DetailFacts facts={[{label:'用户',value:textValue(data.senderDisplayName)||'—',strong:true},{label:'用户 Discord',value:textValue(data.senderDiscordUsername)||textValue(data.senderDiscordUserId)||'—'},{label:'目标陪玩',value:textValue(data.receiverDisplayName)||'—',strong:true},{label:'陪玩 Discord',value:textValue(data.receiverDiscordUsername)||textValue(data.receiverDiscordUserId)||'—'},{label:'订单编号',value:textValue(data.orderId)||'—',mono:true},{label:'订单参与人编号',value:textValue(data.orderParticipantId)||'—',mono:true}]} /></section>
      <section className="entity-detail__section"><div className="entity-detail__section-heading"><div><span>REVIEW</span><h4>审核与资金</h4></div></div><DetailFacts facts={[{label:'预留编号',value:textValue(data.reservationId)||'—',mono:true},{label:'预留有效至',value:scalarValue(data.reservationExpiresAt)},{label:'核对员工',value:textValue(data.verifiedByStaffId)||'—',mono:true},{label:'核对时间',value:scalarValue(data.verifiedAt)},{label:'核对备注',value:textValue(data.verificationNote)||'—'},{label:'批准员工',value:textValue(data.approvedByStaffId)||'—',mono:true},{label:'批准时间',value:scalarValue(data.approvedAt)},{label:'捕获时间',value:scalarValue(data.capturedAt)}]} /></section></div>
    <section className="entity-detail__section"><div className="entity-detail__section-heading"><div><span>DELIVERY</span><h4>播报与生命周期</h4></div></div><DetailFacts facts={[{label:'礼物代码',value:textValue(data.giftCode)||'—',mono:true},{label:'礼物版本编号',value:textValue(data.giftCatalogVersionId)||'—',mono:true},{label:'播报模板快照',value:textValue(data.broadcastTemplate)||'—'},{label:'播报时间',value:scalarValue(data.announcedAt)},{label:'播报频道',value:textValue(data.broadcastChannelId)||'—',mono:true},{label:'播报消息',value:textValue(data.broadcastMessageId)||'—',mono:true},{label:'拒绝原因',value:textValue(data.rejectedReason)||'—'},{label:'失败代码',value:textValue(data.failureCode)||'—',mono:true},{label:'请求有效至',value:scalarValue(data.expiresAt)},{label:'撤回时间',value:scalarValue(data.withdrawnAt)},{label:'创建时间',value:scalarValue(data.createdAt)},{label:'更新时间',value:scalarValue(data.updatedAt)},{label:'数据版本',value:scalarValue(data.rowVersion)}]} /></section>
  </div>;
}

function OrderTimelineRegion(props:{data:Record<string,unknown>;pageState?:AdminBusinessDetailState['timelinePage'];transcriptState?:AdminBusinessDetailState['transcriptPage'];onNext?:(cursor:string)=>void;onNextTranscript?:(cursor:string)=>void;serviceCatalogOptions:Array<Record<string,unknown>>;participantPlayerOptions:Array<Record<string,unknown>>;mutationError?:string|null;onAdd?:(fields:Record<string,unknown>)=>void;onUpdate?:(fields:Record<string,unknown>)=>void;onUpdateOrderNote?:(fields:Record<string,unknown>)=>void;onUpdateRequirement?:(fields:Record<string,unknown>)=>void}) {
  const timeline=readAdminOrderTimeline(props.data);const order=props.data.order as Record<string,unknown>|undefined;const participantPage=props.data.participants as {items?:Array<Record<string,unknown>>;derivedTotalMinor?:unknown}|undefined;const participants=participantPage?.items??[];const requirementPage=props.data.requirements as {items?:Array<Record<string,unknown>>;derivedTotalMinor?:unknown;catalogSubtotalMinor?:unknown;packageAdjustmentMinor?:unknown}|undefined;
  const status=textValue(order?.status);const mutable=!['COMPLETED','CANCELLED'].includes(status);const operational=orderOperationalState(status);const customerName=textValue(order?.customerDisplayName)||textValue(order?.customerDiscordTag)||'客户资料待补充';const serviceSummary=textValue(order?.serviceSummary)||participants.map((participant)=>[textValue(participant.gameDisplayName),textValue(participant.serviceDisplayName)].filter(Boolean).join(' · ')).filter(Boolean).join('；')||'项目资料待补充';
  return <><section className="order-detail-summary order-operational-overview" aria-label="订单处理概览"><div className="subsection-heading"><div><span className="page-eyebrow">订单处理概览</span><h3>订单 {textValue(order?.publicId)||'—'}</h3></div><span className={`order-status order-status--${textValue(order?.status).toLowerCase()}`}>{orderStatusLabel(textValue(order?.status))}</span></div><dl className="order-operational-overview__facts"><OrderFact label="当前阻塞" value={operational.blocker}/><OrderFact label="下一步" value={operational.nextAction} strong/><OrderFact label="客户" value={customerName}/><OrderFact label="服务" value={serviceSummary}/><OrderFact label="订单金额" value={orderPrice(order??{})} strong/><OrderFact label="最近更新" value={`${formatRelativeDate(order?.updatedAt)} · ${formatOrderDate(order?.updatedAt)}`}/></dl>{textValue(order?.notes)&&<p>客户备注：{textValue(order?.notes)}</p>}</section>
    {mutable&&props.onUpdateOrderNote?<OrderNoteEditor note={textValue(order?.notes)} onSubmit={props.onUpdateOrderNote}/>:null}
    <details className="order-technical-details"><summary>技术详情与审计字段</summary><dl className="definition-list">{order&&Object.entries(order).filter(([key])=>['id','customerId','customerDiscordUserId','sourcePackageVersionId','sourcePackageCode','sourcePackageDisplayName','sourcePackageVersion','compositionMode','version','createdAt','updatedAt'].includes(key)).map(([key,value])=><div key={key}><dt><strong>{dashboardFieldLabel(key)}</strong></dt><dd>{displayValue(key,value,order.currency)}</dd></div>)}</dl></details>
    <OrderRequirementRegion requirements={requirementPage?.items??[]} derivedTotalMinor={requirementPage?.derivedTotalMinor} catalogSubtotalMinor={requirementPage?.catalogSubtotalMinor} packageAdjustmentMinor={requirementPage?.packageAdjustmentMinor} currency={typeof order?.currency==='string'?order.currency:'CAT'} onUpdate={mutable?props.onUpdateRequirement:undefined}/>
    <OrderParticipantEditor participants={participants} order={order} derivedTotalMinor={participantPage?.derivedTotalMinor} serviceCatalogOptions={props.serviceCatalogOptions} playerOptions={props.participantPlayerOptions} error={props.mutationError} onAdd={mutable?props.onAdd:undefined} onUpdate={mutable?props.onUpdate:undefined}/>
    <OrderTranscriptRegion transcript={props.data.transcript as {items?:Array<Record<string,unknown>>;nextCursor?:unknown}|undefined} state={props.transcriptState} onNext={props.onNextTranscript}/>
    <section className="subsection" aria-label="交易时间线"><h3>交易时间线</h3>
      {timeline.items.length===0?<p>暂无交易记录。</p>:<div className="table-scroll"><table className="data-table"><thead><tr><th scope="col">时间</th><th scope="col">类型</th><th scope="col">方向</th><th scope="col">金额</th><th scope="col">状态</th></tr></thead><tbody>{timeline.items.map((item)=><tr key={item.id}><td>{item.occurredAt}</td><td>{item.type}</td><td>{item.direction}</td><td>{item.amountMinor===null?'—':displayValue('amountMinor',item.amountMinor,item.currency)}</td><td>{item.status}</td></tr>)}</tbody></table></div>}
      {props.pageState?.kind==='ERROR'&&<p role="alert">后续交易记录暂时无法载入。{props.pageState.requestId?` request_id: ${props.pageState.requestId}`:''}</p>}
      {timeline.nextCursor&&<button type="button" disabled={props.pageState?.kind==='LOADING'} onClick={()=>props.onNext?.(timeline.nextCursor!)}>加载更多记录</button>}
    </section></>;
}

function OrderTranscriptRegion({transcript,state,onNext}:{transcript?:{items?:Array<Record<string,unknown>>;nextCursor?:unknown};state?:AdminBusinessDetailState['transcriptPage'];onNext?:(cursor:string)=>void}){const items=transcript?.items??[];return <section className="subsection order-transcript" aria-label="订单频道记录"><div className="subsection-heading"><div><h3>订单频道记录（只读）</h3><p>用于核对客服上下文；后台不提供任何 Discord 消息写入操作。</p></div></div>{state?.kind==='ERROR'?<p role="alert">频道记录暂时无法载入。{state.requestId?` request_id: ${state.requestId}`:''}</p>:items.length===0?<p>暂无已采集的频道记录。</p>:<ol className="transcript-list">{items.map((item,index)=><li key={`${textValue(item.eventId)}-${index}`}><header><strong>{textValue(item.authorDisplayName)||'未知成员'}</strong><time>{formatOrderDate(item.occurredAt)}</time><span>{item.eventType==='UPDATED'?'已编辑':item.eventType==='DELETED'?'已删除':'消息'}</span></header><p>{item.deleted?'[消息已删除]':textValue(item.content)||'[无文字内容]'}</p>{Array.isArray(item.attachmentMetadata)&&item.attachmentMetadata.length>0&&<small>附件 {item.attachmentMetadata.length} 个</small>}{textValue(item.replyToMessageId)&&<small>回复消息 {textValue(item.replyToMessageId)}</small>}</li>)}</ol>}{typeof transcript?.nextCursor==='string'&&<button type="button" disabled={state?.kind==='LOADING'} onClick={()=>onNext?.(transcript.nextCursor as string)}>加载更多频道记录</button>}</section>;}

function OrderNoteEditor({note,onSubmit}:{note:string;onSubmit:(fields:Record<string,unknown>)=>void}){return <details className="advanced-order-action"><summary>编辑订单备注</summary><form className="participant-inline-form" onSubmit={(event)=>{event.preventDefault();onSubmit(formRecord(event.currentTarget));}}><label><span>当前订单备注（留空即清除）</span><textarea name="note" maxLength={1000} defaultValue={note}/></label><label><span>原因码</span><input name="reasonCode" defaultValue="SUPPORT_CORRECTION" pattern="[A-Z0-9_]{3,100}" required/></label><button type="submit">保存订单备注</button></form></details>;}

function OrderRequirementRegion({requirements,derivedTotalMinor,catalogSubtotalMinor,packageAdjustmentMinor,currency,onUpdate}:{requirements:Array<Record<string,unknown>>;derivedTotalMinor:unknown;catalogSubtotalMinor:unknown;packageAdjustmentMinor:unknown;currency:string;onUpdate?:(fields:Record<string,unknown>)=>void}){
  const active=requirements.filter((item)=>item.status!=='REMOVED');
  return <section className="subsection order-requirements" aria-label="订单项目需求"><div className="subsection-heading"><div><h3>项目需求</h3><p>老板提交的项目、时长与陪玩名额；实际接单人员在下方逐条对应。</p>{typeof packageAdjustmentMinor==='number'&&packageAdjustmentMinor!==0&&<p>目录原价 {typeof catalogSubtotalMinor==='number'?formatMinorCurrency(catalogSubtotalMinor,currency):'—'} · 套餐调整 {formatMinorCurrency(packageAdjustmentMinor,currency)}</p>}</div><strong>报价 {typeof derivedTotalMinor==='number'?formatMinorCurrency(derivedTotalMinor,currency):'—'}</strong></div>{active.length===0?<p>尚未添加项目需求。</p>:<div className="requirement-card-grid">{active.map((item)=>{const requested=Number(item.requestedPlayerCount??0);const filled=Number(item.filledPlayerCount??0);const remaining=Math.max(0,requested-filled);return <article className="requirement-detail-card" key={String(item.id)}><header><div><span>{String(item.regionDisplayName??item.region??'不限区服')}</span><h4>{String(item.gameDisplayName??item.game??'未指定游戏')} · {String(item.serviceDisplayName??item.service??'未指定服务')}</h4></div><span>{remaining===0?'名额已满':`还差 ${remaining} 位`}</span></header><dl><OrderFact label="需求编号" value={String(item.id??'—')}/><OrderFact label="套餐席位编号" value={String(item.sourcePackageSlotId??'自由搭配')}/><OrderFact label="服务目录版本" value={String(item.serviceCatalogVersionId??'—')}/><OrderFact label="席位偏好" value={textValue(item.customerNote)||'未填写'}/><OrderFact label="计费" value={`${String(item.unitCount??'—')} 单位 · ${String(item.billingUnitMinutes??'—')} 分钟/单位`}/><OrderFact label="所需人数" value={`${requested} 位`}/><OrderFact label="已接单" value={`${filled} 位`}/><OrderFact label="项目小计" value={typeof item.estimatedLinePriceMinor==='number'?formatMinorCurrency(item.estimatedLinePriceMinor,currency):'—'} strong/></dl>{onUpdate?<details className="advanced-order-action"><summary>编辑席位备注</summary><form className="participant-inline-form" onSubmit={(event)=>{event.preventDefault();onUpdate({...formRecord(event.currentTarget),requirementId:item.id,expectedRequirementVersion:item.version});}}><label><span>席位备注（留空即清除）</span><textarea name="customerNote" maxLength={500} defaultValue={String(item.customerNote??'')}/></label><label><span>原因码</span><input name="reasonCode" defaultValue="SUPPORT_CORRECTION" pattern="[A-Z0-9_]{3,100}" required/></label><button type="submit">保存席位备注</button></form></details>:null}</article>;})}</div>}</section>;
}

function OrderParticipantEditor(props:{participants:Array<Record<string,unknown>>;order?:Record<string,unknown>;derivedTotalMinor:unknown;serviceCatalogOptions:Array<Record<string,unknown>>;playerOptions:Array<Record<string,unknown>>;error?:string|null;onAdd?:(fields:Record<string,unknown>)=>void;onUpdate?:(fields:Record<string,unknown>)=>void}){
  const[editing,setEditing]=useState<string|null>(null);const currency=typeof props.order?.currency==='string'?props.order.currency:'CAT';
  return <section className="subsection order-participant-editor" aria-label="订单陪玩与项目"><div className="subsection-heading"><div><h3>陪玩与项目</h3><p>每位陪玩独立绑定项目、计费数量、价格和分成。</p></div><strong>合计 {typeof props.derivedTotalMinor==='number'?formatMinorCurrency(props.derivedTotalMinor,currency):'—'}</strong></div>
    {props.participants.length===0?<p>尚未添加陪玩明细。</p>:<div className="participant-card-grid">{props.participants.map((participant)=>{const participantId=String(participant.id);const editKey=`EDIT:${participantId}`;const reassignKey=`REASSIGN:${participantId}`;return <article className={`participant-detail-card participant-detail-card--${String(participant.status??'').toLowerCase()}`} key={participantId}><header><div><span>{String(participant.displayName??'未命名陪玩')}</span><h4>{String(participant.gameDisplayName??participant.game??'未指定游戏')} · {String(participant.serviceDisplayName??participant.service??'未指定服务')}</h4></div><span>{participant.status==='REMOVED'?'已移除':participant.readiness==='READY'?'已就绪':'未就绪'}</span></header><dl><OrderFact label="Discord Tag" value={String(participant.discordTag??'—')}/><OrderFact label="Discord 用户 ID" value={String(participant.discordUserId??'—')}/><OrderFact label="陪玩 ID" value={String(participant.playerId??'—')}/><OrderFact label="需求编号" value={String(participant.orderRequirementId??'人工添加')}/><OrderFact label="服务目录版本" value={String(participant.serviceCatalogVersionId??'—')}/><OrderFact label="区服" value={String(participant.regionDisplayName??participant.region??'不限')}/><OrderFact label="计费" value={`${String(participant.unitCount??'—')} 单位 · ${String(participant.billingUnitMinutes??'—')} 分钟/单位`}/><OrderFact label="客户价格" value={typeof participant.linePriceMinor==='number'?formatMinorCurrency(participant.linePriceMinor,currency):'—'} strong/><OrderFact label="陪玩分成" value={compensationLabel(participant,currency)}/><OrderFact label="预计收益" value={typeof participant.expectedEarningMinor==='number'?formatMinorCurrency(participant.expectedEarningMinor,currency):'—'} strong/><OrderFact label="明细版本" value={String(participant.version??'—')}/></dl>{participant.status==='ACTIVE'&&props.onUpdate?<div className="participant-card-actions"><button type="button" onClick={()=>setEditing(editing===editKey?null:editKey)}>{editing===editKey?'收起编辑':'编辑明细'}</button><button type="button" onClick={()=>setEditing(editing===reassignKey?null:reassignKey)}>{editing===reassignKey?'收起改派':'改派陪玩'}</button></div>:null}{(editing===editKey||editing===reassignKey)&&<ParticipantUpdateForm key={editing} initialAction={editing===reassignKey?'REASSIGN':'CHANGE_PRICE'} participant={participant} catalogs={props.serviceCatalogOptions} players={props.playerOptions} onSubmit={(fields)=>props.onUpdate?.({...fields,participantId:participant.id,expectedParticipantVersion:participant.version})}/>}</article>;})}</div>}
    {props.error&&<p className="form-message form-message--error" role="alert">{props.error}</p>}
    {props.onAdd&&<ParticipantAddForm players={props.playerOptions} catalogs={props.serviceCatalogOptions} onSubmit={props.onAdd}/>}</section>;
}

function ParticipantAddForm(props:{players:Array<Record<string,unknown>>;catalogs:Array<Record<string,unknown>>;onSubmit:(fields:Record<string,unknown>)=>void}){return <details className="advanced-order-action"><summary>高级操作：添加陪玩明细</summary><form className="participant-inline-form" onSubmit={(event)=>{event.preventDefault();props.onSubmit(formRecord(event.currentTarget));}}><input type="hidden" name="reasonCode" value="ADD_ORDER_PLAYER"/><label><span>陪玩</span><select name="playerId" required><option value="">请选择</option>{props.players.map((player)=><option key={String(player.playerId)} value={String(player.playerId)}>{String(player.displayName??player.discordTag??player.playerId)}</option>)}</select></label><CatalogSelect catalogs={props.catalogs}/><label><span>计费单位数</span><input name="unitCount" type="number" min="1" required/></label><label><span>明细价格（CAT 最小单位）</span><input name="linePriceMinor" type="number" min="1" required/></label><button className="button-primary" type="submit">添加陪玩</button></form></details>;}
function ParticipantUpdateForm(props:{participant:Record<string,unknown>;catalogs:Array<Record<string,unknown>>;players:Array<Record<string,unknown>>;initialAction:'CHANGE_PRICE'|'REASSIGN';onSubmit:(fields:Record<string,unknown>)=>void}){const[action,setAction]=useState<'CHANGE_PRICE'|'CHANGE_PROJECT'|'REASSIGN'|'REMOVE'>(props.initialAction);return <form className="participant-inline-form" onSubmit={(event)=>{event.preventDefault();props.onSubmit(formRecord(event.currentTarget));}}><label><span>操作</span><select name="action" value={action} onChange={(event)=>setAction(event.currentTarget.value as typeof action)}><option value="CHANGE_PRICE">修改价格</option><option value="CHANGE_PROJECT">更换项目</option><option value="REASSIGN">改派陪玩</option><option value="REMOVE">移除陪玩</option></select></label>{action==='REASSIGN'?<label><span>新陪玩</span><select name="playerId" required><option value="">请选择</option>{props.players.map((player)=><option key={String(player.playerId)} value={String(player.playerId)}>{String(player.displayName??player.discordTag??player.playerId)}</option>)}</select></label>:null}{action==='CHANGE_PROJECT'?<><CatalogSelect catalogs={props.catalogs} defaultValue={String(props.participant.serviceCatalogVersionId??'')}/><label><span>计费单位数</span><input name="unitCount" type="number" min="1" defaultValue={Number(props.participant.unitCount??1)}/></label></>:null}{action==='CHANGE_PROJECT'||action==='CHANGE_PRICE'?<label><span>明细价格</span><input name="linePriceMinor" type="number" min="1" defaultValue={Number(props.participant.linePriceMinor??1)}/></label>:null}<label><span>原因码</span><input key={action} name="reasonCode" defaultValue={action==='REASSIGN'?'PLAYER_UNAVAILABLE':'UPDATE_ORDER_PLAYER'} pattern="[A-Z0-9_]{3,100}" required/></label><button type="submit">保存明细</button></form>;}
function CatalogSelect({catalogs,defaultValue}:{catalogs:Array<Record<string,unknown>>;defaultValue?:string}){return <label><span>服务项目</span><select name="serviceCatalogVersionId" required defaultValue={defaultValue??''}><option value="">请选择</option>{catalogs.map((catalog)=><option key={String(catalog.id)} value={String(catalog.id)}>{`${String(catalog.gameDisplayName??catalog.game)} · ${String(catalog.serviceDisplayName??catalog.service)}${catalog.regionDisplayName?` · ${String(catalog.regionDisplayName)}`:''}`}</option>)}</select></label>;}
function formRecord(form:HTMLFormElement){return Object.fromEntries(Array.from(new FormData(form).entries()).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));}
function compensationLabel(participant:Record<string,unknown>,currency:string){if(participant.compensationType==='PERCENT_BPS'&&typeof participant.compensationValue==='number')return `${(participant.compensationValue/100).toFixed(2)}% · ${participant.compensationSource==='PLAYER_OVERRIDE'?'个人规则':'项目默认'}`;if(typeof participant.compensationValue==='number')return `${formatMinorCurrency(participant.compensationValue,currency)}/单位 · ${participant.compensationSource==='PLAYER_OVERRIDE'?'个人规则':'项目默认'}`;return '—';}

function UserConsumptionRegion(props: { consumptions: NonNullable<AdminBusinessDetailState['consumptions']>; onNext?: (cursor: string) => void }) {
  const { consumptions } = props;
  return <section className="subsection" aria-label="消费记录">
    <h3>消费记录</h3>
    {consumptions.kind === 'LOADING' && <p aria-busy="true">正在载入消费记录...</p>}
    {consumptions.kind === 'ERROR' && <p role="alert">消费记录暂时无法载入。{consumptions.requestId ? ` request_id: ${consumptions.requestId}` : ''}</p>}
    {consumptions.kind === 'EMPTY' && <p>暂无消费记录。</p>}
    {consumptions.items.length > 0 && <div className="table-scroll"><table className="data-table"><thead><tr><th scope="col">类型</th><th scope="col">金额</th><th scope="col">状态</th></tr></thead><tbody>{consumptions.items.map((item, index) => <tr key={typeof item.id === 'string' ? item.id : index}><td>{displayValue('type', item.type, item.currency)}</td><td>{displayValue('amountMinor', item.amountMinor, item.currency)}</td><td>{displayValue('status', item.status, item.currency)}</td></tr>)}</tbody></table></div>}
    {consumptions.nextCursor && <button type="button" disabled={consumptions.kind === 'LOADING'} onClick={() => props.onNext?.(consumptions.nextCursor!)}>加载更多消费记录</button>}
  </section>;
}

function submitFilters(event: FormEvent<HTMLFormElement>, onFilter?: (filters: Record<string, string>) => void): void {
  event.preventDefault();
  const values: Record<string, string> = {};
  for (const [key, value] of new FormData(event.currentTarget).entries()) {
    if (typeof value === 'string' && value.trim()) values[key] = value.trim();
  }
  onFilter?.(values);
}

function displayValue(column: string, value: unknown, currency: unknown, tags?: BusinessTagGroups): string {
  if (column.endsWith('Minor') && typeof value === 'number' && typeof currency === 'string') return formatMinorCurrency(value, currency);
  if (column === 'status' && typeof value === 'string') return orderStatusLabel(value);
  if (value === null || value === undefined) return '-';
  const tagType = column === 'gameTags' ? 'GAME' : column === 'serviceTags' ? 'SERVICE' : column === 'languageTags' ? 'LANGUAGE' : null;
  if (tagType && Array.isArray(value)) {
    const names = new Map((tags?.[tagType] ?? []).map((tag) => [tag.code, tag.displayName]));
    return value.map((code) => names.get(String(code)) ?? String(code)).join(', ');
  }
  if (Array.isArray(value)) return value.map((item) => typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
