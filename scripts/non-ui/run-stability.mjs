import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const requiredRuns = 10;
const startedAt = new Date().toISOString();
const reportDirectory = resolve(process.env.NON_UI_REPORT_DIR?.trim() || 'test-results/non-ui');
const runId = process.env.NON_UI_RUN_ID?.trim() || process.env.GITHUB_RUN_ID?.trim() || `stability-${Date.now()}`;
const iterations = [];
await mkdir(reportDirectory, { recursive: true });

for (let iteration = 1; iteration <= requiredRuns; iteration += 1) {
  const iterationStarted = Date.now();
  process.stdout.write(`\n=== Non-UI full stability ${iteration}/${requiredRuns} ===\n`);
  const code = await runFull(iteration);
  iterations.push({ iteration, status: code === 0 ? 'PASSED' : 'FAILED', durationMs: Date.now() - iterationStarted });
  if (code !== 0) break;
}

const passed = iterations.filter(({ status }) => status === 'PASSED').length;
const report = {
  schemaVersion: 1,
  gate: 'full-stability',
  status: passed === requiredRuns ? 'PASSED' : 'FAILED',
  requiredRuns,
  passedRuns: passed,
  startedAt,
  completedAt: new Date().toISOString(),
  iterations
};
const reportPath = resolve(reportDirectory, `stability-${runId}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`\nNon-UI stability report: ${reportPath}\n`);
if (report.status !== 'PASSED') process.exitCode = 1;

function runFull(iteration) {
  return new Promise((resolveCode, reject) => {
    const child = spawn(process.execPath, ['scripts/non-ui/run-layered-gate.mjs', 'full'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        NON_UI_REPORT_DIR: reportDirectory,
        NON_UI_RUN_ID: `${runId}-${String(iteration).padStart(2, '0')}`
      },
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveCode(signal ? 1 : (code ?? 1)));
  });
}
