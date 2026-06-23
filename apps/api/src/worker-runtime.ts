import type { JobType, OutboxJob, OutboxStore, OutboxWorker } from './outbox.js';

export type OutboxHandler = (job: OutboxJob) => Promise<void> | void;
export type ProductionHandlerMap = Partial<Record<JobType, OutboxHandler>>;

export const productionJobTypes = [
  'GIFT_ANNOUNCEMENT',
  'GIFT_EXPIRY',
  'DISPATCH_START',
  'DISPATCH_MESSAGE',
  'DISPATCH_TIMEOUT',
  'READINESS_TIMEOUT',
  'CHANNEL_ARCHIVE',
  'PANEL_SYNC',
  'ROLE_RECONCILIATION',
  'WEEKLY_REPORT_GENERATE',
  'WEEKLY_REPORT_NOTIFY'
] as const satisfies readonly JobType[];

export function createProductionHandlerMap(input: {
  giftAnnouncement: OutboxHandler;
  giftExpiry: OutboxHandler;
  dispatchStart: OutboxHandler;
  dispatchMessage: OutboxHandler;
  dispatchTimeout: OutboxHandler;
  readinessTimeout: OutboxHandler;
  channelArchive: OutboxHandler;
  panelSync: OutboxHandler;
  roleReconciliation: OutboxHandler;
  weeklyReportGenerate?: OutboxHandler;
  weeklyReportNotify?: OutboxHandler;
}, options: { m6Enabled?: boolean } = {}): ProductionHandlerMap {
  const handlers: ProductionHandlerMap = {
    GIFT_ANNOUNCEMENT: input.giftAnnouncement,
    GIFT_EXPIRY: input.giftExpiry,
    DISPATCH_START: input.dispatchStart,
    DISPATCH_MESSAGE: input.dispatchMessage,
    DISPATCH_TIMEOUT: input.dispatchTimeout,
    READINESS_TIMEOUT: input.readinessTimeout,
    CHANNEL_ARCHIVE: input.channelArchive,
    PANEL_SYNC: input.panelSync,
    ROLE_RECONCILIATION: input.roleReconciliation
  };
  if (options.m6Enabled ?? true) {
    handlers.WEEKLY_REPORT_GENERATE = input.weeklyReportGenerate!;
    handlers.WEEKLY_REPORT_NOTIFY = input.weeklyReportNotify!;
  }
  return handlers;
}

export function shouldEnqueueWeeklyReport(input: {
  m6Enabled: boolean;
  reportGuildId: string | undefined;
  loopNow: number;
  nextReportScheduleCheckAt: number;
}): boolean {
  return input.m6Enabled
    && Boolean(input.reportGuildId)
    && input.loopNow >= input.nextReportScheduleCheckAt;
}

export class ProductionOutboxRuntime {
  constructor(private readonly input: {
    store: OutboxStore;
    worker: OutboxWorker;
    handlers: ProductionHandlerMap;
    now?: () => Date;
    staleLockMs?: number;
  }) {}

  async initialize(): Promise<OutboxJob[]> {
    const now = (this.input.now ?? (() => new Date()))();
    const staleLockMs = this.input.staleLockMs ?? 5 * 60_000;
    const jobTypes = Object.entries(this.input.handlers)
      .filter((entry): entry is [JobType, OutboxHandler] => typeof entry[1] === 'function')
      .map(([jobType]) => jobType);
    return this.input.store.recoverStaleProcessingJobs({
      lockedBefore: new Date(now.getTime() - staleLockMs),
      now,
      error: 'WORKER_RESTART_RECOVERY',
      jobTypes
    });
  }

  runOnce(): Promise<OutboxJob[]> {
    return this.input.worker.runOnce(this.input.handlers);
  }
}

export interface OrderPanelProjection {
  orderId: string;
  publicId: string;
  status: string;
  version: number;
  channelId: string;
  panelMessageId: string;
  customerDiscordUserId: string;
  playerDiscordUserId: string | null;
  playerDiscordUserIds?: string[];
  requestedPlayerCount?: number;
  filledPlayerCount?: number;
  coordinationRequirements?: OrderCoordinationRequirement[];
  submittedAt?: string | null;
  acceptedAt?: string | null;
  amountMinor: number;
  currency: string;
  guildId?: string;
  voiceChannelId?: string | null;
  privateOrderCategoryId?: string | null;
  staffTaskChannelId?: string | null;
  staffRoleIds?: string[];
}

export interface OrderCoordinationRequirement {
  gameDisplayName: string;
  serviceDisplayName: string;
  regionDisplayName: string | null;
  durationMinutes: number | null;
  requestedPlayerCount: number;
  customerNote: string | null;
}

export interface OrderPanelProjectionStore {
  getOrderPanelProjection(orderId: string): Promise<OrderPanelProjection | null>;
  replacePanelMessageId(input: {
    orderId: string;
    expectedPanelMessageId: string;
    panelMessageId: string;
  }): Promise<void>;
  setVoiceChannelId?(input: { orderId: string; voiceChannelId: string }): Promise<void>;
}

export interface OrderPanelDiscordAdapter {
  upsertOrderPanel(projection: OrderPanelProjection, notBefore: string): Promise<{ messageId: string; recreated: boolean; voiceChannelId?: string }>;
}

export function createPanelSyncHandler(input: {
  store: OrderPanelProjectionStore;
  discord: OrderPanelDiscordAdapter;
}): OutboxHandler {
  return async (job) => {
    if (job.type !== 'PANEL_SYNC') throw new Error('Expected a PANEL_SYNC job.');
    const payload = job.payload as { orderId?: unknown } | null;
    if (!payload || typeof payload.orderId !== 'string' || payload.orderId !== job.aggregateId) {
      throw new Error('Panel sync payload is invalid.');
    }
    const projection = await input.store.getOrderPanelProjection(payload.orderId);
    if (!projection) throw new Error('Order panel projection was not found.');
    const result = await input.discord.upsertOrderPanel(projection, job.createdAt);
    if (result.voiceChannelId && result.voiceChannelId !== projection.voiceChannelId) {
      await input.store.setVoiceChannelId?.({ orderId: projection.orderId, voiceChannelId: result.voiceChannelId });
    }
    if (result.recreated && result.messageId !== projection.panelMessageId) {
      await input.store.replacePanelMessageId({
        orderId: projection.orderId,
        expectedPanelMessageId: projection.panelMessageId,
        panelMessageId: result.messageId
      });
    }
  };
}
