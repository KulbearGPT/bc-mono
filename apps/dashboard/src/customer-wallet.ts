export interface WalletBalance { ledgerBalanceMinor:number;reservedMinor:number;availableMinor:number;currency:'USD';calculatedAt:string;version:number }
export interface WalletEntry { id:string;entryType:string;direction:'CREDIT'|'DEBIT';amountMinor:number;currency:'USD';sourceType:string;sourceId:string;occurredAt:string }
export interface WalletEvidenceFields { amountMinor:number;paymentChannel:string;externalTransactionId:string;occurredAt:string;note:string }
export interface WalletFundingSubmission extends WalletEvidenceFields { receipt:File|null }

export function buildWalletRequest(kind:'TOP_UP'|'EXTERNAL_REFUND_DEBIT',userId:string,fields:WalletEvidenceFields,expectedWalletVersion?:number){
  const path=`/api/v1/admin/users/${encodeURIComponent(userId)}/${kind==='TOP_UP'?'top-ups':'external-refund-debits'}`;
  const timestamp=kind==='TOP_UP'?{paidAt:fields.occurredAt}:{refundedAt:fields.occurredAt,expectedWalletVersion};
  return {method:'POST' as const,path,body:{amountMinor:fields.amountMinor,paymentChannel:fields.paymentChannel,externalTransactionId:fields.externalTransactionId,...timestamp,note:fields.note}};
}
export function walletPaths(userId:string){const encoded=encodeURIComponent(userId);return{balance:`/api/v1/admin/users/${encoded}/wallet`,entries:`/api/v1/admin/users/${encoded}/wallet/entries`,receipt:`/api/v1/admin/users/${encoded}/receipt-attachments`};}
export function formatWalletMoney(value:number){return `USD\u00a0${(value/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;}
export function createWalletIdempotencyKey(kind:'TOP_UP'|'EXTERNAL_REFUND_DEBIT',userId:string){return `dashboard:wallet:${kind.toLowerCase()}:${userId}:${crypto.randomUUID()}`.slice(0,200);}
