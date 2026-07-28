import type { OutboxHandler } from "./worker-runtime.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import type { SelectionReactionBinding } from "./selection-pools.js";

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
    // Deadline-driven recruitment was retired by M11-US-05. Keep the handler
    // registered only so legacy outbox rows can be consumed without retrying or
    // changing the current business state.
    void input;
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
  recruitmentChannelId: string | null;
  recruitmentMessageId: string | null;
  reactionBindings: SelectionReactionBinding[];
  orderId: string;
  orderPublicId: string;
  orderStatus: string;
  orderVersion: number;
  guildId: string;
  orderChannelId: string;
  selectionVoiceChannelId: string | null;
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
    customerNote?: string | null;
  }>;
}

interface DiscordRecruitmentMessage {
  id?: string;
  nonce?: string;
  embeds?: Array<{
    title?: string;
    footer?: { text?: string };
  }>;
  components?: Array<{
    components?: Array<{ custom_id?: string }>;
  }>;
}

export class PostgresSelectionPoolWorkerStore {
  constructor(private readonly pool: Pool) {}
  async enqueueRecruitmentCardNormalization(now: Date) {
    const queued = await this.pool.query(
      `INSERT INTO outbox_events(
         id,event_type,aggregate_type,aggregate_id,order_id,selection_pool_id,
         dedupe_key,payload,status,row_version,attempt_count,max_attempts,
         available_at,created_at,updated_at
       )
       SELECT gen_random_uuid(),'SELECTION_POOL_SYNC','selection_pool',pool.id,pool.order_id,pool.id,
         'selection-reaction-card-normalize-v2:'||pool.id,
         jsonb_build_object('orderId',pool.order_id,'selectionPoolId',pool.id,'phase','COLLECTING'),
         'PENDING',1,0,8,$1,$1,$1
       FROM selection_pools pool
       WHERE pool.status='COLLECTING'
       ON CONFLICT(dedupe_key) DO NOTHING
       RETURNING id`,
      [now],
    );
    return queued.rowCount ?? 0;
  }
  async closeExpired(selectionPoolId: string, deadline: string) {
    void selectionPoolId;
    void deadline;
  }
  async projection(
    selectionPoolId: string,
  ): Promise<SelectionWorkerProjection | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT pool.id pool_id,pool.row_version pool_version,pool.status::text pool_status,pool.recruitment_channel_id,pool.recruitment_message_id,pool.reaction_bindings,orders.id order_id,orders.public_id,orders.status::text order_status,orders.row_version order_version,orders.guild_id,orders.channel_id,orders.selection_voice_channel_id,orders.voice_channel_id,orders.customer_id,customer.discord_user_id customer_discord_user_id,config.config_json,ARRAY(SELECT jsonb_build_object('applicationId',application.id,'discordUserId',account.discord_user_id,'displayName',users.display_name,'status',application.status::text,'applicationVersion',application.row_version,'requirementId',application.order_requirement_id) FROM selection_applications application JOIN users ON users.id=application.player_user_id JOIN discord_accounts account ON account.user_id=users.id AND account.guild_id=orders.guild_id WHERE application.selection_pool_id=pool.id ORDER BY application.applied_at,application.id) applicants,ARRAY(SELECT jsonb_build_object('discordUserId',account.discord_user_id,'displayName',users.display_name) FROM order_participants participant JOIN users ON users.id=participant.player_id JOIN discord_accounts account ON account.user_id=participant.player_id AND account.guild_id=orders.guild_id WHERE participant.order_id=orders.id AND participant.status='ACTIVE' ORDER BY participant.created_at,participant.id) selected_players,ARRAY(SELECT account.discord_user_id FROM order_participants participant JOIN discord_accounts account ON account.user_id=participant.player_id AND account.guild_id=orders.guild_id WHERE participant.order_id=orders.id AND participant.status='ACTIVE' ORDER BY participant.created_at,participant.id) selected_ids,ARRAY(SELECT jsonb_build_object('id',requirement.id,'label',requirement.game_display_name_snapshot||' · '||requirement.service_display_name_snapshot,'remainingSlots',GREATEST(requirement.requested_player_count-(SELECT count(*) FROM order_participants participant WHERE participant.order_requirement_id=requirement.id AND participant.status='ACTIVE'),0),'expectedEarningMinor',FLOOR((requirement.customer_unit_price_minor_snapshot*requirement.unit_count)*version.default_player_payout_bps/10000),'currency',orders.currency,'customerNote',requirement.customer_note) FROM order_requirements requirement JOIN service_catalog_versions version ON version.id=requirement.service_catalog_version_id WHERE requirement.order_id=orders.id AND requirement.status='ACTIVE' ORDER BY requirement.created_at,requirement.id) requirements FROM selection_pools pool JOIN orders ON orders.id=pool.order_id JOIN discord_accounts customer ON customer.user_id=orders.customer_id AND customer.guild_id=orders.guild_id LEFT JOIN guild_bot_configs config ON config.guild_id=orders.guild_id WHERE pool.id=$1`,
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
      recruitmentChannelId: nullable(row.recruitment_channel_id),
      recruitmentMessageId: nullable(row.recruitment_message_id),
      reactionBindings: Array.isArray(row.reaction_bindings)
        ? (row.reaction_bindings as SelectionReactionBinding[])
        : [],
      orderId: text(row.order_id),
      orderPublicId: text(row.public_id),
      orderStatus: text(row.order_status),
      orderVersion: int(row.order_version),
      guildId: text(row.guild_id),
      orderChannelId: text(row.channel_id),
      selectionVoiceChannelId: nullable(row.selection_voice_channel_id),
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
  async setSelectionVoice(
    orderId: string,
    voiceChannelId: string,
    expectedPreviousChannelId: string | null,
  ) {
    const updated = await this.pool.query(
      `UPDATE orders SET selection_voice_channel_id=$2,updated_at=now() WHERE id=$1 AND (selection_voice_channel_id IS NOT DISTINCT FROM $3 OR selection_voice_channel_id=$2) RETURNING id`,
      [orderId, voiceChannelId, expectedPreviousChannelId],
    );
    if (!updated.rows[0])
      throw new Error("Order selection voice channel changed concurrently.");
  }
  async setServiceVoice(orderId: string, voiceChannelId: string) {
    const updated = await this.pool.query(
      `UPDATE orders SET voice_channel_id=$2,updated_at=now() WHERE id=$1 AND (voice_channel_id IS NULL OR voice_channel_id=$2) RETURNING id`,
      [orderId, voiceChannelId],
    );
    if (!updated.rows[0])
      throw new Error("Order service voice channel changed concurrently.");
  }
  async setRecruitmentCard(
    poolId: string,
    channelId: string,
    messageId: string,
    bindings: SelectionReactionBinding[],
  ) {
    const updated = await this.pool.query(
      `UPDATE selection_pools
       SET recruitment_channel_id=$2,recruitment_message_id=$3,reaction_bindings=$4::jsonb,updated_at=now()
       WHERE id=$1 AND status='COLLECTING'
         AND (recruitment_message_id IS NULL OR
              (recruitment_channel_id=$2 AND recruitment_message_id=$3 AND reaction_bindings=$4::jsonb))
       RETURNING id`,
      [poolId, channelId, messageId, JSON.stringify(bindings)],
    );
    if (!updated.rows[0])
      throw new Error("Selection recruitment card changed concurrently.");
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
        projection.voiceChannelId ?? projection.selectionVoiceChannelId,
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
      await this.syncRecruitmentCard(projection);
      return projection.selectionVoiceChannelId;
    }
    if (phase === "CANCELLED") {
      await this.updateRecruitmentCard(projection, cancelledOfferPayload(projection), notBefore);
      await this.sendStatusImageOnce(
        projection.dispatchChannelId,
        `selection-cancelled:${projection.orderId}`,
        ORDER_CANCELLED_BANNER,
        "blackcat-order-cancelled.png",
        "本单流单",
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
      const selectionVoice =
        projection.selectionVoiceChannelId ?? projection.voiceChannelId;
      if (!selectionVoice) return null;
      for (const applicant of projection.applicants) {
        await this.request(
          `/channels/${selectionVoice}/permissions/${applicant.discordUserId}`,
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
          [400, 404],
        );
      }
      await this.request(`/channels/${selectionVoice}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: `${channelName("selection", projection.orderPublicId)}-closing`.slice(
            0,
            100,
          ),
          user_limit: 0,
          permission_overwrites: closingOverwrites(projection),
        }),
      });
      return selectionVoice;
    }
    await this.updateRecruitmentCard(projection, closedOfferPayload(projection), notBefore);
    const channels = (await this.request<
      Array<{
        id: string;
        name: string;
        type: number;
        parent_id?: string | null;
      }>
    >(`/guilds/${projection.guildId}/channels`, { method: "GET" })) ?? [];
    const selectionName = channelName("selection", projection.orderPublicId);
    const closingSelectionName = `${selectionName}-closing`.slice(0, 100);
    const activeSelectionVoice = channels.find(
      (channel) =>
        channel.type === 2 &&
        channel.name === selectionName &&
        channel.parent_id === projection.privateOrderCategoryId,
    )?.id;
    const projectedSelectionVoice = channels.find(
      (channel) =>
        channel.type === 2 &&
        channel.id === projection.selectionVoiceChannelId &&
        channel.parent_id === projection.privateOrderCategoryId,
    )?.id;
    let selectionVoice =
      phase === "SELECTION"
        ? (activeSelectionVoice ?? null)
        : (projectedSelectionVoice ??
          channels.find(
            (channel) =>
              channel.type === 2 &&
              (channel.name === selectionName ||
                channel.name === closingSelectionName) &&
              channel.parent_id === projection.privateOrderCategoryId,
          )?.id ??
          null);
    if (phase === "SELECTION") {
      if (!selectionVoice) {
        selectionVoice = text(
          (
            await this.request<{ id: string }>(
              `/guilds/${projection.guildId}/channels`,
              {
                method: "POST",
                body: JSON.stringify({
                  name: selectionName,
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
      await this.request(`/channels/${selectionVoice}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: selectionName,
          user_limit: 0,
          permission_overwrites: overwrites(projection, phase),
        }),
      });
      const link = `https://discord.com/channels/${projection.guildId}/${selectionVoice}`;
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
          content: `订单 ${projection.orderPublicId} 已进入试音匹配，客服可以加入试音房 ${link}。客户：<@${projection.customerDiscordUserId}>；报名人数：${projection.applicants.filter((item) => item.status === "APPLIED").length}`,
          allowed_mentions: { parse: [] },
        },
        notBefore,
      );
      return selectionVoice;
    }
    if (projection.orderStatus !== "ACCEPTED") {
      await this.removeRejected(projection, selectionVoice, notBefore);
      await this.editIfPresent(
        projection.orderChannelId,
        `selection-customer:${projection.poolId}`,
        partialFinalizedCustomerPayload(projection),
      );
      await this.editIfPresent(
        projection.staffTaskChannelId,
        `selection-staff:${projection.poolId}`,
        partialFinalizedStaffPayload(projection),
      );
      return selectionVoice;
    }
    const serviceName = channelName("service", projection.orderPublicId);
    let serviceVoice =
      channels.find(
        (channel) =>
          channel.type === 2 &&
          channel.name === serviceName &&
          channel.parent_id === projection.privateOrderCategoryId,
      )?.id ??
      (projection.voiceChannelId !== selectionVoice
        ? projection.voiceChannelId
        : null);
    if (!serviceVoice) {
      serviceVoice = text(
        (
          await this.request<{ id: string }>(
            `/guilds/${projection.guildId}/channels`,
            {
              method: "POST",
              body: JSON.stringify({
                name: serviceName,
                type: 2,
                parent_id: projection.privateOrderCategoryId ?? undefined,
                user_limit: Math.min(
                  99,
                  projection.selectedDiscordUserIds.length + 1,
                ),
                permission_overwrites: serviceOverwrites(projection, false),
              }),
            },
          )
        ).id,
      );
    }
    const serviceLink = `https://discord.com/channels/${projection.guildId}/${serviceVoice}`;
    await this.editIfPresent(
      projection.orderChannelId,
      `selection-customer:${projection.poolId}`,
      finalizedCustomerPayload(projection, serviceLink),
    );
    await this.removeRejected(projection, selectionVoice, notBefore);
    if (selectionVoice) {
      await this.request(`/channels/${selectionVoice}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: closingSelectionName,
          user_limit: 0,
          permission_overwrites: closingOverwrites(projection),
        }),
      });
    }
    await this.moveMember(
      projection.guildId,
      projection.customerDiscordUserId,
      serviceVoice,
    );
    await this.request(`/channels/${serviceVoice}`, {
      method: "PATCH",
      body: JSON.stringify({
        user_limit: Math.min(99, projection.selectedDiscordUserIds.length + 1),
        permission_overwrites: serviceOverwrites(projection, true),
      }),
    });
    for (const selectedId of projection.selectedDiscordUserIds) {
      await this.moveMember(projection.guildId, selectedId, serviceVoice);
    }
    const selectionLink = selectionVoice
      ? `https://discord.com/channels/${projection.guildId}/${selectionVoice}`
      : null;
    await this.editIfPresent(
      projection.staffTaskChannelId,
      `selection-staff:${projection.poolId}`,
      finalizedStaffPayload(projection, selectionLink, serviceLink),
    );
    return serviceVoice;
  }
  async syncRecruitmentCard(projection: SelectionWorkerProjection): Promise<{
    channelId: string;
    messageId: string;
    bindings: SelectionReactionBinding[];
  }> {
    const bindings = projection.reactionBindings?.length
      ? validateSelectionReactionBindings(projection.reactionBindings)
      : buildSelectionReactionBindings(projection.requirements);
    const payload = buildSelectionReactionOfferPayload({
      poolId: projection.poolId,
      orderPublicId: projection.orderPublicId,
      requirements: projection.requirements,
      bindings,
    });
    const banner = resolveSelectionGameBanner(projection.requirements.map((item) => item.label));
    const messages = await this.request<DiscordRecruitmentMessage[]>(
      `/channels/${projection.dispatchChannelId}/messages?limit=100`,
      { method: "GET" },
    );
    const matchingMessages = messages.filter((message) =>
      isRecruitmentMessageForPool(message, projection),
    );
    if (!projection.recruitmentMessageId && matchingMessages.length === 0) {
      await this.sendStatusImageOnce(
        projection.dispatchChannelId,
        `selection-dispatching:${projection.orderId}`,
        DISPATCHING_BANNER,
        "blackcat-dispatching.png",
        "正在派单",
        messages,
      );
    }
    let messageId = projection.recruitmentMessageId ??
      oldestDiscordMessageId(matchingMessages) ?? null;
    if (!messageId) {
      const nonce = createHash("sha256")
        .update(`selection-offer:${projection.poolId}`)
        .digest("hex")
        .slice(0, 24);
      const sent = await this.sendRecruitmentCard<{ id: string }>(
        `/channels/${projection.dispatchChannelId}/messages`,
        "POST",
        payload,
        banner,
        { nonce, enforce_nonce: true },
      );
      messageId = text(sent.id);
    } else {
      await this.sendRecruitmentCard(
        `/channels/${projection.dispatchChannelId}/messages/${messageId}`,
        "PATCH",
        payload,
        banner,
      );
    }
    for (const duplicate of matchingMessages) {
      if (!duplicate.id || duplicate.id === messageId) continue;
      await this.request(
        `/channels/${projection.dispatchChannelId}/messages/${duplicate.id}`,
        {
          method: "PATCH",
          body: JSON.stringify(supersededRecruitmentPayload(projection)),
        },
      );
      await this.request(
        `/channels/${projection.dispatchChannelId}/messages/${duplicate.id}/reactions`,
        { method: "DELETE" },
        [404],
      );
    }
    for (const binding of bindings)
      await this.request(
        `/channels/${projection.dispatchChannelId}/messages/${messageId}/reactions/${encodeURIComponent(binding.emoji)}/@me`,
        { method: "PUT" },
      );
    return { channelId: projection.dispatchChannelId, messageId, bindings };
  }
  private async moveMember(guildId: string, userId: string, channelId: string) {
    await this.request(
      `/guilds/${guildId}/members/${userId}`,
      { method: "PATCH", body: JSON.stringify({ channel_id: channelId }) },
      [400, 404],
    );
  }
  private async updateRecruitmentCard(
    projection: SelectionWorkerProjection,
    payload: Record<string, unknown>,
    notBefore: string,
  ) {
    if (!projection.recruitmentMessageId) {
      await this.upsertOnce(
        projection.dispatchChannelId,
        `selection-offer:${projection.poolId}`,
        payload,
        notBefore,
      );
      return;
    }
    await this.request(
      `/channels/${projection.dispatchChannelId}/messages/${projection.recruitmentMessageId}`,
      { method: "PATCH", body: JSON.stringify(payload) },
    );
    await this.request(
      `/channels/${projection.dispatchChannelId}/messages/${projection.recruitmentMessageId}/reactions`,
      { method: "DELETE" },
      [404],
    );
  }
  private async removeRejected(
    projection: SelectionWorkerProjection,
    selectionVoice: string | null,
    notBefore: string,
  ) {
    const selected = new Set(projection.selectedDiscordUserIds);
    for (const applicant of projection.applicants) {
      if (selected.has(applicant.discordUserId)) continue;
      if (selectionVoice) {
        await this.request(
          `/channels/${selectionVoice}/permissions/${applicant.discordUserId}`,
          {
            method: "PUT",
            body: JSON.stringify({
              allow: "0",
              deny: String(VIEW_CHANNEL | CONNECT),
              type: 1,
            }),
          },
        );
      }
      await this.request(
        `/guilds/${projection.guildId}/members/${applicant.discordUserId}`,
        { method: "PATCH", body: JSON.stringify({ channel_id: null }) },
        [400, 404],
      );
      await this.direct(
        applicant.discordUserId,
        `订单 ${projection.orderPublicId} 本轮试音匹配已结束，你本轮暂未匹配成功。已确认陪玩：${projection.selectedPlayers.map((item) => item.displayName).join("、") || "无"}`,
        notBefore,
        projection.poolId,
      );
    }
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
  private async sendStatusImageOnce(
    channel: string,
    key: string,
    asset: URL,
    filename: string,
    description: string,
    knownMessages?: Array<{ nonce?: string }>,
  ) {
    const nonce = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const messages = knownMessages ?? await this.request<Array<{ nonce?: string }>>(
      `/channels/${channel}/messages?limit=100`,
      { method: "GET" },
    );
    if (messages.some((message) => message.nonce === nonce)) return;
    const form = new FormData();
    form.append("payload_json", JSON.stringify({
      nonce,
      enforce_nonce: true,
      attachments: [{ id: 0, filename, description }],
      allowed_mentions: { parse: [] },
    }));
    form.append(
      "files[0]",
      new Blob([await readFile(asset)], { type: "image/png" }),
      filename,
    );
    await this.request(`/channels/${channel}/messages`, {
      method: "POST",
      body: form,
    });
  }
  private async sendRecruitmentCard<T = void>(
    path: string,
    method: "POST" | "PATCH",
    payload: Record<string, unknown>,
    banner: SelectionGameBanner,
    delivery: Record<string, unknown> = {},
  ): Promise<T> {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({
      ...payload,
      ...delivery,
      attachments: [{ id: 0, filename: banner.attachmentName, description: banner.description }],
    }));
    form.append(
      "files[0]",
      new Blob([await readFile(banner.asset)], { type: "image/png" }),
      banner.attachmentName,
    );
    return this.request<T>(path, { method, body: form });
  }
  private async request<T = void>(
    path: string,
    init: RequestInit,
    acceptedStatuses: number[] = [],
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bot ${this.token}`);
    if (!(init.body instanceof FormData))
      headers.set("content-type", "application/json");
    const response = await this.fetcher(`${this.base}${path}`, {
      ...init,
      headers,
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
    if (phase === "COLLECTING") {
      const delivery = await this.discord.syncRecruitmentCard(projection);
      await this.store.setRecruitmentCard(
        poolId,
        delivery.channelId,
        delivery.messageId,
        delivery.bindings,
      );
      return;
    }
    const voice = await this.discord.sync(projection, phase, notBefore);
    if (
      phase === "SELECTION" &&
      voice &&
      voice !== projection.selectionVoiceChannelId
    )
      await this.store.setSelectionVoice(
        projection.orderId,
        voice,
        projection.selectionVoiceChannelId,
      );
    if (
      phase === "FINALIZED" &&
      projection.orderStatus === "ACCEPTED" &&
      voice &&
      voice !== projection.voiceChannelId
    )
      await this.store.setServiceVoice(projection.orderId, voice);
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
    ...(phase === "SELECTION" ? p.selectedDiscordUserIds : []),
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
function serviceOverwrites(p: SelectionWorkerProjection, open: boolean) {
  const participantAllow = String(VIEW_CHANNEL | (open ? CONNECT | SPEAK : 0));
  const participantDeny = open ? "0" : String(CONNECT);
  const staffAllow = String(
    VIEW_CHANNEL | MANAGE_CHANNELS | MOVE_MEMBERS | (open ? CONNECT | SPEAK : 0),
  );
  const staffDeny = open ? "0" : String(CONNECT);
  return [
    {
      id: p.guildId,
      type: 0,
      allow: "0",
      deny: String(VIEW_CHANNEL | CONNECT),
    },
    {
      id: p.customerDiscordUserId,
      type: 1,
      allow: String(VIEW_CHANNEL | CONNECT | SPEAK),
      deny: "0",
    },
    ...p.selectedDiscordUserIds.map((id) => ({
      id,
      type: 1,
      allow: participantAllow,
      deny: participantDeny,
    })),
    ...p.staffRoleIds.map((id) => ({
      id,
      type: 0,
      allow: staffAllow,
      deny: staffDeny,
    })),
  ];
}
function closingOverwrites(p: SelectionWorkerProjection) {
  return [
    {
      id: p.guildId,
      type: 0,
      allow: "0",
      deny: String(VIEW_CHANNEL | CONNECT),
    },
    ...[
      p.customerDiscordUserId,
      ...p.applicants.map((item) => item.discordUserId),
    ].map((id) => ({
      id,
      type: 1,
      allow: String(VIEW_CHANNEL),
      deny: String(CONNECT),
    })),
    ...p.staffRoleIds.map((id) => ({
      id,
      type: 0,
      allow: String(VIEW_CHANNEL | MANAGE_CHANNELS | MOVE_MEMBERS),
      deny: String(CONNECT),
    })),
  ];
}
function channelName(prefix: "selection" | "service", publicId: string) {
  return `${prefix}-${publicId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, "-")
    .slice(0, 90);
}
const SELECTION_REACTION_EMOJIS = [
  "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣",
] as const;
const DISPATCHING_BANNER = new URL(
  "../assets/dispatch/dispatching.png",
  import.meta.url,
);
const ORDER_CANCELLED_BANNER = new URL(
  "../assets/dispatch/order-cancelled.png",
  import.meta.url,
);

interface SelectionGameBanner {
  fileName: string;
  attachmentName: string;
  asset: URL;
  description: string;
}
const GAME_BANNER_RULES = [
  { fileName: "league-of-legends.webp", aliases: /英雄联盟|league of legends|\blol(?:na)?\b/iu },
  { fileName: "valorant.webp", aliases: /无畏契约|瓦洛兰特|valorant/iu },
  { fileName: "delta-force.webp", aliases: /三角洲|delta force|\bdelta\b/iu },
  { fileName: "apex-legends.webp", aliases: /apex/iu },
  { fileName: "pubg.webp", aliases: /绝地求生|pubg/iu },
  { fileName: "cs2-csgo.webp", aliases: /cs2|csgo|counter.?strike/iu },
  { fileName: "overwatch.webp", aliases: /守望先锋|overwatch/iu },
  { fileName: "naraka-bladepoint.webp", aliases: /永劫无间|naraka/iu },
  { fileName: "dota2.webp", aliases: /dota\s*2?/iu },
  { fileName: "tft.webp", aliases: /金铲铲|云顶|teamfight|\btft\b/iu },
  { fileName: "chat-minigames.webp", aliases: /聊天|小游戏|chat|minigame/iu },
  { fileName: "singing-voice.webp", aliases: /唱歌|声优|singing|voice/iu },
] as const;

export function resolveSelectionGameBanner(labels: string[]): SelectionGameBanner {
  const matches = new Set(
    labels.map((label) => GAME_BANNER_RULES.find((rule) => rule.aliases.test(label))?.fileName ?? "other.webp"),
  );
  const fileName = matches.size === 1 ? [...matches][0]! : "other.webp";
  return {
    fileName,
    attachmentName: `blackcat-game-${fileName}`,
    asset: new URL(`../assets/game-banners/${fileName}`, import.meta.url),
    description: "黑猫陪玩游戏主题横幅",
  };
}

export function buildSelectionReactionBindings(
  requirements: Array<{ id: string; label: string; remainingSlots: number }>,
): SelectionReactionBinding[] {
  const remaining = requirements.filter((item) => item.remainingSlots > 0);
  if (remaining.length < 1 || remaining.length > SELECTION_REACTION_EMOJIS.length)
    throw new Error("Selection recruitment requires 1 to at most 9 requirements.");
  return remaining.map((item, index) => ({
    emoji: SELECTION_REACTION_EMOJIS[index]!,
    orderRequirementId: item.id,
    label: item.label,
  }));
}

export function buildSelectionReactionOfferPayload(input: {
  poolId: string;
  orderPublicId: string;
  requirements: Array<{
    id: string;
    label: string;
    remainingSlots: number;
    expectedEarningMinor: number;
    currency: string;
    customerNote?: string | null;
  }>;
  bindings?: SelectionReactionBinding[];
}) {
  const bindings = input.bindings
    ? validateSelectionReactionBindings(input.bindings)
    : buildSelectionReactionBindings(input.requirements);
  const requirements = bindings.map((binding) => {
    const requirement = input.requirements.find((item) => item.id === binding.orderRequirementId);
    if (!requirement)
      throw new Error("Persisted selection reaction requirement is unavailable.");
    return requirement;
  });
  const banner = resolveSelectionGameBanner(requirements.map((item) => item.label));
  return {
    embeds: [
      {
        title: `🐾 新单报名 #${input.orderPublicId}`,
        color: 0x6d5dfc,
        description: [
          "黑猫来新委托啦～合适就留个爪印。",
          "🟢 添加对应数字 = 报名",
          "⚪ 移除对应数字 = 取消报名",
          "可同时报名多个项目或订单；报名不占用正式订单名额。",
        ].join("\n"),
        fields: requirements.map((item, index) => ({
          name: `${bindings[index]!.emoji} ${item.label}`,
          value: [
            `缺 ${item.remainingSlots} 位`,
            `需求：${item.customerNote?.trim() || "老板暂未留言"}`,
          ].join("\n"),
        })),
        image: { url: `attachment://${banner.attachmentName}` },
        footer: { text: `selection-pool:${input.poolId}` },
      },
    ],
    components: [],
    allowed_mentions: { parse: [] },
  };
}

function isRecruitmentMessageForPool(
  message: DiscordRecruitmentMessage,
  projection: SelectionWorkerProjection,
) {
  const marker = `selection-pool:${projection.poolId}`;
  if (message.embeds?.some((embed) => embed.footer?.text === marker)) return true;
  const legacyPrefix = `bc:sp:m:${short(projection.orderId)}:${short(projection.poolId)}:`;
  return message.components?.some((row) =>
    row.components?.some((component) =>
      component.custom_id?.startsWith(legacyPrefix),
    ),
  ) ?? false;
}

function oldestDiscordMessageId(messages: DiscordRecruitmentMessage[]) {
  return messages
    .map((message) => message.id)
    .filter((id): id is string => Boolean(id))
    .sort((left, right) => {
      try {
        const first = BigInt(left);
        const second = BigInt(right);
        return first < second ? -1 : first > second ? 1 : 0;
      } catch {
        return left.localeCompare(right);
      }
    })[0];
}

function supersededRecruitmentPayload(projection: SelectionWorkerProjection) {
  return {
    embeds: [{
      title: `新单报名 #${projection.orderPublicId}（旧报名卡）`,
      description: "此重复报名卡已停用，请使用本频道最新的数字 Reaction 报名卡。",
      footer: { text: `selection-pool-superseded:${projection.poolId}` },
    }],
    components: [],
    allowed_mentions: { parse: [] },
  };
}
function validateSelectionReactionBindings(bindings: SelectionReactionBinding[]) {
  if (
    bindings.length < 1 ||
    bindings.length > SELECTION_REACTION_EMOJIS.length ||
    bindings.some((binding, index) => binding.emoji !== SELECTION_REACTION_EMOJIS[index])
  )
    throw new Error("Persisted selection reaction mapping is invalid.");
  return bindings;
}
function closedOfferPayload(p: SelectionWorkerProjection) {
  const applicationCount = p.applicants.filter(
    (item) => item.status === "APPLIED",
  ).length;
  return {
    embeds: [
      {
        title: `🎧 试音匹配 #${p.orderPublicId} · 报名已结束`,
        description: `本轮报名已结束，共 ${applicationCount} 位陪玩报名。此卡片已停止接受 Reaction。`,
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
        title: `🌧️ 新单报名 #${p.orderPublicId} · 订单已取消`,
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
    content: `订单已取消：${p.orderPublicId}。本轮报名与试音匹配已关闭。`,
    components: [],
    allowed_mentions: { parse: [] },
  };
}
function finalizedCustomerPayload(
  p: SelectionWorkerProjection,
  serviceLink: string,
) {
  return {
    content: `<@${p.customerDiscordUserId}> 本轮试音匹配已完成。已确认陪玩：${p.selectedPlayers.map((item) => item.displayName).join("、") || "无"}\n正式服务语音房已经准备好，系统会先将您移入，再邀请已确认陪玩加入。`,
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: "进入服务房间", url: serviceLink },
        ],
      },
    ],
    allowed_mentions: { parse: [], users: [p.customerDiscordUserId] },
  };
}
function partialFinalizedCustomerPayload(p: SelectionWorkerProjection) {
  return {
    content: `<@${p.customerDiscordUserId}> 本轮试音匹配已完成。已确认陪玩：${p.selectedPlayers.map((item) => item.displayName).join("、") || "无"}。订单仍有空缺，可继续开启下一轮报名。`,
    components: [],
    allowed_mentions: { parse: [], users: [p.customerDiscordUserId] },
  };
}
function partialFinalizedStaffPayload(p: SelectionWorkerProjection) {
  return {
    content: `订单 ${p.orderPublicId} 本轮试音匹配已完成但仍有空缺。已确认陪玩：${p.selectedPlayers.map((item) => item.displayName).join("、") || "无"}`,
    components: [],
    allowed_mentions: { parse: [] },
  };
}
function finalizedStaffPayload(
  p: SelectionWorkerProjection,
  selectionLink: string | null,
  serviceLink: string,
) {
  const links = [
    selectionLink
      ? { type: 2, style: 5, label: "进入协调语音房", url: selectionLink }
      : null,
    { type: 2, style: 5, label: "进入服务房间", url: serviceLink },
  ].filter(Boolean);
  return {
    content: `订单 ${p.orderPublicId} 试音匹配已完成。已确认陪玩：${p.selectedPlayers.map((item) => item.displayName).join("、") || "无"}`,
    components: [{ type: 1, components: links }],
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
                description: "公开陪玩资料",
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
        selectionStartRow(
          `bc:sp:r:${short(p.orderId)}:${short(p.poolId)}:v${p.poolVersion}:o${p.orderVersion}`,
          "本轮暂无合适陪玩，重新招募",
        ),
      ]
    : [
        selectionStartRow(
          `bc:sp:r:${short(p.orderId)}:${short(p.poolId)}:v${p.poolVersion}:o${p.orderVersion}`,
          "重新开始招募",
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
    content: `<@${p.customerDiscordUserId}> 招募已终止。当前报名：${all.map((item) => `<@${item.discordUserId}>`).join("、") || "暂无"}。试音房：${voiceLink}`,
    components,
    allowed_mentions: { parse: [], users: [p.customerDiscordUserId] },
  };
}

function selectionStartRow(customId: string, label: string) {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 1,
        custom_id: customId,
        label,
      },
    ],
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
