import { useCallback, useEffect, useMemo, useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { buildSupportWorkbench, type SupportTaskCardInput } from './support-workbench.js';
import { formatMinorCurrency } from './admin-business.js';

interface StaffTaskPayload extends SupportTaskCardInput {
  version: number;
  contextSnapshot?: { guildId?: string; channelId?: string; voiceChannelId?: string };
}

interface OrderContext {
  order: { publicId: string; status: string; game: string | null; service: string | null; amountMinor: number; currency: string };
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

export function SupportWorkbenchPage({ capabilities }: { capabilities: DashboardCapabilities }) {
  const [tasks, setTasks] = useState<StaffTaskPayload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedOrder, setSelectedOrder] = useState<OrderContext | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'MINE' | 'UNCLAIMED'>('ALL');
  const [metricState, setMetricState] = useState<DashboardMetricState>({kind:'LOADING',requestId:null,data:null});
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
  useEffect(() => {
    void client.get('/api/v1/admin/dashboard/summary').then(async(response)=>{const payload=await response.json().catch(()=>null) as {requestId?:string;data?:DashboardSummaryData}|null;
      setMetricState(response.ok&&payload?.data?{kind:'READY',requestId:payload.requestId??null,data:payload.data}:{kind:'ERROR',requestId:payload?.requestId??null,data:null});
    }).catch(()=>setMetricState({kind:'ERROR',requestId:null,data:null}));
  }, [client]);

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
      <DashboardMetricSummary state={metricState}/>
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
          <dl className="definition-list"><div><dt>服务</dt><dd>{selectedOrder.order.game} · {selectedOrder.order.service}</dd></div><div><dt>订单状态</dt><dd>{selectedOrder.order.status}</dd></div><div><dt>准备状态</dt><dd>用户 {selectedOrder.readiness.customer} / 陪玩 {selectedOrder.readiness.player}</dd></div><div><dt>匹配状态</dt><dd>{selectedOrder.matching?.stage ?? '不适用'}</dd></div><div><dt>自动流程</dt><dd>{selectedOrder.automation.state}</dd></div></dl>
        </aside>
      )}
    </section>
  );
}

export function DashboardMetricSummary({state}:{state:DashboardMetricState}){
  if(state.kind==='LOADING')return <section className="state-card state-card--compact" aria-label="运营指标" aria-busy="true">正在载入运营指标...</section>;
  if(state.kind==='ERROR'||!state.data)return <section className="state-card state-card--compact state-card--error" aria-label="运营指标"><p role="alert">运营指标暂时无法载入。{state.requestId?` request_id: ${state.requestId}`:''}</p></section>;
  const {metrics,currency,timeZone}=state.data;
  const values:Array<[string,string|number]>=[
    ['今日订单',metrics.todayOrderCount],['进行中订单',metrics.inProgressOrderCount],['待处理任务',metrics.pendingStaffTaskCount],
    ['已完成净消费',moneyOrHidden(metrics.completedOrderNetConsumptionMinor,currency)],['礼物净消费',moneyOrHidden(metrics.giftNetConsumptionMinor,currency)],
    ['预留总额',moneyOrHidden(metrics.activeReservedMinor,currency)],['派单成功率',`${(metrics.dispatchSuccessRateBps/100).toFixed(2)}%`],['异常数',metrics.exceptionCount]
  ];
  return <section className="content-panel metric-section" aria-label="运营指标"><div className="metric-heading"><h2>运营概览</h2><small>{timeZone}</small></div>
    <div className="metric-grid">{values.map(([label,value])=><div className="metric-card" key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
  </section>;
}

function moneyOrHidden(value:number|null,currency:string){return value===null?'无权限':formatMinorCurrency(value,currency);}
