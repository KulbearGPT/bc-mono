import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Pool } from "pg";
import { PostgresSupportRatingStore } from "@blackcat/api/support-response-rating";
import { PostgresOrderPanelProjectionStore } from "@blackcat/api/worker-adapters";
import type { AuditRecord } from "@blackcat/api/security";

const execFile = promisify(execFileCallback);
const guildId = "999999999999999999";
const channelId = "777777777777777777";
const customerDiscordId = "111111111111111111";
const staffDiscordId = "222222222222222222";
const orderId = "00000000-0000-0000-0000-000000012491";
const customerId = "00000000-0000-0000-0000-000000012492";
const staffId = "00000000-0000-0000-0000-000000012493";
const responseEventId = "00000000-0000-0000-0000-000000012494";
const completedAt = new Date(Date.now() - 60_000);
let root = "";
let data = "";
let pool: Pool;

describe("M12-US-04 PostgreSQL rating integrity", () => {
  beforeAll(async () => {
    const port = 63_020 + (process.pid % 20);
    root = await mkdtemp(join(tmpdir(), "blackcat-m12-rating-"));
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
      "blackcat_m12_rating",
    ]);
    for (const migration of (
      await readdir("database/prisma/migrations")
    ).sort()) {
      await execFile("psql", [
        "-h",
        root,
        "-p",
        String(port),
        "-d",
        "blackcat_m12_rating",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        `database/prisma/migrations/${migration}/migration.sql`,
      ]);
    }
    pool = new Pool({ host: root, port, database: "blackcat_m12_rating", max: 5 });
    await pool.query(
      `INSERT INTO users(id,display_name,status,row_version,created_at,updated_at)
       VALUES ($1,'客户','ACTIVE',1,now(),now()),($2,'客服','ACTIVE',1,now(),now())`,
      [customerId, staffId],
    );
    await pool.query(
      `INSERT INTO staff_accounts(id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
       VALUES ($1,$1,'L4_ADMIN_OWNER','DISABLED','MANUAL',1,now(),now())`,
      [staffId],
    );
    await pool.query(
      `INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at)
       VALUES (gen_random_uuid(),$1,$3,$4,now(),now(),now()),
              (gen_random_uuid(),$2,$3,$5,now(),now(),now())`,
      [customerId, staffId, guildId, customerDiscordId, staffDiscordId],
    );
    await pool.query(
      `INSERT INTO orders
         (id,public_id,customer_id,status,row_version,guild_id,channel_id,panel_message_id,amount_minor,currency,completed_at,updated_at)
       VALUES($1,'P-M12-RATING',$2,'COMPLETED',10,$3,$4,'666666666666666666',100,'CAT',$5,$5)`,
      [orderId, customerId, guildId, channelId, completedAt],
    );
    await pool.query(
      `INSERT INTO order_channel_message_events
         (id,order_id,order_public_id,guild_id,channel_id,discord_message_id,event_id,event_type,author_discord_id,author_display_name,author_is_bot,content_snapshot,observed_at)
       VALUES($1,$2,'P-M12-RATING',$3,$4,'555555555555555555','CREATED:555555555555555555','CREATED',$5,'客服',false,'我来处理',$6)`,
      [responseEventId, orderId, guildId, channelId, staffDiscordId, completedAt],
    );
    await pool.query(
      `INSERT INTO staff_tasks
         (id,public_id,type,reason_code,status,row_version,order_id,context_snapshot,response_status,response_due_at,first_responded_at,first_response_event_id,created_at,updated_at)
       VALUES('00000000-0000-0000-0000-000000012495','T-M12-RATING','ORDER_ASSIST','CUSTOMER_HELP','RESOLVED',2,$1,'{}','MET',$2,$2,$3,$2,$2)`,
      [orderId, completedAt, responseEventId],
    );
  }, 40_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data)
      await execFile("pg_ctl", ["-D", data, "stop", "-m", "fast"]).catch(
        () => undefined,
      );
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("panel eligibility disappears after one of two concurrent ratings wins", async () => {
    const panels = new PostgresOrderPanelProjectionStore(pool);
    expect((await panels.getOrderPanelProjection(orderId))?.supportRatingEligible).toBe(true);

    const store = new PostgresSupportRatingStore(pool);
    const input = {
      orderId,
      guildId,
      customerDiscordId,
      score: 5,
      reason: null,
      comment: null,
      now: new Date(completedAt.getTime() + 60_000),
    };
    const staged = await Promise.all([store.stageCreate(input), store.stageCreate(input)]);
    const results = await Promise.allSettled(
      staged.map((item) => item.commit(audit(item.data.id))),
    );

    const rejectionMessages = results.flatMap((item) =>
      item.status === "rejected" ? [String(item.reason)] : [],
    );
    expect(results.filter((item) => item.status === "fulfilled"), rejectionMessages.join("\n")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected"), rejectionMessages.join("\n")).toHaveLength(1);
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM order_support_ratings")).rows[0].count,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM order_experience_reviews WHERE order_id=$1 AND target_type='SUPPORT'",
          [orderId],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (await pool.query("SELECT status::text FROM orders WHERE id=$1", [orderId])).rows[0].status,
    ).toBe("COMPLETED");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM outbox_events WHERE dedupe_key=$1",
          [`support-rating:${orderId}:panel-sync`],
        )
      ).rows[0].count,
    ).toBe(1);
    expect((await panels.getOrderPanelProjection(orderId))?.supportRatingEligible).toBe(false);
  });

  test("rating facts are append-only", async () => {
    await expect(
      pool.query("UPDATE order_support_ratings SET score=1 WHERE order_id=$1", [orderId]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      pool.query("DELETE FROM order_support_ratings WHERE order_id=$1", [orderId]),
    ).rejects.toThrow(/append-only/i);
  });
});

function audit(targetId: string): AuditRecord {
  return {
    id: randomUUID(),
    actorId: customerId,
    actorStaffId: null,
    actorLevel: null,
    actorSource: "DISCORD_BOT",
    clientId: "DISCORD_BOT_SERVICE",
    interactionId: "888888888888888888",
    permissionCode: "order.support_rating.create",
    action: "CREATE_ORDER_SUPPORT_RATING",
    targetType: "order_support_rating",
    targetId,
    outcome: "SUCCEEDED",
    reason: null,
    requestId: randomUUID(),
    approvalRequestId: null,
    occurredAt: new Date(completedAt.getTime() + 60_000).toISOString(),
  };
}
