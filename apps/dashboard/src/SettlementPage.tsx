import { useState } from 'react';
import { AlertTriangle, Check, Download, Eye, FileText, Play, RefreshCw, Send, XCircle } from 'lucide-react';
import { formatMinorCurrency } from './admin-business.js';
import type { SettlementAction, SettlementPageModel } from './settlements.js';

const panel = { background: '#fff', border: '1px solid #d8e1e3', borderRadius: 6, padding: 16 } as const;
const button = { border: '1px solid #9aabad', background: '#fff', color: '#173238', borderRadius: 6, padding: '8px 10px', display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' } as const;

export function SettlementPage(props: { model: SettlementPageModel; onRetry: () => void;
  onAction: (action: SettlementAction, item?: Record<string, unknown>, fields?: Record<string, unknown>) => void }) {
  const [period, setPeriod] = useState({ periodStart: '', periodEnd: '', cutoffAt: '', timeZone: 'Asia/Shanghai', currency: 'CNY' });
  const title = props.model.section === 'settlements' ? '周期结算' : '周期周报';
  if (props.model.kind === 'FORBIDDEN') return <section style={{ padding: 24 }}><h1>{title}</h1><p>当前账户没有此工作区权限。</p></section>;
  return <section style={{ padding: 24, minWidth: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }}>
    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
      <div><h1 style={{ margin: 0, fontSize: 24 }}>{title}</h1><p style={{ margin: '6px 0 0', color: '#587075' }}>{props.model.section === 'settlements' ? '复核批次、导出清单并登记第三方支付结果。' : '查看个人与店铺周报的当前修订。'}</p></div>
      <button title="刷新" aria-label="刷新" style={button} onClick={props.onRetry}><RefreshCw size={16} /></button>
    </header>
    {props.model.section === 'settlements' && props.model.actions.includes('PREVIEW') && <form style={{ ...panel, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, marginBottom: 16 }} onSubmit={(event) => event.preventDefault()}>
      {(['periodStart','periodEnd','cutoffAt'] as const).map((key) => <label key={key} style={{ display: 'grid', gap: 5, minWidth: 0 }}>{key === 'periodStart' ? '周期开始' : key === 'periodEnd' ? '周期结束' : '截止时间'}<input type="datetime-local" value={period[key]} onChange={(event) => setPeriod({ ...period, [key]: event.target.value })} /></label>)}
      <label style={{ display: 'grid', gap: 5 }}>币种<select value={period.currency} onChange={(event) => setPeriod({ ...period, currency: event.target.value })}><option>CNY</option></select></label>
      <div style={{ display: 'flex', alignItems: 'end', gap: 8, flexWrap: 'wrap' }}><button style={button} onClick={() => props.onAction('PREVIEW', undefined, isoPeriod(period))}><Eye size={16} />预览</button><button style={{ ...button, background: '#173238', color: '#fff' }} onClick={() => props.onAction('CREATE', undefined, isoPeriod(period))}><Play size={16} />生成</button></div>
    </form>}
    {props.model.alert && <p style={{ ...panel, borderColor: '#d6a343', color: '#754d00' }}><AlertTriangle size={16} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />{props.model.alert}</p>}
    {props.model.kind === 'LOADING' && <div style={panel}>正在载入...</div>}
    {props.model.kind === 'ERROR' && <div style={panel}><strong>载入失败</strong><p>request_id: {props.model.requestId ?? '—'}</p></div>}
    {props.model.kind === 'EMPTY' && <div style={panel}>暂无{props.model.section === 'settlements' ? '结算批次' : '周报'}。</div>}
    {props.model.kind === 'READY' && <div style={{ ...panel, padding: 0, overflowX: 'auto' }}><table style={{ width: '100%', minWidth: 820, borderCollapse: 'collapse' }}><thead><tr>{['编号','状态','周期','金额','修订/版本','操作'].map((label) => <th key={label} style={cell}>{label}</th>)}</tr></thead><tbody>{props.model.items.map((item) => <tr key={String(item.id)}><td style={cell}>{String(item.publicId ?? item.id)}</td><td style={cell}>{String(item.status ?? '—')}</td><td style={cell}>{date(item.periodStart)}<br />{date(item.periodEnd)}</td><td style={cell}>{formatMinorCurrency(settlementAmount(item), String(item.currency ?? 'CNY'))}</td><td style={cell}>{String(item.version ?? item.currentRevision ?? '—')}</td><td style={cell}><RowActions model={props.model} item={item} onAction={props.onAction} /></td></tr>)}</tbody></table></div>}
  </section>;
}

function RowActions({ model, item, onAction }: { model: SettlementPageModel; item: Record<string, unknown>; onAction: (action: SettlementAction, item?: Record<string, unknown>, fields?: Record<string, unknown>) => void }) {
  const [showPaymentEditor, setShowPaymentEditor] = useState(false);
  const [paymentDrafts, setPaymentDrafts] = useState<Record<string, PaymentDraft>>({});
  if (model.section === 'reports') return <button style={button} onClick={() => onAction('EXPORT', item, { exportType: 'CURRENT' })}><Download size={15} />CSV</button>;
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
  return <div style={{ display: 'grid', gap: 8, minWidth: 260 }}>
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{actions.map(([action,label,Icon]) => <button key={action} type="button" style={button} onClick={() => {
      if (action === 'PAYMENT_RESULTS') setShowPaymentEditor((visible) => !visible);
      else onAction(action, item, defaultFields(action));
    }}><Icon size={15} />{label}</button>)}</div>
    {showPaymentEditor && <div style={{ ...panel, padding: 10, display: 'grid', gap: 10, minWidth: 360 }}>
      {unpaidItems.length === 0 && <span>没有待登记的结算条目。</span>}
      {unpaidItems.map((row) => {
        const id = String(row.id); const draft = paymentDrafts[id] ?? emptyPaymentDraft;
        const update = (fields: Partial<PaymentDraft>) => setPaymentDrafts((current) => ({ ...current, [id]: { ...draft, ...fields } }));
        return <fieldset key={id} style={{ border: '1px solid #d8e1e3', borderRadius: 6, padding: 10, display: 'grid', gap: 7 }}>
          <legend>{String(row.playerDisplayName ?? row.externalAccountDisplay ?? row.id)}</legend>
          <label style={{ display: 'grid', gap: 4 }}>付款结果<select value={draft.result} onChange={(event) => update({ result: event.target.value as PaymentDraft['result'] })}>
            <option value="">请选择结果</option><option value="SUCCEEDED">已支付</option><option value="FAILED">支付失败</option>
          </select></label>
          <label style={{ display: 'grid', gap: 4 }}>第三方批次号<input value={draft.externalBatchReference} onChange={(event) => update({ externalBatchReference: event.target.value })} placeholder="成功时建议填写" /></label>
          <label style={{ display: 'grid', gap: 4 }}>登记说明<input value={draft.note} onChange={(event) => update({ note: event.target.value })} placeholder="失败原因或人工核对说明" /></label>
        </fieldset>;
      })}
      <div><button type="button" style={{ ...button, opacity: canSubmitResults ? 1 : 0.55 }} disabled={!canSubmitResults}
        onClick={() => onAction('PAYMENT_RESULTS', item, { results })}><Check size={15} />确认登记</button></div>
    </div>}
  </div>;
}
const cell = { textAlign: 'left', padding: '11px 12px', borderBottom: '1px solid #e4eaeb', fontSize: 13, verticalAlign: 'top' } as const;
function date(value: unknown) { return typeof value === 'string' ? new Date(value).toLocaleString('zh-CN') : '—'; }
function settlementAmount(item: Record<string, unknown>) { const metrics = item.metrics && typeof item.metrics === 'object' ? item.metrics as Record<string, unknown> : null;
  return Number(item.netAmountMinor ?? metrics?.netPayableMinor ?? 0); }
function isoPeriod(period: Record<string, string>) { const convert = (value: string) => value ? new Date(value).toISOString() : value; return { ...period,
  periodStart: convert(period.periodStart), periodEnd: convert(period.periodEnd), cutoffAt: convert(period.cutoffAt) }; }
function defaultFields(action: SettlementAction) { if (action === 'EXPORT') return { exportType: 'TRANSFER_LIST' };
  return { reasonCode: action === 'VOID' ? 'OPERATIONS_VOID' : 'WEEKLY_REVIEW' }; }

type PaymentDraft = { result: '' | 'SUCCEEDED' | 'FAILED'; externalBatchReference: string; note: string };
const emptyPaymentDraft: PaymentDraft = { result: '', externalBatchReference: '', note: '' };
