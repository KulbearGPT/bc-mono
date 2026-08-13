import { createHash } from 'node:crypto';

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
    .replace(/\b(guildFixtureId|actorFixtureId)\s*[:=]\s*([a-z0-9:._-]+)/giu, (_, key, value) => {
      return `${key}=sha256:${fingerprint(value)}`;
    })
    .replace(
      /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY[\s\S]*?END (?:RSA |EC |OPENSSH )?PRIVATE KEY/gu,
      '[REDACTED_KEY]'
    );
}

export function buildFailureArtifact({ gate, stepId, commitSha, runId, output, failedAt, automationCases = [] }) {
  const context = extractFailureContext(output, stepId, automationCases);
  return {
    schemaVersion: 2,
    gate,
    testId: context.testId,
    commitSha,
    runId,
    failedAt,
    temporaryDatabase: context.temporaryDatabase,
    temporaryDatabaseAssociation: context.temporaryDatabaseAssociation,
    observedTemporaryDatabases: context.observedTemporaryDatabases,
    guildFixtureId: context.guildFixtureId,
    actorFixtureId: context.actorFixtureId,
    requestId: context.requestId,
    sanitizedOutput: sanitizeGateOutput(output),
    beforeAfterSnapshot: context.beforeAfterSnapshot,
    acceptanceMapping: 'evidence/P0/non-ui-automation/coverage.json'
  };
}

export function extractFailureContext(output, fallbackTestId, automationCases = []) {
  const value = String(output);
  const failureText = value
    .split(/\r?\n/u)
    .filter((line) => /(?:\bFAIL\b|×)/u.test(line))
    .join('\n');
  const testId =
    lastMatch(failureText, /\b(?:BNUI|DE2E|AT)-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{3}\b/gu)?.[0] ??
    mappedAutomationId(failureText, automationCases) ??
    fallbackTestId;
  const observedTemporaryDatabases = [
    ...new Set([...value.matchAll(/\bblackcat_non_ui_[a-z0-9_]+_[0-9]+_[a-f0-9]{8}\b/gu)].map((match) => match[0]))
  ];
  const contextLines = value.match(/\[NON_UI_CONTEXT\][^\r\n]*/gu) ?? [];
  const fixtureContext = contextLines.findLast((line) => line.includes(`scenario=${testId}`)) ?? '';
  const scenarioDatabase = fixtureContext.match(/\bblackcat_non_ui_[a-z0-9_]+_[0-9]+_[a-f0-9]{8}\b/u)?.[0];
  const temporaryDatabase = scenarioDatabase ?? observedTemporaryDatabases.at(-1) ?? 'NOT_EMITTED';
  const guildFixture = taggedValue(fixtureContext, 'guildFixtureId');
  const actorFixture = taggedValue(fixtureContext, 'actorFixtureId');
  const requestId = lastMatch(value, /\brequest[_-]?id"?\s*[:=]\s*"?([a-z0-9._:-]{1,128})"?/giu)?.[1] ?? 'NOT_EMITTED';
  const snapshot = lastMatch(value, /\[NON_UI_SNAPSHOT\]\s+before=([0-9a-f]{64})\s+after=([0-9a-f]{64})/gu);
  return {
    testId,
    temporaryDatabase,
    temporaryDatabaseAssociation: scenarioDatabase
      ? 'SCENARIO_CONTEXT'
      : temporaryDatabase === 'NOT_EMITTED'
        ? 'NOT_EMITTED'
        : 'LAST_OBSERVED',
    observedTemporaryDatabases,
    guildFixtureId: guildFixture ? `sha256:${fingerprint(guildFixture)}` : 'NOT_EMITTED',
    actorFixtureId: actorFixture ? `sha256:${fingerprint(actorFixture)}` : 'NOT_EMITTED',
    requestId,
    beforeAfterSnapshot: snapshot
      ? { captured: true, beforeDigest: snapshot[1], afterDigest: snapshot[2] }
      : { captured: false, reason: 'NOT_EMITTED' }
  };
}

function taggedValue(output, key) {
  return output.match(new RegExp(`\\b${key}\\s*[:=]\\s*([a-z0-9:._-]+)`, 'iu'))?.[1];
}

function mappedAutomationId(failureText, automationCases) {
  const matches = automationCases.flatMap((item) =>
    (item.sources ?? [])
      .filter((source) => typeof source.test === 'string' && source.test && failureText.includes(source.test))
      .map((source) => ({ automationId: item.automationId, length: source.test.length }))
  );
  return matches.sort((left, right) => right.length - left.length)[0]?.automationId;
}

function lastMatch(value, pattern) {
  return [...value.matchAll(pattern)].at(-1);
}

function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

validateGateDefinition(gateDefinitions);
