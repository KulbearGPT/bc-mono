import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

const run = promisify(execFile);

if (process.env.NODE_ENV !== 'test') {
  throw new Error('Non-UI automation environment verification requires NODE_ENV=test.');
}

const binaries = ['initdb', 'pg_ctl', 'createdb', 'psql'];
const versions = {};
for (const binary of binaries) {
  const { stdout, stderr } = await run(binary, ['--version']);
  versions[binary] = (stdout || stderr).trim();
}

process.stdout.write(`${JSON.stringify({ status: 'READY', nodeEnv: process.env.NODE_ENV, binaries: versions })}\n`);
