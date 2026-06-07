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
       orders.voice_channel_id,
       config.config_json,
       customer_discord.discord_user_id AS customer_discord_user_id,
       player_discord.discord_user_id AS player_discord_user_id,
       orders.amount_minor,
       orders.currency
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
    const voiceChannelId = projection.status === 'ACCEPTED' ? await this.ensureAcceptedCoordination(projection, notBefore) : projection.voiceChannelId ?? undefined;
    if (projection.playerDiscordUserId) {
      await this.request(
        `/channels/${encodeURIComponent(projection.channelId)}/permissions/${encodeURIComponent(projection.playerDiscordUserId)}`,
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
    if (!projection.guildId || !projection.playerDiscordUserId || !projection.staffTaskChannelId) return projection.voiceChannelId ?? undefined;
    let voiceChannelId = projection.voiceChannelId ?? null;
    if (!voiceChannelId) {
      const channelName = `order-${projection.publicId}`.toLowerCase().replace(/[^a-z0-9-]/gu, '-').slice(0, 90);
      const channels = await this.request<Array<{ id: string; name: string; type: number; parent_id?: string | null }>>(`/guilds/${projection.guildId}/channels`, { method: 'GET' });
      voiceChannelId = channels.find((channel) => channel.type === 2 && channel.name === channelName && channel.parent_id === projection.privateOrderCategoryId)?.id ?? null;
      if (!voiceChannelId) {
        const overwrites = [
          { id: projection.guildId, type: 0, allow: '0', deny: String(VIEW_CHANNEL | CONNECT) },
          ...[projection.customerDiscordUserId, projection.playerDiscordUserId].map((id) => ({ id, type: 1, allow: String(VIEW_CHANNEL | CONNECT | SPEAK), deny: '0' })),
          ...(projection.staffRoleIds ?? []).map((id) => ({ id, type: 0, allow: String(VIEW_CHANNEL | CONNECT | SPEAK | MANAGE_CHANNELS | MOVE_MEMBERS), deny: '0' }))
        ];
        const created = await this.request<{ id: string }>(`/guilds/${projection.guildId}/channels`, { method: 'POST', body: JSON.stringify({
          name: channelName, type: 2, parent_id: projection.privateOrderCategoryId ?? undefined, user_limit: 2, permission_overwrites: overwrites
        }) });
        voiceChannelId = text(created.id, 'voice_channel.id');
      }
    }
    const voiceLink = `https://discord.com/channels/${projection.guildId}/${voiceChannelId}`;
    await this.sendOnce(projection.channelId, `accepted-customer:${projection.orderId}`, `<@${projection.customerDiscordUserId}> 你的陪玩已匹配成功，协调语音房已创建：${voiceLink}`, notBefore, [projection.customerDiscordUserId]);
    await this.sendOnce(projection.staffTaskChannelId, `accepted-staff:${projection.orderId}`, `订单 **${projection.publicId}** 已下单并匹配完成。客服协调语音房：${voiceLink}`, notBefore);
    return voiceChannelId;
  }

  private async sendOnce(channelId: string, key: string, content: string, notBefore: string, users: string[] = []): Promise<void> {
    const nonce = createHash('sha256').update(key).digest('hex').slice(0, 24);
    if (await this.findMessageByNonce(channelId, nonce, notBefore)) return;
    await this.request(`/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify({ content, nonce, enforce_nonce: true, allowed_mentions: { users } }) });
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
  return {
    orderId: text(row.order_id, 'order_id'),
    publicId: text(row.public_id, 'public_id'),
    status: text(row.status, 'status'),
    version: integer(row.row_version, 'row_version'),
    channelId: text(row.channel_id, 'channel_id'),
    panelMessageId: text(row.panel_message_id, 'panel_message_id'),
    customerDiscordUserId: text(row.customer_discord_user_id, 'customer_discord_user_id'),
    playerDiscordUserId: nullableText(row.player_discord_user_id, 'player_discord_user_id'),
    amountMinor: integer(row.amount_minor, 'amount_minor'),
    currency: text(row.currency, 'currency').trim()
    ,guildId: text(row.guild_id, 'guild_id')
    ,voiceChannelId: nullableText(row.voice_channel_id, 'voice_channel_id')
    ,privateOrderCategoryId: nullableConfigText(config.private_order_category_id)
    ,staffTaskChannelId: nullableConfigText(config.staff_task_channel_id)
    ,staffRoleIds: ['staff_l1_role_id','staff_l2_role_id','staff_l3_role_id','staff_l4_role_id'].map((key)=>nullableConfigText(config[key])).filter((value):value is string=>Boolean(value))
  };
}

function nullableConfigText(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }

function renderOrderPanel(projection: OrderPanelProjection): {
  content: string;
  embeds: never[];
  allowed_mentions: { parse: never[] };
  components: Array<{ type: 1; components: Array<{ type: 2; style: number; label: string; custom_id: string }> }>;
} {
  const participants = projection.playerDiscordUserId
    ? `客户：<@${projection.customerDiscordUserId}>\n陪玩：<@${projection.playerDiscordUserId}>`
    : `客户：<@${projection.customerDiscordUserId}>\n陪玩：待接单`;
  return {
    content: `**订单 ${projection.publicId}**\n状态：${projection.status}\n金额：${projection.currency} ${(projection.amountMinor / (projection.currency==='CAT'?10:100)).toFixed(projection.currency==='CAT'?1:2)}\n${participants}`,
    embeds: [],
    allowed_mentions: { parse: [] },
    components: [{ type: 1, components: panelActions(projection) }]
  };
}

function panelActions(projection: OrderPanelProjection): Array<{ type: 2; style: number; label: string; custom_id: string }> {
  const route = (action: string) => `bc:service:${action}:${projection.orderId}:v${projection.version}`;
  const support = { type: 2 as const, style: 2, label: '联系客服', custom_id: route('support') };
  if (projection.status === 'ACCEPTED') {
    return [{ type: 2, style: 1, label: '我已就绪', custom_id: route('ready') }, support];
  }
  if (projection.status === 'IN_SERVICE') {
    return [{ type: 2, style: 1, label: '申请完成', custom_id: route('request-completion') }, support];
  }
  if (projection.status === 'PENDING_CONFIRMATION') {
    return [{ type: 2, style: 1, label: '确认完成', custom_id: route('confirm') }, support];
  }
  return [support];
}

async function readMessage(response: Response, fallbackId: string): Promise<{ id: string }> {
  const value = await response.json() as { id?: unknown };
  return { id: typeof value.id === 'string' && value.id ? value.id : fallbackId };
}

async function discordFailure(response: Response): Promise<WorkerAdapterError> {
  const body = await response.clone().json().catch(() => ({})) as { retry_after?: unknown };
  const seconds = typeof body.retry_after === 'number' ? body.retry_after : Number(response.headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1_000) : null;
  return new WorkerAdapterError('DISCORD_ERROR', `Discord API request failed with status ${response.status}.`, retryAfterMs);
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

function invalidRow(field: string): WorkerAdapterError {
  return new WorkerAdapterError('INVALID_DATA', `Order panel projection field ${field} is invalid.`);
}
