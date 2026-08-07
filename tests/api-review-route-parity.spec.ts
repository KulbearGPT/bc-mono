import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

describe('API review route parity gate', () => {
  test('checks OpenAPI and runtime routes in both directions', () => {
    const output = execFileSync(process.execPath, ['scripts/check-api-route-contracts.mjs'], { encoding: 'utf8' });
    expect(output.toLowerCase()).toContain('bidirectional route contract parity passed');
    expect(output).toMatch(/\d+ production operations exactly match OpenAPI/u);
  });
});
