import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

describe('M2-US-03 Bot accepted dispatch channel sync', () => {
  test('keeps accepted-player channel membership behind API reconciliation', async () => {
    const source = await readFile('apps/bot/src/service-center.ts', 'utf8');
    expect(source).not.toContain('buildAcceptedPlayerChannelPermissionPlan');
    expect(source).not.toContain('rejectedCandidateDiscordUserIds');
  });

  test('does not retain the retired availability-based ineligible helper', async () => {
    const source = await readFile('apps/bot/src/service-center-entry.ts', 'utf8');
    expect(source).not.toContain('buildDispatchIneligibleReply');
    expect(source).not.toContain('availability');
  });
});
