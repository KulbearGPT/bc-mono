import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { registerSecureWriteRoute, type ActorContext } from './security.js';

export type RiskEventType =
  | 'PLAYER_NO_SHOW'
  | 'CUSTOMER_NO_SHOW'
  | 'DUPLICATE_ACCOUNT_SIGNAL'
  | 'REFERRAL_ABUSE_SIGNAL'
  | 'PAYMENT_ANOMALY';

export type RiskSeverity = 'LOW' | 'MEDIUM' | 'HIGH';
export type RiskEventSource = 'STAFF_REVIEW' | 'CUSTOMER_REPORT' | 'PLAYER_REPORT' | 'SYSTEM_SIGNAL';

export interface RiskEventRecord {
  id: string;
  userId: string;
  orderId: string | null;
  type: RiskEventType;
  severity: RiskSeverity;
  source: RiskEventSource;
  notes: string;
  createdBy: string;
  createdAt: string;
}

export interface RiskEventResult {
  riskEvent: RiskEventRecord;
  userStatusChanged: false;
}

export interface RiskEventStore {
  createUserRiskEvent(input: {
    userId: string;
    orderId: string | null;
    type: RiskEventType;
    severity: RiskSeverity;
    source: RiskEventSource;
    notes: string;
    actorStaffId: string;
    now: Date;
  }): Promise<RiskEventRecord> | RiskEventRecord;
}

export interface RiskEventQueryClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>;
}

export class RiskEventError extends Error {
  readonly code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'VALIDATION_ERROR';

  constructor(code: RiskEventError['code'], message: string) {
    super(message);
    this.name = 'RiskEventError';
    this.code = code;
  }
}

export class InMemoryRiskEventStore implements RiskEventStore {
  readonly events: RiskEventRecord[];

  constructor(input: { events: RiskEventRecord[] }) {
    this.events = input.events.map(clone);
  }

  createUserRiskEvent(input: {
    userId: string;
    orderId: string | null;
    type: RiskEventType;
    severity: RiskSeverity;
    source: RiskEventSource;
    notes: string;
    actorStaffId: string;
    now: Date;
  }): RiskEventRecord {
    const event: RiskEventRecord = {
      id: crypto.randomUUID(),
      userId: input.userId,
      orderId: input.orderId,
      type: input.type,
      severity: input.severity,
      source: input.source,
      notes: input.notes,
      createdBy: input.actorStaffId,
      createdAt: input.now.toISOString()
    };
    this.events.push(event);
    return clone(event);
  }
}

export class PostgresRiskEventStore implements RiskEventStore {
  private readonly client: RiskEventQueryClient;

  constructor(input: { pool?: Pool; client?: RiskEventQueryClient }) {
    const client = input.pool ?? input.client;
    if (!client) {
      throw new RiskEventError('VALIDATION_ERROR', 'PostgresRiskEventStore requires a pool or client.');
    }
    this.client = client;
  }

  async createUserRiskEvent(input: {
    userId: string;
    orderId: string | null;
    type: RiskEventType;
    severity: RiskSeverity;
    source: RiskEventSource;
    notes: string;
    actorStaffId: string;
    now: Date;
  }): Promise<RiskEventRecord> {
    try {
      const inserted = await this.client.query<RiskEventRow>(
        `
INSERT INTO risk_events (
  id, user_id, order_id, type, severity, source, notes, created_by_staff_id, created_at
)
VALUES (
  gen_random_uuid(), $1, $2, $3::"RiskEventType", $4::"RiskSeverity", $5, $6, $7, $8
)
RETURNING *
        `,
        [
          input.userId,
          input.orderId,
          input.type,
          input.severity,
          input.source,
          input.notes,
          input.actorStaffId,
          input.now.toISOString()
        ]
      );
      return mapRiskEventRow(inserted.rows[0]!);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new RiskEventError('NOT_FOUND', 'User, order, or staff actor was not found.');
      }
      throw error;
    }
  }
}

export async function createUserRiskFlag(input: {
  store: RiskEventStore;
  userId: string;
  actor: ActorContext;
  body: CreateRiskEventInput;
  now: Date;
}): Promise<RiskEventResult> {
  if (!input.actor.actorStaffId) {
    throw new RiskEventError('PERMISSION_DENIED', 'A staff actor is required to create a risk event.');
  }
  const riskEvent = await input.store.createUserRiskEvent({
    userId: input.userId,
    orderId: input.body.orderId,
    type: input.body.type,
    severity: input.body.severity,
    source: input.body.source,
    notes: input.body.notes,
    actorStaffId: input.actor.actorStaffId,
    now: input.now
  });
  return { riskEvent, userStatusChanged: false };
}

export function registerRiskEventRoutes(
  server: FastifyInstance,
  options: { store: RiskEventStore; now?: () => Date }
): void {
  const security = server.securityOptions;
  if (!security) {
    throw new Error('Risk event routes require buildApiServer({ security })');
  }
  const now = options.now ?? (() => new Date());

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/admin/users/:userId/risk-events',
    permission: 'user.risk.manage',
    action: 'CREATE_USER_RISK_EVENT',
    targetType: 'user',
    targetId: (request) => userIdParam(request),
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    successStatusCode: 201,
    handler: async (request, actor) => {
      return createUserRiskFlag({
        store: options.store,
        userId: userIdParam(request),
        actor,
        body: parseCreateRiskEventBody(request.body),
        now: now()
      });
    },
    mapError: mapRiskEventError,
    fingerprintBody: (request) => parseCreateRiskEventBody(request.body)
  });
}

interface CreateRiskEventInput {
  type: RiskEventType;
  severity: RiskSeverity;
  source: RiskEventSource;
  notes: string;
  orderId: string | null;
}

function parseCreateRiskEventBody(body: unknown): CreateRiskEventInput {
  const input = objectBody(body);
  const type = stringField(input.type, 'type') as RiskEventType;
  const severity = stringField(input.severity, 'severity') as RiskSeverity;
  const source = stringField(input.source, 'source') as RiskEventSource;
  const notes = stringField(input.notes, 'notes');
  if (!['PLAYER_NO_SHOW', 'CUSTOMER_NO_SHOW', 'DUPLICATE_ACCOUNT_SIGNAL', 'REFERRAL_ABUSE_SIGNAL', 'PAYMENT_ANOMALY'].includes(type)) {
    throw new RiskEventError('VALIDATION_ERROR', 'type is invalid.');
  }
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(severity)) {
    throw new RiskEventError('VALIDATION_ERROR', 'severity is invalid.');
  }
  if (!['STAFF_REVIEW', 'CUSTOMER_REPORT', 'PLAYER_REPORT', 'SYSTEM_SIGNAL'].includes(source)) {
    throw new RiskEventError('VALIDATION_ERROR', 'source is invalid.');
  }
  if (notes.length > 2_000) {
    throw new RiskEventError('VALIDATION_ERROR', 'notes is too long.');
  }
  return {
    type,
    severity,
    source,
    notes,
    orderId: nullableUuid(input.orderId, 'orderId')
  };
}

function userIdParam(request: FastifyRequest): string {
  const userId = (request.params as { userId?: string }).userId ?? '';
  if (!isUuid(userId)) {
    throw new RiskEventError('VALIDATION_ERROR', 'userId is invalid.');
  }
  return userId;
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RiskEventError('VALIDATION_ERROR', 'Request body must be an object.');
  }
  return body as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RiskEventError('VALIDATION_ERROR', `${field} is required.`);
  }
  return value.trim();
}

function nullableUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new RiskEventError('VALIDATION_ERROR', `${field} is invalid.`);
  }
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function mapRiskEventError(error: unknown): { statusCode: number; code: string; message: string } | null {
  if (!(error instanceof RiskEventError)) {
    return null;
  }
  if (error.code === 'NOT_FOUND') {
    return { statusCode: 404, code: error.code, message: error.message };
  }
  if (error.code === 'PERMISSION_DENIED') {
    return { statusCode: 403, code: error.code, message: error.message };
  }
  return { statusCode: 422, code: error.code, message: error.message };
}

function isForeignKeyViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === '23503');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface RiskEventRow {
  id: string;
  user_id: string;
  order_id: string | null;
  type: RiskEventType;
  severity: RiskSeverity;
  source: RiskEventSource;
  notes: string;
  created_by_staff_id: string;
  created_at: Date | string;
}

function mapRiskEventRow(row: RiskEventRow): RiskEventRecord {
  return {
    id: row.id,
    userId: row.user_id,
    orderId: row.order_id,
    type: row.type,
    severity: row.severity,
    source: row.source,
    notes: row.notes,
    createdBy: row.created_by_staff_id,
    createdAt: new Date(row.created_at).toISOString()
  };
}
