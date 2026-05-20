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

  test('passes only a complete synthetic P0 gate with four explicit approvals', () => {
    const result = evaluateReleaseGate({
      matrix: [{ acceptance_id: 'AT-X-001', candidate_status: 'PASSED' }],
      signoff: { approvals: ['product', 'operations', 'support', 'engineering'].map((role) => ({ role, name: `${role}-reviewer`, approved: true, approvedAt: '2026-07-18T22:00:00.000Z', evidence: `review:${role}` })) },
      config: completeConfig()
    });
    expect(result).toMatchObject({ ready: true, blockers: [], summary: { pendingExternal: 0, signedRoles: 4 } });
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
