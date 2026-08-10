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
  ,type StaffLevel
} from './security.js';
import { PostgresOrderStore, type OrderRecord } from './orders.js';
import { TransactionTimelineError, type TransactionTimelineStore } from './transaction-timeline.js';
import type { CustomerProfileScope } from './customer-profiles.js';
import type { PilotFeature } from './pilot-features.js';
import type { BusinessTagStore } from './business-tags.js';
import { PostgresOrderParticipantStore,type OrderParticipantRecord } from './order-participants.js';
import { decodeAdminCollectionCursor, paginateAdminCollection, parseAdminCollectionSort, type AdminCollectionResource, type CursorBinding, type SortDirection } from './admin-collection-sort.js';

export type AdminOrderListItem = OrderRecord & { participants?: OrderParticipantRecord[]; customerDisplayName?: string | null; customerDiscordTag?: string | null; playerDisplayNames?: string; serviceSummary?: string };
export type AdminConsumptionMirrorType = 'ORDER' | 'GIFT' | 'REFUND_REVERSAL' | 'ADMIN_CORRECTION';
export interface AdminTagSummary { code: string; displayName: string }
export interface AdminUserRecord { id: string; displayName: string; status: string; discordUserId?: string | null; discordUsername?: string | null; externalAccountDisplay: string | null; activeOrderId: string | null; riskFlags: string[]; version: number; createdAt?: string; updatedAt?: string }
export interface AdminPlayerRecord { playerId: string; userId?: string; displayName?: string; discordUserId?: string | null; discordUsername?: string | null; reviewStatus: string; availability: string; discordPresence: string; gameTags: string[]; serviceTags: string[]; languageTags?: string[]; gameTagDetails?: AdminTagSummary[]; serviceTagDetails?: AdminTagSummary[]; languageTagDetails?: AdminTagSummary[]; activeOrderId: string | null; version: number; createdAt?: string; updatedAt?: string }
export interface AdminConsumptionRecord { id: string; userId: string; type: AdminConsumptionMirrorType; sourceId: string; amountMinor: number; currency: string; status: string; occurredAt: string; reversalOf: string | null; guildId?: string }
export interface AdminGiftCatalogRecord { id: string; giftCatalogVersionId?: string; code: string; name: string; priceMinor: number; currency: string; status?: string; enabled: boolean; archived?: boolean; version: number; broadcastTemplate: string; giftCategoryTagId?: string | null; giftCategoryTagDetails?: AdminTagSummary | null; createdByStaffId?: string; createdAt: string; activatedAt?: string | null; retiredAt?: string | null; archivedAt?: string | null }
export interface AdminGiftRequestRecord { id: string; publicId: string; guildId?: string; origin?: 'ORDER'|'STANDALONE'; senderVisibility?: 'PUBLIC'|'ANONYMOUS'; orderId: string|null; orderPublicId?: string|null; orderStatus?: string|null; orderParticipantId?: string | null; giftCatalogVersionId?: string; senderId: string; senderDisplayName?: string; senderDiscordUserId?: string | null; senderDiscordUsername?: string | null; receiverId: string; receiverDisplayName?: string; receiverDiscordUserId?: string | null; receiverDiscordUsername?: string | null; status: string; rowVersion: number; giftCode?: string; giftName: string; amountMinor: number; currency: string; broadcastTemplate?: string; reservationId?: string | null; reservationStatus?: string | null; reservationExpiresAt?: string | null; announcementStatus: string; verifiedByStaffId?: string | null; verifiedAt?: string | null; verificationNote?: string | null; approvedByStaffId?: string | null; approvedAt?: string | null; capturedAt?: string | null; announcedAt?: string | null; broadcastChannelId?: string | null; broadcastMessageId?: string | null; rejectedReason?: string | null; failureCode?: string | null; expiresAt?: string; withdrawnAt?: string | null; createdAt: string; updatedAt?: string }
interface Page<T> { items: T[]; nextCursor: string | null }
interface StagedAdminWrite<T> {
  data: T;
  commit(auditRecord: AuditRecord, auditSink: AuditSink): Promise<void> | void;
}

export interface AdminDirectoryStore {
  listOrders(input: PageInput & { status?: string; query?: string; actorStaffId: string; actorLevel: string; guildId?: string }): Promise<Page<AdminOrderListItem>> | Page<AdminOrderListItem>;
  listUsers(input: PageInput & { query?: string }): Promise<Page<AdminUserRecord>> | Page<AdminUserRecord>;
  getUser(userId: string): Promise<AdminUserRecord | null> | AdminUserRecord | null;
  listUserConsumptions(input: PageInput & { userId: string; guildId?: string; type?: AdminConsumptionMirrorType }): Promise<Page<AdminConsumptionRecord>> | Page<AdminConsumptionRecord>;
  setUserStatus(input: { userId: string; expectedVersion: number; status: string; reasonCode: string; note: string | null; actorStaffId: string; now: Date }): Promise<StagedAdminWrite<AdminUserRecord>> | StagedAdminWrite<AdminUserRecord>;
  listPlayers(input: PageInput & { reviewStatus?: string }): Promise<Page<AdminPlayerRecord>> | Page<AdminPlayerRecord>;
  getPlayer(playerId: string): Promise<AdminPlayerRecord | null> | AdminPlayerRecord | null;
  listGiftCatalog(input: PageInput): Promise<Page<AdminGiftCatalogRecord>> | Page<AdminGiftCatalogRecord>;
  getGiftCatalog(giftCatalogId: string): Promise<AdminGiftCatalogRecord | null> | AdminGiftCatalogRecord | null;
  createGiftCatalog(input: GiftCatalogCreateBody & { actorStaffId: string; now: Date }): Promise<StagedAdminWrite<AdminGiftCatalogRecord>> | StagedAdminWrite<AdminGiftCatalogRecord>;
  updateGiftCatalog(input: { giftCatalogId: string; expectedVersion: number; action: string; reasonCode: string; replacement: GiftCatalogCreateBody | null; actorStaffId: string; now: Date }): Promise<StagedAdminWrite<AdminGiftCatalogRecord>> | StagedAdminWrite<AdminGiftCatalogRecord>;
  listGiftRequests(input: PageInput & { status?: string; actorStaffId: string; actorLevel: string; guildId?: string }): Promise<Page<AdminGiftRequestRecord>> | Page<AdminGiftRequestRecord>;
  getGiftRequest(input: { giftRequestId: string; actorStaffId: string; actorLevel: string; guildId?: string }): Promise<AdminGiftRequestRecord | null> | AdminGiftRequestRecord | null;
}

interface PageInput { cursor: string | null; limit: number; sortBy?: string; sortDirection?: SortDirection; binding?: CursorBinding }
type CursorResource = 'orders' | 'users' | 'user_consumptions' | 'players' | 'gift_catalog' | 'gift_requests';
interface CursorPayload { version: 1; resource: CursorResource; keys: string[] }
interface GiftCatalogCreateBody { name: string; amountMinor: number; currency: string; enabled: boolean; broadcastTemplate: string; giftCategoryTagId?: string | null; reasonCode: string }

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

  listOrders(input: PageInput & { status?: string; query?: string; actorStaffId: string; actorLevel: string; guildId?: string }) {
    const visibleIds = input.actorLevel === 'L1_SUPPORT' ? new Set(this.visibleOrderIdsByStaffId[input.actorStaffId] ?? []) : null;
    const items=this.orders.filter((item) => (!visibleIds || visibleIds.has(item.id)) && matchesOrderStatusFilter(item.status,input.status) && (!input.query || `${item.publicId} ${item.id}`.toLowerCase().includes(input.query.toLowerCase()))).map((item)=>projectOrderListItem(item,this.users.find((user)=>user.id===item.customerId)?.displayName??null));
    return collectionPage(items, input, 'orders', (item) => item.id, (item, sortBy) => sortBy === 'amountMinor' ? item.amountMinor : sortBy === 'updatedAt' ? item.updatedAt : item.createdAt);
  }
  listUsers(input: PageInput & { query?: string }) { return collectionPage(this.users.filter((item) => !input.query || `${item.displayName} ${item.id}`.toLowerCase().includes(input.query.toLowerCase())), input, 'users', (item) => item.id, (item, sortBy) => sortBy === 'displayName' ? item.displayName : sortBy === 'updatedAt' ? item.updatedAt : item.createdAt); }
  getUser(userId: string) { return clone(this.users.find((item) => item.id === userId) ?? null); }
  listUserConsumptions(input: PageInput & { userId: string; guildId?: string; type?: AdminConsumptionMirrorType }) {
    const scoped = this.consumptions.filter((item) => item.userId === input.userId && (!input.guildId || item.guildId === input.guildId) && (!input.type || item.type === input.type));
    return page(scoped.map(({ guildId: _guildId, ...item }) => item), input, 'user_consumptions', consumptionCursorKeys);
  }
  listPlayers(input: PageInput & { reviewStatus?: string }) { return collectionPage(this.players.filter((item) => !input.reviewStatus || item.reviewStatus === input.reviewStatus), input, 'players', (item) => item.playerId, (item, sortBy) => sortBy === 'displayName' ? item.displayName : sortBy === 'updatedAt' ? item.updatedAt : item.createdAt); }
  getPlayer(playerId: string) { return clone(this.players.find((item) => item.playerId === playerId) ?? null); }
  listGiftCatalog(input: PageInput) { return collectionPage(this.gifts.filter((item)=>!item.archived), input, 'gift_catalog', (item) => item.id, (item, sortBy) => sortBy === 'name' ? item.name : sortBy === 'priceMinor' ? item.priceMinor : sortBy === 'version' ? item.version : item.createdAt); }
  getGiftCatalog(giftCatalogId: string) { return clone(this.gifts.find((item) => item.id === giftCatalogId && !item.archived) ?? null); }
  listGiftRequests(input: PageInput & { status?: string; actorStaffId: string; actorLevel: string; guildId?: string }) { const visibleIds = input.actorLevel === 'L1_SUPPORT' ? new Set(this.visibleGiftRequestIdsByStaffId[input.actorStaffId] ?? []) : null; return collectionPage(this.giftRequests.filter((item) => (!input.guildId || !item.guildId || item.guildId === input.guildId) && (!visibleIds || visibleIds.has(item.id)) && (!input.status || item.status === input.status)), input, 'gift_requests', (item) => item.id, (item, sortBy) => sortBy === 'amountMinor' ? item.amountMinor : sortBy === 'expiresAt' ? item.expiresAt : sortBy === 'updatedAt' ? item.updatedAt : item.createdAt); }
  getGiftRequest(input: { giftRequestId: string; actorStaffId: string; actorLevel: string; guildId?: string }) { const visibleIds = input.actorLevel === 'L1_SUPPORT' ? new Set(this.visibleGiftRequestIdsByStaffId[input.actorStaffId] ?? []) : null; return clone(this.giftRequests.find((item) => item.id === input.giftRequestId && (!input.guildId || !item.guildId || item.guildId === input.guildId) && (!visibleIds || visibleIds.has(item.id))) ?? null); }

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

  createGiftCatalog(input: GiftCatalogCreateBody & { actorStaffId: string; now: Date }) {
    const gift: AdminGiftCatalogRecord = { id: crypto.randomUUID(), giftCatalogVersionId: crypto.randomUUID(), code: `GIFT_${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: input.name,
      priceMinor: input.amountMinor, currency: input.currency, status: input.enabled ? 'ACTIVE' : 'DRAFT', enabled: input.enabled, version: 1,
      broadcastTemplate: input.broadcastTemplate, giftCategoryTagId: input.giftCategoryTagId ?? null, giftCategoryTagDetails: null,
      createdByStaffId: input.actorStaffId, createdAt: input.now.toISOString(), activatedAt: input.enabled ? input.now.toISOString() : null, retiredAt: null, archivedAt: null };
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
  private readonly participants: PostgresOrderParticipantStore;

  constructor(private readonly pool: Pool) { this.orders = new PostgresOrderStore({ pool }); this.participants=new PostgresOrderParticipantStore(pool); }

  async listOrders(input: PageInput & { status?: string; query?: string; actorStaffId: string; actorLevel: string; guildId?: string }) {
    const cursor=adminCollectionCursor(input,'orders');const sort=adminSqlSort('orders',input.sortBy??'createdAt',input.sortDirection??'desc');
    const rows = await this.pool.query<{ id: string }>(`SELECT id FROM orders
      WHERE ($5::text IS NULL OR guild_id=$5) AND ($1::text IS NULL OR status::text = $1 OR ($1::text='IN_PROGRESS' AND status IN ('PENDING_DISPATCH','ACCEPTED','IN_SERVICE','PENDING_CONFIRMATION'))) AND ($2::text IS NULL OR public_id ILIKE '%' || $2 || '%' OR id::text = $2)
      AND ${sqlKeyset(sort,cursor,6,7,'id')}
      AND ($3::text <> 'L1_SUPPORT' OR EXISTS (
        SELECT 1 FROM staff_tasks task WHERE task.order_id = orders.id AND task.claimed_by_staff_id = $4::uuid
        AND task.status IN ('CLAIMED', 'VERIFIED', 'PENDING_APPROVAL')
      ))
      ORDER BY (${sort.expression} IS NULL) ASC,${sort.expression} ${sort.direction},id ${sort.direction} LIMIT $8`, [input.status ?? null,input.query ?? null,input.actorLevel,input.actorStaffId,input.guildId??null,cursor?.sortValue??null,cursor?.id??null,input.limit+1]);
    const records = await Promise.all(rows.rows.map((row) => this.orders.findById(row.id)));
    const visible=records.filter((record): record is OrderRecord => record !== null);
    const customerRows=visible.length?await this.pool.query<{order_id:string;display_name:string|null;discord_tag:string|null}>(`SELECT o.id AS order_id,u.display_name,COALESCE(da.username,da.discord_user_id) AS discord_tag FROM orders o LEFT JOIN users u ON u.id=o.customer_id LEFT JOIN LATERAL (SELECT username,discord_user_id FROM discord_accounts WHERE user_id=u.id ORDER BY created_at ASC LIMIT 1) da ON true WHERE o.id=ANY($1::uuid[])`,[visible.map((record)=>record.id)]):{rows:[]};
    const customers=new Map(customerRows.rows.map((row)=>[row.order_id,row]));
    const withParticipants=await Promise.all(visible.map(async(record)=>{const participants=await this.listOrderParticipants(record,input);const customer=customers.get(record.id);return projectOrderListItem({...record,participants,customerDiscordTag:customer?.discord_tag??null},customer?.display_name??null);}));
    return collectionPage(withParticipants,{...input,cursor:null},'orders',item=>item.id,(item,sortBy)=>sortBy==='amountMinor'?item.amountMinor:sortBy==='updatedAt'?item.updatedAt:item.createdAt);
  }

  private async listOrderParticipants(record:OrderRecord,input:{actorStaffId:string;actorLevel:string}){if(!record.guildId)return[];try{return(await this.participants.list({orderId:record.id,actorStaffId:input.actorStaffId,actorLevel:input.actorLevel as StaffLevel,guildId:record.guildId,cursor:null,limit:100})).items;}catch(error){if((error as {code?:string})?.code==='42P01')return[];throw error;}}

  async listUsers(input: PageInput & { query?: string }) {
    const cursor=adminCollectionCursor(input,'users');const sort=adminSqlSort('users',input.sortBy??'createdAt',input.sortDirection??'desc');
    const rows = await this.pool.query<AdminUserRow>(userSelect + ` WHERE ($1::text IS NULL OR u.display_name ILIKE '%' || $1 || '%' OR u.id::text = $1 OR da.discord_user_id = $1)
      AND ${sqlKeyset(sort,cursor,2,3,'u.id')}
      GROUP BY u.id, da.discord_user_id, da.username, active_order.id ORDER BY (${sort.expression} IS NULL) ASC,${sort.expression} ${sort.direction},u.id ${sort.direction} LIMIT $4`, [input.query??null,cursor?.sortValue??null,cursor?.id??null,input.limit+1]);
    return collectionPage(rows.rows.map(mapUser),{...input,cursor:null},'users',item=>item.id,(item,sortBy)=>sortBy==='displayName'?item.displayName:sortBy==='updatedAt'?item.updatedAt:item.createdAt);
  }

  async getUser(userId: string) {
    const rows = await this.pool.query<AdminUserRow>(userSelect + ` WHERE u.id = $1 GROUP BY u.id, da.discord_user_id, da.username, active_order.id LIMIT 1`, [userId]);
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
    const cursor=adminCollectionCursor(input,'players');const sort=adminSqlSort('players',input.sortBy??'createdAt',input.sortDirection??'desc');
    const rows = await this.pool.query<PlayerRow>(playerSelect + ` WHERE ($1::text IS NULL OR pp.review_status::text = $1)
      AND ${sqlKeyset(sort,cursor,2,3,'pp.id')}
      GROUP BY pp.id, u.id, da.discord_user_id, da.username, active_order.id ORDER BY (${sort.expression} IS NULL) ASC,${sort.expression} ${sort.direction},pp.id ${sort.direction} LIMIT $4`, [input.reviewStatus??null,cursor?.sortValue??null,cursor?.id??null,input.limit+1]);
    return collectionPage(rows.rows.map(mapPlayer),{...input,cursor:null},'players',item=>item.playerId,(item,sortBy)=>sortBy==='displayName'?item.displayName:sortBy==='updatedAt'?item.updatedAt:item.createdAt);
  }
  async getPlayer(playerId: string) { const rows = await this.pool.query<PlayerRow>(playerSelect + ` WHERE pp.id = $1 GROUP BY pp.id, u.id, da.discord_user_id, da.username, active_order.id LIMIT 1`, [playerId]); return rows.rows[0] ? mapPlayer(rows.rows[0]) : null; }

  async listGiftCatalog(input: PageInput) {
    const cursor=adminCollectionCursor(input,'gift_catalog');const sort=adminSqlSort('gift_catalog',input.sortBy??'createdAt',input.sortDirection??'desc');
    const rows = await this.pool.query<GiftCatalogRow>(`SELECT item.id, item.code, item.archived_at, version.id AS gift_catalog_version_id, version.name, version.price_minor, version.currency, version.status::text,
      version.version, version.broadcast_template, version.gift_category_tag_id, category.code AS gift_category_code, category.display_name AS gift_category_display_name,
      version.created_by_staff_id, version.activated_at, version.retired_at, version.created_at FROM gift_catalog_items item
      JOIN LATERAL (
        SELECT name, price_minor, currency, status, version, broadcast_template, gift_category_tag_id, created_by_staff_id, activated_at, retired_at, created_at, id
        FROM gift_catalog_versions WHERE gift_catalog_item_id = item.id ORDER BY version DESC LIMIT 1
      ) version ON TRUE
      LEFT JOIN skill_tags category ON category.id = version.gift_category_tag_id
      WHERE item.archived_at IS NULL AND ${sqlKeyset(sort,cursor,1,2,'item.id')}
      ORDER BY (${sort.expression} IS NULL) ASC,${sort.expression} ${sort.direction},item.id ${sort.direction} LIMIT $3`, [cursor?.sortValue??null,cursor?.id??null,input.limit+1]);
    return collectionPage(rows.rows.map(mapGiftCatalog),{...input,cursor:null},'gift_catalog',item=>item.id,(item,sortBy)=>sortBy==='name'?item.name:sortBy==='priceMinor'?item.priceMinor:sortBy==='version'?item.version:item.createdAt);
  }
  async getGiftCatalog(giftCatalogId: string) { const rows = await this.pool.query<GiftCatalogRow>(giftCatalogCurrentSelect, [giftCatalogId]); return rows.rows[0] ? mapGiftCatalog(rows.rows[0]) : null; }

  async createGiftCatalog(input: GiftCatalogCreateBody & { actorStaffId: string; now: Date }) {
    const data: AdminGiftCatalogRecord = {
      id: crypto.randomUUID(), giftCatalogVersionId: crypto.randomUUID(), code: `GIFT_${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: input.name,
      priceMinor: input.amountMinor, currency: input.currency, status: input.enabled ? 'ACTIVE' : 'DRAFT', enabled: input.enabled, version: 1,
      broadcastTemplate: input.broadcastTemplate, giftCategoryTagId: input.giftCategoryTagId ?? null, giftCategoryTagDetails: null,
      createdByStaffId: input.actorStaffId, createdAt: input.now.toISOString(), activatedAt: input.enabled ? input.now.toISOString() : null, retiredAt: null, archivedAt: null
    };
    return {
      data,
      commit: async (auditRecord: AuditRecord, _auditSink: AuditSink) => {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`INSERT INTO gift_catalog_items (id, code, created_at, updated_at) VALUES ($1::uuid, $2, $3, $3)`, [data.id, data.code, input.now]);
          await client.query(`INSERT INTO gift_catalog_versions (id, gift_catalog_item_id, version, status, active_gift_key, name, price_minor, currency, broadcast_template, gift_category_tag_id, created_by_staff_id, activated_at, created_at)
            VALUES ($11::uuid, $1::uuid, 1, $2::"CatalogVersionStatus", CASE WHEN $3::boolean THEN $1::uuid ELSE NULL END, $4, $5, $6, $7, $8::uuid, $9::uuid, CASE WHEN $3::boolean THEN $10::timestamptz ELSE NULL END, $10::timestamptz)`,
            [data.id, input.enabled ? 'ACTIVE' : 'DRAFT', input.enabled, input.name, input.amountMinor, input.currency, input.broadcastTemplate, input.giftCategoryTagId, input.actorStaffId, input.now, data.giftCatalogVersionId]);
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
    if (!['ENABLE', 'DISABLE', 'CREATE_REPLACEMENT_VERSION', 'ARCHIVE'].includes(input.action)) {
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
          if(input.action==='ARCHIVE'){
            await client.query(`UPDATE gift_catalog_items SET archived_at=$2,updated_at=$2 WHERE id=$1 AND archived_at IS NULL`,[input.giftCatalogId,input.now]);
            await client.query(`UPDATE gift_catalog_versions SET status='RETIRED',active_gift_key=NULL,retired_at=COALESCE(retired_at,$2) WHERE gift_catalog_item_id=$1 AND status='ACTIVE'`,[input.giftCatalogId,input.now]);
            await insertPostgresAuditRecord(client,auditRecord);await client.query('COMMIT');return;
          }
          await client.query(`UPDATE gift_catalog_versions SET status = 'RETIRED', active_gift_key = NULL, retired_at = $2
            WHERE gift_catalog_item_id = $1 AND status = 'ACTIVE'`, [input.giftCatalogId, input.now]);
          await client.query(`INSERT INTO gift_catalog_versions (id, gift_catalog_item_id, version, status, active_gift_key, name, price_minor, currency, broadcast_template, gift_category_tag_id, created_by_staff_id, activated_at, created_at)
            VALUES ($12::uuid, $1::uuid, $2, $3::"CatalogVersionStatus", CASE WHEN $4::boolean THEN $1::uuid ELSE NULL END, $5, $6, $7, $8, $9::uuid, $10::uuid, CASE WHEN $4::boolean THEN $11::timestamptz ELSE NULL END, $11::timestamptz)`,
            [input.giftCatalogId, data.version, data.enabled ? 'ACTIVE' : 'DRAFT', data.enabled, data.name, data.priceMinor, data.currency, data.broadcastTemplate, data.giftCategoryTagId, input.actorStaffId, input.now, data.giftCatalogVersionId]);
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

  async listGiftRequests(input: PageInput & { status?: string; actorStaffId: string; actorLevel: string; guildId?: string }) {
    const cursor=adminCollectionCursor(input,'gift_requests');const sort=adminSqlSort('gift_requests',input.sortBy??'createdAt',input.sortDirection??'desc');
    const rows = await this.pool.query<GiftRequestRow>(giftRequestSelect + ` WHERE ($1::text IS NULL OR gr.status::text = $1)
      AND gr.guild_id=$4::text AND ${sqlKeyset(sort,cursor,5,6,'gr.id')}
      AND ($2::text <> 'L1_SUPPORT' OR EXISTS (
        SELECT 1 FROM staff_tasks task WHERE task.gift_request_id = gr.id AND task.claimed_by_staff_id = $3::uuid
        AND task.status IN ('CLAIMED', 'VERIFIED', 'PENDING_APPROVAL')
      )) ORDER BY (${sort.expression} IS NULL) ASC,${sort.expression} ${sort.direction},gr.id ${sort.direction} LIMIT $7`, [input.status??null,input.actorLevel,input.actorStaffId,input.guildId,cursor?.sortValue??null,cursor?.id??null,input.limit+1]);
    return collectionPage(rows.rows.map(mapGiftRequest),{...input,cursor:null},'gift_requests',item=>item.id,(item,sortBy)=>sortBy==='amountMinor'?item.amountMinor:sortBy==='expiresAt'?item.expiresAt:sortBy==='updatedAt'?item.updatedAt:item.createdAt);
  }
  async getGiftRequest(input: { giftRequestId: string; actorStaffId: string; actorLevel: string; guildId?: string }) { const rows = await this.pool.query<GiftRequestRow>(giftRequestSelect + ` WHERE gr.id = $1 AND gr.guild_id=$4::text
    AND ($2::text <> 'L1_SUPPORT' OR EXISTS (SELECT 1 FROM staff_tasks task WHERE task.gift_request_id = gr.id AND task.claimed_by_staff_id = $3::uuid
      AND task.status IN ('CLAIMED', 'VERIFIED', 'PENDING_APPROVAL')))`, [input.giftRequestId, input.actorLevel, input.actorStaffId,input.guildId]); return rows.rows[0] ? mapGiftRequest(rows.rows[0]) : null; }
}

export function registerAdminDirectoryRoutes(server: FastifyInstance, options: { store: AdminDirectoryStore; businessTags?: BusinessTagStore; timelineStore?: TransactionTimelineStore; customerScope?: CustomerProfileScope; now?: () => Date }) {
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
  read('/api/v1/admin/orders', 'order.read', 'LIST_ADMIN_ORDERS', 'order', (request, actor) => { const status=enumQuery(request, 'status', ['DRAFT', 'PENDING_DISPATCH', 'ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION', 'COMPLETED', 'CANCELLED', 'EXCEPTION','IN_PROGRESS']);const query=queryString(request,'query');return options.store.listOrders({ ...collectionPageQuery(request,'orders',actor,{status,query}), status, query, actorStaffId: actor.actorStaffId!, actorLevel: actor.actorLevel!, guildId: actor.guildId! }); });
  if (options.timelineStore) read('/api/v1/admin/orders/:orderId', 'staff_task.read', 'GET_ADMIN_ORDER', 'order', async (request, actor) => {
    try { return required(await options.timelineStore!.getAdminOrder({ orderId: param(request, 'orderId'), actorStaffId: actor.actorStaffId!, actorLevel: actor.actorLevel!, cursor: timelineCursor(request), limit: timelineLimit(request) }), 'Order'); }
    catch (error) { if (error instanceof TransactionTimelineError) throw new AdminDirectoryError('VALIDATION_ERROR', error.message); throw error; }
  });
  read('/api/v1/admin/users', 'user.read', 'LIST_ADMIN_USERS', 'user', (request,actor) => {const query=queryString(request,'query');return options.store.listUsers({ ...collectionPageQuery(request,'users',actor,{query}), query });});
  read('/api/v1/admin/users/:userId', 'user.read', 'GET_ADMIN_USER', 'user', async (request) => required(await options.store.getUser(param(request, 'userId')), 'User'));
  read('/api/v1/admin/users/:userId/consumptions', 'customer_profile.read', 'LIST_ADMIN_USER_CONSUMPTIONS', 'consumption_entry', async (request, actor) => {
    const userId = param(request, 'userId');
    if (!actor.guildId || !options.customerScope || !await options.customerScope.canReadCustomer({ userId, actorStaffId: actor.actorStaffId!, actorLevel: actor.actorLevel!, guildId: actor.guildId })) {
      throw new AdminDirectoryError('NOT_FOUND', 'Customer was not found.');
    }
    return { userId, ...await options.store.listUserConsumptions({ ...pageQuery(request), userId, guildId: actor.guildId, type: consumptionType(request) }) };
  });
  read('/api/v1/admin/players', 'player.read', 'LIST_ADMIN_PLAYERS', 'player_profile', (request,actor) => {const reviewStatus=enumQuery(request,'reviewStatus',['PENDING_REVIEW','ACTIVE','PAUSED','SUSPENDED']);return options.store.listPlayers({...collectionPageQuery(request,'players',actor,{reviewStatus}),reviewStatus});});
  read('/api/v1/admin/players/:playerId', 'player.read', 'GET_ADMIN_PLAYER', 'player_profile', async (request) => required(await options.store.getPlayer(param(request, 'playerId')), 'Player'));
  read('/api/v1/admin/gift-catalog', 'gift_catalog.read', 'LIST_ADMIN_GIFT_CATALOG', 'gift_catalog', (request,actor) => options.store.listGiftCatalog(collectionPageQuery(request,'gift_catalog',actor,{})), 'GIFTS');
  read('/api/v1/admin/gift-catalog/:giftCatalogId', 'gift_catalog.read', 'GET_ADMIN_GIFT_CATALOG_ITEM', 'gift_catalog', async (request) => required(await options.store.getGiftCatalog(param(request, 'giftCatalogId')), 'Gift catalog item'), 'GIFTS');
  read('/api/v1/admin/gift-requests', 'gift_request.read', 'LIST_ADMIN_GIFT_REQUESTS', 'gift_request', (request, actor) => {const status=enumQuery(request,'status',['PENDING_REVIEW','PENDING_APPROVAL','APPROVED','CAPTURED','ANNOUNCED','REJECTED','EXPIRED','WITHDRAWN','FAILED','REVERSED']);return options.store.listGiftRequests({ ...collectionPageQuery(request,'gift_requests',actor,{status}), status, actorStaffId: actor.actorStaffId!, actorLevel: actor.actorLevel!,guildId:actor.guildId! });}, 'GIFTS');
  read('/api/v1/admin/gift-requests/:giftRequestId', 'gift_request.read', 'GET_ADMIN_GIFT_REQUEST', 'gift_request', async (request, actor) => required(await options.store.getGiftRequest({ giftRequestId: param(request, 'giftRequestId'), actorStaffId: actor.actorStaffId!, actorLevel: actor.actorLevel!,guildId:actor.guildId! }), 'Gift request'), 'GIFTS');

  registerSecureWriteRoute(server, security, { method: 'PUT', url: '/api/v1/admin/users/:userId/operational-status', permission: 'user.status.manage', action: 'SET_USER_OPERATIONAL_STATUS', targetType: 'user',
    targetId: (request) => param(request, 'userId'), acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], requiresRecentStepUp: true,
    handler: async (request, actor) => { if (!actor.actorStaffId) throw new AdminDirectoryError('PERMISSION_DENIED', 'Staff is required.'); return bindAudit(await options.store.setUserStatus({ userId: param(request, 'userId'), actorStaffId: actor.actorStaffId, now: now(), ...parseUserStatus(request.body) }), auditSink); },
    successReason: (request) => parseUserStatus(request.body).reasonCode, mapError });
  registerSecureWriteRoute(server, security, { method: 'POST', url: '/api/v1/admin/gift-catalog', permission: 'gift_catalog.manage', requiredFeature: 'GIFTS', action: 'CREATE_GIFT_CATALOG_ITEM', targetType: 'gift_catalog',
    successStatusCode: 201, acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    handler: async (request, actor) => { if (!actor.actorStaffId) throw new AdminDirectoryError('PERMISSION_DENIED', 'Staff is required.'); const body=await giftCreateInput(request.body,options.businessTags); return bindAudit(await options.store.createGiftCatalog({ ...body, actorStaffId: actor.actorStaffId, now: now() }), auditSink); },
    successReason: (request) => parseGiftCreate(request.body).reasonCode, mapError });
  registerSecureWriteRoute(server, security, { method: 'PATCH', url: '/api/v1/admin/gift-catalog/:giftCatalogId', permission: 'gift_catalog.manage', requiredFeature: 'GIFTS', action: 'UPDATE_GIFT_CATALOG_ITEM', targetType: 'gift_catalog',
    targetId: (request) => param(request, 'giftCatalogId'), acceptedSources: ['DASHBOARD', 'DISCORD_BOT'],
    handler: async (request, actor) => { if (!actor.actorStaffId) throw new AdminDirectoryError('PERMISSION_DENIED', 'Staff is required.'); return bindAudit(await options.store.updateGiftCatalog({ giftCatalogId: param(request, 'giftCatalogId'), actorStaffId: actor.actorStaffId, now: now(), ...await giftUpdateInput(request.body,options.businessTags) }), auditSink); },
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
  input: { action: string; replacement: GiftCatalogCreateBody | null; actorStaffId: string; now: Date }
): AdminGiftCatalogRecord {
  const nextVersion = {
    giftCatalogVersionId: crypto.randomUUID(),
    createdByStaffId: input.actorStaffId,
    createdAt: input.now.toISOString(),
    activatedAt: null,
    retiredAt: null,
    archivedAt: null
  };
  if (input.action === 'ENABLE') {
    return { ...current, ...nextVersion, status: 'ACTIVE', enabled: true, version: current.version + 1, activatedAt: input.now.toISOString() };
  }
  if (input.action === 'DISABLE') {
    return { ...current, ...nextVersion, status: 'DRAFT', enabled: false, version: current.version + 1 };
  }
  if(input.action==='ARCHIVE')return{...current,status:'RETIRED',enabled:false,archived:true,retiredAt:current.status==='ACTIVE'?input.now.toISOString():current.retiredAt??null,archivedAt:input.now.toISOString()};
  if (input.action === 'CREATE_REPLACEMENT_VERSION' && input.replacement) {
    return {
      ...current,
      ...nextVersion,
      name: input.replacement.name,
      priceMinor: input.replacement.amountMinor,
      currency: input.replacement.currency,
      status: input.replacement.enabled ? 'ACTIVE' : 'DRAFT',
      enabled: input.replacement.enabled,
      broadcastTemplate: input.replacement.broadcastTemplate,
      giftCategoryTagId: input.replacement.giftCategoryTagId ?? null,
      giftCategoryTagDetails: null,
      version: current.version + 1,
      activatedAt: input.replacement.enabled ? input.now.toISOString() : null
    };
  }
  throw new AdminDirectoryError('VALIDATION_ERROR', 'Gift catalog action is invalid.');
}

function adminCollectionCursor(input:PageInput,resource:AdminCollectionResource){try{return decodeAdminCollectionCursor({resource,cursor:input.cursor,sortBy:input.sortBy??'createdAt',sortDirection:input.sortDirection??'desc',binding:input.binding??{actorGuildId:null,actorScope:'legacy',filters:{}}});}catch{throw new AdminDirectoryError('VALIDATION_ERROR','cursor is invalid.');}}
function adminSqlSort(resource:AdminCollectionResource,sortBy:string,direction:SortDirection){
  const maps:Record<AdminCollectionResource,Record<string,{expression:string;cast:string}>>={
    orders:{createdAt:{expression:'created_at',cast:'timestamptz'},updatedAt:{expression:'updated_at',cast:'timestamptz'},amountMinor:{expression:'amount_minor',cast:'bigint'}},
    users:{createdAt:{expression:'u.created_at',cast:'timestamptz'},updatedAt:{expression:'u.updated_at',cast:'timestamptz'},displayName:{expression:'u.display_name COLLATE "C"',cast:'text'}},
    players:{createdAt:{expression:'pp.created_at',cast:'timestamptz'},updatedAt:{expression:'pp.updated_at',cast:'timestamptz'},displayName:{expression:'u.display_name COLLATE "C"',cast:'text'}},
    service_catalog:{},service_packages:{},
    gift_catalog:{createdAt:{expression:'version.created_at',cast:'timestamptz'},name:{expression:'version.name COLLATE "C"',cast:'text'},priceMinor:{expression:'version.price_minor',cast:'bigint'},version:{expression:'version.version',cast:'integer'}},
    gift_requests:{createdAt:{expression:'gr.created_at',cast:'timestamptz'},updatedAt:{expression:'gr.updated_at',cast:'timestamptz'},amountMinor:{expression:'gr.price_minor',cast:'bigint'},expiresAt:{expression:'gr.expires_at',cast:'timestamptz'}}
  };
  const selected=maps[resource][sortBy];if(!selected)throw new AdminDirectoryError('VALIDATION_ERROR','sortBy is invalid.');return{...selected,direction:direction.toUpperCase()};
}
function sqlKeyset(sort:{expression:string;cast:string;direction:string},cursor:{sortValue:string|number|null;id:string}|null,valueParameter:number,idParameter:number,idExpression:string){const value=`$${valueParameter}::${sort.cast}`;const id=`$${idParameter}::uuid`;if(!cursor)return`(${value} IS NULL AND ${id} IS NULL)`;const op=sort.direction==='ASC'?'>':'<';return `((${sort.expression} IS NULL AND ${value} IS NULL AND ${idExpression} ${op} ${id}) OR (${value} IS NOT NULL AND (${sort.expression} IS NULL OR ${sort.expression} ${op} ${value} OR (${sort.expression} = ${value} AND ${idExpression} ${op} ${id}))))`;}

function page<T>(items: T[], input: PageInput, resource: CursorResource, keyOf: (item: T) => string[]): Page<T> {
  const keys = cursorKeys(input.cursor, resource);
  const sorted = items.slice().sort((left, right) => compareCursorKeys(keyOf(left), keyOf(right)));
  const remaining = keys ? sorted.filter((item) => compareCursorKeys(keyOf(item), keys) > 0) : sorted;
  return pageFromRows(remaining, input, resource, keyOf);
}
function collectionPage<T>(items:T[],input:PageInput,resource:AdminCollectionResource,idOf:(item:T)=>string,valueOf:(item:T,sortBy:string)=>string|number|null|undefined):Page<T>{
  const sortBy=input.sortBy??'createdAt';const sortDirection=input.sortDirection??'desc';
  try{return paginateAdminCollection(items,{resource,cursor:input.cursor,limit:input.limit,sortBy,sortDirection,binding:input.binding??{actorGuildId:null,actorScope:'legacy',filters:{}},idOf,valueOf:item=>valueOf(item,sortBy)});}catch(error){if((error as Error).message==='cursor is invalid.')throw new AdminDirectoryError('VALIDATION_ERROR','cursor is invalid.');throw error;}
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
function collectionPageQuery(request:FastifyRequest,resource:AdminCollectionResource,actor:ActorContext,filters:Record<string,string|undefined>):PageInput{
  const base=pageQuery(request);const sort=parseAdminCollectionSort(resource,request.query as Record<string,unknown>,message=>new AdminDirectoryError('VALIDATION_ERROR',message));
  return{...base,...sort,binding:{actorGuildId:actor.guildId??null,actorScope:`${actor.actorLevel}:${actor.actorStaffId}`,filters}};
}
function queryString(request: FastifyRequest, key: string): string | undefined { const value = (request.query as Record<string, unknown>)[key]; if (value === undefined) return undefined; if (typeof value !== 'string' || value.length > 100) throw new AdminDirectoryError('VALIDATION_ERROR', `${key} is invalid.`); return value.trim() || undefined; }
function enumQuery(request: FastifyRequest, key: string, allowed: string[]): string | undefined { const value = queryString(request, key); if (value && !allowed.includes(value)) throw new AdminDirectoryError('VALIDATION_ERROR', `${key} is invalid.`); return value; }
function consumptionType(request: FastifyRequest): AdminConsumptionMirrorType | undefined { const value = queryString(request, 'type'); if (value === undefined) return undefined; if (!isAdminConsumptionMirrorType(value)) throw new AdminDirectoryError('VALIDATION_ERROR', 'type is invalid.'); return value; }
function timelineLimit(request: FastifyRequest) { const value=Number((request.query as Record<string,unknown>).timelineLimit??25);if(!Number.isInteger(value)||value<1||value>100)throw new AdminDirectoryError('VALIDATION_ERROR','timelineLimit is invalid.');return value; }
function timelineCursor(request: FastifyRequest) { const value=(request.query as Record<string,unknown>).timelineCursor;if(value===undefined)return null;if(typeof value!=='string'||value.length<1||value.length>500)throw new AdminDirectoryError('VALIDATION_ERROR','timelineCursor is invalid.');return value; }
function param(request: FastifyRequest, key: string): string { return String((request.params as Record<string, unknown>)[key] ?? ''); }
function required<T>(value: T | null, label: string): T { if (!value) throw new AdminDirectoryError('NOT_FOUND', `${label} was not found.`); return value; }
function parseUserStatus(body: unknown) { const input = object(body); const expectedVersion = integer(input.expectedVersion, 'expectedVersion'); const status = text(input.status, 'status'); if (!['ACTIVE', 'PAUSED', 'SUSPENDED'].includes(status)) throw new AdminDirectoryError('VALIDATION_ERROR', 'status is invalid.'); return { expectedVersion, status, reasonCode: reason(input.reasonCode), note: nullableText(input.note, 1000) }; }
function parseGiftCreate(body: unknown): GiftCatalogCreateBody { const input = object(body); const price = object(input.price); return { name: text(input.name, 'name', 100), amountMinor: integer(price.amountMinor, 'amountMinor'), currency: currency(price.currency), enabled: boolean(input.enabled, 'enabled'), broadcastTemplate: text(input.broadcastTemplate, 'broadcastTemplate', 500), giftCategoryTagId: typeof input.giftCategoryTagId==='string'?input.giftCategoryTagId:null, reasonCode: reason(input.reasonCode) }; }
async function giftCreateInput(body:unknown,tags?:BusinessTagStore){const input=parseGiftCreate(body);if(!tags)return input;if(!input.giftCategoryTagId)throw new AdminDirectoryError('VALIDATION_ERROR','giftCategoryTagId is required.');try{await tags.resolveEnabled([input.giftCategoryTagId],['GIFT_CATEGORY']);}catch{throw new AdminDirectoryError('VALIDATION_ERROR','giftCategoryTagId must reference an enabled gift category.');}return input;}
function parseGiftUpdate(body: unknown) { const input = object(body); const action = text(input.action, 'action'); return { expectedVersion: integer(input.expectedVersion, 'expectedVersion'), action, reasonCode: reason(input.reasonCode), replacement: input.replacement == null ? null : parseGiftCreate(input.replacement) }; }
async function giftUpdateInput(body:unknown,tags?:BusinessTagStore){const input=parseGiftUpdate(body);if(tags&&input.replacement){if(!input.replacement.giftCategoryTagId)throw new AdminDirectoryError('VALIDATION_ERROR','giftCategoryTagId is required.');try{await tags.resolveEnabled([input.replacement.giftCategoryTagId],['GIFT_CATEGORY']);}catch{throw new AdminDirectoryError('VALIDATION_ERROR','giftCategoryTagId must reference an enabled gift category.');}}return input;}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdminDirectoryError('VALIDATION_ERROR', 'Object payload is required.'); return value as Record<string, unknown>; }
function text(value: unknown, field: string, max = 100) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AdminDirectoryError('VALIDATION_ERROR', `${field} is invalid.`); return value.trim(); }
function nullableText(value: unknown, max: number) { if (value == null) return null; if (typeof value !== 'string' || value.length > max) throw new AdminDirectoryError('VALIDATION_ERROR', 'note is invalid.'); return value; }
function integer(value: unknown, field: string) { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new AdminDirectoryError('VALIDATION_ERROR', `${field} is invalid.`); return Number(value); }
function boolean(value: unknown, field: string) { if (typeof value !== 'boolean') throw new AdminDirectoryError('VALIDATION_ERROR', `${field} is invalid.`); return value; }
function reason(value: unknown) { const result = text(value, 'reasonCode'); if (!/^[A-Z0-9_]{3,100}$/.test(result)) throw new AdminDirectoryError('VALIDATION_ERROR', 'reasonCode is invalid.'); return result; }
function currency(value: unknown) { const result = text(value, 'currency', 3); if (!/^[A-Z]{3}$/.test(result)) throw new AdminDirectoryError('VALIDATION_ERROR', 'currency is invalid.'); return result; }
function mapError(error: unknown) { if (!(error instanceof AdminDirectoryError)) return null; return { statusCode: error.code === 'NOT_FOUND' ? 404 : error.code === 'PERMISSION_DENIED' ? 403 : error.code === 'CONFLICT' ? 409 : 400, code: error.code, message: error.message }; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function matchesOrderStatusFilter(status:string,filter?:string):boolean{return !filter||status===filter||(filter==='IN_PROGRESS'&&['PENDING_DISPATCH','ACCEPTED','IN_SERVICE','PENDING_CONFIRMATION'].includes(status));}
function projectOrderListItem(item:AdminOrderListItem,customerDisplayName:string|null):AdminOrderListItem{
  const participants=(item.participants??[]).filter((participant)=>participant.status!=='REMOVED');
  const playerDisplayNames=participants.map((participant)=>participant.displayName).filter(Boolean).join('、');
  const services=Array.from(new Set(participants.map((participant)=>[participant.gameDisplayName,participant.serviceDisplayName].filter(Boolean).join(' · ')).filter(Boolean)));
  const legacyService=[item.gameDisplayName,item.serviceDisplayName].filter(Boolean).join(' · ');
  return {...item,customerDisplayName:item.customerDisplayName??customerDisplayName,playerDisplayNames:item.playerDisplayNames??playerDisplayNames,serviceSummary:item.serviceSummary??(services.join('；')||legacyService)};
}
function timeKey(value: string) { return new Date(value).toISOString(); }
function consumptionCursorKeys(item: AdminConsumptionRecord) { return [timeKey(item.occurredAt), item.id]; }
function isDatabaseUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }

const userSelect = `SELECT u.id, u.display_name, u.status::text, u.row_version, u.created_at, u.updated_at, da.discord_user_id, da.username AS discord_username, active_order.id AS active_order_id,
  COALESCE(array_agg(DISTINCT risk.type::text) FILTER (WHERE risk.id IS NOT NULL), '{}') AS risk_flags FROM users u
  LEFT JOIN LATERAL (
    SELECT discord_user_id, username FROM discord_accounts
    WHERE user_id = u.id
    ORDER BY created_at ASC LIMIT 1
  ) da ON TRUE
  LEFT JOIN orders active_order ON active_order.active_customer_slot_id = u.id
  LEFT JOIN risk_events risk ON risk.user_id = u.id`;
const playerSelect = `SELECT pp.id AS player_id, pp.user_id, u.display_name, da.discord_user_id, da.username AS discord_username, pp.review_status::text, pp.availability::text, pp.discord_presence::text, pp.row_version, pp.created_at, pp.updated_at,
  active_order.id AS active_order_id,
  COALESCE(array_agg(DISTINCT tag.code) FILTER (WHERE tag.type = 'GAME'), '{}') AS game_tags,
  COALESCE(array_agg(DISTINCT tag.code) FILTER (WHERE tag.type = 'SERVICE'), '{}') AS service_tags,
  COALESCE(array_agg(DISTINCT tag.code) FILTER (WHERE tag.type = 'LANGUAGE'), '{}') AS language_tags,
  COALESCE(jsonb_agg(DISTINCT jsonb_build_object('code', tag.code, 'displayName', tag.display_name)) FILTER (WHERE tag.type = 'GAME'), '[]') AS game_tag_details,
  COALESCE(jsonb_agg(DISTINCT jsonb_build_object('code', tag.code, 'displayName', tag.display_name)) FILTER (WHERE tag.type = 'SERVICE'), '[]') AS service_tag_details,
  COALESCE(jsonb_agg(DISTINCT jsonb_build_object('code', tag.code, 'displayName', tag.display_name)) FILTER (WHERE tag.type = 'LANGUAGE'), '[]') AS language_tag_details
  FROM player_profiles pp JOIN users u ON u.id = pp.user_id LEFT JOIN player_skills skill ON skill.player_profile_id = pp.id
  LEFT JOIN skill_tags tag ON tag.id = skill.skill_tag_id
  LEFT JOIN LATERAL (SELECT discord_user_id, username FROM discord_accounts WHERE user_id = u.id ORDER BY created_at ASC LIMIT 1) da ON TRUE
  LEFT JOIN orders active_order ON active_order.active_player_slot_id = pp.user_id`;
const giftCatalogCurrentSelect = `SELECT item.id, item.code, item.archived_at, version.id AS gift_catalog_version_id, version.name, version.price_minor, version.currency, version.status::text,
  version.version, version.broadcast_template, version.gift_category_tag_id, category.code AS gift_category_code, category.display_name AS gift_category_display_name,
  version.created_by_staff_id, version.activated_at, version.retired_at, version.created_at FROM gift_catalog_items item
  JOIN gift_catalog_versions version ON version.gift_catalog_item_id = item.id
  LEFT JOIN skill_tags category ON category.id = version.gift_category_tag_id
  WHERE item.id = $1 ORDER BY version.version DESC LIMIT 1`;
const giftRequestSelect = `SELECT gr.id, gr.public_id,gr.guild_id,gr.origin::text,gr.sender_visibility::text, gr.order_id, orders.public_id AS order_public_id, orders.status::text AS order_status,
  NULLIF(to_jsonb(gr)->>'order_participant_id', '')::uuid AS order_participant_id, gr.gift_catalog_version_id,
  gr.sender_id, sender.display_name AS sender_display_name, sender_account.discord_user_id AS sender_discord_user_id, sender_account.username AS sender_discord_username,
  gr.receiver_id, receiver.display_name AS receiver_display_name, receiver_account.discord_user_id AS receiver_discord_user_id, receiver_account.username AS receiver_discord_username,
  gr.status::text, gr.row_version, gr.gift_code_snapshot, gr.gift_name_snapshot, gr.price_minor, gr.currency, gr.broadcast_template_snapshot,
  reservation.id AS reservation_id, reservation.status::text AS reservation_status, reservation.expires_at AS reservation_expires_at,
  gr.verified_by_staff_id, gr.verified_at, gr.verification_note, gr.approved_by_staff_id, gr.approved_at, gr.captured_at, gr.announced_at,
  gr.broadcast_channel_id, gr.broadcast_message_id, gr.rejected_reason, gr.failure_code, gr.expires_at, gr.withdrawn_at, gr.created_at, gr.updated_at,
  CASE
    WHEN gr.announced_at IS NOT NULL OR announcement_job.status = 'COMPLETED' THEN 'ANNOUNCED'
    WHEN announcement_job.status = 'FAILED' THEN 'FAILED'
    WHEN announcement_job.status IN ('PENDING', 'PROCESSING') THEN 'PENDING'
    ELSE 'NOT_QUEUED'
  END AS announcement_status
  FROM gift_requests gr
  LEFT JOIN orders ON orders.id = gr.order_id
  JOIN users sender ON sender.id = gr.sender_id
  JOIN users receiver ON receiver.id = gr.receiver_id
  LEFT JOIN LATERAL (SELECT discord_user_id, username FROM discord_accounts WHERE user_id=gr.sender_id AND guild_id=gr.guild_id ORDER BY created_at LIMIT 1) sender_account ON TRUE
  LEFT JOIN LATERAL (SELECT discord_user_id, username FROM discord_accounts WHERE user_id=gr.receiver_id AND guild_id=gr.guild_id ORDER BY created_at LIMIT 1) receiver_account ON TRUE
  LEFT JOIN LATERAL (SELECT id, status, expires_at FROM fund_reservations WHERE gift_request_id=gr.id ORDER BY created_at DESC LIMIT 1) reservation ON TRUE
  LEFT JOIN LATERAL (
    SELECT status::text AS status
    FROM outbox_events
    WHERE gift_request_id = gr.id AND event_type = 'GIFT_ANNOUNCEMENT'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  ) announcement_job ON TRUE`;
interface AdminUserRow { id: string; display_name: string; status: string; discord_user_id: string | null; discord_username: string | null; row_version: number; active_order_id: string | null; risk_flags: string[]; created_at: Date | string; updated_at: Date | string }
interface PlayerRow { player_id: string; user_id: string; display_name: string; discord_user_id: string | null; discord_username: string | null; review_status: string; availability: string; discord_presence: string; row_version: number; active_order_id: string | null; game_tags: string[]; service_tags: string[]; language_tags: string[]; game_tag_details: AdminTagSummary[]; service_tag_details: AdminTagSummary[]; language_tag_details: AdminTagSummary[]; created_at: Date | string; updated_at: Date | string }
interface ConsumptionRow { id: string; user_id: string; entry_type: string; source_id: string; amount_minor: string | number; currency: string; direction: string; occurred_at: Date | string; reversal_of_entry_id: string | null }
interface GiftCatalogRow { id: string; gift_catalog_version_id: string; code: string; name: string; price_minor: string | number; currency: string; status: string; version: number; broadcast_template: string; gift_category_tag_id: string | null; gift_category_code: string | null; gift_category_display_name: string | null; created_by_staff_id: string; activated_at: Date | string | null; retired_at: Date | string | null; archived_at: Date | string | null; created_at: Date | string }
interface GiftRequestRow { id: string; public_id: string; guild_id:string;origin:'ORDER'|'STANDALONE';sender_visibility:'PUBLIC'|'ANONYMOUS'; order_id: string|null; order_public_id: string|null; order_status: string|null; order_participant_id: string | null; gift_catalog_version_id: string; sender_id: string; sender_display_name: string; sender_discord_user_id: string | null; sender_discord_username: string | null; receiver_id: string; receiver_display_name: string; receiver_discord_user_id: string | null; receiver_discord_username: string | null; status: string; row_version: number; gift_code_snapshot: string; gift_name_snapshot: string; price_minor: string | number; currency: string; broadcast_template_snapshot: string; reservation_id: string | null; reservation_status: string | null; reservation_expires_at: Date | string | null; announcement_status: string; verified_by_staff_id: string | null; verified_at: Date | string | null; verification_note: string | null; approved_by_staff_id: string | null; approved_at: Date | string | null; captured_at: Date | string | null; announced_at: Date | string | null; broadcast_channel_id: string | null; broadcast_message_id: string | null; rejected_reason: string | null; failure_code: string | null; expires_at: Date | string; withdrawn_at: Date | string | null; created_at: Date | string; updated_at: Date | string }
function mapUser(row: AdminUserRow): AdminUserRecord { return { id: row.id, displayName: row.display_name, status: row.status, discordUserId: row.discord_user_id, discordUsername: row.discord_username, externalAccountDisplay: null, activeOrderId: row.active_order_id, riskFlags: row.risk_flags, version: row.row_version, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }; }
function mapPlayer(row: PlayerRow): AdminPlayerRecord { return { playerId: row.player_id, userId: row.user_id, displayName: row.display_name, discordUserId: row.discord_user_id, discordUsername: row.discord_username, reviewStatus: row.review_status, availability: row.availability, discordPresence: row.discord_presence, gameTags: row.game_tags, serviceTags: row.service_tags, languageTags: row.language_tags, gameTagDetails: row.game_tag_details, serviceTagDetails: row.service_tag_details, languageTagDetails: row.language_tag_details, activeOrderId: row.active_order_id, version: row.row_version, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }; }
function mapGiftCatalog(row: GiftCatalogRow): AdminGiftCatalogRecord { return { id: row.id, giftCatalogVersionId: row.gift_catalog_version_id, code: row.code, name: row.name, priceMinor: safeMinorInteger(row.price_minor), currency: row.currency, status: row.status, enabled: row.status === 'ACTIVE', version: row.version, broadcastTemplate: row.broadcast_template, giftCategoryTagId: row.gift_category_tag_id, giftCategoryTagDetails: row.gift_category_code ? { code: row.gift_category_code, displayName: row.gift_category_display_name ?? row.gift_category_code } : null, createdByStaffId: row.created_by_staff_id, createdAt: isoTime(row.created_at)!, activatedAt: isoTime(row.activated_at), retiredAt: isoTime(row.retired_at), archivedAt: isoTime(row.archived_at) }; }
function mapGiftRequest(row: GiftRequestRow): AdminGiftRequestRecord { return { id: row.id, publicId: row.public_id,guildId:row.guild_id,origin:row.origin,senderVisibility:row.sender_visibility, orderId: row.order_id, orderPublicId: row.order_public_id, orderStatus: row.order_status, orderParticipantId: row.order_participant_id, giftCatalogVersionId: row.gift_catalog_version_id, senderId: row.sender_id, senderDisplayName: row.sender_display_name, senderDiscordUserId: row.sender_discord_user_id, senderDiscordUsername: row.sender_discord_username, receiverId: row.receiver_id, receiverDisplayName: row.receiver_display_name, receiverDiscordUserId: row.receiver_discord_user_id, receiverDiscordUsername: row.receiver_discord_username, status: row.status, rowVersion: row.row_version, giftCode: row.gift_code_snapshot, giftName: row.gift_name_snapshot, amountMinor: safeMinorInteger(row.price_minor), currency: row.currency, broadcastTemplate: row.broadcast_template_snapshot, reservationId: row.reservation_id, reservationStatus: row.reservation_status, reservationExpiresAt: isoTime(row.reservation_expires_at), announcementStatus: row.announcement_status, verifiedByStaffId: row.verified_by_staff_id, verifiedAt: isoTime(row.verified_at), verificationNote: row.verification_note, approvedByStaffId: row.approved_by_staff_id, approvedAt: isoTime(row.approved_at), capturedAt: isoTime(row.captured_at), announcedAt: isoTime(row.announced_at), broadcastChannelId: row.broadcast_channel_id, broadcastMessageId: row.broadcast_message_id, rejectedReason: row.rejected_reason, failureCode: row.failure_code, expiresAt: isoTime(row.expires_at)!, withdrawnAt: isoTime(row.withdrawn_at), createdAt: isoTime(row.created_at)!, updatedAt: isoTime(row.updated_at)! }; }
function isoTime(value: Date | string | null): string | null { return value === null ? null : new Date(value).toISOString(); }
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
