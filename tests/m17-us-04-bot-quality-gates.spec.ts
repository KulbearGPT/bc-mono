import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

describe('M17-US-04 Bot engineering quality gates', () => {
  test('root scripts expose one reproducible Bot quality command', async () => {
    const rootPackage = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(rootPackage.scripts['lint:bot']).toBe('eslint apps/bot/src --max-warnings 0');
    expect(rootPackage.scripts['format:bot:check']).toBe('prettier --check apps/bot/src');
    expect(rootPackage.scripts['test:bot']).toBe('node scripts/run-bot-tests.mjs');
    expect(rootPackage.scripts['quality:bot']).toContain('npm run lint:bot');
    expect(rootPackage.scripts['quality:bot']).toContain('npm run format:bot:check');
    expect(rootPackage.scripts['quality:bot']).toContain('npm run typecheck -w @blackcat/bot');
    expect(rootPackage.scripts['quality:bot']).toContain('npm run build');
    expect(rootPackage.scripts['quality:bot']).toContain('npm run pieces -w @blackcat/bot');
    expect(rootPackage.scripts['quality:bot']).toContain('npm run test:bot');
  });

  test('ESLint includes Bot TypeScript under the same zero-error rules', async () => {
    const eslintConfig = await readFile('eslint.config.js', 'utf8');
    expect(eslintConfig).toContain("'apps/bot/src/**/*.ts'");
  });

  test('Bot test discovery is deterministic and covers behavior, pieces and M17 regressions', async () => {
    const { collectBotTestFiles } = await import('../scripts/run-bot-tests.mjs');
    const files = await collectBotTestFiles(process.cwd());

    expect(files).toEqual([...files].sort());
    expect(files).toEqual(expect.arrayContaining([
      'tests/m1-us-04-bot.spec.ts',
      'tests/m11-us-03-selection-discord.spec.ts',
      'tests/m17-us-02-private-channel-adapter.spec.ts',
      'tests/m17-us-03-bot-readiness.spec.ts'
    ]));
    expect(files).not.toContain('tests/m16-us-03-dashboard-consistency.spec.ts');
  });
});
