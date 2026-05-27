import { useState,type FormEvent } from 'react';
import { formatWalletMoney,type WalletBalance,type WalletEntry,type WalletFundingSubmission } from './customer-wallet.js';

export function CustomerWalletPanel(props:{userId:string;balance:WalletBalance;entries:WalletEntry[];busy:boolean;
  onTopUp:(value:WalletFundingSubmission)=>void|Promise<void>;onExternalRefund:(value:WalletFundingSubmission)=>void|Promise<void>}){
  const [kind,setKind]=useState<'TOP_UP'|'EXTERNAL_REFUND_DEBIT'>('TOP_UP');
  function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const data=new FormData(event.currentTarget);const receipt=data.get('receipt');const value:WalletFundingSubmission={
    amountMinor:Math.round(Number(data.get('amount'))*100),paymentChannel:String(data.get('paymentChannel')??''),externalTransactionId:String(data.get('externalTransactionId')??''),
    occurredAt:new Date(String(data.get('occurredAt')??'')).toISOString(),note:String(data.get('note')??''),receipt:receipt instanceof File&&receipt.size>0?receipt:null};
    void(kind==='TOP_UP'?props.onTopUp(value):props.onExternalRefund(value));
  }
  return <section className="wallet-panel" aria-label="客户钱包">
    <div className="wallet-balance-grid"><Metric label="账本余额" value={props.balance.ledgerBalanceMinor}/><Metric label="已预留" value={props.balance.reservedMinor}/><Metric label="可用余额" value={props.balance.availableMinor}/></div>
    <div role="group" aria-label="资金操作" className="wallet-tabs"><button type="button" aria-pressed={kind==='TOP_UP'} onClick={()=>setKind('TOP_UP')}>充值</button><button type="button" aria-pressed={kind==='EXTERNAL_REFUND_DEBIT'} onClick={()=>setKind('EXTERNAL_REFUND_DEBIT')}>渠道退款扣款</button></div>
    <form onSubmit={submit} className="wallet-form">
      <label>金额（USD）<input name="amount" type="number" min="0.01" step="0.01" required disabled={props.busy}/></label>
      <p>到账后按 1 USD = 10 MB 发放。</p>
      <label>支付渠道<input name="paymentChannel" required maxLength={50} disabled={props.busy}/></label>
      <label>渠道交易号<input name="externalTransactionId" required maxLength={200} disabled={props.busy}/></label>
      <label>{kind==='TOP_UP'?'付款时间':'退款时间'}<input name="occurredAt" type="datetime-local" required disabled={props.busy}/></label>
      <label>备注<textarea name="note" required maxLength={1000} disabled={props.busy}/></label>
      <label>Receipt 图片或 PDF（可选）<input name="receipt" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={props.busy}/></label>
      <button type="submit" disabled={props.busy}>{props.busy?'处理中…':kind==='TOP_UP'?'确认充值':'确认扣款'}</button>
    </form>
    <h3>钱包流水</h3>{props.entries.length?<div className="wallet-entry-scroll"><table><thead><tr><th>类型</th><th>方向</th><th>金额</th><th>时间</th></tr></thead><tbody>{props.entries.map(entry=><tr key={entry.id}><td>{entry.entryType}</td><td>{entry.direction}</td><td>{formatWalletMoney(entry.amountMinor)}</td><td>{new Date(entry.occurredAt).toLocaleString('zh-CN')}</td></tr>)}</tbody></table></div>:<p>暂无钱包流水。</p>}
  </section>;
}
function Metric(props:{label:string;value:number}){return <div><span>{props.label}</span><strong>{formatWalletMoney(props.value)}</strong></div>}
