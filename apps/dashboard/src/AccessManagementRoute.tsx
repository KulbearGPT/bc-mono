import { useCallback, useEffect, useState } from 'react';
import { AccessManagementPage } from './AccessManagementPage.js';
import { buildRoleMappingUpdateRequest, type AccessManagementModel, type RoleMappingRecord } from './access-management.js';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';

const loading: AccessManagementModel = { kind: 'LOADING', mappings: [], requestId: null };

export function AccessManagementRoute(props: { capabilities: DashboardCapabilities }) {
  const [model, setModel] = useState<AccessManagementModel>(loading);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const api = createDashboardApiClient();

  const load = useCallback(async () => {
    if (!props.capabilities.permissions.includes('access.manage')) {
      setModel({ kind: 'FORBIDDEN', mappings: [], requestId: null });
      return;
    }
    setModel(loading);
    const response = await api.get('/api/v1/admin/discord-role-mappings').catch(() => null);
    if (!response) { setModel({ kind: 'ERROR', mappings: [], requestId: null }); return; }
    const payload = await response.json().catch(() => null) as { data?: { items?: RoleMappingRecord[] }; requestId?: string } | null;
    if (response.status === 428) { setModel({ kind: 'STEP_UP_REQUIRED', mappings: [], requestId: payload?.requestId ?? null }); return; }
    if (response.status === 403) { setModel({ kind: 'FORBIDDEN', mappings: [], requestId: payload?.requestId ?? null }); return; }
    if (!response.ok || !Array.isArray(payload?.data?.items)) { setModel({ kind: 'ERROR', mappings: [], requestId: payload?.requestId ?? null }); return; }
    const mappings = payload.data.items;
    setModel({ kind: mappings.length ? 'READY' : 'EMPTY', mappings, requestId: null });
  }, [props.capabilities.permissions.join('|')]);

  useEffect(() => { void load(); }, [load]);

  const updateMapping = async (mapping: RoleMappingRecord, discordRoleId: string, reasonCode: string) => {
    setSubmitting(true); setNotice(null);
    try {
      const request = buildRoleMappingUpdateRequest({ mapping, discordRoleId, reasonCode });
      const response = await api.put(request.path, request.body);
      const payload = await response.json().catch(() => null) as { requestId?: string } | null;
      if (!response.ok) {
        setNotice(response.status === 428 ? '需要先完成近期二次验证。' : `保存失败${payload?.requestId ? ` · request_id: ${payload.requestId}` : ''}`);
        return;
      }
      setNotice('Role 映射已更新，全量对账已进入队列。');
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败，请重试。');
    } finally { setSubmitting(false); }
  };

  return <AccessManagementPage model={model} submitting={submitting} notice={notice} onRefresh={() => void load()} onUpdateMapping={(...args) => void updateMapping(...args)} />;
}
