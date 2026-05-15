import { useCallback, useEffect, useMemo, useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { OperationsPage } from './OperationsPage.js';
import {
  buildAuditLogView, buildFailedJobsView, buildPolicySettingsView,
  buildPanelRepairControl, buildPanelRepairRequest, buildRetryJobRequest, buildUpdatePolicySettingRequest,
  type AuditLogRow, type FailedJobRow, type OperationsLoadStatus, type PolicySettingRow
} from './operations.js';

interface ListState<T> { status: OperationsLoadStatus; items: T[]; nextCursor: string | null; requestId: string | null }
const empty = <T,>(): ListState<T> => ({ status: 'LOADING', items: [], nextCursor: null, requestId: null });

export function OperationsRoute({ capabilities }: { capabilities: DashboardCapabilities }) {
  const client = useMemo(() => createDashboardApiClient(), []);
  const permissions = capabilities.permissions;
  const [audit, setAudit] = useState<ListState<AuditLogRow>>(empty);
  const [jobs, setJobs] = useState<ListState<FailedJobRow>>(empty);
  const [policies, setPolicies] = useState<ListState<PolicySettingRow>>(empty);
  const [retrying, setRetrying] = useState<string[]>([]);
  const [repairingPanel, setRepairingPanel] = useState(false);

  const load = useCallback(async <T,>(path: string, setter: React.Dispatch<React.SetStateAction<ListState<T>>>, cursor: string | null = null) => {
    setter((current) => ({ ...current, status: 'LOADING', requestId: null }));
    try {
      const response = await client.get(`${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      const body = await response.json().catch(() => null) as { requestId?: string; data?: { items?: T[]; nextCursor?: string | null } } | null;
      if (!response.ok || !body?.data) { setter({ status: 'ERROR', items: [], nextCursor: null, requestId: body?.requestId ?? null }); return; }
      setter({ status: 'READY', items: body.data.items ?? [], nextCursor: body.data.nextCursor ?? null, requestId: null });
    } catch { setter({ status: 'ERROR', items: [], nextCursor: null, requestId: null }); }
  }, [client]);

  const loadAudit = useCallback((cursor: string | null = null) => load('/api/v1/admin/audit-logs', setAudit, cursor), [load]);
  const loadJobs = useCallback((cursor: string | null = null) => load('/api/v1/admin/jobs', setJobs, cursor), [load]);
  const loadPolicies = useCallback(() => load('/api/v1/admin/policy-settings', setPolicies), [load]);

  useEffect(() => {
    if (permissions.includes('audit.read')) void loadAudit();
    if (permissions.includes('job.read')) void loadJobs();
    if (permissions.includes('policy.read')) void loadPolicies();
  }, [permissions.join('|'), loadAudit, loadJobs, loadPolicies]);

  async function retryJob(job: FailedJobRow) {
    const reasonCode = window.prompt('请输入重试原因码', 'MANUAL_DISPLAY_RECOVERY')?.trim();
    if (!reasonCode) return;
    setRetrying((ids) => [...ids, job.id]);
    try {
      const request = buildRetryJobRequest(job, reasonCode);
      const response = await client.post(request.path, request.body);
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { requestId?: string; error?: { message?: string } } | null;
        window.alert(`${body?.error?.message ?? '任务重试失败。'}${body?.requestId ? ` request_id: ${body.requestId}` : ''}`);
        return;
      }
      await loadJobs();
    } catch {
      window.alert('任务重试请求未送达，请稍后重试。');
    } finally {
      setRetrying((ids) => ids.filter((id) => id !== job.id));
    }
  }

  async function updatePolicy(setting: PolicySettingRow) {
    const rawValue = window.prompt('请输入新的整数值', String(setting.integerValue));
    if (rawValue === null) return;
    const integerValue = Number(rawValue);
    const reasonCode = window.prompt('请输入修改原因码', 'P0_POLICY_CONFIRMATION')?.trim();
    if (!reasonCode) return;
    try {
      const request = buildUpdatePolicySettingRequest(setting, { integerValue, currency: setting.currency, reasonCode });
      const response = await client.put(request.path, request.body);
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { requestId?: string; error?: { message?: string } } | null;
        window.alert(`${body?.error?.message ?? '设置修改失败。'}${body?.requestId ? ` request_id: ${body.requestId}` : ''}`);
        return;
      }
      await loadPolicies();
    } catch (error) { window.alert(error instanceof Error ? error.message : '输入值无效。'); }
  }

  async function repairPanel() {
    const orderId = window.prompt('请输入订单 UUID')?.trim();
    if (!orderId) return;
    const reasonCode = window.prompt('请输入修复原因码', 'PANEL_MESSAGE_DELETED')?.trim();
    if (!reasonCode) return;
    setRepairingPanel(true);
    try {
      const request = buildPanelRepairRequest(orderId, reasonCode);
      const response = await client.post(request.path, request.body);
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { requestId?: string; error?: { message?: string } } | null;
        window.alert(`${body?.error?.message ?? '面板修复任务创建失败。'}${body?.requestId ? ` request_id: ${body.requestId}` : ''}`);
        return;
      }
      window.alert('面板修复任务已进入队列。');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '面板修复请求未送达，请稍后重试。');
    } finally {
      setRepairingPanel(false);
    }
  }

  return <OperationsPage
    audit={buildAuditLogView({ permissions, ...audit })}
    jobs={buildFailedJobsView({ permissions, ...jobs, retryingJobIds: retrying })}
    policies={buildPolicySettingsView({ permissions, ...policies })}
    panelRepair={buildPanelRepairControl(permissions, repairingPanel)}
    onReload={(section) => { if (section === 'audit') void loadAudit(); else if (section === 'jobs') void loadJobs(); else void loadPolicies(); }}
    onNextAudit={(cursor) => void loadAudit(cursor)} onNextJobs={(cursor) => void loadJobs(cursor)}
    onRetryJob={(job) => void retryJob(job)} onRepairPanel={() => void repairPanel()}
    onUpdatePolicy={(setting) => void updatePolicy(setting)} />;
}
