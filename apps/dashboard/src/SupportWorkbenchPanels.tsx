import { useMemo, useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { formatMinorCurrency } from './admin-business.js';
import { buildAutomationControlView, type DashboardResumeAction, type DashboardStaffLevel } from './automation-control.js';
import type { DashboardMetricState, OrderContext, StaffTaskPayload } from './support-workbench-view-types.js';

export function SupportAutomationControl({ context, task, capabilities, onUpdated }: {
  context: OrderContext;
  task: StaffTaskPayload;
  capabilities: DashboardCapabilities;
  onUpdated: () => Promise<void>;
}) {
  const client = useMemo(() => createDashboardApiClient(), []);
  const [scope, setScope] = useState<'ALL' | 'DISPATCH' | 'LIFECYCLE' | 'CANCELLATION'>('ALL');
  const [pauseNote, setPauseNote] = useState('');
  const [resumeNote, setResumeNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const level = capabilities.level as DashboardStaffLevel;
  const view = buildAutomationControlView({
    orderId: context.order.id,
    orderVersion: context.order.version,
    orderStatus: context.order.status,
    automationState: context.automation?.state ?? 'RUNNING',
    automationExpiresAt: context.automation?.expiresAt ?? null,
    staffLevel: level,
    hasClaimedOrderTask: task.claimedBy === capabilities.staffId
  });
  const pause = view.actions.find((action) => action.id === 'PAUSE');
  const resume = view.actions.find((action) => action.id === 'RESUME');

  async function submit(action: 'pause' | 'resume') {
    const note = action === 'pause' ? pauseNote.trim() : resumeNote.trim();
    if (!note) return;
    const response = await client.post(`/api/v1/admin/orders/${encodeURIComponent(context.order.id)}/automation/${action}`, {
      expectedVersion: context.order.version,
      reasonCode: action === 'pause' ? 'STAFF_TAKEOVER' : 'BLOCKER_RESOLVED',
      note,
      ...(action === 'pause' ? { scope } : { resumeAction: view.resumeAction })
    });
    if (!response.ok) {
      setMessage(action === 'pause'
        ? '订单事实已变化或当前任务不允许接管；自动流程未暂停。'
        : '订单、余额或预留复核未通过；自动流程保持暂停。');
      await onUpdated();
      return;
    }
    setMessage(null);
    if (action === 'pause') setPauseNote(''); else setResumeNote('');
    await onUpdated();
  }

  return <aside className="action-panel order-automation-control" aria-label="订单自动流程控制">
    <div className="panel-heading"><div><span className="page-eyebrow">STAFF TAKEOVER</span><h2>自动流程接管</h2><p>暂停或恢复只控制自动动作，不改变订单状态，也不会新建、捕获或释放资金预留。</p></div><strong>{view.statusLabel}</strong></div>
    {message && <p className="form-message form-message--error" role="alert">{message}</p>}
    {pause?.enabled && <div className="task-card__editor">
      <label>暂停范围<select aria-label="暂停范围" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
        <option value="ALL">全部自动流程</option><option value="DISPATCH">仅派单</option><option value="LIFECYCLE">仅服务生命周期</option><option value="CANCELLATION">仅取消流程</option>
      </select></label>
      <textarea aria-label="接管原因" value={pauseNote} onChange={(event) => setPauseNote(event.target.value)} maxLength={1000} rows={2} placeholder="记录谁提出暂停、当前情况和下一步核对动作" />
      <button className="button-primary" type="button" disabled={!pauseNote.trim()} onClick={() => void submit('pause')}>{pause.label}</button>
    </div>}
    {resume?.enabled && <div className="task-card__editor">
      <p className="context-note">恢复后动作：{resumeActionLabel(view.resumeAction)}。系统会重新核对最新订单、候选、就绪、余额和预留状态。</p>
      <textarea aria-label="恢复说明" value={resumeNote} onChange={(event) => setResumeNote(event.target.value)} maxLength={1000} rows={2} placeholder="记录阻断已解除及订单、余额、预留复核结果" />
      <button className="button-primary" type="button" disabled={!resumeNote.trim()} onClick={() => void submit('resume')}>{resume.label}</button>
    </div>}
  </aside>;
}

function resumeActionLabel(action: DashboardResumeAction): string {
  return ({ REDISPATCH: '重新派单', RESTART_READINESS_TIMEOUT: '重新启动就绪超时', NONE: '不触发额外自动动作' } as const)[action];
}

export function SupportOrderContextPreview({ context }: { context: OrderContext }) {
  const { order } = context;
  const service = [order.gameDisplayName ?? order.game, order.serviceDisplayName ?? order.service].filter(Boolean).join(' · ') || '项目资料待补充';
  const amount = typeof order.amountMinor === 'number' && order.currency ? formatMinorCurrency(order.amountMinor, order.currency) : '金额待补充';
  const participants = context.readiness?.participants ?? [];
  const readiness = participants.length
    ? participants.map((participant) => `${participant.displayName}：${participant.readiness === 'READY' ? '已就绪' : '未就绪'}`).join('；')
    : order.status === 'ACCEPTED' ? '有效陪玩名单尚未就绪' : '当前无待确认陪玩';
  return <aside className="action-panel order-preview" aria-label="订单处理概览">
    <div className="panel-heading"><div><span className="page-eyebrow">订单处理概览</span><h2>订单 {order.publicId}</h2></div></div>
    <dl className="definition-list">
      <div><dt>客户</dt><dd>{order.customerDisplayName ?? '客户资料待补充'}</dd></div>
      <div><dt>服务</dt><dd>{service}</dd></div>
      <div><dt>订单状态</dt><dd>{supportOrderStatusLabel(order.status)}</dd></div>
      <div><dt>订单金额</dt><dd>{amount}</dd></div>
      <div><dt>准备状态</dt><dd>{readiness}</dd></div>
      <div><dt>匹配状态</dt><dd>{context.matching?.stage ?? '待补充'}</dd></div>
      <div><dt>自动流程</dt><dd>{context.automation?.state ?? '待补充'}</dd></div>
    </dl>
  </aside>;
}

function supportOrderStatusLabel(status: string): string {
  return ({ DRAFT:'草稿', PENDING_DISPATCH:'等待陪玩报名', ACCEPTED:'已接单', IN_SERVICE:'服务中', PENDING_CONFIRMATION:'等待客户确认', COMPLETED:'已完成', CANCELLED:'已取消', EXCEPTION:'异常处理中' } as Record<string,string>)[status] ?? status;
}

export function DashboardMetricSummary({state}:{state:DashboardMetricState}){
  if(state.kind==='LOADING')return <section className="state-card state-card--compact" aria-label="运营指标" aria-busy="true">正在载入运营指标...</section>;
  if(state.kind==='ERROR'||!state.data)return <section className="state-card state-card--compact state-card--error" aria-label="运营指标"><p role="alert">运营指标暂时无法载入。{state.requestId?` 请求编号：${state.requestId}`:''}</p></section>;
  const {metrics,currency,timeZone}=state.data;
  const values:Array<[string,string|number,string,string?]>=[
    ['今日订单',metrics.todayOrderCount,'今日创建'],['进行中订单',metrics.inProgressOrderCount,'当前进行中','/admin/orders?status=IN_PROGRESS'],['待处理任务',metrics.pendingStaffTaskCount,'尚未终结','/support?taskFilter=ALL'],
    ['已完成净消费',moneyOrHidden(metrics.completedOrderNetConsumptionMinor,currency),'当前业务日'],['礼物净消费',moneyOrHidden(metrics.giftNetConsumptionMinor,currency),'当前业务日'],
    ['预留总额',moneyOrHidden(metrics.activeReservedMinor,currency),'当前有效'],['派单成功率',`${(metrics.dispatchSuccessRateBps/100).toFixed(2)}%`,'有效派单轮次'],['异常数',metrics.exceptionCount,'尚未关闭','/admin/orders?status=EXCEPTION']
  ];
  const money=[
    ['已完成净消费',metrics.completedOrderNetConsumptionMinor],['礼物净消费',metrics.giftNetConsumptionMinor],['有效预留',metrics.activeReservedMinor]
  ] as const;
  const moneyMax=Math.max(1,...money.map(([,value])=>value??0));
  const dispatchPercent=metrics.dispatchSuccessRateBps/100;
  return <section className="operations-dashboard" aria-label="运营指标"><div className="metric-heading"><div><span className="page-eyebrow">TODAY OVERVIEW</span><h2>今日运营数据</h2></div><small>{timeZone} · 当前业务日</small></div>
    {state.stale&&<p className="form-message form-message--warning" role="status">指标刷新失败，当前保留上次结果。</p>}
    <div className="operations-kpi-grid">{values.map(([label,value,caption,href])=>href?<a className="operations-kpi operations-kpi--link" href={href} key={label}><small>{label}</small><strong>{value}</strong><span>{caption} · 查看</span></a>:<article className="operations-kpi" key={label}><small>{label}</small><strong>{value}</strong><span>{caption}</span></article>)}</div>
    <div className="operations-chart-grid">
      <article className="operations-chart-card operations-money-chart"><div className="chart-card-heading"><div><small>资金健康</small><h3>资金构成</h3></div><span>{currency}</span></div>
        <div className="money-bars" role="img" aria-label="资金构成图">{money.map(([label,value],index)=><div className="money-bar" key={label}><div><span>{label}</span><strong>{moneyOrHidden(value,currency)}</strong></div><svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect className="money-bar__track" width="100" height="8" rx="4"/><rect className={`money-bar__value money-bar__value--${index+1}`} width={value===null?0:Math.max(2,value*100/moneyMax)} height="8" rx="4"/></svg></div>)}</div>
      </article>
      <article className="operations-chart-card dispatch-chart"><div className="chart-card-heading"><div><small>派单健康</small><h3>派单成功率</h3></div></div><div className="dispatch-chart__body">
        <div className="dispatch-ring"><svg viewBox="0 0 120 120" role="img" aria-label={`派单成功率 ${dispatchPercent.toFixed(2)}%`}><circle className="dispatch-ring__track" cx="60" cy="60" r="46" pathLength="100"/><circle className="dispatch-ring__value" cx="60" cy="60" r="46" pathLength="100" strokeDasharray={`${dispatchPercent} 100`}/></svg><strong>{dispatchPercent.toFixed(2)}%</strong></div>
        <div><span>当前业务日</span><p>按已接受的有效派单轮次计算，零轮次固定显示 0%。</p></div></div>
      </article>
      <article className="operations-chart-card attention-chart"><div className="chart-card-heading"><div><small>需要关注</small><h3>待办健康度</h3></div></div><dl><div><dt>待处理任务</dt><dd>{metrics.pendingStaffTaskCount}</dd></div><div><dt>未关闭异常</dt><dd>{metrics.exceptionCount}</dd></div><div><dt>进行中订单</dt><dd>{metrics.inProgressOrderCount}</dd></div></dl></article>
    </div>
  </section>;
}

function moneyOrHidden(value:number|null,currency:string){return value===null?'无权限':formatMinorCurrency(value,currency);}
