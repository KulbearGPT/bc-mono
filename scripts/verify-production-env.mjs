import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export { validateProductionEnv } from '../modules/platform/src/production-env.js';
import { validateProductionEnv } from '../modules/platform/src/production-env.js';
function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/u).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('='); return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = resolve(process.argv[2] ?? '.env.production');
  const errors = validateProductionEnv(parseEnv(await readFile(path, 'utf8')));
  if (errors.length) { process.stderr.write(`${errors.join('\n')}\n`); process.exitCode = 1; }
  else process.stdout.write('production-env-ok\n');
}
