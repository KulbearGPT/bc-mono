import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { validateRuntimeEnv, type RuntimeEnvInput } from '@blackcat/platform/env';

export type StaffLevel = 'L1_SUPPORT' | 'L2_SUPERVISOR' | 'L3_OPERATIONS' | 'L4_ADMIN_OWNER';
export type ActorSource = 'DISCORD_BOT' | 'DASHBOARD' | 'SYSTEM_JOB' | 'THIRD_PARTY_WEBHOOK';
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
  reserve(scopeKey: string, fingerprint: string): { reserved: true; record: IdempotencyRecord } | { reserved: false; record: IdempotencyRecord };
  complete(scopeKey: string, statusCode: number, payload: unknown): void;
  fail(scopeKey: string, statusCode: number, payload: unknown, errorCode: string): void;
  retryFailed?(scopeKey: string, fingerprint: string, errorCode: string): boolean;
}

export interface SecurityOptions {
  env?: RuntimeEnvInput;
  auditSink?: AuditSink;
  idempotencyStore?: IdempotencyStore;
  staffDirectory?: StaffDirectory;
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
  fingerprintBody?: (request: FastifyRequest) => unknown;
  mapError?: (error: unknown) => { statusCode: number; code: string; message: string; details?: Array<{ field: string; reason: string }> } | null;
  requiresRecentStepUp?: boolean | ((request: FastifyRequest, actor: ActorContext) => boolean);
  retryCommitFailures?: boolean;
  auditSnapshots?: (
    request: FastifyRequest,
    actor: ActorContext,
    payload: unknown
  ) => Pick<AuditRecord, 'beforeSnapshot' | 'afterSnapshot'>;
}

type SecureHandler = (request: FastifyRequest, actor: ActorContext) => Promise<unknown> | unknown;
type StagedSecureWrite = {
  data: unknown;
  statusCode?: number;
  commit: (successAuditRecord: AuditRecord) => Promise<void> | void;
};

const levelRank: Record<StaffLevel, number> = {
  L1_SUPPORT: 1,
  L2_SUPERVISOR: 2,
  L3_OPERATIONS: 3,
  L4_ADMIN_OWNER: 4
};

const minimumPermissionLevel: Record<string, StaffLevel> = {
  'catalog.read': 'L2_SUPERVISOR',
  'catalog.manage': 'L3_OPERATIONS',
  'staff_task.claim': 'L1_SUPPORT',
  'staff_task.verify': 'L1_SUPPORT',
  'staff_task.resolve': 'L2_SUPERVISOR',
  'gift.approve': 'L2_SUPERVISOR',
  'gift.reject': 'L2_SUPERVISOR',
  'earnings.read': 'L2_SUPERVISOR',
  'earnings.manage': 'L3_OPERATIONS',
  'commission.read': 'L3_OPERATIONS',
  'commission.manage': 'L3_OPERATIONS',
  'referral.read': 'L2_SUPERVISOR',
  'referral.manage': 'L3_OPERATIONS',
  'refund.execute': 'L2_SUPERVISOR',
  'order.resolve': 'L2_SUPERVISOR',
  'order.reassign': 'L2_SUPERVISOR',
  'order.pause': 'L1_SUPPORT',
  'order.resume': 'L2_SUPERVISOR',
  'player.approve': 'L3_OPERATIONS',
  'player.status.manage': 'L3_OPERATIONS',
  'player.tags.manage': 'L2_SUPERVISOR',
  'user.risk.manage': 'L2_SUPERVISOR',
  'job.read': 'L2_SUPERVISOR',
  'job.retry': 'L2_SUPERVISOR',
  'audit.read': 'L1_SUPPORT',
  'access.manage': 'L4_ADMIN_OWNER'
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
  'gift.request'
]);

export class InMemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];

  append(record: AuditRecord): void {
    this.records.push(record);
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();
  private readonly waiters = new Map<string, Array<(record: IdempotencyRecord) => void>>();

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
            : existing
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
    const completedRecord: IdempotencyRecord = {
      scopeKey,
      fingerprint: record.fingerprint,
      status: 'COMPLETED',
      statusCode,
      payload
    };
    this.records.set(scopeKey, completedRecord);
    for (const waiter of this.waiters.get(scopeKey) ?? []) {
      waiter(completedRecord);
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

export function registerSecureReadRoute(
  server: FastifyInstance,
  securityOptions: SecurityOptions,
  route: SecureRouteOptions & {
    method: 'GET';
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

      const authResult = await authenticateActor(request, securityOptions);
      if (!authResult.ok) {
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildUnauthenticatedAuditContext(request),
          outcome: 'REJECTED',
          reason: authResult.reason
        });
        return sendError(reply, requestId, 401, 'AUTH_REQUIRED', 'Authentication or actor context is invalid.');
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

      if (!hasPermission(actor.actorLevel, route.permission)) {
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

      try {
        const payload = await route.handler(request, actor);
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildAuditContext(actor),
          outcome: 'SUCCEEDED',
          reason: route.successReason?.(request) ?? null
        });
        reply.code(route.successStatusCode ?? 200);
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

      const authResult = await authenticateActor(request, securityOptions);
      if (!authResult.ok) {
        await appendAudit(auditSink, {
          ...baseAudit,
          ...buildUnauthenticatedAuditContext(request),
          outcome: 'REJECTED',
          reason: authResult.reason
        });
        return sendError(reply, requestId, 401, 'AUTH_REQUIRED', 'Authentication or actor context is invalid.');
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

      if (!hasPermission(actor.actorLevel, route.permission)) {
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
        const verified = await securityOptions.stepUpVerifier?.verify({ request, actor }) ?? false;
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
        idempotencyStore.retryFailed?.(scopeKey, fingerprint, 'COMMIT_FAILED');
      }
      const reservation = idempotencyStore.reserve(scopeKey, fingerprint);
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
        details: Array<{ field: string; reason: string }> = []
      ) => {
        const failedPayload = buildErrorPayload(requestId, code, message, details);
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
        idempotencyStore.fail(scopeKey, statusCode, failedPayload, reason);
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
          mappedError?.details ?? []
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
      idempotencyStore.complete(scopeKey, statusCode, responsePayload);
      reply.code(statusCode);
      return responsePayload;
    }
  });
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
  securityOptions: SecurityOptions
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

function hasPermission(level: StaffLevel | null, permission: string): boolean {
  if (authenticatedActorPermissions.has(permission)) {
    return true;
  }
  if (!level) {
    return false;
  }
  const minimumLevel = minimumPermissionLevel[permission];
  if (!minimumLevel) {
    return false;
  }
  return levelRank[level] >= levelRank[minimumLevel];
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
  return JSON.stringify({
    method: request.method,
    url: request.url,
    body: sanitizedBody ?? request.body ?? null,
    actorUserId: actor.actorUserId,
    actorStaffId: actor.actorStaffId,
    actorSource: actor.actorSource,
    guildId: actor.guildId,
    discordUserId: actor.discordUserId,
    permissionsVersion: actor.permissionsVersion
  });
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
    actorSource: actorSource.actorSource,
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

function buildErrorPayload(
  requestId: string,
  code: string,
  message: string,
  details: Array<{ field: string; reason: string }> = []
) {
  return {
    requestId,
    error: {
      code,
      message,
      retryable: false,
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
