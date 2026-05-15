import type { AuditLogRow, FailedJobRow, PolicySettingRow } from './operations.js';

type ViewKind = 'LOADING' | 'EMPTY' | 'ERROR' | 'FORBIDDEN' | 'READY';
interface ErrorView { message: string; requestIdLabel: string }

export function OperationsPage(props: {
  audit: { kind: ViewKind; rows: ReadonlyArray<AuditLogRow & { readOnly: true }>; error: ErrorView | null; pagination: { hasNext: boolean; nextCursor: string | null } };
  jobs: { kind: ViewKind; rows: ReadonlyArray<FailedJobRow & { retry: { visible: boolean; enabled: boolean; state: string } }>; error: ErrorView | null; pagination: { hasNext: boolean; nextCursor: string | null } };
  policies: { kind: ViewKind; rows: ReadonlyArray<PolicySettingRow & { edit: { visible: boolean; enabled: boolean } }>; error: ErrorView | null };
  panelRepair: { visible: boolean; enabled: boolean };
  onReload: (section: 'audit' | 'jobs' | 'policies') => void;
  onNextAudit: (cursor: string) => void;
  onNextJobs: (cursor: string) => void;
  onRetryJob: (job: FailedJobRow) => void;
  onRepairPanel: () => void;
  onUpdatePolicy: (setting: PolicySettingRow) => void;
}) {
  return <section aria-labelledby="operations-title" style={{ padding: 24, minWidth: 0 }}>
    <h1 id="operations-title" style={{ fontSize: 24 }}>系统运营</h1>
    {props.panelRepair.visible && <section aria-labelledby="operations-panel-repair" style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #d9e1e3' }}>
      <h2 id="operations-panel-repair" style={{ fontSize: 18 }}>订单面板修复</h2>
      <button type="button" disabled={!props.panelRepair.enabled} onClick={props.onRepairPanel}>修复已删除面板</button>
    </section>}
    <OperationsSection title="审计记录" kind={props.audit.kind} error={props.audit.error} onReload={() => props.onReload('audit')}>
      {props.audit.kind === 'READY' && <DataTable rows={props.audit.rows} />}
      {props.audit.pagination.hasNext && props.audit.pagination.nextCursor && <button type="button" onClick={() => props.onNextAudit(props.audit.pagination.nextCursor!)}>下一页</button>}
    </OperationsSection>
    <OperationsSection title="失败任务" kind={props.jobs.kind} error={props.jobs.error} onReload={() => props.onReload('jobs')}>
      {props.jobs.kind === 'READY' && <DataTable rows={props.jobs.rows} actions={(row) => {
        const job = row as unknown as FailedJobRow & { retry: { visible: boolean; enabled: boolean } };
        return job.retry.visible ? <button type="button" disabled={!job.retry.enabled} onClick={() => props.onRetryJob(job)}>重试</button> : null;
      }} />}
      {props.jobs.pagination.hasNext && props.jobs.pagination.nextCursor && <button type="button" onClick={() => props.onNextJobs(props.jobs.pagination.nextCursor!)}>下一页</button>}
    </OperationsSection>
    <OperationsSection title="系统设置" kind={props.policies.kind} error={props.policies.error} onReload={() => props.onReload('policies')}>
      {props.policies.kind === 'READY' && <DataTable rows={props.policies.rows} actions={(row) => {
        const setting = row as unknown as PolicySettingRow & { edit: { visible: boolean; enabled: boolean } };
        return setting.edit.visible ? <button type="button" disabled={!setting.edit.enabled} onClick={() => props.onUpdatePolicy(setting)}>修改</button> : null;
      }} />}
    </OperationsSection>
  </section>;
}

function OperationsSection(props: { title: string; kind: ViewKind; error: ErrorView | null; onReload: () => void; children: React.ReactNode }) {
  return <section aria-labelledby={`operations-${props.title}`} style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #d9e1e3' }}>
    <h2 id={`operations-${props.title}`} style={{ fontSize: 18 }}>{props.title}</h2>
    {props.kind === 'FORBIDDEN' && <p>当前账号无权查看此区域。</p>}
    {props.kind === 'LOADING' && <p aria-busy="true">正在载入...</p>}
    {props.kind === 'EMPTY' && <p>当前没有记录。</p>}
    {props.kind === 'ERROR' && <div role="alert"><p>{props.error?.message ?? '载入失败。'} {props.error?.requestIdLabel ?? ''}</p><button type="button" onClick={props.onReload}>重试</button></div>}
    {props.children}
  </section>;
}

function DataTable<T extends object>(props: { rows: ReadonlyArray<T>; actions?: (row: T) => React.ReactNode }) {
  const columns = Array.from(new Set(props.rows.flatMap((row) => Object.keys(row)))).filter((key) => key !== 'readOnly' && key !== 'retry' && key !== 'edit');
  return <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
    <thead><tr>{columns.map((column) => <th key={column} scope="col" style={{ textAlign: 'left', padding: 8 }}>{column}</th>)}{props.actions && <th scope="col">操作</th>}</tr></thead>
    <tbody>{props.rows.map((row, index) => <tr key={typeof (row as Record<string, unknown>).id === 'string' ? String((row as Record<string, unknown>).id) : index}>
      {columns.map((column) => <td key={column} style={{ padding: 8, borderTop: '1px solid #d9e1e3' }}>{display((row as Record<string, unknown>)[column])}</td>)}
      {props.actions && <td style={{ borderTop: '1px solid #d9e1e3' }}>{props.actions(row)}</td>}
    </tr>)}</tbody>
  </table></div>;
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
