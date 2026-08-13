import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { buildFailureArtifact, gateDefinitions, sanitizeGateOutput } from './gate-definition.mjs';

class GateStepError extends Error {
  constructor(message, output) {
    super(message);
    this.output = sanitizeGateOutput(output.slice(-100_000));
  }
}

const gate = process.argv[2];
if (!gateDefinitions[gate]) {
  throw new Error(`Unknown non-UI layer '${gate ?? ''}'. Available layers: ${Object.keys(gateDefinitions).join(', ')}`);
}

const commitSha = await gitSha();
const runId = process.env.NON_UI_RUN_ID?.trim() || process.env.GITHUB_RUN_ID?.trim() || `local-${Date.now()}`;
const reportDirectory = resolve(process.env.NON_UI_REPORT_DIR?.trim() || 'test-results/non-ui');
const reportPath = resolve(reportDirectory, `${gate}-${runId}.json`);
const startedAt = new Date().toISOString();
const results = [];
await mkdir(reportDirectory, { recursive: true });

try {
  await executeLayer(gate, new Set());
  await persistReport('PASSED');
} catch (error) {
  const failed = results.findLast(({ status }) => status === 'FAILED');
  const output = error instanceof GateStepError ? error.output : String(error);
  const artifact = buildFailureArtifact({
    gate,
    stepId: failed?.id ?? 'gate-definition',
    commitSha,
    runId,
    output,
    failedAt: new Date().toISOString()
  });
  await writeFile(
    resolve(reportDirectory, `${gate}-${runId}-failure.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8'
  );
  await persistReport('FAILED');
  process.exitCode = 1;
}

async function executeLayer(layer, completedLayers) {
  if (completedLayers.has(layer)) return;
  const definition = gateDefinitions[layer];
  for (const item of definition.preflight) await executeStep(layer, item);
  for (const included of definition.includes) await executeLayer(included, completedLayers);
  for (const item of definition.steps) await executeStep(layer, item);
  completedLayers.add(layer);
}

async function executeStep(layer, item) {
  const started = Date.now();
  const output = [];
  process.stdout.write(`\n[non-ui:${gate}] ${layer}:${item.id}\n`);
  const code = await new Promise((resolveCode, reject) => {
    const child = spawn(item.command, item.args, {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    for (const [stream, destination] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr]
    ]) {
      stream.on('data', (chunk) => {
        destination.write(chunk);
        output.push(chunk.toString('utf8'));
      });
    }
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolveCode(signal ? `signal:${signal}` : (exitCode ?? 1)));
  });
  const result = {
    layer,
    id: item.id,
    command: [item.command, ...item.args],
    status: code === 0 ? 'PASSED' : 'FAILED',
    durationMs: Date.now() - started,
    exit: code
  };
  results.push(result);
  if (code !== 0) throw new GateStepError(`${layer}:${item.id} failed with ${code}.`, output.join(''));
}

async function persistReport(status) {
  const report = {
    schemaVersion: 1,
    gate,
    status,
    commitSha,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    coverageReport: 'evidence/P0/non-ui-automation/coverage.json',
    steps: results
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nNon-UI ${gate} report: ${reportPath}\n`);
}

async function gitSha() {
  const output = [];
  const code = await new Promise((resolveCode, reject) => {
    const child = spawn('git', ['rev-parse', '--short=12', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
    child.once('error', reject);
    child.once('exit', resolveCode);
  });
  return code === 0 ? output.join('').trim() : 'WORKTREE';
}
