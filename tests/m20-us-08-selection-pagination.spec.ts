import { describe, expect, test, vi } from 'vitest';
import { toDiscordUpdate } from '../apps/bot/src/discord-renderer';
import {
  buildSelectionCandidatePanel,
  mergeSelectionCandidates,
  parseSelectionCustomId,
  selectionIdsFromConfirmationComponents
} from '@blackcat/bot/selection-discord';
import { loadSelectionApplicationPage } from '../apps/bot/src/pieces/interaction-handlers/dispatch-buttons';

const orderId = '11111111-1111-4111-8111-111111111111';
const poolId = '22222222-2222-4222-8222-222222222222';
const visibleApplicationId = '33333333-3333-4333-8333-333333333333';
const offPageApplicationId = '44444444-4444-4444-8444-444444444444';

describe('M20-US-08 selection pagination', () => {
  test('never embeds a 500-character API cursor in Discord custom IDs', () => {
    const panel = candidatePanel({ nextCursor: `c1_${'a'.repeat(497)}`, pageIndex: 0 });

    expect(() => toDiscordUpdate(panel)).not.toThrow();
    for (const component of panel.components.flatMap((row) => row.components)) {
      expect(component.customId.length).toBeLessThanOrEqual(100);
      expect(component.customId).not.toContain('c1_');
    }
  });

  test('renders compact previous and next routes on an interior page', () => {
    const panel = candidatePanel({ nextCursor: 'c1_next-page-cursor-1234567890', pageIndex: 4 });
    const pageButtons = panel.components
      .flatMap((row) => row.components)
      .filter((component) => component.type === 'BUTTON' && /上一页|下一页/u.test(component.label));

    expect(pageButtons.map((button) => button.label)).toEqual(['← 上一页', '下一页 →']);
    expect(pageButtons.map((button) => parseSelectionCustomId(button.customId))).toEqual([
      expect.objectContaining({ action: 'page', pageIndex: 3 }),
      expect.objectContaining({ action: 'page', pageIndex: 5 })
    ]);
  });

  test('carries an off-page selected application in Discord message components', () => {
    const panel = candidatePanel({
      nextCursor: 'c1_next-page-cursor-1234567890',
      pageIndex: 2,
      selectedApplicationIds: [offPageApplicationId]
    });
    const rendered = toDiscordUpdate(panel);
    const raw = JSON.parse(JSON.stringify(rendered.components));

    expect(selectionIdsFromConfirmationComponents(raw)).toEqual([offPageApplicationId]);
  });

  test('keeps the compact page route below Discord limits at large page numbers', () => {
    const panel = candidatePanel({ nextCursor: 'c1_next-page-cursor-1234567890', pageIndex: 9_999 });
    const next = panel.components
      .flatMap((row) => row.components)
      .find((component) => component.type === 'BUTTON' && component.label === '下一页 →');
    if (!next || next.type !== 'BUTTON') throw new Error('Expected next-page button.');

    expect(next.customId.length).toBeLessThanOrEqual(100);
    expect(parseSelectionCustomId(next.customId)).toMatchObject({ action: 'page', pageIndex: 10_000 });
  });

  test('resolves a page by following API cursors without exposing them to Discord', async () => {
    const cursor1 = `c1_${'a'.repeat(497)}`;
    const cursor2 = `c1_${'b'.repeat(497)}`;
    const listSelectionApplications = vi
      .fn()
      .mockResolvedValueOnce({ items: [], nextCursor: cursor1, pool: { version: 4 } })
      .mockResolvedValueOnce({ items: [], nextCursor: cursor2, pool: { version: 4 } })
      .mockResolvedValueOnce({ items: [{ id: visibleApplicationId }], nextCursor: null, pool: { version: 4 } });

    const page = await loadSelectionApplicationPage({
      api: { listSelectionApplications } as never,
      actor: {
        guildId: 'guild-1',
        discordUserId: 'customer-1',
        interactionId: 'page-1',
        clientSource: 'DISCORD_BOT'
      },
      orderId,
      poolId,
      pageIndex: 2
    });

    expect(listSelectionApplications.mock.calls.map((call) => call[3])).toEqual([undefined, cursor1, cursor2]);
    expect(page.items).toEqual([{ id: visibleApplicationId }]);
  });

  test('retains off-page selections and replaces the current-page subset', () => {
    const merged = mergeSelectionCandidates({
      retainedCandidates: [
        { id: offPageApplicationId, playerDisplayName: '离页陪玩' },
        { id: visibleApplicationId, playerDisplayName: '旧的本页陪玩' }
      ],
      currentPageCandidates: [
        { id: visibleApplicationId, playerDisplayName: '奶糖' },
        { id: '66666666-6666-4666-8666-666666666666', playerDisplayName: '新陪玩' }
      ],
      selectedCurrentPageIds: ['66666666-6666-4666-8666-666666666666']
    });

    expect(merged).toEqual([
      { id: offPageApplicationId, playerDisplayName: '离页陪玩' },
      { id: '66666666-6666-4666-8666-666666666666', playerDisplayName: '新陪玩' }
    ]);
  });
});

function candidatePanel(input: {
  nextCursor: string | null;
  pageIndex: number;
  selectedApplicationIds?: string[];
}) {
  return buildSelectionCandidatePanel({
    orderId,
    poolId,
    poolVersion: 4,
    orderVersion: 7,
    items: [
      {
        id: visibleApplicationId,
        playerDisplayName: '奶糖',
        orderRequirementId: '55555555-5555-4555-8555-555555555555',
        publicGameTags: ['瓦洛兰特'],
        publicServiceTags: ['娱乐陪玩']
      }
    ],
    nextCursor: input.nextCursor,
    selectedApplicationIds: input.selectedApplicationIds ?? [],
    pageIndex: input.pageIndex
  } as Parameters<typeof buildSelectionCandidatePanel>[0] & { pageIndex: number });
}
