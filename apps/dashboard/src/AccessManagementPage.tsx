import { useState, type FormEvent } from 'react';
import { KeyRound, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { staffLevelLabels, type AccessManagementModel, type RoleMappingRecord,type StaffAccountRecord,type StaffLevel } from './access-management.js';

export function AccessManagementPage(props: {
  model: AccessManagementModel;
  submitting?: boolean;
  notice?: string | null;
  onRefresh: () => void;
  onUpdateMapping: (mapping: RoleMappingRecord, discordRoleId: string, reasonCode: string) => void;
  staffAccounts?:StaffAccountRecord[];staffNextCursor?:string|null;staffLoadingMore?:boolean;onNextStaffPage?:()=>void;onApproveElevation:(staff:StaffAccountRecord,reason:string)=>void;onUpdateStaff:(staff:StaffAccountRecord,level:StaffLevel,status:'ACTIVE'|'REVOKED',reason:string)=>void;onRevokeSessions:(staff:StaffAccountRecord,reason:string)=>void;onReconcileStaff:(staff:StaffAccountRecord)=>void;
}) {
  if (props.model.kind === 'LOADING') return <AccessState title="正在读取权限配置" copy="Role 映射由统一业务 API 安全载入。" />;
  if (props.model.kind === 'FORBIDDEN') return <AccessState title="无权访问权限管理" copy="此工作区仅对具备 access.manage 的 L4 员工开放。" requestId={props.model.requestId} />;
  if (props.model.kind === 'STEP_UP_REQUIRED') return <AccessState title="需要完成二次验证" copy="Role 映射属于高风险配置，请先到账户安全页面完成近期验证。" requestId={props.model.requestId} actionHref="/security" />;
  if (props.model.kind === 'ERROR') return <AccessState title="权限配置载入失败" copy="请安全重试；其他工作区不受影响。" requestId={props.model.requestId} onRetry={props.onRefresh} />;

  return (
    <section className="dashboard-page" aria-labelledby="access-page-title">
      <header className="page-heading">
        <div><span className="page-eyebrow">ACCESS CONTROL</span><h1 id="access-page-title">权限管理</h1><p>管理 Discord Role 到内部员工级别的版本化映射；最终授权始终由服务端解析。</p></div>
        <button type="button" className="button-secondary" onClick={props.onRefresh}><RefreshCw size={17} aria-hidden="true" />刷新配置</button>
      </header>

      <div className="metric-grid access-principles" aria-label="权限安全原则">
        <article className="metric-card"><span><ShieldCheck size={17} aria-hidden="true" />授权事实</span><strong>内部级别</strong><small>仅内部有效级别决定最终权限</small></article>
        <article className="metric-card"><span><KeyRound size={17} aria-hidden="true" />敏感操作</span><strong>L4 + Step-up</strong><small>修改后触发全量 Role 对账</small></article>
        <article className="metric-card"><span><ShieldAlert size={17} aria-hidden="true" />永久限制</span><strong>无硬删除</strong><small>资金、业务与审计事实只追加</small></article>
      </div>

      {props.notice && <div className="status-notice" role="status">{props.notice}</div>}

      <section className="content-panel" aria-labelledby="staff-accounts-title"><div className="section-heading"><div><span className="page-eyebrow">STAFF ACCOUNTS</span><h2 id="staff-accounts-title">员工账号与 Role 同步状态</h2></div><p>内部有效级别是授权事实；这里同时展示 Discord 最近观察结果和持久化对账状态。</p></div><div className="access-mapping-list">{(props.staffAccounts??[]).map((staff)=><StaffAccountForm key={staff.staffId} staff={staff} mappings={props.model.mappings} submitting={props.submitting} onApprove={props.onApproveElevation} onUpdate={props.onUpdateStaff} onRevokeSessions={props.onRevokeSessions} onReconcile={props.onReconcileStaff}/>)}</div>{!(props.staffAccounts??[]).length?<p>当前 Guild 没有员工账号。</p>:null}{props.staffNextCursor&&props.onNextStaffPage?<div className="pagination-bar"><button type="button" disabled={props.staffLoadingMore} onClick={props.onNextStaffPage}>{props.staffLoadingMore?'载入中…':'继续加载员工'}</button></div>:null}</section>

      <section className="content-panel" aria-labelledby="role-mappings-title">
        <div className="section-heading"><div><span className="page-eyebrow">ROLE MAPPINGS</span><h2 id="role-mappings-title">Discord Role 映射</h2></div><p>版本冲突时不会覆盖他人的更新，请刷新后重试。</p></div>
        {props.model.kind === 'EMPTY'
          ? <div className="state-card"><strong>尚未配置 Role 映射</strong><p>请先通过受控初始化流程建立映射。</p></div>
          : <div className="access-mapping-list">{props.model.mappings.map((mapping) => <RoleMappingForm key={`${mapping.guildId}:${mapping.targetLevel}`} mapping={mapping} submitting={props.submitting} onSubmit={props.onUpdateMapping} />)}</div>}
      </section>

      <aside className="callout callout-danger"><strong>权限边界：</strong>Discord Role 只提供候选级别，不能越过内部审批结果。L3/L4 首次升级必须由另一名有效 L4 确认；降权或撤权会立即使旧会话失效。</aside>
    </section>
  );
}

function StaffAccountForm(props:{staff:StaffAccountRecord;mappings:RoleMappingRecord[];submitting?:boolean;onApprove:(staff:StaffAccountRecord,reason:string)=>void;onUpdate:(staff:StaffAccountRecord,level:StaffLevel,status:'ACTIVE'|'REVOKED',reason:string)=>void;onRevokeSessions:(staff:StaffAccountRecord,reason:string)=>void;onReconcile:(staff:StaffAccountRecord)=>void}) {
  const [level,setLevel]=useState<StaffLevel>(props.staff.effectiveLevel);
  const [reason,setReason]=useState('ACCESS_CORRECTION');
  const observedRoles=(props.staff.observedDiscordRoleIds??[]).map((roleId)=>{
    const mapping=props.mappings.find((candidate)=>candidate.discordRoleId===roleId);
    return mapping?`${staffLevelLabels[mapping.targetLevel]} (${roleId})`:roleId;
  });
  return <article className="access-mapping-row" aria-label={`员工 ${props.staff.displayName}`}>
    <div className="access-mapping-row__level">
      <small>{props.staff.status}</small><strong>{props.staff.displayName}</strong>
      <span>{staffLevelLabels[props.staff.effectiveLevel]} · 权限 v{props.staff.permissionsVersion} · 活跃会话 {props.staff.activeSessions}</span>
      {props.staff.pendingElevationLevel?<em>待确认升级至 {staffLevelLabels[props.staff.pendingElevationLevel]}</em>:null}
      <dl className="compact-definition">
        <dt>最近同步</dt><dd>{formatSyncTime(props.staff.roleSyncedAt)}</dd>
        <dt>当前观察 Role</dt><dd>{observedRoles.length?observedRoles.join('、'):'尚无观测'}</dd>
        <dt>处理结果</dt><dd>{props.staff.lastRoleSyncStatus??'尚无结果'}{props.staff.roleSyncQueueStatus?` · 队列 ${props.staff.roleSyncQueueStatus}`:''}</dd>
        <dt>上次同步错误</dt><dd>{props.staff.lastRoleSyncError??'无'}</dd>
      </dl>
    </div>
    <label className="field"><span>内部级别</span><select value={level} onChange={(event)=>setLevel(event.currentTarget.value as StaffLevel)}>{Object.entries(staffLevelLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    <label className="field"><span>操作原因</span><input value={reason} onChange={(event)=>setReason(event.currentTarget.value)} pattern="[A-Z][A-Z0-9_]{2,99}" required/></label>
    <div className="button-row">
      {props.staff.pendingElevationLevel?<button className="button-primary" disabled={props.submitting} onClick={()=>props.onApprove(props.staff,'ROLE_AND_IDENTITY_VERIFIED')}>确认提权</button>:null}
      <button className="button-secondary" disabled={props.submitting} onClick={()=>props.onReconcile(props.staff)}>立即从 Discord 对账</button>
      <button disabled={props.submitting||level===props.staff.effectiveLevel} onClick={()=>props.onUpdate(props.staff,level,'ACTIVE',reason)}>保存级别</button>
      <button disabled={props.submitting} onClick={()=>props.onRevokeSessions(props.staff,'SECURITY_RESPONSE')}>撤销会话</button>
      <button className="table-action--danger" disabled={props.submitting||props.staff.status==='REVOKED'} onClick={()=>props.onUpdate(props.staff,props.staff.effectiveLevel,'REVOKED','ACCESS_REVOKED')}>撤销权限</button>
    </div>
  </article>;
}

function formatSyncTime(value?:string|null):string {
  if(!value)return '尚未同步';
  const date=new Date(value);
  return Number.isNaN(date.getTime())?'时间未知':date.toLocaleString('zh-CN');
}

function RoleMappingForm(props: { mapping: RoleMappingRecord; submitting?: boolean; onSubmit: (mapping: RoleMappingRecord, discordRoleId: string, reasonCode: string) => void }) {
  const [roleId, setRoleId] = useState(props.mapping.discordRoleId);
  const [reasonCode, setReasonCode] = useState('ROLE_CONFIGURATION_CHANGE');
  const submit = (event: FormEvent) => { event.preventDefault(); props.onSubmit(props.mapping, roleId, reasonCode); };
  return <form className="access-mapping-row" onSubmit={submit}>
    <div className="access-mapping-row__level"><small>内部有效级别</small><strong>{staffLevelLabels[props.mapping.targetLevel]}</strong><span>映射版本 v{props.mapping.version}</span></div>
    <label className="field"><span>Discord Role ID</span><input value={roleId} onChange={(event) => setRoleId(event.currentTarget.value)} inputMode="numeric" required /></label>
    <label className="field"><span>变更原因</span><input value={reasonCode} onChange={(event) => setReasonCode(event.currentTarget.value)} pattern="[A-Z][A-Z0-9_]{2,99}" required /></label>
    <button type="submit" className="button-primary" disabled={props.submitting}>{props.submitting ? '正在保存…' : '更新映射'}</button>
  </form>;
}

function AccessState(props: { title: string; copy: string; requestId?: string | null; actionHref?: string; onRetry?: () => void }) {
  return <section className="dashboard-page"><div className="state-card"><span className="page-eyebrow">ACCESS CONTROL</span><h1>{props.title}</h1><p>{props.copy}</p>{props.requestId && <code>request_id: {props.requestId}</code>}<div className="button-row">{props.actionHref && <a className="button button-primary" href={props.actionHref}>前往账户安全</a>}{props.onRetry && <button type="button" onClick={props.onRetry}>重新载入</button>}</div></div></section>;
}
