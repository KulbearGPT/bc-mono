import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

const ledgerKeys = ['schemaVersion', 'results'];
const resultKeys = ['acceptanceId', 'status', 'candidateRef', 'executedAt', 'executor', 'environment', 'summary', 'evidence'];
const evidenceKeys = ['path', 'sha256'];
const candidatePattern = /^(?:git:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/u;
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const evidenceSections = ['Preconditions', 'Steps', 'Expected Result', 'Actual Result', 'Diagnostics'];
const attestationSections = evidenceSections.slice(0, 4);
const minimumSectionCharacters = 20;
const minimumRedactionCharacters = 40;
const minimumNotApplicableCharacters = 20;
const genericActualResultPattern = /^(?:pass(?:ed)?|fail(?:ed)?|success(?:ful(?:ly)?)?|succeed(?:ed)?|ok)\s*[.!?]*$/iu;
const scaffoldPattern = /\b(?:tbd|todo|placeholder|scaffold|lorem ipsum|replace this|fill (?:this|in)|example text|sample text)\b/iu;
const requestIdPattern = /\brequest_id\s*[:=]\s*[a-z0-9][a-z0-9._:-]{7,}\b/iu;
const diagnosticArtifactPattern = /\b(?:log|screenshot|recording|command[- ]output)(?:\s+(?:path|reference))?\s*[:=]\s*\S{8,}/iu;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

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
    const executor = requiredTrimmed(result.executor, 'executor');
    const environment = requiredTrimmed(result.environment, 'environment');
    requiredTrimmed(result.summary, 'summary');
    if (!Array.isArray(result.evidence) || result.evidence.length === 0) throw new Error(`${id} evidence is required.`);
    const refs = [];
    const expectedMetadata = {
      'Acceptance ID': id,
      Status: result.status,
      candidateRef: result.candidateRef,
      executedAt: result.executedAt,
      executor,
      environment
    };
    for (let index = 0; index < result.evidence.length; index += 1) {
      refs.push(await validateEvidenceFile(root, id, result.evidence[index], expectedMetadata, index === 0));
    }
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

async function validateEvidenceFile(root, id, item, expectedMetadata, isPrimary) {
  assertExactKeys(item, evidenceKeys, `${id} evidence`);
  const path = requiredTrimmed(item.path, 'evidence.path');
  const containsExample = path.split(/[\\/]/u).some((part) => part.toLowerCase().includes('example'));
  if (!/^[0-9a-f]{64}$/u.test(item.sha256) || isAbsolute(path)
    || path.split(/[\\/]/u).includes('..') || containsExample) {
    throw new Error(`${id} evidence metadata is invalid.`);
  }
  if (isPrimary && !path.endsWith('.md')) throw new Error(`${id} primary evidence must be valid UTF-8 Markdown.`);
  const allowed = resolve(root, 'evidence/P0/external', id);
  const candidate = resolve(root, path);
  if (!isWithin(allowed, candidate)) throw new Error(`${id} evidence path escapes its directory.`);
  const stat = await lstatEvidencePath(root, candidate, id);
  if (!stat.isFile() || stat.size === 0) throw new Error(`${id} evidence must be a non-empty regular file.`);
  const [allowedReal, candidateReal, content] = await Promise.all([realpath(allowed), realpath(candidate), readFile(candidate)]);
  if (!isWithin(allowedReal, candidateReal)) throw new Error(`${id} evidence realpath escapes its directory.`);
  const digest = createHash('sha256').update(content).digest('hex');
  if (digest !== item.sha256) throw new Error(`${id} evidence hash does not match.`);
  if (!isPrimary) return path;
  let markdown;
  try {
    markdown = utf8Decoder.decode(content);
  } catch {
    throw new Error(`${id} primary evidence must be valid UTF-8 Markdown.`);
  }
  validateEvidenceDocument(markdown, id, expectedMetadata);
  return path;
}

function validateEvidenceDocument(content, id, expectedMetadata) {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  const metadataLabels = [...Object.keys(expectedMetadata), 'Redaction Review', 'Redaction Details'];
  const metadata = {};
  for (let index = 0; index < metadataLabels.length; index += 1) {
    const label = metadataLabels[index];
    const prefix = `${label}: `;
    const line = lines[index];
    if (typeof line !== 'string' || !line.startsWith(prefix)) {
      throw new Error(`${id} evidence document metadata is invalid.`);
    }
    const value = line.slice(prefix.length);
    if (!value.trim()) {
      if (label === 'Redaction Review') throw new Error(`${id} evidence Redaction Review is required.`);
      if (label === 'Redaction Details') throw new Error(`${id} evidence Redaction Details is required.`);
      throw new Error(`${id} evidence ${label} is required.`);
    }
    if (value !== value.trim()) throw new Error(`${id} evidence document metadata is invalid.`);
    metadata[label] = value;
  }
  if (lines[metadataLabels.length] !== '') throw new Error(`${id} evidence document metadata is invalid.`);
  for (const [label, expected] of Object.entries(expectedMetadata)) {
    if (metadata[label] !== expected) throw new Error(`${id} evidence ${label} does not match ledger.`);
  }
  if (metadata['Redaction Review'] !== 'CONFIRMED') {
    throw new Error(`${id} evidence Redaction Review must be CONFIRMED.`);
  }
  validateMeaningfulText(metadata['Redaction Details'], 'Redaction Details', minimumRedactionCharacters, id);

  const sectionLines = lines.slice(metadataLabels.length + 1);
  const headings = evidenceSections.map((section) => `## ${section}`);
  const indexes = headings.map((heading) => sectionLines.reduce((matches, line, index) => {
    if (line === heading) matches.push(index);
    return matches;
  }, []));
  const hasExactSections = indexes.every((matches) => matches.length === 1)
    && indexes.every((matches, index) => index === 0 ? matches[0] === 0 : matches[0] > indexes[index - 1][0])
    && sectionLines.every((line) => !line.startsWith('## ') || headings.includes(line));
  if (!hasExactSections) throw new Error(`${id} evidence must contain the exact Markdown sections in order.`);

  const sections = {};
  for (let index = 0; index < evidenceSections.length; index += 1) {
    const start = indexes[index][0] + 1;
    const end = index + 1 < indexes.length ? indexes[index + 1][0] : sectionLines.length;
    const body = sectionLines.slice(start, end).join('\n').trim();
    const section = evidenceSections[index];
    if (!body) throw new Error(`${id} evidence ${section} section is required.`);
    sections[section] = body;
  }

  if (genericActualResultPattern.test(sections['Actual Result'])) {
    throw new Error(`${id} evidence Actual Result must contain a concrete observed outcome.`);
  }
  for (const section of attestationSections) {
    validateMeaningfulText(sections[section], section, minimumSectionCharacters, id);
  }
  const normalizedSections = attestationSections.map((section) => normalizeText(sections[section]));
  if (new Set(normalizedSections).size !== normalizedSections.length) {
    throw new Error(`${id} evidence attestation sections must not repeat the same content.`);
  }

  const diagnostics = sections.Diagnostics;
  if (/^(?:n\/a|none|not applicable)(?:\b|:)/iu.test(diagnostics)) {
    const match = /^Not applicable: (\S[\s\S]*)$/u.exec(diagnostics);
    if (!match) throw new Error(`${id} evidence Diagnostics requires an explicit not-applicable reason.`);
    validateMeaningfulText(match[1], 'Diagnostics not-applicable reason', minimumNotApplicableCharacters, id);
  } else if (!requestIdPattern.test(diagnostics) && !diagnosticArtifactPattern.test(diagnostics)) {
    throw new Error(`${id} evidence Diagnostics must contain a concrete reference.`);
  }
}

function validateMeaningfulText(value, label, minimumCharacters, id) {
  if (scaffoldPattern.test(value)) {
    throw new Error(`${id} evidence ${label} must not contain placeholder or scaffold text.`);
  }
  const meaningfulCharacters = [...value.normalize('NFKC')].filter((character) => /[\p{L}\p{N}]/u.test(character));
  if (meaningfulCharacters.length < minimumCharacters) {
    throw new Error(`${id} evidence ${label} must contain at least ${minimumCharacters} letters or numbers.`);
  }
  if (new Set(meaningfulCharacters.map((character) => character.toLocaleLowerCase('en-US'))).size < 5) {
    throw new Error(`${id} evidence ${label} must contain at least 5 distinct letters or numbers.`);
  }
}

function normalizeText(value) {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
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
