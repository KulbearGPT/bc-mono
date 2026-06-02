import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
import { PostgresOrderStore, type OrderRecord } from './orders.js';
import { TransactionTimelineError, type TransactionTimelineStore } from './transaction-timeline.js';
import type { CustomerProfileScope } from './customer-profiles.js';
import type { PilotFeature } from './pilot-features.js';

export type AdminOrderListItem = OrderRecord;
export type AdminConsumptionMirrorType = 'ORDER' | 'GIFT' | 'REFUND_REVERSAL' | 'ADMIN_CORRECTION';
export interface AdminUserRecord { id: string; displayName: string; status: string; externalAccountDisplay: string | null; activeOrderId: string | null; riskFlags: string[]; version: number }
export interface AdminPlayerRecord { playerId: string; reviewStatus: string; availability: string; discordPresence: string; gameTags: string[]; serviceTags: string[]; activeOrderId: string | null; version: number }
export interface AdminConsumptionRecord { id: string; userId: string; type: AdminConsumptionMirrorType; sourceId: string; amountMinor: number; currency: string; status: string; occurredAt: string; reversalOf: string | null; guildId?: string }
export interface AdminGiftCatalogRecord { id: string; code: string; name: string; priceMinor: number; currency: string; enabled: boolean; version: number; broadcastTemplate: string; createdAt: string }
export interface AdminGiftRequestRecord { id: string; publicId: string; orderId: string; senderId: string; receiverId: string; status: string; rowVersion: number; giftName: string; amountMinor: number; currency: string; announcementStatus: string; createdAt: string }
interface Page<T> { items: T[]; nextCursor: string | null }
interface StagedAdminWrite<T> {
  data: T;
  commit(auditRecord: AuditRecord, auditSink: AuditSink): Promise<void> | void;
}

export interface AdminDirectoryStore {
  listOrders(input: PageInput & { status?: string; query?: string; actorStaffId: string; actorLevel: string }): Promise<Page<AdminOrderListItem>> | Page<AdminOrderListItem>;
  listUsers(input: PageInput & { query?: string }): Promise<Page<AdminUserRecord>> | Page<AdminUserRecord>;
  getUser(userId: string): Promise<AdminUserRecord | null> | AdminUserRecord | null;
  listUserConsumptions(input: PageInput & { userId: string; guildId?: string; type?: AdminConsumptionMirrorType }): Promise<Page<AdminConsumptionRecord>> | Page<AdminConsumptionRecord>;
  setUserStatus(input: { userId: string; expectedVersion: number; status: string; reasonCode: string; note: string | null; actorStaffId: string; now: Date }): Promise<StagedAdminWrite<AdminUserRecord>> | StagedAdminWrite<AdminUserRecord>;
  listPlayers(input: PageInput & { reviewStatus?: string }): Promise<Page<AdminPlayerRecord>> | Page<AdminPlayerRecord>;
  getPlayer(playerId: string): Promise<AdminPlayerRecord | null> | AdminPlayerRecord | null;
  listGiftCatalog(input: PageInput): Promise<Page<AdminGiftCatalogRecord>> | Page<AdminGiftCatalogRecord>;
  createGiftCatalog(input: { name: string; amountMinor: number; currency: string; enabled: boolean; broadcastTemplate: string; reasonCode: string; actorStaffId: string; now: Date }): Promise<StagedAdminWrite<AdminGiftCatalogRecord>> | StagedAdminWrite<AdminGiftCatalogRecord>;
  updateGiftCatalog(input: { giftCatalogId: string; expectedVersion: number; action: string; reasonCode: string; replacement: GiftCatalogCreateBody | null; actorStaffId: string; now: Date }): Promise<StagedAdminWrite<AdminGiftCatalogRecord>> | StagedAdminWrite<AdminGiftCatalogRecord>;
  listGiftRequests(input: PageInput & { status?: string; actorStaffId: string; actorLevel: string }): Promise<Page<AdminGiftRequestRecord>> | Page<AdminGiftRequestRecord>;
  getGiftRequest(input: { giftRequestId: string; actorStaffId: string; actorLevel: string }): Promise<AdminGiftRequestRecord | null> | AdminGiftRequestRecord | null;
}

interface PageInput { cursor: string | null; limit: number }
type CursorResource = 'orders' | 'users' | 'user_consumptions' | 'players' | 'gift_catalog' | 'gift_requests';
interface CursorPayload { version: 1; resource: CursorResource; keys: string[] }
interface GiftCatalogCreateBody { name: string; amountMinor: number; currency: string; enabled: boolean; broadcastTemplate: string; reasonCode: string }

const cursorSigningKey = process.env.BOT_SERVICE_TOKEN
  ? Buffer.from(process.env.BOT_SERVICE_TOKEN, 'utf8')
  : randomBytes(32);

export class AdminDirectoryError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION_ERROR' | 'PERMISSION_DENIED', message: string) { super(message); this.name = 'AdminDirectoryError'; }
}

export class InMemoryAdminDirectoryStore implements AdminDirectoryStore {
  readonly orders: AdminOrderListItem[];
  readonly users: AdminUserRecord[];
  readonly players: AdminPlayerRecord[];
  readonly consumptions: AdminConsumptionRecord[];
  readonly gifts: AdminGiftCatalogRecord[];
  readonly giftRequests: AdminGiftRequestRecord[];
  private readonly visibleOrderIdsByStaffId: Record<string, string[]>;
  private readonly visibleGiftRequestIdsByStaffId: Record<string, string[]>;

  constructor(input: { orders: AdminOrderListItem[]; users: AdminUserRecord[]; players: AdminPlayerRecord[]; consumptions: AdminConsumptionRecord[]; gifts: AdminGiftCatalogRecord[]; giftRequests: AdminGiftRequestRecord[]; visibleOrderIdsByStaffId?: Record<string, string[]>; visibleGiftRequestIdsByStaffId?: Record<string, string[]> }) {
    this.orders = clone(input.orders); this.users = clone(input.users); this.players = clone(input.players);
    this.consumptions = clone(input.consumptions); this.gifts = clone(input.gifts); this.giftRequests = clone(input.giftRequests);
    this.visibleOrderIdsByStaffId = clone(input.visibleOrderIdsByStaffId ?? {});
    this.visibleGiftRequestIdsByStaffId = clone(input.visibleGiftRequestIdsByStaffId ?? {});
  }

  listOrders(input: PageInput & { status?: string; query?: string; actorStaffId: string; actorLevel: string }) {
    const visibleIds = input.actorLevel === 'L1_SUPPORT' ? new Set(this.visibleOrderIdsByStaffId[input.actorStaffId] ?? []) : null;
    return page(this.orders.filter((item) => (!visibleIds || visibleIds.has(item.id)) && (!input.status || item.status === input.status) && (!input.query || `${item.publicId} ${item.id}`.toLowerCase().includes(input.query.toLowerCase()))), input, 'orders', orderCursorKeys);
  }
  listUsers(input: PageInput & { query?: string }) { return page(this.users.filter((item) => !input.query || `${item.displayName} ${item.id}`.toLowerCase().includes(input.query.toLowerCase())), input, 'users', userCursorKeys); }
  getUser(userId: string) { return clone(this.users.find((item) => item.id === userId) ?? null); }
  listUserConsumptions(input: PageInput & { userId: string; guildId?: string; type?: AdminConsumptionMirrorType }) {
    const scoped = this.consumptions.filter((item) => item.userId === input.userId && (!input.guildId || item.guildId === input.guildId) && (!input.type || item.type === input.type));
    return page(scoped.map(({ guildId: _guildId, ...item }) => item), input, 'user_consumptions', consumptionCursorKeys);
  }
  listPlayers(input: PageInput & { reviewStatus?: string }) { return page(this.players.filter((item) => !input.reviewStatus || item.reviewStatus === input.reviewStatus), input, 'players', playerCursorKeys); }
  getPlayer(playerId: string) { return clone(this.players.find((item) => item.playerId === playerId) ?? null); }
  listGiftCatalog(input: PageInput) { return page(this.gifts, input, 'gift_catalog', giftCatalogCursorKeys); }
  listGiftRequests(input: PageInput & { status?: string; actorStaffId: string; actorLevel: string }) { const visibleIds = input.actorLevel === 'L1_SUPPORT' ? new Set(this.visibleGiftRequestIdsByStaffId[input.actorStaffId] ?? []) : null; return page(this.giftRequests.filter((item) => (!visibleIds || visibleIds.has(item.id)) && (!input.status || item.status === input.status)), input, 'gift_requests', giftRequestCursorKeys); }
  getGiftRequest(input: { giftRequestId: string; actorStaffId: string; actorLevel: string }) { const visibleIds = input.actorLevel === 'L1_SUPPORT' ? new Set(this.visibleGiftRequestIdsByStaffId[input.actorStaffId] ?? []) : null; return clone(this.giftRequests.find((item) => item.id === input.giftRequestId && (!visibleIds || visibleIds.has(item.id))) ?? null); }

  setUserStatus(input: { userId: string; expectedVersion: number; status: string; reasonCode: string; note: string | null; actorStaffId: string; now: Date }) {
    const user = this.users.find((item) => item.id === input.userId);
    if (!user) throw new AdminDirectoryError('NOT_FOUND', 'User was not found.');
    if (user.version !== input.expectedVersion) throw new AdminDirectoryError('CONFLICT', 'User version is stale.');
    const updated = clone({ ...user, status: input.status, version: user.version + 1 });
    return {
      data: updated,
      commit: async (auditRecord: AuditRecord, auditSink: AuditSink) => {
        const current = this.users.find((item) => item.id === input.userId);
        if (!current) throw new AdminDirectoryError('NOT_FOUND', 'User was not found.');
        if (current.version !== input.expectedVersion) throw new AdminDirectoryError('CONFLICT', 'User version is stale.');
        const snapshot = clone(current);
        try {
          Object.assign(current, clone(updated));
          await auditSink.append(auditRecord);
        } catch (error) {
          Object.assign(current, snapshot);
          throw error;
        }
      }
    };
  }

  createGiftCatalog(input: { name: string; amountMinor: number; currency: string; enabled: boolean; broadcastTemplate: string; reasonCode: string; actorStaffId: string; now: Date }) {
    const gift: AdminGiftCatalogRecord = { id: crypto.randomUUID(), code: `GIFT_${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: input.name,
      priceMinor: input.amountMinor, currency: input.currency, enabled: input.enabled, version: 1, broadcastTemplate: input.broadcastTemplate, createdAt: input.now.toISOString() };
    return {
      data: clone(gift),
      commit: async (auditRecord: AuditRecord, auditSink: AuditSink) => {
        if (this.gifts.some((item) => item.id === gift.id || item.code === gift.code)) {
          throw new AdminDirectoryError('CONFLICT', 'Gift catalog item already exists.');
        }
        this.gifts.push(clone(gift));
        try {
          await auditSink.append(auditRecord);
        } catch (error) {
          const index = this.gifts.findIndex((item) => item.id === gift.id);
          if (index >= 0) this.gifts.splice(index, 1);
          throw error;
        }
      }
    };
  }

  updateGiftCatalog(input: { giftCatalogId: string; expectedVersion: number; action: string; reasonCode: string; replacement: GiftCatalogCreateBody | null; actorStaffId: string; now: Date }) {
    const gift = this.gifts.find((item) => item.id === input.giftCatalogId);
    if (!gift) throw new AdminDirectoryError('NOT_FOUND', 'Gift catalog item was not found.');
    if (gift.version !== input.expectedVersion) throw new AdminDirectoryError('CONFLICT', 'Gift catalog version is stale.');
    const updated = buildUpdatedGift(gift, input);
    return {
      data: clone(updated),
      commit: async (auditRecord: AuditRecord, auditSink: AuditSink) => {
        const current = this.gifts.find((item) => item.id === input.giftCatalogId);
        if (!current) throw new AdminDirectoryError('NOT_FOUND', 'Gift catalog item was not found.');
        if (current.version !== input.expectedVersion) throw new AdminDirectoryError('CONFLICT', 'Gift catalog version is stale.');
        const snapshot = clone(current);
        try {
          Object.assign(current, clone(updated));
          await auditSink.append(auditRecord);
        } catch (error) {
          Object.assign(current, snapshot);
          throw error;
        }
      }
    };
  }
}

export class PostgresAdminDirectoryStore implements AdminDirectoryStore {
  private readonly orders: PostgresOrderStore;

  constructor(private readonly pool: Pool) { this.orders = new PostgresOrderStore({ pool }); }

  async listOrders(input: PageInput & { status?: string; query?: string; actorStaffId: string; actorLevel: string }) {
    const keys = cursorKeys(input.cursor, 'orders');
    const rows = await this.pool.query<{ id: string }>(`SELECT id FROM orders
      WHERE ($1::text IS NULL OR status::text = $1) AND ($2::text IS NULL OR public_id ILIKE '%' || $2 || '%' OR id::text = $2)
      AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
      AND ($6::text <> 'L1_SUPPORT' OR EXISTS (
        SELECT 1 FROM staff_tasks task WHERE task.order_id = orders.id AND task.claimed_by_staff_id = $7::uuid
        AND task.status IN ('CLAIMED', 'VERIFIED', 'PENDING_APPROVAL')
      ))
      ORDER BY created_at DESC, id DESC LIMIT $5`, [input.status ?? null, input.query ?? null, keys?.[0] ?? null, keys?.[1] ?? null, input.limit + 1, input.actorLevel, input.actorStaffId]);
    const records = await Promise.all(rows.rows.map((row) => this.orders.findById(row.id)));
    return pageFromRows(records.filter((record): record is OrderRecord => record !== null), input, 'orders', orderCursorKeys);
  }

  async listUsers(input: PageInput & { query?: string }) {
    const keys = cursorKeys(input.cursor, 'users');
    const rows = await this.pool.query<AdminUserRow>(userSelect + ` WHERE ($1::text IS NULL OR u.display_name ILIKE '%' || $1 || '%' OR u.id::text = $1 OR da.discord_user_id = $1)
      AND ($2::uuid IS NULL OR u.id < $2::uuid)
      GROUP BY u.id, da.discord_user_id, active_order.id ORDER BY u.id DESC LIMIT $3`, [input.query ?? null, keys?.[0] ?? null, input.limit + 1]);
    return pageFromRows(rows.rows.map(mapUser), input, 'users', userCursorKeys);
  }

  async getUser(userId: string) {
    const rows = await this.pool.query<AdminUserRow>(userSelect + ` WHERE u.id = $1 GROUP BY u.id, da.discord_user_id, active_order.id LIMIT 1`, [userId]);
    return rows.rows[0] ? mapUser(rows.rows[0]) : null;
  }

  async listUserConsumptions(input: PageInput & { userId: string; guildId?: string; type?: AdminConsumptionMirrorType }) {
    const entryType = input.type ? consumptionEntryTypeByMirrorType[input.type] : null;
    const keys = cursorKeys(input.cursor, 'user_consumptions');
    const rows = await this.pool.query<ConsumptionRow>(`SELECT id, user_id, entry_type::text, source_id, amount_minor, currency, direction::text, occurred_at, reversal_of_entry_id
      FROM consumption_entries ce WHERE ce.user_id = $1 AND ($2::text IS NULL OR ce.entry_type::text = $2)
      AND ($3::timestamptz IS NULL OR (ce.occurred_at, ce.id) < ($3::timestamptz, $4::uuid))
      AND ($6::text IS NULL OR ${adminConsumptionGuildPredicate('ce', '$6')})
      ORDER BY ce.occurred_at DESC, ce.id DESC LIMIT $5`, [input.userId, entryType, keys?.[0] ?? null, keys?.[1] ?? null, input.limit + 1, input.guildId ?? null]);
    const records = rows.rows.map((row) => ({ id: row.id, userId: row.user_id, type: mapConsumptionEntryType(row.entry_type), sourceId: row.source_id,
      amountMinor: (row.direction === 'DEBIT' ? 1 : -1) * safeMinorInteger(row.amount_minor), currency: row.currency, status: row.direction === 'DEBIT' ? 'SUCCEEDED' : 'REVERSED',
      occurredAt: new Date(row.occurred_at).toISOString(), reversalOf: row.reversal_of_entry_id }));
    return pageFromRows(records, input, 'user_consumptions', consumptionCursorKeys);
  }

  async setUserStatus(input: { userId: string; expectedVersion: number; status: string; reasonCode: string; note: string | null; actorStaffId: string; now: Date }) {
    const current = await this.getUser(input.userId);
    if (!current) throw new AdminDirectoryError('NOT_FOUND', 'User was not found.');
    if (current.version !== input.expectedVersion) throw new AdminDirectoryError('CONFLICT', 'User version is stale.');
    const data = { ...current, status: input.status, version: current.version + 1 };
    return {
      data,
      commit: async (auditRecord: AuditRecord, _auditSink: AuditSink) => {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          const updated = await client.query(`UPDATE users SET status = $3::"UserStatus", row_version = row_version + 1,
            suspended_at = CASE WHEN $3 = 'SUSPENDED' THEN $4::timestamptz ELSE NULL END, suspension_reason = CASE WHEN $3 = 'SUSPENDED' THEN $5 ELSE NULL END, updated_at = $4
            WHERE id = $1 AND row_version = $2 RETURNING id`, [input.userId, input.expectedVersion, input.status, input.now.toISOString(), input.note ?? input.reasonCode]);
          if (!updated.rows[0]) throw new AdminDirectoryError('CONFLICT', 'User version is stale or user was not found.');
          await insertPostgresAuditRecord(client, auditRecord);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }
    };
  }

  async listPlayers(input: PageInput & { reviewStatus?: string }) {
    const keys = cursorKeys(input.cursor, 'players');
    const rows = await this.pool.query<PlayerRow>(playerSelect + ` WHERE ($1::text IS NULL OR pp.review_status::text = $1)
      AND ($2::uuid IS NULL OR pp.id < $2::uuid)
      GROUP BY pp.id, active_order.id ORDER BY pp.id DESC LIMIT $3`, [input.reviewStatus ?? null, keys?.[0] ?? null, input.limit + 1]);
    return pageFromRows(rows.rows.map(mapPlayer), input, 'players', playerCursorKeys);
  }
  async getPlayer(playerId: string) { const rows = await this.pool.query<PlayerRow>(playerSelect + ` WHERE pp.id = $1 GROUP BY pp.id, active_order.id LIMIT 1`, [playerId]); return rows.rows[0] ? mapPlayer(rows.rows[0]) : null; }

  async listGiftCatalog(input: PageInput) {
    const keys = cursorKeys(input.cursor, 'gift_catalog');
    const rows = await this.pool.query<GiftCatalogRow>(`SELECT item.id, item.code, version.name, version.price_minor, version.currency, version.status::text,
      version.version, version.broadcast_template, version.created_at FROM gift_catalog_items item
      JOIN LATERAL (
        SELECT name, price_minor, currency, status, version, broadcast_template, created_at, id
        FROM gift_catalog_versions WHERE gift_catalog_item_id = item.id ORDER BY version DESC LIMIT 1
      ) version ON TRUE
      WHERE ($1::timestamptz IS NULL OR (version.created_at, item.id) < ($1::timestamptz, $2::uuid))
      ORDER BY version.created_at DESC, item.id DESC LIMIT $3`, [keys?.[0] ?? null, keys?.[1] ?? null, input.limit + 1]);
    return pageFromRows(rows.rows.map(mapGiftCatalog), input, 'gift_catalog', giftCatalogCursorKeys);
  }

  async createGiftCatalog(input: { name: string; amountMinor: number; currency: string; enabled: boolean; broadcastTemplate: string; reasonCode: string; actorStaffId: string; now: Date }) {
    const data: AdminGiftCatalogRecord = {
      id: crypto.randomUUID(), code: `GIFT_${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: input.name,
      priceMinor: input.amountMinor, currency: input.currency, enabled: input.enabled, version: 1,
      broadcastTemplate: input.broadcastTemplate, createdAt: input.now.toISOString()
    };
    return {
      data,
      commit: async (auditRecord: AuditRecord, _auditSink: AuditSink) => {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`INSERT INTO gift_catalog_items (id, code, created_at, updated_at) VALUES ($1::uuid, $2, $3, $3)`, [data.id, data.code, input.now]);
          await client.query(`INSERT INTO gift_catalog_versions (id, gift_catalog_item_id, version, status, active_gift_key, name, price_minor, currency, broadcast_template, created_by_staff_id, activated_at, created_at)
            VALUES (gen_random_uuid(), $1::uuid, 1, $2::"CatalogVersionStatus", CASE WHEN $3::boolean THEN $1::uuid ELSE NULL END, $4, $5, $6, $7, $8::uuid, CASE WHEN $3::boolean THEN $9::timestamptz ELSE NULL END, $9::timestamptz)`,
            [data.id, input.enabled ? 'ACTIVE' : 'DRAFT', input.enabled, input.name, input.amountMinor, input.currency, input.broadcastTemplate, input.actorStaffId, input.now]);
          await insertPostgresAuditRecord(client, auditRecord);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }
    };
  }

  async updateGiftCatalog(input: { giftCatalogId: string; expectedVersion: number; action: string; reasonCode: string; replacement: GiftCatalogCreateBody | null; actorStaffId: string; now: Date }) {
    if (!['ENABLE', 'DISABLE', 'CREATE_REPLACEMENT_VERSION'].includes(input.action)) {
      throw new AdminDirectoryError('VALIDATION_ERROR', 'Gift catalog action is invalid.');
    }
    if (input.action === 'CREATE_REPLACEMENT_VERSION' && !input.replacement) {
      throw new AdminDirectoryError('VALIDATION_ERROR', 'A replacement version is required.');
    }
    const selected = await this.pool.query<GiftCatalogRow>(giftCatalogCurrentSelect, [input.giftCatalogId]);
    if (!selected.rows[0]) throw new AdminDirectoryError('NOT_FOUND', 'Gift catalog item was not found.');
    const current = mapGiftCatalog(selected.rows[0]);
    if (current.version !== input.expectedVersion) throw new AdminDirectoryError('CONFLICT', 'Gift catalog version is stale.');
    const data = buildUpdatedGift(current, input);
    return {
      data,
      commit: async (auditRecord: AuditRecord, _auditSink: AuditSink) => {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          const locked = await client.query<GiftCatalogRow>(`${giftCatalogCurrentSelect} FOR UPDATE OF item`, [input.giftCatalogId]);
          if (!locked.rows[0]) throw new AdminDirectoryError('NOT_FOUND', 'Gift catalog item was not found.');
          if (mapGiftCatalog(locked.rows[0]).version !== input.expectedVersion) throw new AdminDirectoryError('CONFLICT', 'Gift catalog version is stale.');
          await client.query(`UPDATE gift_catalog_versions SET status = 'RETIRED', active_gift_key = NULL, retired_at = $2
            WHERE gift_catalog_item_id = $1 AND status = 'ACTIVE'`, [input.giftCatalogId, input.now]);
          await client.query(`INSERT INTO gift_catalog_versions (id, gift_catalog_item_id, version, status, active_gift_key, name, price_minor, currency, broadcast_template, created_by_staff_id, activated_at, created_at)
            VALUES (gen_random_uuid(), $1::uuid, $2, $3::"CatalogVersionStatus", CASE WHEN $4::boolean THEN $1::uuid ELSE NULL END, $5, $6, $7, $8, $9::uuid, CASE WHEN $4::boolean THEN $10::timestamptz ELSE NULL END, $10::timestamptz)`,
            [input.giftCatalogId, data.version, data.enabled ? 'ACTIVE' : 'DRAFT', data.enabled, data.name, data.priceMinor, data.currency, data.broadcastTemplate, input.actorStaffId, input.now]);
          await insertPostgresAuditRecord(client, auditRecord);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }
    };
  }

  async listGiftRequests(input: PageInput & { status?: string; actorStaffId: string; actorLevel: string }) {
    const keys = cursorKeys(input.cursor, 'gift_requests');
    const rows = await this.pool.query<GiftRequestRow>(giftRequestSelect + ` WHERE ($1::text IS NULL OR gr.status::text = $1)
      AND ($2::timestamptz IS NULL OR (gr.created_at, gr.id) < ($2::timestamptz, $3::uuid))
      AND ($5::text <> 'L1_SUPPORT' OR EXISTS (
        SELECT 1 FROM staff_tasks task WHERE task.gift_request_id = gr.id AND task.claimed_by_staff_id = $6::uuid
        AND task.status IN ('CLAIMED', 'VERIFIED', 'PENDING_APPROVAL')
      )) ORDER BY gr.created_at DESC, gr.id DESC LIMIT $4`, [input.status ?? null, keys?.[0] ?? null, keys?.[1] ?? null, input.limit + 1, input.actorLevel, input.actorStaffId]);
    return pageFromRows(rows.rows.map(mapGiftRequest), input, 'gift_requests', giftRequestCursorKeys);
  }
  async getGiftRequest(input: { giftRequestId: string; actorStaffId: string; actorLevel: string }) { const rows = await this.pool.query<GiftRequestRow>(giftRequestSelect + ` WHERE gr.id = $1
    AND ($2::text <> 'L1_SUPPORT' OR EXISTS (SELECT 1 FROM staff_tasks task WHERE task.gift_request_id = gr.id AND task.claimed_by_staff_id = $3::uuid
      AND task.status IN ('CLAIMED', 'VERIFIED', 'PENDING_APPROVAL')))`, [input.giftRequestId, input.actorLevel, input.actorStaffId]); return rows.rows[0] ? mapGiftRequest(rows.rows[0]) : null; }
}

export function registerAdminDirectoryRoutes(server: FastifyInstance, options: { store: AdminDirectoryStore; timelineStore?: TransactionTimelineStore; customerScope?: CustomerProfileScope; now?: () => Date }) {
  if (!server.securityOptions) throw new Error('Admin directory routes require security options.');
  const security = server.securityOptions; const now = options.now ?? (() => new Date());
  const auditSink = security.auditSink ?? new InMemoryAuditSink();
  const read = (url: string, permission: string, action: string, targetType: string, handler: (request: FastifyRequest, actor: ActorContext) => unknown, requiredFeature?: PilotFeature) => registerSecureReadRoute(server, security, {
    method: 'GET', url, permission, action, targetType, requiredFeature, acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    handler: (request, actor) => {
      if (!actor.actorStaffId || !actor.actorLevel) throw new AdminDirectoryError('PERMISSION_DENIED', 'An active staff account is required.');
      return handler(request, actor);
    }, mapError
  });
  read('/api/v1/admin/orders', 'order.read', 'LIST_ADMIN_ORDERS', 'order', (request, actor) => options.store.listOrders({ ...pageQuery(request), status: enumQuery(request, 'status', ['DRAFT', 'PENDING_DISPATCH', 'ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION', 'COMPLETED', 'CANCELLED', 'EXCEPTION']), query: queryString(request, 'query'), actorStaffId: actor.actorStaffId!, actorLevel: actor.actorLevel! }));
  if (options.timelineStore) read('/api/v1/admin/orders/:orderId', 'staff_task.read', 'GET_ADMIN_ORDER', 'order', async (request, actor) => {
    try { return required(await options.timelineStore!.getAdminOrder({ orderId: param(request, 'orderId'), actorStaffId: actor.actorStaffId!, actorLevel: actor.actorLevel!, cursor: timelineCursor(request), limit: timelineLimit(request) }), 'Order'); }
    catch (error) { if (error instanceof TransactionTimelineError) throw new AdminDirectoryError('VALIDATION_ERROR', error.message); throw error; }
  });
  read('/api/v1/admin/users', 'user.read', 'LIST_ADMIN_USERS', 'user', (request) => options.store.listUsers({ ...pageQuery(request), query: queryString(request, 'query') }));
  read('/api/v1/admin/users/:userId', 'user.read', 'GET_ADMIN_USER', 'user', async (request) => required(await options.store.getUser(param(request, 'userId')), 'User'));
  read('/api/v1/admin/users/:userId/consumptions', 'customer_profile.read', 'LIST_ADMIN_USER_CONSUMPTIONS', 'consumption_entry', async (request, actor) => {
    const userId = param(request, 'userId');
    if (!actor.guildId || !options.customerScope || !await options.customerScope.canReadCustomer({ userId, actorStaffId: actor.actorStaffId!, actorLevel: actor.actorLevel!, guildId: actor.guildId })) {
      throw new AdminDirectoryError('NOT_FOUND', 'Customer was not found.');
    }
    return { userId, ...await options.store.listUserConsumptions({ ...pageQuery(request), userId, guildId: actor.guildId, type: consumptionType(request) }) };
  });
  read('/api/v1/admin/players', 'player.read', 'LIST_ADMIN_PLAYERS', 'player_profile', (request) => options.store.listPlayers({ ...pageQuery(request), reviewStatus: enumQuery(request, 'reviewStatus', ['PENDING_REVIEW', 'ACTIVE', 'PAUSED', 'SUSPENDED']) }));
  read('/api/v1/admin/players/:playerId', 'player.read', 'GET_ADMIN_PLAYER', 'player_profile', async (request) => required(await options.store.getPlayer(param(request, 'playerId')), 'Player'));
  read('/api/v1/admin/gift-catalog', 'gift_catalog.read', 'LIST_ADMIN_GIFT_CATALOG', 'gift_catalog', (request) => options.store.listGiftCatalog(pageQuery(request)), 'GIFTS');
  read('/api/v1/admin/gift-requests', 'gift_request.read', 'LIST_ADMIN_GIFT_REQUESTS', 'gift_request', (request, actor) => options.store.listGiftRequests({ ...pageQuery(request), status: enumQuery(request, 'status', ['PENDING_REVIEW', 'PENDING_APPROVAL', 'APPROVED', 'CAPTURED', 'ANNOUNCED', 'REJECTED', 'EXPIRED', 'WITHDRAWN', 'FAILED', 'REVERSED']), actorStaffId: actor.actorStaffId!, actorLevel: actor.actorLevel! }), 'GIFTS');
  read('/api/v1/admin/gift-requests/:giftRequestId', 'gift_request.read', 'GET_ADMIN_GIFT_REQUEST', 'gift_request', async (request, actor) => required(await options.store.getGiftRequest({ giftRequestId: param(request, 'giftRequestId'), actorStaffId: actor.actorStaffId!, actorLevel: actor.actorLevel! }), 'Gift request'), 'GIFTS');

  registerSecureWriteRoute(server, security, { method: 'PUT', url: '/api/v1/admin/users/:userId/operational-status', permission: 'user.status.manage', action: 'SET_USER_OPERATIONAL_STATUS', targetType: 'user',
    targetId: (request) => param(request, 'userId'), acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], requiresRecentStepUp: true,
    handler: async (request, actor) => { if (!actor.actorStaffId) throw new AdminDirectoryError('PERMISSION_DENIED', 'Staff is required.'); return bindAudit(await options.store.setUserStatus({ userId: param(request, 'userId'), actorStaffId: actor.actorStaffId, now: now(), ...parseUserStatus(request.body) }), auditSink); },
    successReason: (request) => parseUserStatus(request.body).reasonCode, mapError });
  registerSecureWriteRoute(server, security, { method: 'POST', url: '/api/v1/admin/gift-catalog', permission: 'gift_catalog.manage', requiredFeature: 'GIFTS', action: 'CREATE_GIFT_CATALOG_ITEM', targetType: 'gift_catalog',
    successStatusCode: 201, acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], requiresRecentStepUp: true,
    handler: async (request, actor) => { if (!actor.actorStaffId) throw new AdminDirectoryError('PERMISSION_DENIED', 'Staff is required.'); return bindAudit(await options.store.createGiftCatalog({ ...parseGiftCreate(request.body), actorStaffId: actor.actorStaffId, now: now() }), auditSink); },
    successReason: (request) => parseGiftCreate(request.body).reasonCode, mapError });
  registerSecureWriteRoute(server, security, { method: 'PATCH', url: '/api/v1/admin/gift-catalog/:giftCatalogId', permission: 'gift_catalog.manage', requiredFeature: 'GIFTS', action: 'UPDATE_GIFT_CATALOG_ITEM', targetType: 'gift_catalog',
    targetId: (request) => param(request, 'giftCatalogId'), acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], requiresRecentStepUp: true,
    handler: async (request, actor) => { if (!actor.actorStaffId) throw new AdminDirectoryError('PERMISSION_DENIED', 'Staff is required.'); return bindAudit(await options.store.updateGiftCatalog({ giftCatalogId: param(request, 'giftCatalogId'), actorStaffId: actor.actorStaffId, now: now(), ...parseGiftUpdate(request.body) }), auditSink); },
    successReason: (request) => parseGiftUpdate(request.body).reasonCode, mapError });
}

function bindAudit<T>(write: StagedAdminWrite<T>, auditSink: AuditSink) {
  return { data: write.data, commit: (auditRecord: AuditRecord) => write.commit(auditRecord, auditSink) };
}

function adminConsumptionGuildPredicate(alias: string, guildParameter: string) { return `EXISTS (
  SELECT 1 FROM orders scoped_order WHERE scoped_order.guild_id=${guildParameter} AND (
    scoped_order.id=${alias}.order_id
    OR EXISTS (SELECT 1 FROM gift_requests scoped_gift WHERE scoped_gift.id=${alias}.gift_request_id AND scoped_gift.order_id=scoped_order.id)
    OR EXISTS (SELECT 1 FROM refunds scoped_refund LEFT JOIN gift_requests refund_gift ON refund_gift.id=scoped_refund.gift_request_id
      WHERE scoped_refund.id=${alias}.refund_id AND (scoped_refund.order_id=scoped_order.id OR refund_gift.order_id=scoped_order.id))
    OR EXISTS (SELECT 1 FROM consumption_entries original LEFT JOIN gift_requests original_gift ON original_gift.id=original.gift_request_id
      LEFT JOIN refunds original_refund ON original_refund.id=original.refund_id LEFT JOIN gift_requests original_refund_gift ON original_refund_gift.id=original_refund.gift_request_id
      WHERE original.id=${alias}.reversal_of_entry_id AND (original.order_id=scoped_order.id OR original_gift.order_id=scoped_order.id
        OR original_refund.order_id=scoped_order.id OR original_refund_gift.order_id=scoped_order.id))
  ))`; }

function buildUpdatedGift(
  current: AdminGiftCatalogRecord,
  input: { action: string; replacement: GiftCatalogCreateBody | null; now: Date }
): AdminGiftCatalogRecord {
  if (input.action === 'ENABLE') {
    return { ...current, enabled: true, version: current.version + 1, createdAt: input.now.toISOString() };
  }
  if (input.action === 'DISABLE') {
    return { ...current, enabled: false, version: current.version + 1, createdAt: input.now.toISOString() };
  }
  if (input.action === 'CREATE_REPLACEMENT_VERSION' && input.replacement) {
    return {
      ...current,
      name: input.replacement.name,
      priceMinor: input.replacement.amountMinor,
      currency: input.replacement.currency,
      enabled: input.replacement.enabled,
      broadcastTemplate: input.replacement.broadcastTemplate,
      version: current.version + 1,
      createdAt: input.now.toISOString()
    };
  }
  throw new AdminDirectoryError('VALIDATION_ERROR', 'Gift catalog action is invalid.');
}

function page<T>(items: T[], input: PageInput, resource: CursorResource, keyOf: (item: T) => string[]): Page<T> {
  const keys = cursorKeys(input.cursor, resource);
  const sorted = items.slice().sort((left, right) => compareCursorKeys(keyOf(left), keyOf(right)));
  const remaining = keys ? sorted.filter((item) => compareCursorKeys(keyOf(item), keys) > 0) : sorted;
  return pageFromRows(remaining, input, resource, keyOf);
}
function pageFromRows<T>(items: T[], input: PageInput, resource: CursorResource, keyOf: (item: T) => string[]): Page<T> {
  const selected = items.slice(0, input.limit);
  const last = selected.at(-1);
  return { items: clone(selected), nextCursor: items.length > input.limit && last ? encodeCursor(resource, keyOf(last)) : null };
}
function encodeCursor(resource: CursorResource, keys: string[]): string {
  const payload = Buffer.from(JSON.stringify({ version: 1, resource, keys } satisfies CursorPayload)).toString('base64url');
  const signature = createHmac('sha256', cursorSigningKey).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function cursorKeys(value: string | null, resource: CursorResource): string[] | null {
  if (!value) return null;
  try {
    const parts = value.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('invalid cursor');
    const expectedSignature = createHmac('sha256', cursorSigningKey).update(parts[0]).digest('base64url');
    const actualBytes = Buffer.from(parts[1]);
    const expectedBytes = Buffer.from(expectedSignature);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) throw new Error('invalid cursor');
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (payload.version !== 1 || payload.resource !== resource || !Array.isArray(payload.keys)) throw new Error('invalid cursor');
    validateCursorKeys(resource, payload.keys);
    return payload.keys;
  } catch {
    throw new AdminDirectoryError('VALIDATION_ERROR', 'cursor is invalid.');
  }
}
function validateCursorKeys(resource: CursorResource, keys: unknown[]): asserts keys is string[] {
  const expectedLength = resource === 'users' || resource === 'players' ? 1 : 2;
  if (keys.length !== expectedLength || keys.some((key) => typeof key !== 'string' || key.length < 1 || key.length > 100)) throw new Error('invalid cursor');
  const idIndex = expectedLength - 1;
  if (!isDatabaseUuid(keys[idIndex] as string)) throw new Error('invalid cursor');
  if (expectedLength === 2 && new Date(keys[0] as string).toISOString() !== keys[0]) throw new Error('invalid cursor');
}
function compareCursorKeys(left: string[], right: string[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (right[index] ?? '').localeCompare(left[index] ?? '');
    if (difference !== 0) return difference;
  }
  return 0;
}
function pageQuery(request: FastifyRequest): PageInput {
  const query = request.query as { cursor?: unknown; limit?: unknown };
  const limit = Number(query.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AdminDirectoryError('VALIDATION_ERROR', 'limit is invalid.');
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length < 1 || query.cursor.length > 500)) throw new AdminDirectoryError('VALIDATION_ERROR', 'cursor is invalid.');
  return { cursor: query.cursor as string | undefined ?? null, limit };
}
function queryString(request: FastifyRequest, key: string): string | undefined { const value = (request.query as Record<string, unknown>)[key]; if (value === undefined) return undefined; if (typeof value !== 'string' || value.length > 100) throw new AdminDirectoryError('VALIDATION_ERROR', `${key} is invalid.`); return value.trim() || undefined; }
function enumQuery(request: FastifyRequest, key: string, allowed: string[]): string | undefined { const value = queryString(request, key); if (value && !allowed.includes(value)) throw new AdminDirectoryError('VALIDATION_ERROR', `${key} is invalid.`); return value; }
function consumptionType(request: FastifyRequest): AdminConsumptionMirrorType | undefined { const value = queryString(request, 'type'); if (value === undefined) return undefined; if (!isAdminConsumptionMirrorType(value)) throw new AdminDirectoryError('VALIDATION_ERROR', 'type is invalid.'); return value; }
function timelineLimit(request: FastifyRequest) { const value=Number((request.query as Record<string,unknown>).timelineLimit??25);if(!Number.isInteger(value)||value<1||value>100)throw new AdminDirectoryError('VALIDATION_ERROR','timelineLimit is invalid.');return value; }
function timelineCursor(request: FastifyRequest) { const value=(request.query as Record<string,unknown>).timelineCursor;if(value===undefined)return null;if(typeof value!=='string'||value.length<1||value.length>500)throw new AdminDirectoryError('VALIDATION_ERROR','timelineCursor is invalid.');return value; }
function param(request: FastifyRequest, key: string): string { return String((request.params as Record<string, unknown>)[key] ?? ''); }
function required<T>(value: T | null, label: string): T { if (!value) throw new AdminDirectoryError('NOT_FOUND', `${label} was not found.`); return value; }
function parseUserStatus(body: unknown) { const input = object(body); const expectedVersion = integer(input.expectedVersion, 'expectedVersion'); const status = text(input.status, 'status'); if (!['ACTIVE', 'PAUSED', 'SUSPENDED'].includes(status)) throw new AdminDirectoryError('VALIDATION_ERROR', 'status is invalid.'); return { expectedVersion, status, reasonCode: reason(input.reasonCode), note: nullableText(input.note, 1000) }; }
function parseGiftCreate(body: unknown): GiftCatalogCreateBody { const input = object(body); const price = object(input.price); return { name: text(input.name, 'name', 100), amountMinor: integer(price.amountMinor, 'amountMinor'), currency: currency(price.currency), enabled: boolean(input.enabled, 'enabled'), broadcastTemplate: text(input.broadcastTemplate, 'broadcastTemplate', 500), reasonCode: reason(input.reasonCode) }; }
function parseGiftUpdate(body: unknown) { const input = object(body); const action = text(input.action, 'action'); return { expectedVersion: integer(input.expectedVersion, 'expectedVersion'), action, reasonCode: reason(input.reasonCode), replacement: input.replacement == null ? null : parseGiftCreate(input.replacement) }; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdminDirectoryError('VALIDATION_ERROR', 'Object payload is required.'); return value as Record<string, unknown>; }
function text(value: unknown, field: string, max = 100) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AdminDirectoryError('VALIDATION_ERROR', `${field} is invalid.`); return value.trim(); }
function nullableText(value: unknown, max: number) { if (value == null) return null; if (typeof value !== 'string' || value.length > max) throw new AdminDirectoryError('VALIDATION_ERROR', 'note is invalid.'); return value; }
function integer(value: unknown, field: string) { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new AdminDirectoryError('VALIDATION_ERROR', `${field} is invalid.`); return Number(value); }
function boolean(value: unknown, field: string) { if (typeof value !== 'boolean') throw new AdminDirectoryError('VALIDATION_ERROR', `${field} is invalid.`); return value; }
function reason(value: unknown) { const result = text(value, 'reasonCode'); if (!/^[A-Z0-9_]{3,100}$/.test(result)) throw new AdminDirectoryError('VALIDATION_ERROR', 'reasonCode is invalid.'); return result; }
function currency(value: unknown) { const result = text(value, 'currency', 3); if (!/^[A-Z]{3}$/.test(result)) throw new AdminDirectoryError('VALIDATION_ERROR', 'currency is invalid.'); return result; }
function mapError(error: unknown) { if (!(error instanceof AdminDirectoryError)) return null; return { statusCode: error.code === 'NOT_FOUND' ? 404 : error.code === 'PERMISSION_DENIED' ? 403 : error.code === 'CONFLICT' ? 409 : 400, code: error.code, message: error.message }; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function timeKey(value: string) { return new Date(value).toISOString(); }
function orderCursorKeys(item: AdminOrderListItem) { return [timeKey(item.createdAt), item.id]; }
function userCursorKeys(item: AdminUserRecord) { return [item.id]; }
function consumptionCursorKeys(item: AdminConsumptionRecord) { return [timeKey(item.occurredAt), item.id]; }
function playerCursorKeys(item: AdminPlayerRecord) { return [item.playerId]; }
function giftCatalogCursorKeys(item: AdminGiftCatalogRecord) { return [timeKey(item.createdAt), item.id]; }
function giftRequestCursorKeys(item: AdminGiftRequestRecord) { return [timeKey(item.createdAt), item.id]; }
function isDatabaseUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }

const userSelect = `SELECT u.id, u.display_name, u.status::text, u.row_version, active_order.id AS active_order_id,
  COALESCE(array_agg(DISTINCT risk.type::text) FILTER (WHERE risk.id IS NOT NULL), '{}') AS risk_flags FROM users u
  LEFT JOIN LATERAL (
    SELECT discord_user_id FROM discord_accounts
    WHERE user_id = u.id
    ORDER BY created_at ASC LIMIT 1
  ) da ON TRUE
  LEFT JOIN orders active_order ON active_order.active_customer_slot_id = u.id
  LEFT JOIN risk_events risk ON risk.user_id = u.id`;
const playerSelect = `SELECT pp.id AS player_id, pp.review_status::text, pp.availability::text, pp.discord_presence::text, pp.row_version,
  active_order.id AS active_order_id,
  COALESCE(array_agg(DISTINCT tag.code) FILTER (WHERE tag.type = 'GAME'), '{}') AS game_tags,
  COALESCE(array_agg(DISTINCT tag.code) FILTER (WHERE tag.type = 'SERVICE'), '{}') AS service_tags
  FROM player_profiles pp JOIN users u ON u.id = pp.user_id LEFT JOIN player_skills skill ON skill.player_profile_id = pp.id
  LEFT JOIN skill_tags tag ON tag.id = skill.skill_tag_id LEFT JOIN orders active_order ON active_order.active_player_slot_id = pp.user_id`;
const giftCatalogCurrentSelect = `SELECT item.id, item.code, version.name, version.price_minor, version.currency, version.status::text,
  version.version, version.broadcast_template, version.created_at FROM gift_catalog_items item
  JOIN gift_catalog_versions version ON version.gift_catalog_item_id = item.id
  WHERE item.id = $1 ORDER BY version.version DESC LIMIT 1`;
const giftRequestSelect = `SELECT gr.id, gr.public_id, gr.order_id, gr.sender_id, gr.receiver_id, gr.status::text,
  gr.row_version, gr.gift_name_snapshot, gr.price_minor, gr.currency,
  CASE
    WHEN gr.announced_at IS NOT NULL OR announcement_job.status = 'COMPLETED' THEN 'ANNOUNCED'
    WHEN announcement_job.status = 'FAILED' THEN 'FAILED'
    WHEN announcement_job.status IN ('PENDING', 'PROCESSING') THEN 'PENDING'
    ELSE 'NOT_QUEUED'
  END AS announcement_status,
  gr.created_at
  FROM gift_requests gr
  LEFT JOIN LATERAL (
    SELECT status::text AS status
    FROM outbox_events
    WHERE gift_request_id = gr.id AND event_type = 'GIFT_ANNOUNCEMENT'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  ) announcement_job ON TRUE`;
interface AdminUserRow { id: string; display_name: string; status: string; row_version: number; active_order_id: string | null; risk_flags: string[] }
interface PlayerRow { player_id: string; review_status: string; availability: string; discord_presence: string; row_version: number; active_order_id: string | null; game_tags: string[]; service_tags: string[] }
interface ConsumptionRow { id: string; user_id: string; entry_type: string; source_id: string; amount_minor: string | number; currency: string; direction: string; occurred_at: Date | string; reversal_of_entry_id: string | null }
interface GiftCatalogRow { id: string; code: string; name: string; price_minor: string | number; currency: string; status: string; version: number; broadcast_template: string; created_at: Date | string }
interface GiftRequestRow { id: string; public_id: string; order_id: string; sender_id: string; receiver_id: string; status: string; row_version: number; gift_name_snapshot: string; price_minor: string | number; currency: string; announcement_status: string; created_at: Date | string }
function mapUser(row: AdminUserRow): AdminUserRecord { return { id: row.id, displayName: row.display_name, status: row.status, externalAccountDisplay: null, activeOrderId: row.active_order_id, riskFlags: row.risk_flags, version: row.row_version }; }
function mapPlayer(row: PlayerRow): AdminPlayerRecord { return { playerId: row.player_id, reviewStatus: row.review_status, availability: row.availability, discordPresence: row.discord_presence, gameTags: row.game_tags, serviceTags: row.service_tags, activeOrderId: row.active_order_id, version: row.row_version }; }
function mapGiftCatalog(row: GiftCatalogRow): AdminGiftCatalogRecord { return { id: row.id, code: row.code, name: row.name, priceMinor: safeMinorInteger(row.price_minor), currency: row.currency, enabled: row.status === 'ACTIVE', version: row.version, broadcastTemplate: row.broadcast_template, createdAt: new Date(row.created_at).toISOString() }; }
function mapGiftRequest(row: GiftRequestRow): AdminGiftRequestRecord { return { id: row.id, publicId: row.public_id, orderId: row.order_id, senderId: row.sender_id, receiverId: row.receiver_id, status: row.status, rowVersion: row.row_version, giftName: row.gift_name_snapshot, amountMinor: safeMinorInteger(row.price_minor), currency: row.currency, announcementStatus: row.announcement_status, createdAt: new Date(row.created_at).toISOString() }; }
function safeMinorInteger(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AdminDirectoryError('VALIDATION_ERROR', 'Stored amount is outside the supported minor-unit range.');
  return parsed;
}

const consumptionEntryTypeByMirrorType: Record<AdminConsumptionMirrorType, string> = {
  ORDER: 'ORDER_CHARGE',
  GIFT: 'GIFT_CHARGE',
  REFUND_REVERSAL: 'REFUND_REVERSAL',
  ADMIN_CORRECTION: 'ADMIN_CORRECTION'
};

function mapConsumptionEntryType(entryType: string): AdminConsumptionMirrorType {
  if (entryType === 'ORDER_CHARGE') return 'ORDER';
  if (entryType === 'GIFT_CHARGE') return 'GIFT';
  if (entryType === 'REFUND_REVERSAL') return 'REFUND_REVERSAL';
  if (entryType === 'ADMIN_CORRECTION') return 'ADMIN_CORRECTION';
  throw new AdminDirectoryError('VALIDATION_ERROR', 'Stored consumption entry type is unsupported.');
}

function isAdminConsumptionMirrorType(value: string): value is AdminConsumptionMirrorType {
  return Object.hasOwn(consumptionEntryTypeByMirrorType, value);
}
