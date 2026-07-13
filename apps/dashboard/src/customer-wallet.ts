export interface WalletBalance { ledgerBalanceMinor:number;reservedMinor:number;availableMinor:number;currency:'USD';calculatedAt:string;version:number }
export interface WalletEntry { id:string;entryType:string;direction:'CREDIT'|'DEBIT';amountMinor:number;currency:'USD';sourceType:string;sourceId:string;reversalOfEntryId?:string|null;occurredAt:string }
export interface WalletEvidenceFields { amountMinor:number;paymentChannel:string;externalTransactionId:string;occurredAt:string;note:string;reasonCode:string }
export interface WalletFundingSubmission extends WalletEvidenceFields { receipt:File|null }
export interface WalletAdjustmentSubmission { direction:'CREDIT'|'DEBIT';amountMinor:number;reversalOfEntryId:string;reason:string }

// Customer-facing surfaces may display the fixed CAT issuance rate, while the
// staff Dashboard continues to read and write only the canonical USD ledger.
export const customerTokenDisplay={code:'CAT',catPerUsd:10} as const;

export function buildWalletRequest(kind:'TOP_UP'|'CASH_REFUND_DEBIT',userId:string,fields:WalletEvidenceFields,expectedWalletVersion?:number){
  const path=`/api/v1/admin/users/${encodeURIComponent(userId)}/${kind==='TOP_UP'?'top-ups':'external-refund-debits'}`;
  const body=kind==='TOP_UP'
    ? {paidAmountUsdCents:fields.amountMinor,paidCurrency:'USD' as const,paymentMethod:fields.paymentChannel,receiptNumber:fields.externalTransactionId,paidAt:fields.occurredAt,note:fields.note,reasonCode:fields.reasonCode}
    : {amountMinor:fields.amountMinor,paymentChannel:fields.paymentChannel,externalTransactionId:fields.externalTransactionId,refundedAt:fields.occurredAt,expectedWalletVersion,note:fields.note};
  return {method:'POST' as const,path,body};
}
export function walletPaths(userId:string){const encoded=encodeURIComponent(userId);return{balance:`/api/v1/admin/users/${encoded}/wallet`,entries:`/api/v1/admin/users/${encoded}/wallet/entries`,receipt:`/api/v1/admin/users/${encoded}/receipt-attachments`};}
export function formatWalletMoney(value:number){return new Intl.NumberFormat('zh-CN',{style:'currency',currency:'USD',currencyDisplay:'code'}).format(value/100);}
export function createWalletIdempotencyKey(kind:'TOP_UP'|'CASH_REFUND_DEBIT',userId:string){return `dashboard:wallet:${kind.toLowerCase()}:${userId}:${crypto.randomUUID()}`.slice(0,200);}
export function walletAdjustmentCandidates(entries:WalletEntry[]){return entries.filter((entry)=>!entry.entryType.startsWith('ADJUSTMENT_')&&!entry.reversalOfEntryId);}
export function buildWalletAdjustmentRequest(userId:string,fields:WalletAdjustmentSubmission,expectedWalletVersion:number){return{
  method:'POST' as const,path:`/api/v1/admin/users/${encodeURIComponent(userId)}/wallet-adjustments`,body:{entryType:`ADJUSTMENT_${fields.direction}` as 'ADJUSTMENT_CREDIT'|'ADJUSTMENT_DEBIT',amountMinor:fields.amountMinor,reversalOfEntryId:fields.reversalOfEntryId,reason:fields.reason.trim(),expectedWalletVersion}
};}
export function createWalletAdjustmentIdempotencyKey(userId:string){return `dashboard:wallet:adjustment:${userId}:${crypto.randomUUID()}`.slice(0,200);}
