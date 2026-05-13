import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildAcceptanceMatrix, serializeAcceptanceMatrix } from '../scripts/build-p0-acceptance-matrix.mjs';

const root = resolve('.');

describe('M5-US-01 P0 acceptance traceability', () => {
  test('maps all 152 authoritative acceptance cases to executable Story evidence', async () => {
    const rows = await buildAcceptanceMatrix(root);

    expect(rows).toHaveLength(152);
    expect(new Set(rows.map((row) => row.acceptance_id)).size).toBe(152);
    for (const row of rows) {
      expect(row.story_ids).toMatch(/^M[0-5]-US-[0-9]{2}(;M[0-5]-US-[0-9]{2})*$/u);
      if (row.execution_class === 'AUTOMATED') {
        expect(row.test_files).toMatch(/^tests\/.+\.spec\.ts(?:;tests\/.+\.spec\.ts)*$/u);
        expect(row.evidence_refs).toMatch(/^evidence\/P0\/.+\.md(?:;evidence\/P0\/.+\.md)*$/u);
      }
      expect(['AUTOMATED', 'EXTERNAL_E2E']).toContain(row.execution_class);
      expect(row.candidate_status).toBe(row.execution_class === 'AUTOMATED' ? 'COVERED_BY_REGRESSION' : 'PENDING_EXTERNAL');
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
