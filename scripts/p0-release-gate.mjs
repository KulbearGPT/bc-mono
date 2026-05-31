import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAcceptanceMatrix } from './build-p0-acceptance-matrix.mjs';

const requiredRoles = ['owner', 'staff'];
const requiredConfig = [
  'releaseCandidate', 'rollbackImageDigest', 'railwaySandboxEvidence', 'fundingModeEvidence',
  'discordGuildEvidence', 'backupRestoreEvidence', 'workerRecoveryEvidence'
];

export function evaluateReleaseGate({ matrix, signoff, config }) {
  const blockers = [];
  const pendingExternal = matrix.filter((row) => row.candidate_status === 'PENDING_EXTERNAL').length;
  const failedCases = matrix.filter((row) => !['PASSED', 'COVERED_BY_REGRESSION', 'PENDING_EXTERNAL'].includes(row.candidate_status));
  const passedExternal = matrix.filter((row) => row.execution_class === 'EXTERNAL_E2E' && row.candidate_status === 'PASSED');
  const staleExternal = passedExternal.filter((row) => row.external_candidate_ref !== config?.releaseCandidate);
  if (pendingExternal) blockers.push(`${pendingExternal} external acceptance cases remain pending.`);
  if (failedCases.length) blockers.push(`${failedCases.length} acceptance cases have an invalid or failed status.`);
  if (staleExternal.length) blockers.push(`${staleExternal.length} passed external acceptance cases target another candidate.`);
  const approvals = Array.isArray(signoff?.approvals) ? signoff.approvals : [];
  for (const role of requiredRoles) {
    const approval = approvals.find((item) => item?.role === role && item.approved === true && item.name && item.approvedAt && item.evidence);
    if (!approval) blockers.push(`${role} sign-off is missing or not explicitly approved.`);
  }
  if (config?.scope !== 'P0') blockers.push('Release scope must be exactly P0.');
  if (config?.p1Excluded !== true) blockers.push('P1 and Nice to Have exclusion is not confirmed.');
  if (!Number.isInteger(config?.blockingDefects) || config.blockingDefects !== 0) blockers.push('Blocking defect count must be exactly zero.');
  if (config?.realMoneyFundingExcluded !== true) blockers.push('Real-money funding exclusion is not confirmed.');
  if (config?.providerIntegrationDeferred !== true) blockers.push('Third-party Provider integration deferral is not confirmed.');
  for (const field of requiredConfig) if (typeof config?.[field] !== 'string' || !config[field].trim()) blockers.push(`${field} evidence is required.`);
  return {
    ready: blockers.length === 0,
    blockers,
    summary: { acceptanceCases: matrix.length, pendingExternal, passedExternal: passedExternal.length, signedRoles: requiredRoles.filter((role) => approvals.some((item) => item?.role === role && item.approved === true && item.name && item.approvedAt && item.evidence)).length }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? '.');
  const inputs = await resolveProductionGateInputs(root);
  const report = inputs.blockers.length
    ? { ready: false, blockers: inputs.blockers, summary: emptySummary() }
    : evaluateReleaseGate({
      matrix: await buildAcceptanceMatrix(root),
      signoff: await readJson(inputs.signoffPath),
      config: await readJson(inputs.configPath)
    });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready) process.exitCode = 1;
}

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

async function resolveProductionGateInputs(root) {
  const requestedInputs = [
    ['P0_SIGNOFF_FILE', process.env.P0_SIGNOFF_FILE],
    ['P0_CONFIG_SNAPSHOT_FILE', process.env.P0_CONFIG_SNAPSHOT_FILE]
  ];
  const blockers = requestedInputs
    .filter(([, value]) => typeof value !== 'string' || !value.trim() || containsExample(value))
    .map(([name]) => `${name} must reference an explicit non-example path.`);
  if (blockers.length) return { blockers };

  const [[, signoffFile], [, configFile]] = requestedInputs;
  const [signoffPath, configPath] = await Promise.all([
    realpath(resolve(root, signoffFile)),
    realpath(resolve(root, configFile))
  ]);
  for (const [name, path] of [['P0_SIGNOFF_FILE', signoffPath], ['P0_CONFIG_SNAPSHOT_FILE', configPath]]) {
    if (containsExample(path)) blockers.push(`${name} must reference an explicit non-example path.`);
  }
  return { blockers, signoffPath, configPath };
}

function containsExample(path) { return path.toLowerCase().includes('example'); }
function emptySummary() { return { acceptanceCases: 0, pendingExternal: 0, passedExternal: 0, signedRoles: 0 }; }
