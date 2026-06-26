import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { registerSecureReadRoute, registerSecureWriteRoute } from './security.js';

export type PlayerCompensationType = 'PERCENT_BPS' | 'FIXED_MINOR';

export interface PlayerCompensationRule {
  id: string;
  playerId: string;
  serviceOfferingId: string;
  type: PlayerCompensationType;
  value: number;
  currency: 'CAT' | null;
  version: number;
  updatedByStaffId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlayerCompensationStore {
  find(playerId: string, serviceOfferingId: string): Promise<PlayerCompensationRule | null>;
  list(playerId: string): Promise<PlayerCompensationRule[]>;
  upsert(input: Omit<PlayerCompensationRule, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { expectedVersion: number | null; now: Date }): Promise<PlayerCompensationRule>;
  upsertBatch(inputs: Array<Omit<PlayerCompensationRule, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { expectedVersion: number | null; now: Date }>): Promise<PlayerCompensationRule[]>;
  findForCatalog?(playerId:string,serviceCatalogId:string):Promise<PlayerCompensationRule|null>;
}

export class PlayerCompensationError extends Error {
  constructor(readonly code: 'VALIDATION_ERROR' | 'CONFLICT' | 'NOT_FOUND', message: string) { super(message); this.name = 'PlayerCompensationError'; }
}

export class InMemoryPlayerCompensationStore implements PlayerCompensationStore {
  private readonly records = new Map<string, PlayerCompensationRule>();
  async find(playerId: string, serviceOfferingId: string) { return clone(this.records.get(`${playerId}:${serviceOfferingId}`) ?? null); }
  async list(playerId:string){return Array.from(this.records.values()).filter((item)=>item.playerId===playerId).map(clone);}
  async upsert(input: Omit<PlayerCompensationRule, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { expectedVersion: number | null; now: Date }) {
    const key = `${input.playerId}:${input.serviceOfferingId}`;
    const current = this.records.get(key);
    if ((!current && input.expectedVersion !== null) || (current && current.version !== input.expectedVersion)) throw new PlayerCompensationError('CONFLICT', 'Compensation rule version is stale.');
    const timestamp = input.now.toISOString();
    const record: PlayerCompensationRule = { id: current?.id ?? crypto.randomUUID(), playerId: input.playerId, serviceOfferingId: input.serviceOfferingId,
      type: input.type, value: input.value, currency: input.currency, version: (current?.version ?? 0) + 1, updatedByStaffId: input.updatedByStaffId,
      createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp };
    this.records.set(key, record);
    return clone(record);
  }
  async upsertBatch(inputs: Array<Omit<PlayerCompensationRule, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { expectedVersion: number | null; now: Date }>) {
    const seen=new Set<string>();
    for(const input of inputs){const key=`${input.playerId}:${input.serviceOfferingId}`;if(seen.has(key))throw new PlayerCompensationError('VALIDATION_ERROR','Each service offering can only appear once.');seen.add(key);const current=this.records.get(key);if((!current&&input.expectedVersion!==null)||(current&&current.version!==input.expectedVersion))throw new PlayerCompensationError('CONFLICT','Compensation rule version is stale.');}
    return Promise.all(inputs.map((input)=>this.upsert(input)));
  }
}

export class PostgresPlayerCompensationStore implements PlayerCompensationStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}
  async find(playerId: string, serviceOfferingId: string) {
    const result = await this.pool.query<CompensationRow>('SELECT * FROM player_service_compensation_rules WHERE player_id=$1 AND service_offering_id=$2', [playerId, serviceOfferingId]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }
  async list(playerId:string){const result=await this.pool.query<CompensationRow>('SELECT * FROM player_service_compensation_rules WHERE player_id=$1 ORDER BY updated_at DESC',[playerId]);return result.rows.map(mapRow);}
  async findForCatalog(playerId:string,serviceCatalogId:string){const result=await this.pool.query<CompensationRow>(`SELECT rule.* FROM player_service_compensation_rules rule JOIN service_catalog_versions version ON version.service_offering_id=rule.service_offering_id WHERE rule.player_id=$1 AND version.id=$2`,[playerId,serviceCatalogId]);return result.rows[0]?mapRow(result.rows[0]):null;}
  async upsert(input: Omit<PlayerCompensationRule, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { expectedVersion: number | null; now: Date }) {
    const current=await this.find(input.playerId,input.serviceOfferingId);
    if((!current&&input.expectedVersion!==null)||(current&&current.version!==input.expectedVersion))throw new PlayerCompensationError('CONFLICT','Compensation rule version is stale.');
    if(input.type==='FIXED_MINOR'){
      const price=await this.pool.query<{customer_unit_price_minor:number|string}>(`SELECT customer_unit_price_minor FROM service_catalog_versions WHERE service_offering_id=$1 AND status='ACTIVE' ORDER BY version DESC LIMIT 1`,[input.serviceOfferingId]);
      if(!price.rows[0])throw new PlayerCompensationError('NOT_FOUND','Active service offering was not found.');
      if(input.value>Number(price.rows[0].customer_unit_price_minor))throw new PlayerCompensationError('VALIDATION_ERROR','Fixed player payout cannot exceed the customer unit price.');
    }
    const result = await this.pool.query<CompensationRow>(`INSERT INTO player_service_compensation_rules
      (player_id,service_offering_id,type,value,currency,row_version,updated_by_staff_id,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,1,$6,$7,$7)
      ON CONFLICT (player_id,service_offering_id) DO UPDATE SET type=EXCLUDED.type,value=EXCLUDED.value,currency=EXCLUDED.currency,
        row_version=player_service_compensation_rules.row_version+1,updated_by_staff_id=EXCLUDED.updated_by_staff_id,updated_at=EXCLUDED.updated_at
      WHERE player_service_compensation_rules.row_version=$8
      RETURNING *`, [input.playerId,input.serviceOfferingId,input.type,input.value,input.currency,input.updatedByStaffId,input.now.toISOString(),input.expectedVersion]);
    if (!result.rows[0]) throw new PlayerCompensationError('CONFLICT', 'Compensation rule version is stale.');
    return mapRow(result.rows[0]);
  }
  async upsertBatch(inputs: Array<Omit<PlayerCompensationRule, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { expectedVersion: number | null; now: Date }>) {
    if(!inputs.length)return [];
    const seen=new Set<string>();for(const input of inputs){if(seen.has(input.serviceOfferingId))throw new PlayerCompensationError('VALIDATION_ERROR','Each service offering can only appear once.');seen.add(input.serviceOfferingId);}
    const result=await this.pool.query<CompensationRow>(`WITH requested(player_id,service_offering_id,type,value,currency,expected_version,updated_by_staff_id,updated_at) AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(player_id uuid,service_offering_id uuid,type "PlayerCompensationType",value integer,currency text,expected_version integer,updated_by_staff_id uuid,updated_at timestamptz)
    ), checked AS (
      SELECT requested.*, rule.id AS existing_id, rule.row_version, rule.created_at,
        (SELECT customer_unit_price_minor FROM service_catalog_versions WHERE service_offering_id=requested.service_offering_id AND status='ACTIVE' ORDER BY version DESC LIMIT 1) AS customer_unit_price_minor
      FROM requested LEFT JOIN player_service_compensation_rules rule ON rule.player_id=requested.player_id AND rule.service_offering_id=requested.service_offering_id
    ), invalid AS (SELECT 1 FROM checked WHERE (existing_id IS NULL AND expected_version IS NOT NULL) OR (existing_id IS NOT NULL AND row_version<>expected_version) OR (type='FIXED_MINOR' AND (customer_unit_price_minor IS NULL OR value>customer_unit_price_minor)) LIMIT 1), written AS (
      INSERT INTO player_service_compensation_rules (player_id,service_offering_id,type,value,currency,row_version,updated_by_staff_id,created_at,updated_at)
      SELECT player_id,service_offering_id,type,value,currency,1,updated_by_staff_id,updated_at,updated_at FROM checked WHERE NOT EXISTS (SELECT 1 FROM invalid)
      ON CONFLICT (player_id,service_offering_id) DO UPDATE SET type=EXCLUDED.type,value=EXCLUDED.value,currency=EXCLUDED.currency,row_version=player_service_compensation_rules.row_version+1,updated_by_staff_id=EXCLUDED.updated_by_staff_id,updated_at=EXCLUDED.updated_at
      WHERE player_service_compensation_rules.row_version=(SELECT expected_version FROM requested WHERE requested.player_id=EXCLUDED.player_id AND requested.service_offering_id=EXCLUDED.service_offering_id)
      RETURNING *) SELECT * FROM written`,[JSON.stringify(inputs.map((input)=>({player_id:input.playerId,service_offering_id:input.serviceOfferingId,type:input.type,value:input.value,currency:input.currency,expected_version:input.expectedVersion,updated_by_staff_id:input.updatedByStaffId,updated_at:input.now.toISOString()})))]);
    if(result.rows.length!==inputs.length)throw new PlayerCompensationError('CONFLICT','Compensation rules changed or are invalid; no changes were saved.');
    return result.rows.map(mapRow);
  }
}

export function calculatePlayerCompensation(input: { customerUnitPriceMinor: number; unitCount: number; defaultPayoutBps: number; rule: Pick<PlayerCompensationRule, 'type' | 'value' | 'currency'> | null }) {
  if (!Number.isSafeInteger(input.customerUnitPriceMinor) || input.customerUnitPriceMinor < 1 || !Number.isSafeInteger(input.unitCount) || input.unitCount < 1 || !Number.isInteger(input.defaultPayoutBps) || input.defaultPayoutBps < 1 || input.defaultPayoutBps > 10000) throw new PlayerCompensationError('VALIDATION_ERROR', 'Compensation inputs are invalid.');
  const unitPayoutMinor = input.rule?.type === 'FIXED_MINOR' ? input.rule.value : Math.floor(input.customerUnitPriceMinor * (input.rule?.value ?? input.defaultPayoutBps) / 10000);
  if (!Number.isSafeInteger(unitPayoutMinor) || unitPayoutMinor < 1 || unitPayoutMinor > input.customerUnitPriceMinor) throw new PlayerCompensationError('VALIDATION_ERROR', 'Player payout must be positive and cannot exceed the customer price.');
  return { unitPayoutMinor, totalPayoutMinor: unitPayoutMinor * input.unitCount, source: input.rule ? 'PLAYER_OVERRIDE' as const : 'CATALOG_DEFAULT' as const };
}

export async function upsertPlayerCompensationRule(input: { store: PlayerCompensationStore; playerId: string; serviceOfferingId: string; expectedVersion: number | null; type: PlayerCompensationType; value: number; currency: 'CAT' | null; actorStaffId: string; now: Date }) {
  if ((input.type === 'PERCENT_BPS' && (input.value < 1 || input.value > 10000 || input.currency !== null)) || (input.type === 'FIXED_MINOR' && (input.value < 1 || input.currency !== 'CAT')) || !Number.isSafeInteger(input.value)) throw new PlayerCompensationError('VALIDATION_ERROR', 'Compensation rule is invalid.');
  return input.store.upsert({ playerId: input.playerId, serviceOfferingId: input.serviceOfferingId, expectedVersion: input.expectedVersion, type: input.type, value: input.value, currency: input.currency, updatedByStaffId: input.actorStaffId, now: input.now });
}
export async function upsertPlayerCompensationRules(input:{store:PlayerCompensationStore;playerId:string;rules:Array<{serviceOfferingId:string;expectedVersion:number|null;type:PlayerCompensationType;value:number;currency:'CAT'|null}>;actorStaffId:string;now:Date}){
  if(!input.rules.length||input.rules.length>100)throw new PlayerCompensationError('VALIDATION_ERROR','Between 1 and 100 compensation rules are required.');
  for(const rule of input.rules)if(!rule.serviceOfferingId||((rule.type==='PERCENT_BPS'&&(rule.value<1||rule.value>10000||rule.currency!==null))||(rule.type==='FIXED_MINOR'&&(rule.value<1||rule.currency!=='CAT'))||!Number.isSafeInteger(rule.value)))throw new PlayerCompensationError('VALIDATION_ERROR','Compensation rule is invalid.');
  return input.store.upsertBatch(input.rules.map((rule)=>({...rule,playerId:input.playerId,updatedByStaffId:input.actorStaffId,now:input.now})));
}

export function registerPlayerCompensationRoutes(server:FastifyInstance,options:{store:PlayerCompensationStore;now?:()=>Date}){if(!server.securityOptions)throw new Error('Player compensation routes require security options.');const security=server.securityOptions;const now=options.now??(()=>new Date());
  registerSecureReadRoute(server,security,{method:'GET',url:'/api/v1/admin/players/:playerId/compensation',permission:'player.read',action:'LIST_PLAYER_COMPENSATION',targetType:'player_compensation',acceptedSources:['DASHBOARD'],handler:async(request)=>({items:await options.store.list(param(request,'playerId'))}),mapError});
  registerSecureWriteRoute(server,security,{method:'PUT',url:'/api/v1/admin/players/:playerId/compensation',permission:'player.tags.manage',action:'UPSERT_PLAYER_COMPENSATION_BATCH',targetType:'player_compensation',targetId:(request)=>param(request,'playerId'),acceptedSources:['DASHBOARD'],handler:async(request,actor)=>{if(!actor.actorStaffId)throw new PlayerCompensationError('VALIDATION_ERROR','Staff is required.');const body=parseBatchBody(request.body);return{items:await upsertPlayerCompensationRules({store:options.store,playerId:param(request,'playerId'),actorStaffId:actor.actorStaffId,now:now(),rules:body.rules})};},successReason:(request)=>parseBatchBody(request.body).reasonCode,mapError});
  registerSecureWriteRoute(server,security,{method:'PUT',url:'/api/v1/admin/players/:playerId/compensation/:serviceOfferingId',permission:'player.tags.manage',action:'UPSERT_PLAYER_COMPENSATION',targetType:'player_compensation',targetId:(request)=>`${param(request,'playerId')}:${param(request,'serviceOfferingId')}`,acceptedSources:['DASHBOARD'],handler:async(request,actor)=>{if(!actor.actorStaffId)throw new PlayerCompensationError('VALIDATION_ERROR','Staff is required.');const body=parseBody(request.body);return upsertPlayerCompensationRule({store:options.store,playerId:param(request,'playerId'),serviceOfferingId:param(request,'serviceOfferingId'),actorStaffId:actor.actorStaffId,now:now(),...body});},successReason:(request)=>parseBody(request.body).reasonCode,mapError});
}
function parseBody(value:unknown):{type:PlayerCompensationType;value:number;currency:'CAT'|null;expectedVersion:number|null;reasonCode:string}{if(!value||typeof value!=='object'||Array.isArray(value))throw new PlayerCompensationError('VALIDATION_ERROR','Object payload is required.');const body=value as Record<string,unknown>;const type=body.type;if(type!=='PERCENT_BPS'&&type!=='FIXED_MINOR')throw new PlayerCompensationError('VALIDATION_ERROR','type is invalid.');if(!Number.isSafeInteger(body.value))throw new PlayerCompensationError('VALIDATION_ERROR','value is invalid.');const currency=body.currency===null?null:body.currency==='CAT'?'CAT':undefined;if(currency===undefined)throw new PlayerCompensationError('VALIDATION_ERROR','currency is invalid.');const expectedVersion=body.expectedVersion===null?null:Number.isSafeInteger(body.expectedVersion)?Number(body.expectedVersion):undefined;if(expectedVersion===undefined)throw new PlayerCompensationError('VALIDATION_ERROR','expectedVersion is invalid.');const reasonCode=typeof body.reasonCode==='string'&&/^[A-Z0-9_]{3,100}$/.test(body.reasonCode)?body.reasonCode:null;if(!reasonCode)throw new PlayerCompensationError('VALIDATION_ERROR','reasonCode is invalid.');return{type,value:Number(body.value),currency,expectedVersion,reasonCode};}
function parseBatchBody(value:unknown){if(!value||typeof value!=='object'||Array.isArray(value))throw new PlayerCompensationError('VALIDATION_ERROR','Object payload is required.');const body=value as Record<string,unknown>;if(!Array.isArray(body.rules))throw new PlayerCompensationError('VALIDATION_ERROR','rules is invalid.');const rules=body.rules.map((rule)=>{if(!rule||typeof rule!=='object'||Array.isArray(rule)||typeof (rule as Record<string,unknown>).serviceOfferingId!=='string')throw new PlayerCompensationError('VALIDATION_ERROR','serviceOfferingId is invalid.');const record=rule as Record<string,unknown>;const parsed=parseBody({...record,reasonCode:body.reasonCode});return{serviceOfferingId:record.serviceOfferingId as string,...parsed};});const reasonCode=parseBody({type:'PERCENT_BPS',value:1,currency:null,expectedVersion:null,reasonCode:body.reasonCode}).reasonCode;return{rules,reasonCode};}
function param(request:FastifyRequest,key:string){return String((request.params as Record<string,unknown>)[key]??'');}
function mapError(error:unknown){if(!(error instanceof PlayerCompensationError))return null;return{statusCode:error.code==='NOT_FOUND'?404:error.code==='CONFLICT'?409:400,code:error.code,message:error.message};}

interface CompensationRow { id:string;player_id:string;service_offering_id:string;type:PlayerCompensationType;value:number|string;currency:'CAT'|null;row_version:number;updated_by_staff_id:string;created_at:string|Date;updated_at:string|Date }
function mapRow(row:CompensationRow):PlayerCompensationRule{return{id:row.id,playerId:row.player_id,serviceOfferingId:row.service_offering_id,type:row.type,value:Number(row.value),currency:row.currency,version:row.row_version,updatedByStaffId:row.updated_by_staff_id,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()};}
function clone<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}
