export interface WalletBalance { ledgerBalanceMinor:number;reservedMinor:number;availableMinor:number;currency:'CAT';calculatedAt:string;version:number }
export interface WalletEntry { id:string;entryType:string;direction:'CREDIT'|'DEBIT';amountMinor:number;currency:'CAT';sourceType:string;sourceId:string;reversalOfEntryId?:string|null;occurredAt:string }
export interface WalletEntryPage { items:WalletEntry[];nextCursor:string|null }
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
export function parseWalletBalance(value:unknown):WalletBalance|null{if(!isRecord(value)||value.currency!=='CAT'||!safeInteger(value.ledgerBalanceMinor)||!safeInteger(value.reservedMinor)||!safeInteger(value.availableMinor)||!safeInteger(value.version)||typeof value.calculatedAt!=='string')return null;return{ledgerBalanceMinor:value.ledgerBalanceMinor,reservedMinor:value.reservedMinor,availableMinor:value.availableMinor,currency:'CAT',calculatedAt:value.calculatedAt,version:value.version};}
export function parseWalletEntryPage(value:unknown):WalletEntryPage|null{if(!isRecord(value)||!Array.isArray(value.items)||(value.nextCursor!==null&&typeof value.nextCursor!=='string'))return null;const items=value.items.map(parseWalletEntry);return items.every((item):item is WalletEntry=>item!==null)?{items,nextCursor:value.nextCursor}:null;}
export function createWalletIdempotencyKey(kind:'TOP_UP'|'CASH_REFUND_DEBIT',userId:string){return `dashboard:wallet:${kind.toLowerCase()}:${userId}:${crypto.randomUUID()}`.slice(0,200);}
export function walletAdjustmentCandidates(entries:WalletEntry[]){return entries.filter((entry)=>!entry.entryType.startsWith('ADJUSTMENT_')&&!entry.reversalOfEntryId);}
export function buildWalletAdjustmentRequest(userId:string,fields:WalletAdjustmentSubmission,expectedWalletVersion:number){return{
  method:'POST' as const,path:`/api/v1/admin/users/${encodeURIComponent(userId)}/wallet-adjustments`,body:{entryType:`ADJUSTMENT_${fields.direction}` as 'ADJUSTMENT_CREDIT'|'ADJUSTMENT_DEBIT',amountMinor:fields.amountMinor,reversalOfEntryId:fields.reversalOfEntryId,reason:fields.reason.trim(),expectedWalletVersion}
};}
export function createWalletAdjustmentIdempotencyKey(userId:string){return `dashboard:wallet:adjustment:${userId}:${crypto.randomUUID()}`.slice(0,200);}
function parseWalletEntry(value:unknown):WalletEntry|null{if(!isRecord(value)||typeof value.id!=='string'||typeof value.entryType!=='string'||(value.direction!=='CREDIT'&&value.direction!=='DEBIT')||!safeInteger(value.amountMinor)||value.currency!=='CAT'||typeof value.sourceType!=='string'||typeof value.sourceId!=='string'||(value.reversalOfEntryId!==undefined&&value.reversalOfEntryId!==null&&typeof value.reversalOfEntryId!=='string')||typeof value.occurredAt!=='string')return null;return{id:value.id,entryType:value.entryType,direction:value.direction,amountMinor:value.amountMinor,currency:'CAT',sourceType:value.sourceType,sourceId:value.sourceId,reversalOfEntryId:value.reversalOfEntryId,occurredAt:value.occurredAt};}
function isRecord(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function safeInteger(value:unknown):value is number{return Number.isSafeInteger(value);}
