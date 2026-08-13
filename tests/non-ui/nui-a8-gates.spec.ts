import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import {
  buildFailureArtifact,
  gateDefinitions,
  sanitizeGateOutput,
  validateGateDefinition
} from '../../scripts/non-ui/gate-definition.mjs';

describe('M23-US-09 / NUI-A8 layered non-UI gates', () => {
  test('freezes distinct PR quick, main full, and fail-closed release layers without retry wrappers', () => {
    expect(gateDefinitions.quick.steps.map(({ id }) => id)).toEqual([
      'environment',
      'critical-scenarios',
      'coverage-report'
    ]);
    expect(gateDefinitions.full.includes).toEqual(['quick']);
    expect(gateDefinitions.full.steps.map(({ id }) => id)).toEqual([
      'all-bnui',
      'prisma',
      'routes',
      'bot-quality',
      'repository-regression',
      'acceptance-matrix',
      'generated-evidence',
      'clean-diff'
    ]);
    expect(gateDefinitions.release.preflight.map(({ id }) => id)).toEqual(['production-evidence']);
    expect(gateDefinitions.release.includes).toEqual(['full']);
    expect(gateDefinitions.release.steps.map(({ id }) => id)).toEqual([
      'gift-compatibility',
      'dashboard-coverage',
      'dashboard-e2e'
    ]);
    expect(() => validateGateDefinition(gateDefinitions)).not.toThrow();
    expect(JSON.stringify(gateDefinitions)).not.toMatch(/(?:retry|flaky|--rerun)/iu);
  });

  test('sanitizes failure output and emits every required forensic field without credentials', () => {
    const rawOutput = [
      'PASS BNUI-ACC-001 registers an account',
      'FAIL BNUI-ORD-004 rejects a concurrent reservation',
      '[NON_UI_CONTEXT] database=blackcat_non_ui_orders_123_abcd1234 scenario=BNUI-ORD-004 guildFixtureId=11111111-1111-4111-a111-111111111111 actorFixtureId=22222222-2222-4222-a222-222222222222',
      '{"error":{"request_id":"req-BNUI-ORD-004"}}',
      `[NON_UI_SNAPSHOT] before=${'a'.repeat(64)} after=${'b'.repeat(64)}`,
      'Authorization: Bearer valid-bot-token password=123456 receiptBody=private accountNumber=6222000012345678'
    ].join('\n');
    const output = sanitizeGateOutput(rawOutput);
    expect(output).not.toMatch(/valid-bot-token|123456|private|6222000012345678/u);
    const artifact = buildFailureArtifact({
      gate: 'full',
      stepId: 'all-bnui',
      commitSha: 'abcdef1',
      runId: 'local-1',
      output: rawOutput,
      failedAt: '2026-08-14T00:00:00.000Z'
    });
    expect(artifact).toMatchObject({
      schemaVersion: 2,
      testId: 'BNUI-ORD-004',
      commitSha: 'abcdef1',
      runId: 'local-1',
      temporaryDatabase: 'blackcat_non_ui_orders_123_abcd1234',
      requestId: 'req-BNUI-ORD-004',
      temporaryDatabaseAssociation: 'SCENARIO_CONTEXT',
      beforeAfterSnapshot: {
        captured: true,
        beforeDigest: 'a'.repeat(64),
        afterDigest: 'b'.repeat(64)
      },
      acceptanceMapping: 'evidence/P0/non-ui-automation/coverage.json'
    });
    expect(artifact.guildFixtureId).toMatch(/^sha256:[0-9a-f]{12}$/u);
    expect(artifact.actorFixtureId).toMatch(/^sha256:[0-9a-f]{12}$/u);
    expect(artifact.guildFixtureId).not.toContain('11111111');
    expect(artifact.actorFixtureId).not.toContain('22222222');
    expect(JSON.stringify(artifact)).not.toMatch(/valid-bot-token|123456|receiptBody|accountNumber/u);

    const mappedArtifact = buildFailureArtifact({
      gate: 'full',
      stepId: 'all-bnui',
      commitSha: 'abcdef1',
      runId: 'local-2',
      output: 'FAIL tests/order.spec.ts > derives every line and order estimate without accepting client money',
      failedAt: '2026-08-14T00:00:00.000Z',
      automationCases: [
        {
          automationId: 'BNUI-ORD-001',
          sources: [
            {
              file: 'tests/order.spec.ts',
              test: 'derives every line and order estimate without accepting client money'
            }
          ]
        }
      ]
    });
    expect(mappedArtifact.testId).toBe('BNUI-ORD-001');

    const unscopedArtifact = buildFailureArtifact({
      gate: 'quick',
      stepId: 'critical-scenarios',
      commitSha: 'abcdef1',
      runId: 'local-3',
      output: [
        'PASS BNUI-WLT-006 keeps providers retired',
        '[NON_UI_CONTEXT] database=blackcat_non_ui_a0_snapshot_123_abcd1234',
        '[NON_UI_CONTEXT] scenario=BNUI-WLT-006 guildFixtureId=BNUI-WLT-006:9:guild-set actorFixtureId=BNUI-WLT-006:9:actor-set',
        'FAIL tests/non-ui/nui-a0-harness.spec.ts > infrastructure contract without a BNUI identifier'
      ].join('\n'),
      failedAt: '2026-08-14T00:00:00.000Z'
    });
    expect(unscopedArtifact).toMatchObject({
      testId: 'critical-scenarios',
      temporaryDatabaseAssociation: 'LAST_OBSERVED',
      guildFixtureId: 'NOT_EMITTED',
      actorFixtureId: 'NOT_EMITTED'
    });
  });

  test('wires PR, main, and release entry points to their named gate without inline reruns', async () => {
    const [candidateWorkflow, releaseWorkflow, packageJson, coverageBuilder] = await Promise.all([
      readFile('.github/workflows/p0-ci.yml', 'utf8'),
      readFile('.github/workflows/p0-release.yml', 'utf8'),
      readFile('package.json', 'utf8'),
      readFile('scripts/non-ui/build-coverage-report.ts', 'utf8')
    ]);
    expect(candidateWorkflow).toContain('npm run test:non-ui:quick');
    expect(candidateWorkflow).toContain('npm run test:non-ui:full');
    expect(releaseWorkflow).toContain('npm run test:non-ui:release');
    expect(packageJson).toContain('"test:non-ui:stability"');
    expect(coverageBuilder).not.toContain('new Date().toISOString()');
    expect(coverageBuilder).toContain("process.env.NON_UI_COMMIT_SHA ?? 'WORKTREE'");
    expect(coverageBuilder).toContain('process.env.SOURCE_DATE_EPOCH');
    expect(`${candidateWorkflow}\n${releaseWorkflow}`).not.toMatch(/continue-on-error:\s*true|(?:retry|rerun)/iu);
  });
});
