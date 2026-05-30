import { writeFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { Pool } from 'pg';
import { validateRuntimeEnv } from '@blackcat/platform/env';
import { PostgresDispatchStore, expireDispatchAttempt } from './dispatch.js';
import { createRuntimeFundingAdapter } from './funding-adapter-runtime.js';
import { PostgresGiftStore, createGiftAnnouncementHandler, createGiftExpiryHandler } from './gifts.js';
import { PostgresOrderStore } from './orders.js';
import { OutboxWorker, PostgresOutboxStore } from './outbox.js';
import { PostgresServiceLifecycleStore, handleReadinessTimeoutJob } from './service-lifecycle.js';
import { DiscordRestWorkerAdapter, PostgresOrderPanelProjectionStore } from './worker-adapters.js';
import { DiscordRestDeliveryAdapter, PostgresDispatchMessageStore } from './worker-delivery.js';
import {
  createChannelArchiveHandler,
  createDispatchMessageHandler,
  createDispatchTimeoutHandler,
  createReadinessTimeoutHandler,
  createRoleReconciliationHandler
} from './worker-handlers.js';
import {
  ProductionOutboxRuntime,
  createPanelSyncHandler,
  createProductionHandlerMap,
  shouldEnqueueWeeklyReport
} from './worker-runtime.js';
import { PostgresWeeklyReportStore, createWeeklyReportGenerationHandler, createWeeklyReportNotificationHandler } from './weekly-reports.js';
import { createPilotFeaturePolicy } from './pilot-features.js';
import { processHealthPort, requireProductionServiceEnv, startProcessHealthServer } from '@blackcat/platform/process-health';

const READY_FILE = '/tmp/blackcat-worker-ready';
const isProductionRuntime = process.env.NODE_ENV === 'production';
if (isProductionRuntime) requireProductionServiceEnv('worker', process.env);
const validation = validateRuntimeEnv(process.env, { allowMissingDiscordToken: false });
const pilotFeaturePolicy = createPilotFeaturePolicy(process.env.PILOT_PHASE);
const m6Enabled = pilotFeaturePolicy.isEnabled('M6');
if (!validation.ok) {
  console.error(JSON.stringify({ level: 'error', event: 'worker.config.invalid', errors: validation.errors }));
  process.exit(1);
}

const discordToken = validation.values.discordBotToken!;
const pool = new Pool({ connectionString: validation.values.databaseUrl, application_name: 'blackcat_worker' });
const { adapter: fundingAdapter, providerKey } = createRuntimeFundingAdapter(process.env, { pool });
const outboxStore = new PostgresOutboxStore({ client: pool });
const orderStore = new PostgresOrderStore({ pool });
const dispatchStore = new PostgresDispatchStore({ pool });
const lifecycleStore = new PostgresServiceLifecycleStore({ pool, fundingAdapter, providerKey });
const giftStore = new PostgresGiftStore(pool);
const dispatchMessageStore = new PostgresDispatchMessageStore(pool);
const panelStore = new PostgresOrderPanelProjectionStore(pool);
const weeklyReportStore = m6Enabled ? new PostgresWeeklyReportStore(pool) : null;
const delivery = new DiscordRestDeliveryAdapter({
  botToken: discordToken,
  businessApiBaseUrl: validation.values.apiBaseUrl,
  botServiceToken: validation.values.botServiceToken
});
const panelDiscord = new DiscordRestWorkerAdapter({ token: discordToken });
const heartbeatMs = positiveInteger(process.env.WORKER_HEARTBEAT_MS, 60_000);
const staleLockMs = positiveInteger(process.env.WORKER_STALE_LOCK_MS, 5 * 60_000);
if (staleLockMs < heartbeatMs * 3) throw new Error('WORKER_STALE_LOCK_MS must be at least three heartbeat intervals.');
const worker = new OutboxWorker({
  store: outboxStore,
  workerId: `${hostname()}:${process.pid}`,
  heartbeatMs,
  logger: (entry) => console.log(JSON.stringify({ level: 'info', ...entry })),
  metric: (name, tags) => console.log(JSON.stringify({ level: 'info', event: 'worker.metric', name, tags }))
});
const runtime = new ProductionOutboxRuntime({
  store: outboxStore,
  worker,
  staleLockMs,
  handlers: createProductionHandlerMap({
    giftAnnouncement: createGiftAnnouncementHandler({ store: giftStore, send: (message) => delivery.sendMessage(message) }),
    giftExpiry: createGiftExpiryHandler({ store: giftStore, fundingAdapter }),
    dispatchMessage: createDispatchMessageHandler({ store: dispatchMessageStore, discord: delivery }),
    dispatchTimeout: createDispatchTimeoutHandler({
      expire: (dispatchAttemptId) => expireDispatchAttempt({ orderStore, dispatchStore, dispatchAttemptId, now: new Date() })
    }),
    readinessTimeout: createReadinessTimeoutHandler({
      expire: (job) => handleReadinessTimeoutJob({ job, store: lifecycleStore, now: new Date() })
    }),
    channelArchive: createChannelArchiveHandler({ archive: (channelId) => delivery.archiveChannel(channelId) }),
    panelSync: createPanelSyncHandler({ store: panelStore, discord: panelDiscord }),
    roleReconciliation: createRoleReconciliationHandler({
      reconcile: (guildId, mappingVersion, observedAt) => delivery.reconcileRoles(guildId, mappingVersion, observedAt)
    }),
    weeklyReportGenerate: weeklyReportStore
      ? createWeeklyReportGenerationHandler({ store: weeklyReportStore })
      : undefined,
    weeklyReportNotify: weeklyReportStore
      ? createWeeklyReportNotificationHandler({
          store: weeklyReportStore,
          sendDirectMessage: (message) => delivery.sendDirectMessage(message)
        })
      : undefined
  }, { m6Enabled })
});

let stopping = false;
let ready = false;
const health = isProductionRuntime
  ? await startProcessHealthServer({ port: processHealthPort(process.env.PORT), isReady: () => ready })
  : undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { stopping = true; ready = false; });
}

try {
  const recovered = await runtime.initialize();
  ready = true;
  await writeFile(READY_FILE, new Date().toISOString(), 'utf8');
  console.log(JSON.stringify({ level: 'info', event: 'worker.started', recoveredJobs: recovered.length }));
  const pollIntervalMs = positiveInteger(process.env.WORKER_POLL_INTERVAL_MS, 500);
  const reportGuildId = process.env.DISCORD_GUILD_ID?.trim();
  let nextReportScheduleCheckAt = 0;
  while (!stopping) {
    const loopNow = Date.now();
    if (shouldEnqueueWeeklyReport({ m6Enabled, reportGuildId, loopNow, nextReportScheduleCheckAt })) {
      await weeklyReportStore!.enqueueScheduledGeneration({ guildId: reportGuildId!, scheduleKey: 'weekly-cny',
        timeZone: process.env.WEEKLY_REPORT_TIME_ZONE?.trim() || 'Asia/Shanghai', now: new Date(loopNow), weekStartsOn: 1 });
      nextReportScheduleCheckAt = loopNow + 60_000;
    }
    const completed = await runtime.runOnce();
    if (completed.length === 0) await sleep(pollIntervalMs);
  }
} finally {
  ready = false;
  await unlink(READY_FILE).catch(() => undefined);
  await pool.end();
  await health?.close();
  console.log(JSON.stringify({ level: 'info', event: 'worker.stopped' }));
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Worker timing values must be positive integers.');
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
