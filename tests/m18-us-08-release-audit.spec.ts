import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { buildAcceptanceMatrix } from '../scripts/build-p0-acceptance-matrix.mjs';

describe('M18-US-08 release audit', () => {
  test('keeps the complete original visual asset set available for Discord UAT', async () => {
    const [dispatch, games] = await Promise.all([
      readdir('apps/api/assets/dispatch'),
      readdir('apps/api/assets/game-banners')
    ]);

    expect(dispatch.sort()).toEqual(['dispatching.png', 'order-cancelled.png']);
    expect(games.filter((name) => name.endsWith('.png')).sort()).toEqual([
      'apex-legends.png',
      'chat-minigames.png',
      'cs2-csgo.png',
      'delta-force.png',
      'dota2.png',
      'league-of-legends.png',
      'naraka-bladepoint.png',
      'other.png',
      'overwatch.png',
      'pubg.png',
      'singing-voice.png',
      'tft.png',
      'valorant.png'
    ]);
  });

  test('makes live sample delivery explicit, mention-safe, and idempotent without business writes', async () => {
    const script = await readFile('scripts/uat/m18-discord-visual-samples.ts', 'utf8');

    expect(script).toContain("M18_UAT_CONFIRM !== 'SEND_VISUAL_SAMPLES'");
    expect(script).toContain("const MARKER = '[M18_VISUAL_SAMPLE_V1]'");
    expect(script.match(/allowedMentions: \{ parse: \[\] \}/gu)).toHaveLength(5);
    expect(script).toContain('/api/v1/admin/bot-config?guildId=');
    expect(script).toContain('readOnlyApiCalls: 1');
    expect(script).toContain('businessMutationCalls: 0');
    expect(script).not.toMatch(/method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/u);
  });

  test('keeps automated terminology covered and every visual or risk UAT fail-closed', async () => {
    const matrix = await buildAcceptanceMatrix(process.cwd());
    const experience = matrix.filter((row) => row.acceptance_id.startsWith('AT-EXP-'));

    expect(experience.map((row) => [row.acceptance_id, row.execution_class, row.candidate_status])).toEqual([
      ['AT-EXP-001', 'AUTOMATED', 'COVERED_BY_REGRESSION'],
      ['AT-EXP-002', 'EXTERNAL_E2E', 'PENDING_EXTERNAL'],
      ['AT-EXP-003', 'EXTERNAL_E2E', 'PENDING_EXTERNAL'],
      ['AT-EXP-004', 'EXTERNAL_E2E', 'PENDING_EXTERNAL'],
      ['AT-EXP-005', 'EXTERNAL_E2E', 'PENDING_EXTERNAL']
    ]);
  });
});
