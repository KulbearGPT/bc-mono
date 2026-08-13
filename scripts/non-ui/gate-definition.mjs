const step = (id, command, args) => ({ id, command, args });

export const gateDefinitions = Object.freeze({
  quick: Object.freeze({
    includes: [],
    preflight: [],
    steps: [
      step('environment', process.execPath, ['scripts/non-ui/verify-environment.mjs']),
      step('critical-scenarios', process.execPath, ['scripts/non-ui/run-domain-gate.mjs', 'quick']),
      step('coverage-report', 'npm', ['run', 'generate:non-ui:coverage'])
    ]
  }),
  full: Object.freeze({
    includes: ['quick'],
    preflight: [],
    steps: [
      step('all-bnui', process.execPath, ['scripts/non-ui/run-domain-gate.mjs', 'a7']),
      step('prisma', 'npm', ['run', 'db:validate']),
      step('routes', 'npm', ['run', 'quality:routes']),
      step('bot-quality', 'npm', ['run', 'quality:bot']),
      step('repository-regression', 'npm', ['test']),
      step('acceptance-matrix', process.execPath, ['scripts/build-p0-acceptance-matrix.mjs']),
      step('generated-evidence', 'git', [
        'diff',
        '--exit-code',
        '--',
        'evidence/P0/non-ui-automation/coverage.json',
        'evidence/P0/acceptance-matrix.csv'
      ]),
      step('clean-diff', 'git', ['diff', '--check'])
    ]
  }),
  release: Object.freeze({
    includes: ['full'],
    preflight: [step('production-evidence', process.execPath, ['scripts/p0-release-gate.mjs'])],
    steps: [
      step('gift-compatibility', 'npm', ['run', 'test:gift:non-ui']),
      step('dashboard-coverage', 'npm', ['run', 'e2e:coverage:verify']),
      step('dashboard-e2e', 'npm', ['run', 'test:e2e:dashboard:isolated'])
    ]
  })
});

export function validateGateDefinition(definitions) {
  for (const layer of ['quick', 'full', 'release']) {
    const definition = definitions[layer];
    if (
      !definition ||
      !Array.isArray(definition.includes) ||
      !Array.isArray(definition.preflight) ||
      !Array.isArray(definition.steps)
    ) {
      throw new Error(`Invalid non-UI gate definition: ${layer}`);
    }
    const ids = [...definition.preflight, ...definition.steps].map(({ id }) => id);
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate non-UI gate step in ${layer}.`);
    for (const item of [...definition.preflight, ...definition.steps]) {
      if (!item.id || !item.command || !Array.isArray(item.args))
        throw new Error(`Invalid non-UI gate step in ${layer}.`);
      if (/(?:retry|flaky|--rerun)/iu.test([item.command, ...item.args].join(' '))) {
        throw new Error(`Unconditional rerun is forbidden in ${layer}:${item.id}.`);
      }
    }
    for (const included of definition.includes) {
      if (!definitions[included] || included === layer)
        throw new Error(`Invalid included gate ${included} in ${layer}.`);
    }
  }
  if (definitions.release.preflight[0]?.id !== 'production-evidence') {
    throw new Error('Release gate must fail closed on production evidence before execution.');
  }
}

export function sanitizeGateOutput(output) {
  return String(output)
    .replace(/Authorization:\s*Bearer\s+\S+/giu, 'Authorization: [REDACTED]')
    .replace(
      /\b(?:password|totp|secret|receiptBody|accountNumber|privateKey|idempotency-key)\s*[:=]\s*\S+/giu,
      '[REDACTED_FIELD]'
    )
    .replace(/\b(?:valid-bot-token|[0-9]{12,19})\b/gu, '[REDACTED_VALUE]')
    .replace(
      /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY[\s\S]*?END (?:RSA |EC |OPENSSH )?PRIVATE KEY/gu,
      '[REDACTED_KEY]'
    );
}

export function buildFailureArtifact({ gate, stepId, commitSha, runId, output, failedAt }) {
  return {
    schemaVersion: 1,
    gate,
    testId: stepId,
    commitSha,
    runId,
    failedAt,
    temporaryDatabase: 'ISOLATED_PER_TEST',
    guildFixtureId: 'REDACTED_FIXTURE',
    actorFixtureId: 'REDACTED_FIXTURE',
    requestId: 'SEE_SANITIZED_TEST_OUTPUT',
    sanitizedOutput: sanitizeGateOutput(output),
    beforeAfterSnapshot: 'ASSERTED_BY_EXECUTABLE_SCENARIO',
    acceptanceMapping: 'evidence/P0/non-ui-automation/coverage.json'
  };
}

validateGateDefinition(gateDefinitions);
