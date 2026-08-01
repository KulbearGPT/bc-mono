import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { buildTranscriptEventId, resolveTranscriptUpdateMessage } from '@blackcat/bot/order-channel-transcript';
import {
  SelectionReactionObservationTracker,
  buildReconciliationObservationIdentity,
  handleSelectionReactionEvent
} from '@blackcat/bot/selection-reactions';

describe('M20-US-12 stable Discord event identity', () => {
  test('keeps gateway update replays stable while preserving distinct same-millisecond edits', () => {
    const base = {
      id: 'message-1',
      editedTimestamp: 1_786_440_000_123,
      content: 'first edit',
      embeds: [],
      attachments: []
    };
    expect(buildTranscriptEventId(base, 'UPDATED')).toBe(buildTranscriptEventId(base, 'UPDATED'));
    expect(buildTranscriptEventId(base, 'UPDATED')).not.toBe(
      buildTranscriptEventId({ ...base, content: 'second edit' }, 'UPDATED')
    );
    expect(buildTranscriptEventId({ ...base, editedTimestamp: null }, 'UPDATED')).toBeNull();
  });

  test('fetches partial updates before recording and fails closed when Discord cannot resolve them', async () => {
    const resolved = { id: 'message-1', partial: false, editedTimestamp: Date.now() };
    const fetch = vi.fn().mockResolvedValue(resolved);
    await expect(resolveTranscriptUpdateMessage({ partial: true, fetch } as never)).resolves.toBe(resolved);
    await expect(
      resolveTranscriptUpdateMessage({ partial: true, fetch: vi.fn().mockRejectedValue(new Error('gone')) } as never)
    ).resolves.toBeNull();
  });

  test('deduplicates same-state gateway replays but advances identity across add/remove/add transitions', () => {
    const tracker = new SelectionReactionObservationTracker();
    const key = 'guild:channel:message:emoji:user';
    const add1 = tracker.observe(key, 'ADDED');
    expect(tracker.observe(key, 'ADDED')).toBe(add1);
    const remove = tracker.observe(key, 'REMOVED');
    const add2 = tracker.observe(key, 'ADDED');
    expect(remove).not.toBe(add1);
    expect(add2).not.toBe(add1);
  });

  test('uses the transition identity for both Actor Context and API idempotency', async () => {
    const observeSelectionReaction = vi.fn().mockResolvedValue({ changed: true, state: 'APPLIED' });
    const common = {
      reaction: {
        emoji: { name: '1️⃣' },
        message: { id: 'message-live', channelId: 'channel-live', guildId: 'guild-live' }
      },
      user: { id: 'user-live', bot: false, send: vi.fn() },
      api: { observeSelectionReaction },
      logger: { error: vi.fn() },
      removeUserReaction: vi.fn()
    };
    await handleSelectionReactionEvent({ ...common, state: 'ADDED' });
    await handleSelectionReactionEvent({ ...common, state: 'ADDED' });
    await handleSelectionReactionEvent({ ...common, state: 'REMOVED' });
    await handleSelectionReactionEvent({ ...common, state: 'ADDED' });

    const keys = observeSelectionReaction.mock.calls.map((call) => call[2] as string);
    const actorIds = observeSelectionReaction.mock.calls.map((call) => call[1].interactionId as string);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
    expect(keys[3]).not.toBe(keys[1]);
    expect(keys.map((key) => key.replace('selection-reaction:', ''))).toEqual(actorIds);
  });

  test('makes startup reconciliation identity reproducible from the full observed snapshot', async () => {
    const input = {
      poolId: 'pool-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      emoji: '1️⃣',
      discordUserId: 'user-1',
      state: 'ADDED' as const,
      discordUserIds: ['user-2', 'user-1'],
      appliedDiscordUserIds: ['user-2']
    };
    expect(buildReconciliationObservationIdentity(input)).toBe(
      buildReconciliationObservationIdentity({
        ...input,
        discordUserIds: ['user-1', 'user-2']
      })
    );
    const source = await readFile('apps/bot/src/selection-reactions.ts', 'utf8');
    expect(source).not.toContain('randomUUID');
  });
});
