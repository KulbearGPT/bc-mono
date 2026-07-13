import { parseWalletBalanceDto, parseWalletEntryPageDto, type WalletBalanceDto, type WalletEntryDto, type WalletEntryPageDto } from '@blackcat/platform/api-contracts';

export type WalletBalance = WalletBalanceDto;
export type WalletEntry = WalletEntryDto;
export type WalletEntryPage = WalletEntryPageDto;
export interface WalletEvidenceFields { amountMinor:number;paymentChannel:string;externalTransactionId:string;occurredAt:string;note:string;reasonCode:string }
export interface WalletFundingSubmission extends WalletEvidenceFields { receipt:File|null }
export interface WalletAdjustmentSubmission { direction:'CREDIT'|'DEBIT';amountMinor:number;reversalOfEntryId:string;reason:string }

// The top-up receipt is denominated in USD; every internal wallet fact is CAT.
export const customerTokenDisplay={code:'CAT',catPerUsd:10} as const;

export function buildWalletRequest(kind:'TOP_UP'|'CASH_REFUND_DEBIT',userId:string,fields:WalletEvidenceFields,expectedWalletVersion?:number){
  const path=`/api/v1/admin/users/${encodeURIComponent(userId)}/${kind==='TOP_UP'?'top-ups':'external-refund-debits'}`;
  const body=kind==='TOP_UP'
    ? {paidAmountUsdCents:fields.amountMinor,paidCurrency:'USD' as const,paymentMethod:fields.paymentChannel,receiptNumber:fields.externalTransactionId,paidAt:fields.occurredAt,note:fields.note,reasonCode:fields.reasonCode}
    : {amountMinor:fields.amountMinor,paymentChannel:fields.paymentChannel,externalTransactionId:fields.externalTransactionId,refundedAt:fields.occurredAt,expectedWalletVersion,note:fields.note};
  return {method:'POST' as const,path,body};
}
export function walletPaths(userId:string){const encoded=encodeURIComponent(userId);return{balance:`/api/v1/admin/users/${encoded}/wallet`,entries:`/api/v1/admin/users/${encoded}/wallet/entries`,receipt:`/api/v1/admin/users/${encoded}/receipt-attachments`};}
export function formatWalletMoney(value:number){if(!Number.isSafeInteger(value))throw new TypeError('CAT amounts must use safe integer subunits.');return `${(value/10).toLocaleString('zh-CN',{minimumFractionDigits:1,maximumFractionDigits:1})} 猫条`;}
export function walletInputToSubunits(kind:'TOP_UP'|'CASH_REFUND_DEBIT'|'ADJUSTMENT',value:number){
  const scale=kind==='TOP_UP'?100:10;const minor=Math.round(value*scale);
  if(!Number.isSafeInteger(minor)||minor<1)throw new TypeError('Amount must be positive and use the supported precision.');return minor;
}
export function walletInputLabel(kind:'TOP_UP'|'CASH_REFUND_DEBIT'|'ADJUSTMENT'){
  return kind==='TOP_UP'?'实收金额（USD）':kind==='CASH_REFUND_DEBIT'?'扣回金额（CAT）':'冲正金额（CAT）';
}
export const parseWalletBalance = parseWalletBalanceDto;
export const parseWalletEntryPage = parseWalletEntryPageDto;
export function createWalletIdempotencyKey(kind:'TOP_UP'|'CASH_REFUND_DEBIT',userId:string){return `dashboard:wallet:${kind.toLowerCase()}:${userId}:${crypto.randomUUID()}`.slice(0,200);}
export function walletAdjustmentCandidates(entries:WalletEntry[]){return entries.filter((entry)=>!entry.entryType.startsWith('ADJUSTMENT_')&&!entry.reversalOfEntryId);}
export function buildWalletAdjustmentRequest(userId:string,fields:WalletAdjustmentSubmission,expectedWalletVersion:number){return{
  method:'POST' as const,path:`/api/v1/admin/users/${encodeURIComponent(userId)}/wallet-adjustments`,body:{entryType:`ADJUSTMENT_${fields.direction}` as 'ADJUSTMENT_CREDIT'|'ADJUSTMENT_DEBIT',amountMinor:fields.amountMinor,reversalOfEntryId:fields.reversalOfEntryId,reason:fields.reason.trim(),expectedWalletVersion}
};}
export function createWalletAdjustmentIdempotencyKey(userId:string){return `dashboard:wallet:adjustment:${userId}:${crypto.randomUUID()}`.slice(0,200);}
