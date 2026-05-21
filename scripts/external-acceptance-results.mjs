import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const ledgerKeys = ['schemaVersion', 'results'];
const resultKeys = ['acceptanceId', 'status', 'candidateRef', 'executedAt', 'executor', 'environment', 'summary', 'evidence'];
const evidenceKeys = ['path', 'sha256'];
const candidatePattern = /^(?:git:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/u;
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export async function applyExternalAcceptanceResults({ root, rows, ledger }) {
  assertExactKeys(ledger, ledgerKeys, 'ledger');
  if (ledger.schemaVersion !== 1) throw new Error('ledger.schemaVersion must be 1.');
  if (!Array.isArray(ledger.results)) throw new Error('ledger.results must be an array.');
  const output = rows.map((row) => ({ ...row, external_candidate_ref: '', external_executed_at: '', external_evidence_refs: '' }));
  const byId = new Map(output.map((row) => [row.acceptance_id, row]));
  const seen = new Set();
  for (const result of ledger.results) {
    const resultId = result && typeof result === 'object' && !Array.isArray(result)
      && typeof result.acceptanceId === 'string' && result.acceptanceId.trim()
      ? result.acceptanceId.trim() : '';
    assertExactKeys(result, resultKeys, resultId ? `${resultId} result` : 'result');
    const id = requiredTrimmed(result.acceptanceId, 'acceptanceId');
    if (seen.has(id)) throw new Error(`${id} has duplicate external results.`);
    seen.add(id);
    const row = byId.get(id);
    if (!row) throw new Error(`${id} is not an authoritative acceptance case.`);
    if (row.execution_class !== 'EXTERNAL_E2E') throw new Error(`${id} is not external acceptance.`);
    if (!['PASSED', 'FAILED'].includes(result.status)) throw new Error(`${id} status is invalid.`);
    if (!candidatePattern.test(result.candidateRef)) throw new Error(`${id} candidateRef is invalid.`);
    validateUtc(result.executedAt, id);
    requiredTrimmed(result.executor, 'executor');
    requiredTrimmed(result.environment, 'environment');
    requiredTrimmed(result.summary, 'summary');
    if (!Array.isArray(result.evidence) || result.evidence.length === 0) throw new Error(`${id} evidence is required.`);
    const refs = [];
    for (const item of result.evidence) refs.push(await validateEvidenceFile(root, id, item));
    Object.assign(row, {
      candidate_status: result.status,
      external_candidate_ref: result.candidateRef,
      external_executed_at: result.executedAt,
      external_evidence_refs: refs.join(';')
    });
  }
  return output;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const expectedKeys = [...expected].sort();
  const actualKeys = Object.keys(value).sort();
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  const unexpected = actualKeys.filter((key) => !expectedKeys.includes(key));
  if (missing.length === 0 && unexpected.length === 0) return;
  const details = [];
  if (missing.length > 0) details.push(`missing field(s): ${missing.join(', ')}`);
  if (unexpected.length > 0) details.push(`unexpected field(s): ${unexpected.join(', ')}`);
  throw new Error(`${label} fields are invalid: ${details.join('; ')}.`);
}

function requiredTrimmed(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function validateUtc(value, id) {
  if (typeof value !== 'string' || !utcPattern.test(value) || new Date(value).toISOString() !== value) {
    throw new Error(`${id} executedAt must be UTC ISO 8601.`);
  }
}

async function validateEvidenceFile(root, id, item) {
  assertExactKeys(item, evidenceKeys, `${id} evidence`);
  const path = requiredTrimmed(item.path, 'evidence.path');
  if (!/^[0-9a-f]{64}$/u.test(item.sha256) || isAbsolute(path)
    || path.split(/[\\/]/u).includes('..') || /(?:^|[.\\/])example(?:[.\\/]|$)/iu.test(path)) {
    throw new Error(`${id} evidence metadata is invalid.`);
  }
  const allowed = resolve(root, 'evidence/P0/external', id);
  const candidate = resolve(root, path);
  if (!isWithin(allowed, candidate)) throw new Error(`${id} evidence path escapes its directory.`);
  const stat = await lstatEvidencePath(root, candidate, id);
  if (!stat.isFile() || stat.size === 0) throw new Error(`${id} evidence must be a non-empty regular file.`);
  const [allowedReal, candidateReal, content] = await Promise.all([realpath(allowed), realpath(candidate), readFile(candidate)]);
  if (!isWithin(allowedReal, candidateReal)) throw new Error(`${id} evidence realpath escapes its directory.`);
  const digest = createHash('sha256').update(content).digest('hex');
  if (digest !== item.sha256) throw new Error(`${id} evidence hash does not match.`);
  return path;
}

async function lstatEvidencePath(root, candidate, id) {
  const parts = relative(resolve(root), candidate).split(sep);
  let current = resolve(root);
  let stat;
  for (const part of parts) {
    current = resolve(current, part);
    stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`${id} evidence contains a symbolic link.`);
  }
  return stat;
}

function isWithin(parent, child) {
  const value = relative(parent, child);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}
