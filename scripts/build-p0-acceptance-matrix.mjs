import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyExternalAcceptanceResults } from './external-acceptance-results.mjs';

const acceptancePath = 'outputs/P0开发交付包/07-验收测试/acceptance-cases.csv';
const backlogPath = 'outputs/P0开发交付包/06-开发计划/backlog.csv';
const openApiPath = 'outputs/P0开发交付包/02-API/openapi.yaml';
const outputPath = 'evidence/P0/acceptance-matrix.csv';
const externalResultsPath = 'evidence/P0/external-acceptance-results.json';

const storyOverrides = {
  'AT-ACC-003': ['M1-US-02'],
  'AT-SVC-003': ['M2-US-04'], 'AT-SVC-004': ['M2-US-04'],
  'AT-CAN-002': ['M2-US-10'], 'AT-CAN-005': ['M2-US-09'], 'AT-CAN-007': ['M2-US-06'],
  'AT-SUP-003': ['M2-US-06'], 'AT-SUP-004': ['M2-US-05'], 'AT-SUP-006': ['M2-US-11'],
  'AT-GFT-002': ['M3-US-02'], 'AT-GFT-008': ['M3-US-03'], 'AT-GFT-009': ['M3-US-03'], 'AT-GFT-010': ['M3-US-03'],
  'AT-REF-001': ['M3-US-07'], 'AT-REF-002': ['M3-US-07'], 'AT-REF-003': ['M3-US-07'],
  'AT-REF-004': ['M3-US-07'], 'AT-REF-005': ['M3-US-07'],
  'AT-RBAC-007': ['M4-US-07'], 'AT-RBAC-008': ['M4-US-07'],
  'AT-ROL-002': ['M4-US-05'], 'AT-ROL-003': ['M4-US-05'], 'AT-ROL-005': ['M4-US-05'],
  'AT-AUTH-003': ['M4-US-07'], 'AT-REC-003': ['M0-US-04', 'M5-US-02'], 'AT-REC-004': ['M0-US-05'], 'AT-AUD-002': ['M0-US-03'],
  'AT-WHK-003': ['M0-US-04'], 'AT-REC-005': ['M5-US-02'],
  'AT-PL-002': ['M1-US-08'], 'AT-PL-003': ['M2-US-07'], 'AT-PL-004': ['M2-US-08'],
  'AT-PL-005': ['M2-US-09'], 'AT-PL-006': ['M2-US-10'],
  'AT-RES-004': ['M2-US-10'], 'AT-RES-005': ['M2-US-04'], 'AT-RES-006': ['M2-US-06'],
  'AT-RES-007': ['M2-US-06'], 'AT-RES-010': ['M3-US-06'], 'AT-RES-011': ['M3-US-06'],
  'AT-WRK-002': ['M2-US-01'], 'AT-WRK-003': ['M2-US-01'], 'AT-MAT-002': ['M2-US-07'],
  'AT-RDY-003': ['M2-US-04'], 'AT-RDY-004': ['M2-US-09'], 'AT-RDY-005': ['M2-US-09'],
  'AT-CXL-002': ['M2-US-10'], 'AT-CXL-003': ['M2-US-10'], 'AT-CXL-004': ['M2-US-10'],
  'AT-TML-002': ['M4-US-08'],
  'AT-MET-003': ['M4-US-09'], 'AT-MET-004': ['M4-US-09'], 'AT-MET-005': ['M4-US-09'],
  'AT-MET-006': ['M4-US-09'], 'AT-MET-007': ['M4-US-09'], 'AT-MET-008': ['M4-US-09'],
  'AT-UI-004': ['M1-US-04'], 'AT-UI-005': ['M3-US-01', 'M2-US-10'],
  'AT-TKN-001': ['M8-US-01'], 'AT-TKN-002': ['M8-US-01'], 'AT-TKN-003': ['M8-US-01'],
  'AT-TKN-004': ['M8-US-01'], 'AT-TKN-005': ['M8-US-01'], 'AT-TKN-006': ['M8-US-01'],
  'AT-TKN-007': ['M8-US-01']
};

const columns = [
  'acceptance_id', 'priority', 'layer', 'module', 'title', 'requirement_ids', 'suggested_automation',
  'story_ids', 'operation_ids', 'test_files', 'evidence_refs', 'execution_class', 'candidate_status',
  'external_candidate_ref', 'external_executed_at', 'external_evidence_refs'
];

export async function buildAcceptanceMatrix(root) {
  const [acceptanceText, backlogText, openApiText, testNames, externalResultsText] = await Promise.all([
    readFile(resolve(root, acceptancePath), 'utf8'),
    readFile(resolve(root, backlogPath), 'utf8'),
    readFile(resolve(root, openApiPath), 'utf8'),
    readdir(resolve(root, 'tests')),
    readFile(resolve(root, externalResultsPath), 'utf8')
  ]);
  const acceptance = parseCsv(acceptanceText);
  const backlog = parseCsv(backlogText).filter((row) => row.item_type === 'USER_STORY' && /^M[0-9]-US-[0-9]{2}$/u.test(row.item_id));
  const implementedBacklog = backlog;
  const knownOperations = new Set([...openApiText.matchAll(/^\s+operationId:\s*([^\s]+)\s*$/gmu)].map((match) => match[1]));
  const byAcceptance = new Map();
  const byStory = new Map(backlog.map((row) => [row.item_id, row]));

  for (const story of implementedBacklog) {
    for (const acceptanceId of splitList(story.test_refs)) {
      const values = byAcceptance.get(acceptanceId) ?? [];
      values.push(story.item_id);
      byAcceptance.set(acceptanceId, values);
    }
  }

  if (!acceptance.length) throw new Error('The authoritative acceptance catalog must not be empty.');
  if (new Set(acceptance.map((row) => row.ID)).size !== acceptance.length) throw new Error('Acceptance IDs must be unique.');

  const baseRows = await Promise.all(acceptance.map(async (item) => {
    const storyIds = unique([...(byAcceptance.get(item.ID) ?? []), ...(storyOverrides[item.ID] ?? [])]).sort();
    if (!storyIds.length) throw new Error(`${item.ID} has no owning Story.`);
    const stories = storyIds.map((id) => byStory.get(id));
    if (stories.some((story) => !story)) throw new Error(`${item.ID} references an unknown Story.`);
    const operationIds = unique(stories.flatMap((story) => splitList(story.api_operation_ids)).filter((id) => id !== 'none')).sort();
    const unknownOperations = operationIds.filter((id) => !knownOperations.has(id));
    if (unknownOperations.length) throw new Error(`${item.ID} references unknown operations: ${unknownOperations.join(', ')}.`);
    const testFiles = unique(storyIds.flatMap((storyId) => {
      const prefix = storyId.toLowerCase();
      return testNames.filter((name) => name.startsWith(prefix) && name.endsWith('.spec.ts')).map((name) => `tests/${name}`);
    })).sort();
    const executionClass = requiresExternalEnvironment(item['建议自动化']) ? 'EXTERNAL_E2E' : 'AUTOMATED';
    if (!testFiles.length && executionClass === 'AUTOMATED') throw new Error(`${item.ID} has no executable Story test.`);
    const evidenceRefs = storyIds.map((storyId) => {
      const path = `evidence/P0/${storyId}/summary.md`;
      return existsSync(resolve(root, path)) ? path : `pending:${path}`;
    }).filter((value) => !value.startsWith('pending:'));
    if (!evidenceRefs.length) evidenceRefs.push(`pending:evidence/P0/${storyIds[0]}/summary.md`);
    for (const path of evidenceRefs.filter((value) => value.startsWith('evidence/'))) await readFile(resolve(root, path), 'utf8');
    return {
      acceptance_id: item.ID,
      priority: item['优先级'], layer: item['层级'], module: item['模块'], title: item['标题'],
      requirement_ids: item['对应需求'], suggested_automation: item['建议自动化'],
      story_ids: storyIds.join(';'), operation_ids: operationIds.length ? operationIds.join(';') : 'none',
      test_files: testFiles.length ? testFiles.join(';') : `external:${storyIds.join(';')}`,
      evidence_refs: evidenceRefs.join(';'), execution_class: executionClass,
      candidate_status: executionClass === 'AUTOMATED' ? 'COVERED_BY_REGRESSION' : 'PENDING_EXTERNAL'
    };
  }));

  return applyExternalAcceptanceResults({
    root,
    rows: baseRows,
    ledger: JSON.parse(externalResultsText)
  });
}

export function serializeAcceptanceMatrix(rows) {
  return `${columns.map(csvCell).join(',')}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')).join('\n')}\n`;
}

function parseCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n') { row.push(value.replace(/\r$/u, '')); rows.push(row); row = []; value = ''; }
    else value += char;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  const [headers, ...records] = rows.filter((fields) => fields.some(Boolean));
  return records.map((fields) => Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? ''])));
}

function splitList(value) { return value ? value.split(';').map((item) => item.trim()).filter(Boolean) : []; }
function unique(values) { return [...new Set(values)]; }
function requiresExternalEnvironment(value) { return /(?:^|_)E2E(?:_|$)|MANUAL|DISCORD|UAT/u.test(value); }
function csvCell(value) { return `"${String(value).replaceAll('"', '""')}"`; }

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? '.');
  const rows = await buildAcceptanceMatrix(root);
  const target = resolve(root, outputPath);
  await writeFile(target, serializeAcceptanceMatrix(rows), 'utf8');
  process.stdout.write(`Wrote ${rows.length} acceptance rows to ${relative(root, target)}.\n`);
}
