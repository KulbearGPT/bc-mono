import { useCallback, useEffect, useMemo, useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { buildSupportWorkbench, type SupportTaskCardInput } from './support-workbench.js';
import { formatMinorCurrency } from './admin-business.js';

interface StaffTaskPayload extends SupportTaskCardInput {
  version: number;
  responseStatus?: 'NOT_REQUIRED' | 'PENDING' | 'MET' | 'OVERDUE';
  responseDueAt?: string | null;
  firstRespondedAt?: string | null;
}

type GiftVerificationMethod = 'ORDER_CHANNEL' | 'DIRECT_MESSAGE' | 'VOICE';
interface GiftVerificationDraft { method: GiftVerificationMethod; notes: string }

interface OrderContext {
  order: { publicId: string; status: string; game?: string | null; gameDisplayName?: string | null; service?: string | null; serviceDisplayName?: string | null; amountMinor?: number; currency?: string; customerDisplayName?: string | null };
  readiness?: { customer: string; player: string; bothReady: boolean };
  automation?: { state: string; reasonCode: string | null };
  matching?: { stage: string; nextStep: string } | null;
  timeline?: { items: unknown[]; nextCursor: string | null };
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
interface SupportShift { id:string;staffId:string;clockedInAt:string;clockedOutAt:string|null }
interface SupportSummaryItem { staffId:string;displayName:string;clockedIn:boolean;shiftSeconds:number;handledTaskCount:number;overdueTaskCount:number;ratingCount:number;averageRating:number|null }

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
  const [resolutionDrafts, setResolutionDrafts] = useState<Record<string, string>>({});
  const [giftVerificationDrafts, setGiftVerificationDrafts] = useState<Record<string, GiftVerificationDraft>>({});
  const [giftDecisionDrafts, setGiftDecisionDrafts] = useState<Record<string, string>>({});
  const [selectedOrder, setSelectedOrder] = useState<OrderContext | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'MINE' | 'UNCLAIMED'>(()=>{if(typeof window==='undefined')return 'ALL';const value=new URLSearchParams(window.location.search).get('taskFilter');return value==='MINE'||value==='UNCLAIMED'?value:'ALL';});
  const [shift, setShift] = useState<SupportShift | null>(null);
  const [supportSummary, setSupportSummary] = useState<SupportSummaryItem[]>([]);
  const client = useMemo(() => createDashboardApiClient(), []);
  const load = useCallback(async () => {
    const response = await client.get('/api/v1/admin/staff-tasks');
    if (!response.ok) {
      setError('任务列表暂时无法载入。');
      return;
    }
    const payload = await response.json() as { data: { items: StaffTaskPayload[] } };
    setTasks(payload.data.items);
    setError(null);
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  const loadSupportOperations = useCallback(async () => {
    const [shiftResponse, summaryResponse] = await Promise.all([
      client.get('/api/v1/admin/support-shifts/me'),
      client.get('/api/v1/admin/support/summary')
    ]);
    if (shiftResponse.ok) setShift((await shiftResponse.json() as { data: SupportShift | null }).data);
    if (summaryResponse.ok) setSupportSummary((await summaryResponse.json() as { data: { items: SupportSummaryItem[] } }).data.items);
  }, [client]);

  useEffect(() => { void loadSupportOperations(); }, [loadSupportOperations]);

  const view = buildSupportWorkbench({
    guildId: '',
    currentStaffId: capabilities.staffId ?? '',
    permissions: capabilities.permissions,
    tasks
  });
  const visibleTasks = filter === 'MINE' ? view.sections.mine : filter === 'UNCLAIMED' ? view.sections.unclaimed : view.sections.all;

  async function claim(task: StaffTaskPayload) {
    const response = await client.post(`/api/v1/admin/staff-tasks/${task.id}/claim`, { expectedVersion: task.version });
    await load();
    if (!response.ok) setError('任务已被认领或状态已变化，请刷新后重试。');
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

  async function resolve(task: StaffTaskPayload) {
    const notes = resolutionDrafts[task.id]?.trim();
    if (!notes) return;
    const response = await client.post(`/api/v1/admin/staff-tasks/${task.id}/resolve`, {
      expectedVersion: task.version,
      resolutionCode: 'UNDERLYING_ACTION_COMPLETED',
      notes
    });
    if (!response.ok) {
      setError('任务状态已变化或底层业务处理尚未完成，请刷新后重试。');
      await load();
      return;
    }
    setError(null);
    setResolutionDrafts((current) => ({ ...current, [task.id]: '' }));
    await load();
  }

  async function verifyGift(task: StaffTaskPayload) {
    const draft = giftVerificationDrafts[task.id] ?? { method: 'ORDER_CHANNEL' as const, notes: '' };
    if (!draft.notes.trim()) return;
    const response = await client.post(`/api/v1/admin/staff-tasks/${task.id}/verify`, {
      expectedVersion: task.version,
      verificationMethod: draft.method,
      notes: draft.notes.trim()
    });
    if (!response.ok) {
      setError('礼物核验失败；请确认任务仍由你认领并刷新最新状态。');
      await load();
      return;
    }
    setError(null);
    setGiftVerificationDrafts((current) => ({ ...current, [task.id]: { method: draft.method, notes: '' } }));
    await load();
  }

  async function decideGift(task: StaffTaskPayload, decision: 'approve' | 'reject') {
    const giftRequestId = task.giftRequestId;
    const reason = giftDecisionDrafts[task.id]?.trim();
    if (!giftRequestId || !reason) return;
    const detailResponse = await client.get(`/api/v1/admin/gift-requests/${encodeURIComponent(giftRequestId)}`);
    const detailPayload = await detailResponse.json().catch(() => null) as { data?: { rowVersion?: unknown } } | null;
    if (!detailResponse.ok || !Number.isInteger(detailPayload?.data?.rowVersion)) {
      setError('礼物请求最新版本无法载入，未执行批准或拒绝。');
      return;
    }
    const response = await client.post(`/api/v1/admin/gift-requests/${encodeURIComponent(giftRequestId)}/${decision}`, {
      expectedVersion: detailPayload!.data!.rowVersion,
      reason
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      setError(payload?.error?.code === 'STEP_UP_REQUIRED' ? '该金额需要先完成账户安全 step-up，再重新提交。' : '礼物请求状态已变化或资金处理失败，未执行决定。');
      await load();
      return;
    }
    setError(null);
    setGiftDecisionDrafts((current) => ({ ...current, [task.id]: '' }));
    await load();
  }

  async function openOrder(task: StaffTaskPayload) {
    if (!task.orderId) return;
    const response = await client.get(`/api/v1/admin/orders/${task.orderId}?taskId=${task.id}`);
    if (!response.ok) {
      setError('请先认领任务，再查看完整订单。');
      return;
    }
    const payload = await response.json().catch(() => null) as { data?: OrderContext } | null;
    if (!payload?.data?.order) {
      setError('订单详情暂时无法载入。');
      return;
    }
    setError(null);
    setSelectedOrder(payload.data);
  }

  async function toggleShift() {
    const response = await client.post(
      shift ? '/api/v1/admin/support-shifts/clock-out' : '/api/v1/admin/support-shifts/clock-in',
      {}
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      setError(payload?.error?.code === 'ACTIVE_CLAIMED_TASKS'
        ? '你还有已认领、未处理完的任务，暂时不能下班。'
        : '打卡操作失败，请重试。');
      return;
    }
    setError(null);
    await loadSupportOperations();
  }

  return (
    <section className="dashboard-page" aria-labelledby="support-title">
      <header className="page-heading"><div><span className="page-eyebrow">SUPPORT DESK</span><h1 id="support-title">客服工作台</h1><p>处理待认领任务，并跟进已由你接手的服务请求。</p></div></header>
      {error && <p className="form-message form-message--error" role="alert">{error}</p>}
      <section className="support-shift-bar" aria-label="客服打卡">
        <div><strong>{shift ? '当前上班中' : '当前未上班'}</strong><span>{shift ? ` · ${new Date(shift.clockedInAt).toLocaleString()} 开始` : ' · 打卡只记录班次，不影响任务权限'}</span></div>
          {['L1_SUPPORT','L2_SUPERVISOR'].includes(capabilities.level ?? '') && <button className="button-primary" type="button" onClick={() => void toggleShift()}>{shift ? '下班打卡' : '上班打卡'}</button>}
      </section>
      <section className="support-queue" aria-label="当前任务队列">
        <div className="panel-heading"><div><span className="page-eyebrow">ACTIVE QUEUE</span><h2>当前任务</h2><p>已按超时、首响截止时间和创建时间排列。</p></div><strong className="queue-count">{visibleTasks.length} 项</strong></div>
        <div className="segmented-control support-filters" role="group" aria-label="任务筛选">
          {view.filters.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}
        </div>
        <div className="task-list">
          {visibleTasks.map((task) => (
            <article className={`content-panel task-card${task.responseStatus === 'OVERDUE' ? ' task-card--urgent' : ''}`} key={task.id}>
              <div className="task-card__header">
                <div><strong className="task-card__id">订单 {task.triage.orderPublicId ?? '编号待补充'}</strong><div className="task-card__meta">{task.statusLabel} · {formatTaskPressure(task)}</div></div>
                <span className={`task-pressure task-pressure--${task.responseStatus === 'OVERDUE' ? 'urgent' : 'normal'}`}>{supportResponseLabel(task)}</span>
              </div>
              <dl className="task-card__summary">
                <div><dt>客户</dt><dd>{task.triage.customerDisplayName ?? '待补充'}</dd></div>
                <div><dt>服务</dt><dd>{[task.triage.gameDisplayName, task.triage.serviceDisplayName].filter(Boolean).join(' · ') || '待补充'}</dd></div>
                <div><dt>需要处理</dt><dd>{task.triage.reasonLabel}</dd></div>
                <div><dt>下一步</dt><dd>{task.triage.nextActionLabel}</dd></div>
              </dl>
              <div className="inline-actions task-card__actions">
                <button type="button" aria-expanded={expandedTaskId === task.id} onClick={() => setExpandedTaskId((current) => current === task.id ? null : task.id)}>查看任务上下文</button>
                {task.links.orderChannel ? <a href={task.links.orderChannel} target="_blank" rel="noreferrer">进入订单频道</a> : <span className="action-unavailable">订单频道暂不可用</span>}
                {task.links.voiceChannel && <a href={task.links.voiceChannel} target="_blank" rel="noreferrer">进入语音频道</a>}
                {task.actions.find((action) => action.id === 'CLAIM')?.enabled && <button className="button-primary" type="button" onClick={() => void claim(task)}>认领任务</button>}
                {task.claimedBy === capabilities.staffId && <button type="button" onClick={() => void openOrder(task)}>查看完整订单</button>}
              </div>
              {expandedTaskId === task.id && <div className="task-card__context" role="region" aria-label={`${task.triage.orderPublicId ?? task.publicId} 任务上下文`}>
                <dl className="definition-list"><div><dt>任务编号</dt><dd>{task.publicId}</dd></div><div><dt>等待开始</dt><dd>{new Date(task.triage.waitStartedAt).toLocaleString()}</dd></div>
                  <div><dt>订单金额</dt><dd>{task.triage.amountMinor === null || !task.triage.currency ? '待补充' : formatMinorCurrency(task.triage.amountMinor, task.triage.currency)}</dd></div><div><dt>首响状态</dt><dd>{supportResponseLabel(task)}</dd></div></dl>
                {task.claimedBy !== capabilities.staffId && <p className="context-note">这是认领前只读摘要；完整订单和写入仍按你的任务权限控制。</p>}
              </div>}
              {task.claimedBy === capabilities.staffId && task.status === 'CLAIMED' && (
                <div className="task-card__editor">
                  <textarea aria-label={`${task.publicId} 处理备注`} value={drafts[task.id] ?? ''}
                    onChange={(event) => setDrafts((current) => ({ ...current, [task.id]: event.target.value }))}
                    maxLength={2000} rows={2} placeholder="记录联系结果或升级原因" />
                  <div className="inline-actions"><button className="button-primary" type="button" onClick={() => void addNote(task)}>保存备注</button><button type="button" onClick={() => void escalate(task)}>提交主管处理</button></div>
                </div>
              )}
              {task.actions.find((action) => action.id === 'RESOLVE')?.enabled && (
                <div className="task-card__editor task-card__resolution">
                  <strong>任务结案</strong>
                  <p className="context-note">仅在订单、退款、礼物或其他底层业务动作已经完成后结案；此操作本身不会修改订单或资金。</p>
                  <textarea aria-label={`${task.publicId} 结案说明`} value={resolutionDrafts[task.id] ?? ''}
                    onChange={(event) => setResolutionDrafts((current) => ({ ...current, [task.id]: event.target.value }))}
                    maxLength={2000} rows={2} placeholder="填写已完成的处理动作及通知结果" />
                  <button className="button-primary" type="button" disabled={!resolutionDrafts[task.id]?.trim()} onClick={() => void resolve(task)}>确认任务已完成</button>
                </div>
              )}
              {task.actions.find((action) => action.id === 'VERIFY_GIFT')?.enabled && (() => {
                const draft = giftVerificationDrafts[task.id] ?? { method: 'ORDER_CHANNEL' as const, notes: '' };
                return <div className="task-card__editor task-card__gift-review">
                  <strong>礼物请求核验</strong>
                  <label>核验方式<select value={draft.method} onChange={(event) => setGiftVerificationDrafts((current) => ({ ...current, [task.id]: { ...draft, method: event.target.value as GiftVerificationMethod } }))}>
                    <option value="ORDER_CHANNEL">订单频道</option><option value="DIRECT_MESSAGE">私信</option><option value="VOICE">语音确认</option>
                  </select></label>
                  <textarea aria-label={`${task.publicId} 礼物核验说明`} value={draft.notes}
                    onChange={(event) => setGiftVerificationDrafts((current) => ({ ...current, [task.id]: { ...draft, notes: event.target.value } }))}
                    maxLength={2000} rows={2} placeholder="记录已核对的赠送人、接收陪玩、礼物、金额和真实意愿" />
                  <button className="button-primary" type="button" disabled={!draft.notes.trim()} onClick={() => void verifyGift(task)}>确认核验完成</button>
                </div>;
              })()}
              {(task.actions.find((action) => action.id === 'APPROVE_GIFT')?.enabled || task.actions.find((action) => action.id === 'REJECT_GIFT')?.enabled) && (
                <div className="task-card__editor task-card__gift-decision">
                  <strong>礼物资金决定</strong>
                  <p className="context-note">批准会捕获已有礼物预留；拒绝会释放已有礼物预留。金额由服务端快照决定，后台不会重新计算。</p>
                  <textarea aria-label={`${task.publicId} 礼物决定说明`} value={giftDecisionDrafts[task.id] ?? ''}
                    onChange={(event) => setGiftDecisionDrafts((current) => ({ ...current, [task.id]: event.target.value }))}
                    maxLength={2000} rows={2} placeholder="填写批准依据或拒绝原因" />
                  <div className="inline-actions">
                    {task.actions.find((action) => action.id === 'APPROVE_GIFT')?.enabled && <button className="button-primary" type="button" disabled={!giftDecisionDrafts[task.id]?.trim()} onClick={() => void decideGift(task, 'approve')}>批准并捕获预留</button>}
                    {task.actions.find((action) => action.id === 'REJECT_GIFT')?.enabled && <button type="button" disabled={!giftDecisionDrafts[task.id]?.trim()} onClick={() => void decideGift(task, 'reject')}>拒绝并释放预留</button>}
                  </div>
                </div>
              )}
            </article>
          ))}
          {visibleTasks.length === 0 && <div className="state-card state-card--compact"><strong>当前没有匹配任务</strong><p>可以切换筛选查看其他任务。</p></div>}
        </div>
      </section>
      <section className="content-panel" aria-label="最近 30 天客服记录">
        <div className="panel-heading"><div><h2>最近 30 天客服记录</h2><p>仅展示事实记录，不计算奖惩或绩效积分。</p></div></div>
        <div className="table-shell"><table><thead><tr><th>客服</th><th>班次</th><th>时长</th><th>认领任务</th><th>超时首响</th><th>评分</th></tr></thead><tbody>
          {supportSummary.map((item) => <tr key={item.staffId}><td>{item.displayName}</td><td>{item.clockedIn ? '上班中' : '未上班'}</td><td>{Math.floor(item.shiftSeconds / 60)} 分钟</td><td>{item.handledTaskCount}</td><td>{item.overdueTaskCount}</td><td>{item.averageRating === null ? '暂无' : `${item.averageRating} / 5（${item.ratingCount}）`}</td></tr>)}
        </tbody></table></div>
      </section>
      <DashboardMetricSummaryLoader/>
      {selectedOrder && <SupportOrderContextPreview context={selectedOrder} />}
    </section>
  );
}

export function SupportOrderContextPreview({ context }: { context: OrderContext }) {
  const { order } = context;
  const service = [order.gameDisplayName ?? order.game, order.serviceDisplayName ?? order.service].filter(Boolean).join(' · ') || '项目资料待补充';
  const amount = typeof order.amountMinor === 'number' && order.currency ? formatMinorCurrency(order.amountMinor, order.currency) : '金额待补充';
  const readiness = context.readiness ? `用户 ${context.readiness.customer} / 陪玩 ${context.readiness.player}` : '待补充';
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
  if(state.kind==='ERROR'||!state.data)return <section className="state-card state-card--compact state-card--error" aria-label="运营指标"><p role="alert">运营指标暂时无法载入。{state.requestId?` request_id: ${state.requestId}`:''}</p></section>;
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
function supportResponseLabel(task:StaffTaskPayload){
  if(task.responseStatus==='PENDING'&&task.responseDueAt)return `等待首响（截止 ${new Date(task.responseDueAt).toLocaleTimeString()}）`;
  if(task.responseStatus==='OVERDUE')return '首响已超时';
  if(task.responseStatus==='MET')return task.firstRespondedAt?`已首响 ${new Date(task.firstRespondedAt).toLocaleTimeString()}`:'已首响';
  return '无需首响';
}

function formatTaskPressure(task: StaffTaskPayload): string {
  const target = task.responseDueAt ?? task.triage.waitStartedAt;
  const seconds = Math.round((new Date(target).getTime() - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = absolute >= 3600
    ? [Math.round(seconds / 3600), 'hour'] : [Math.round(seconds / 60), 'minute'];
  return new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }).format(value, unit);
}
