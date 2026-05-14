import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAcceptanceMatrix } from './build-p0-acceptance-matrix.mjs';

const requiredRoles = ['product', 'operations', 'support', 'engineering'];
const requiredConfig = [
  'releaseCandidate', 'rollbackImageDigest', 'providerSandboxEvidence', 'discordGuildEvidence',
  'backupRestoreEvidence', 'workerRecoveryEvidence'
];

export function evaluateReleaseGate({ matrix, signoff, config }) {
  const blockers = [];
  const pendingExternal = matrix.filter((row) => row.candidate_status === 'PENDING_EXTERNAL').length;
  const failedCases = matrix.filter((row) => !['PASSED', 'COVERED_BY_REGRESSION', 'PENDING_EXTERNAL'].includes(row.candidate_status));
  if (pendingExternal) blockers.push(`${pendingExternal} external acceptance cases remain pending.`);
  if (failedCases.length) blockers.push(`${failedCases.length} acceptance cases have an invalid or failed status.`);
  const approvals = Array.isArray(signoff?.approvals) ? signoff.approvals : [];
  for (const role of requiredRoles) {
    const approval = approvals.find((item) => item?.role === role && item.approved === true && item.name && item.approvedAt && item.evidence);
    if (!approval) blockers.push(`${role} sign-off is missing or not explicitly approved.`);
  }
  if (config?.scope !== 'P0') blockers.push('Release scope must be exactly P0.');
  if (config?.p1Excluded !== true) blockers.push('P1 and Nice to Have exclusion is not confirmed.');
  if (!Number.isInteger(config?.blockingDefects) || config.blockingDefects !== 0) blockers.push('Blocking defect count must be exactly zero.');
  for (const field of requiredConfig) if (typeof config?.[field] !== 'string' || !config[field].trim()) blockers.push(`${field} evidence is required.`);
  return {
    ready: blockers.length === 0,
    blockers,
    summary: { acceptanceCases: matrix.length, pendingExternal, signedRoles: requiredRoles.filter((role) => approvals.some((item) => item?.role === role && item.approved === true && item.name && item.approvedAt && item.evidence)).length }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? '.');
  const signoffPath = resolve(root, process.env.P0_SIGNOFF_FILE ?? 'evidence/P0/release/signoff.example.json');
  const configPath = resolve(root, process.env.P0_CONFIG_SNAPSHOT_FILE ?? 'evidence/P0/release/config-snapshot.example.json');
  const [matrix, signoff, config] = await Promise.all([
    buildAcceptanceMatrix(root), readJson(signoffPath), readJson(configPath)
  ]);
  const report = evaluateReleaseGate({ matrix, signoff, config });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready) process.exitCode = 1;
}

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
