import { useState, type FormEvent, type ReactNode } from 'react';
import type { AdminBusinessAction, AdminBusinessDetailState, AdminBusinessPageModel } from './admin-business.js';
import { formatMinorCurrency, readAdminOrderTimeline } from './admin-business.js';

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
}) {
  const { model } = props;
  if (model.kind === 'FORBIDDEN') {
    return <section aria-labelledby="admin-page-title"><h1 id="admin-page-title">无权访问</h1><p>需要权限：{model.requiredPermission}</p></section>;
  }

  return (
    <section aria-labelledby="admin-page-title" style={{ padding: 24, minWidth: 0 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <h1 id="admin-page-title" style={{ fontSize: 24 }}>{model.title}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {props.onAction && model.actions.filter((action) => action.scope === 'COLLECTION').map((action) => (
            <button key={action.id} type="button" onClick={() => props.onAction?.(action)}>{action.label}</button>
          ))}
        </div>
      </header>

      {model.filters.length > 0 && (
        <form onSubmit={(event) => submitFilters(event, props.onFilter)} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {model.filters.map((filter) => <input key={filter.id} name={filter.id} aria-label={filter.label} placeholder={filter.label} />)}
          <button type="submit">筛选</button>
          <button type="button" onClick={props.onClearFilters}>清除</button>
        </form>
      )}

      {model.kind === 'LOADING' && <div aria-busy="true" style={{ minHeight: 240 }}>正在载入...</div>}
      {model.kind === 'ERROR' && (
        <div role="alert"><p>数据暂时无法载入。{model.requestId ? ` request_id: ${model.requestId}` : ''}</p><button type="button" onClick={props.onRetry}>重试</button></div>
      )}
      {model.kind === 'EMPTY' && <div style={{ minHeight: 160 }}><p>当前筛选下没有记录。</p><button type="button" onClick={props.onClearFilters}>清除筛选</button></div>}
      {model.kind === 'READY' && <AdminBusinessTable model={model} onAction={props.onAction} onOpenDetail={props.onOpenDetail} />}

      {props.detail && <AdminDetailRegion detail={props.detail} onClose={props.onCloseDetail} onNextConsumptions={props.onNextConsumptions} onNextTimeline={props.onNextTimeline} />}
      {props.activeAction && <AdminActionPanel active={props.activeAction} status={props.actionStatus ?? 'IDLE'} error={props.actionError}
        onCancel={props.onCancelAction} onSubmit={props.onSubmitAction} />}

      {model.pagination.hasNext && model.pagination.nextCursor && (
        <button type="button" onClick={() => props.onNextPage?.(model.pagination.nextCursor!)}>下一页</button>
      )}
    </section>
  );
}

function AdminBusinessTable(props: {
  model: AdminBusinessPageModel;
  onAction?: (action: AdminBusinessAction, item?: Record<string, unknown>) => void;
  onOpenDetail?: (item: Record<string, unknown>) => void;
}) {
  const columns = collectColumns(props.model.items);
  const itemActions = props.onAction ? props.model.actions.filter((action) => action.scope === 'ITEM') : [];
  const hasDetail = Boolean(props.onOpenDetail) && ['orders', 'users', 'players', 'giftRequests'].includes(props.model.page);
  const hasOperations = itemActions.length > 0 || hasDetail;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{columns.map((column) => <th key={column} scope="col" style={{ textAlign: 'left', padding: 8 }}>{column}</th>)}{hasOperations && <th scope="col">操作</th>}</tr></thead>
        <tbody>{props.model.items.map((item, index) => (
          <tr key={typeof item.id === 'string' ? item.id : index}>
            {columns.map((column) => <td key={column} style={{ padding: 8, borderTop: '1px solid #d9e1e3' }}>{displayValue(column, item[column], item.currency)}</td>)}
            {hasOperations && <td style={{ whiteSpace: 'nowrap' }}>
              {hasDetail && <button type="button" onClick={() => props.onOpenDetail?.(item)}>查看详情</button>}
              {itemActions.map((action) => <button key={action.id} type="button" onClick={() => props.onAction?.(action, item)}>{action.label}</button>)}
            </td>}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function AdminActionPanel(props: {
  active: { action: AdminBusinessAction; item?: Record<string, unknown> };
  status: 'IDLE' | 'SUBMITTING' | 'ERROR';
  error?: string | null;
  onCancel?: () => void;
  onSubmit?: (action: AdminBusinessAction, item: Record<string, unknown> | undefined, fields: Record<string, string | boolean>) => void;
}) {
  const action = props.active.action;
  return (
    <aside aria-label={`${action.label}操作面板`} style={{ marginTop: 20, borderTop: '1px solid #d9e1e3', paddingTop: 16 }}>
      <h2 style={{ fontSize: 18 }}>{action.label}</h2>
      <form aria-label={`${action.label}操作表单`} onSubmit={(event) => submitAction(event, props)} style={{ display: 'grid', gap: 10, maxWidth: 560 }}>
        <ActionFields action={action} />
        {action.requiresReason && <label>原因码<input name="reasonCode" required pattern="[A-Z0-9_]{3,100}" placeholder="OPERATIONS_DECISION" /></label>}
        {props.error && <p role="alert" style={{ color: '#9b2c2c' }}>{props.error}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" disabled={props.status === 'SUBMITTING'}>{props.status === 'SUBMITTING' ? '提交中...' : '提交'}</button>
          <button type="button" disabled={props.status === 'SUBMITTING'} onClick={props.onCancel}>取消</button>
        </div>
      </form>
    </aside>
  );
}

function ActionFields({ action }: { action: AdminBusinessAction }) {
  if (action.id === 'SET_OPERATIONAL_STATUS') return <>
    <label>目标状态<select name="status" required defaultValue="PAUSED"><option value="ACTIVE">恢复</option><option value="PAUSED">暂停</option><option value="SUSPENDED">停用</option></select></label>
    <label>处理说明<textarea name="note" rows={3} maxLength={1000} /></label>
  </>;
  if (action.id === 'CREATE_GIFT') return <GiftCatalogFields />;
  if (action.id === 'CREATE_SERVICE_VERSION') return <ServiceCatalogFields />;
  if (action.id === 'UPDATE_GIFT_VERSION') return <VersionActionFields action={action} replacementAction="CREATE_REPLACEMENT_VERSION" replacementFields={<GiftCatalogFields />} />;
  if (action.id === 'UPDATE_VERSION') return <VersionActionFields action={action} replacementAction="SUPERSEDE" replacementFields={<ServiceCatalogFields />} />;
  if (action.id === 'CREATE_RISK_EVENT') return <>
    <label>事件类型<select name="type" required defaultValue="PAYMENT_ANOMALY"><option value="PAYMENT_ANOMALY">支付异常</option><option value="DUPLICATE_ACCOUNT_SIGNAL">重复账号信号</option><option value="REFERRAL_ABUSE_SIGNAL">返佣滥用信号</option><option value="PLAYER_NO_SHOW">陪玩未到场</option><option value="CUSTOMER_NO_SHOW">用户未到场</option></select></label>
    <label>严重程度<select name="severity" required defaultValue="MEDIUM"><option value="LOW">低</option><option value="MEDIUM">中</option><option value="HIGH">高</option></select></label>
    <label>来源<select name="source" required defaultValue="STAFF_REVIEW"><option value="STAFF_REVIEW">员工复核</option><option value="CUSTOMER_REPORT">用户反馈</option><option value="PLAYER_REPORT">陪玩反馈</option><option value="SYSTEM_SIGNAL">系统信号</option></select></label>
    <label>关联订单 ID（可选）<input name="orderId" maxLength={100} /></label>
    <label>说明<textarea name="notes" required rows={4} maxLength={2000} /></label>
  </>;
  return null;
}

function GiftCatalogFields() {
  return <>
    <label>礼物名称<input name="name" required maxLength={100} /></label>
    <label>价格（minor units）<input name="amountMinor" type="number" required min={1} step={1} /></label>
    <label>币种<select name="currency" required defaultValue="CNY"><option value="CNY">CNY</option><option value="USD">USD</option></select></label>
    <label><input name="enabled" type="checkbox" defaultChecked />立即启用</label>
    <label>播报模板<textarea name="broadcastTemplate" required rows={3} maxLength={500} /></label>
  </>;
}

function ServiceCatalogFields() {
  return <>
    <label>游戏<input name="game" required maxLength={100} /></label>
    <label>服务<input name="service" required maxLength={100} /></label>
    <label>地区（可选）<input name="region" maxLength={100} /></label>
    <label>计费单位（分钟）<input name="billingUnitMinutes" type="number" required min={1} max={1440} step={1} /></label>
    <label>最少单位数<input name="minimumUnits" type="number" required min={1} max={1440} step={1} /></label>
    <label>用户单价（minor units）<input name="customerAmountMinor" type="number" required min={1} step={1} /></label>
    <label>陪玩单价（minor units）<input name="playerAmountMinor" type="number" required min={1} step={1} /></label>
    <label>币种<select name="currency" required defaultValue="CNY"><option value="CNY">CNY</option><option value="USD">USD</option></select></label>
    <label><input name="enabled" type="checkbox" defaultChecked />立即启用</label>
  </>;
}

function VersionActionFields(props: { action: AdminBusinessAction; replacementAction: string; replacementFields: ReactNode }) {
  const [action, setAction] = useState('DISABLE');
  return <>
    <label>版本动作<select name="action" required value={action} onChange={(event) => setAction(event.currentTarget.value)}><option value="ENABLE">启用</option><option value="DISABLE">停用</option><option value={props.replacementAction}>{props.action.id === 'UPDATE_VERSION' ? '创建替代服务版本' : '创建替代礼物版本'}</option></select></label>
    {action === props.replacementAction && props.replacementFields}
  </>;
}

function submitAction(event: FormEvent<HTMLFormElement>, props: Parameters<typeof AdminActionPanel>[0]): void {
  event.preventDefault();
  const fields: Record<string, string | boolean> = {};
  for (const [key, value] of new FormData(event.currentTarget).entries()) {
    if (typeof value === 'string') fields[key] = value;
  }
  const enabled = event.currentTarget.elements.namedItem('enabled');
  if (enabled instanceof HTMLInputElement) fields.enabled = enabled.checked;
  props.onSubmit?.(props.active.action, props.active.item, fields);
}

function AdminDetailRegion(props: { detail: AdminBusinessDetailState; onClose?: () => void; onNextConsumptions?: (cursor: string) => void; onNextTimeline?: (cursor: string) => void }) {
  const { detail } = props;
  return (
    <aside aria-label="业务对象详情" style={{ marginTop: 20, borderTop: '1px solid #d9e1e3', paddingTop: 16, minHeight: 160 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}><h2 style={{ fontSize: 18 }}>详情</h2><button type="button" onClick={props.onClose}>关闭</button></div>
      {detail.kind === 'LOADING' && <p aria-busy="true">正在载入详情...</p>}
      {detail.kind === 'FORBIDDEN' && <p role="alert">{detail.page === 'orders' ? '当前订单不在你的任务权限范围内。' : '当前账号无权查看此详情。'}{detail.requestId ? ` request_id: ${detail.requestId}` : ''}</p>}
      {detail.kind === 'ERROR' && <p role="alert">详情暂时无法载入。{detail.requestId ? ` request_id: ${detail.requestId}` : ''}</p>}
      {detail.kind === 'READY' && detail.data && <>{detail.page === 'orders' ? <OrderTimelineRegion data={detail.data} pageState={detail.timelinePage} onNext={props.onNextTimeline} /> : <dl>{Object.entries(detail.data).map(([key, value]) => <div key={key}><dt><strong>{key}</strong></dt><dd>{displayValue(key, value, detail.data?.currency)}</dd></div>)}</dl>}{detail.page === 'users' && typeof detail.data.id === 'string' && <p><a href={`/admin/users/${encodeURIComponent(detail.data.id)}/profile`}>打开客户 Profile</a></p>}{detail.page === 'users' && detail.consumptions && <UserConsumptionRegion consumptions={detail.consumptions} onNext={props.onNextConsumptions} />}</>}
    </aside>
  );
}

function OrderTimelineRegion(props:{data:Record<string,unknown>;pageState?:AdminBusinessDetailState['timelinePage'];onNext?:(cursor:string)=>void}) {
  const timeline=readAdminOrderTimeline(props.data);const order=props.data.order as Record<string,unknown>|undefined;
  return <><dl>{order&&Object.entries(order).filter(([key])=>['publicId','status','amountMinor','currency','updatedAt'].includes(key)).map(([key,value])=><div key={key}><dt><strong>{key}</strong></dt><dd>{displayValue(key,value,order.currency)}</dd></div>)}</dl>
    <section aria-label="交易时间线" style={{marginTop:16}}><h3 style={{fontSize:16}}>交易时间线</h3>
      {timeline.items.length===0?<p>暂无交易记录。</p>:<table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr><th scope="col">时间</th><th scope="col">类型</th><th scope="col">方向</th><th scope="col">金额</th><th scope="col">状态</th></tr></thead><tbody>{timeline.items.map((item)=><tr key={item.id}><td>{item.occurredAt}</td><td>{item.type}</td><td>{item.direction}</td><td>{item.amountMinor===null?'—':displayValue('amountMinor',item.amountMinor,item.currency)}</td><td>{item.status}</td></tr>)}</tbody></table>}
      {props.pageState?.kind==='ERROR'&&<p role="alert">后续交易记录暂时无法载入。{props.pageState.requestId?` request_id: ${props.pageState.requestId}`:''}</p>}
      {timeline.nextCursor&&<button type="button" disabled={props.pageState?.kind==='LOADING'} onClick={()=>props.onNext?.(timeline.nextCursor!)}>加载更多记录</button>}
    </section></>;
}

function UserConsumptionRegion(props: { consumptions: NonNullable<AdminBusinessDetailState['consumptions']>; onNext?: (cursor: string) => void }) {
  const { consumptions } = props;
  return <section aria-label="消费记录" style={{ marginTop: 16 }}>
    <h3 style={{ fontSize: 16 }}>消费记录</h3>
    {consumptions.kind === 'LOADING' && <p aria-busy="true">正在载入消费记录...</p>}
    {consumptions.kind === 'ERROR' && <p role="alert">消费记录暂时无法载入。{consumptions.requestId ? ` request_id: ${consumptions.requestId}` : ''}</p>}
    {consumptions.kind === 'EMPTY' && <p>暂无消费记录。</p>}
    {consumptions.items.length > 0 && <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th scope="col">类型</th><th scope="col">金额</th><th scope="col">状态</th></tr></thead><tbody>{consumptions.items.map((item, index) => <tr key={typeof item.id === 'string' ? item.id : index}><td>{displayValue('type', item.type, item.currency)}</td><td>{displayValue('amountMinor', item.amountMinor, item.currency)}</td><td>{displayValue('status', item.status, item.currency)}</td></tr>)}</tbody></table>}
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

function displayValue(column: string, value: unknown, currency: unknown): string {
  if (column.endsWith('Minor') && typeof value === 'number' && typeof currency === 'string') return formatMinorCurrency(value, currency);
  if (value === null || value === undefined) return '-';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
