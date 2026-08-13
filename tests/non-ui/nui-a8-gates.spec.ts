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
    const output = sanitizeGateOutput(
      'Authorization: Bearer valid-bot-token password=123456 receiptBody=private accountNumber=6222000012345678'
    );
    expect(output).not.toMatch(/valid-bot-token|123456|private|6222000012345678/u);
    const artifact = buildFailureArtifact({
      gate: 'full',
      stepId: 'all-bnui',
      commitSha: 'abcdef1',
      runId: 'local-1',
      output,
      failedAt: '2026-08-14T00:00:00.000Z'
    });
    expect(artifact).toMatchObject({
      testId: 'all-bnui',
      commitSha: 'abcdef1',
      runId: 'local-1',
      temporaryDatabase: 'ISOLATED_PER_TEST',
      guildFixtureId: 'REDACTED_FIXTURE',
      actorFixtureId: 'REDACTED_FIXTURE',
      requestId: 'SEE_SANITIZED_TEST_OUTPUT',
      acceptanceMapping: 'evidence/P0/non-ui-automation/coverage.json'
    });
    expect(JSON.stringify(artifact)).not.toMatch(/valid-bot-token|123456|receiptBody|accountNumber/u);
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
