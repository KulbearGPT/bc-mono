import { createHash } from 'node:crypto';
import type {
  OrderPanelDiscordAdapter,
  OrderPanelProjection,
  OrderPanelProjectionStore
} from './worker-runtime.js';

interface QueryResult {
  rows: Record<string, unknown>[];
}

export interface WorkerAdapterQueryClient {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
}

export class WorkerAdapterError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_DATA' | 'DISCORD_ERROR',
    message: string,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = 'WorkerAdapterError';
  }
}

export class PostgresOrderPanelProjectionStore implements OrderPanelProjectionStore {
  constructor(private readonly client: WorkerAdapterQueryClient) {}

  async getOrderPanelProjection(orderId: string): Promise<OrderPanelProjection | null> {
    const result = await this.client.query(
      `
SELECT orders.id AS order_id,
       orders.public_id,
       orders.status::text AS status,
       orders.row_version,
       orders.channel_id,
       orders.panel_message_id,
       orders.guild_id,
       orders.selection_voice_channel_id,
       orders.voice_channel_id,
       config.config_json,
       customer_discord.discord_user_id AS customer_discord_user_id,
       player_discord.discord_user_id AS player_discord_user_id,
       ARRAY(
         SELECT participant_discord.discord_user_id
         FROM order_participants participant
         JOIN discord_accounts participant_discord
           ON participant_discord.user_id = participant.player_id
          AND participant_discord.guild_id = orders.guild_id
         WHERE participant.order_id = orders.id
           AND participant.status = 'ACTIVE'
         ORDER BY participant.created_at, participant.id
       ) AS player_discord_user_ids,
       (SELECT COALESCE(SUM(requirement.requested_player_count), 0)::int
          FROM order_requirements requirement
         WHERE requirement.order_id = orders.id AND requirement.status = 'ACTIVE') AS requested_player_count,
       (SELECT COUNT(*)::int
          FROM order_participants participant
         WHERE participant.order_id = orders.id AND participant.status = 'ACTIVE') AS filled_player_count,
       (SELECT jsonb_agg(jsonb_build_object(
                 'gameDisplayName', COALESCE(to_jsonb(requirement)->>'game_display_name_snapshot', to_jsonb(requirement)->>'game_code_snapshot'),
                 'serviceDisplayName', COALESCE(to_jsonb(requirement)->>'service_display_name_snapshot', to_jsonb(requirement)->>'service_code_snapshot'),
                 'regionDisplayName', COALESCE(to_jsonb(requirement)->>'region_display_name_snapshot', to_jsonb(requirement)->>'region_code_snapshot'),
                 'durationMinutes', NULLIF(to_jsonb(requirement)->>'billing_unit_minutes_snapshot','')::int * NULLIF(to_jsonb(requirement)->>'unit_count','')::int,
                 'requestedPlayerCount', requirement.requested_player_count,
                 'customerNote', to_jsonb(requirement)->>'customer_note'
               ) ORDER BY requirement.id)
          FROM order_requirements requirement
         WHERE requirement.order_id = orders.id AND requirement.status = 'ACTIVE') AS coordination_requirements,
       orders.game_name_snapshot AS legacy_game_display_name,
       orders.service_name_snapshot AS legacy_service_display_name,
       COALESCE(to_jsonb(orders)->>'region_name_snapshot', orders.region_code_snapshot) AS legacy_region_display_name,
       orders.billing_unit_minutes AS legacy_billing_unit_minutes,
       orders.unit_count AS legacy_unit_count,
       orders.customer_note AS legacy_customer_note,
       orders.submitted_at,
       orders.accepted_at,
       orders.amount_minor,
       orders.currency,
       (SELECT jsonb_build_object(
                 'id', selection_pool.id,
                 'status', selection_pool.status::text,
                 'version', selection_pool.row_version,
                 'round', selection_pool.round,
                 'applicationCount', (SELECT COUNT(*)::int
                                        FROM selection_applications application
                                       WHERE application.selection_pool_id=selection_pool.id
                                         AND application.status='APPLIED'),
                 'applicantDiscordUserIds', ARRAY(
                   SELECT applicant_discord.discord_user_id
                     FROM selection_applications application
                     JOIN discord_accounts applicant_discord
                       ON applicant_discord.user_id=application.player_user_id
                      AND applicant_discord.guild_id=orders.guild_id
                    WHERE application.selection_pool_id=selection_pool.id
                      AND application.status='APPLIED'
                    GROUP BY applicant_discord.discord_user_id
                    ORDER BY MIN(application.applied_at),applicant_discord.discord_user_id
                 ),
                 'closesAt', selection_pool.closes_at
               )
          FROM selection_pools selection_pool
         WHERE selection_pool.order_id=orders.id
           AND selection_pool.status IN ('COLLECTING','SELECTION')
         ORDER BY selection_pool.round DESC
         LIMIT 1) AS selection_pool,
       (orders.status='COMPLETED'
        AND orders.completed_at IS NOT NULL
        AND orders.completed_at+interval '24 hours'>=now()
        AND EXISTS (
          SELECT 1 FROM staff_tasks support_task
           WHERE support_task.order_id=orders.id
             AND support_task.first_responded_at IS NOT NULL
             AND support_task.first_response_event_id IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM order_support_ratings support_rating
           WHERE support_rating.order_id=orders.id
        )) AS support_rating_eligible
FROM orders AS orders
JOIN users AS customer ON customer.id = orders.customer_id
JOIN discord_accounts AS customer_discord
  ON customer_discord.user_id = customer.id
 AND customer_discord.guild_id = orders.guild_id
LEFT JOIN users AS player ON player.id = orders.player_id
LEFT JOIN discord_accounts AS player_discord
  ON player_discord.user_id = player.id
 AND player_discord.guild_id = orders.guild_id
LEFT JOIN guild_bot_configs AS config ON config.guild_id = orders.guild_id
WHERE orders.id = $1
      `,
      [orderId]
    );
    const row = result.rows[0];
    return row ? mapProjection(row) : null;
  }

  async setVoiceChannelId(input: { orderId: string; voiceChannelId: string }): Promise<void> {
    const result = await this.client.query(
      `UPDATE orders SET voice_channel_id=$2, updated_at=now()
       WHERE id=$1 AND (voice_channel_id IS NULL OR voice_channel_id=$2) RETURNING id`,
      [input.orderId, input.voiceChannelId]
    );
    if (!result.rows[0]) throw new WorkerAdapterError('CONFLICT', 'Order voice channel changed concurrently.');
  }

  async replacePanelMessageId(input: {
    orderId: string;
    expectedPanelMessageId: string;
    panelMessageId: string;
  }): Promise<void> {
    const updated = await this.client.query(
      `
UPDATE orders
SET panel_message_id = $3,
    updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND panel_message_id = $2
RETURNING id
      `,
      [input.orderId, input.expectedPanelMessageId, input.panelMessageId]
    );
    if (updated.rows[0]) return;

    const current = await this.client.query(
      'SELECT panel_message_id FROM orders WHERE id = $1',
      [input.orderId]
    );
    if (!current.rows[0]) {
      throw new WorkerAdapterError('NOT_FOUND', 'Order was not found while replacing its panel message.');
    }
    throw new WorkerAdapterError('CONFLICT', 'Order panel message changed before the replacement could be stored.');
  }
}

type WorkerFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class DiscordRestWorkerAdapter implements OrderPanelDiscordAdapter {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetch: WorkerFetch;

  constructor(input: { token: string; apiBaseUrl?: string; fetch?: WorkerFetch }) {
    if (!input.token.trim()) throw new WorkerAdapterError('INVALID_DATA', 'Discord Bot token is required.');
    this.token = input.token;
    this.apiBaseUrl = (input.apiBaseUrl ?? 'https://discord.com/api/v10').replace(/\/$/u, '');
    this.fetch = input.fetch ?? globalThis.fetch;
  }

  async upsertOrderPanel(projection: OrderPanelProjection, notBefore: string): Promise<{ messageId: string; recreated: boolean; voiceChannelId?: string }> {
    const voiceChannelId = projection.status === 'ACCEPTED'
      ? await this.ensureAcceptedCoordination(projection, notBefore)
      : projection.voiceChannelId ?? undefined;
    if (projection.status !== 'ACCEPTED' && voiceChannelId)
      await this.updateStaffCoordination(projection, voiceChannelId, notBefore);
    for (const playerDiscordUserId of activePlayerDiscordUserIds(projection)) {
      await this.request(
        `/channels/${encodeURIComponent(projection.channelId)}/permissions/${encodeURIComponent(playerDiscordUserId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ allow: String(VIEW_CHANNEL | SEND_MESSAGES), deny: '0', type: 1 })
        }
      );
    }

    const panel = renderOrderPanel(projection);
    const body = JSON.stringify(panel);
    const patch = await this.fetch(
      this.url(`/channels/${encodeURIComponent(projection.channelId)}/messages/${encodeURIComponent(projection.panelMessageId)}`),
      this.init({ method: 'PATCH', body })
    );
    if (patch.ok) {
      const message = await readMessage(patch, projection.panelMessageId);
      return voiceChannelId ? { messageId: message.id, recreated: false, voiceChannelId } : { messageId: message.id, recreated: false };
    }
    if (patch.status !== 404) throw await discordFailure(patch);

    const nonce = createHash('sha256').update(`order-panel:${projection.orderId}`).digest('hex').slice(0, 24);
    const recoveredMessageId = await this.findMessageByNonce(projection.channelId, nonce, notBefore);
    if (recoveredMessageId) return { messageId: recoveredMessageId, recreated: true };
    const created = await this.request<{ id: string }>(
      `/channels/${encodeURIComponent(projection.channelId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...panel,
          nonce,
          enforce_nonce: true
        })
      }
    );
    if (!created.id) throw new WorkerAdapterError('DISCORD_ERROR', 'Discord returned an invalid replacement panel message.');
    return voiceChannelId ? { messageId: created.id, recreated: true, voiceChannelId } : { messageId: created.id, recreated: true };
  }

  private async ensureAcceptedCoordination(projection: OrderPanelProjection, notBefore: string): Promise<string | undefined> {
    const playerDiscordUserIds = activePlayerDiscordUserIds(projection);
    if (!projection.guildId || playerDiscordUserIds.length === 0 || !projection.staffTaskChannelId) return projection.voiceChannelId ?? undefined;
    let voiceChannelId = projection.voiceChannelId ?? null;
    if (!voiceChannelId) {
      const channelName = `service-${projection.publicId}`.toLowerCase().replace(/[^a-z0-9-]/gu, '-').slice(0, 90);
      const channels = await this.request<Array<{ id: string; name: string; type: number; parent_id?: string | null }>>(`/guilds/${projection.guildId}/channels`, { method: 'GET' });
      voiceChannelId = channels.find((channel) => channel.type === 2 && channel.name === channelName && channel.parent_id === projection.privateOrderCategoryId)?.id ?? null;
      if (!voiceChannelId) {
        const customerFirst = Boolean(projection.selectionVoiceChannelId);
        const overwrites = [
          { id: projection.guildId, type: 0, allow: '0', deny: String(VIEW_CHANNEL | CONNECT) },
          { id: projection.customerDiscordUserId, type: 1, allow: String(VIEW_CHANNEL | CONNECT | SPEAK), deny: '0' },
          ...playerDiscordUserIds.map((id) => ({
            id,
            type: 1,
            allow: String(VIEW_CHANNEL | (customerFirst ? 0 : CONNECT | SPEAK)),
            deny: customerFirst ? String(CONNECT) : '0'
          })),
          ...(projection.staffRoleIds ?? []).map((id) => ({
            id,
            type: 0,
            allow: String(VIEW_CHANNEL | MANAGE_CHANNELS | MOVE_MEMBERS | (customerFirst ? 0 : CONNECT | SPEAK)),
            deny: customerFirst ? String(CONNECT) : '0'
          }))
        ];
        const created = await this.request<{ id: string }>(`/guilds/${projection.guildId}/channels`, { method: 'POST', body: JSON.stringify({
          name: channelName, type: 2, parent_id: projection.privateOrderCategoryId ?? undefined,
          user_limit: Math.min(99, playerDiscordUserIds.length + 1), permission_overwrites: overwrites
        }) });
        voiceChannelId = text(created.id, 'voice_channel.id');
      }
    }
    const voiceLink = `https://discord.com/channels/${projection.guildId}/${voiceChannelId}`;
    await this.sendOnce(projection.channelId, `accepted-customer:${projection.orderId}`, `<@${projection.customerDiscordUserId}> 你的陪玩已匹配成功，正式服务语音房已创建：${voiceLink}`, notBefore, [projection.customerDiscordUserId]);
    await this.sendOnce(projection.staffTaskChannelId, `accepted-staff:${projection.orderId}`,
      buildStaffCoordinationNotice(projection, voiceChannelId, projection.selectionVoiceChannelId), notBefore);
    return voiceChannelId;
  }

  private async updateStaffCoordination(
    projection: OrderPanelProjection,
    voiceChannelId: string,
    notBefore: string
  ): Promise<void> {
    if (!projection.guildId || !projection.staffTaskChannelId || activePlayerDiscordUserIds(projection).length === 0) return;
    const nonce = createHash('sha256').update(`accepted-staff:${projection.orderId}`).digest('hex').slice(0, 24);
    const messageId = await this.findMessageByNonce(projection.staffTaskChannelId, nonce, notBefore);
    if (!messageId) return;
    await this.request(
      `/channels/${encodeURIComponent(projection.staffTaskChannelId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(buildStaffCoordinationNotice(projection, voiceChannelId, projection.selectionVoiceChannelId))
      }
    );
  }

  private async sendOnce(
    channelId: string,
    key: string,
    message: string | Record<string, unknown>,
    notBefore: string,
    users: string[] = []
  ): Promise<void> {
    const nonce = createHash('sha256').update(key).digest('hex').slice(0, 24);
    if (await this.findMessageByNonce(channelId, nonce, notBefore)) return;
    const payload = typeof message === 'string' ? { content: message } : message;
    await this.request(`/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify({
      ...payload,
      nonce,
      enforce_nonce: true,
      allowed_mentions: 'allowed_mentions' in payload ? payload.allowed_mentions : { parse: [], users }
    }) });
  }

  private async findMessageByNonce(channelId: string, nonce: string, notBefore: string): Promise<string | null> {
    const cutoff = Date.parse(notBefore) - 5 * 60_000;
    if (!Number.isFinite(cutoff)) throw new WorkerAdapterError('INVALID_DATA', 'Message reconciliation boundary is invalid.');
    let before: string | null = null;
    while (true) {
      const suffix = before ? `&before=${encodeURIComponent(before)}` : '';
      const messages = await this.request<unknown>(`/channels/${encodeURIComponent(channelId)}/messages?limit=100${suffix}`, { method: 'GET' });
      if (!Array.isArray(messages)) throw new WorkerAdapterError('DISCORD_ERROR', 'Discord message history response is invalid.');
      const found = messages.find((value) => value && typeof value === 'object' && String((value as { nonce?: unknown }).nonce ?? '') === nonce);
      if (found) return text((found as { id?: unknown }).id, 'message.id');
      if (messages.length < 100) return null;
      const oldest = messages.at(-1) as { id?: unknown; timestamp?: unknown };
      const oldestAt = Date.parse(text(oldest.timestamp, 'message.timestamp'));
      if (!Number.isFinite(oldestAt)) throw new WorkerAdapterError('DISCORD_ERROR', 'Discord message timestamp is invalid.');
      if (oldestAt < cutoff) return null;
      before = text(oldest.id, 'message.id');
    }
  }

  private async request<T = void>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetch(this.url(path), this.init(init));
    if (!response.ok) throw await discordFailure(response);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private init(init: RequestInit): RequestInit {
    return {
      ...init,
      headers: {
        authorization: `Bot ${this.token}`,
        'content-type': 'application/json',
        ...init.headers
      }
    };
  }

  private url(path: string): string {
    return `${this.apiBaseUrl}${path}`;
  }
}

const VIEW_CHANNEL = 1 << 10;
const SEND_MESSAGES = 1 << 11;
const MANAGE_CHANNELS = 1 << 4;
const CONNECT = 1 << 20;
const SPEAK = 1 << 21;
const MOVE_MEMBERS = 1 << 24;

function mapProjection(row: Record<string, unknown>): OrderPanelProjection {
  const config = row.config_json && typeof row.config_json === 'object' ? row.config_json as Record<string, unknown> : {};
  const legacyPlayerDiscordUserId = nullableText(row.player_discord_user_id, 'player_discord_user_id');
  const participantDiscordUserIds = textArray(row.player_discord_user_ids, 'player_discord_user_ids');
  const playerDiscordUserIds = [...new Set([
    ...participantDiscordUserIds,
    ...(legacyPlayerDiscordUserId ? [legacyPlayerDiscordUserId] : [])
  ])];
  return {
    orderId: text(row.order_id, 'order_id'),
    publicId: text(row.public_id, 'public_id'),
    status: text(row.status, 'status'),
    version: integer(row.row_version, 'row_version'),
    channelId: text(row.channel_id, 'channel_id'),
    panelMessageId: text(row.panel_message_id, 'panel_message_id'),
    customerDiscordUserId: text(row.customer_discord_user_id, 'customer_discord_user_id'),
    playerDiscordUserId: legacyPlayerDiscordUserId,
    playerDiscordUserIds,
    requestedPlayerCount: optionalInteger(row.requested_player_count, playerDiscordUserIds.length),
    filledPlayerCount: optionalInteger(row.filled_player_count, playerDiscordUserIds.length),
    coordinationRequirements: coordinationRequirements(row),
    submittedAt: nullableDateText(row.submitted_at, 'submitted_at'),
    acceptedAt: nullableDateText(row.accepted_at, 'accepted_at'),
    amountMinor: integer(row.amount_minor, 'amount_minor'),
    currency: text(row.currency, 'currency').trim()
    ,...(typeof row.support_rating_eligible === 'boolean'
      ? { supportRatingEligible: row.support_rating_eligible }
      : {})
    ,guildId: text(row.guild_id, 'guild_id')
    ,...(nullableText(row.selection_voice_channel_id, 'selection_voice_channel_id')
      ? { selectionVoiceChannelId: nullableText(row.selection_voice_channel_id, 'selection_voice_channel_id') }
      : {})
    ,voiceChannelId: nullableText(row.voice_channel_id, 'voice_channel_id')
    ,privateOrderCategoryId: nullableConfigText(config.private_order_category_id)
    ,staffTaskChannelId: nullableConfigText(config.staff_task_channel_id)
    ,staffRoleIds: ['staff_l1_role_id','staff_l2_role_id','staff_l3_role_id','staff_l4_role_id'].map((key)=>nullableConfigText(config[key])).filter((value):value is string=>Boolean(value))
    ,...selectionPoolProjection(row.selection_pool)
  };
}

function selectionPoolProjection(value: unknown): Pick<OrderPanelProjection, 'selectionPool'> | Record<string, never> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidRow('selection_pool');
  const pool = value as Record<string, unknown>;
  const status = text(pool.status, 'selection_pool.status');
  if (status !== 'COLLECTING' && status !== 'SELECTION') throw invalidRow('selection_pool.status');
  const closesAt = nullableDateText(pool.closesAt, 'selection_pool.closesAt');
  return {
    selectionPool: {
      id: text(pool.id, 'selection_pool.id'),
      status,
      version: integer(pool.version, 'selection_pool.version'),
      round: integer(pool.round, 'selection_pool.round'),
      applicationCount: integer(pool.applicationCount, 'selection_pool.applicationCount'),
      applicantDiscordUserIds: pool.applicantDiscordUserIds === undefined
        ? []
        : textArray(pool.applicantDiscordUserIds, 'selection_pool.applicantDiscordUserIds'),
      closesAt
    }
  };
}

function nullableConfigText(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }

function buildStaffCoordinationNotice(
  projection: OrderPanelProjection,
  voiceChannelId: string,
  selectionVoiceChannelId?: string | null
): Record<string, unknown> {
  const guildId = projection.guildId!;
  const playerIds = activePlayerDiscordUserIds(projection);
  const orderLink = `https://discord.com/channels/${guildId}/${projection.channelId}`;
  const voiceLink = `https://discord.com/channels/${guildId}/${voiceChannelId}`;
  const selectionVoiceLink = selectionVoiceChannelId
    ? `https://discord.com/channels/${guildId}/${selectionVoiceChannelId}`
    : null;
  const requirements = projection.coordinationRequirements ?? [];
  const requirementSummary = requirements.length > 0
    ? requirements.map((requirement, index) => {
      const location = requirement.regionDisplayName ? ` · ${requirement.regionDisplayName}` : '';
      const duration = requirement.durationMinutes ? formatMinutes(requirement.durationMinutes) : '时长待确认';
      const note = requirement.customerNote ? `\n   需求备注：${requirement.customerNote}` : '';
      return `${index + 1}. **${requirement.gameDisplayName} · ${requirement.serviceDisplayName}${location}**\n   ${duration} · ${requirement.requestedPlayerCount} 位${note}`;
    }).join('\n')
    : '暂无结构化需求，请进入订单频道确认。';
  const timeLines = [
    projection.submittedAt ? `下单：${discordTimestamp(projection.submittedAt)}` : null,
    projection.acceptedAt ? `匹配：${discordTimestamp(projection.acceptedAt)}` : null
  ].filter(Boolean).join('\n') || '暂无时间记录';
  return {
    content: null,
    embeds: [{
      color: 0x5865f2,
      title: `🛠️ 新订单协调 · ${projection.publicId}`.slice(0, 256),
      description: '订单已匹配完成，请客服在进入协调前先查看参与人和项目需求。',
      fields: [
        embedField('当前状态', `${coordinationStatusLabel(projection.status)}（${projection.status}）`, true),
        embedField('客户', `<@${projection.customerDiscordUserId}>`, true),
        embedField('已匹配陪玩', playerIds.map((id) => `<@${id}>`).join('、') || '待确认', false),
        embedField('项目需求', requirementSummary, false),
        embedField('关键时间', timeLines, false),
        embedField('协调入口', [
          `[打开订单频道](${orderLink})`,
          selectionVoiceLink ? `[进入协调语音房](${selectionVoiceLink})` : null,
          `[进入服务房间](${voiceLink})`
        ].filter(Boolean).join(' · '), false)
      ],
      footer: { text: '协调前请先确认需求、参与人与准备状态 · Blackcat Companion' }
    }],
    components: [{ type: 1, components: [
      { type: 2, style: 5, label: '打开订单频道', url: orderLink },
      ...(selectionVoiceLink
        ? [{ type: 2, style: 5, label: '进入协调语音房', url: selectionVoiceLink }]
        : []),
      { type: 2, style: 5, label: '进入服务房间', url: voiceLink }
    ] }],
    allowed_mentions: { parse: [] }
  };
}

function embedField(name: string, value: string, inline: boolean): { name: string; value: string; inline: boolean } {
  return { name, value: truncate(value, 1_024), inline };
}

function formatMinutes(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

function discordTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? `<t:${Math.floor(milliseconds / 1_000)}:F>` : value;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function coordinationStatusLabel(status: string): string {
  return status === 'ACCEPTED' ? '等待双方准备' : orderStatusLabel(status);
}

function coordinationRequirements(row: Record<string, unknown>): NonNullable<OrderPanelProjection['coordinationRequirements']> {
  const raw = row.coordination_requirements;
  if (Array.isArray(raw) && raw.length > 0) {
    const requirements = raw.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRow('coordination_requirements');
      const item = value as Record<string, unknown>;
      const gameDisplayName = nullablePlainText(item.gameDisplayName);
      const serviceDisplayName = nullablePlainText(item.serviceDisplayName);
      if (!gameDisplayName || !serviceDisplayName) throw invalidRow('coordination_requirements');
      return {
        gameDisplayName,
        serviceDisplayName,
        regionDisplayName: nullablePlainText(item.regionDisplayName),
        durationMinutes: nullablePositiveInteger(item.durationMinutes),
        requestedPlayerCount: optionalInteger(item.requestedPlayerCount, 1),
        customerNote: nullablePlainText(item.customerNote)
      };
    });
    return requirements;
  }
  const gameDisplayName = nullablePlainText(row.legacy_game_display_name);
  const serviceDisplayName = nullablePlainText(row.legacy_service_display_name);
  if (!gameDisplayName || !serviceDisplayName) return [];
  const billingUnitMinutes = nullablePositiveInteger(row.legacy_billing_unit_minutes);
  const unitCount = nullablePositiveInteger(row.legacy_unit_count);
  return [{
    gameDisplayName,
    serviceDisplayName,
    regionDisplayName: nullablePlainText(row.legacy_region_display_name),
    durationMinutes: billingUnitMinutes && unitCount ? billingUnitMinutes * unitCount : null,
    requestedPlayerCount: 1,
    customerNote: nullablePlainText(row.legacy_customer_note)
  }];
}

function nullablePlainText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nullableDateText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(text(value, field));
  if (!Number.isFinite(date.getTime())) throw invalidRow(field);
  return date.toISOString();
}

function renderOrderPanel(projection: OrderPanelProjection) {
  const playerDiscordUserIds = activePlayerDiscordUserIds(projection);
  const requestedPlayerCount = projection.requestedPlayerCount ?? Math.max(playerDiscordUserIds.length, 1);
  const filledPlayerCount = projection.filledPlayerCount ?? playerDiscordUserIds.length;
  const participants = playerDiscordUserIds.length > 0
    ? `已到位陪玩：${playerDiscordUserIds.map((id) => `<@${id}>`).join('、')}`
    : '陪玩：待接单';
  const assembly = projection.status === 'PENDING_DISPATCH' && !projection.selectionPool && requestedPlayerCount > 0
    ? `陪玩到位：${filledPlayerCount}/${requestedPlayerCount}\n${filledPlayerCount < requestedPlayerCount ? `还差 ${requestedPlayerCount - filledPlayerCount} 位，全部到齐后开放准备确认。` : '队伍已到齐，正在进入准备确认。'}`
    : null;
  const selection = selectionPanelSummary(projection);
  const body = [
    `-# 订单 #${projection.publicId} · ${selection?.label ?? orderStatusLabel(projection.status)}`,
    `## 当前订单状态：${projection.status}`,
    `金额：${projection.currency} ${(projection.amountMinor / (projection.currency === 'CAT' ? 10 : 100)).toFixed(projection.currency === 'CAT' ? 1 : 2)}`,
    `客户：<@${projection.customerDiscordUserId}>`,
    participants,
    assembly,
    selection?.body
  ].filter(Boolean).join('\n');
  const interactionRows = selectionPanelRows(projection);
  return {
    flags: 1 << 15,
    allowed_mentions: { parse: [] },
    components: [{
      type: 17,
      accent_color: 2_410_696,
      components: [
        { type: 10, content: body },
        ...interactionRows,
        { type: 1, components: panelActions(projection) },
        { type: 10, content: '-# Blackcat Companion' }
      ]
    }]
  };
}

function selectionPanelSummary(projection: OrderPanelProjection): { label: string; body: string } | null {
  if (projection.status !== 'PENDING_DISPATCH') return null;
  const pool = projection.selectionPool;
  if (!pool) return { label: '尚未开始招募', body: '点击“开始招募”后，符合条件的陪玩即可报名。' };
  if (pool.status === 'COLLECTING') {
    const applicants = selectionApplicantMentions(pool.applicantDiscordUserIds ?? []);
    return {
      label: '招募进行中',
      body: `第 ${pool.round} 轮\n当前报名陪玩：${applicants}`
    };
  }
  if (pool.applicationCount === 0) {
    return {
      label: '本轮无人报名',
      body: `第 ${pool.round} 轮招募已终止。\n当前候选：暂无\n可以重新开始招募或取消订单。`
    };
  }
  return {
    label: '等待选择陪玩',
    body: `第 ${pool.round} 轮招募已终止。\n当前候选：${selectionApplicantMentions(pool.applicantDiscordUserIds ?? [])}\n请在候选名单中确认入选陪玩。`
  };
}

function selectionPanelRows(projection: OrderPanelProjection): Array<Record<string, unknown>> {
  if (projection.status !== 'PENDING_DISPATCH') return [];
  const pool = projection.selectionPool;
  if (!pool)
    return [selectionActionRow(`bc:sp:new:${projection.orderId}:o${projection.version}`, '开始招募', 1)];
  if (pool.status === 'COLLECTING')
    return [{
      type: 1,
      components: [{
        type: 2,
        style: 1,
        label: '终止招募',
        custom_id: `bc:sp:c:${shortSelectionId(projection.orderId)}:${shortSelectionId(pool.id)}:v${pool.version}`
      }]
    }];
  if (pool.applicationCount === 0)
    return [selectionActionRow(`bc:sp:r:${shortSelectionId(projection.orderId)}:${shortSelectionId(pool.id)}:v${pool.version}:o${projection.version}`, '重新开始招募', 1)];
  return [];
}

function selectionActionRow(customId: string, label: string, style: number): Record<string, unknown> {
  return {
    type: 1,
    components: [{
      type: 2,
      style,
      custom_id: customId,
      label
    }]
  };
}

function selectionApplicantMentions(discordUserIds: string[]): string {
  return discordUserIds.length ? discordUserIds.map((id) => `<@${id}>`).join('、') : '暂无陪玩报名';
}

function shortSelectionId(uuid: string): string {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex').toString('base64url');
}

function activePlayerDiscordUserIds(projection: OrderPanelProjection): string[] {
  return [...new Set([
    ...(projection.playerDiscordUserIds ?? []),
    ...(projection.playerDiscordUserId ? [projection.playerDiscordUserId] : [])
  ])];
}

function orderStatusLabel(status: string): string {
  if (status === 'PENDING_DISPATCH') return '队伍正在集合';
  if (status === 'ACCEPTED') return '等待准备确认';
  if (status === 'IN_SERVICE') return '服务进行中';
  if (status === 'PENDING_CONFIRMATION') return '等待客户确认完成';
  if (status === 'COMPLETED') return '订单已完成';
  if (status === 'CANCELLED') return '订单已取消';
  return status;
}

function panelActions(projection: OrderPanelProjection): Array<{ type: 2; style: number; label: string; custom_id: string }> {
  const route = (action: string) => `bc:service:${action}:${projection.orderId}:v${projection.version}`;
  const support = { type: 2 as const, style: 2, label: '联系客服', custom_id: route('support') };
  const refresh = { type: 2 as const, style: 2, label: '刷新订单', custom_id: `bc:order:${projection.orderId}:refresh` };
  if (projection.status === 'PENDING_DISPATCH') {
    return [
      { type: 2, style: 4, label: '取消订单', custom_id: `bc:order:${projection.orderId}:cancel:v${projection.version}` },
      support,
      refresh
    ];
  }
  if (projection.status === 'ACCEPTED') {
    return [{ type: 2, style: 1, label: '我已就绪', custom_id: route('ready') }, support, refresh];
  }
  if (projection.status === 'IN_SERVICE') {
    return [{ type: 2, style: 1, label: '申请完成', custom_id: route('request-completion') }, support, refresh];
  }
  if (projection.status === 'PENDING_CONFIRMATION') {
    return [{ type: 2, style: 1, label: '确认完成', custom_id: route('confirm') }, support, refresh];
  }
  if (projection.status === 'COMPLETED' && projection.supportRatingEligible) {
    return [
      { type: 2, style: 1, label: '评价客服', custom_id: `bc:support-rating:${projection.orderId}:start` },
      support,
      refresh
    ];
  }
  return [support, refresh];
}

async function readMessage(response: Response, fallbackId: string): Promise<{ id: string }> {
  const value = await response.json() as { id?: unknown };
  return { id: typeof value.id === 'string' && value.id ? value.id : fallbackId };
}

async function discordFailure(response: Response): Promise<WorkerAdapterError> {
  const body = await response.clone().json().catch(() => ({})) as { retry_after?: unknown; code?: unknown; message?: unknown };
  const seconds = typeof body.retry_after === 'number' ? body.retry_after : Number(response.headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1_000) : null;
  const detail = typeof body.message === 'string'
    ? ` (${typeof body.code === 'number' ? `${body.code}: ` : ''}${body.message})`
    : '';
  return new WorkerAdapterError('DISCORD_ERROR', `Discord API request failed with status ${response.status}${detail}.`, retryAfterMs);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw invalidRow(field);
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, field);
}

function integer(value: unknown, field: string): number {
  const parsed = typeof value === 'bigint' ? Number(value) : typeof value === 'string' && /^-?\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed)) throw invalidRow(field);
  return parsed as number;
}

function optionalInteger(value: unknown, fallback: number): number {
  return value === null || value === undefined ? fallback : integer(value, 'optional_integer');
}

function textArray(value: unknown, field: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) throw invalidRow(field);
  return value as string[];
}

function invalidRow(field: string): WorkerAdapterError {
  return new WorkerAdapterError('INVALID_DATA', `Order panel projection field ${field} is invalid.`);
}
