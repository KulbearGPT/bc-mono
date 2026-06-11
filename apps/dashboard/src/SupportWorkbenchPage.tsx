import { useCallback, useEffect, useMemo, useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { buildSupportWorkbench, type SupportTaskCardInput } from './support-workbench.js';
import { formatMinorCurrency } from './admin-business.js';

interface StaffTaskPayload extends SupportTaskCardInput {
  version: number;
  contextSnapshot?: { guildId?: string; channelId?: string; voiceChannelId?: string };
}

interface OrderContext {
  order: { publicId: string; status: string; game: string | null; gameDisplayName?: string | null; service: string | null; serviceDisplayName?: string | null; amountMinor: number; currency: string };
  readiness: { customer: string; player: string; bothReady: boolean };
  automation: { state: string; reasonCode: string | null };
  matching: { stage: string; nextStep: string } | null;
}

interface DashboardMetrics {
  todayOrderCount: number;
  inProgressOrderCount: number;
  pendingStaffTaskCount: number;
  completedOrderNetConsumptionMinor: number | null;
  giftNetConsumptionMinor: number | null;
  activeReservedMinor: number | null;
  dispatchSuccessRateBps: number;
  exceptionCount: number;
}

interface DashboardSummaryData { windowStart:string;windowEnd:string;timeZone:string;currency:string;metrics:DashboardMetrics }
export type DashboardMetricState={kind:'LOADING'|'READY'|'ERROR';requestId:string|null;data:DashboardSummaryData|null};

export function DashboardMetricSummaryLoader(){
  const [state,setState]=useState<DashboardMetricState>({kind:'LOADING',requestId:null,data:null});
  const client=useMemo(()=>createDashboardApiClient(),[]);
  useEffect(()=>{void client.get('/api/v1/admin/dashboard/summary').then(async(response)=>{const payload=await response.json().catch(()=>null) as {requestId?:string;data?:DashboardSummaryData}|null;
    setState(response.ok&&payload?.data?{kind:'READY',requestId:payload.requestId??null,data:payload.data}:{kind:'ERROR',requestId:payload?.requestId??null,data:null});
  }).catch(()=>setState({kind:'ERROR',requestId:null,data:null}));},[client]);
  return <DashboardMetricSummary state={state}/>;
}

export function SupportWorkbenchPage({ capabilities }: { capabilities: DashboardCapabilities }) {
  const [tasks, setTasks] = useState<StaffTaskPayload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedOrder, setSelectedOrder] = useState<OrderContext | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'MINE' | 'UNCLAIMED'>('ALL');
  const client = useMemo(() => createDashboardApiClient(), []);
  const load = useCallback(async () => {
    const response = await client.get('/api/v1/admin/staff-tasks');
    if (!response.ok) {
      setError('任务列表暂时无法载入。');
      return;
    }
    const payload = await response.json() as { data: { items: StaffTaskPayload[] } };
    setTasks(payload.data.items.map((task) => ({
      ...task,
      guildId: task.contextSnapshot?.guildId ?? task.guildId,
      channelId: task.contextSnapshot?.channelId ?? task.channelId ?? null,
      voiceChannelId: task.contextSnapshot?.voiceChannelId ?? task.voiceChannelId ?? null
    })));
    setError(null);
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  const view = buildSupportWorkbench({
    guildId: '',
    currentStaffId: capabilities.staffId ?? '',
    permissions: capabilities.permissions,
    tasks
  });

  async function claim(task: StaffTaskPayload) {
    const response = await client.post(`/api/v1/admin/staff-tasks/${task.id}/claim`, { expectedVersion: task.version });
    if (!response.ok) setError('任务已被认领或状态已变化，请刷新后重试。');
    await load();
  }

  async function addNote(task: StaffTaskPayload) {
    const body = drafts[task.id]?.trim();
    if (!body) return;
    const response = await client.post(`/api/v1/admin/staff-tasks/${task.id}/notes`, { body });
    if (!response.ok) setError('备注未保存，请刷新后重试。');
    else setDrafts((current) => ({ ...current, [task.id]: '' }));
  }

  async function escalate(task: StaffTaskPayload) {
    const note = drafts[task.id]?.trim();
    if (!note) return;
    const response = await client.post(`/api/v1/admin/staff-tasks/${task.id}/escalate`, {
      expectedVersion: task.version,
      reasonCode: 'SUPERVISOR_REVIEW',
      note
    });
    if (!response.ok) setError('升级请求未提交，请刷新后重试。');
    await load();
  }

  async function openOrder(task: StaffTaskPayload) {
    if (!task.orderId) return;
    const response = await client.get(`/api/v1/admin/orders/${task.orderId}?taskId=${task.id}`);
    if (!response.ok) {
      setError('请先认领任务，再查看完整订单。');
      return;
    }
    setSelectedOrder((await response.json() as { data: OrderContext }).data);
  }

  return (
    <section className="dashboard-page" aria-labelledby="support-title">
      <header className="page-heading"><div><span className="page-eyebrow">SUPPORT DESK</span><h1 id="support-title">客服工作台</h1><p>处理待认领任务，并跟进已由你接手的服务请求。</p></div></header>
      {error && <p className="form-message form-message--error" role="alert">{error}</p>}
      <DashboardMetricSummaryLoader/>
      <div className="segmented-control support-filters" role="tablist" aria-label="任务筛选">
        {view.filters.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}
      </div>
      <div className="task-list">
        {(filter === 'MINE' ? view.sections.mine : filter === 'UNCLAIMED' ? view.sections.unclaimed : [...view.sections.mine, ...view.sections.unclaimed]).map((task) => (
          <article className="content-panel task-card" key={task.id}>
            <div className="task-card__header">
              <div><strong className="task-card__id">{task.publicId}</strong><div className="task-card__meta">{task.type} · {task.statusLabel}</div></div>
              <div className="inline-actions task-card__actions">
                {task.links.orderChannel && <a href={task.links.orderChannel} target="_blank" rel="noreferrer">订单频道</a>}
                {task.links.voiceChannel && <a href={task.links.voiceChannel} target="_blank" rel="noreferrer">语音频道</a>}
                {task.actions.find((action) => action.id === 'CLAIM')?.enabled && <button type="button" onClick={() => void claim(task)}>认领</button>}
                {task.claimedBy === capabilities.staffId && <button type="button" onClick={() => void openOrder(task)}>查看订单</button>}
              </div>
            </div>
            {task.claimedBy === capabilities.staffId && task.status === 'CLAIMED' && (
              <div className="task-card__editor">
                <textarea aria-label={`${task.publicId} 处理备注`} value={drafts[task.id] ?? ''}
                  onChange={(event) => setDrafts((current) => ({ ...current, [task.id]: event.target.value }))}
                  maxLength={2000} rows={2} placeholder="记录联系结果或升级原因" />
                <div className="inline-actions">
                  <button className="button-primary" type="button" onClick={() => void addNote(task)}>保存备注</button>
                  <button type="button" onClick={() => void escalate(task)}>提交主管处理</button>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
      {selectedOrder && (
        <aside className="action-panel order-preview">
          <div className="panel-heading"><div><span className="page-eyebrow">ORDER CONTEXT</span><h2>订单 {selectedOrder.order.publicId}</h2></div></div>
          <dl className="definition-list"><div><dt>服务</dt><dd>{String(selectedOrder.order.gameDisplayName ?? selectedOrder.order.game)} · {String(selectedOrder.order.serviceDisplayName ?? selectedOrder.order.service)}</dd></div><div><dt>订单状态</dt><dd>{selectedOrder.order.status}</dd></div><div><dt>准备状态</dt><dd>用户 {selectedOrder.readiness.customer} / 陪玩 {selectedOrder.readiness.player}</dd></div><div><dt>匹配状态</dt><dd>{selectedOrder.matching?.stage ?? '不适用'}</dd></div><div><dt>自动流程</dt><dd>{selectedOrder.automation.state}</dd></div></dl>
        </aside>
      )}
    </section>
  );
}

export function DashboardMetricSummary({state}:{state:DashboardMetricState}){
  if(state.kind==='LOADING')return <section className="state-card state-card--compact" aria-label="运营指标" aria-busy="true">正在载入运营指标...</section>;
  if(state.kind==='ERROR'||!state.data)return <section className="state-card state-card--compact state-card--error" aria-label="运营指标"><p role="alert">运营指标暂时无法载入。{state.requestId?` request_id: ${state.requestId}`:''}</p></section>;
  const {metrics,currency,timeZone}=state.data;
  const values:Array<[string,string|number,string]>=[
    ['今日订单',metrics.todayOrderCount,'今日创建'],['进行中订单',metrics.inProgressOrderCount,'当前进行中'],['待处理任务',metrics.pendingStaffTaskCount,'尚未终结'],
    ['已完成净消费',moneyOrHidden(metrics.completedOrderNetConsumptionMinor,currency),'当前业务日'],['礼物净消费',moneyOrHidden(metrics.giftNetConsumptionMinor,currency),'当前业务日'],
    ['预留总额',moneyOrHidden(metrics.activeReservedMinor,currency),'当前有效'],['派单成功率',`${(metrics.dispatchSuccessRateBps/100).toFixed(2)}%`,'有效派单轮次'],['异常数',metrics.exceptionCount,'尚未关闭']
  ];
  const money=[
    ['已完成净消费',metrics.completedOrderNetConsumptionMinor],['礼物净消费',metrics.giftNetConsumptionMinor],['有效预留',metrics.activeReservedMinor]
  ] as const;
  const moneyMax=Math.max(1,...money.map(([,value])=>value??0));
  const dispatchPercent=metrics.dispatchSuccessRateBps/100;
  return <section className="operations-dashboard" aria-label="运营指标"><div className="metric-heading"><div><span className="page-eyebrow">TODAY OVERVIEW</span><h2>今日运营数据</h2></div><small>{timeZone} · 当前业务日</small></div>
    <div className="operations-kpi-grid">{values.map(([label,value,caption])=><article className="operations-kpi" key={label}><small>{label}</small><strong>{value}</strong><span>{caption}</span></article>)}</div>
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
