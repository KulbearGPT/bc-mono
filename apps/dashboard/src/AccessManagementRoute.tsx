import { useCallback, useEffect, useState } from 'react';
import { AccessManagementPage } from './AccessManagementPage.js';
import { buildRoleMappingUpdateRequest,buildStaffElevationApprovalRequest,buildStaffRoleUpdateRequest,buildStaffSessionRevocationRequest, type AccessManagementModel, type RoleMappingRecord,type StaffAccountRecord } from './access-management.js';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';

const loading: AccessManagementModel = { kind: 'LOADING', mappings: [], requestId: null };

export function AccessManagementRoute(props: { capabilities: DashboardCapabilities }) {
  const [model, setModel] = useState<AccessManagementModel>(loading);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [staffAccounts,setStaffAccounts]=useState<StaffAccountRecord[]>([]);
  const api = createDashboardApiClient();

  const load = useCallback(async () => {
    if (!props.capabilities.permissions.includes('access.manage')) {
      setModel({ kind: 'FORBIDDEN', mappings: [], requestId: null });
      return;
    }
    setModel(loading);
    const [response,staffResponse] = await Promise.all([api.get('/api/v1/admin/discord-role-mappings').catch(() => null),api.get('/api/v1/admin/staff?limit=100').catch(()=>null)]);
    if (!response||!staffResponse) { setModel({ kind: 'ERROR', mappings: [], requestId: null }); return; }
    const payload = await response.json().catch(() => null) as { data?: { items?: RoleMappingRecord[] }; requestId?: string } | null;
    if (response.status === 428||staffResponse.status===428) { setModel({ kind: 'STEP_UP_REQUIRED', mappings: [], requestId: payload?.requestId ?? null }); return; }
    if (response.status === 403) { setModel({ kind: 'FORBIDDEN', mappings: [], requestId: payload?.requestId ?? null }); return; }
    const staffPayload=await staffResponse.json().catch(()=>null) as {data?:{items?:StaffAccountRecord[]}}|null;
    if (!response.ok || !Array.isArray(payload?.data?.items)||!staffResponse.ok||!Array.isArray(staffPayload?.data?.items)) { setModel({ kind: 'ERROR', mappings: [], requestId: payload?.requestId ?? null }); return; }
    setStaffAccounts(staffPayload.data.items);
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

  const writeStaff=async(request:{method:'POST'|'PATCH';path:string;body:Record<string,unknown>})=>{setSubmitting(true);setNotice(null);try{const response=request.method==='POST'?await api.post(request.path,request.body):await api.patch(request.path,request.body);const payload=await response.json().catch(()=>null) as {requestId?:string;error?:{message?:string}}|null;if(!response.ok){setNotice(`${payload?.error?.message??'员工账号操作失败。'}${payload?.requestId?` · request_id: ${payload.requestId}`:''}`);return;}setNotice('员工账号已更新，旧会话已按规则撤销。');await load();}catch(error){setNotice(error instanceof Error?error.message:'员工账号操作失败。');}finally{setSubmitting(false);}};

  return <AccessManagementPage model={model} staffAccounts={staffAccounts} submitting={submitting} notice={notice} onRefresh={() => void load()} onUpdateMapping={(...args) => void updateMapping(...args)} onApproveElevation={(staff,reason)=>void writeStaff(buildStaffElevationApprovalRequest(staff,reason))} onUpdateStaff={(staff,level,status,reason)=>void writeStaff(buildStaffRoleUpdateRequest(staff,level,status,reason))} onRevokeSessions={(staff,reason)=>void writeStaff(buildStaffSessionRevocationRequest(staff,reason))} />;
}
