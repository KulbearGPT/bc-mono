export interface WalletBalance { ledgerBalanceMinor:number;reservedMinor:number;availableMinor:number;currency:'CAT';calculatedAt:string;version:number }
export interface WalletEntry { id:string;entryType:string;direction:'CREDIT'|'DEBIT';amountMinor:number;currency:'CAT';sourceType:string;sourceId:string;occurredAt:string }
export interface WalletEvidenceFields { amountMinor:number;paymentChannel:string;externalTransactionId:string;occurredAt:string;note:string;reasonCode:string }
export interface WalletFundingSubmission extends WalletEvidenceFields { receipt:File|null }

export function buildWalletRequest(kind:'TOP_UP'|'CASH_REFUND_DEBIT',userId:string,fields:WalletEvidenceFields,expectedWalletVersion?:number){
  const path=`/api/v1/admin/users/${encodeURIComponent(userId)}/${kind==='TOP_UP'?'top-ups':'external-refund-debits'}`;
  const body=kind==='TOP_UP'
    ? {paidAmountUsdCents:fields.amountMinor,paidCurrency:'USD' as const,paymentMethod:fields.paymentChannel,receiptNumber:fields.externalTransactionId,paidAt:fields.occurredAt,note:fields.note,reasonCode:fields.reasonCode}
    : {amountMinor:fields.amountMinor,paymentChannel:fields.paymentChannel,externalTransactionId:fields.externalTransactionId,refundedAt:fields.occurredAt,expectedWalletVersion,note:fields.note};
  return {method:'POST' as const,path,body};
}
export function walletPaths(userId:string){const encoded=encodeURIComponent(userId);return{balance:`/api/v1/admin/users/${encoded}/wallet`,entries:`/api/v1/admin/users/${encoded}/wallet/entries`,receipt:`/api/v1/admin/users/${encoded}/receipt-attachments`};}
export function formatWalletMoney(value:number){return `${(value/10).toLocaleString('zh-CN',{minimumFractionDigits:1,maximumFractionDigits:1})} 猫条`;}
export function createWalletIdempotencyKey(kind:'TOP_UP'|'CASH_REFUND_DEBIT',userId:string){return `dashboard:wallet:${kind.toLowerCase()}:${userId}:${crypto.randomUUID()}`.slice(0,200);}
