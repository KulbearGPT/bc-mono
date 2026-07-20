import type { OutboxHandler } from "./worker-runtime.js";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { PostgresSelectionPoolStore } from "./selection-pools.js";
import type { AuditRecord } from "./security.js";

type SelectionSyncPhase = "COLLECTING" | "SELECTION" | "FINALIZED" | "CANCELLED";

export function createSelectionPoolCloseHandler(input: {
  close: (selectionPoolId: string, deadline: string) => Promise<unknown>;
}): OutboxHandler {
  return async (job) => {
    if (job.type !== "SELECTION_POOL_CLOSE")
      throw new Error("Expected a SELECTION_POOL_CLOSE job.");
    const payload = job.payload as {
      orderId?: unknown;
      selectionPoolId?: unknown;
    } | null;
    if (
      !payload ||
      typeof payload.orderId !== "string" ||
      typeof payload.selectionPoolId !== "string" ||
      payload.selectionPoolId !== job.aggregateId
    )
      throw new Error("Selection pool close payload is invalid.");
    await input.close(payload.selectionPoolId, job.runAfter);
  };
}

export function createSelectionPoolSyncHandler(input: {
  sync: (
    selectionPoolId: string,
    phase: SelectionSyncPhase,
    notBefore: string,
  ) => Promise<unknown>;
  onTerminalFailure?: (
    selectionPoolId: string,
    error: unknown,
    failedAt: string,
  ) => Promise<unknown>;
}): OutboxHandler {
  return async (job) => {
    if (job.type !== "SELECTION_POOL_SYNC")
      throw new Error("Expected a SELECTION_POOL_SYNC job.");
    const payload = job.payload as {
      orderId?: unknown;
      selectionPoolId?: unknown;
      phase?: unknown;
    } | null;
    if (
      !payload ||
      typeof payload.orderId !== "string" ||
      typeof payload.selectionPoolId !== "string" ||
      payload.selectionPoolId !== job.aggregateId ||
      (payload.phase !== "COLLECTING" &&
        payload.phase !== "SELECTION" &&
        payload.phase !== "FINALIZED" &&
        payload.phase !== "CANCELLED")
    )
      throw new Error("Selection pool sync payload is invalid.");
    try {
      await input.sync(payload.selectionPoolId, payload.phase, job.createdAt);
    } catch (error) {
      if (job.attempts >= job.maxAttempts)
        await input.onTerminalFailure?.(
          payload.selectionPoolId,
          error,
          new Date().toISOString(),
        );
      throw error;
    }
  };
}

interface SelectionWorkerProjection {
  poolId: string;
  poolVersion: number;
  poolStatus: string;
  orderId: string;
  orderPublicId: string;
  orderStatus: string;
  orderVersion: number;
  guildId: string;
  orderChannelId: string;
  voiceChannelId: string | null;
  customerUserId: string;
  customerDiscordUserId: string;
  dispatchChannelId: string;
  staffTaskChannelId: string;
  privateOrderCategoryId: string | null;
  staffRoleIds: string[];
  applicants: Array<{
    applicationId: string;
    discordUserId: string;
    displayName: string;
    status: string;
    applicationVersion: number;
    requirementId: string;
  }>;
  selectedPlayers: Array<{ discordUserId: string; displayName: string }>;
  selectedDiscordUserIds: string[];
  requirements: Array<{
    id: string;
    label: string;
    remainingSlots: number;
    expectedEarningMinor: number;
    currency: string;
  }>;
}

export class PostgresSelectionPoolWorkerStore {
  constructor(private readonly pool: Pool) {}
  async closeExpired(selectionPoolId: string, deadline: string) {
    const row = (
      await this.pool.query<{
        order_id: string;
        guild_id: string;
        discord_user_id: string;
        row_version: number;
        closes_at: Date | string;
      }>(
        `SELECT pool.order_id,orders.guild_id,account.discord_user_id,pool.row_version,pool.closes_at FROM selection_pools pool JOIN orders ON orders.id=pool.order_id JOIN discord_accounts account ON account.user_id=orders.customer_id AND account.guild_id=orders.guild_id WHERE pool.id=$1 AND pool.status='COLLECTING'`,
        [selectionPoolId],
      )
    ).rows[0];
    if (!row) return;
    if (
      new Date(row.closes_at).toISOString() !== new Date(deadline).toISOString()
    )
      return;
    const store = new PostgresSelectionPoolStore(this.pool);
    const staged = await store.closePool({
      orderId: row.order_id,
      selectionPoolId,
      actorGuildId: row.guild_id,
      actorDiscordUserId: row.discord_user_id,
      expectedPoolVersion: row.row_version,
      reason: "TIME_ELAPSED",
      idempotencyKey: `selection-pool-close:${selectionPoolId}:v${row.row_version}`,
      now: new Date(deadline),
    });
    await staged.commit(
      workerAudit(
        selectionPoolId,
        `selection-pool-close:${selectionPoolId}:v${row.row_version}`,
        new Date(deadline),
      ),
    );
  }
  async projection(
    selectionPoolId: string,
  ): Promise<SelectionWorkerProjection | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT pool.id pool_id,pool.row_version pool_version,pool.status::text pool_status,orders.id order_id,orders.public_id,orders.status::text order_status,orders.row_version order_version,orders.guild_id,orders.channel_id,orders.voice_channel_id,orders.customer_id,customer.discord_user_id customer_discord_user_id,config.config_json,ARRAY(SELECT jsonb_build_object('applicationId',application.id,'discordUserId',account.discord_user_id,'displayName',users.display_name,'status',application.status::text,'applicationVersion',application.row_version,'requirementId',application.order_requirement_id) FROM selection_applications application JOIN users ON users.id=application.player_user_id JOIN discord_accounts account ON account.user_id=users.id AND account.guild_id=orders.guild_id WHERE application.selection_pool_id=pool.id ORDER BY application.applied_at,application.id) applicants,ARRAY(SELECT jsonb_build_object('discordUserId',account.discord_user_id,'displayName',users.display_name) FROM order_participants participant JOIN users ON users.id=participant.player_id JOIN discord_accounts account ON account.user_id=participant.player_id AND account.guild_id=orders.guild_id WHERE participant.order_id=orders.id AND participant.status='ACTIVE' ORDER BY participant.created_at,participant.id) selected_players,ARRAY(SELECT account.discord_user_id FROM order_participants participant JOIN discord_accounts account ON account.user_id=participant.player_id AND account.guild_id=orders.guild_id WHERE participant.order_id=orders.id AND participant.status='ACTIVE' ORDER BY participant.created_at,participant.id) selected_ids,ARRAY(SELECT jsonb_build_object('id',requirement.id,'label',requirement.game_display_name_snapshot||' · '||requirement.service_display_name_snapshot,'remainingSlots',GREATEST(requirement.requested_player_count-(SELECT count(*) FROM order_participants participant WHERE participant.order_requirement_id=requirement.id AND participant.status='ACTIVE'),0),'expectedEarningMinor',FLOOR((requirement.customer_unit_price_minor_snapshot*requirement.unit_count)*version.default_player_payout_bps/10000),'currency',orders.currency) FROM order_requirements requirement JOIN service_catalog_versions version ON version.id=requirement.service_catalog_version_id WHERE requirement.order_id=orders.id AND requirement.status='ACTIVE' ORDER BY requirement.created_at,requirement.id) requirements FROM selection_pools pool JOIN orders ON orders.id=pool.order_id JOIN discord_accounts customer ON customer.user_id=orders.customer_id AND customer.guild_id=orders.guild_id LEFT JOIN guild_bot_configs config ON config.guild_id=orders.guild_id WHERE pool.id=$1`,
      [selectionPoolId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const config =
      row.config_json && typeof row.config_json === "object"
        ? (row.config_json as Record<string, unknown>)
        : {};
    return {
      poolId: text(row.pool_id),
      poolVersion: int(row.pool_version),
      poolStatus: text(row.pool_status),
      orderId: text(row.order_id),
      orderPublicId: text(row.public_id),
      orderStatus: text(row.order_status),
      orderVersion: int(row.order_version),
      guildId: text(row.guild_id),
      orderChannelId: text(row.channel_id),
      voiceChannelId: nullable(row.voice_channel_id),
      customerUserId: text(row.customer_id),
      customerDiscordUserId: text(row.customer_discord_user_id),
      dispatchChannelId: configText(
        config.dispatch_channel_id,
        "dispatch_channel_id",
      ),
      staffTaskChannelId: configText(
        config.staff_task_channel_id,
        "staff_task_channel_id",
      ),
      privateOrderCategoryId: nullable(config.private_order_category_id),
      staffRoleIds: [
        "staff_l1_role_id",
        "staff_l2_role_id",
        "staff_l3_role_id",
        "staff_l4_role_id",
      ]
        .map((key) => nullable(config[key]))
        .filter((id): id is string => Boolean(id)),
      applicants:
        (row.applicants as SelectionWorkerProjection["applicants"]) ?? [],
      selectedPlayers:
        (row.selected_players as SelectionWorkerProjection["selectedPlayers"]) ??
        [],
      selectedDiscordUserIds: (row.selected_ids as string[]) ?? [],
      requirements:
        (row.requirements as SelectionWorkerProjection["requirements"]) ?? [],
    };
  }
  async setVoice(orderId: string, voiceChannelId: string) {
    const updated = await this.pool.query(
      `UPDATE orders SET voice_channel_id=$2,updated_at=now() WHERE id=$1 AND (voice_channel_id IS NULL OR voice_channel_id=$2) RETURNING id`,
      [orderId, voiceChannelId],
    );
    if (!updated.rows[0])
      throw new Error("Order voice channel changed concurrently.");
  }
  async createFailureTask(
    selectionPoolId: string,
    error: unknown,
    failedAt: string,
  ) {
    const projection = await this.projection(selectionPoolId);
    if (!projection) return;
    const publicId = `ST-SEL-${createHash("sha256").update(selectionPoolId).digest("hex").slice(0, 16).toUpperCase()}`;
    await this.pool.query(
      `INSERT INTO staff_tasks(id,public_id,type,reason_code,status,row_version,order_id,voice_channel_id,context_snapshot,created_at,updated_at) VALUES(gen_random_uuid(),$1,'AUTOMATION_FAILURE','SELECTION_DISCORD_SYNC_FAILED','OPEN',1,$2,$3,$4::jsonb,$5,$5) ON CONFLICT(public_id) DO NOTHING`,
      [
        publicId,
        projection.orderId,
        projection.voiceChannelId,
        JSON.stringify({
          selectionPoolId,
          error: error instanceof Error ? error.message : String(error),
          phase: projection.poolStatus,
        }),
        failedAt,
      ],
    );
  }
}

export class DiscordSelectionPoolAdapter {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  constructor(input: {
    token: string;
    apiBaseUrl?: string;
    fetch?: typeof fetch;
  }) {
    this.base = (input.apiBaseUrl ?? "https://discord.com/api/v10").replace(
      /\/$/u,
      "",
    );
    this.fetcher = input.fetch ?? fetch;
    this.token = input.token;
  }
  private readonly token: string;
  async sync(
    projection: SelectionWorkerProjection,
    phase: SelectionSyncPhase,
    notBefore: string,
  ): Promise<string | null> {
    if (phase === "COLLECTING") {
      await this.sendOnce(
        projection.dispatchChannelId,
        `selection-offer:${projection.poolId}`,
        offerPayload(projection),
        notBefore,
      );
      return projection.voiceChannelId;
    }
    if (phase === "CANCELLED") {
      await this.upsertOnce(
        projection.dispatchChannelId,
        `selection-offer:${projection.poolId}`,
        cancelledOfferPayload(projection),
        notBefore,
      );
      await this.editIfPresent(
        projection.orderChannelId,
        `selection-customer:${projection.poolId}`,
        cancelledCustomerPayload(projection),
      );
      await this.editIfPresent(
        projection.staffTaskChannelId,
        `selection-staff:${projection.poolId}`,
        cancelledStaffPayload(projection),
      );
      if (!projection.voiceChannelId) return null;
      await this.request(`/channels/${projection.voiceChannelId}`, {
        method: "PATCH",
        body: JSON.stringify({
          user_limit: 0,
          permission_overwrites: overwrites(projection, phase),
        }),
      });
      for (const applicant of projection.applicants) {
        await this.request(
          `/channels/${projection.voiceChannelId}/permissions/${applicant.discordUserId}`,
          {
            method: "PUT",
            body: JSON.stringify({
              allow: "0",
              deny: String(VIEW_CHANNEL | CONNECT),
              type: 1,
            }),
          },
        );
        await this.request(
          `/guilds/${projection.guildId}/members/${applicant.discordUserId}`,
          { method: "PATCH", body: JSON.stringify({ channel_id: null }) },
          [404],
        );
      }
      return projection.voiceChannelId;
    }
    await this.upsertOnce(
      projection.dispatchChannelId,
      `selection-offer:${projection.poolId}`,
      closedOfferPayload(projection),
      notBefore,
    );
    let voice = projection.voiceChannelId;
    if (!voice) {
      const channels = await this.request<
        Array<{
          id: string;
          name: string;
          type: number;
          parent_id?: string | null;
        }>
      >(`/guilds/${projection.guildId}/channels`, { method: "GET" });
      const name = `selection-${projection.orderPublicId}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/gu, "-")
        .slice(0, 90);
      voice =
        channels.find(
          (channel) =>
            channel.type === 2 &&
            channel.name === name &&
            channel.parent_id === projection.privateOrderCategoryId,
        )?.id ?? null;
      if (!voice) {
        voice = text(
          (
            await this.request<{ id: string }>(
              `/guilds/${projection.guildId}/channels`,
              {
                method: "POST",
                body: JSON.stringify({
                  name,
                  type: 2,
                  parent_id: projection.privateOrderCategoryId ?? undefined,
                  user_limit: 0,
                  permission_overwrites: overwrites(projection, phase),
                }),
              },
            )
          ).id,
        );
      }
    }
    await this.request(`/channels/${voice}`, {
      method: "PATCH",
      body: JSON.stringify({
        user_limit: 0,
        permission_overwrites: overwrites(projection, phase),
      }),
    });
    const link = `https://discord.com/channels/${projection.guildId}/${voice}`;
    if (phase === "SELECTION") {
      await this.sendOnce(
        projection.orderChannelId,
        `selection-customer:${projection.poolId}`,
        candidatePayload(projection, link),
        notBefore,
      );
      await this.sendOnce(
        projection.staffTaskChannelId,
        `selection-staff:${projection.poolId}`,
        {
          content: `订单 ${projection.orderPublicId} 已开始陪玩选拔，客服可以加入语音频道 ${link}。客户：<@${projection.customerDiscordUserId}>；候选人数：${projection.applicants.filter((item) => item.status === "APPLIED").length}`,
          allowed_mentions: { parse: [] },
        },
        notBefore,
      );
    } else {
      const selected = new Set(projection.selectedDiscordUserIds);
      for (const applicant of projection.applicants) {
        if (selected.has(applicant.discordUserId)) continue;
        await this.request(
          `/channels/${voice}/permissions/${applicant.discordUserId}`,
          {
            method: "PUT",
            body: JSON.stringify({
              allow: "0",
              deny: String(VIEW_CHANNEL | CONNECT),
              type: 1,
            }),
          },
        );
        await this.request(
          `/guilds/${projection.guildId}/members/${applicant.discordUserId}`,
          { method: "PATCH", body: JSON.stringify({ channel_id: null }) },
          [404],
        );
        await this.direct(
          applicant.discordUserId,
          `订单 ${projection.orderPublicId} 本轮选拔已结束，你本轮未入选。入选陪玩：${projection.selectedPlayers.map((item) => item.displayName).join("、") || "无"}`,
          notBefore,
          projection.poolId,
        );
      }
      await this.editIfPresent(
        projection.orderChannelId,
        `selection-customer:${projection.poolId}`,
        finalizedCustomerPayload(projection),
      );
      await this.editIfPresent(
        projection.staffTaskChannelId,
        `selection-staff:${projection.poolId}`,
        finalizedStaffPayload(projection),
      );
    }
    return voice;
  }
  private async direct(
    userId: string,
    content: string,
    notBefore: string,
    poolId: string,
  ) {
    const dm = await this.request<{ id: string }>("/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: userId }),
    });
    await this.sendOnce(
      text(dm.id),
      `selection-result:${poolId}:${userId}`,
      { content, allowed_mentions: { parse: [] } },
      notBefore,
    );
  }
  private async sendOnce(
    channel: string,
    key: string,
    payload: Record<string, unknown>,
    notBefore: string,
  ) {
    const nonce = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const messages = await this.request<
      Array<{ nonce?: string; timestamp?: string }>
    >(`/channels/${channel}/messages?limit=100`, { method: "GET" });
    if (
      messages.some(
        (message) =>
          message.nonce === nonce &&
          Date.parse(message.timestamp ?? "") >= Date.parse(notBefore) - 300000,
      )
    )
      return;
    await this.request(`/channels/${channel}/messages`, {
      method: "POST",
      body: JSON.stringify({ ...payload, nonce, enforce_nonce: true }),
    });
  }
  private async upsertOnce(
    channel: string,
    key: string,
    payload: Record<string, unknown>,
    notBefore: string,
  ) {
    const nonce = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const messages = await this.request<
      Array<{ id?: string; nonce?: string }>
    >(`/channels/${channel}/messages?limit=100`, { method: "GET" });
    const message = messages.find(
      (candidate) => candidate.nonce === nonce && candidate.id,
    );
    if (!message?.id) {
      await this.sendOnce(channel, key, payload, notBefore);
      return;
    }
    await this.request(`/channels/${channel}/messages/${message.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }
  private async editIfPresent(
    channel: string,
    key: string,
    payload: Record<string, unknown>,
  ) {
    const nonce = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const messages = await this.request<
      Array<{ id?: string; nonce?: string }>
    >(`/channels/${channel}/messages?limit=100`, { method: "GET" });
    const message = messages.find(
      (candidate) => candidate.nonce === nonce && candidate.id,
    );
    if (!message?.id) return;
    await this.request(`/channels/${channel}/messages/${message.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }
  private async request<T = void>(
    path: string,
    init: RequestInit,
    acceptedStatuses: number[] = [],
  ): Promise<T> {
    const response = await this.fetcher(`${this.base}${path}`, {
      ...init,
      headers: {
        authorization: `Bot ${this.token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok && !acceptedStatuses.includes(response.status))
      throw new Error(`Discord selection sync failed (${response.status}).`);
    return response.status === 204 || acceptedStatuses.includes(response.status)
      ? (undefined as T)
      : (response.json() as Promise<T>);
  }
}

export class SelectionPoolWorkerService {
  constructor(
    private readonly store: PostgresSelectionPoolWorkerStore,
    private readonly discord: DiscordSelectionPoolAdapter,
  ) {}
  async sync(
    poolId: string,
    phase: SelectionSyncPhase,
    notBefore: string,
  ) {
    const projection = await this.store.projection(poolId);
    if (!projection)
      throw new Error("Selection pool projection was not found.");
    if (projection.poolStatus !== phase) return;
    const voice = await this.discord.sync(projection, phase, notBefore);
    if (voice && voice !== projection.voiceChannelId)
      await this.store.setVoice(projection.orderId, voice);
  }
}

const VIEW_CHANNEL = 1 << 10,
  CONNECT = 1 << 20,
  SPEAK = 1 << 21,
  MANAGE_CHANNELS = 1 << 4,
  MOVE_MEMBERS = 1 << 24;
function overwrites(p: SelectionWorkerProjection, phase: string) {
  const selected = new Set(p.selectedDiscordUserIds);
  const memberIds = [
    p.customerDiscordUserId,
    ...p.applicants
      .filter((item) =>
        phase === "SELECTION"
          ? item.status === "APPLIED"
          : selected.has(item.discordUserId),
      )
      .map((item) => item.discordUserId),
  ];
  return [
    {
      id: p.guildId,
      type: 0,
      allow: "0",
      deny: String(VIEW_CHANNEL | CONNECT),
    },
    ...[...new Set(memberIds)].map((id) => ({
      id,
      type: 1,
      allow: String(VIEW_CHANNEL | CONNECT | SPEAK),
      deny: "0",
    })),
    ...p.staffRoleIds.map((id) => ({
      id,
      type: 0,
      allow: String(
        VIEW_CHANNEL | CONNECT | SPEAK | MANAGE_CHANNELS | MOVE_MEMBERS,
      ),
      deny: "0",
    })),
  ];
}
function offerPayload(p: SelectionWorkerProjection) {
  const requirements = p.requirements
    .filter((item) => item.remainingSlots > 0)
    .slice(0, 25);
  return {
    embeds: [
      {
        title: `候选池 #${p.orderPublicId}`,
        description: "可同时报名多个订单；报名不会占用正式订单名额。",
        fields: requirements.map((item) => ({
          name: item.label,
          value: `缺 ${item.remainingSlots} 位 · 默认预计收益 ${item.expectedEarningMinor} ${item.currency}`,
        })),
      },
    ],
    components: requirements.length
      ? [
          {
            type: 1,
            components: [
              {
                type: 3,
                custom_id: `bc:sp:m:${short(p.orderId)}:${short(p.poolId)}:v${p.poolVersion}`,
                placeholder: "选择要报名的项目",
                min_values: 1,
                max_values: 1,
                options: requirements.map((item) => ({
                  label: item.label.slice(0, 100),
                  value: short(item.id),
                  description:
                    `缺 ${item.remainingSlots} 位 · 默认预计收益 ${item.expectedEarningMinor} ${item.currency}`.slice(
                      0,
                      100,
                    ),
                })),
              },
            ],
          },
        ]
      : [],
    allowed_mentions: { parse: [] },
  };
}
function closedOfferPayload(p: SelectionWorkerProjection) {
  const applicationCount = p.applicants.filter(
    (item) => item.status === "APPLIED",
  ).length;
  return {
    embeds: [
      {
        title: `候选池 #${p.orderPublicId} · 报名已结束`,
        description: `本轮报名已结束，共 ${applicationCount} 位候选。此卡片已停止接受报名。`,
      },
    ],
    components: [],
    allowed_mentions: { parse: [] },
  };
}
function cancelledOfferPayload(p: SelectionWorkerProjection) {
  return {
    embeds: [
      {
        title: `候选池 #${p.orderPublicId} · 订单已取消`,
        description: "订单已取消，本轮报名已经关闭，此卡片不再接受报名。",
      },
    ],
    components: [],
    allowed_mentions: { parse: [] },
  };
}
function cancelledCustomerPayload(p: SelectionWorkerProjection) {
  return {
    content: `<@${p.customerDiscordUserId}> 订单已取消，本轮陪玩选择已经关闭。`,
    components: [],
    allowed_mentions: { parse: [], users: [p.customerDiscordUserId] },
  };
}
function cancelledStaffPayload(p: SelectionWorkerProjection) {
  return {
    content: `订单已取消：${p.orderPublicId}。本轮陪玩选拔已关闭。`,
    components: [],
    allowed_mentions: { parse: [] },
  };
}
function finalizedCustomerPayload(p: SelectionWorkerProjection) {
  return {
    content: `<@${p.customerDiscordUserId}> 本轮选拔已完成。入选陪玩：${p.selectedPlayers.map((item) => item.displayName).join("、") || "无"}`,
    components: [],
    allowed_mentions: { parse: [], users: [p.customerDiscordUserId] },
  };
}
function finalizedStaffPayload(p: SelectionWorkerProjection) {
  return {
    content: `订单 ${p.orderPublicId} 选拔已完成。入选陪玩：${p.selectedPlayers.map((item) => item.displayName).join("、") || "无"}`,
    components: [],
    allowed_mentions: { parse: [] },
  };
}
function candidatePayload(p: SelectionWorkerProjection, voiceLink: string) {
  const all = p.applicants.filter((item) => item.status === "APPLIED");
  const applicants = all.slice(0, 25);
  const components = applicants.length
    ? [
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: `bc:sp:s:${short(p.orderId)}:${short(p.poolId)}:v${p.poolVersion}:o${p.orderVersion}`,
              placeholder: "选择并确认本轮入选陪玩",
              min_values: 1,
              max_values: applicants.length,
              options: applicants.map((item) => ({
                label: item.displayName.slice(0, 100),
                value: short(item.applicationId),
                description: "公开候选资料",
              })),
            },
          ],
        },
        ...(all.length > 25
          ? [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 2,
                    label: "下一页",
                    custom_id: `bc:sp:n:${short(p.orderId)}:${short(p.poolId)}:o${p.orderVersion}:${Buffer.from(JSON.stringify({ v: 1, offset: 25 })).toString("base64url")}`,
                  },
                ],
              },
            ]
          : []),
      ]
    : [
        ...selectionWaitRows(
          `bc:sp:r:${short(p.orderId)}:${short(p.poolId)}:o${p.orderVersion}`,
        ),
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 4,
              label: "取消订单",
              custom_id: `bc:order:${p.orderId}:cancel:v${p.orderVersion}`,
            },
          ],
        },
      ];
  return {
    content: `<@${p.customerDiscordUserId}> 报名已结束，共 ${all.length} 位候选。选秀语音：${voiceLink}`,
    components,
    allowed_mentions: { parse: [], users: [p.customerDiscordUserId] },
  };
}

function selectionWaitRows(customId: string) {
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: customId,
          placeholder: "选择等待时间",
          min_values: 1,
          max_values: 1,
          options: [1, 3, 5, 10, 15, 30].map((minutes) => ({
            label: `等待 ${minutes} 分钟`,
            value: String(minutes),
          })),
        },
      ],
    },
  ];
}
function workerAudit(orderId: string, key: string, now: Date): AuditRecord {
  return {
    id: randomUUID(),
    actorId: null,
    actorStaffId: null,
    actorLevel: null,
    actorSource: "SYSTEM_JOB",
    clientId: "SELECTION_POOL_WORKER",
    interactionId: null,
    permissionCode: "order.selection_pool.close",
    action: "CLOSE_EXPIRED_SELECTION_POOL",
    targetType: "selection_pool",
    targetId: orderId,
    outcome: "SUCCEEDED",
    reason: "TIME_ELAPSED",
    requestId: `job_${key}`,
    idempotencyKey: key,
    approvalRequestId: null,
    jobId: null,
    triggerSource: "OUTBOX",
    retryAttempt: 0,
    occurredAt: now.toISOString(),
  };
}
function short(uuid: string) {
  return Buffer.from(uuid.replaceAll("-", ""), "hex").toString("base64url");
}
function text(value: unknown) {
  if (typeof value !== "string" || !value)
    throw new Error("Selection projection text is invalid.");
  return value;
}
function nullable(value: unknown) {
  return typeof value === "string" && value ? value : null;
}
function int(value: unknown) {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error("Selection projection integer is invalid.");
  return number;
}
function configText(value: unknown, name: string) {
  const result = nullable(value);
  if (!result) throw new Error(`${name} is not configured.`);
  return result;
}
