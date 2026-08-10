import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { giftAutomationCoverage } from './support/gift-automation-coverage';

const expectedIds = [
  ...Array.from({ length: 9 }, (_, index) => `GTA-S-${String(index + 1).padStart(3, '0')}`),
  ...Array.from({ length: 8 }, (_, index) => `GTA-O-${String(index + 1).padStart(3, '0')}`),
  ...Array.from({ length: 11 }, (_, index) => `GTA-A-${String(index + 1).padStart(3, '0')}`),
  ...Array.from({ length: 12 }, (_, index) => `GTA-L-${String(index + 1).padStart(3, '0')}`),
  ...Array.from({ length: 8 }, (_, index) => `GTA-B-${String(index + 1).padStart(3, '0')}`)
];

describe('M22-US-06 gift non-UI automation gate', () => {
  test('maps every planned GTA case exactly once', () => {
    const ids = giftAutomationCoverage.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...expectedIds].sort());
  });

  test('references executable tests without skip or todo placeholders', async () => {
    const files = [...new Set(giftAutomationCoverage.flatMap(({ sources }) => sources.map(({ file }) => file)))];
    const contents = new Map(await Promise.all(files.map(async (file) => [file, await readFile(file, 'utf8')] as const)));
    for (const coverage of giftAutomationCoverage) {
      expect(coverage.sources.length, coverage.id).toBeGreaterThan(0);
      for (const source of coverage.sources) {
        const content = contents.get(source.file) ?? '';
        expect(content, `${coverage.id}: ${source.file} must contain ${source.test}`).toContain(source.test);
        expect(content, `${source.file} cannot contain disabled tests`).not.toMatch(/(?:test|it|describe)\.(?:skip|todo)\s*\(/u);
      }
    }
  });

  test('runs every mapped file from the dedicated package command', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> };
    const command = packageJson.scripts['test:gift:non-ui'] ?? '';
    for (const file of new Set(giftAutomationCoverage.flatMap(({ sources }) => sources.map(({ file }) => file)))) {
      const included = command.includes(file)
        || (file.startsWith('tests/m22-us-06-') && command.includes('tests/m22-us-06-*.spec.ts'));
      expect(included, `${file} is missing from test:gift:non-ui`).toBe(true);
    }
  });
});
