import { useState,type FormEvent } from 'react';
import { formatWalletMoney,walletAdjustmentCandidates,type WalletAdjustmentSubmission,type WalletBalance,type WalletEntry,type WalletFundingSubmission } from './customer-wallet.js';

export function CustomerWalletPanel(props:{userId:string;balance:WalletBalance;entries:WalletEntry[];busy:boolean;
  onTopUp:(value:WalletFundingSubmission)=>void|Promise<void>;onExternalRefund:(value:WalletFundingSubmission)=>void|Promise<void>;canAdjust?:boolean;onAdjustment?:(value:WalletAdjustmentSubmission)=>void|Promise<void>}){
  const [kind,setKind]=useState<'TOP_UP'|'CASH_REFUND_DEBIT'|'ADJUSTMENT'>('TOP_UP');
  function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const data=new FormData(event.currentTarget);
    if(kind==='ADJUSTMENT'){void props.onAdjustment?.({direction:String(data.get('direction')) as 'CREDIT'|'DEBIT',amountMinor:Math.round(Number(data.get('amount'))*100),reversalOfEntryId:String(data.get('reversalOfEntryId')??''),reason:String(data.get('reason')??'')});return;}
    const receipt=data.get('receipt');const value:WalletFundingSubmission={
    amountMinor:Math.round(Number(data.get('amount'))*100),paymentChannel:String(data.get('paymentChannel')??''),externalTransactionId:String(data.get('externalTransactionId')??''),
    occurredAt:new Date(String(data.get('occurredAt')??'')).toISOString(),note:String(data.get('note')??''),reasonCode:String(data.get('reasonCode')??''),receipt:receipt instanceof File&&receipt.size>0?receipt:null};
    void(kind==='TOP_UP'?props.onTopUp(value):props.onExternalRefund(value));
  }
  return <section className="wallet-panel" aria-label="客户钱包">
    <div className="wallet-balance-grid"><Metric label="账本余额" value={props.balance.ledgerBalanceMinor}/><Metric label="已预留" value={props.balance.reservedMinor}/><Metric label="可用余额" value={props.balance.availableMinor}/></div>
    <div role="group" aria-label="资金操作" className="wallet-tabs"><button type="button" aria-pressed={kind==='TOP_UP'} onClick={()=>setKind('TOP_UP')}>充值</button><button type="button" aria-pressed={kind==='CASH_REFUND_DEBIT'} onClick={()=>setKind('CASH_REFUND_DEBIT')}>渠道退款扣款</button>{props.canAdjust&&<button type="button" aria-pressed={kind==='ADJUSTMENT'} onClick={()=>setKind('ADJUSTMENT')}>账目冲正</button>}</div>
    <form onSubmit={submit} className="wallet-form">
      {kind==='ADJUSTMENT'?<>
        <p>冲正只追加新流水，原账目保持不变。金额始终使用 canonical USD。</p>
        <label>原始账目<select name="reversalOfEntryId" required disabled={props.busy}>{walletAdjustmentCandidates(props.entries).map((entry)=><option key={entry.id} value={entry.id}>{entry.entryType} · {formatWalletMoney(entry.amountMinor)} · {new Date(entry.occurredAt).toLocaleString('zh-CN')}</option>)}</select></label>
        <label>冲正方向<select name="direction" required disabled={props.busy}><option value="DEBIT">扣减多记金额</option><option value="CREDIT">补回少记金额</option></select></label>
        <label>冲正金额（USD）<input name="amount" type="number" min="0.01" step="0.01" required disabled={props.busy}/></label>
        <label>冲正原因<textarea name="reason" required minLength={3} maxLength={1000} disabled={props.busy}/></label>
      </>:<>
      <label>{kind==='TOP_UP'?'实收金额（USD）':'扣回金额（USD）'}<input name="amount" type="number" min="0.01" step="0.01" required disabled={props.busy}/></label>
      {kind==='TOP_UP'&&<p>员工后台只登记并显示 canonical USD 账本事实。</p>}
      <label>支付方式<select name="paymentChannel" required disabled={props.busy}><option value="ZELLE">Zelle</option><option value="PAYPAL">PayPal</option><option value="BANK_TRANSFER">银行转账</option><option value="CASH">现金</option><option value="OTHER">其他</option></select></label>
      <label>收据号 / 渠道交易号<input name="externalTransactionId" required maxLength={200} disabled={props.busy}/></label>
      <label>{kind==='TOP_UP'?'付款时间':'退款时间'}<input name="occurredAt" type="datetime-local" required disabled={props.busy}/></label>
      <label>备注<textarea name="note" required maxLength={1000} disabled={props.busy}/></label>
      <label>原因代码<input name="reasonCode" defaultValue={kind==='TOP_UP'?'MANUAL_TOP_UP':'CASH_REFUND'} required maxLength={80} disabled={props.busy}/></label>
      <label>Receipt 图片或 PDF（可选）<input name="receipt" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={props.busy}/></label>
      </>}
      <button type="submit" disabled={props.busy||kind==='ADJUSTMENT'&&walletAdjustmentCandidates(props.entries).length===0}>{props.busy?'处理中…':kind==='TOP_UP'?'确认充值':kind==='CASH_REFUND_DEBIT'?'确认扣款':'追加冲正'}</button>
    </form>
    <h3>钱包流水</h3>{props.entries.length?<div className="wallet-entry-scroll"><table><thead><tr><th>类型</th><th>方向</th><th>金额</th><th>原始账目</th><th>时间</th></tr></thead><tbody>{props.entries.map(entry=><tr key={entry.id}><td>{entry.entryType}</td><td>{entry.direction}</td><td>{formatWalletMoney(entry.amountMinor)}</td><td>{entry.reversalOfEntryId??'—'}</td><td>{new Date(entry.occurredAt).toLocaleString('zh-CN')}</td></tr>)}</tbody></table></div>:<p>暂无钱包流水。</p>}
  </section>;
}
function Metric(props:{label:string;value:number}){return <div><span>{props.label}</span><strong>{formatWalletMoney(props.value)}</strong></div>}
