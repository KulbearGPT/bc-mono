import { writeFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { Pool } from "pg";
import { validateRuntimeEnv } from "@blackcat/platform/env";
import { PostgresAuditSink } from "./security.js";
import {
  PostgresGiftStore,
  createGiftAnnouncementHandler,
  createGiftExpiryHandler,
} from "./gifts.js";
import { OutboxWorker, PostgresOutboxStore } from "./outbox.js";
import {
  PostgresServiceLifecycleStore,
  handleReadinessTimeoutJob,
} from "./service-lifecycle.js";
import {
  DiscordRestWorkerAdapter,
  PostgresOrderPanelProjectionStore,
} from "./worker-adapters.js";
import { DiscordRestDeliveryAdapter } from "./worker-delivery.js";
import {
  createReadinessTimeoutHandler,
  createRoleReconciliationHandler,
} from "./worker-handlers.js";
import {
  createTerminalChannelArchiveHandler,
  PostgresTerminalChannelCleanupStore,
} from "./order-channel-cleanup.js";
import {
  ProductionOutboxRuntime,
  createPanelSyncHandler,
  createProductionHandlerMap,
} from "./worker-runtime.js";
import {
  createSelectionPoolCloseHandler,
  createSelectionPoolSyncHandler,
  DiscordSelectionPoolAdapter,
  PostgresSelectionPoolWorkerStore,
  SelectionPoolWorkerService,
} from "./selection-pool-worker.js";
import {
  PostgresWeeklyReportStore,
  createWeeklyReportGenerationHandler,
  createWeeklyReportNotificationHandler,
} from "./weekly-reports.js";
import {
  PostgresSupportResponseJobStore,
  createSupportResponseOverdueHandler,
  createSupportResponseReminderHandler,
} from "./support-response-jobs.js";
import { enqueuePeriodicRoleReconciliation } from "./access.js";

const READY_FILE = "/tmp/blackcat-worker-ready";
const validation = validateRuntimeEnv(process.env, {
  allowMissingDiscordToken: false,
});
if (!validation.ok) {
  console.error(
    JSON.stringify({
      level: "error",
      event: "worker.config.invalid",
      errors: validation.errors,
    }),
  );
  process.exit(1);
}

const discordToken = validation.values.discordBotToken!;
const pool = new Pool({
  connectionString: validation.values.databaseUrl,
  application_name: "blackcat_worker",
});
const outboxStore = new PostgresOutboxStore({ client: pool });
const lifecycleStore = new PostgresServiceLifecycleStore({ pool });
const giftStore = new PostgresGiftStore(pool);
const panelStore = new PostgresOrderPanelProjectionStore(pool);
const weeklyReportStore = new PostgresWeeklyReportStore(pool);
const supportResponseStore = new PostgresSupportResponseJobStore(pool);
const terminalChannelCleanupStore = new PostgresTerminalChannelCleanupStore(pool);
const delivery = new DiscordRestDeliveryAdapter({
  botToken: discordToken,
  businessApiBaseUrl: validation.values.apiBaseUrl,
  botServiceToken: validation.values.botServiceToken,
});
const panelDiscord = new DiscordRestWorkerAdapter({ token: discordToken });
const selectionWorkerStore = new PostgresSelectionPoolWorkerStore(pool);
const selectionWorkerService = new SelectionPoolWorkerService(
  selectionWorkerStore,
  new DiscordSelectionPoolAdapter({ token: discordToken }),
);
const heartbeatMs = positiveInteger(process.env.WORKER_HEARTBEAT_MS, 60_000);
const staleLockMs = positiveInteger(
  process.env.WORKER_STALE_LOCK_MS,
  5 * 60_000,
);
if (staleLockMs < heartbeatMs * 3)
  throw new Error(
    "WORKER_STALE_LOCK_MS must be at least three heartbeat intervals.",
  );
const worker = new OutboxWorker({
  store: outboxStore,
  auditSink: new PostgresAuditSink({ client: pool }),
  workerId: `${hostname()}:${process.pid}`,
  heartbeatMs,
  logger: (entry) => console.log(JSON.stringify({ level: "info", ...entry })),
  metric: (name, tags, value) =>
    console.log(
      JSON.stringify({ level: "info", event: "worker.metric", name, tags, value }),
    ),
});
const runtime = new ProductionOutboxRuntime({
  store: outboxStore,
  worker,
  staleLockMs,
  handlers: createProductionHandlerMap({
    giftAnnouncement: createGiftAnnouncementHandler({
      store: giftStore,
      send: (message) => delivery.sendMessage(message),
    }),
    giftExpiry: createGiftExpiryHandler({ store: giftStore }),
    selectionPoolClose: createSelectionPoolCloseHandler({
      close: (selectionPoolId, deadline) =>
        selectionWorkerStore.closeExpired(selectionPoolId, deadline),
    }),
    selectionPoolSync: createSelectionPoolSyncHandler({
      sync: (selectionPoolId, phase, notBefore) =>
        selectionWorkerService.sync(selectionPoolId, phase, notBefore),
      onTerminalFailure: (selectionPoolId, error, failedAt) =>
        selectionWorkerStore.createFailureTask(
          selectionPoolId,
          error,
          failedAt,
        ),
    }),
    readinessTimeout: createReadinessTimeoutHandler({
      expire: (job) =>
        handleReadinessTimeoutJob({
          job,
          store: lifecycleStore,
          now: new Date(),
        }),
    }),
    channelArchive: createTerminalChannelArchiveHandler({
      store: terminalChannelCleanupStore,
      discord: delivery,
    }),
    panelSync: createPanelSyncHandler({
      store: panelStore,
      discord: panelDiscord,
    }),
    roleReconciliation: createRoleReconciliationHandler({
      reconcileGuild: (guildId, mappingVersion, observedAt) =>
        delivery.reconcileRoles(guildId, mappingVersion, observedAt),
      reconcileMember: (guildId, discordUserId, mappingVersion, observedAt) =>
        delivery.reconcileMember(guildId, discordUserId, mappingVersion, observedAt),
      syncObservation: (observation) => delivery.syncObservedRoles(observation),
    }),
    weeklyReportGenerate: createWeeklyReportGenerationHandler({
      store: weeklyReportStore,
    }),
    weeklyReportNotify: createWeeklyReportNotificationHandler({
      store: weeklyReportStore,
      sendDirectMessage: (message) => delivery.sendDirectMessage(message),
    }),
    supportResponseReminder: createSupportResponseReminderHandler({
      store: supportResponseStore,
      send: (message) => delivery.sendMessage(message),
      update: (message) => delivery.updateMessage(message),
    }),
    supportResponseOverdue: createSupportResponseOverdueHandler({
      store: supportResponseStore,
    }),
  }),
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
  });
}

try {
  const recovered = await runtime.initialize();
  const queuedSelectionReactionCards =
    await selectionWorkerStore.enqueueRecruitmentCardNormalization(new Date());
  const queuedOrderPanelExperienceRefreshes =
    await panelStore.enqueuePanelExperienceNormalization(new Date());
  const queuedTerminalChannelCleanups =
    await terminalChannelCleanupStore.enqueueDueTerminalOrders(new Date());
  await writeFile(READY_FILE, new Date().toISOString(), "utf8");
  console.log(
    JSON.stringify({
      level: "info",
      event: "worker.started",
      recoveredJobs: recovered.length,
      queuedSelectionReactionCards,
      queuedOrderPanelExperienceRefreshes,
      queuedTerminalChannelCleanups,
    }),
  );
  const pollIntervalMs = positiveInteger(
    process.env.WORKER_POLL_INTERVAL_MS,
    500,
  );
  const reportGuildId = process.env.DISCORD_GUILD_ID?.trim();
  const roleReconciliationIntervalMs = positiveInteger(
    process.env.ROLE_RECONCILIATION_INTERVAL_MS,
    5 * 60_000,
  );
  let nextReportScheduleCheckAt = 0;
  let nextTerminalChannelCleanupCheckAt = 0;
  let nextRoleReconciliationAt = 0;
  while (!stopping) {
    const loopNow = Date.now();
    if (loopNow >= nextTerminalChannelCleanupCheckAt) {
      await terminalChannelCleanupStore.enqueueDueTerminalOrders(new Date(loopNow));
      nextTerminalChannelCleanupCheckAt = loopNow + 60_000;
    }
    if (reportGuildId && loopNow >= nextRoleReconciliationAt) {
      await enqueuePeriodicRoleReconciliation({
        client: pool,
        guildId: reportGuildId,
        now: new Date(loopNow),
        intervalMs: roleReconciliationIntervalMs,
      });
      nextRoleReconciliationAt = loopNow + roleReconciliationIntervalMs;
    }
    if (reportGuildId && loopNow >= nextReportScheduleCheckAt) {
      await weeklyReportStore.enqueueScheduledGeneration({
        guildId: reportGuildId,
        scheduleKey: "weekly-usd",
        timeZone:
          process.env.WEEKLY_REPORT_TIME_ZONE?.trim() || "Asia/Shanghai",
        now: new Date(loopNow),
        weekStartsOn: 1,
      });
      nextReportScheduleCheckAt = loopNow + 60_000;
    }
    const completed = await runtime.runOnce();
    if (completed.length === 0) await sleep(pollIntervalMs);
  }
} finally {
  await unlink(READY_FILE).catch(() => undefined);
  await pool.end();
  console.log(JSON.stringify({ level: "info", event: "worker.stopped" }));
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("Worker timing values must be positive integers.");
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
