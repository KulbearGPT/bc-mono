import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { validateRuntimeEnv, type RuntimeEnvInput } from '@blackcat/platform/env';
import { hasStaffPermission } from './authorization-policy.js';
import { createPilotFeaturePolicy, type PilotFeature, type PilotFeaturePolicy } from './pilot-features.js';

export type StaffLevel = 'L1_SUPPORT' | 'L2_SUPERVISOR' | 'L3_OPERATIONS' | 'L4_ADMIN_OWNER';
export type ActorSource = 'DISCORD_BOT' | 'DASHBOARD' | 'SYSTEM_JOB' | 'THIRD_PARTY_WEBHOOK' | 'UNKNOWN';
export type AuditOutcome = 'SUCCEEDED' | 'REJECTED' | 'FAILED';

export interface StaffAccount {
  staffId: string;
  userId: string;
  level: StaffLevel;
  permissionsVersion: number;
  status: 'ACTIVE' | 'PENDING_ELEVATION' | 'SUSPENDED' | 'DISABLED';
}

export interface StaffDirectory {
  resolveByDiscord(input: { discordUserId: string; guildId: string }): StaffAccount | null | Promise<StaffAccount | null>;
}

export interface DashboardSessionResolver {
  resolve(sessionToken: string, now?: Date):
    | { ok: true; staff: StaffAccount; csrfToken: string }
    | { ok: false; reason: 'AUTH_REQUIRED' | 'SESSION_REVOKED' }
    | Promise<
        | { ok: true; staff: StaffAccount; csrfToken: string }
        | { ok: false; reason: 'AUTH_REQUIRED' | 'SESSION_REVOKED' }
      >;
  verifyCsrf(sessionToken: string, csrfToken: string): boolean | Promise<boolean>;
  verifyRecentStepUp?(sessionToken: string, now?: Date): boolean | Promise<boolean>;
}

export interface StaffDirectoryQueryClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

export interface ActorContext {
  actorUserId: string | null;
  actorStaffId: string | null;
  actorLevel: StaffLevel | null;
  actorSource: ActorSource;
  clientId: string;
  guildId: string | null;
  discordUserId: string | null;
  interactionId: string | null;
  permissionsVersion: number | null;
}

export interface AuditRecord {
  id: string;
  actorId: string | null;
  actorStaffId: string | null;
  actorLevel: StaffLevel | null;
  actorSource: ActorSource | null;
  clientId: string;
  interactionId: string | null;
  permissionCode: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: AuditOutcome;
  reason: string | null;
  requestId: string;
  approvalRequestId: string | null;
  occurredAt: string;
  beforeSnapshot?: unknown;
  afterSnapshot?: unknown;
}

export interface AuditSink {
  append(record: AuditRecord): void | Promise<void>;
}

export interface AuditQueryClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

export interface IdempotencyRecord {
  scopeKey: string;
  fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  statusCode?: number;
  payload?: unknown;
  errorCode?: string;
  completed?: Promise<IdempotencyRecord>;
}

export interface IdempotencyStore {
  reserve(scopeKey: string, fingerprint: string):
    | { reserved: true; record: IdempotencyRecord }
    | { reserved: false; record: IdempotencyRecord }
    | Promise<{ reserved: true; record: IdempotencyRecord } | { reserved: false; record: IdempotencyRecord }>;
  complete(scopeKey: string, statusCode: number, payload: unknown): void | Promise<void>;
  fail(scopeKey: string, statusCode: number, payload: unknown, errorCode: string): void | Promise<void>;
  retryFailed?(scopeKey: string, fingerprint: string, errorCode: string): boolean | Promise<boolean>;
}

export interface SecurityOptions {
  env?: RuntimeEnvInput;
  now?: () => Date;
  auditSink?: AuditSink;
  idempotencyStore?: IdempotencyStore;
  staffDirectory?: StaffDirectory;
  dashboardSessions?: DashboardSessionResolver;
  dashboardGuildId?: string;
  pilotFeaturePolicy?: PilotFeaturePolicy;
  businessEnvironment?: 'SANDBOX' | 'PRODUCTION';
  stepUpVerifier?: {
    verify(input: { request: FastifyRequest; actor: ActorContext }): boolean | Promise<boolean>;
  };
}

export interface SecureRouteOptions {
  permission: string;
  action: string;
  targetType: string;
  targetId?: (request: FastifyRequest) => string;
  successStatusCode?: number;
  successReason?: (request: FastifyRequest) => string | null;
  acceptedSources?: ActorSource[];
  allowServiceActor?: boolean;
  fingerprintBody?: (request: FastifyRequest) => unknown;
  mapError?: (error: unknown) => {
    statusCode: number;
    code: string;
    message: string;
    details?: Array<{ field: string; reason: string }>;
    retryable?: boolean;
    idempotencyFailureCode?: string;
  } | null;
  requiresRecentStepUp?: boolean | ((request: FastifyRequest, actor: ActorContext) => boolean);
  retryCommitFailures?: boolean;
  retryableFailureCodes?: readonly string[];
  requiredFeature?: PilotFeature;
  auditSnapshots?: (
    request: FastifyRequest,
    actor: ActorContext,
    payload: unknown
  ) => Pick<AuditRecord, 'beforeSnapshot' | 'afterSnapshot'>;
  rawResponse?: (payload: unknown, reply: FastifyReply) => unknown;
}

type SecureHandler = (request: FastifyRequest, actor: ActorContext) => Promise<unknown> | unknown;
type StagedSecureWrite = {
  data: unknown;
  statusCode?: number;
  commit: (successAuditRecord: AuditRecord) => Promise<void> | void;
};

const authenticatedActorPermissions = new Set([
  'service.read',
  'service.estimate',
  'account.bind',
  'account.self.read',
  'balance.self.read',
  'consumption.self.read',
  'commission.self.read',
  'order.create',
  'order.read',
  'order.update',
  'order.estimate',
  'order.submit',
  'order.cancellation.preview',
  'order.cancel',
  'dispatch.execute',
  'order.accept',
  'order.readiness.confirm',
  'order.request_completion',
  'order.confirm',
  'order.legacy_start.reject',
  'staff_task.request',
  'player.workspace.read',
  'player.availability.manage_self',
  'presence.sync',
  'gift.request',
  'access.role_sync',
  'operations.failure.report'
]);
const serviceActorPermissions = new Set(['access.role_sync', 'bot_config.read']);

export class InMemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];

  append(record: AuditRecord): void {
    this.records.push(record);
  }
}

export class PostgresAuditSink implements AuditSink {
  constructor(private readonly options: { client: AuditQueryClient }) {}

  async append(record: AuditRecord): Promise<void> {
    await insertPostgresAuditRecord(this.options.client, record);
  }
}

export async function insertPostgresAuditRecord(client: AuditQueryClient, record: AuditRecord): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (
      id, actor_user_id, actor_staff_id, actor_level, actor_source, client_id,
      interaction_id, permission_code, action, target_type, target_id, outcome,
      before_snapshot, after_snapshot, reason, request_id, approval_request_id, created_at
    ) VALUES (
      $1, $2, $3, $4::"StaffLevel", $5::"ActorSource", $6,
      $7, $8, $9, $10, $11, $12::"AuditOutcome",
      $13::jsonb, $14::jsonb, $15, $16, $17, $18
    )`,
    [
      record.id,
      record.actorId && isAuditUuid(record.actorId) ? record.actorId : null,
      record.actorStaffId,
      record.actorLevel,
      record.actorSource,
      record.clientId,
      record.interactionId,
      record.permissionCode,
      record.action,
      record.targetType,
      record.targetId,
      record.outcome,
      record.beforeSnapshot == null ? null : JSON.stringify(record.beforeSnapshot),
      record.afterSnapshot == null ? null : JSON.stringify(record.afterSnapshot),
      record.reason,
      record.requestId,
      record.approvalRequestId,
      new Date(record.occurredAt)
    ]
  );
}

function isAuditUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();
  private readonly waiters = new Map<string, Array<(record: IdempotencyRecord) => void>>();
  private readonly payloadKey = randomBytes(32);

  get scopeKeys(): string[] {
    return Array.from(this.records.keys());
  }

  reserve(scopeKey: string, fingerprint: string): { reserved: true; record: IdempotencyRecord } | { reserved: false; record: IdempotencyRecord } {
    const existing = this.records.get(scopeKey);
    if (existing) {
      return {
        reserved: false,
        record:
          existing.status === 'IN_PROGRESS'
            ? {
                ...existing,
                completed: new Promise((resolve) => {
                  const waiters = this.waiters.get(scopeKey) ?? [];
                  waiters.push(resolve);
                  this.waiters.set(scopeKey, waiters);
                })
              }
            : hydrateIdempotencyRecord(existing, this.payloadKey)
      };
    }

    const record: IdempotencyRecord = {
      scopeKey,
      fingerprint,
      status: 'IN_PROGRESS'
    };
    this.records.set(scopeKey, record);
    return { reserved: true, record };
  }

  complete(scopeKey: string, statusCode: number, payload: unknown): void {
    const record = this.records.get(scopeKey);
    if (!record) {
      return;
    }
    const completedRecord: IdempotencyRecord & { encryptedPayload: string } = {
      scopeKey,
      fingerprint: record.fingerprint,
      status: 'COMPLETED',
      statusCode,
      encryptedPayload: encryptIdempotencyPayload(payload, this.payloadKey)
    };
    this.records.set(scopeKey, completedRecord);
    for (const waiter of this.waiters.get(scopeKey) ?? []) {
      waiter({ ...completedRecord, payload });
    }
    this.waiters.delete(scopeKey);
  }

  fail(scopeKey: string, statusCode: number, payload: unknown, errorCode: string): void {
    const record = this.records.get(scopeKey);
    if (!record) {
      return;
    }
    const failedRecord: IdempotencyRecord = {
      scopeKey,
      fingerprint: record.fingerprint,
      status: 'FAILED',
      statusCode,
      payload,
      errorCode
    };
    this.records.set(scopeKey, failedRecord);
    for (const waiter of this.waiters.get(scopeKey) ?? []) {
      waiter(failedRecord);
    }
    this.waiters.delete(scopeKey);
  }

  retryFailed(scopeKey: string, fingerprint: string, errorCode: string): boolean {
    const existing = this.records.get(scopeKey);
    if (
      existing?.status !== 'FAILED' ||
      existing.errorCode !== errorCode ||
      existing.fingerprint !== fingerprint
    ) {
      return false;
    }
    this.records.delete(scopeKey);
    return true;
  }
}

export interface IdempotencyQueryClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

interface PostgresIdempotencyRow extends Record<string, unknown> {
  request_hash: string;
  status: IdempotencyRecord['status'];
  response_status_code: number | null;
  response_body: unknown;
  error_code: string | null;
  expires_at: Date | string;
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: { client: IdempotencyQueryClient; ttlMs?: number; now?: () => Date }) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  async reserve(scopeKey: string, fingerprint: string): Promise<{ reserved: true; record: IdempotencyRecord } | { reserved: false; record: IdempotencyRecord }> {
    const scope = parseIdempotencyScope(scopeKey);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    const actorStaffId = scope.actorKey.startsWith('STAFF:') ? scope.actorKey.slice('STAFF:'.length) : null;
    const actorUserId = scope.actorKey.startsWith('USER:') ? scope.actorKey.slice('USER:'.length) : null;
    const inserted = await this.options.client.query<PostgresIdempotencyRow>(
      `INSERT INTO idempotency_records
        (id,client_id,key,operation,actor_key,actor_user_id,actor_staff_id,interaction_id,request_hash,status,
         response_status_code,response_body,error_code,expires_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,'IN_PROGRESS',NULL,NULL,NULL,$9,$10,$10)
       ON CONFLICT (client_id,operation,actor_key,key) DO NOTHING
       RETURNING request_hash,status,response_status_code,response_body,error_code,expires_at`,
      [randomUUID(), scope.clientId, scope.key, scope.operation, scope.actorKey, actorUserId, actorStaffId,
        fingerprint, expiresAt, now]
    );
    if (inserted.rows[0]) return { reserved: true, record: postgresIdempotencyRecord(scopeKey, inserted.rows[0]) };

    const reclaimed = await this.options.client.query<PostgresIdempotencyRow>(
      `UPDATE idempotency_records SET request_hash=$5,status='IN_PROGRESS',response_status_code=NULL,
         response_body=NULL,error_code=NULL,expires_at=$6,updated_at=$7
       WHERE client_id=$1 AND operation=$2 AND actor_key=$3 AND key=$4 AND expires_at<=$7
       RETURNING request_hash,status,response_status_code,response_body,error_code,expires_at`,
      [scope.clientId, scope.operation, scope.actorKey, scope.key, fingerprint, expiresAt, now]
    );
    if (reclaimed.rows[0]) return { reserved: true, record: postgresIdempotencyRecord(scopeKey, reclaimed.rows[0]) };

    const existing = await this.options.client.query<PostgresIdempotencyRow>(
      `SELECT request_hash,status,response_status_code,response_body,error_code,expires_at
       FROM idempotency_records WHERE client_id=$1 AND operation=$2 AND actor_key=$3 AND key=$4`,
      [scope.clientId, scope.operation, scope.actorKey, scope.key]
    );
    if (!existing.rows[0]) return this.reserve(scopeKey, fingerprint);
    return { reserved: false, record: postgresIdempotencyRecord(scopeKey, existing.rows[0]) };
  }

  async complete(scopeKey: string, statusCode: number, payload: unknown): Promise<void> {
    const scope = parseIdempotencyScope(scopeKey);
    await this.options.client.query(
      `UPDATE idempotency_records SET status='COMPLETED',response_status_code=$5,response_body=$6::jsonb,
         error_code=NULL,updated_at=$7 WHERE client_id=$1 AND operation=$2 AND actor_key=$3 AND key=$4`,
      [scope.clientId, scope.operation, scope.actorKey, scope.key, statusCode, JSON.stringify(payload), this.now()]
    );
  }

  async fail(scopeKey: string, statusCode: number, payload: unknown, errorCode: string): Promise<void> {
    const scope = parseIdempotencyScope(scopeKey);
    await this.options.client.query(
      `UPDATE idempotency_records SET status='FAILED',response_status_code=$5,response_body=$6::jsonb,
         error_code=$7,updated_at=$8 WHERE client_id=$1 AND operation=$2 AND actor_key=$3 AND key=$4`,
      [scope.clientId, scope.operation, scope.actorKey, scope.key, statusCode, JSON.stringify(payload), errorCode, this.now()]
    );
  }

  async retryFailed(scopeKey: string, fingerprint: string, errorCode: string): Promise<boolean> {
    const scope = parseIdempotencyScope(scopeKey);
    const deleted = await this.options.client.query(
      `DELETE FROM idempotency_records WHERE client_id=$1 AND operation=$2 AND actor_key=$3 AND key=$4
       AND status='FAILED' AND request_hash=$5 AND error_code=$6`,
      [scope.clientId, scope.operation, scope.actorKey, scope.key, fingerprint, errorCode]
    );
    return deleted.rowCount === 1;
  }
}

function parseIdempotencyScope(scopeKey: string): { clientId: string; operation: string; actorKey: string; key: string } {
  const parsed = JSON.parse(scopeKey) as Record<string, unknown>;
  if (typeof parsed.clientId !== 'string' || typeof parsed.operation !== 'string'
    || typeof parsed.actorKey !== 'string' || typeof parsed.key !== 'string') {
    throw new Error('IDEMPOTENCY_SCOPE_INVALID');
  }
  return { clientId: parsed.clientId, operation: parsed.operation, actorKey: parsed.actorKey, key: parsed.key };
}

function postgresIdempotencyRecord(scopeKey: string, row: PostgresIdempotencyRow): IdempotencyRecord {
  return {
    scopeKey,
    fingerprint: row.request_hash,
    status: row.status,
    statusCode: row.response_status_code ?? undefined,
    payload: row.response_body ?? undefined,
    errorCode: row.error_code ?? undefined
  };
}

function encryptIdempotencyPayload(payload: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((value) => value.toString('base64url')).join('.');
}

function hydrateIdempotencyRecord(record: IdempotencyRecord, key: Buffer): IdempotencyRecord {
  const encrypted = (record as IdempotencyRecord & { encryptedPayload?: string }).encryptedPayload;
  if (!encrypted) return record;
  const [ivValue, tagValue, ciphertextValue] = encrypted.split('.');
  if (!ivValue || !tagValue || !ciphertextValue) throw new Error('IDEMPOTENCY_PAYLOAD_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  const payload = JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final()
  ]).toString('utf8')) as unknown;
  return { scopeKey: record.scopeKey, fingerprint: record.fingerprint, status: record.status, statusCode: record.statusCode, payload, errorCode: record.errorCode };
}

export function registerSecureReadRoute(
  server: FastifyInstance,
  securityOptions: SecurityOptions,
  route: SecureRouteOptions & {
    method: 'GET' | 'POST';
    url: string;
    handler: SecureHandler;
  }
): void {
  const auditSink = securityOptions.auditSink ?? new InMemoryAuditSink();

  server.route({
    method: route.method,
    url: route.url,
    handler: async (request, reply) => {
      const requestId = getRequestId(request);
      const targetId = route.targetId?.(request) ?? '00000000-0000-0000-0000-000000000000';
      const baseAudit = {
        action: route.action,
        targetType: route.targetType,
        targetId,
        permissionCode: route.permission,
        requestId
      };

      const authResult = await authenticateActor(request, securityOptions, route.allowServiceActor === true);
      if (!authResult.ok) {
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildUnauthenticatedAuditContext(request),
          outcome: 'REJECTED',
          reason: authResult.reason
        });
        return sendAuthenticationError(reply, requestId, authResult.reason);
      }

      const actor = authResult.actor;
      if (!isAcceptedSource(actor, route.acceptedSources)) {
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildAuditContext(actor),
          outcome: 'REJECTED',
          reason: 'CLIENT_SOURCE_NOT_ACCEPTED'
        });
        return sendError(reply, requestId, 403, 'CLIENT_SOURCE_NOT_ACCEPTED', 'This client source is not accepted for the route.');
      }

      if (route.requiredFeature && !(securityOptions.pilotFeaturePolicy ?? createPilotFeaturePolicy('OFF')).isEnabled(route.requiredFeature)) {
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildAuditContext(actor),
          outcome: 'REJECTED',
          reason: `FEATURE_DISABLED:${route.requiredFeature}`
        });
        return sendError(
          reply,
          requestId,
          409,
          'FEATURE_DISABLED',
          'This feature is disabled for the current pilot phase.',
          [{ field: 'feature', reason: route.requiredFeature }]
        );
      }

      if (!hasPermission(actor, route.permission)) {
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildAuditContext(actor),
          outcome: 'REJECTED',
          reason: 'PERMISSION_DENIED'
        });
        return sendError(
          reply,
          requestId,
          403,
          'PERMISSION_DENIED',
          'The actor is not permitted to perform this action.',
          [{ field: 'permission', reason: `${route.permission} required` }]
        );
      }

      const requiresRecentStepUp = typeof route.requiresRecentStepUp === 'function'
        ? route.requiresRecentStepUp(request, actor)
        : route.requiresRecentStepUp === true;
      if (requiresRecentStepUp && !(await hasRecentStepUp(request, actor, securityOptions))) {
        await appendAudit(auditSink, { ...baseAudit, ...buildAuditContext(actor), outcome: 'REJECTED', reason: 'STEP_UP_REQUIRED' });
        return sendError(reply, requestId, 428, 'STEP_UP_REQUIRED', 'A recent MFA step-up is required for this sensitive action.');
      }

      try {
        const payload = await route.handler(request, actor);
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildAuditContext(actor),
          outcome: 'SUCCEEDED',
          reason: route.successReason?.(request) ?? null
        });
        reply.code(route.successStatusCode ?? 200);
        if (route.rawResponse) return route.rawResponse(payload, reply);
        return {
          requestId,
          data: payload
        };
      } catch (error) {
        const mappedError = route.mapError?.(error);
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildAuditContext(actor),
          outcome: 'FAILED',
          reason: 'HANDLER_FAILED'
        });
        return sendError(
          reply,
          requestId,
          mappedError?.statusCode ?? 500,
          mappedError?.code ?? 'OPERATION_FAILED',
          mappedError?.message ?? 'The operation failed.',
          mappedError?.details ?? []
        );
      }
    }
  });
}

export function registerSecureWriteRoute(
  server: FastifyInstance,
  securityOptions: SecurityOptions,
  route: SecureRouteOptions & {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url: string;
    handler: SecureHandler;
  }
): void {
  const auditSink = securityOptions.auditSink ?? new InMemoryAuditSink();
  const idempotencyStore = securityOptions.idempotencyStore ?? new InMemoryIdempotencyStore();

  server.route({
    method: route.method,
    url: route.url,
    handler: async (request, reply) => {
      const requestId = getRequestId(request);
      const targetId = route.targetId?.(request) ?? '00000000-0000-0000-0000-000000000000';
      const baseAudit = {
        action: route.action,
        targetType: route.targetType,
        targetId,
        permissionCode: route.permission,
        requestId
      };

      const authResult = await authenticateActor(request, securityOptions, route.allowServiceActor === true);
      if (!authResult.ok) {
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildUnauthenticatedAuditContext(request),
          outcome: 'REJECTED',
          reason: authResult.reason
        });
        return sendAuthenticationError(reply, requestId, authResult.reason);
      }

      const actor = authResult.actor;
      if (!isAcceptedSource(actor, route.acceptedSources)) {
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildAuditContext(actor),
          outcome: 'REJECTED',
          reason: 'CLIENT_SOURCE_NOT_ACCEPTED'
        });
        return sendError(reply, requestId, 403, 'CLIENT_SOURCE_NOT_ACCEPTED', 'This client source is not accepted for the route.');
      }

      if (route.requiredFeature && !(securityOptions.pilotFeaturePolicy ?? createPilotFeaturePolicy('OFF')).isEnabled(route.requiredFeature)) {
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildAuditContext(actor),
          outcome: 'REJECTED',
          reason: `FEATURE_DISABLED:${route.requiredFeature}`
        });
        return sendError(
          reply,
          requestId,
          409,
          'FEATURE_DISABLED',
          'This feature is disabled for the current pilot phase.',
          [{ field: 'feature', reason: route.requiredFeature }]
        );
      }

      if (actor.actorSource === 'DASHBOARD' && !(await hasValidDashboardCsrf(request, securityOptions))) {
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildAuditContext(actor),
          outcome: 'REJECTED',
          reason: 'CSRF_REQUIRED'
        });
        return sendError(reply, requestId, 403, 'CSRF_REQUIRED', 'A valid CSRF token is required.');
      }

      const idempotencyKey = getHeader(request, 'idempotency-key');
      if (!idempotencyKey) {
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildAuditContext(actor),
          outcome: 'REJECTED',
          reason: 'IDEMPOTENCY_KEY_REQUIRED'
        });
        return sendError(reply, requestId, 400, 'VALIDATION_ERROR', 'Idempotency-Key is required.');
      }
      if (!isValidIdempotencyKey(idempotencyKey)) {
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildAuditContext(actor),
          outcome: 'REJECTED',
          reason: 'IDEMPOTENCY_KEY_INVALID'
        });
        return sendError(
          reply,
          requestId,
          400,
          'VALIDATION_ERROR',
          'Idempotency-Key must be 16-200 characters and contain only letters, numbers, colon, underscore, or dash.',
          [{ field: 'idempotency-key', reason: 'must match ^[A-Za-z0-9:_-]+$ and length 16-200' }]
        );
      }

      if (!hasPermission(actor, route.permission)) {
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildAuditContext(actor),
          outcome: 'REJECTED',
          reason: 'PERMISSION_DENIED'
        });
        return sendError(
          reply,
          requestId,
          403,
          'PERMISSION_DENIED',
          'The actor is not permitted to perform this action.',
          [{ field: 'permission', reason: `${route.permission} required` }]
        );
      }

      const requiresRecentStepUp = typeof route.requiresRecentStepUp === 'function'
        ? route.requiresRecentStepUp(request, actor)
        : route.requiresRecentStepUp === true;
      if (requiresRecentStepUp) {
        const verified = await hasRecentStepUp(request, actor, securityOptions);
        if (!verified) {
          await appendAudit(auditSink, {
            ...baseAudit,
            ...buildAuditContext(actor),
            outcome: 'REJECTED',
            reason: 'STEP_UP_REQUIRED'
          });
          return sendError(
            reply,
            requestId,
            428,
            'STEP_UP_REQUIRED',
            'A recent MFA step-up is required for this sensitive action.'
          );
        }
      }

      let fingerprintBody:unknown;
      try{fingerprintBody=route.fingerprintBody?.(request);}catch(error){const mapped=route.mapError?.(error);await appendAudit(auditSink,{...baseAudit,...buildAuditContext(actor),outcome:'REJECTED',reason:mapped?.code??'VALIDATION_ERROR'});return sendError(reply,requestId,mapped?.statusCode??400,mapped?.code??'VALIDATION_ERROR',mapped?.message??'The request payload is invalid.',mapped?.details??[]);}
      const fingerprint = buildRequestFingerprint(request, actor, fingerprintBody);
      const scopeKey = buildIdempotencyScopeKey(idempotencyKey, route.action, actor);
      if (route.retryCommitFailures) {
        await idempotencyStore.retryFailed?.(scopeKey, fingerprint, 'COMMIT_FAILED');
      }
      for (const failureCode of route.retryableFailureCodes ?? []) {
        if (await idempotencyStore.retryFailed?.(scopeKey, fingerprint, failureCode)) break;
      }
      const reservation = await idempotencyStore.reserve(scopeKey, fingerprint);
      if (!reservation.reserved) {
        if (reservation.record.fingerprint !== fingerprint) {
          await appendAudit(auditSink, {
            ...baseAudit,
            ...buildAuditContext(actor),
            outcome: 'REJECTED',
            reason: 'IDEMPOTENCY_CONFLICT'
          });
          return sendError(
            reply,
            requestId,
            409,
            'IDEMPOTENCY_CONFLICT',
            'The same Idempotency-Key was used with a different request fingerprint.'
          );
        }

        const record = reservation.record.completed ? await reservation.record.completed : reservation.record;
        if (record.status !== 'COMPLETED' && record.status !== 'FAILED') {
          return sendError(
            reply,
            requestId,
            409,
            'IDEMPOTENCY_IN_PROGRESS',
            'The same Idempotency-Key is already being processed.'
          );
        }
        reply.header('x-idempotency-replayed', 'true');
        reply.code(record.statusCode ?? 200);
        return record.payload;
      }

      const failReservedRequest = async (
        code: string,
        message: string,
        reason: string,
        statusCode = 500,
        details: Array<{ field: string; reason: string }> = [],
        retryable = false,
        idempotencyFailureCode = reason
      ) => {
        const failedPayload = buildErrorPayload(requestId, code, message, details, retryable);
        try {
          await appendAudit(auditSink, {
            ...baseAudit,
            ...buildAuditContext(actor),
            outcome: 'FAILED',
            reason
          });
        } catch {
          // The idempotency record must still be resolved so duplicate writes do not hang forever.
        }
        await idempotencyStore.fail(scopeKey, statusCode, failedPayload, idempotencyFailureCode);
        reply.code(statusCode);
        return failedPayload;
      };

      let handlerResult: unknown;
      try {
        handlerResult = await route.handler(request, actor);
      } catch (error) {
        const mappedError = route.mapError?.(error);
        return failReservedRequest(
          mappedError?.code ?? 'OPERATION_FAILED',
          mappedError?.message ?? 'The operation failed before it could be completed.',
          mappedError?.code ?? 'HANDLER_FAILED',
          mappedError?.statusCode ?? 500,
          mappedError?.details ?? [],
          mappedError?.retryable ?? false,
          mappedError?.idempotencyFailureCode ?? mappedError?.code ?? 'HANDLER_FAILED'
        );
      }

      const stagedWrite = normalizeHandlerResult(handlerResult);
      const payload = stagedWrite.data;
      const responsePayload = {
        requestId,
        data: payload
      };
      let auditSnapshots: Pick<AuditRecord, 'beforeSnapshot' | 'afterSnapshot'> = {};
      try {
        auditSnapshots = route.auditSnapshots?.(request, actor, payload) ?? {};
        const successAuditInput = {
          ...baseAudit,
          ...buildAuditContext(actor),
          ...auditSnapshots,
          outcome: 'SUCCEEDED',
          reason: route.successReason?.(request) ?? null
        } satisfies Omit<AuditRecord, 'id' | 'occurredAt'>;
        if (stagedWrite.commit) {
          await stagedWrite.commit(buildAuditRecord(successAuditInput));
        } else {
          await appendAudit(auditSink, successAuditInput);
        }
      } catch (error) {
        const mappedError = route.mapError?.(error);
        if (mappedError) {
          return failReservedRequest(mappedError.code, mappedError.message, mappedError.code, mappedError.statusCode, mappedError.details ?? []);
        }
        const failureCode = stagedWrite.commit ? 'COMMIT_FAILED' : 'AUDIT_APPEND_FAILED';
        return failReservedRequest(
          failureCode,
          stagedWrite.commit
            ? 'The operation could not be committed transactionally.'
            : 'The operation could not be recorded in the audit log.',
          failureCode
        );
      }

      const statusCode = stagedWrite.statusCode ?? route.successStatusCode ?? 200;
      await idempotencyStore.complete(scopeKey, statusCode, responsePayload);
      reply.code(statusCode);
      return responsePayload;
    }
  });
}

async function hasRecentStepUp(request: FastifyRequest, actor: ActorContext, securityOptions: SecurityOptions): Promise<boolean> {
  const explicitVerification = securityOptions.stepUpVerifier?.verify({ request, actor });
  if (explicitVerification !== undefined) return explicitVerification;
  const sessionToken = actor.actorSource === 'DASHBOARD' ? parseCookie(request, 'p0_session') : null;
  return Boolean(sessionToken && securityOptions.dashboardSessions?.verifyRecentStepUp
    && await securityOptions.dashboardSessions.verifyRecentStepUp(
      sessionToken,
      securityOptions.now?.() ?? new Date()
    ));
}

export function registerSecurityProbeRoutes(server: FastifyInstance): void {
  const security = server.securityOptions;
  if (!security) {
    throw new Error('Security probe routes require buildApiServer({ security })');
  }

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/__m0/security/staff-task-claim-probe',
    permission: 'staff_task.claim',
    action: 'STAFF_TASK_CLAIM_PROBE',
    targetType: 'staff_task',
    targetId: () => '00000000-0000-0000-0000-00000000c1a1',
    handler: (_request, actor) => ({
      actorLevel: actor.actorLevel,
      claimed: true
    })
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/__m0/security/gift-approval-probe',
    permission: 'gift.approve',
    action: 'GIFT_APPROVAL_PROBE',
    targetType: 'gift_request',
    targetId: () => '00000000-0000-0000-0000-00000000babe',
    handler: (_request, actor) => ({
      actorLevel: actor.actorLevel,
      approved: true,
      approvedByStaffId: actor.actorStaffId
    })
  });
}

export class PostgresStaffDirectory implements StaffDirectory {
  private readonly client: StaffDirectoryQueryClient;

  constructor(options: { client: StaffDirectoryQueryClient }) {
    this.client = options.client;
  }

  async resolveByDiscord(input: { discordUserId: string; guildId: string }): Promise<StaffAccount | null> {
    const result = await this.client.query<{
      staff_id: string;
      user_id: string;
      level: StaffLevel;
      permissions_version: number;
      status: StaffAccount['status'];
    }>(
      `
SELECT staff.id AS staff_id,
       staff.user_id,
       staff.level,
       staff.permissions_version,
       staff.status
FROM discord_accounts AS discord
JOIN staff_accounts AS staff ON staff.user_id = discord.user_id
WHERE discord.guild_id = $1
  AND discord.discord_user_id = $2
LIMIT 1
      `,
      [input.guildId, input.discordUserId]
    );
    const row = result.rows[0];
    return row
      ? {
          staffId: row.staff_id,
          userId: row.user_id,
          level: row.level,
          permissionsVersion: row.permissions_version,
          status: row.status
        }
      : null;
  }
}

async function authenticateActor(
  request: FastifyRequest,
  securityOptions: SecurityOptions,
  allowServiceActor = false
): Promise<{ ok: true; actor: ActorContext } | { ok: false; reason: string }> {
  const env = securityOptions.env ?? process.env;
  const validation = validateRuntimeEnv(env, { allowMissingDiscordToken: true });
  const expectedToken = validation.values.botServiceToken;
  const authorization = getHeader(request, 'authorization');
  const actorSourceResult = getActorSource(request);
  if (!actorSourceResult.ok) {
    return { ok: false, reason: 'INVALID_CLIENT_SOURCE' };
  }
  const actorSource = actorSourceResult.actorSource;

  if (actorSource === 'DASHBOARD' && securityOptions.dashboardSessions) {
    const sessionToken = parseCookie(request, 'p0_session');
    if (!sessionToken || !securityOptions.dashboardSessions) {
      return { ok: false, reason: 'AUTH_REQUIRED' };
    }
    const session = await securityOptions.dashboardSessions.resolve(sessionToken, securityOptions.now?.() ?? new Date());
    if (!session.ok) return { ok: false, reason: session.reason };
    const staff = session.staff;
    return {
      ok: true,
      actor: {
        actorUserId: staff.userId,
        actorStaffId: staff.staffId,
        actorLevel: staff.level,
        actorSource: 'DASHBOARD',
        clientId: 'DASHBOARD',
        guildId: securityOptions.dashboardGuildId?.trim() || null,
        discordUserId: null,
        interactionId: null,
        permissionsVersion: staff.permissionsVersion
      }
    };
  }

  if (!expectedToken || authorization !== `Bearer ${expectedToken}`) {
    return { ok: false, reason: 'AUTH_REQUIRED' };
  }
  if (actorSource === 'SYSTEM_JOB') {
    return {
      ok: true,
      actor: {
        actorUserId: null,
        actorStaffId: null,
        actorLevel: null,
        actorSource,
        clientId: actorSource,
        guildId: null,
        discordUserId: null,
        interactionId: getHeader(request, 'x-discord-interaction-id'),
        permissionsVersion: null
      }
    };
  }
  if (actorSource === 'DISCORD_BOT' && allowServiceActor
    && !getHeader(request, 'x-actor-discord-user-id') && !getHeader(request, 'x-actor-guild-id')) {
    return {
      ok: true,
      actor: {
        actorUserId: null,
        actorStaffId: null,
        actorLevel: null,
        actorSource,
        clientId: 'DISCORD_BOT_SERVICE',
        guildId: null,
        discordUserId: null,
        interactionId: getHeader(request, 'x-discord-interaction-id'),
        permissionsVersion: null
      }
    };
  }
  if (actorSource !== 'DISCORD_BOT' && actorSource !== 'DASHBOARD') {
    return { ok: false, reason: 'UNSUPPORTED_CLIENT_SOURCE' };
  }

  const discordUserId = getHeader(request, 'x-actor-discord-user-id');
  const guildId = getHeader(request, 'x-actor-guild-id');
  if (!discordUserId || !guildId) {
    return { ok: false, reason: 'ACTOR_CONTEXT_REQUIRED' };
  }

  const staff = (await securityOptions.staffDirectory?.resolveByDiscord({ discordUserId, guildId })) ?? null;
  if (!staff || staff.status !== 'ACTIVE') {
    return {
      ok: true,
      actor: {
        actorUserId: null,
        actorStaffId: null,
        actorLevel: null,
        actorSource,
        clientId: actorSource,
        guildId,
        discordUserId,
        interactionId: getHeader(request, 'x-discord-interaction-id'),
        permissionsVersion: null
      }
    };
  }

  return {
    ok: true,
    actor: {
      actorUserId: staff.userId,
      actorStaffId: staff.staffId,
      actorLevel: staff.level,
      actorSource,
      clientId: actorSource,
      guildId,
      discordUserId,
      interactionId: getHeader(request, 'x-discord-interaction-id'),
      permissionsVersion: staff.permissionsVersion
    }
  };
}

async function hasValidDashboardCsrf(request: FastifyRequest, securityOptions: SecurityOptions): Promise<boolean> {
  // Trusted service-token compatibility is retained only when Dashboard sessions are not configured.
  if (!securityOptions.dashboardSessions) return true;
  const sessionToken = parseCookie(request, 'p0_session');
  const csrfCookie = parseCookie(request, 'p0_csrf');
  const csrfHeader = getHeader(request, 'x-csrf-token');
  if (!sessionToken || !csrfCookie || !csrfHeader || csrfCookie !== csrfHeader || !securityOptions.dashboardSessions) {
    return false;
  }
  return securityOptions.dashboardSessions.verifyCsrf(sessionToken, csrfHeader);
}

function parseCookie(request: FastifyRequest, name: string): string | null {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name && value.length > 0) return decodeURIComponent(value.join('='));
  }
  return null;
}

function hasPermission(actor: ActorContext, permission: string): boolean {
  if (actor.clientId === 'DISCORD_BOT_SERVICE') return serviceActorPermissions.has(permission);
  if (authenticatedActorPermissions.has(permission)) {
    return true;
  }
  if (!actor.actorLevel) {
    return false;
  }
  return hasStaffPermission(actor.actorLevel, permission);
}

function isAcceptedSource(actor: ActorContext, acceptedSources: ActorSource[] | undefined): boolean {
  return !acceptedSources || acceptedSources.includes(actor.actorSource);
}

function isValidIdempotencyKey(key: string): boolean {
  return key.length >= 16 && key.length <= 200 && /^[A-Za-z0-9:_-]+$/.test(key);
}

function normalizeHandlerResult(result: unknown): {
  data: unknown;
  statusCode?: number;
  commit?: (successAuditRecord: AuditRecord) => Promise<void> | void;
} {
  if (isStagedSecureWrite(result)) {
    return result;
  }
  return { data: result };
}

function isStagedSecureWrite(result: unknown): result is StagedSecureWrite {
  if (!result || typeof result !== 'object') {
    return false;
  }
  return 'data' in result && typeof (result as { commit?: unknown }).commit === 'function';
}

function buildRequestFingerprint(request: FastifyRequest, actor: ActorContext, sanitizedBody?: unknown): string {
  return createHash('sha256').update(JSON.stringify({
    method: request.method,
    url: request.url,
    body: sanitizedBody ?? request.body ?? null,
    actorUserId: actor.actorUserId,
    actorStaffId: actor.actorStaffId,
    actorSource: actor.actorSource,
    guildId: actor.guildId,
    discordUserId: actor.discordUserId,
    permissionsVersion: actor.permissionsVersion
  })).digest('hex');
}

function buildIdempotencyScopeKey(
  key: string,
  operation: string,
  actor: ActorContext
): string {
  return JSON.stringify({
    clientId: actor.clientId,
    operation,
    actorKey: buildActorKey(actor),
    key
  });
}

function buildActorKey(actor: ActorContext): string {
  if (actor.actorStaffId) {
    return `STAFF:${actor.actorStaffId}`;
  }
  if (actor.actorUserId) {
    return `USER:${actor.actorUserId}`;
  }
  if (actor.guildId && actor.discordUserId) {
    return `DISCORD:${actor.guildId}:${actor.discordUserId}`;
  }
  return 'SYSTEM:anonymous';
}

function buildAuditContext(actor: ActorContext) {
  return {
    actorId: actor.actorUserId,
    actorStaffId: actor.actorStaffId,
    actorLevel: actor.actorLevel,
    actorSource: actor.actorSource,
    clientId: actor.clientId,
    interactionId: actor.interactionId,
    approvalRequestId: null
  };
}

function buildUnauthenticatedAuditContext(request: FastifyRequest) {
  const actorSource = getActorSource(request);
  return {
    actorId: null,
    actorStaffId: null,
    actorLevel: null,
    actorSource: actorSource.actorSource ?? 'UNKNOWN',
    clientId: actorSource.actorSource ?? 'UNKNOWN',
    interactionId: getHeader(request, 'x-discord-interaction-id'),
    approvalRequestId: null
  };
}

async function appendAudit(
  auditSink: AuditSink,
  input: Omit<AuditRecord, 'id' | 'occurredAt'>
): Promise<void> {
  await auditSink.append(buildAuditRecord(input));
}

function buildAuditRecord(input: Omit<AuditRecord, 'id' | 'occurredAt'>): AuditRecord {
  return {
    id: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    ...input
  };
}

function sendError(
  reply: FastifyReply,
  requestId: string,
  statusCode: number,
  code: string,
  message: string,
  details: Array<{ field: string; reason: string }> = []
) {
  reply.code(statusCode);
  return buildErrorPayload(requestId, code, message, details);
}

function sendAuthenticationError(reply: FastifyReply, requestId: string, reason: string) {
  if (reason === 'SESSION_REVOKED') {
    return sendError(reply, requestId, 401, 'SESSION_REVOKED', 'The staff session is expired or has been revoked.');
  }
  return sendError(reply, requestId, 401, 'AUTH_REQUIRED', 'Authentication or actor context is invalid.');
}

function buildErrorPayload(
  requestId: string,
  code: string,
  message: string,
  details: Array<{ field: string; reason: string }> = [],
  retryable = false
) {
  return {
    requestId,
    error: {
      code,
      message,
      retryable,
      details
    }
  };
}

function getActorSource(
  request: FastifyRequest
): { ok: true; actorSource: ActorSource } | { ok: false; actorSource: null } {
  const source = getHeader(request, 'x-client-source');
  if (
    source === 'DASHBOARD' ||
    source === 'SYSTEM_JOB' ||
    source === 'THIRD_PARTY_WEBHOOK' ||
    source === 'DISCORD_BOT'
  ) {
    return { ok: true, actorSource: source };
  }
  return { ok: false, actorSource: null };
}

function getRequestId(request: FastifyRequest): string {
  return getHeader(request, 'x-request-id') ?? `req_${crypto.randomUUID()}`;
}

function getHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

declare module 'fastify' {
  interface FastifyInstance {
    securityOptions?: SecurityOptions;
  }
}
