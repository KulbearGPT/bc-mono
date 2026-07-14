import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function collectBotTestFiles(root) {
  const testsDirectory = resolve(root, 'tests');
  const names = (await readdir(testsDirectory))
    .filter((name) => name.endsWith('.spec.ts'))
    .sort();
  const selected = [];
  for (const name of names) {
    const source = await readFile(resolve(testsDirectory, name), 'utf8');
    if (/(?:@blackcat\/bot|(?:\.\.\/)?apps\/bot\/src)/u.test(source)) {
      selected.push(`tests/${name}`);
    }
  }
  if (!selected.length) throw new Error('Bot test discovery returned no test files.');
  return selected;
}

async function main() {
  const root = resolve(process.cwd());
  const files = await collectBotTestFiles(root);
  process.stdout.write(`Running ${files.length} Bot test files.\n`);
  const result = spawnSync(
    process.execPath,
    [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', ...files],
    { cwd: root, stdio: 'inherit' }
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
