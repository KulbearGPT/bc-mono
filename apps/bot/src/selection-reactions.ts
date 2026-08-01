import { createHash } from 'node:crypto';
import { buildBotEventActorContext, type DiscordBotActorContext } from './actor-context.js';
import type { SelectionReactionCard, SelectionReactionObservationResult } from './service-center-api.js';

export type SelectionReactionState = 'ADDED' | 'REMOVED';

const SUPPORTED_REACTIONS = new Set(['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣']);
const reactionQueues = new Map<string, Promise<{ handled: boolean }>>();

export class SelectionReactionObservationTracker {
  private readonly observations = new Map<
    string,
    { state: SelectionReactionState; generation: number; seenAt: number }
  >();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  public constructor(input: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}) {
    this.now = input.now ?? Date.now;
    this.ttlMs = input.ttlMs ?? 30 * 60_000;
    this.maxEntries = input.maxEntries ?? 10_000;
  }

  public observe(key: string, state: SelectionReactionState): string {
    const now = this.now();
    this.prune(now);
    const previous = this.observations.get(key);
    const generation = previous ? previous.generation + (previous.state === state ? 0 : 1) : 1;
    this.observations.delete(key);
    this.observations.set(key, { state, generation, seenAt: now });
    return stableIdentity(`live:${key}:${generation}:${state}`);
  }

  private prune(now: number): void {
    for (const [key, value] of this.observations) {
      if (value.seenAt + this.ttlMs > now && this.observations.size < this.maxEntries) break;
      this.observations.delete(key);
    }
  }
}

export function buildReconciliationObservationIdentity(input: {
  poolId: string;
  channelId: string;
  messageId: string;
  emoji: string;
  discordUserId: string;
  state: SelectionReactionState;
  discordUserIds: string[];
  appliedDiscordUserIds: string[];
}): string {
  return stableIdentity(
    [
      'reconcile',
      input.poolId,
      input.channelId,
      input.messageId,
      input.emoji,
      input.discordUserId,
      input.state,
      [...input.discordUserIds].sort().join(','),
      [...input.appliedDiscordUserIds].sort().join(',')
    ].join(':')
  );
}

const reactionObservationTracker = new SelectionReactionObservationTracker();

interface SelectionReactionApi {
  observeSelectionReaction(
    input: { channelId: string; messageId: string; emoji: string; state: SelectionReactionState },
    actor: DiscordBotActorContext,
    idempotencyKey: string
  ): Promise<SelectionReactionObservationResult>;
}

interface SelectionReactionLogger {
  error(value: unknown): void;
}

export async function handleSelectionReactionEvent(input: {
  state: SelectionReactionState;
  reaction: {
    emoji: { name: string | null };
    message: { id: string; channelId: string; guildId: string | null };
  };
  user: { id: string; bot: boolean; send(content: string): Promise<unknown> };
  api: SelectionReactionApi;
  logger: SelectionReactionLogger;
  removeUserReaction(): Promise<unknown>;
}): Promise<{ handled: boolean }> {
  const queueKey = [
    input.reaction.message.guildId,
    input.reaction.message.channelId,
    input.reaction.message.id,
    input.reaction.emoji.name,
    input.user.id
  ].join(':');
  const previous = reactionQueues.get(queueKey);
  const current = (previous ? previous.catch(() => ({ handled: true })) : Promise.resolve({ handled: false })).then(
    () => processSelectionReactionEvent(input)
  );
  reactionQueues.set(queueKey, current);
  try {
    return await current;
  } finally {
    if (reactionQueues.get(queueKey) === current) reactionQueues.delete(queueKey);
  }
}

async function processSelectionReactionEvent(input: Parameters<typeof handleSelectionReactionEvent>[0]) {
  const emoji = input.reaction.emoji.name;
  const guildId = input.reaction.message.guildId;
  if (input.user.bot || !emoji || !SUPPORTED_REACTIONS.has(emoji) || !guildId) return { handled: false };
  const sourceEventId = reactionObservationTracker.observe(queueKeyFor(input), input.state);
  const actor = buildBotEventActorContext({
    guildId,
    discordUserId: input.user.id,
    sourceEventId
  });
  if (!actor) return { handled: false };
  try {
    await input.api.observeSelectionReaction(
      {
        channelId: input.reaction.message.channelId,
        messageId: input.reaction.message.id,
        emoji,
        state: input.state
      },
      actor,
      `selection-reaction:${sourceEventId}`
    );
    return { handled: true };
  } catch (error) {
    input.logger.error({
      event: 'bot.selection_reaction.failed',
      state: input.state,
      guildId,
      channelId: input.reaction.message.channelId,
      messageId: input.reaction.message.id,
      discordUserId: input.user.id,
      emoji,
      error
    });
    if (input.state === 'ADDED') {
      await Promise.resolve(input.removeUserReaction()).catch(() => undefined);
      await Promise.resolve(
        input.user.send(
          '这次报名未能确认，我已移除对应 Reaction。请稍后重试；如果持续失败，请把时间和订单编号提供给管理员。'
        )
      ).catch(() => undefined);
    }
    return { handled: true };
  }
}

export async function reconcileSelectionReactionCards(input: {
  guildId: string;
  api: SelectionReactionApi & {
    listActiveSelectionReactionCards(guildId: string): Promise<{ items: SelectionReactionCard[] }>;
  };
  fetchReactionUserIds(card: SelectionReactionCard, emoji: string): Promise<string[]>;
  logger: SelectionReactionLogger;
}): Promise<{ added: number; removed: number; failed: number }> {
  const cards = await input.api.listActiveSelectionReactionCards(input.guildId);
  const result = { added: 0, removed: 0, failed: 0 };
  for (const card of cards.items) {
    for (const binding of card.bindings) {
      let discordUsers: string[];
      try {
        discordUsers = await input.fetchReactionUserIds(card, binding.emoji);
      } catch (error) {
        result.failed += 1;
        input.logger.error({
          event: 'bot.selection_reaction.reconcile_fetch_failed',
          card,
          emoji: binding.emoji,
          error
        });
        continue;
      }
      const discord = new Set(discordUsers);
      const applied = new Set(binding.appliedDiscordUserIds);
      for (const discordUserId of discord) {
        if (applied.has(discordUserId)) continue;
        if (
          await submitReconciled(
            input,
            card,
            binding.emoji,
            discordUserId,
            'ADDED',
            discordUsers,
            binding.appliedDiscordUserIds
          )
        )
          result.added += 1;
        else result.failed += 1;
      }
      for (const discordUserId of applied) {
        if (discord.has(discordUserId)) continue;
        if (
          await submitReconciled(
            input,
            card,
            binding.emoji,
            discordUserId,
            'REMOVED',
            discordUsers,
            binding.appliedDiscordUserIds
          )
        )
          result.removed += 1;
        else result.failed += 1;
      }
    }
  }
  return result;
}

async function submitReconciled(
  input: Parameters<typeof reconcileSelectionReactionCards>[0],
  card: SelectionReactionCard,
  emoji: string,
  discordUserId: string,
  state: SelectionReactionState,
  discordUserIds: string[],
  appliedDiscordUserIds: string[]
) {
  const sourceEventId = buildReconciliationObservationIdentity({
    poolId: card.poolId,
    channelId: card.channelId,
    messageId: card.messageId,
    emoji,
    discordUserId,
    state,
    discordUserIds,
    appliedDiscordUserIds
  });
  const actor = buildBotEventActorContext({ guildId: input.guildId, discordUserId, sourceEventId });
  if (!actor) return false;
  try {
    await input.api.observeSelectionReaction(
      { channelId: card.channelId, messageId: card.messageId, emoji, state },
      actor,
      `selection-reaction-reconcile:${sourceEventId}`
    );
    return true;
  } catch (error) {
    input.logger.error({
      event: 'bot.selection_reaction.reconcile_submit_failed',
      poolId: card.poolId,
      discordUserId,
      emoji,
      state,
      error
    });
    return false;
  }
}

function queueKeyFor(input: Parameters<typeof handleSelectionReactionEvent>[0]): string {
  return [
    input.reaction.message.guildId,
    input.reaction.message.channelId,
    input.reaction.message.id,
    input.reaction.emoji.name,
    input.user.id
  ].join(':');
}

function stableIdentity(value: string): string {
  return `sr:${createHash('sha256').update(value).digest('hex').slice(0, 29)}`;
}
