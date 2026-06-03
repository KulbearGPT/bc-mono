import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  InMemoryAuditSink,
  insertPostgresAuditRecord,
  registerSecureReadRoute,
  registerSecureWriteRoute,
  type ActorContext,
  type AuditRecord,
  type AuditSink
} from './security.js';

export const businessTagTypes = ['GAME', 'SERVICE', 'REGION', 'LANGUAGE', 'GIFT_CATEGORY'] as const;
export type BusinessTagType = typeof businessTagTypes[number];
export interface BusinessTagRecord { id: string; type: BusinessTagType; code: string; displayName: string; enabled: boolean; version: number }
interface StagedTagWrite { data: BusinessTagRecord; commit(audit: AuditRecord, sink: AuditSink): Promise<void> | void }

export interface BusinessTagStore {
  list(input?: { type?: BusinessTagType; enabled?: boolean }): Promise<BusinessTagRecord[]> | BusinessTagRecord[];
  stageCreate(input: { type: BusinessTagType; code: string; displayName: string; actorStaffId: string; now: Date }): Promise<StagedTagWrite> | StagedTagWrite;
  stageUpdate(input: { tagId: string; expectedVersion: number; displayName: string; enabled: boolean; actorStaffId: string; now: Date }): Promise<StagedTagWrite> | StagedTagWrite;
  resolveEnabled(ids: string[], allowedTypes: BusinessTagType[]): Promise<BusinessTagRecord[]> | BusinessTagRecord[];
}

export class BusinessTagError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION_ERROR' | 'PERMISSION_DENIED', message: string) { super(message); this.name = 'BusinessTagError'; }
}

export class InMemoryBusinessTagStore implements BusinessTagStore {
  private readonly items: BusinessTagRecord[];
  constructor(items: BusinessTagRecord[] = []) { this.items = structuredClone(items); }
  list(input: { type?: BusinessTagType; enabled?: boolean } = {}) { return structuredClone(this.items.filter((item) => (!input.type || item.type === input.type) && (input.enabled === undefined || item.enabled === input.enabled))); }
  stageCreate(input: { type: BusinessTagType; code: string; displayName: string; actorStaffId: string; now: Date }) {
    if (this.items.some((item) => item.type === input.type && item.code === input.code)) throw new BusinessTagError('CONFLICT', 'Business tag code already exists for this type.');
    const data: BusinessTagRecord = { id: randomUUID(), type: input.type, code: input.code, displayName: input.displayName, enabled: true, version: 1 };
    return { data, commit: async (audit: AuditRecord, sink: AuditSink) => { this.items.push(structuredClone(data)); try { await sink.append(audit); } catch (error) { this.items.splice(this.items.findIndex((item) => item.id === data.id), 1); throw error; } } };
  }
  stageUpdate(input: { tagId: string; expectedVersion: number; displayName: string; enabled: boolean; actorStaffId: string; now: Date }) {
    const current = this.items.find((item) => item.id === input.tagId); if (!current) throw new BusinessTagError('NOT_FOUND', 'Business tag was not found.');
    if (current.version !== input.expectedVersion) throw new BusinessTagError('CONFLICT', 'Business tag version is stale.');
    const data = { ...current, displayName: input.displayName, enabled: input.enabled, version: current.version + 1 };
    return { data, commit: async (audit: AuditRecord, sink: AuditSink) => { const snapshot = { ...current }; Object.assign(current, data); try { await sink.append(audit); } catch (error) { Object.assign(current, snapshot); throw error; } } };
  }
  resolveEnabled(ids: string[], allowedTypes: BusinessTagType[]) { return resolveRecords(this.items, ids, allowedTypes); }
}

export class PostgresBusinessTagStore implements BusinessTagStore {
  constructor(private readonly pool: Pool) {}
  async list(input: { type?: BusinessTagType; enabled?: boolean } = {}) {
    const result = await this.pool.query<{ id: string; type: BusinessTagType; code: string; display_name: string; enabled: boolean; row_version: number }>(
      `SELECT id,type,code,display_name,enabled,row_version FROM skill_tags WHERE ($1::text IS NULL OR type::text=$1) AND ($2::boolean IS NULL OR enabled=$2) ORDER BY type,code`,
      [input.type ?? null, input.enabled ?? null]
    );
    return result.rows.map(mapRow);
  }
  async stageCreate(input: { type: BusinessTagType; code: string; displayName: string; actorStaffId: string; now: Date }) {
    const data: BusinessTagRecord = { id: randomUUID(), type: input.type, code: input.code, displayName: input.displayName, enabled: true, version: 1 };
    return { data, commit: async (audit: AuditRecord) => { const client = await this.pool.connect(); try { await client.query('BEGIN'); await client.query(`INSERT INTO skill_tags(id,type,code,display_name,enabled,row_version,created_at,updated_at) VALUES($1,$2::"SkillTagType",$3,$4,true,1,$5,$5)`, [data.id,data.type,data.code,data.displayName,input.now]); await insertPostgresAuditRecord(client,audit); await client.query('COMMIT'); } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); if (isUnique(error)) throw new BusinessTagError('CONFLICT','Business tag code already exists for this type.'); throw error; } finally { client.release(); } } };
  }
  async stageUpdate(input: { tagId: string; expectedVersion: number; displayName: string; enabled: boolean; actorStaffId: string; now: Date }) {
    const current = (await this.list()).find((item) => item.id === input.tagId); if (!current) throw new BusinessTagError('NOT_FOUND','Business tag was not found.');
    if (current.version !== input.expectedVersion) throw new BusinessTagError('CONFLICT','Business tag version is stale.');
    const data = { ...current, displayName: input.displayName, enabled: input.enabled, version: current.version + 1 };
    return { data, commit: async (audit: AuditRecord) => { const client=await this.pool.connect(); try { await client.query('BEGIN'); const updated=await client.query(`UPDATE skill_tags SET display_name=$3,enabled=$4,row_version=row_version+1,updated_at=$5 WHERE id=$1 AND row_version=$2 RETURNING id`,[input.tagId,input.expectedVersion,input.displayName,input.enabled,input.now]); if(!updated.rows[0])throw new BusinessTagError('CONFLICT','Business tag version is stale.'); await insertPostgresAuditRecord(client,audit); await client.query('COMMIT'); } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; } finally { client.release(); } } };
  }
  async resolveEnabled(ids: string[], allowedTypes: BusinessTagType[]) { return resolveRecords(await this.list(), ids, allowedTypes); }
}

export async function createBusinessTag(input: { store: BusinessTagStore; actor: Pick<ActorContext,'actorStaffId'|'actorLevel'>; input: { type: string; code: string; displayName: string }; now?: Date }) {
  requireManager(input.actor); const normalized = parseCreate(input.input); const now=input.now??new Date(); const staged=await input.store.stageCreate({ ...normalized, actorStaffId: input.actor.actorStaffId!, now }); await staged.commit(fakeAudit(input.actor,'CREATE_BUSINESS_TAG',staged.data.id,now),new InMemoryAuditSink()); return staged.data;
}
export async function updateBusinessTag(input: { store: BusinessTagStore; actor: Pick<ActorContext,'actorStaffId'|'actorLevel'>; tagId: string; input: { expectedVersion: number; displayName: string; enabled: boolean }; now?: Date }) {
  requireManager(input.actor); const normalized=parseUpdate(input.input); const now=input.now??new Date(); const staged=await input.store.stageUpdate({tagId:input.tagId,...normalized,actorStaffId:input.actor.actorStaffId!,now}); await staged.commit(fakeAudit(input.actor,'UPDATE_BUSINESS_TAG',input.tagId,now),new InMemoryAuditSink()); return staged.data;
}

export function registerBusinessTagRoutes(server: FastifyInstance, options: { store: BusinessTagStore; now?: () => Date }) {
  if(!server.securityOptions)throw new Error('Business tag routes require security options.'); const now=options.now??(()=>new Date()); const sink=server.securityOptions.auditSink??new InMemoryAuditSink();
  registerSecureReadRoute(server,server.securityOptions,{method:'GET',url:'/api/v1/admin/business-tags',permission:'catalog.read',action:'LIST_BUSINESS_TAGS',targetType:'skill_tag',acceptedSources:['DASHBOARD'],handler:(request)=>options.store.list(readFilters(request)),mapError});
  registerSecureWriteRoute(server,server.securityOptions,{method:'POST',url:'/api/v1/admin/business-tags',permission:'catalog.manage',action:'CREATE_BUSINESS_TAG',targetType:'skill_tag',acceptedSources:['DASHBOARD'],successStatusCode:201,mapError,handler:async(request,actor)=>{requireActor(actor);const value=parseCreate(request.body);const staged=await options.store.stageCreate({...value,actorStaffId:actor.actorStaffId!,now:now()});return{data:staged.data,commit:(audit:AuditRecord)=>staged.commit(audit,sink)};}});
  registerSecureWriteRoute(server,server.securityOptions,{method:'PATCH',url:'/api/v1/admin/business-tags/:tagId',permission:'catalog.manage',action:'UPDATE_BUSINESS_TAG',targetType:'skill_tag',targetId:(request)=>tagId(request),acceptedSources:['DASHBOARD'],mapError,handler:async(request,actor)=>{requireActor(actor);const value=parseUpdate(request.body);const staged=await options.store.stageUpdate({tagId:tagId(request),...value,actorStaffId:actor.actorStaffId!,now:now()});return{data:staged.data,commit:(audit:AuditRecord)=>staged.commit(audit,sink)};}});
}

function parseCreate(value: unknown) { const input=record(value); const type=String(input.type??'') as BusinessTagType;if(!businessTagTypes.includes(type))throw new BusinessTagError('VALIDATION_ERROR','Business tag type is invalid.');const code=String(input.code??'').trim().toUpperCase();if(!/^[A-Z][A-Z0-9_]{1,79}$/u.test(code))throw new BusinessTagError('VALIDATION_ERROR','Business tag code is invalid.');return{type,code,displayName:text(input.displayName,'displayName',100)}; }
function parseUpdate(value: unknown) { const input=record(value);if(!Number.isInteger(input.expectedVersion)||Number(input.expectedVersion)<1)throw new BusinessTagError('VALIDATION_ERROR','expectedVersion is invalid.');if(typeof input.enabled!=='boolean')throw new BusinessTagError('VALIDATION_ERROR','enabled is required.');return{expectedVersion:Number(input.expectedVersion),displayName:text(input.displayName,'displayName',100),enabled:input.enabled}; }
function readFilters(request:FastifyRequest){const query=request.query as Record<string,unknown>;const type=typeof query.type==='string'?query.type as BusinessTagType:undefined;if(type&&!businessTagTypes.includes(type))throw new BusinessTagError('VALIDATION_ERROR','Business tag type is invalid.');const enabled=query.enabled==='true'?true:query.enabled==='false'?false:undefined;return{type,enabled};}
function resolveRecords(items:BusinessTagRecord[],ids:string[],allowedTypes:BusinessTagType[]){const unique=[...new Set(ids)];const resolved=unique.map((id)=>items.find((item)=>item.id===id));if(resolved.some((item)=>!item||!item.enabled||!allowedTypes.includes(item.type)))throw new BusinessTagError('VALIDATION_ERROR','A selected business tag is missing, disabled, or has the wrong type.');return structuredClone(resolved as BusinessTagRecord[]);}
function requireManager(actor:Pick<ActorContext,'actorStaffId'|'actorLevel'>){if(!actor.actorStaffId||!['L3_OPERATIONS','L4_ADMIN_OWNER'].includes(actor.actorLevel??''))throw new BusinessTagError('PERMISSION_DENIED','Catalog manager access is required.');}
function requireActor(actor:ActorContext){if(!actor.actorStaffId)throw new BusinessTagError('PERMISSION_DENIED','Staff actor is required.');}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new BusinessTagError('VALIDATION_ERROR','Request body must be an object.');return value as Record<string,unknown>;}
function text(value:unknown,field:string,max:number){if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new BusinessTagError('VALIDATION_ERROR',`${field} is invalid.`);return value.trim();}
function tagId(request:FastifyRequest){return String((request.params as Record<string,unknown>).tagId??'');}
function mapRow(row:{id:string;type:BusinessTagType;code:string;display_name:string;enabled:boolean;row_version:number}):BusinessTagRecord{return{id:row.id,type:row.type,code:row.code,displayName:row.display_name,enabled:row.enabled,version:row.row_version};}
function mapError(error:unknown){if(!(error instanceof BusinessTagError))return null;return{statusCode:error.code==='NOT_FOUND'?404:error.code==='CONFLICT'?409:error.code==='PERMISSION_DENIED'?403:400,code:error.code,message:error.message};}
function isUnique(error:unknown){return Boolean(error&&typeof error==='object'&&'code'in error&&(error as {code?:string}).code==='23505');}
function fakeAudit(actor:Pick<ActorContext,'actorStaffId'|'actorLevel'>,action:string,targetId:string,now:Date):AuditRecord{return{id:randomUUID(),actorId:actor.actorStaffId!,actorStaffId:actor.actorStaffId!,actorLevel:actor.actorLevel??null,actorSource:'DASHBOARD',clientId:'TEST',interactionId:null,permissionCode:'catalog.manage',action,targetType:'skill_tag',targetId,outcome:'SUCCEEDED',reason:null,requestId:`req_${randomUUID()}`,approvalRequestId:null,occurredAt:now.toISOString()};}
