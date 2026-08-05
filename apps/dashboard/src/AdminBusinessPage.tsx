import { type FormEvent } from 'react';
import {
  adminCollectionConfigs,
  isAdminCollectionPage,
  type AdminBusinessAction,
  type AdminBusinessDetailState,
  type AdminBusinessPageModel,
  type AdminCollectionView,
  type AdminSortDirection
} from './admin-business.js';
import { AdminBusinessActionPanel } from './AdminBusinessActionPanel.js';
import { AdminBusinessDetail } from './AdminBusinessDetail.js';
import { DashboardOverlay } from './DashboardOverlay.js';
import {
  catalogStatusLabel,
  compactIdentifier,
  displayValue,
  formatOrderDate,
  formatRelativeDate,
  numberValue,
  orderBillingSummary,
  orderOperationalState,
  orderPrice,
  orderStatusLabel,
  OrderFact,
  playerStatusLabel,
  priceValue,
  scalarValue,
  textValue
} from './admin-business-presenters.js';
import type { BusinessTagGroups } from './business-tags.js';
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
        <div className="state-card state-card--error" role="alert"><p>数据暂时无法载入。{model.requestId ? ` 请求编号：${model.requestId}` : ''}</p><button type="button" onClick={props.onRetry}>重试</button></div>
      )}
      {model.kind === 'EMPTY' && <div className="state-card"><p>当前筛选下没有记录。</p><button type="button" onClick={props.onClearFilters}>清除筛选</button></div>}
      {model.kind === 'READY' && (collectionConfig?(view==='TABLE'?<AdminBusinessTable model={model} columns={collectionConfig.columns} onAction={props.onAction} onOpenDetail={props.onOpenDetail} businessTagOptions={props.businessTagOptions}/>:model.page==='orders'?<OrderDiscussionGrid model={model} onAction={props.onAction} onOpenDetail={props.onOpenDetail}/>:<BusinessDiscussionGrid model={model} onAction={props.onAction} onOpenDetail={props.onOpenDetail}/>):<AdminBusinessTable model={model} columns={[]} onAction={props.onAction} onOpenDetail={props.onOpenDetail} businessTagOptions={props.businessTagOptions}/>)}

      {props.detail && <DashboardOverlay label="业务对象详情" onClose={props.onCloseDetail}><AdminBusinessDetail detail={props.detail} onClose={props.onCloseDetail} onNextConsumptions={props.onNextConsumptions} onNextTimeline={props.onNextTimeline} onNextTranscript={props.onNextTranscript} serviceCatalogOptions={props.serviceCatalogOptions} participantPlayerOptions={props.participantPlayerOptions} participantMutationError={props.participantMutationError} onAddOrderParticipant={props.onAddOrderParticipant} onUpdateOrderParticipant={props.onUpdateOrderParticipant} onUpdateOrderNote={props.onUpdateOrderNote} onUpdateOrderRequirement={props.onUpdateOrderRequirement} /></DashboardOverlay>}
      {props.activeAction && <DashboardOverlay label={`${props.activeAction.action.label}操作`} onClose={props.onCancelAction}><AdminBusinessActionPanel active={props.activeAction} status={props.actionStatus ?? 'IDLE'} error={props.actionError} businessTagOptions={props.businessTagOptions} serviceCatalogOptions={props.serviceCatalogOptions}
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

function submitFilters(event: FormEvent<HTMLFormElement>, onFilter?: (filters: Record<string, string>) => void): void {
  event.preventDefault();
  const values: Record<string, string> = {};
  for (const [key, value] of new FormData(event.currentTarget).entries()) {
    if (typeof value === 'string' && value.trim()) values[key] = value.trim();
  }
  onFilter?.(values);
}
