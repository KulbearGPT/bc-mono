import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();

describe('M9-US-07 provider retirement and Railway gate', () => {
  test('does not require a funding provider in production configuration', async () => {
    const [validator, example, rootPackage] = await Promise.all([
      readFile(resolve(root, 'modules/platform/src/production-env.js'), 'utf8'),
      readFile(resolve(root, '.env.example'), 'utf8'),
      readFile(resolve(root, 'package.json'), 'utf8')
    ]);
    expect(validator).not.toContain('FUNDING_ADAPTER');
    expect(example).not.toContain('FUNDING_ADAPTER');
    expect(example).not.toContain('SANDBOX_FUNDING');
    expect(rootPackage).not.toContain('sandbox:provision');
  });

  test('documents migrations, health checks and separate Railway processes', async () => {
    const guide = await readFile(resolve(root, 'docs/runbooks/Railway-Sandbox测试部署手册.md'), 'utf8');
    expect(guide).toContain('db:migrate:deploy');
    expect(guide).toContain('/ready');
    expect(guide).toContain('npm run start:web');
    expect(guide).toContain('npm run start:bot');
    expect(guide).not.toContain('sandbox:provision');
  });
});
