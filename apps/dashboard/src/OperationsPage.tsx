import type { AuditLogRow, FailedJobRow, PolicySettingRow } from './operations.js';
import { dashboardFieldLabel } from './table-labels.js';

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
  return <section className="dashboard-page" aria-labelledby="operations-title">
    <header className="page-heading"><div><span className="page-eyebrow">SYSTEM OPS</span><h1 id="operations-title">系统运营</h1><p>集中查看审计、失败任务与服务端策略事实。</p></div></header>
    {props.panelRepair.visible && <section className="content-panel operations-repair" aria-labelledby="operations-panel-repair">
      <div className="section-title-row"><div><h2 id="operations-panel-repair">订单面板修复</h2><p>仅为已删除的 Discord 订单面板创建恢复任务。</p></div><button className="button-primary" type="button" disabled={!props.panelRepair.enabled} onClick={props.onRepairPanel}>修复已删除面板</button></div>
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
  return <section className="content-panel page-section" aria-labelledby={`operations-${props.title}`}>
    <div className="section-title-row"><h2 id={`operations-${props.title}`}>{props.title}</h2>{props.kind === 'ERROR' && <button type="button" onClick={props.onReload}>重试</button>}</div>
    {props.kind === 'FORBIDDEN' && <div className="state-card state-card--compact"><p>当前账号无权查看此区域。</p></div>}
    {props.kind === 'LOADING' && <div className="state-card state-card--compact" aria-busy="true">正在载入...</div>}
    {props.kind === 'EMPTY' && <div className="state-card state-card--compact">当前没有记录。</div>}
    {props.kind === 'ERROR' && <div className="state-card state-card--compact state-card--error" role="alert"><p>{props.error?.message ?? '载入失败。'} {props.error?.requestIdLabel ?? ''}</p></div>}
    {props.children}
  </section>;
}

function DataTable<T extends object>(props: { rows: ReadonlyArray<T>; actions?: (row: T) => React.ReactNode }) {
  const columns = Array.from(new Set(props.rows.flatMap((row) => Object.keys(row)))).filter((key) => key !== 'readOnly' && key !== 'retry' && key !== 'edit');
  return <div className="table-scroll"><table className="data-table">
    <thead><tr>{columns.map((column) => <th className={column.toLowerCase() === 'id' ? 'data-column--id' : undefined} key={column} scope="col" title={column}>{dashboardFieldLabel(column)}</th>)}{props.actions && <th className="data-column--actions" scope="col" title="actions">操作</th>}</tr></thead>
    <tbody>{props.rows.map((row, index) => <tr key={typeof (row as Record<string, unknown>).id === 'string' ? String((row as Record<string, unknown>).id) : index}>
      {columns.map((column) => <td className={column.toLowerCase() === 'id' ? 'data-column--id' : undefined} key={column}>{display((row as Record<string, unknown>)[column])}</td>)}
      {props.actions && <td className="table-actions"><div className="table-actions__group">{props.actions(row)}</div></td>}
    </tr>)}</tbody>
  </table></div>;
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
