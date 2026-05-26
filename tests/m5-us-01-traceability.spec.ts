import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildAcceptanceMatrix, serializeAcceptanceMatrix } from '../scripts/build-p0-acceptance-matrix.mjs';
import { applyExternalAcceptanceResults } from '../scripts/external-acceptance-results.mjs';

const root = resolve('.');
const candidateRef = `git:${'a'.repeat(40)}`;
const executedAt = '2026-07-19T12:00:00.000Z';
const executor = 'qa-reviewer';
const environment = 'isolated-postgresql';

type EvidenceOverrides = Partial<{
  acceptanceId: string;
  status: string;
  candidateRef: string;
  executedAt: string;
  executor: string;
  environment: string;
  redactionReview: string;
  redactionDetails: string;
  preconditions: string;
  steps: string;
  expectedResult: string;
  actualResult: string;
  diagnostics: string;
}>;

function evidenceDocument(overrides: EvidenceOverrides = {}): string {
  const values = {
    acceptanceId: 'AT-REC-005',
    status: 'PASSED',
    candidateRef,
    executedAt,
    executor,
    environment,
    redactionReview: 'CONFIRMED',
    redactionDetails: 'Tokens, secrets, account identifiers, balances, and personal data were removed; controlled originals are retained by QA.',
    preconditions: 'An isolated PostgreSQL restore target is available.',
    steps: '1. Restore the candidate backup.\n2. Run the integrity probes.',
    expectedResult: 'The restored facts and immutable records match the source.',
    actualResult: 'The restore and all integrity probes completed successfully.',
    diagnostics: 'request_id=req_restore_001; restore log retained in controlled storage.',
    ...overrides
  };
  return [
    `Acceptance ID: ${values.acceptanceId}`,
    `Status: ${values.status}`,
    `candidateRef: ${values.candidateRef}`,
    `executedAt: ${values.executedAt}`,
    `executor: ${values.executor}`,
    `environment: ${values.environment}`,
    `Redaction Review: ${values.redactionReview}`,
    `Redaction Details: ${values.redactionDetails}`,
    '',
    '## Preconditions',
    values.preconditions,
    '',
    '## Steps',
    values.steps,
    '',
    '## Expected Result',
    values.expectedResult,
    '',
    '## Actual Result',
    values.actualResult,
    '',
    '## Diagnostics',
    values.diagnostics,
    ''
  ].join('\n');
}

describe('M5-US-01 P0 acceptance traceability', () => {
  test.each([
    ['schemaVersion', { schemaVersion: 2, results: [] }, 'ledger.schemaVersion must be 1.'],
    ['results', { schemaVersion: 1, results: {} }, 'ledger.results must be an array.']
  ])('identifies an invalid top-level %s field', async (_field, ledger, expectedError) => {
    await expect(applyExternalAcceptanceResults({ root, rows: [], ledger })).rejects.toThrow(expectedError);
  });

  test('overlays a validated primary Markdown attestation with a hashed binary attachment', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'blackcat-external-evidence-'));
    try {
      const evidencePath = 'evidence/P0/external/AT-REC-005/restore.md';
      const attachmentPath = 'evidence/P0/external/AT-REC-005/restore-command-output.log';
      const content = evidenceDocument({ diagnostics: `command-output: ${attachmentPath}` });
      const attachment = Buffer.from([0xff, 0x00, 0x72, 0x65, 0x73, 0x74, 0x6f, 0x72, 0x65]);
      await mkdir(join(tempRoot, 'evidence/P0/external/AT-REC-005'), { recursive: true });
      await Promise.all([
        writeFile(join(tempRoot, evidencePath), content, 'utf8'),
        writeFile(join(tempRoot, attachmentPath), attachment)
      ]);
      const rows = [
        { acceptance_id: 'AT-REC-005', execution_class: 'EXTERNAL_E2E', candidate_status: 'PENDING_EXTERNAL' },
        { acceptance_id: 'AT-AUD-001', execution_class: 'AUTOMATED', candidate_status: 'COVERED_BY_REGRESSION' }
      ];
      const ledger = { schemaVersion: 1, results: [{
        acceptanceId: 'AT-REC-005', status: 'PASSED', candidateRef,
        executedAt, executor, environment, summary: 'Restore passed.',
        evidence: [
          { path: evidencePath, sha256: createHash('sha256').update(content).digest('hex') },
          { path: attachmentPath, sha256: createHash('sha256').update(attachment).digest('hex') }
        ]
      }] };

      const result = await applyExternalAcceptanceResults({ root: tempRoot, rows, ledger });

      expect(result[0]).toMatchObject({ candidate_status: 'PASSED',
        external_candidate_ref: candidateRef,
        external_executed_at: executedAt, external_evidence_refs: `${evidencePath};${attachmentPath}` });
      expect(result[1]).toMatchObject({ candidate_status: 'COVERED_BY_REGRESSION', external_candidate_ref: '' });
      expect(rows[0]).toEqual({ acceptance_id: 'AT-REC-005', execution_class: 'EXTERNAL_E2E', candidate_status: 'PENDING_EXTERNAL' });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('accepts an explicit not-applicable diagnostics reason', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'blackcat-external-evidence-'));
    try {
      const evidencePath = 'evidence/P0/external/AT-REC-005/restore.md';
      const content = evidenceDocument({ diagnostics: 'Not applicable: the run completed without diagnostic events.' });
      await mkdir(join(tempRoot, 'evidence/P0/external/AT-REC-005'), { recursive: true });
      await writeFile(join(tempRoot, evidencePath), content, 'utf8');

      await expect(applyExternalAcceptanceResults({
        root: tempRoot,
        rows: [{ acceptance_id: 'AT-REC-005', execution_class: 'EXTERNAL_E2E', candidate_status: 'PENDING_EXTERNAL' }],
        ledger: { schemaVersion: 1, results: [{
          acceptanceId: 'AT-REC-005', status: 'PASSED', candidateRef,
          executedAt, executor, environment, summary: 'Restore passed.',
          evidence: [{ path: evidencePath, sha256: createHash('sha256').update(content).digest('hex') }]
        }] }
      })).resolves.toMatchObject([{ candidate_status: 'PASSED' }]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ['Acceptance ID', { acceptanceId: 'AT-REC-004' }, 'Acceptance ID'],
    ['Status', { status: 'FAILED' }, 'Status'],
    ['candidateRef', { candidateRef: `git:${'b'.repeat(40)}` }, 'candidateRef'],
    ['executedAt', { executedAt: '2026-07-19T12:00:01.000Z' }, 'executedAt'],
    ['executor', { executor: 'another-reviewer' }, 'executor'],
    ['environment', { environment: 'another-environment' }, 'environment']
  ])('rejects evidence whose %s metadata does not match the ledger', async (_field, overrides, expectedField) => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'blackcat-external-evidence-'));
    try {
      const evidencePath = 'evidence/P0/external/AT-REC-005/restore.md';
      const content = evidenceDocument(overrides);
      await mkdir(join(tempRoot, 'evidence/P0/external/AT-REC-005'), { recursive: true });
      await writeFile(join(tempRoot, evidencePath), content, 'utf8');

      await expect(applyExternalAcceptanceResults({
        root: tempRoot,
        rows: [{ acceptance_id: 'AT-REC-005', execution_class: 'EXTERNAL_E2E', candidate_status: 'PENDING_EXTERNAL' }],
        ledger: { schemaVersion: 1, results: [{
          acceptanceId: 'AT-REC-005', status: 'PASSED', candidateRef,
          executedAt, executor, environment, summary: 'Restore passed.',
          evidence: [{ path: evidencePath, sha256: createHash('sha256').update(content).digest('hex') }]
        }] }
      })).rejects.toThrow(`evidence ${expectedField} does not match ledger`);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ['one-byte arbitrary content', 'x', 'document metadata'],
    ['non-exact redaction review affirmation', evidenceDocument({ redactionReview: 'YES' }), 'Redaction Review must be CONFIRMED'],
    ['one-character Redaction Details', evidenceDocument({ redactionDetails: 'x' }), 'Redaction Details must contain at least'],
    ['repeated-character Redaction Details', evidenceDocument({ redactionDetails: 'x'.repeat(40) }), 'Redaction Details must contain at least 5 distinct'],
    ['empty Preconditions', evidenceDocument({ preconditions: ' ' }), 'Preconditions section'],
    ['one-character Preconditions', evidenceDocument({ preconditions: 'x' }), 'Preconditions must contain at least'],
    ['empty Steps', evidenceDocument({ steps: ' ' }), 'Steps section'],
    ['one-character Steps', evidenceDocument({ steps: 'x' }), 'Steps must contain at least'],
    ['repeated-character Steps', evidenceDocument({ steps: 'x'.repeat(20) }), 'Steps must contain at least 5 distinct'],
    ['empty Expected Result', evidenceDocument({ expectedResult: ' ' }), 'Expected Result section'],
    ['one-character Expected Result', evidenceDocument({ expectedResult: 'x' }), 'Expected Result must contain at least'],
    ['empty Actual Result', evidenceDocument({ actualResult: ' ' }), 'Actual Result section'],
    ['one-character Actual Result', evidenceDocument({ actualResult: 'x' }), 'Actual Result must contain at least'],
    ['generic passed Actual Result', evidenceDocument({ actualResult: 'passed' }), 'Actual Result must contain a concrete observed outcome'],
    ['generic failed Actual Result', evidenceDocument({ actualResult: 'FAILED.' }), 'Actual Result must contain a concrete observed outcome'],
    ['generic success Actual Result', evidenceDocument({ actualResult: 'success!' }), 'Actual Result must contain a concrete observed outcome'],
    ['generic ok Actual Result', evidenceDocument({ actualResult: 'OK' }), 'Actual Result must contain a concrete observed outcome'],
    ['empty Diagnostics', evidenceDocument({ diagnostics: ' ' }), 'Diagnostics section'],
    ['Diagnostics without a concrete reference', evidenceDocument({ diagnostics: 'The run completed without any errors being observed.' }), 'Diagnostics must contain a concrete reference'],
    ['bare not-applicable Diagnostics', evidenceDocument({ diagnostics: 'Not applicable' }), 'not-applicable reason'],
    ['short not-applicable Diagnostics reason', evidenceDocument({ diagnostics: 'Not applicable: no errors.' }), 'not-applicable reason must contain at least'],
    ['placeholder scaffold', evidenceDocument({ steps: 'TODO: replace this placeholder with the execution steps.' }), 'must not contain placeholder or scaffold text'],
    ['literal scaffold text', evidenceDocument({ steps: 'Scaffold content that has not been replaced with executed operations.' }), 'must not contain placeholder or scaffold text'],
    ['repeated scaffold content', evidenceDocument({
      preconditions: 'The identical case sentence is repeated without specific observed facts.',
      steps: 'The identical case sentence is repeated without specific observed facts.',
      expectedResult: 'The identical case sentence is repeated without specific observed facts.',
      actualResult: 'The identical case sentence is repeated without specific observed facts.'
    }), 'must not repeat the same content'],
    ['missing exact section heading', evidenceDocument().replace('## Steps', '## Procedure'), 'exact Markdown sections']
  ])('rejects evidence with %s', async (_caseName, content, expectedError) => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'blackcat-external-evidence-'));
    try {
      const evidencePath = 'evidence/P0/external/AT-REC-005/restore.md';
      await mkdir(join(tempRoot, 'evidence/P0/external/AT-REC-005'), { recursive: true });
      await writeFile(join(tempRoot, evidencePath), content, 'utf8');

      await expect(applyExternalAcceptanceResults({
        root: tempRoot,
        rows: [{ acceptance_id: 'AT-REC-005', execution_class: 'EXTERNAL_E2E', candidate_status: 'PENDING_EXTERNAL' }],
        ledger: { schemaVersion: 1, results: [{
          acceptanceId: 'AT-REC-005', status: 'PASSED', candidateRef,
          executedAt, executor, environment, summary: 'Restore passed.',
          evidence: [{ path: evidencePath, sha256: createHash('sha256').update(content).digest('hex') }]
        }] }
      })).rejects.toThrow(expectedError);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects an attachment placed before the required primary Markdown attestation', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'blackcat-external-evidence-'));
    try {
      const evidenceDirectory = join(tempRoot, 'evidence/P0/external/AT-REC-005');
      const evidencePath = 'evidence/P0/external/AT-REC-005/restore.md';
      const attachmentPath = 'evidence/P0/external/AT-REC-005/restore.log';
      const content = evidenceDocument();
      const attachment = Buffer.from('restore command output', 'utf8');
      await mkdir(evidenceDirectory, { recursive: true });
      await Promise.all([
        writeFile(join(tempRoot, evidencePath), content, 'utf8'),
        writeFile(join(tempRoot, attachmentPath), attachment)
      ]);

      await expect(applyExternalAcceptanceResults({
        root: tempRoot,
        rows: [{ acceptance_id: 'AT-REC-005', execution_class: 'EXTERNAL_E2E', candidate_status: 'PENDING_EXTERNAL' }],
        ledger: { schemaVersion: 1, results: [{
          acceptanceId: 'AT-REC-005', status: 'PASSED', candidateRef,
          executedAt, executor, environment, summary: 'Restore passed.',
          evidence: [
            { path: attachmentPath, sha256: createHash('sha256').update(attachment).digest('hex') },
            { path: evidencePath, sha256: createHash('sha256').update(content).digest('hex') }
          ]
        }] }
      })).rejects.toThrow('primary evidence must be valid UTF-8 Markdown');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects a non-Markdown evidence file even when its content satisfies the document contract', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'blackcat-external-evidence-'));
    try {
      const evidencePath = 'evidence/P0/external/AT-REC-005/restore.txt';
      const content = evidenceDocument();
      await mkdir(join(tempRoot, 'evidence/P0/external/AT-REC-005'), { recursive: true });
      await writeFile(join(tempRoot, evidencePath), content, 'utf8');

      await expect(applyExternalAcceptanceResults({
        root: tempRoot,
        rows: [{ acceptance_id: 'AT-REC-005', execution_class: 'EXTERNAL_E2E', candidate_status: 'PENDING_EXTERNAL' }],
        ledger: { schemaVersion: 1, results: [{
          acceptanceId: 'AT-REC-005', status: 'PASSED', candidateRef,
          executedAt, executor, environment, summary: 'Restore passed.',
          evidence: [{ path: evidencePath, sha256: createHash('sha256').update(content).digest('hex') }]
        }] }
      })).rejects.toThrow('primary evidence must be valid UTF-8 Markdown');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects evidence that is not valid UTF-8 Markdown', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'blackcat-external-evidence-'));
    try {
      const evidencePath = 'evidence/P0/external/AT-REC-005/restore.md';
      const content = Buffer.concat([Buffer.from(evidenceDocument(), 'utf8'), Buffer.from([0xff])]);
      await mkdir(join(tempRoot, 'evidence/P0/external/AT-REC-005'), { recursive: true });
      await writeFile(join(tempRoot, evidencePath), content);

      await expect(applyExternalAcceptanceResults({
        root: tempRoot,
        rows: [{ acceptance_id: 'AT-REC-005', execution_class: 'EXTERNAL_E2E', candidate_status: 'PENDING_EXTERNAL' }],
        ledger: { schemaVersion: 1, results: [{
          acceptanceId: 'AT-REC-005', status: 'PASSED', candidateRef,
          executedAt, executor, environment, summary: 'Restore passed.',
          evidence: [{ path: evidencePath, sha256: createHash('sha256').update(content).digest('hex') }]
        }] }
      })).rejects.toThrow('evidence must be valid UTF-8 Markdown');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('reports missing result fields with the acceptance ID', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'blackcat-external-evidence-'));
    try {
      const evidencePath = 'evidence/P0/external/AT-REC-005/restore.md';
      const content = evidenceDocument();
      await mkdir(join(tempRoot, 'evidence/P0/external/AT-REC-005'), { recursive: true });
      await writeFile(join(tempRoot, evidencePath), content, 'utf8');
      const { summary: _summary, ...result } = {
        acceptanceId: 'AT-REC-005', status: 'PASSED', candidateRef,
        executedAt, executor, environment, summary: 'Restore passed.',
        evidence: [{ path: evidencePath, sha256: createHash('sha256').update(content).digest('hex') }]
      };

      await expect(applyExternalAcceptanceResults({
        root: tempRoot,
        rows: [{ acceptance_id: 'AT-REC-005', execution_class: 'EXTERNAL_E2E', candidate_status: 'PENDING_EXTERNAL' }],
        ledger: { schemaVersion: 1, results: [result] }
      })).rejects.toThrow('AT-REC-005 result fields are invalid: missing field(s): summary');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('reports unexpected result fields with the acceptance ID', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'blackcat-external-evidence-'));
    try {
      const evidencePath = 'evidence/P0/external/AT-REC-005/restore.md';
      const content = evidenceDocument();
      await mkdir(join(tempRoot, 'evidence/P0/external/AT-REC-005'), { recursive: true });
      await writeFile(join(tempRoot, evidencePath), content, 'utf8');
      const result = {
        acceptanceId: 'AT-REC-005', status: 'PASSED', candidateRef,
        executedAt, executor, environment, summary: 'Restore passed.',
        evidence: [{ path: evidencePath, sha256: createHash('sha256').update(content).digest('hex') }],
        unexpectedField: true
      };

      await expect(applyExternalAcceptanceResults({
        root: tempRoot,
        rows: [{ acceptance_id: 'AT-REC-005', execution_class: 'EXTERNAL_E2E', candidate_status: 'PENDING_EXTERNAL' }],
        ledger: { schemaVersion: 1, results: [result] }
      })).rejects.toThrow('AT-REC-005 result fields are invalid: unexpected field(s): unexpectedField');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ['unknown ID', (result: Record<string, unknown>) => ({ ...result, acceptanceId: 'AT-UNKNOWN-001' }), 'AT-UNKNOWN-001'],
    ['automated ID', (result: Record<string, unknown>) => ({ ...result, acceptanceId: 'AT-AUD-001' }), 'AT-AUD-001'],
    ['duplicate ID', (result: Record<string, unknown>) => [result, { ...result, summary: 'Repeated result.' }], 'AT-REC-005'],
    ['invalid status', (result: Record<string, unknown>) => ({ ...result, status: 'PENDING_EXTERNAL' }), 'AT-REC-005 status'],
    ['invalid candidate reference', (result: Record<string, unknown>) => ({ ...result, candidateRef: 'git:ABC' }), 'AT-REC-005 candidateRef'],
    ['non-UTC time', (result: Record<string, unknown>) => ({ ...result, executedAt: '2026-07-19T12:00:00.000+00:00' }), 'AT-REC-005 executedAt'],
    ['empty executor', (result: Record<string, unknown>) => ({ ...result, executor: ' ' }), 'executor'],
    ['empty environment', (result: Record<string, unknown>) => ({ ...result, environment: ' ' }), 'environment'],
    ['empty summary', (result: Record<string, unknown>) => ({ ...result, summary: ' ' }), 'summary'],
    ['missing evidence', (result: Record<string, unknown>) => ({ ...result, evidence: [] }), 'AT-REC-005 evidence'],
    ['path traversal', (result: Record<string, unknown>) => ({ ...result, evidence: [{ path: 'evidence/P0/external/AT-REC-005/../AT-REC-005/restore.md', sha256: result.sha256 }] }), 'AT-REC-005 evidence'],
    ['example path', (result: Record<string, unknown>) => ({ ...result, evidence: [{ path: 'evidence/P0/external/AT-REC-005/example.md', sha256: result.sha256 }] }), 'AT-REC-005 evidence'],
    ['example substring in basename', (result: Record<string, unknown>) => ({ ...result, evidence: [{ path: 'evidence/P0/external/AT-REC-005/Example-Evidence.md', sha256: result.sha256 }] }), 'AT-REC-005 evidence'],
    ['example substring in directory', (result: Record<string, unknown>) => ({ ...result, evidence: [{ path: 'evidence/P0/external/AT-REC-005/run-example-1/restore.md', sha256: result.sha256 }] }), 'AT-REC-005 evidence'],
    ['missing file', (result: Record<string, unknown>) => ({ ...result, evidence: [{ path: 'evidence/P0/external/AT-REC-005/missing.md', sha256: result.sha256 }] }), 'AT-REC-005'],
    ['empty file', (result: Record<string, unknown>) => ({ ...result, evidence: [{ path: 'evidence/P0/external/AT-REC-005/empty.md', sha256: createHash('sha256').digest('hex') }] }), 'AT-REC-005'],
    ['symlink', (result: Record<string, unknown>) => ({ ...result, evidence: [{ path: 'evidence/P0/external/AT-REC-005/link.md', sha256: result.sha256 }] }), 'AT-REC-005'],
    ['wrong hash', (result: Record<string, unknown>) => ({ ...result, evidence: [{ path: 'evidence/P0/external/AT-REC-005/restore.md', sha256: '0'.repeat(64) }] }), 'AT-REC-005']
  ])('rejects %s external evidence', async (_caseName, alterResult, expectedError) => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'blackcat-external-evidence-'));
    try {
      const evidenceDirectory = join(tempRoot, 'evidence/P0/external/AT-REC-005');
      const evidencePath = 'evidence/P0/external/AT-REC-005/restore.md';
      const content = evidenceDocument();
      const sha256 = createHash('sha256').update(content).digest('hex');
      await mkdir(evidenceDirectory, { recursive: true });
      await Promise.all([
        writeFile(join(tempRoot, evidencePath), content, 'utf8'),
        writeFile(join(evidenceDirectory, 'example.md'), content, 'utf8'),
        writeFile(join(evidenceDirectory, 'empty.md'), '', 'utf8'),
        symlink(join(evidenceDirectory, 'restore.md'), join(evidenceDirectory, 'link.md'))
      ]);
      const result = {
        acceptanceId: 'AT-REC-005', status: 'PASSED', candidateRef,
        executedAt, executor, environment, summary: 'Restore passed.',
        evidence: [{ path: evidencePath, sha256 }], sha256
      };
      const altered = alterResult(result);
      const results = Array.isArray(altered) ? altered : [altered];
      for (const item of results) delete item.sha256;

      await expect(applyExternalAcceptanceResults({
        root: tempRoot,
        rows: [
          { acceptance_id: 'AT-REC-005', execution_class: 'EXTERNAL_E2E', candidate_status: 'PENDING_EXTERNAL' },
          { acceptance_id: 'AT-AUD-001', execution_class: 'AUTOMATED', candidate_status: 'COVERED_BY_REGRESSION' }
        ],
        ledger: { schemaVersion: 1, results }
      })).rejects.toThrow(expectedError);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ['acceptance-ID directory', 'evidence/P0/external/AT-REC-005', 'isolated-evidence/AT-REC-005', ''],
    ['external parent directory', 'evidence/P0/external', 'isolated-external', 'AT-REC-005']
  ])('rejects a symlinked %s in an evidence path', async (_caseName, linkPath, targetPath, evidenceSubdirectory) => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'blackcat-external-evidence-'));
    try {
      const evidencePath = 'evidence/P0/external/AT-REC-005/restore.md';
      const content = evidenceDocument();
      const targetDirectory = join(tempRoot, targetPath);
      await mkdir(join(tempRoot, 'evidence/P0'), { recursive: true });
      await mkdir(join(targetDirectory, evidenceSubdirectory), { recursive: true });
      if (linkPath.endsWith('AT-REC-005')) await mkdir(join(tempRoot, 'evidence/P0/external'), { recursive: true });
      await writeFile(join(targetDirectory, evidenceSubdirectory, 'restore.md'), content, 'utf8');
      await symlink(targetDirectory, join(tempRoot, linkPath));

      await expect(applyExternalAcceptanceResults({
        root: tempRoot,
        rows: [{ acceptance_id: 'AT-REC-005', execution_class: 'EXTERNAL_E2E', candidate_status: 'PENDING_EXTERNAL' }],
        ledger: { schemaVersion: 1, results: [{
          acceptanceId: 'AT-REC-005', status: 'PASSED', candidateRef,
          executedAt, executor, environment, summary: 'Restore passed.',
          evidence: [{ path: evidencePath, sha256: createHash('sha256').update(content).digest('hex') }]
        }] }
      })).rejects.toThrow('AT-REC-005 evidence contains a symbolic link.');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('maps every authoritative acceptance case to executable Story evidence', async () => {
    const rows = await buildAcceptanceMatrix(root);
    const authoritativeCaseCount = (await readFile(resolve(root, 'outputs/P0开发交付包/07-验收测试/acceptance-cases.csv'), 'utf8'))
      .trim().split(/\r?\n/u).length - 1;

    expect(rows).toHaveLength(authoritativeCaseCount);
    expect(new Set(rows.map((row) => row.acceptance_id)).size).toBe(authoritativeCaseCount);
    for (const row of rows) {
      expect(row.story_ids).toMatch(/^M[0-8]-US-[0-9]{2}(;M[0-8]-US-[0-9]{2})*$/u);
      if (row.execution_class === 'AUTOMATED') {
        expect(row.test_files).toMatch(/^tests\/.+\.spec\.ts(?:;tests\/.+\.spec\.ts)*$/u);
        expect(row.evidence_refs).toMatch(/^evidence\/P0\/.+\.md(?:;evidence\/P0\/.+\.md)*$/u);
      }
      expect(['AUTOMATED', 'EXTERNAL_E2E']).toContain(row.execution_class);
      if (row.execution_class === 'AUTOMATED') {
        expect(row.candidate_status).toBe('COVERED_BY_REGRESSION');
      } else {
        expect(['PENDING_EXTERNAL', 'PASSED', 'FAILED']).toContain(row.candidate_status);
      }
      if (row.candidate_status === 'PENDING_EXTERNAL') {
        expect(row.external_candidate_ref).toBe('');
        expect(row.external_executed_at).toBe('');
        expect(row.external_evidence_refs).toBe('');
      }
      for (const path of row.external_evidence_refs.split(';').filter(Boolean)) {
        await expect(readFile(resolve(root, path), 'utf8')).resolves.not.toHaveLength(0);
      }
    }
  });

  test('keeps operation and file references valid and covers the three M5-US-01 focus cases', async () => {
    const rows = await buildAcceptanceMatrix(root);
    const focus = new Map(rows.filter((row) => ['AT-AUD-004', 'AT-RBAC-001', 'AT-MET-001'].includes(row.acceptance_id))
      .map((row) => [row.acceptance_id, row]));

    expect([...focus.keys()].sort()).toEqual(['AT-AUD-004', 'AT-MET-001', 'AT-RBAC-001']);
    for (const row of rows) {
      const paths = [...row.test_files.split(';'), ...row.evidence_refs.split(';')]
        .filter((path) => path.startsWith('tests/') || path.startsWith('evidence/'));
      for (const path of paths) {
        await expect(readFile(resolve(root, path), 'utf8')).resolves.not.toHaveLength(0);
      }
    }
  });

  test('keeps the committed matrix byte-for-byte reproducible', async () => {
    const rows = await buildAcceptanceMatrix(root);
    const committed = await readFile(resolve(root, 'evidence/P0/acceptance-matrix.csv'), 'utf8');
    expect(committed).toBe(serializeAcceptanceMatrix(rows));
  });
});
