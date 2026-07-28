import { readFile, readdir, stat } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { buildAcceptanceMatrix } from '../scripts/build-p0-acceptance-matrix.mjs';

describe('M18-US-08 release audit', () => {
  test('keeps the complete original visual asset set available for Discord UAT', async () => {
    const [dispatch, games] = await Promise.all([
      readdir('apps/api/assets/dispatch'),
      readdir('apps/api/assets/game-banners')
    ]);
    const gameImages = games.filter((name) => name.endsWith('.webp')).sort();

    expect(dispatch.sort()).toEqual(['dispatching.png', 'order-cancelled.png']);
    expect(gameImages).toEqual([
      'apex-legends.webp',
      'chat-minigames.webp',
      'cs2-csgo.webp',
      'delta-force.webp',
      'dota2.webp',
      'league-of-legends.webp',
      'naraka-bladepoint.webp',
      'other.webp',
      'overwatch.webp',
      'pubg.webp',
      'singing-voice.webp',
      'tft.webp',
      'valorant.webp'
    ]);
    expect(games.some((name) => name.endsWith('.png'))).toBe(false);

    const welcomePath = 'apps/api/assets/onboarding/welcome.webp';
    const welcome = await readFile(welcomePath);
    expect(webpDimensions(welcome)).toEqual({ width: 1600, height: 535 });
    expect((await stat(welcomePath)).size).toBeLessThanOrEqual(550_000);

    for (const fileName of gameImages) {
      const path = `apps/api/assets/game-banners/${fileName}`;
      expect(webpDimensions(await readFile(path))).toEqual({ width: 1600, height: 800 });
      expect((await stat(path)).size).toBeLessThanOrEqual(550_000);
    }
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

function webpDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('Expected a WebP RIFF container.');
  }
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  throw new Error(`Unsupported WebP chunk: ${chunk}`);
}
