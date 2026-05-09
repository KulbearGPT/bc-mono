import { useCallback, useEffect, useMemo, useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { buildSupportWorkbench, type SupportTaskCardInput } from './support-workbench.js';

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
  inServiceOrderCount: number;
  pendingStaffTaskCount: number;
  exceptionCount: number;
}

export function SupportWorkbenchPage({ capabilities }: { capabilities: DashboardCapabilities }) {
  const [tasks, setTasks] = useState<StaffTaskPayload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedOrder, setSelectedOrder] = useState<OrderContext | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'MINE' | 'UNCLAIMED'>('ALL');
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
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
    void client.get('/api/v1/admin/dashboard/summary').then(async (response) => {
      if (response.ok) setMetrics((await response.json() as { data: { metrics: DashboardMetrics } }).data.metrics);
    });
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
    <section style={{ padding: 24, minWidth: 0 }}>
      <header><h1 style={{ fontSize: 24 }}>客服工作台</h1><p>待认领任务与我的任务</p></header>
      {error && <p role="alert" style={{ color: '#9b2c2c' }}>{error}</p>}
      {metrics && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(100px, 1fr))', gap: 8, marginBottom: 16 }}>
        {[['今日订单', metrics.todayOrderCount], ['服务中', metrics.inServiceOrderCount], ['待处理', metrics.pendingStaffTaskCount], ['异常', metrics.exceptionCount]].map(([label, value]) => (
          <div key={String(label)} style={{ background: '#fff', border: '1px solid #d9e1e3', padding: 12 }}><small>{label}</small><strong style={{ display: 'block', fontSize: 20 }}>{value}</strong></div>
        ))}
      </div>}
      <div role="tablist" aria-label="任务筛选" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {view.filters.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        {(filter === 'MINE' ? view.sections.mine : filter === 'UNCLAIMED' ? view.sections.unclaimed : [...view.sections.mine, ...view.sections.unclaimed]).map((task) => (
          <article key={task.id} style={{ background: '#fff', border: '1px solid #d9e1e3', borderRadius: 6, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
              <div><strong>{task.publicId}</strong><div>{task.type} · {task.statusLabel}</div></div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {task.links.orderChannel && <a href={task.links.orderChannel} target="_blank" rel="noreferrer">订单频道</a>}
                {task.links.voiceChannel && <a href={task.links.voiceChannel} target="_blank" rel="noreferrer">语音频道</a>}
                {task.actions.find((action) => action.id === 'CLAIM')?.enabled && <button type="button" onClick={() => void claim(task)}>认领</button>}
                {task.claimedBy === capabilities.staffId && <button type="button" onClick={() => void openOrder(task)}>查看订单</button>}
              </div>
            </div>
            {task.claimedBy === capabilities.staffId && task.status === 'CLAIMED' && (
              <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                <textarea aria-label={`${task.publicId} 处理备注`} value={drafts[task.id] ?? ''}
                  onChange={(event) => setDrafts((current) => ({ ...current, [task.id]: event.target.value }))}
                  maxLength={2000} rows={2} placeholder="记录联系结果或升级原因" />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => void addNote(task)}>保存备注</button>
                  <button type="button" onClick={() => void escalate(task)}>提交主管处理</button>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
      {selectedOrder && (
        <aside style={{ marginTop: 20, background: '#fff', border: '1px solid #d9e1e3', padding: 16 }}>
          <h2 style={{ fontSize: 18 }}>订单 {selectedOrder.order.publicId}</h2>
          <p>{selectedOrder.order.game} · {selectedOrder.order.service} · {selectedOrder.order.status}</p>
          <p>准备状态：用户 {selectedOrder.readiness.customer} / 陪玩 {selectedOrder.readiness.player}</p>
          <p>匹配状态：{selectedOrder.matching?.stage ?? '不适用'}</p>
          <p>自动流程：{selectedOrder.automation.state}</p>
        </aside>
      )}
    </section>
  );
}
