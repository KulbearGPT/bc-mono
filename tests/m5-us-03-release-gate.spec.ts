import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { buildAcceptanceMatrix } from '../scripts/build-p0-acceptance-matrix.mjs';
import { evaluateReleaseGate } from '../scripts/p0-release-gate.mjs';

describe('M5-US-03 fail-closed release gate', () => {
  test('blocks the current candidate on external acceptance and unsigned roles', async () => {
    const matrix = await buildAcceptanceMatrix(process.cwd());
    const result = evaluateReleaseGate({ matrix, signoff: { approvals: [] }, config: { scope: 'P0' } });
    const pendingExternal = matrix.filter((row) => row.candidate_status === 'PENDING_EXTERNAL').length;

    expect(result.ready).toBe(false);
    expect(result.summary.pendingExternal).toBe(pendingExternal);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining(`${pendingExternal} external acceptance cases`),
      expect.stringContaining('product sign-off'),
      expect.stringContaining('rollbackImageDigest')
    ]));
  });

  test('rejects P1 scope and typed names without explicit approval evidence', () => {
    const result = evaluateReleaseGate({
      matrix: [{ acceptance_id: 'AT-X-001', candidate_status: 'PASSED' }],
      signoff: { approvals: [{ role: 'product', name: 'A', approved: false }] },
      config: completeConfig({ scope: 'P0+P1' })
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([expect.stringContaining('scope must be exactly P0'), expect.stringContaining('product sign-off')]));
  });

  test('blocks failed evidence and passed evidence from another candidate', () => {
    const config = completeConfig({ releaseCandidate: `sha256:${'a'.repeat(64)}` });
    const result = evaluateReleaseGate({
      matrix: [
        { acceptance_id: 'AT-X-001', execution_class: 'EXTERNAL_E2E', candidate_status: 'FAILED', external_candidate_ref: config.releaseCandidate },
        { acceptance_id: 'AT-X-002', execution_class: 'EXTERNAL_E2E', candidate_status: 'PASSED', external_candidate_ref: `sha256:${'b'.repeat(64)}` }
      ],
      signoff: { approvals: ['product', 'operations', 'support', 'engineering'].map((role) => ({
        role, name: `${role}-reviewer`, approved: true,
        approvedAt: '2026-07-19T12:00:00.000Z', evidence: `review:${role}`
      })) },
      config
    });
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('1 acceptance cases have an invalid or failed status'),
      expect.stringContaining('1 passed external acceptance cases target another candidate')
    ]));
  });

  test('passes only a complete synthetic P0 gate with four explicit approvals', () => {
    const candidate = `sha256:${'c'.repeat(64)}`;
    const matrix = Array.from({ length: 175 }, (_, index) => index < 47
      ? { acceptance_id: `AT-EXT-${index}`, execution_class: 'EXTERNAL_E2E',
          candidate_status: 'PASSED', external_candidate_ref: candidate }
      : { acceptance_id: `AT-AUTO-${index}`, execution_class: 'AUTOMATED',
          candidate_status: 'COVERED_BY_REGRESSION', external_candidate_ref: '' });
    const result = evaluateReleaseGate({
      matrix,
      signoff: { approvals: ['product', 'operations', 'support', 'engineering'].map((role) => ({ role, name: `${role}-reviewer`, approved: true, approvedAt: '2026-07-18T22:00:00.000Z', evidence: `review:${role}` })) },
      config: completeConfig({ releaseCandidate: candidate })
    });
    expect(result).toMatchObject({ ready: true, blockers: [], summary: {
      acceptanceCases: 175, pendingExternal: 0, passedExternal: 47, signedRoles: 4
    } });
  });

  test('keeps example artifacts visibly non-approved and free of real credentials', async () => {
    const [signoff, config] = await Promise.all([
      readFile('evidence/P0/release/signoff.example.json', 'utf8'),
      readFile('evidence/P0/release/config-snapshot.example.json', 'utf8')
    ]);
    expect(signoff).toContain('"approved": false');
    expect(config).toContain('"scope": "P0"');
    expect(`${signoff}${config}`).not.toMatch(/Bot [A-Za-z0-9._-]{20,}|postgresql:\/\/[^:]+:[^@]+@/u);
  });
});

function completeConfig(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'P0', releaseCandidate: 'sha256:immutable-candidate', rollbackImageDigest: 'sha256:immutable-rollback',
    providerSandboxEvidence: 'evidence:provider', discordGuildEvidence: 'evidence:discord',
    backupRestoreEvidence: 'evidence:restore', workerRecoveryEvidence: 'evidence:worker',
    p1Excluded: true, blockingDefects: 0, acceptedRisks: [], ...overrides
  };
}
