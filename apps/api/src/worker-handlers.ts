import type { OutboxHandler } from './worker-runtime.js';

export interface DispatchMessageStore {
  getDispatchMessageId(dispatchAttemptId: string): Promise<string | null>;
  recordDispatchMessageId(input: {
    dispatchAttemptId: string;
    messageId: string;
  }): Promise<void>;
  replaceDispatchMessageId(input: {
    dispatchAttemptId: string;
    expectedMessageId: string;
    messageId: string;
  }): Promise<void>;
}

export interface DispatchOfferDiscordAdapter {
  upsertDispatchOffer(
    payload: Record<string, unknown>,
    existingMessageId: string | null,
    notBefore: string
  ): Promise<{ messageId: string; recreated: boolean }>;
}

export function createDispatchMessageHandler(input: {
  store: DispatchMessageStore;
  discord: DispatchOfferDiscordAdapter;
}): OutboxHandler {
  return async (job) => {
    if (job.type !== 'DISPATCH_MESSAGE') throw new Error('Expected a DISPATCH_MESSAGE job.');
    const payload = job.payload as Record<string, unknown> | null;
    if (!payload || typeof payload.dispatchAttemptId !== 'string' || typeof payload.dispatchChannelId !== 'string'
      || payload.dispatchAttemptId !== job.aggregateId) {
      throw new Error('Dispatch message payload is invalid.');
    }
    const existingMessageId = await input.store.getDispatchMessageId(payload.dispatchAttemptId);
    const result = await input.discord.upsertDispatchOffer(payload, existingMessageId, job.createdAt);
    if (!existingMessageId) {
      await input.store.recordDispatchMessageId({
        dispatchAttemptId: payload.dispatchAttemptId,
        messageId: result.messageId
      });
    } else if (result.recreated && result.messageId !== existingMessageId) {
      await input.store.replaceDispatchMessageId({
        dispatchAttemptId: payload.dispatchAttemptId,
        expectedMessageId: existingMessageId,
        messageId: result.messageId
      });
    }
  };
}

export function createDispatchTimeoutHandler(input: {
  expire: (dispatchAttemptId: string) => Promise<unknown>;
}): OutboxHandler {
  return async (job) => {
    if (job.type !== 'DISPATCH_TIMEOUT') throw new Error('Expected a DISPATCH_TIMEOUT job.');
    const payload = job.payload as { dispatchAttemptId?: unknown } | null;
    if (!payload || typeof payload.dispatchAttemptId !== 'string' || payload.dispatchAttemptId !== job.aggregateId) {
      throw new Error('Dispatch timeout payload is invalid.');
    }
    await input.expire(payload.dispatchAttemptId);
  };
}

export function createReadinessTimeoutHandler(input: {
  expire: (job: Parameters<OutboxHandler>[0]) => Promise<unknown>;
}): OutboxHandler {
  return async (job) => {
    if (job.type !== 'READINESS_TIMEOUT') throw new Error('Expected a READINESS_TIMEOUT job.');
    const payload = job.payload as { orderId?: unknown; readinessDueAt?: unknown } | null;
    if (!payload || typeof payload.orderId !== 'string' || typeof payload.readinessDueAt !== 'string'
      || payload.orderId !== job.aggregateId) {
      throw new Error('Readiness timeout payload is invalid.');
    }
    await input.expire(job);
  };
}

export function createChannelArchiveHandler(input: {
  archive: (channelId: string) => Promise<unknown>;
}): OutboxHandler {
  return async (job) => {
    if (job.type !== 'CHANNEL_ARCHIVE') throw new Error('Expected a CHANNEL_ARCHIVE job.');
    const payload = job.payload as { orderId?: unknown; channelId?: unknown } | null;
    if (!payload || typeof payload.orderId !== 'string' || typeof payload.channelId !== 'string'
      || payload.orderId !== job.aggregateId) {
      throw new Error('Channel archive payload is invalid.');
    }
    await input.archive(payload.channelId);
  };
}

export function createRoleReconciliationHandler(input: {
  reconcile: (guildId: string, mappingVersion: number, observedAt: string) => Promise<unknown>;
}): OutboxHandler {
  return async (job) => {
    if (job.type !== 'ROLE_RECONCILIATION') throw new Error('Expected a ROLE_RECONCILIATION job.');
    const payload = job.payload as { guildId?: unknown; mappingVersion?: unknown } | null;
    if (!payload || typeof payload.guildId !== 'string' || !Number.isSafeInteger(payload.mappingVersion)
      || Number(payload.mappingVersion) < 1) {
      throw new Error('Role reconciliation payload is invalid.');
    }
    await input.reconcile(payload.guildId, Number(payload.mappingVersion), job.createdAt);
  };
}
