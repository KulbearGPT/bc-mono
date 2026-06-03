export const businessTagTypes = ['GAME','SERVICE','REGION','LANGUAGE','GIFT_CATEGORY'] as const;
export type BusinessTagType = typeof businessTagTypes[number];
export interface BusinessTagRecord { id:string;type:BusinessTagType;code:string;displayName:string;enabled:boolean;version:number }
export type BusinessTagGroups = Record<BusinessTagType,BusinessTagRecord[]>;
export const businessTagTypeLabels:Record<BusinessTagType,string>={GAME:'游戏',SERVICE:'陪玩服务/种类',REGION:'地区',LANGUAGE:'语言',GIFT_CATEGORY:'礼物分类'};
export function groupEnabledBusinessTags(items:BusinessTagRecord[]):BusinessTagGroups{const groups:BusinessTagGroups={GAME:[],SERVICE:[],REGION:[],LANGUAGE:[],GIFT_CATEGORY:[]};for(const item of items)if(item.enabled)groups[item.type].push(item);return groups;}
export function buildBusinessTagCreateRequest(input:{type:BusinessTagType;code:string;displayName:string}){return{method:'POST' as const,path:'/api/v1/admin/business-tags',body:{type:input.type,code:input.code.trim().toUpperCase(),displayName:input.displayName.trim()}};}
export function buildBusinessTagUpdateRequest(input:{tag:BusinessTagRecord;displayName:string;enabled:boolean}){return{method:'PATCH' as const,path:`/api/v1/admin/business-tags/${encodeURIComponent(input.tag.id)}`,body:{expectedVersion:input.tag.version,displayName:input.displayName.trim(),enabled:input.enabled}};}
