import { spawn } from 'node:child_process';
import process from 'node:process';

const gate = process.argv[2];
const filesByGate = {
  a0: ['tests/non-ui/nui-a0-harness.spec.ts']
};

const files = filesByGate[gate];
if (!files) {
  throw new Error(`Unknown non-UI gate '${gate ?? ''}'. Available gates: ${Object.keys(filesByGate).join(', ')}`);
}

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['./node_modules/vitest/vitest.mjs', 'run', ...files], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'inherit'
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (signal) reject(new Error(`Non-UI gate ${gate} terminated by ${signal}.`));
    else if (code === 0) resolve();
    else reject(new Error(`Non-UI gate ${gate} failed with exit code ${code}.`));
  });
});
