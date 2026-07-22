import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Pool } from "pg";
import { PostgresSelectionPoolStore } from "@blackcat/api/selection-pools";
import { PostgresSelectionPoolWorkerStore } from "@blackcat/api/selection-pool-worker";
import type { AuditRecord } from "@blackcat/api/security";

const execFile = promisify(execFileCallback);
let root = "";
let data = "";
let port = 0;
let pool: Pool;
const guildId = "999999999999999999";
const customerId = "00000000-0000-0000-0000-000000011001";
const customerDiscord = "111111111111111111";
const playerId = "00000000-0000-0000-0000-000000011002";
const playerDiscord = "222222222222222222";
const secondPlayerId = "00000000-0000-0000-0000-000000011007";
const secondPlayerDiscord = "444444444444444444";
const staffId = "00000000-0000-0000-0000-000000011003";
const catalogId = "00000000-0000-0000-0000-000000011011";
const orderId = "00000000-0000-0000-0000-000000011020";
const requirementId = "00000000-0000-0000-0000-000000011021";
const secondOrderId = "00000000-0000-0000-0000-000000011030";
const secondRequirementId = "00000000-0000-0000-0000-000000011031";
const secondCustomerId = "00000000-0000-0000-0000-000000011032";
const secondCustomerDiscord = "333333333333333333";

describe("M11-US-02 PostgreSQL selection pool transaction", () => {
  beforeAll(async () => {
    port = 62600 + (process.pid % 100);
    root = await mkdtemp(join(tmpdir(), "blackcat-m11-selection-"));
    data = join(root, "data");
    await execFile("initdb", ["-D", data, "--no-locale", "--encoding=UTF8"]);
    await execFile("pg_ctl", [
      "-D",
      data,
      "-o",
      `-p ${port} -k ${root}`,
      "-l",
      join(root, "postgres.log"),
      "start",
    ]);
    await execFile("createdb", [
      "-h",
      root,
      "-p",
      String(port),
      "blackcat_m11_selection",
    ]);
    for (const migration of (
      await readdir("database/prisma/migrations")
    ).sort())
      await execFile("psql", [
        "-h",
        root,
        "-p",
        String(port),
        "-d",
        "blackcat_m11_selection",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        `database/prisma/migrations/${migration}/migration.sql`,
      ]);
    pool = new Pool({
      host: root,
      port,
      database: "blackcat_m11_selection",
      max: 8,
    });
    await seed();
  }, 30000);
  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data)
      await execFile("pg_ctl", ["-D", data, "stop", "-m", "fast"]).catch(
        () => undefined,
      );
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("allows cross-order applications while offline, then atomically grants only one active slot", async () => {
    const store = new PostgresSelectionPoolStore(pool);
    const now = new Date("2026-08-04T12:00:00Z");
    const created = await commit(
      await store.createPool({
        orderId,
        actorGuildId: guildId,
        actorDiscordUserId: customerDiscord,
        expectedOrderVersion: 1,
        waitMinutes: 3,
        idempotencyKey: "m11:pool:create:0001",
        now,
      }),
      customerId,
    );
    const secondCreated = await commit(
      await store.createPool({
        orderId: secondOrderId,
        actorGuildId: guildId,
        actorDiscordUserId: secondCustomerDiscord,
        expectedOrderVersion: 1,
        waitMinutes: 3,
        idempotencyKey: "m11:pool:create:1001",
        now,
      }),
      secondCustomerId,
    );
    const [firstApplicationWrite, competingApplicationWrite] = await Promise.all([
      store.apply({
        orderId,
        selectionPoolId: created.pool.id,
        orderRequirementId: requirementId,
        actorGuildId: guildId,
        actorDiscordUserId: playerDiscord,
        expectedPoolVersion: created.pool.version,
        idempotencyKey: "m11:pool:apply:0002",
        now,
      }),
      store.apply({
        orderId,
        selectionPoolId: created.pool.id,
        orderRequirementId: requirementId,
        actorGuildId: guildId,
        actorDiscordUserId: secondPlayerDiscord,
        expectedPoolVersion: created.pool.version,
        idempotencyKey: "m11:pool:apply:0002:second-player",
        now,
      }),
    ]);
    const [applied, competingApplied] = await Promise.all([
      commit(firstApplicationWrite, playerId),
      commit(competingApplicationWrite, secondPlayerId),
    ]);
    const secondApplied = await commit(
      await store.apply({
        orderId: secondOrderId,
        selectionPoolId: secondCreated.pool.id,
        orderRequirementId: secondRequirementId,
        actorGuildId: guildId,
        actorDiscordUserId: playerDiscord,
        expectedPoolVersion: secondCreated.pool.version,
        idempotencyKey: "m11:pool:apply:1002",
        now,
      }),
      playerId,
    );
    expect(applied.application).toMatchObject({ playerId, status: "APPLIED" });
    expect(competingApplied).toMatchObject({
      pool: { version: created.pool.version },
      application: { playerId: secondPlayerId, status: "APPLIED" },
    });
    await expect(
      pool.query(
        `SELECT count(*)::int application_count FROM selection_applications WHERE selection_pool_id=$1 AND status='APPLIED'`,
        [created.pool.id],
      ),
    ).resolves.toMatchObject({ rows: [{ application_count: 2 }] });
    const withdrawn = await commit(
      await store.withdraw({
        orderId,
        selectionPoolId: created.pool.id,
        applicationId: competingApplied.application.id,
        actorGuildId: guildId,
        actorDiscordUserId: secondPlayerDiscord,
        expectedPoolVersion: created.pool.version,
        expectedApplicationVersion: competingApplied.application.version,
        idempotencyKey: "m11:pool:withdraw:0002:second-player",
        now,
      }),
      secondPlayerId,
    );
    expect(withdrawn).toMatchObject({
      pool: { version: created.pool.version, applicationCount: 1 },
      application: { playerId: secondPlayerId, status: "WITHDRAWN" },
    });
    expect(
      (
        await pool.query(
          `SELECT availability::text,discord_presence::text FROM player_profiles WHERE user_id=$1`,
          [playerId],
        )
      ).rows[0],
    ).toEqual({ availability: "BUSY", discord_presence: "OFFLINE" });
    const closed = await commit(
      await store.closePool({
        orderId,
        selectionPoolId: created.pool.id,
        actorGuildId: guildId,
        actorDiscordUserId: customerDiscord,
        expectedPoolVersion: created.pool.version,
        reason: "CUSTOMER_EARLY_CLOSE",
        idempotencyKey: "m11:pool:close:0003",
        now,
      }),
      customerId,
    );
    const secondClosed = await commit(
      await store.closePool({
        orderId: secondOrderId,
        selectionPoolId: secondCreated.pool.id,
        actorGuildId: guildId,
        actorDiscordUserId: secondCustomerDiscord,
        expectedPoolVersion: secondCreated.pool.version,
        reason: "CUSTOMER_EARLY_CLOSE",
        idempotencyKey: "m11:pool:close:1003",
        now,
      }),
      secondCustomerId,
    );
    const firstFinal = await store.finalize({
      orderId,
      selectionPoolId: created.pool.id,
      actorGuildId: guildId,
      actorDiscordUserId: customerDiscord,
      expectedOrderVersion: 1,
      expectedPoolVersion: closed.pool.version,
      applicationIds: [applied.application.id],
      idempotencyKey: "m11:pool:finalize:0004",
      now,
    });
    const secondFinal = await store.finalize({
      orderId: secondOrderId,
      selectionPoolId: secondCreated.pool.id,
      actorGuildId: guildId,
      actorDiscordUserId: secondCustomerDiscord,
      expectedOrderVersion: 1,
      expectedPoolVersion: secondClosed.pool.version,
      applicationIds: [secondApplied.application.id],
      idempotencyKey: "m11:pool:finalize:1004",
      now,
    });
    const outcomes = await Promise.allSettled([
      commit(firstFinal, customerId),
      commit(secondFinal, secondCustomerId),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );
    const facts = await pool.query(
      `SELECT (SELECT count(*)::int FROM order_participants WHERE player_id=$1 AND status='ACTIVE') participant_count,(SELECT count(*)::int FROM orders WHERE id=ANY($2::uuid[]) AND status='ACCEPTED') accepted_count,(SELECT count(*)::int FROM orders WHERE id=ANY($2::uuid[]) AND status='ACCEPTED' AND readiness_due_at IS NOT NULL) accepted_with_deadline_count,(SELECT count(*)::int FROM selection_applications WHERE player_user_id=$1 AND status='SELECTED') selected_count,(SELECT count(*)::int FROM selection_applications WHERE player_user_id=$1 AND status='INVALIDATED') invalidated_count,(SELECT count(*)::int FROM fund_reservations WHERE order_id=ANY($2::uuid[])) reservation_count,(SELECT count(*)::int FROM order_participant_events event JOIN order_participants participant ON participant.id=event.order_participant_id WHERE participant.player_id=$1) participant_event_count,(SELECT count(*)::int FROM outbox_events WHERE order_id=ANY($2::uuid[]) AND event_type='PANEL_SYNC') panel_sync_count,(SELECT count(*)::int FROM outbox_events WHERE order_id=ANY($2::uuid[]) AND event_type='READINESS_TIMEOUT') readiness_timeout_count`,
      [playerId, [orderId, secondOrderId]],
    );
    expect(facts.rows[0]).toEqual({
      participant_count: 1,
      accepted_count: 1,
      accepted_with_deadline_count: 1,
      selected_count: 1,
      invalidated_count: 1,
      reservation_count: 0,
      participant_event_count: 1,
      panel_sync_count: 9,
      readiness_timeout_count: 1,
    });
    const panelJobs = await pool.query(
      `SELECT payload->>'kind' kind,count(*)::int count FROM outbox_events WHERE order_id=ANY($1::uuid[]) AND event_type='PANEL_SYNC' GROUP BY payload->>'kind' ORDER BY payload->>'kind'`,
      [[orderId, secondOrderId]],
    );
    expect(panelJobs.rows).toEqual([
      { kind: "ORDER_SELECTION_APPLICATION_CHANNEL_SYNC", count: 3 },
      { kind: "ORDER_SELECTION_CLOSED_CHANNEL_SYNC", count: 2 },
      { kind: "ORDER_SELECTION_FINALIZED_CHANNEL_SYNC", count: 1 },
      { kind: "ORDER_SELECTION_STARTED_CHANNEL_SYNC", count: 2 },
      { kind: "ORDER_SELECTION_WITHDRAWN_CHANNEL_SYNC", count: 1 },
    ]);
    const jobs = await pool.query(
      `SELECT event_type,count(*)::int count FROM outbox_events WHERE selection_pool_id=ANY($1::uuid[]) GROUP BY event_type ORDER BY event_type`,
      [[created.pool.id, secondCreated.pool.id]],
    );
    expect(jobs.rows).toEqual([
      { event_type: "SELECTION_POOL_SYNC", count: 5 },
    ]);
    await expect(
      pool.query(
        `UPDATE selection_pool_events SET snapshot='{}' WHERE selection_pool_id=$1`,
        [created.pool.id],
      ),
    ).rejects.toThrow(/append-only/u);
  });

  test("does not close a pool when a legacy deadline worker call is recovered", async () => {
    const customer = "00000000-0000-0000-0000-000000011070",
      discord = "777777777777777777",
      order = "00000000-0000-0000-0000-000000011071",
      requirement = "00000000-0000-0000-0000-000000011072";
    await pool.query(
      `INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES($1,'定时老板','ACTIVE',1,now(),now())`,
      [customer],
    );
    await pool.query(
      `INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES('00000000-0000-0000-0000-000000011073',$1,$2,$3,now(),now(),now())`,
      [customer, guildId, discord],
    );
    await pool.query(
      `INSERT INTO orders(id,public_id,customer_id,active_customer_slot_id,status,row_version,amount_minor,expected_player_earning_minor,currency,guild_id,submitted_at,created_at,updated_at) VALUES($1,'P-M11-DUE',$2,$2,'PENDING_DISPATCH',1,200,120,'CAT',$3,now(),now(),now())`,
      [order, customer, guildId],
    );
    await pool.query(
      `INSERT INTO order_requirements(id,order_id,service_catalog_version_id,status,row_version,game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,region_code_snapshot,region_display_name_snapshot,billing_unit_minutes_snapshot,unit_count,requested_player_count,customer_unit_price_minor_snapshot,estimated_line_price_minor,created_at,updated_at) VALUES($1,$2,$3,'ACTIVE',1,'VALORANT','瓦洛兰特','TECH','技术陪玩','NA','北美',60,2,1,100,200,now(),now())`,
      [requirement, order, catalogId],
    );
    const openedAt = new Date("2026-08-04T11:57:00Z");
    const store = new PostgresSelectionPoolStore(pool);
    const created = await commit(
      await store.createPool({
        orderId: order,
        actorGuildId: guildId,
        actorDiscordUserId: discord,
        expectedOrderVersion: 1,
        waitMinutes: 3,
        idempotencyKey: "m11:due:create",
        now: openedAt,
      }),
      customer,
    );
    await new PostgresSelectionPoolWorkerStore(pool).closeExpired(
      created.pool.id,
      "2026-08-04T12:00:00.000Z",
    );
    const facts = await pool.query(
      `SELECT pool.status::text,pool.close_reason::text,(SELECT count(*)::int FROM selection_pools WHERE order_id=$2) round_count,(SELECT count(*)::int FROM outbox_events WHERE selection_pool_id=pool.id AND event_type='SELECTION_POOL_SYNC') sync_count FROM selection_pools pool WHERE pool.id=$1`,
      [created.pool.id, order],
    );
    expect(facts.rows[0]).toEqual({
      status: "COLLECTING",
      close_reason: null,
      round_count: 1,
      sync_count: 1,
    });
  });

  test("persists a reaction card and reactivates the same application after reaction removal", async () => {
    const reactionCustomer = "00000000-0000-0000-0000-000000011080";
    const reactionCustomerDiscord = "888888888888888880";
    const reactionOrder = "00000000-0000-0000-0000-000000011081";
    const reactionRequirement = "00000000-0000-0000-0000-000000011082";
    const channelId = "888888888888888881";
    const messageId = "888888888888888882";
    await pool.query(
      `INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES($1,'Reaction 老板','ACTIVE',1,now(),now())`,
      [reactionCustomer],
    );
    await pool.query(
      `INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES('00000000-0000-0000-0000-000000011083',$1,$2,$3,now(),now(),now())`,
      [reactionCustomer, guildId, reactionCustomerDiscord],
    );
    await pool.query(
      `INSERT INTO orders(id,public_id,customer_id,active_customer_slot_id,status,row_version,amount_minor,expected_player_earning_minor,currency,guild_id,submitted_at,created_at,updated_at) VALUES($1,'P-M11-REACTION',$2,$2,'PENDING_DISPATCH',1,200,120,'CAT',$3,now(),now(),now())`,
      [reactionOrder, reactionCustomer, guildId],
    );
    await pool.query(
      `INSERT INTO order_requirements(id,order_id,service_catalog_version_id,status,row_version,game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,region_code_snapshot,region_display_name_snapshot,billing_unit_minutes_snapshot,unit_count,requested_player_count,customer_unit_price_minor_snapshot,estimated_line_price_minor,created_at,updated_at) VALUES($1,$2,$3,'ACTIVE',1,'VALORANT','瓦洛兰特','TECH','技术陪玩','NA','北美',60,2,1,100,200,now(),now())`,
      [reactionRequirement, reactionOrder, catalogId],
    );
    const store = new PostgresSelectionPoolStore(pool);
    const workerStore = new PostgresSelectionPoolWorkerStore(pool);
    const now = new Date("2026-08-08T12:00:00Z");
    const created = await commit(await store.createPool({
      orderId: reactionOrder,
      actorGuildId: guildId,
      actorDiscordUserId: reactionCustomerDiscord,
      expectedOrderVersion: 1,
      idempotencyKey: "m11:reaction:create",
      now,
    }), reactionCustomer);
    await workerStore.setRecruitmentCard(created.pool.id, channelId, messageId, [{
      emoji: "1️⃣",
      orderRequirementId: reactionRequirement,
      label: "瓦洛兰特 · 技术陪玩",
    }]);

    const observe = (state: "ADDED" | "REMOVED", key: string) => store.observeReaction({
      actorGuildId: guildId,
      actorDiscordUserId: playerDiscord,
      channelId,
      messageId,
      emoji: "1️⃣",
      state,
      idempotencyKey: key,
      now,
    });
    const added = await commit(await observe("ADDED", "m11:reaction:add:1"), playerId);
    const removed = await commit(await observe("REMOVED", "m11:reaction:remove:1"), playerId);
    const readded = await commit(await observe("ADDED", "m11:reaction:add:2"), playerId);

    expect(added).toMatchObject({ changed: true, state: "APPLIED", application: { version: 1 } });
    expect(removed).toMatchObject({ changed: true, state: "WITHDRAWN", application: { version: 2 } });
    expect(readded).toMatchObject({ changed: true, state: "APPLIED", application: { version: 3 } });
    await expect(store.listReactionCards({ guildId })).resolves.toEqual(expect.objectContaining({
      items: expect.arrayContaining([expect.objectContaining({
        poolId: created.pool.id,
        channelId,
        messageId,
        bindings: [expect.objectContaining({ emoji: "1️⃣", appliedDiscordUserIds: [playerDiscord] })],
      })]),
    }));
    await expect(pool.query(
      `SELECT count(*)::int count FROM selection_applications WHERE selection_pool_id=$1`,
      [created.pool.id],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  test("atomically rejects an active candidate round before opening the replacement", async () => {
    const customer = "00000000-0000-0000-0000-000000011074";
    const discord = "888888888888888888";
    const order = "00000000-0000-0000-0000-000000011075";
    const requirement = "00000000-0000-0000-0000-000000011076";
    await pool.query(
      `INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES($1,'重选老板','ACTIVE',1,now(),now())`,
      [customer],
    );
    await pool.query(
      `INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES('00000000-0000-0000-0000-000000011077',$1,$2,$3,now(),now(),now())`,
      [customer, guildId, discord],
    );
    await pool.query(
      `INSERT INTO orders(id,public_id,customer_id,active_customer_slot_id,status,row_version,amount_minor,expected_player_earning_minor,currency,guild_id,submitted_at,created_at,updated_at) VALUES($1,'P-M11-RESELECT',$2,$2,'PENDING_DISPATCH',1,200,120,'CAT',$3,now(),now(),now())`,
      [order, customer, guildId],
    );
    await pool.query(
      `INSERT INTO order_requirements(id,order_id,service_catalog_version_id,status,row_version,game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,region_code_snapshot,region_display_name_snapshot,billing_unit_minutes_snapshot,unit_count,requested_player_count,customer_unit_price_minor_snapshot,estimated_line_price_minor,created_at,updated_at) VALUES($1,$2,$3,'ACTIVE',1,'VALORANT','瓦洛兰特','TECH','技术陪玩','NA','北美',60,2,1,100,200,now(),now())`,
      [requirement, order, catalogId],
    );
    const store = new PostgresSelectionPoolStore(pool);
    const now = new Date("2026-08-04T13:00:00Z");
    const first = await commit(await store.createPool({ orderId: order, actorGuildId: guildId, actorDiscordUserId: discord, expectedOrderVersion: 1, waitMinutes: 3, idempotencyKey: "m11:reselect:create", now }), customer);
    const applied = await commit(await store.apply({ orderId: order, selectionPoolId: first.pool.id, orderRequirementId: requirement, actorGuildId: guildId, actorDiscordUserId: secondPlayerDiscord, expectedPoolVersion: first.pool.version, idempotencyKey: "m11:reselect:apply", now }), secondPlayerId);
    const closed = await commit(await store.closePool({ orderId: order, selectionPoolId: first.pool.id, actorGuildId: guildId, actorDiscordUserId: discord, expectedPoolVersion: applied.pool.version, reason: "CUSTOMER_EARLY_CLOSE", idempotencyKey: "m11:reselect:close", now }), customer);
    const replacement = await commit(await store.createPool({ orderId: order, actorGuildId: guildId, actorDiscordUserId: discord, expectedOrderVersion: 1, waitMinutes: 5, replacesSelectionPoolId: first.pool.id, expectedSelectionPoolVersion: closed.pool.version, idempotencyKey: "m11:reselect:replace", now: new Date("2026-08-04T13:01:00Z") }), customer);

    const facts = await pool.query(
      `SELECT old_pool.status::text old_status,old_pool.row_version old_version,new_pool.status::text new_status,new_pool.round new_round,application.status::text application_status,application.row_version application_version,application.decided_at IS NOT NULL application_decided,orders.status::text order_status,orders.row_version order_version,(SELECT count(*)::int FROM order_participants WHERE order_id=$3) participant_count,(SELECT count(*)::int FROM selection_application_events WHERE selection_application_id=application.id AND event_type='NOT_SELECTED') not_selected_event_count,(SELECT count(*)::int FROM outbox_events WHERE selection_pool_id=old_pool.id AND event_type='SELECTION_POOL_SYNC') old_sync_count,(SELECT count(*)::int FROM outbox_events WHERE order_id=$3 AND event_type='PANEL_SYNC' AND dedupe_key='m11:reselect:replace:panel-sync') new_panel_sync_count FROM selection_pools old_pool JOIN selection_pools new_pool ON new_pool.id=$2 JOIN selection_applications application ON application.id=$4 JOIN orders ON orders.id=$3 WHERE old_pool.id=$1`,
      [first.pool.id, replacement.pool.id, order, applied.application.id],
    );
    expect(facts.rows[0]).toEqual({
      old_status: "FINALIZED",
      old_version: closed.pool.version + 1,
      new_status: "COLLECTING",
      new_round: 2,
      application_status: "NOT_SELECTED",
      application_version: applied.application.version + 1,
      application_decided: true,
      order_status: "PENDING_DISPATCH",
      order_version: 1,
      participant_count: 0,
      not_selected_event_count: 1,
      old_sync_count: 3,
      new_panel_sync_count: 1,
    });
  });
});

async function commit<T>(
  staged: { data: T; commit(audit: AuditRecord): Promise<void> | void },
  actorId: string,
) {
  await staged.commit({
    id: crypto.randomUUID(),
    actorId,
    actorStaffId: null,
    actorLevel: null,
    actorSource: "DISCORD_BOT",
    clientId: "DISCORD_BOT",
    interactionId: null,
    permissionCode: "order.selection_pool.create",
    action: "TEST_SELECTION_WRITE",
    targetType: "selection_pool",
    targetId: orderId,
    outcome: "SUCCEEDED",
    reason: null,
    requestId: `req_${crypto.randomUUID()}`,
    idempotencyKey: null,
    approvalRequestId: null,
    occurredAt: "2026-08-04T12:00:00.000Z",
  });
  return staged.data;
}

async function seed() {
  await pool.query(
    `INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES($1,'老板','ACTIVE',1,now(),now()),($2,'离线猫','ACTIVE',1,now(),now()),($3,'店主','ACTIVE',1,now(),now()),($4,'另一位老板','ACTIVE',1,now(),now()),($5,'第二只猫','ACTIVE',1,now(),now())`,
    [customerId, playerId, staffId, secondCustomerId, secondPlayerId],
  );
  await pool.query(
    `INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES('00000000-0000-0000-0000-000000011004',$1,$3,$4,now(),now(),now()),('00000000-0000-0000-0000-000000011005',$2,$3,$5,now(),now(),now()),('00000000-0000-0000-0000-000000011033',$6,$3,$7,now(),now(),now()),('00000000-0000-0000-0000-000000011008',$8,$3,$9,now(),now(),now())`,
    [
      customerId,
      playerId,
      guildId,
      customerDiscord,
      playerDiscord,
      secondCustomerId,
      secondCustomerDiscord,
      secondPlayerId,
      secondPlayerDiscord,
    ],
  );
  await pool.query(
    `INSERT INTO staff_accounts(id,user_id,level,status,role_source,permissions_version,created_at,updated_at) VALUES($1,$1,'L4_ADMIN_OWNER','ACTIVE','MANUAL',1,now(),now())`,
    [staffId],
  );
  await pool.query(
    `INSERT INTO player_profiles(id,user_id,review_status,row_version,availability,discord_presence,created_at,updated_at) VALUES('00000000-0000-0000-0000-000000011006',$1,'ACTIVE',1,'BUSY','OFFLINE',now(),now()),('00000000-0000-0000-0000-000000011009',$2,'ACTIVE',1,'AVAILABLE','ONLINE',now(),now())`,
    [playerId, secondPlayerId],
  );
  await pool.query(
    `INSERT INTO service_offerings(id,code,game_code,game_name,service_code,service_name,region_code,created_at,updated_at) VALUES('00000000-0000-0000-0000-000000011010','VAL-TECH-NA','VALORANT','瓦洛兰特','TECH','技术陪玩','NA',now(),now())`,
  );
  await pool.query(
    `INSERT INTO service_catalog_versions(id,service_offering_id,version,status,active_offering_key,billing_unit_minutes,minimum_units,customer_unit_price_minor,player_unit_payout_minor,default_player_payout_bps,currency,created_by_staff_id,created_at) VALUES($1,'00000000-0000-0000-0000-000000011010',1,'ACTIVE','00000000-0000-0000-0000-000000011010',60,1,100,60,6000,'CAT',$2,now())`,
    [catalogId, staffId],
  );
  await pool.query(
    `INSERT INTO orders(id,public_id,customer_id,active_customer_slot_id,status,row_version,amount_minor,expected_player_earning_minor,currency,guild_id,submitted_at,created_at,updated_at) VALUES($1,'P-M11-POOL',$2,$2,'PENDING_DISPATCH',1,200,120,'CAT',$3,now(),now(),now())`,
    [orderId, customerId, guildId],
  );
  await pool.query(
    `INSERT INTO order_requirements(id,order_id,service_catalog_version_id,status,row_version,game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,region_code_snapshot,region_display_name_snapshot,billing_unit_minutes_snapshot,unit_count,requested_player_count,customer_unit_price_minor_snapshot,estimated_line_price_minor,created_at,updated_at) VALUES($1,$2,$3,'ACTIVE',1,'VALORANT','瓦洛兰特','TECH','技术陪玩','NA','北美',60,2,1,100,200,now(),now())`,
    [requirementId, orderId, catalogId],
  );
  await pool.query(
    `INSERT INTO orders(id,public_id,customer_id,active_customer_slot_id,status,row_version,amount_minor,expected_player_earning_minor,currency,guild_id,submitted_at,created_at,updated_at) VALUES($1,'P-M11-POOL-2',$2,$2,'PENDING_DISPATCH',1,200,120,'CAT',$3,now(),now(),now())`,
    [secondOrderId, secondCustomerId, guildId],
  );
  await pool.query(
    `INSERT INTO order_requirements(id,order_id,service_catalog_version_id,status,row_version,game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,region_code_snapshot,region_display_name_snapshot,billing_unit_minutes_snapshot,unit_count,requested_player_count,customer_unit_price_minor_snapshot,estimated_line_price_minor,created_at,updated_at) VALUES($1,$2,$3,'ACTIVE',1,'VALORANT','瓦洛兰特','TECH','技术陪玩','NA','北美',60,2,1,100,200,now(),now())`,
    [secondRequirementId, secondOrderId, catalogId],
  );
}
