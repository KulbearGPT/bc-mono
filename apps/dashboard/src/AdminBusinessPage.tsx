import { useState, type FormEvent, type ReactNode } from 'react';
import type { AdminBusinessAction, AdminBusinessDetailState, AdminBusinessPageModel } from './admin-business.js';
import { formatMinorCurrency, readAdminOrderTimeline } from './admin-business.js';
import type { BusinessTagGroups, BusinessTagRecord } from './business-tags.js';
import { dashboardFieldLabel } from './table-labels.js';

export function AdminBusinessPage(props: {
  model: AdminBusinessPageModel;
  onRetry?: () => void;
  onClearFilters?: () => void;
  onNextPage?: (cursor: string) => void;
  onFilter?: (filters: Record<string, string>) => void;
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
  businessTagOptions?: BusinessTagGroups;
  serviceCatalogOptions?: Array<Record<string, unknown>>;
  dispatchCandidateOptions?: Array<Record<string, unknown>>;
}) {
  const { model } = props;
  if (model.kind === 'FORBIDDEN') {
    return <section className="dashboard-page" aria-labelledby="admin-page-title"><header className="page-heading"><div><span className="page-eyebrow">BUSINESS OPS</span><h1 id="admin-page-title">无权访问</h1><p>当前账号缺少此工作区所需权限：{model.requiredPermission}</p></div></header></section>;
  }

  return (
    <section className="dashboard-page" aria-labelledby="admin-page-title">
      <header className="page-heading">
        <div><span className="page-eyebrow">BUSINESS OPS</span><h1 id="admin-page-title">{model.title}</h1><p>查看业务事实并执行当前权限范围内的操作。</p></div>
        <div className="page-actions">
          {props.onAction && model.actions.filter((action) => action.scope === 'COLLECTION').map((action) => (
            <button className="button-primary" key={action.id} type="button" onClick={() => props.onAction?.(action)}>{action.label}</button>
          ))}
        </div>
      </header>

      {model.filters.length > 0 && (
        <form className="content-panel filter-bar" aria-label="列表筛选" onSubmit={(event) => submitFilters(event, props.onFilter)}>
          {model.filters.map((filter) => <input key={filter.id} name={filter.id} aria-label={filter.label} placeholder={filter.label} />)}
          <button className="button-primary" type="submit">筛选</button>
          <button type="button" onClick={props.onClearFilters}>清除</button>
        </form>
      )}

      {model.kind === 'LOADING' && <div className="state-card" aria-busy="true">正在载入...</div>}
      {model.kind === 'ERROR' && (
        <div className="state-card state-card--error" role="alert"><p>数据暂时无法载入。{model.requestId ? ` request_id: ${model.requestId}` : ''}</p><button type="button" onClick={props.onRetry}>重试</button></div>
      )}
      {model.kind === 'EMPTY' && <div className="state-card"><p>当前筛选下没有记录。</p><button type="button" onClick={props.onClearFilters}>清除筛选</button></div>}
      {model.kind === 'READY' && <AdminBusinessTable model={model} onAction={props.onAction} onOpenDetail={props.onOpenDetail} businessTagOptions={props.businessTagOptions} />}

      {props.detail && <AdminDetailRegion detail={props.detail} onClose={props.onCloseDetail} onNextConsumptions={props.onNextConsumptions} onNextTimeline={props.onNextTimeline} />}
       {props.activeAction && <AdminActionPanel active={props.activeAction} status={props.actionStatus ?? 'IDLE'} error={props.actionError} businessTagOptions={props.businessTagOptions} serviceCatalogOptions={props.serviceCatalogOptions} dispatchCandidateOptions={props.dispatchCandidateOptions}
        onCancel={props.onCancelAction} onSubmit={props.onSubmitAction} />}

      {model.pagination.hasNext && model.pagination.nextCursor && (
        <div className="pagination-bar"><button type="button" onClick={() => props.onNextPage?.(model.pagination.nextCursor!)}>下一页</button></div>
      )}
    </section>
  );
}

function AdminBusinessTable(props: {
  model: AdminBusinessPageModel;
  onAction?: (action: AdminBusinessAction, item?: Record<string, unknown>) => void;
  onOpenDetail?: (item: Record<string, unknown>) => void;
  businessTagOptions?: BusinessTagGroups;
}) {
  const columns = collectColumns(props.model.items);
  const itemActions = props.onAction ? props.model.actions.filter((action) => action.scope === 'ITEM') : [];
  const hasDetail = Boolean(props.onOpenDetail) && ['orders', 'users', 'players', 'giftRequests'].includes(props.model.page);
  const hasOperations = itemActions.length > 0 || hasDetail;
  return (
    <div className="table-scroll content-panel content-panel--flush">
      <table className="data-table">
        <thead><tr>{hasOperations && <th className="data-column--actions" scope="col" title="actions">操作</th>}{columns.map((column) => <th className={column.toLowerCase() === 'id' ? 'data-column--id' : undefined} key={column} scope="col" title={column}>{dashboardFieldLabel(column)}</th>)}</tr></thead>
        <tbody>{props.model.items.map((item, index) => (
          <tr key={typeof item.id === 'string' ? item.id : index}>
            {hasOperations && <td className="table-actions">
              <div className="table-actions__group">
                {hasDetail && <button type="button" onClick={() => props.onOpenDetail?.(item)}>查看详情</button>}
                {itemActions.filter((action)=>playerActionApplies(action,item)).map((action) => <button className={action.id.startsWith('ARCHIVE_')?'table-action--danger':undefined} key={action.id} type="button" onClick={() => props.onAction?.(action, item)}>{action.label}</button>)}
              </div>
            </td>}
            {columns.map((column) => <td className={column.toLowerCase() === 'id' ? 'data-column--id' : undefined} key={column}>{displayValue(column, item[column], item.currency, props.businessTagOptions)}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function playerActionApplies(action:AdminBusinessAction,item:Record<string,unknown>):boolean{if(action.id==='MANUAL_DISPATCH')return item.status==='PENDING_DISPATCH';if(action.id==='APPROVE_COMPANION'||action.id==='REJECT_COMPANION')return item.reviewStatus==='PENDING_REVIEW';if(action.id==='EDIT_COMPANION_TAGS')return item.reviewStatus!=='PENDING_REVIEW'&&item.reviewStatus!=='REJECTED';return true;}

function AdminActionPanel(props: {
  active: { action: AdminBusinessAction; item?: Record<string, unknown> };
  status: 'IDLE' | 'SUBMITTING' | 'ERROR';
  error?: string | null;
  onCancel?: () => void;
  onSubmit?: (action: AdminBusinessAction, item: Record<string, unknown> | undefined, fields: Record<string, string | boolean>) => void;
  businessTagOptions?: BusinessTagGroups;
  serviceCatalogOptions?: Array<Record<string, unknown>>;
  dispatchCandidateOptions?: Array<Record<string, unknown>>;
}) {
  const action = props.active.action;
  return (
    <aside className="action-panel" aria-label={`${action.label}操作面板`}>
      <div className="panel-heading"><div><span className="page-eyebrow">ACTION</span><h2>{action.label}</h2></div><button type="button" disabled={props.status === 'SUBMITTING'} onClick={props.onCancel}>关闭</button></div>
      <form className="form-grid" aria-label={`${action.label}操作表单`} onSubmit={(event) => submitAction(event, props)}>
        <ActionFields action={action} item={props.active.item} businessTagOptions={props.businessTagOptions} serviceCatalogOptions={props.serviceCatalogOptions} dispatchCandidateOptions={props.dispatchCandidateOptions} />
        {action.requiresReason && <label className="field"><span>原因码</span><input name="reasonCode" required pattern="[A-Z0-9_]{3,100}" placeholder="OPERATIONS_DECISION" /></label>}
        {props.error && <p className="form-message form-message--error" role="alert">{props.error}</p>}
        <div className="form-actions">
          <button className="button-primary" type="submit" disabled={props.status === 'SUBMITTING'}>{props.status === 'SUBMITTING' ? '提交中...' : '提交'}</button>
          <button type="button" disabled={props.status === 'SUBMITTING'} onClick={props.onCancel}>取消</button>
        </div>
      </form>
    </aside>
  );
}

function ActionFields({ action, item, businessTagOptions, serviceCatalogOptions, dispatchCandidateOptions }: { action: AdminBusinessAction; item?:Record<string,unknown>; businessTagOptions?: BusinessTagGroups;serviceCatalogOptions?:Array<Record<string,unknown>>;dispatchCandidateOptions?:Array<Record<string,unknown>> }) {
  if(action.id==='MANUAL_DISPATCH')return <ManualDispatchFields candidates={dispatchCandidateOptions??[]}/>;
  if(action.id==='APPROVE_COMPANION')return <><TagSelect name="gameTagIds" label="支持游戏" items={businessTagOptions?.GAME??[]} multiple/><TagSelect name="serviceTagIds" label="支持服务/种类" items={businessTagOptions?.SERVICE??[]} multiple/><TagSelect name="languageTagIds" label="服务语言（可选）" items={businessTagOptions?.LANGUAGE??[]} multiple required={false}/></>;
  if(action.id==='EDIT_COMPANION_TAGS')return <><TagSelect name="gameTagIds" label="支持游戏" items={businessTagOptions?.GAME??[]} multiple selectedCodes={stringList(item?.gameTags)}/><TagSelect name="serviceTagIds" label="支持服务/种类" items={businessTagOptions?.SERVICE??[]} multiple selectedCodes={stringList(item?.serviceTags)}/><TagSelect name="languageTagIds" label="服务语言（可选）" items={businessTagOptions?.LANGUAGE??[]} multiple required={false} selectedCodes={stringList(item?.languageTags)}/></>;
  if(action.id==='EDIT_PLAYER_COMPENSATION')return <PlayerCompensationFields offerings={serviceCatalogOptions??[]}/>;
  if(action.id==='REJECT_COMPANION')return <label className="field field--full"><span>拒绝说明</span><textarea name="note" required rows={4} maxLength={1000}/></label>;
  if (action.id === 'SET_OPERATIONAL_STATUS') return <>
    <label className="field"><span>目标状态</span><select name="status" required defaultValue="PAUSED"><option value="ACTIVE">恢复</option><option value="PAUSED">暂停</option><option value="SUSPENDED">停用</option></select></label>
    <label className="field field--full"><span>处理说明</span><textarea name="note" rows={3} maxLength={1000} /></label>
  </>;
  if (action.id === 'CREATE_GIFT') return <GiftCatalogFields options={businessTagOptions}/>;
  if (action.id === 'CREATE_SERVICE_VERSION') return <ServiceCatalogFields options={businessTagOptions}/>;
  if (action.id === 'UPDATE_GIFT_VERSION') return <VersionActionFields action={action} replacementAction="CREATE_REPLACEMENT_VERSION" replacementFields={<GiftCatalogFields options={businessTagOptions} item={item}/>} />;
  if (action.id === 'UPDATE_VERSION') return <VersionActionFields action={action} replacementAction="SUPERSEDE" replacementFields={<ServiceCatalogFields options={businessTagOptions} item={item}/>} />;
  if(action.id==='ARCHIVE_SERVICE'||action.id==='ARCHIVE_GIFT')return <div className="field field--full archive-warning"><strong>确认从目录中删除？</strong><p>该操作会归档当前项目，使其不再出现在目录中；历史订单、礼物记录和金额快照不会受到影响。</p></div>;
  if (action.id === 'CREATE_RISK_EVENT') return <>
    <label className="field"><span>事件类型</span><select name="type" required defaultValue="PAYMENT_ANOMALY"><option value="PAYMENT_ANOMALY">支付异常</option><option value="DUPLICATE_ACCOUNT_SIGNAL">重复账号信号</option><option value="REFERRAL_ABUSE_SIGNAL">返佣滥用信号</option><option value="PLAYER_NO_SHOW">陪玩未到场</option><option value="CUSTOMER_NO_SHOW">用户未到场</option></select></label>
    <label className="field"><span>严重程度</span><select name="severity" required defaultValue="MEDIUM"><option value="LOW">低</option><option value="MEDIUM">中</option><option value="HIGH">高</option></select></label>
    <label className="field"><span>来源</span><select name="source" required defaultValue="STAFF_REVIEW"><option value="STAFF_REVIEW">员工复核</option><option value="CUSTOMER_REPORT">用户反馈</option><option value="PLAYER_REPORT">陪玩反馈</option><option value="SYSTEM_SIGNAL">系统信号</option></select></label>
    <label className="field"><span>关联订单 ID（可选）</span><input name="orderId" maxLength={100} /></label>
    <label className="field field--full"><span>说明</span><textarea name="notes" required rows={4} maxLength={2000} /></label>
  </>;
  return null;
}

function ManualDispatchFields({candidates}:{candidates:Array<Record<string,unknown>>}){const[selected,setSelected]=useState<string[]>([]);return <fieldset className="field field--full tag-checklist"><legend>选择派单范围（最多 3 人）</legend><p className="field-help">不勾选时发送给全部当前合格陪玩；勾选后仅通知指定人选。</p>{candidates.length===0?<p>当前没有符合订单要求且在线可接单的陪玩。</p>:candidates.map((candidate)=>{const id=textValue(candidate.discordUserId);const checked=selected.includes(id);return <label className="checkbox-field" key={id}><input type="checkbox" name="targetDiscordUserIds" value={id} checked={checked} disabled={!checked&&selected.length>=3} onChange={()=>setSelected((current)=>checked?current.filter((value)=>value!==id):[...current,id])}/><span>{`陪玩 ${textValue(candidate.playerId).slice(0,8)} · Discord ${id}`}</span></label>;})}<p className="field-help">已选 {selected.length}/3</p></fieldset>}

function PlayerCompensationFields({offerings}:{offerings:Array<Record<string,unknown>>}){const[selected,setSelected]=useState('');const selectedOffering=offerings.find((item)=>item.serviceOfferingId===selected);const rule=selectedOffering?.compensationRule as Record<string,unknown>|undefined;const[type,setType]=useState('PERCENT_BPS');return <>
    <label className="field field--full"><span>陪玩项目</span><select name="serviceOfferingId" required value={selected} onChange={(event)=>{const value=event.currentTarget.value;setSelected(value);const next=offerings.find((item)=>item.serviceOfferingId===value)?.compensationRule as Record<string,unknown>|undefined;setType(textValue(next?.type)||'PERCENT_BPS');}}><option value="" disabled>请选择项目</option>{offerings.map((item)=><option key={textValue(item.serviceOfferingId)} value={textValue(item.serviceOfferingId)}>{[item.gameDisplayName??item.game,item.serviceDisplayName??item.service,item.regionDisplayName??item.region].filter(Boolean).join(' · ')}</option>)}</select></label>
  <input type="hidden" name="compensationVersion" value={typeof rule?.version==='number'?rule.version:''}/>
  <label className="field"><span>分成方式</span><select name="compensationType" value={type} onChange={(event)=>setType(event.currentTarget.value)}><option value="PERCENT_BPS">按客户价格比例</option><option value="FIXED_MINOR">每计费单位固定金额</option></select></label>
  {type==='PERCENT_BPS'?<label className="field"><span>分成比例（%）</span><input key={`${selected}:percent`} name="percentage" type="number" required min="0.01" max="100" step="0.01" placeholder="例如 60" defaultValue={rule?.type==='PERCENT_BPS'&&typeof rule.value==='number'?rule.value/100:undefined}/></label>:<label className="field"><span>每单位固定收益（minor units）</span><input key={`${selected}:fixed`} name="fixedAmountMinor" type="number" required min="1" step="1" defaultValue={rule?.type==='FIXED_MINOR'&&typeof rule.value==='number'?rule.value:undefined}/></label>}
  <p className="field-help field--full">个人设置优先；未设置时使用服务项目的默认分成。修改不会追溯已接单订单。</p>
</>}

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

function TagSelect(props:{name:string;label:string;items:BusinessTagRecord[];multiple?:boolean;required?:boolean;selectedCodes?:string[];selectedValue?:string}){if(props.multiple)return <fieldset className="field tag-checklist"><legend>{props.label}</legend>{props.items.map((item)=><label className="checkbox-field" key={item.id}><input type="checkbox" name={props.name} value={item.id} defaultChecked={props.selectedCodes?.includes(item.code)}/><span>{item.displayName} · {item.code}</span></label>)}</fieldset>;const selected=props.selectedValue||props.items.find((item)=>props.selectedCodes?.includes(item.code))?.id||'';return <label className="field"><span>{props.label}</span><select name={props.name} required={props.required??true} defaultValue={selected}><option value="" disabled={props.required??true}>请选择</option>{props.items.map((item)=><option key={item.id} value={item.id}>{item.displayName} · {item.code}</option>)}</select></label>}
function stringList(value:unknown):string[]{return Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[];}
function textValue(value:unknown):string{return typeof value==='string'?value:'';}
function numberValue(value:unknown):number|undefined{return typeof value==='number'&&Number.isFinite(value)?value:undefined;}

function VersionActionFields(props: { action: AdminBusinessAction; replacementAction: string; replacementFields: ReactNode }) {
  const [action, setAction] = useState(props.replacementAction);
  return <>
    <label className="field"><span>操作</span><select name="action" required value={action} onChange={(event) => setAction(event.currentTarget.value)}><option value={props.replacementAction}>保存修改（创建新版本）</option><option value="ENABLE">启用</option><option value="DISABLE">停用</option></select></label>
    {action === props.replacementAction && props.replacementFields}
  </>;
}

function submitAction(event: FormEvent<HTMLFormElement>, props: Parameters<typeof AdminActionPanel>[0]): void {
  event.preventDefault();
  const fields: Record<string, string | boolean> = {};
  for (const [key, value] of new FormData(event.currentTarget).entries()) {
    if (typeof value === 'string') fields[key] = typeof fields[key] === 'string' ? `${fields[key]},${value}` : value;
  }
  const enabled = event.currentTarget.elements.namedItem('enabled');
  if (enabled instanceof HTMLInputElement) fields.enabled = enabled.checked;
  props.onSubmit?.(props.active.action, props.active.item, fields);
}

function AdminDetailRegion(props: { detail: AdminBusinessDetailState; onClose?: () => void; onNextConsumptions?: (cursor: string) => void; onNextTimeline?: (cursor: string) => void }) {
  const { detail } = props;
  return (
    <aside className="content-panel detail-panel" aria-label="业务对象详情">
      <div className="panel-heading"><h2>详情</h2><button type="button" onClick={props.onClose}>关闭</button></div>
      {detail.kind === 'LOADING' && <p aria-busy="true">正在载入详情...</p>}
      {detail.kind === 'FORBIDDEN' && <p role="alert">{detail.page === 'orders' ? '当前订单不在你的任务权限范围内。' : '当前账号无权查看此详情。'}{detail.requestId ? ` request_id: ${detail.requestId}` : ''}</p>}
      {detail.kind === 'ERROR' && <p role="alert">详情暂时无法载入。{detail.requestId ? ` request_id: ${detail.requestId}` : ''}</p>}
      {detail.kind === 'READY' && detail.data && <>{detail.page === 'orders' ? <OrderTimelineRegion data={detail.data} pageState={detail.timelinePage} onNext={props.onNextTimeline} /> : <dl>{Object.entries(detail.data).map(([key, value]) => <div key={key}><dt><strong>{key}</strong></dt><dd>{displayValue(key, value, detail.data?.currency)}</dd></div>)}</dl>}{detail.page === 'users' && typeof detail.data.id === 'string' && <p><a href={`/admin/users/${encodeURIComponent(detail.data.id)}/profile`}>打开客户 Profile</a></p>}{detail.page === 'users' && detail.consumptions && <UserConsumptionRegion consumptions={detail.consumptions} onNext={props.onNextConsumptions} />}</>}
    </aside>
  );
}

function OrderTimelineRegion(props:{data:Record<string,unknown>;pageState?:AdminBusinessDetailState['timelinePage'];onNext?:(cursor:string)=>void}) {
  const timeline=readAdminOrderTimeline(props.data);const order=props.data.order as Record<string,unknown>|undefined;
  return <><dl className="definition-list">{order&&Object.entries(order).filter(([key])=>['publicId','status','amountMinor','currency','updatedAt'].includes(key)).map(([key,value])=><div key={key}><dt><strong>{key}</strong></dt><dd>{displayValue(key,value,order.currency)}</dd></div>)}</dl>
    <section className="subsection" aria-label="交易时间线"><h3>交易时间线</h3>
      {timeline.items.length===0?<p>暂无交易记录。</p>:<div className="table-scroll"><table className="data-table"><thead><tr><th scope="col">时间</th><th scope="col">类型</th><th scope="col">方向</th><th scope="col">金额</th><th scope="col">状态</th></tr></thead><tbody>{timeline.items.map((item)=><tr key={item.id}><td>{item.occurredAt}</td><td>{item.type}</td><td>{item.direction}</td><td>{item.amountMinor===null?'—':displayValue('amountMinor',item.amountMinor,item.currency)}</td><td>{item.status}</td></tr>)}</tbody></table></div>}
      {props.pageState?.kind==='ERROR'&&<p role="alert">后续交易记录暂时无法载入。{props.pageState.requestId?` request_id: ${props.pageState.requestId}`:''}</p>}
      {timeline.nextCursor&&<button type="button" disabled={props.pageState?.kind==='LOADING'} onClick={()=>props.onNext?.(timeline.nextCursor!)}>加载更多记录</button>}
    </section></>;
}

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

function collectColumns(items: ReadonlyArray<Record<string, unknown>>): string[] {
  return Array.from(new Set(items.flatMap((item) => Object.keys(item)))).filter((column) => !column.toLowerCase().includes('idempotency'));
}

function displayValue(column: string, value: unknown, currency: unknown, tags?: BusinessTagGroups): string {
  if (column.endsWith('Minor') && typeof value === 'number' && typeof currency === 'string') return formatMinorCurrency(value, currency);
  if (value === null || value === undefined) return '-';
  const tagType = column === 'gameTags' ? 'GAME' : column === 'serviceTags' ? 'SERVICE' : column === 'languageTags' ? 'LANGUAGE' : null;
  if (tagType && Array.isArray(value)) {
    const names = new Map((tags?.[tagType] ?? []).map((tag) => [tag.code, tag.displayName]));
    return value.map((code) => names.get(String(code)) ?? String(code)).join(', ');
  }
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
