import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { buildSupportWorkbench } from './support-workbench.js';
import { formatMinorCurrency } from './admin-business.js';
import { createLatestRequestSequence, createVisibleRefreshLoop } from './live-query-refresh.js';
import { DashboardMetricSummary, SupportAutomationControl, SupportOrderContextPreview } from './SupportWorkbenchPanels.js';
import type { DashboardMetricState, DashboardSummaryData, OrderContext, StaffTaskPayload } from './support-workbench-view-types.js';

export { DashboardMetricSummary, SupportOrderContextPreview } from './SupportWorkbenchPanels.js';

const SUPPORT_REFRESH_INTERVAL_MS = 5_000;

type GiftVerificationMethod = 'ORDER_CHANNEL' | 'DIRECT_MESSAGE' | 'VOICE';
interface GiftVerificationDraft { method: GiftVerificationMethod; notes: string }

interface SupportShift { id:string;staffId:string;clockedInAt:string;clockedOutAt:string|null }
interface SupportSummaryItem { staffId:string;displayName:string;clockedIn:boolean;shiftSeconds:number;handledTaskCount:number;overdueTaskCount:number;ratingCount:number;averageRating:number|null }

interface SelectedSupportContext { task: StaffTaskPayload; order: OrderContext }

export function supportSelectionMatches(
  task: { orderId: string | null },
  context: { order: { id: string } }
): boolean {
  return Boolean(task.orderId && task.orderId === context.order.id);
}

export function DashboardMetricSummaryLoader(){
  const [state,setState]=useState<DashboardMetricState>({kind:'LOADING',requestId:null,data:null});
  const client=useMemo(()=>createDashboardApiClient(),[]);
  const requestSequence=useRef(createLatestRequestSequence()).current;
  const load=useCallback(async()=>{const sequence=requestSequence.begin();try{const response=await client.get('/api/v1/admin/dashboard/summary');const payload=await response.json().catch(()=>null) as {requestId?:string;data?:DashboardSummaryData}|null;if(!requestSequence.isCurrent(sequence))return;
    setState(current=>response.ok&&payload?.data?{kind:'READY',requestId:payload.requestId??null,data:payload.data,stale:false}:current.data?{...current,kind:'READY',requestId:payload?.requestId??null,stale:true}:{kind:'ERROR',requestId:payload?.requestId??null,data:null,stale:false});
  }catch{if(requestSequence.isCurrent(sequence))setState(current=>current.data?{...current,kind:'READY',stale:true}:{kind:'ERROR',requestId:null,data:null,stale:false});}},[client,requestSequence]);
  useEffect(()=>createVisibleRefreshLoop({refresh:load,intervalMs:SUPPORT_REFRESH_INTERVAL_MS}),[load]);
  return <DashboardMetricSummary state={state}/>;
}

export function SupportWorkbenchPage({ capabilities }: { capabilities: DashboardCapabilities }) {
  const [tasks, setTasks] = useState<StaffTaskPayload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [resolutionDrafts, setResolutionDrafts] = useState<Record<string, string>>({});
  const [giftVerificationDrafts, setGiftVerificationDrafts] = useState<Record<string, GiftVerificationDraft>>({});
  const [giftDecisionDrafts, setGiftDecisionDrafts] = useState<Record<string, string>>({});
  const [selectedContext, setSelectedContext] = useState<SelectedSupportContext | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'MINE' | 'UNCLAIMED'>(()=>{if(typeof window==='undefined')return 'ALL';const value=new URLSearchParams(window.location.search).get('taskFilter');return value==='MINE'||value==='UNCLAIMED'?value:'ALL';});
  const [shift, setShift] = useState<SupportShift | null>(null);
  const [supportSummary, setSupportSummary] = useState<SupportSummaryItem[]>([]);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const client = useMemo(() => createDashboardApiClient(), []);
  const taskRequestSequence = useRef(createLatestRequestSequence()).current;
  const orderRequestSequence = useRef(createLatestRequestSequence()).current;
  const selectedTaskRef = useRef<StaffTaskPayload | null>(null);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const load = useCallback(async (): Promise<boolean> => {
    const sequence = taskRequestSequence.begin();
    const response = await client.get('/api/v1/admin/staff-tasks');
    if (!taskRequestSequence.isCurrent(sequence)) return true;
    if (!response.ok) {
      return false;
    }
    const payload = await response.json() as { data: { items: StaffTaskPayload[] } };
    if (!taskRequestSequence.isCurrent(sequence)) return true;
    setTasks(payload.data.items);
    const selected = selectedTaskRef.current;
    if (selected) selectedTaskRef.current = payload.data.items.find((item) => item.id === selected.id) ?? selected;
    return true;
  }, [client, taskRequestSequence]);

  const loadSupportOperations = useCallback(async (): Promise<boolean> => {
    const [shiftResponse, summaryResponse] = await Promise.all([
      client.get('/api/v1/admin/support-shifts/me'),
      client.get('/api/v1/admin/support/summary')
    ]);
    if (shiftResponse.ok) setShift((await shiftResponse.json() as { data: SupportShift | null }).data);
    if (summaryResponse.ok) setSupportSummary((await summaryResponse.json() as { data: { items: SupportSummaryItem[] } }).data.items);
    return shiftResponse.ok && summaryResponse.ok;
  }, [client]);

  const loadOrderContext = useCallback(async (task: StaffTaskPayload, surfaceError = false): Promise<boolean> => {
    if (!task.orderId) return true;
    const sequence = orderRequestSequence.begin();
    const response = await client.get(`/api/v1/admin/orders/${task.orderId}?taskId=${task.id}`);
    const payload = await response.json().catch(() => null) as { data?: OrderContext } | null;
    if (!orderRequestSequence.isCurrent(sequence)) return true;
    if (!response.ok || !payload?.data?.order) {
      if (surfaceError) setError(response.status === 403 ? '请先认领任务，再查看完整订单。' : '订单详情暂时无法载入。');
      return false;
    }
    if (!supportSelectionMatches(task, payload.data)) {
      if (surfaceError) setError('订单详情与当前任务不一致，已停止显示和操作。');
      return false;
    }
    setSelectedContext({ task, order: payload.data });
    return true;
  }, [client, orderRequestSequence]);

  const refreshSupportState = useCallback((): Promise<void> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    setRefreshing(true);
    const work = (async () => {
      const selected = selectedTaskRef.current;
      const results = await Promise.all([
        load(),
        loadSupportOperations(),
        selected ? loadOrderContext(selected) : Promise.resolve(true)
      ]);
      if (results.every(Boolean)) {
        setLastRefreshedAt(new Date());
        setRefreshWarning(null);
      } else {
        setRefreshWarning('部分信息刷新失败，已保留上次可信内容；可立即重试。');
      }
    })().catch(() => {
      setRefreshWarning('实时刷新请求未送达，已保留上次可信内容；可立即重试。');
    }).finally(() => {
      setRefreshing(false);
      refreshInFlight.current = null;
    });
    refreshInFlight.current = work;
    return work;
  }, [load, loadOrderContext, loadSupportOperations]);

  useEffect(() => createVisibleRefreshLoop({
    refresh: refreshSupportState,
    intervalMs: SUPPORT_REFRESH_INTERVAL_MS
  }), [refreshSupportState]);

  const view = buildSupportWorkbench({
    guildId: '',
    currentStaffId: capabilities.staffId ?? '',
    permissions: capabilities.permissions,
    tasks
  });
  const visibleTasks = filter === 'MINE' ? view.sections.mine : filter === 'UNCLAIMED' ? view.sections.unclaimed : view.sections.all;

  async function claim(task: StaffTaskPayload) {
    const response = await client.post(`/api/v1/admin/staff-tasks/${task.id}/claim`, { expectedVersion: task.version });
    const failure = response.ok ? null : await supportActionError(response, '任务已被认领或状态已变化。');
    await refreshSupportState();
    setError(failure);
  }

  async function addNote(task: StaffTaskPayload) {
    const body = drafts[task.id]?.trim();
    if (!body) return;
    const response = await client.post(`/api/v1/admin/staff-tasks/${task.id}/notes`, { body });
    const failure = response.ok ? null : await supportActionError(response, '备注未保存。');
    if (response.ok) setDrafts((current) => ({ ...current, [task.id]: '' }));
    await refreshSupportState();
    setError(failure);
  }

  async function escalate(task: StaffTaskPayload) {
    const note = drafts[task.id]?.trim();
    if (!note) return;
    const response = await client.post(`/api/v1/admin/staff-tasks/${task.id}/escalate`, {
      expectedVersion: task.version,
      reasonCode: 'SUPERVISOR_REVIEW',
      note
    });
    const failure = response.ok ? null : await supportActionError(response, '升级请求未提交。');
    await refreshSupportState();
    setError(failure);
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
      const failure = await supportActionError(response, '任务状态已变化或底层业务处理尚未完成。');
      await refreshSupportState();
      setError(failure);
      return;
    }
    setError(null);
    setResolutionDrafts((current) => ({ ...current, [task.id]: '' }));
    await refreshSupportState();
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
      const failure = await supportActionError(response, '礼物核验失败；请确认任务仍由你认领。');
      await refreshSupportState();
      setError(failure);
      return;
    }
    setError(null);
    setGiftVerificationDrafts((current) => ({ ...current, [task.id]: { method: draft.method, notes: '' } }));
    await refreshSupportState();
  }

  async function decideGift(task: StaffTaskPayload, decision: 'approve' | 'reject') {
    const giftRequestId = task.giftRequestId;
    const reason = giftDecisionDrafts[task.id]?.trim();
    if (!giftRequestId || !reason) return;
    const detailResponse = await client.get(`/api/v1/admin/gift-requests/${encodeURIComponent(giftRequestId)}`);
    const detailPayload = await detailResponse.json().catch(() => null) as { data?: { rowVersion?: unknown } } | null;
    if (!detailResponse.ok || !Number.isInteger(detailPayload?.data?.rowVersion)) {
      const suffix = (detailPayload as { requestId?: string } | null)?.requestId ? ` 请求编号：${(detailPayload as { requestId: string }).requestId}` : '';
      setError(`礼物请求最新版本无法载入，未执行批准或拒绝。${suffix}`);
      await refreshSupportState();
      return;
    }
    const response = await client.post(`/api/v1/admin/gift-requests/${encodeURIComponent(giftRequestId)}/${decision}`, {
      expectedVersion: detailPayload!.data!.rowVersion,
      reason
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { requestId?: string; error?: { code?: string } } | null;
      const message = payload?.error?.code === 'STEP_UP_REQUIRED' ? '该金额需要先完成账户安全二次验证，再重新提交。' : '礼物请求状态已变化或资金处理失败，未执行决定。';
      await refreshSupportState();
      setError(`${message}${payload?.requestId ? ` 请求编号：${payload.requestId}` : ''}`);
      return;
    }
    setError(null);
    setGiftDecisionDrafts((current) => ({ ...current, [task.id]: '' }));
    await refreshSupportState();
  }

  async function openOrder(task: StaffTaskPayload) {
    if (!task.orderId) return;
    setSelectedContext(null);
    selectedTaskRef.current = task;
    const loaded = await loadOrderContext(task, true);
    if (loaded) setError(null);
  }

  async function toggleShift() {
    const response = await client.post(
      shift ? '/api/v1/admin/support-shifts/clock-out' : '/api/v1/admin/support-shifts/clock-in',
      {}
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { requestId?: string; error?: { code?: string } } | null;
      const message = payload?.error?.code === 'ACTIVE_CLAIMED_TASKS'
        ? '你还有已认领、未处理完的任务，暂时不能下班。'
        : '打卡操作失败，请重试。';
      await refreshSupportState();
      setError(`${message}${payload?.requestId ? ` 请求编号：${payload.requestId}` : ''}`);
      return;
    }
    setError(null);
    await refreshSupportState();
  }

  return (
    <section className="dashboard-page" aria-labelledby="support-title">
      <header className="page-heading"><div><span className="page-eyebrow">SUPPORT DESK</span><h1 id="support-title">客服工作台</h1><p>处理待认领任务，并跟进已由你接手的服务请求。</p></div><div className="page-actions"><span className="context-note">{lastRefreshedAt ? `上次更新 ${lastRefreshedAt.toLocaleTimeString('zh-CN')}` : '正在同步最新业务事实'}</span><button type="button" disabled={refreshing} onClick={() => void refreshSupportState()}>{refreshing ? '刷新中…' : '立即刷新'}</button></div></header>
      {error && <p className="form-message form-message--error" role="alert">{error}</p>}
      {refreshWarning && <p className="form-message form-message--warning" role="status">{refreshWarning}</p>}
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
                {(task.claimedBy === capabilities.staffId || capabilities.permissions.includes('order.resume')) && <button type="button" onClick={() => void openOrder(task)}>查看完整订单</button>}
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
                  <p className="context-note">批准会扣除已有礼物预留；拒绝会释放已有礼物预留。金额以礼物申请中已记录的数值为准，工作台不会重新计算。</p>
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
      {selectedContext && <>
        <SupportOrderContextPreview context={selectedContext.order} />
        <SupportAutomationControl context={selectedContext.order} task={selectedContext.task} capabilities={capabilities} onUpdated={refreshSupportState} />
      </>}
    </section>
  );
}

async function supportActionError(response:Response,fallback:string){const payload=await response.json().catch(()=>null) as {requestId?:string}|null;return `${fallback} 已刷新最新状态，请核对后再操作。${payload?.requestId?` 请求编号：${payload.requestId}`:''}`;}
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
