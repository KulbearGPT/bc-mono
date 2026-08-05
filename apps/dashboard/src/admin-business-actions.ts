import { catInputToMinor } from './cat-money.js';

export interface AdminActionRequest {
  method: 'POST' | 'PUT' | 'PATCH';
  path: string;
  body: Record<string, unknown>;
}

export function buildAddOrderParticipantRequest(orderId:string,fields:{playerId:unknown;serviceCatalogVersionId:unknown;unitCount:unknown;linePriceCat:unknown;expectedOrderVersion:unknown;reasonCode:unknown}):AdminActionRequest{return{method:'POST',path:`/api/v1/admin/orders/${encodeURIComponent(requireText(orderId,'orderId'))}/participants`,body:{playerId:requireText(fields.playerId,'playerId'),serviceCatalogVersionId:requireText(fields.serviceCatalogVersionId,'serviceCatalogVersionId'),unitCount:requirePositiveInteger(fields.unitCount,'unitCount'),linePriceMinor:catInputToMinor(fields.linePriceCat,{field:'明细价格'}),expectedOrderVersion:requirePositiveInteger(fields.expectedOrderVersion,'expectedOrderVersion'),reasonCode:requireReasonCode(fields.reasonCode)}};}

export function buildUpdateOrderParticipantRequest(orderId:string,participantId:string,fields:{action:unknown;playerId?:unknown;serviceCatalogVersionId?:unknown;unitCount?:unknown;linePriceCat?:unknown;expectedOrderVersion:unknown;expectedParticipantVersion:unknown;reasonCode:unknown}):AdminActionRequest{const action=requireEnum(fields.action,['CHANGE_PROJECT','CHANGE_PRICE','REASSIGN','REMOVE'],'action');return{method:'PATCH',path:`/api/v1/admin/orders/${encodeURIComponent(requireText(orderId,'orderId'))}/participants/${encodeURIComponent(requireText(participantId,'participantId'))}`,body:{expectedOrderVersion:requirePositiveInteger(fields.expectedOrderVersion,'expectedOrderVersion'),expectedParticipantVersion:requirePositiveInteger(fields.expectedParticipantVersion,'expectedParticipantVersion'),action,playerId:action==='REASSIGN'?requireText(fields.playerId,'playerId'):null,serviceCatalogVersionId:action==='CHANGE_PROJECT'?requireText(fields.serviceCatalogVersionId,'serviceCatalogVersionId'):null,unitCount:action==='CHANGE_PROJECT'?requirePositiveInteger(fields.unitCount,'unitCount'):null,linePriceMinor:action==='CHANGE_PRICE'||action==='CHANGE_PROJECT'?catInputToMinor(fields.linePriceCat,{field:'明细价格'}):null,reasonCode:requireReasonCode(fields.reasonCode)}};}
export function buildUpdateAdminOrderNoteRequest(orderId:string,fields:{expectedOrderVersion:unknown;note?:unknown;reasonCode:unknown}):AdminActionRequest{return{method:'PATCH',path:`/api/v1/admin/orders/${encodeURIComponent(requireText(orderId,'orderId'))}`,body:{expectedOrderVersion:requirePositiveInteger(fields.expectedOrderVersion,'expectedOrderVersion'),action:'CHANGE_NOTE',note:boundedOptionalText(fields.note,1000,'note'),reasonCode:requireReasonCode(fields.reasonCode)}};}
export function buildUpdateAdminOrderRequirementRequest(orderId:string,requirementId:string,fields:{expectedOrderVersion:unknown;expectedRequirementVersion:unknown;customerNote?:unknown;reasonCode:unknown}):AdminActionRequest{return{method:'PATCH',path:`/api/v1/admin/orders/${encodeURIComponent(requireText(orderId,'orderId'))}/requirements/${encodeURIComponent(requireText(requirementId,'requirementId'))}`,body:{expectedOrderVersion:requirePositiveInteger(fields.expectedOrderVersion,'expectedOrderVersion'),expectedRequirementVersion:requirePositiveInteger(fields.expectedRequirementVersion,'expectedRequirementVersion'),action:'CHANGE_NOTE',customerNote:boundedOptionalText(fields.customerNote,500,'customerNote'),reasonCode:requireReasonCode(fields.reasonCode)}};}

export function buildAdminActionRequest(input: {
  actionId: string;
  item?: Record<string, unknown>;
  fields: Record<string, string | boolean>;
}): AdminActionRequest {
  if (input.actionId === 'REFUND_ORDER') {
    const item = requireItem(input.item);
    requireEnum(input.item?.status, ['COMPLETED', 'EXCEPTION'], 'status');
    return {
      method: 'POST', path: `/api/v1/admin/orders/${encodeURIComponent(item.id)}/refund`,
      body: {
        expectedVersion: item.version,
        amount: { amountMinor: catInputToMinor(input.fields.amountCat, { field: '退款金额' }), currency: requireCurrency(input.fields.currency) },
        reasonCode: requireReasonCode(input.fields.reasonCode),
        evidenceNote: requireText(input.fields.evidenceNote, 'evidenceNote', 2_000)
      }
    };
  }
  if (input.actionId === 'CANCEL_ORDER_RESOLUTION') {
    const item = requireItem(input.item);
    requireEnum(input.item?.status, ['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION', 'EXCEPTION'], 'status');
    const currency = requireCurrency(input.fields.currency);
    return {
      method: 'POST', path: `/api/v1/admin/orders/${encodeURIComponent(item.id)}/resolve`,
      body: {
        expectedVersion: item.version,
        targetStatus: 'CANCELLED',
        reasonCode: requireReasonCode(input.fields.reasonCode),
        refund: { amountMinor: catInputToMinor(input.fields.refundAmountCat, { allowZero: true, field: '客户退款金额' }), currency },
        playerEarning: { amountMinor: catInputToMinor(input.fields.playerEarningCat, { allowZero: true, field: '陪玩收益' }), currency },
        evidenceNote: requireText(input.fields.evidenceNote, 'evidenceNote', 2_000),
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    };
  }
  if(input.actionId==='APPROVE_COMPANION'){const item=requirePlayerItem(input.item);return{method:'POST',path:`/api/v1/admin/players/${encodeURIComponent(item.id)}/approve`,body:{expectedVersion:item.version,
    gameTagIds:splitTags(input.fields.gameTagIds),serviceTagIds:splitTags(input.fields.serviceTagIds),languageTagIds:splitOptionalTags(input.fields.languageTagIds),reasonCode:requireReasonCode(input.fields.reasonCode)}};}
  if(input.actionId==='EDIT_COMPANION_TAGS'){const item=requirePlayerItem(input.item);return{method:'PUT',path:`/api/v1/admin/players/${encodeURIComponent(item.id)}/tags`,body:{expectedVersion:item.version,
    gameTagIds:splitTags(input.fields.gameTagIds),serviceTagIds:splitTags(input.fields.serviceTagIds),languageTagIds:splitOptionalTags(input.fields.languageTagIds),reasonCode:requireReasonCode(input.fields.reasonCode)}};}
  if(input.actionId==='EDIT_PLAYER_COMPENSATION'){const item=requirePlayerItem(input.item);if(typeof input.fields.compensationChangesJson==='string'){const changes=parseCompensationChanges(input.fields.compensationChangesJson);return{method:'PUT',path:`/api/v1/admin/players/${encodeURIComponent(item.id)}/compensation`,body:{rules:changes,reasonCode:requireReasonCode(input.fields.reasonCode)}};}const serviceOfferingId=requireText(input.fields.serviceOfferingId,'serviceOfferingId');const type=requireEnum(input.fields.compensationType,['PERCENT_BPS','FIXED_MINOR'],'compensationType');
    const value=type==='PERCENT_BPS'?requirePercentageBps(input.fields.percentage):catInputToMinor(input.fields.fixedAmountCat,{field:'每单位固定收益'});
    return{method:'PUT',path:`/api/v1/admin/players/${encodeURIComponent(item.id)}/compensation/${encodeURIComponent(serviceOfferingId)}`,body:{expectedVersion:optionalPositiveInteger(input.fields.compensationVersion),type,value,currency:type==='FIXED_MINOR'?'CAT':null,reasonCode:requireReasonCode(input.fields.reasonCode)}};}
  if(input.actionId==='REJECT_COMPANION'){const item=requirePlayerItem(input.item);return{method:'POST',path:`/api/v1/admin/players/${encodeURIComponent(item.id)}/reject`,body:{expectedVersion:item.version,
    reasonCode:requireReasonCode(input.fields.reasonCode),note:requireText(input.fields.note,'note',1000)}};}
  if(input.actionId==='SET_PLAYER_OPERATIONAL_STATUS'){const item=requirePlayerItem(input.item);const reviewStatus=requireEnum(input.fields.status,['ACTIVE','PAUSED','SUSPENDED'],'status');return{method:'PUT',path:`/api/v1/admin/players/${encodeURIComponent(item.id)}/operational-status`,body:{expectedVersion:item.version,reviewStatus,reasonCode:requireReasonCode(input.fields.reasonCode),note:optionalText(input.fields.note)}};}
  if (input.actionId === 'SET_OPERATIONAL_STATUS') {
    const item = requireItem(input.item);
    const status = requireEnum(input.fields.status, ['ACTIVE', 'PAUSED', 'SUSPENDED'], 'status');
    const reasonCode = requireReasonCode(input.fields.reasonCode);
    return {
      method: 'PUT', path: `/api/v1/admin/users/${encodeURIComponent(item.id)}/operational-status`,
      body: { expectedVersion: item.version, status, reasonCode, note: optionalText(input.fields.note) }
    };
  }
  if (input.actionId === 'CREATE_GIFT') {
    return {
      method: 'POST', path: '/api/v1/admin/gift-catalog',
      body: buildGiftCatalogCreateBody(input.fields, requireReasonCode(input.fields.reasonCode))
    };
  }
  if (input.actionId === 'CREATE_SERVICE_VERSION') {
    const reasonCode = requireReasonCode(input.fields.reasonCode);
    return { method: 'POST', path: '/api/v1/admin/service-catalog', body: buildServiceCatalogCreateBody(input.fields, reasonCode) };
  }
  if(input.actionId==='CREATE_PACKAGE_VERSION'||input.actionId==='COPY_PACKAGE_VERSION')return{method:'POST',path:'/api/v1/admin/service-packages',body:buildServicePackageCreateBody(input.fields,requireReasonCode(input.fields.reasonCode))};
  if(input.actionId==='UPDATE_PACKAGE_STATUS'){const expectedStatus=requireEnum(input.item?.status as string,['DRAFT','ACTIVE','RETIRED'],'status');const item=requireItem(input.item);const action=requireEnum(input.fields.action,['ACTIVATE','RETIRE'],'action');return{method:'PATCH',path:`/api/v1/admin/service-packages/${encodeURIComponent(item.id)}`,body:{expectedStatus,action,reasonCode:requireReasonCode(input.fields.reasonCode)}};}
  if (input.actionId === 'UPDATE_GIFT_VERSION') {
    const item = requireItem(input.item);
    const action = requireEnum(input.fields.action, ['ENABLE', 'DISABLE', 'CREATE_REPLACEMENT_VERSION'], 'action');
    const reasonCode = requireReasonCode(input.fields.reasonCode);
    return {
      method: 'PATCH', path: `/api/v1/admin/gift-catalog/${encodeURIComponent(item.id)}`,
      body: { expectedVersion: item.version, action, reasonCode, replacement: action === 'CREATE_REPLACEMENT_VERSION' ? buildGiftCatalogCreateBody(input.fields, reasonCode) : null }
    };
  }
  if(input.actionId==='ARCHIVE_GIFT'){const item=requireItem(input.item);return{method:'PATCH',path:`/api/v1/admin/gift-catalog/${encodeURIComponent(item.id)}`,body:{expectedVersion:item.version,action:'ARCHIVE',reasonCode:requireReasonCode(input.fields.reasonCode),replacement:null}};}
  if (input.actionId === 'UPDATE_VERSION') {
    const item = requireItem(input.item);
    const action = requireEnum(input.fields.action, ['ENABLE', 'DISABLE', 'SUPERSEDE'], 'action');
    const reasonCode = requireReasonCode(input.fields.reasonCode);
    return {
      method: 'PATCH', path: `/api/v1/admin/service-catalog/${encodeURIComponent(item.id)}`,
      body: { expectedVersion: item.version, action, reasonCode, replacement: action === 'SUPERSEDE' ? buildServiceCatalogCreateBody(input.fields, reasonCode) : null }
    };
  }
  if(input.actionId==='ARCHIVE_SERVICE'){const item=requireItem(input.item);return{method:'PATCH',path:`/api/v1/admin/service-catalog/${encodeURIComponent(item.id)}`,body:{expectedVersion:item.version,action:'ARCHIVE',reasonCode:requireReasonCode(input.fields.reasonCode),replacement:null}};}
  if (input.actionId === 'CREATE_RISK_EVENT') {
    const item = requireItem(input.item);
    return {
      method: 'POST', path: `/api/v1/admin/users/${encodeURIComponent(item.id)}/risk-events`,
      body: {
        type: requireEnum(input.fields.type, ['PLAYER_NO_SHOW', 'CUSTOMER_NO_SHOW', 'DUPLICATE_ACCOUNT_SIGNAL', 'REFERRAL_ABUSE_SIGNAL', 'PAYMENT_ANOMALY'], 'type'),
        severity: requireEnum(input.fields.severity, ['LOW', 'MEDIUM', 'HIGH'], 'severity'),
        source: requireEnum(input.fields.source, ['STAFF_REVIEW', 'CUSTOMER_REPORT', 'PLAYER_REPORT', 'SYSTEM_SIGNAL'], 'source'),
        notes: requireText(input.fields.notes, 'notes', 2_000),
        orderId: optionalText(input.fields.orderId)
      }
    };
  }
  if (input.actionId === 'CONFIRM' || input.actionId === 'MARK_PAID') {
    const item = requireItem(input.item);
    const reasonCode = requireReasonCode(input.fields.reasonCode);
    return {
      method: 'PATCH', path: `/api/v1/admin/player-earnings/${encodeURIComponent(item.id)}`,
      body: { expectedVersion: item.version, action: input.actionId, reasonCode }
    };
  }
  throw new TypeError('当前操作无法提交，请刷新页面后重试。');
}

function parseCompensationChanges(value:string){let entries:unknown;try{entries=JSON.parse(value);}catch{throw new Error('compensationChangesJson is invalid.');}if(!Array.isArray(entries)||!entries.length)throw new Error('至少需要一条分成改动。');return entries.map((entry)=>{if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new Error('compensation change is invalid.');const item=entry as Record<string,unknown>;const type=requireEnum(item.type as string,['PERCENT_BPS','FIXED_MINOR'],'compensationType');return{serviceOfferingId:requireText(item.serviceOfferingId as string,'serviceOfferingId'),expectedVersion:optionalPositiveInteger(item.expectedVersion as string),type,value:type==='PERCENT_BPS'?requirePercentageBps(item.percentage as string):catInputToMinor(item.fixedAmountCat,{field:'每单位固定收益'}),currency:type==='FIXED_MINOR'?'CAT':null};});}

function requireItem(item: Record<string, unknown> | undefined): { id: string; version: number } {
  if (!item) throw new TypeError('An item is required for this action.');
  const id = requireText(item.id, 'id');
  if (!Number.isSafeInteger(item.version) || Number(item.version) < 1) throw new TypeError('A valid item version is required.');
  return { id, version: Number(item.version) };
}
function requirePlayerItem(item:Record<string,unknown>|undefined):{id:string;version:number}{if(!item)throw new TypeError('A player item is required.');const id=requireText(item.playerId??item.id,'playerId');
  if(!Number.isSafeInteger(item.version)||Number(item.version)<1)throw new TypeError('A valid player version is required.');return{id,version:Number(item.version)};}
function splitTags(value:string|boolean|undefined):string[]{if(typeof value!=='string')throw new TypeError('Tags are required.');const tags=Array.from(new Set(value.split(',').map(item=>item.trim()).filter(Boolean)));
  if(!tags.length)throw new TypeError('At least one tag is required.');return tags;}
function requireReasonCode(value: unknown): string {
  const reasonCode = requireText(value, 'reasonCode');
  if (!/^[A-Z0-9_]{3,100}$/.test(reasonCode)) throw new TypeError('reasonCode must contain 3-100 uppercase letters, numbers, or underscores.');
  return reasonCode;
}
function splitOptionalTags(value:string|boolean|undefined):string[]{return value===undefined?[]:splitTags(value);}

function requireText(value: unknown, field: string, maxLength = Number.POSITIVE_INFINITY): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) throw new TypeError(`${field} is required.`);
  return value.trim();
}

function optionalText(value: string | boolean | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function boundedOptionalText(value:unknown,maxLength:number,field:string):string|null{if(value===undefined||value===null||value==='')return null;if(typeof value!=='string'||value.trim().length>maxLength)throw new TypeError(`${field} is invalid.`);return value.trim()||null;}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new TypeError(`${field} is invalid.`);
  return value as T;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${field} must be a positive integer.`);
  return parsed;
}
function optionalPositiveInteger(value:string|boolean|undefined):number|null{if(value===undefined||value==='')return null;return requirePositiveInteger(value,'compensationVersion');}
function requirePercentageBps(value:string|boolean|undefined):number{const parsed=typeof value==='string'?Number(value):Number.NaN;if(!Number.isFinite(parsed)||parsed<=0||parsed>100)throw new TypeError('percentage must be between 0 and 100.');const bps=Math.round(parsed*100);if(!Number.isSafeInteger(bps)||bps<1||bps>10000)throw new TypeError('percentage must be between 0 and 100.');return bps;}

function requireIntegerInRange(value: string | boolean | undefined, field: string, minimum: number, maximum: number): number {
  const parsed = requirePositiveInteger(value, field);
  if (parsed < minimum || parsed > maximum) throw new TypeError(`${field} must be between ${minimum} and ${maximum}.`);
  return parsed;
}

function requireCurrency(value: string | boolean | undefined): string {
  const currency = requireText(value, 'currency');
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError('currency must be a three-letter uppercase code.');
  return currency;
}

function buildServiceCatalogCreateBody(fields: Record<string, string | boolean>, reasonCode: string) {
  const currency = requireCurrency(fields.currency);
  const customerAmountMinor = catInputToMinor(fields.customerAmountCat, { field: '用户单价' });
  const defaultPlayerPayoutBps = requirePercentageBps(fields.defaultPlayerPayoutPercent);
  return {
    gameTagId: requireText(fields.gameTagId, 'gameTagId', 100),
    serviceTagId: requireText(fields.serviceTagId, 'serviceTagId', 100),
    regionTagId: optionalText(fields.regionTagId),
    billingUnitMinutes: requireIntegerInRange(fields.billingUnitMinutes, 'billingUnitMinutes', 1, 1_440),
    minimumUnits: requireIntegerInRange(fields.minimumUnits, 'minimumUnits', 1, 1_440),
    customerUnitPrice: { amountMinor: customerAmountMinor, currency },
    playerUnitPayout: { amountMinor: Math.floor(customerAmountMinor * defaultPlayerPayoutBps / 10000), currency },
    defaultPlayerPayoutBps,
    enabled: fields.enabled === true,
    reasonCode
  };
}

function buildGiftCatalogCreateBody(fields: Record<string, string | boolean>, reasonCode: string) {
  return {
    name: requireText(fields.name, 'name', 100), giftCategoryTagId: requireText(fields.giftCategoryTagId,'giftCategoryTagId',100),
    price: { amountMinor: catInputToMinor(fields.amountCat, { field: '礼物价格' }), currency: requireCurrency(fields.currency) },
    enabled: fields.enabled === true,
    broadcastTemplate: requireText(fields.broadcastTemplate, 'broadcastTemplate', 500),
    reasonCode
  };
}

function buildServicePackageCreateBody(fields:Record<string,string|boolean>,reasonCode:string){let slots:unknown;try{slots=JSON.parse(requireText(fields.slotsJson,'slotsJson',20_000));}catch{throw new TypeError('请至少配置一个有效套餐席位。');}if(!Array.isArray(slots)||slots.length<1||slots.length>25)throw new TypeError('套餐席位数量必须在 1 到 25 之间。');return{code:requireText(fields.code,'code',100).toUpperCase(),displayName:requireText(fields.displayName,'displayName',100),description:requireText(fields.description,'description',1000),currency:'CAT',activate:fields.activate===true,slots:slots.map((slot,index)=>{if(!slot||typeof slot!=='object'||Array.isArray(slot))throw new TypeError(`第 ${index+1} 个席位无效。`);const value=slot as Record<string,unknown>;return{serviceCatalogVersionId:requireText(value.serviceCatalogVersionId as string,'serviceCatalogVersionId'),unitCount:requirePositiveInteger(String(value.unitCount),'unitCount'),customerNoteTemplate:optionalText(typeof value.customerNoteTemplate==='string'?value.customerNoteTemplate:undefined)};}),reasonCode};}
