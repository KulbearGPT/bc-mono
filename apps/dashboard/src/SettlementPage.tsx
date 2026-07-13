import { useState } from 'react';
import { AlertTriangle, Check, Download, Eye, FileText, Play, RefreshCw, Send, XCircle } from 'lucide-react';
import { formatMinorCurrency } from './admin-business.js';
import type { SettlementAction, SettlementPageModel } from './settlements.js';

export function SettlementPage(props: { model: SettlementPageModel; onRetry: () => void;
  onAction: (action: SettlementAction, item?: Record<string, unknown>, fields?: Record<string, unknown>) => void }) {
  const [period, setPeriod] = useState({ periodStart: '', periodEnd: '', cutoffAt: '', timeZone: 'Asia/Shanghai', currency: 'CAT' });
  const title = props.model.section === 'settlements' ? '周期结算' : '周期周报';
  if (props.model.kind === 'FORBIDDEN') return <section className="dashboard-page"><header className="page-heading"><div><span className="page-eyebrow">SETTLEMENTS</span><h1>{title}</h1><p>当前账户没有此工作区权限。</p></div></header></section>;
  return <section className="dashboard-page settlement-page">
    <header className="page-heading">
      <div><span className="page-eyebrow">{props.model.section === 'settlements' ? 'SETTLEMENTS' : 'WEEKLY REPORTS'}</span><h1>{title}</h1><p>{props.model.section === 'settlements' ? '复核批次、导出清单并登记第三方支付结果。' : '查看个人与店铺周报的当前修订。'}</p></div>
      <button title="刷新" aria-label="刷新" onClick={props.onRetry}><RefreshCw size={16} /></button>
    </header>
    {props.model.section === 'settlements' && props.model.actions.includes('PREVIEW') && <form className="content-panel form-grid form-grid--compact settlement-builder" onSubmit={(event) => event.preventDefault()}>
      {(['periodStart','periodEnd','cutoffAt'] as const).map((key) => <label className="field" key={key}><span>{key === 'periodStart' ? '周期开始' : key === 'periodEnd' ? '周期结束' : '截止时间'}</span><input type="datetime-local" value={period[key]} onChange={(event) => setPeriod({ ...period, [key]: event.target.value })} /></label>)}
      <label className="field"><span>币种</span><select value={period.currency} onChange={(event) => setPeriod({ ...period, currency: event.target.value })}><option value="CAT">CAT</option></select></label>
      <div className="form-actions"><button onClick={() => props.onAction('PREVIEW', undefined, isoPeriod(period))}><Eye size={16} />预览</button><button className="button-primary" onClick={() => props.onAction('CREATE', undefined, isoPeriod(period))}><Play size={16} />生成</button></div>
    </form>}
    {props.model.alert && <p className="state-card state-card--compact state-card--warning settlement-alert"><AlertTriangle size={16} />{props.model.alert}</p>}
    {props.model.kind === 'LOADING' && <div className="state-card">正在载入...</div>}
    {props.model.kind === 'ERROR' && <div className="state-card state-card--error"><strong>载入失败</strong><p>request_id: {props.model.requestId ?? '—'}</p></div>}
    {props.model.kind === 'EMPTY' && <div className="state-card">{props.model.emptyMessage ?? `暂无${props.model.section === 'settlements' ? '结算批次' : '周报'}。`}</div>}
    {props.model.kind === 'READY' && <div className="table-scroll content-panel content-panel--flush"><table className="data-table settlement-table"><thead><tr>{['编号','状态','周期','应付 CAT / 实付 USD','修订/版本','操作'].map((label) => <th className={label === '操作' ? 'data-column--actions' : undefined} key={label}>{label}</th>)}</tr></thead><tbody>{props.model.items.map((item) => <tr key={String(item.id)}><td>{String(item.publicId ?? item.id)}</td><td>{String(item.status ?? '—')}</td><td>{date(item.periodStart)}<br />{date(item.periodEnd)}</td><td>{formatSettlementPayout(settlementAmount(item))}</td><td>{String(item.version ?? item.currentRevision ?? '—')}</td><td className="table-actions"><div className="table-actions__group"><RowActions model={props.model} item={item} onAction={props.onAction} /></div></td></tr>)}</tbody></table></div>}
  </section>;
}

function RowActions({ model, item, onAction }: { model: SettlementPageModel; item: Record<string, unknown>; onAction: (action: SettlementAction, item?: Record<string, unknown>, fields?: Record<string, unknown>) => void }) {
  const [showPaymentEditor, setShowPaymentEditor] = useState(false);
  const [paymentDrafts, setPaymentDrafts] = useState<Record<string, PaymentDraft>>({});
  if (model.section === 'reports') return <button onClick={() => onAction('EXPORT', item, { exportType: 'CURRENT' })}><Download size={15} />CSV</button>;
  const status = String(item.status); const actions: Array<[SettlementAction, string, typeof Send]> = [];
  if (status === 'DRAFT' && model.actions.includes('SUBMIT')) actions.push(['SUBMIT','提交复核',Send]);
  if (status === 'PENDING_REVIEW' && model.actions.includes('APPROVE')) actions.push(['APPROVE','批准',Check]);
  if (['APPROVED','EXPORTED','PARTIALLY_PAID'].includes(status) && model.actions.includes('EXPORT')) actions.push(['EXPORT','清单',Download]);
  if (['APPROVED','EXPORTED','PARTIALLY_PAID'].includes(status) && model.actions.includes('PAYMENT_RESULTS')) actions.push(['PAYMENT_RESULTS','登记结果',FileText]);
  if (model.actions.includes('VOID') && ['DRAFT','PENDING_REVIEW','APPROVED','EXPORTED'].includes(status)) actions.push(['VOID','作废',XCircle]);
  const unpaidItems = Array.isArray(item.items) ? item.items.filter((value) => (value as Record<string, unknown>).paymentStatus !== 'SUCCEEDED') as Record<string, unknown>[] : [];
  const results = unpaidItems.flatMap((row) => {
    const draft = paymentDrafts[String(row.id)];
    if (!draft?.result) return [];
    return [{ settlementItemId: row.id, expectedVersion: row.version, result: draft.result,
      amountMinor: draft.result === 'SUCCEEDED' ? Number(row.netAmountMinor ?? 0) : 0, currency: item.currency,
      externalBatchReference: draft.externalBatchReference, note: draft.note }];
  });
  const canSubmitResults = results.length > 0 && results.every((result) => result.externalBatchReference.trim() || result.note.trim());
  return <div className="row-action-stack">
    <div className="inline-actions">{actions.map(([action,label,Icon]) => <button key={action} type="button" onClick={() => {
      if (action === 'PAYMENT_RESULTS') setShowPaymentEditor((visible) => !visible);
      else onAction(action, item, defaultFields(action));
    }}><Icon size={15} />{label}</button>)}</div>
    {showPaymentEditor && <div className="payment-editor">
      {unpaidItems.length === 0 && <span>没有待登记的结算条目。</span>}
      {unpaidItems.map((row) => {
        const id = String(row.id); const draft = paymentDrafts[id] ?? emptyPaymentDraft;
        const update = (fields: Partial<PaymentDraft>) => setPaymentDrafts((current) => ({ ...current, [id]: { ...draft, ...fields } }));
        return <fieldset className="payment-editor__item" key={id}>
          <legend>{String(row.playerDisplayName ?? row.externalAccountDisplay ?? row.id)} · {formatSettlementPayout(Number(row.netAmountMinor ?? 0))}</legend>
          <label className="field"><span>付款结果</span><select value={draft.result} onChange={(event) => update({ result: event.target.value as PaymentDraft['result'] })}>
            <option value="">请选择结果</option><option value="SUCCEEDED">已支付</option><option value="FAILED">支付失败</option>
          </select></label>
          <label className="field"><span>第三方批次号</span><input value={draft.externalBatchReference} onChange={(event) => update({ externalBatchReference: event.target.value })} placeholder="成功时建议填写" /></label>
          <label className="field"><span>登记说明</span><input value={draft.note} onChange={(event) => update({ note: event.target.value })} placeholder="失败原因或人工核对说明" /></label>
        </fieldset>;
      })}
      <div className="inline-actions"><button className="button-primary" type="button" disabled={!canSubmitResults}
        onClick={() => onAction('PAYMENT_RESULTS', item, { results })}><Check size={15} />确认登记</button></div>
    </div>}
  </div>;
}
function date(value: unknown) { return typeof value === 'string' ? new Date(value).toLocaleString('zh-CN') : '—'; }
function settlementAmount(item: Record<string, unknown>) { const metrics = item.metrics && typeof item.metrics === 'object' ? item.metrics as Record<string, unknown> : null;
  return Number(item.netAmountMinor ?? metrics?.netPayableMinor ?? 0); }
export function formatSettlementPayout(amountMinor: number): string {
  const usd = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', currencyDisplay: 'code' }).format(amountMinor / 100);
  return `${formatMinorCurrency(amountMinor, 'CAT')} · ${usd}`;
}
function isoPeriod(period: Record<string, string>) { const convert = (value: string) => value ? new Date(value).toISOString() : value; return { ...period,
  periodStart: convert(period.periodStart), periodEnd: convert(period.periodEnd), cutoffAt: convert(period.cutoffAt) }; }
function defaultFields(action: SettlementAction) { if (action === 'EXPORT') return { exportType: 'TRANSFER_LIST' };
  return { reasonCode: action === 'VOID' ? 'OPERATIONS_VOID' : 'WEEKLY_REVIEW' }; }

type PaymentDraft = { result: '' | 'SUCCEEDED' | 'FAILED'; externalBatchReference: string; note: string };
const emptyPaymentDraft: PaymentDraft = { result: '', externalBatchReference: '', note: '' };
