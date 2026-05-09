import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { registerSecureReadRoute, registerSecureWriteRoute } from './security.js';

export type CommissionStatus = 'PENDING' | 'CONFIRMED' | 'PAID' | 'REVERSED';
export type CommissionAdjustmentType = 'REVERSAL_DEBIT' | 'CORRECTION_DEBIT' | 'CORRECTION_CREDIT';

export interface CommissionAdjustmentRecord {
  id: string; commissionId: string; type: CommissionAdjustmentType; sourceRefundId: string | null;
  amountMinor: number; currency: string; reason: string; idempotencyKey: string;
  createdByStaffId: string | null; createdAt: string;
}

export interface CommissionRecord {
  id: string; referralAttributionId: string; sourceCustomerId: string; beneficiaryId: string;
  programType: 'PROMOTER_FIRST_PURCHASE' | 'PLAYER_LIFETIME'; rewardMode: 'FIXED_FIRST_PURCHASE' | 'PERCENT_FIRST_PURCHASE' | 'PERCENT_LIFETIME';
  sourceType: 'ORDER' | 'GIFT'; sourceId: string; baseAmountMinor: number; rateBps: number | null;
  amountMinor: number; currency: string; status: CommissionStatus; adjustments: CommissionAdjustmentRecord[];
  netAmountMinor: number; version: number; confirmedAt: string | null; paidAt: string | null;
  createdAt: string; updatedAt: string;
}

export interface CommissionMutationInput {
  commissionId: string; expectedVersion: number; action: 'CONFIRM' | 'MARK_PAID' | 'CREATE_REVERSAL';
  reversalAmount?: { amountMinor: number; currency: string }; reason: string; idempotencyKey: string;
  actorStaffId: string; now: Date;
}

export interface CommissionStore {
  list(input: { status?: CommissionStatus; limit: number }): Promise<CommissionRecord[]> | CommissionRecord[];
  get(id: string): Promise<CommissionRecord> | CommissionRecord;
  mutate(input: CommissionMutationInput): Promise<CommissionMutationResult> | CommissionMutationResult;
}

export interface CommissionMutationResult {
  resultType: 'STATE_UPDATED' | 'ADJUSTMENT_CREATED'; commission: CommissionRecord;
  adjustment: CommissionAdjustmentRecord | null;
}

export class CommissionError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'VALIDATION_ERROR' | 'CONFLICT', message: string) {
    super(message); this.name = 'CommissionError';
  }
}

export class InMemoryCommissionStore implements CommissionStore {
  readonly commissions: CommissionRecord[];
  constructor(input: { commissions?: CommissionRecord[] } = {}) { this.commissions = structuredClone(input.commissions ?? []); }
  list(input: { status?: CommissionStatus; limit: number }): CommissionRecord[] {
    return structuredClone(this.commissions.filter((item) => !input.status || item.status === input.status).slice(0, input.limit));
  }
  get(id: string): CommissionRecord {
    const item = this.commissions.find((candidate) => candidate.id === id);
    if (!item) throw new CommissionError('NOT_FOUND', 'Commission was not found.');
    return structuredClone(item);
  }
  mutate(input: CommissionMutationInput): CommissionMutationResult {
    const item = this.commissions.find((candidate) => candidate.id === input.commissionId);
    if (!item) throw new CommissionError('NOT_FOUND', 'Commission was not found.');
    if (input.action === 'CREATE_REVERSAL') {
      const replay = item.adjustments.find((adjustment) => adjustment.idempotencyKey === input.idempotencyKey);
      if (replay) return { resultType: 'ADJUSTMENT_CREATED', commission: structuredClone(item), adjustment: structuredClone(replay) };
    }
    if (item.version !== input.expectedVersion) throw new CommissionError('CONFLICT', 'Commission version is stale.');
    if (input.action === 'CONFIRM') {
      if (item.status !== 'PENDING') throw new CommissionError('CONFLICT', 'Only pending commissions can be confirmed.');
      Object.assign(item, { status: 'CONFIRMED', version: item.version + 1, confirmedAt: input.now.toISOString(), updatedAt: input.now.toISOString() });
      return { resultType: 'STATE_UPDATED', commission: structuredClone(item), adjustment: null };
    }
    if (input.action === 'MARK_PAID') {
      if (item.status !== 'CONFIRMED') throw new CommissionError('CONFLICT', 'Only confirmed commissions can be marked paid.');
      Object.assign(item, { status: 'PAID', version: item.version + 1, paidAt: input.now.toISOString(), updatedAt: input.now.toISOString() });
      return { resultType: 'STATE_UPDATED', commission: structuredClone(item), adjustment: null };
    }
    const amount = requireReversal(input, item);
    if (amount.amountMinor > item.netAmountMinor) throw new CommissionError('VALIDATION_ERROR', 'Reversal exceeds net commission.');
    const adjustment: CommissionAdjustmentRecord = { id: deterministicUuid(`commission-adjustment:${input.idempotencyKey}`),
      commissionId: item.id, type: 'REVERSAL_DEBIT', sourceRefundId: null, amountMinor: amount.amountMinor,
      currency: amount.currency, reason: input.reason, idempotencyKey: input.idempotencyKey,
      createdByStaffId: input.actorStaffId, createdAt: input.now.toISOString() };
    item.adjustments.push(adjustment); item.netAmountMinor -= amount.amountMinor; item.version += 1; item.updatedAt = input.now.toISOString();
    return { resultType: 'ADJUSTMENT_CREATED', commission: structuredClone(item), adjustment: structuredClone(adjustment) };
  }
}

export class PostgresCommissionStore implements CommissionStore {
  constructor(private readonly pool: Pool) {}
  async list(input: { status?: CommissionStatus; limit: number }): Promise<CommissionRecord[]> {
    const result = await this.pool.query<{ id: string }>(`SELECT id FROM commissions
      WHERE ($1::text IS NULL OR status::text=$1) ORDER BY created_at DESC,id DESC LIMIT $2`, [input.status ?? null, input.limit]);
    return Promise.all(result.rows.map((row) => loadCommission(this.pool, row.id)));
  }
  get(id: string): Promise<CommissionRecord> { return loadCommission(this.pool, id); }
  async mutate(input: CommissionMutationInput): Promise<CommissionMutationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (input.action === 'CREATE_REVERSAL') {
        const replay = await client.query<{ commission_id: string }>('SELECT commission_id FROM commission_adjustments WHERE idempotency_key=$1', [input.idempotencyKey]);
        if (replay.rows[0]) {
          const commission = await loadCommission(client, replay.rows[0].commission_id, true);
          const adjustment = commission.adjustments.find((item) => item.idempotencyKey === input.idempotencyKey)!;
          await client.query('COMMIT'); return { resultType: 'ADJUSTMENT_CREATED', commission, adjustment };
        }
      }
      const item = await loadCommission(client, input.commissionId, true);
      if (item.version !== input.expectedVersion) throw new CommissionError('CONFLICT', 'Commission version is stale.');
      if (input.action === 'CONFIRM') {
        if (item.status !== 'PENDING') throw new CommissionError('CONFLICT', 'Only pending commissions can be confirmed.');
        await client.query("UPDATE commissions SET status='CONFIRMED',row_version=row_version+1,confirmed_at=$2,updated_at=$2 WHERE id=$1", [item.id, input.now]);
        const commission = await loadCommission(client, item.id); await client.query('COMMIT');
        return { resultType: 'STATE_UPDATED', commission, adjustment: null };
      }
      if (input.action === 'MARK_PAID') {
        if (item.status !== 'CONFIRMED') throw new CommissionError('CONFLICT', 'Only confirmed commissions can be marked paid.');
        await client.query("UPDATE commissions SET status='PAID',row_version=row_version+1,paid_at=$2,updated_at=$2 WHERE id=$1", [item.id, input.now]);
        const commission = await loadCommission(client, item.id); await client.query('COMMIT');
        return { resultType: 'STATE_UPDATED', commission, adjustment: null };
      }
      const amount = requireReversal(input, item);
      if (amount.amountMinor > item.netAmountMinor) throw new CommissionError('VALIDATION_ERROR', 'Reversal exceeds net commission.');
      const id = deterministicUuid(`commission-adjustment:${input.idempotencyKey}`);
      await client.query(`INSERT INTO commission_adjustments
        (id,commission_id,type,source_refund_id,amount_minor,currency,reason,idempotency_key,created_by_staff_id,created_at)
        VALUES ($1,$2,'REVERSAL_DEBIT',NULL,$3,$4,$5,$6,$7,$8)`, [id,item.id,amount.amountMinor,amount.currency,input.reason,input.idempotencyKey,input.actorStaffId,input.now]);
      await client.query('UPDATE commissions SET row_version=row_version+1,updated_at=$2 WHERE id=$1', [item.id,input.now]);
      const commission = await loadCommission(client,item.id); const adjustment = commission.adjustments.find((value) => value.id === id)!;
      await client.query('COMMIT'); return { resultType: 'ADJUSTMENT_CREATED', commission, adjustment };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}

export function registerCommissionRoutes(server: FastifyInstance, options: { store: CommissionStore; now?: () => Date }): void {
  if (!server.securityOptions) throw new Error('Commission routes require security options.');
  const security = server.securityOptions; const now = options.now ?? (() => new Date());
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/admin/commissions', permission: 'commission.read',
    action: 'LIST_COMMISSIONS', targetType: 'commission', acceptedSources: ['DASHBOARD','DISCORD_BOT'],
    handler: async (request) => ({ items: await options.store.list({ status: parseStatus((request.query as {status?: unknown}).status), limit: pageLimit(request) }), nextCursor: null }), mapError });
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/admin/commissions/:commissionId', permission: 'commission.read',
    action: 'GET_COMMISSION_CONFIDENTIAL', targetType: 'commission', targetId: commissionIdParam, acceptedSources: ['DASHBOARD','DISCORD_BOT'],
    handler: (request) => options.store.get(commissionIdParam(request)), mapError });
  registerSecureWriteRoute(server, security, { method: 'PATCH', url: '/api/v1/admin/commissions/:commissionId', permission: 'commission.manage',
    action: 'UPDATE_COMMISSION', targetType: 'commission', targetId: commissionIdParam, acceptedSources: ['DASHBOARD','DISCORD_BOT'], requiresRecentStepUp: true,
    handler: (request, actor) => {
      if (!actor.actorStaffId) throw new CommissionError('PERMISSION_DENIED','A staff actor is required.');
      return options.store.mutate({ ...parseMutation(request.body), commissionId: commissionIdParam(request), actorStaffId: actor.actorStaffId,
        idempotencyKey: request.headers['idempotency-key'] as string, now: now() });
    }, fingerprintBody: (request) => parseMutation(request.body), successReason: (request) => parseMutation(request.body).reason, mapError });
}

async function loadCommission(client: Pick<Pool,'query'> | PoolClient, id: string, forUpdate=false): Promise<CommissionRecord> {
  const result = await client.query<CommissionRow>(`SELECT c.id,c.referral_attribution_id,c.beneficiary_user_id,c.program_type_snapshot,
    c.award_mode_snapshot,c.base_amount_minor,c.rate_bps,c.amount_minor,c.currency,c.status,c.row_version,c.confirmed_at,c.paid_at,c.created_at,c.updated_at,
    ra.referred_user_id AS source_customer_id,ce.source_type,COALESCE(ce.order_id,ce.gift_request_id) AS source_id
    FROM commissions c JOIN referral_attributions ra ON ra.id=c.referral_attribution_id JOIN consumption_entries ce ON ce.id=c.source_consumption_entry_id
    WHERE c.id=$1${forUpdate ? ' FOR UPDATE OF c' : ''}`, [id]);
  const row=result.rows[0]; if(!row) throw new CommissionError('NOT_FOUND','Commission was not found.');
  const adjustmentRows=await client.query<CommissionAdjustmentRow>(`SELECT id,commission_id,type,source_refund_id,amount_minor,currency,reason,idempotency_key,created_by_staff_id,created_at
    FROM commission_adjustments WHERE commission_id=$1 ORDER BY created_at,id`,[id]);
  const adjustments=adjustmentRows.rows.map(mapAdjustment);
  const net=adjustments.reduce((value,item)=>item.type==='CORRECTION_CREDIT'?value+item.amountMinor:value-item.amountMinor,Number(row.amount_minor));
  return { id:row.id,referralAttributionId:row.referral_attribution_id,sourceCustomerId:row.source_customer_id,beneficiaryId:row.beneficiary_user_id,
    programType:row.program_type_snapshot,rewardMode:mapRewardMode(row.program_type_snapshot,row.award_mode_snapshot),sourceType:row.source_type,sourceId:row.source_id,
    baseAmountMinor:Number(row.base_amount_minor),rateBps:row.rate_bps,amountMinor:Number(row.amount_minor),currency:row.currency,status:row.status,
    adjustments,netAmountMinor:Math.max(0,net),version:row.row_version,confirmedAt:nullableIso(row.confirmed_at),paidAt:nullableIso(row.paid_at),
    createdAt:toIso(row.created_at),updatedAt:toIso(row.updated_at) };
}

function parseMutation(value: unknown) {
  const body=value as Record<string,unknown>; const reason=[body?.reasonCode,body?.note].filter((item):item is string=>typeof item==='string').join(': ');
  if(!body||!Number.isInteger(body.expectedVersion)||!['CONFIRM','MARK_PAID','CREATE_REVERSAL'].includes(String(body.action))||reason.length<3)
    throw new CommissionError('VALIDATION_ERROR','expectedVersion, action, and reasonCode are required.');
  const money=body.reversalAmount as Record<string,unknown>|undefined;
  const reversalAmount=money&&Number.isInteger(money.amountMinor)&&typeof money.currency==='string'?{amountMinor:money.amountMinor as number,currency:money.currency}:undefined;
  return {expectedVersion:body.expectedVersion as number,action:body.action as CommissionMutationInput['action'],reversalAmount,reason};
}
function requireReversal(input:CommissionMutationInput,item:CommissionRecord){const amount=input.reversalAmount;if(!amount||amount.amountMinor<1||amount.currency!==item.currency)throw new CommissionError('VALIDATION_ERROR','A positive reversalAmount in the commission currency is required.');return amount;}
function pageLimit(request:FastifyRequest){const value=Number((request.query as {limit?:unknown}).limit??50);if(!Number.isInteger(value)||value<1||value>100)throw new CommissionError('VALIDATION_ERROR','limit must be between 1 and 100.');return value;}
function parseStatus(value:unknown):CommissionStatus|undefined{if(value===undefined)return undefined;if(!['PENDING','CONFIRMED','PAID','REVERSED'].includes(String(value)))throw new CommissionError('VALIDATION_ERROR','status is invalid.');return value as CommissionStatus;}
function commissionIdParam(request:FastifyRequest){const id=(request.params as {commissionId?:unknown}).commissionId;if(typeof id!=='string')throw new CommissionError('VALIDATION_ERROR','commissionId is required.');return id;}
function mapError(error:unknown){if(!(error instanceof CommissionError))return null;return {statusCode:error.code==='NOT_FOUND'?404:error.code==='PERMISSION_DENIED'?403:error.code==='VALIDATION_ERROR'?400:409,code:error.code,message:error.message};}
function mapAdjustment(row:CommissionAdjustmentRow):CommissionAdjustmentRecord{return{id:row.id,commissionId:row.commission_id,type:row.type,sourceRefundId:row.source_refund_id,amountMinor:Number(row.amount_minor),currency:row.currency,reason:row.reason,idempotencyKey:row.idempotency_key,createdByStaffId:row.created_by_staff_id,createdAt:toIso(row.created_at)};}
function mapRewardMode(program:CommissionRecord['programType'],mode:'FIXED_MINOR'|'NET_SPEND_BPS'):CommissionRecord['rewardMode']{if(mode==='FIXED_MINOR')return'FIXED_FIRST_PURCHASE';return program==='PROMOTER_FIRST_PURCHASE'?'PERCENT_FIRST_PURCHASE':'PERCENT_LIFETIME';}
function deterministicUuid(seed:string){const bytes=crypto.createHash('sha256').update(seed).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;return`${bytes.subarray(0,4).toString('hex')}-${bytes.subarray(4,6).toString('hex')}-${bytes.subarray(6,8).toString('hex')}-${bytes.subarray(8,10).toString('hex')}-${bytes.subarray(10).toString('hex')}`;}
function toIso(value:Date|string){return value instanceof Date?value.toISOString():new Date(value).toISOString();} function nullableIso(value:Date|string|null){return value?toIso(value):null;}
interface CommissionRow{id:string;referral_attribution_id:string;beneficiary_user_id:string;program_type_snapshot:CommissionRecord['programType'];award_mode_snapshot:'FIXED_MINOR'|'NET_SPEND_BPS';base_amount_minor:string|number|bigint;rate_bps:number|null;amount_minor:string|number|bigint;currency:string;status:CommissionStatus;row_version:number;confirmed_at:Date|string|null;paid_at:Date|string|null;created_at:Date|string;updated_at:Date|string;source_customer_id:string;source_type:'ORDER'|'GIFT';source_id:string;}
interface CommissionAdjustmentRow{id:string;commission_id:string;type:CommissionAdjustmentType;source_refund_id:string|null;amount_minor:string|number|bigint;currency:string;reason:string;idempotency_key:string;created_by_staff_id:string|null;created_at:Date|string;}
