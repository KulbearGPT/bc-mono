import type { NonUiAutomationCase, NonUiPackage } from './non-ui-coverage';

export interface NonUiAcceptanceReport {
  schemaVersion: 1;
  story: `M23-US-${string}`;
  implementationPackage: NonUiPackage;
  commitSha: string;
  generatedAt: string;
  summary: { total: number; automated: number; planned: number };
  cases: NonUiAutomationCase[];
}

export function buildNonUiAcceptanceReport(input: {
  story: `M23-US-${string}`;
  implementationPackage: NonUiPackage;
  commitSha: string;
  generatedAt: string;
  cases: NonUiAutomationCase[];
}): NonUiAcceptanceReport {
  const cases = structuredClone(input.cases);
  return {
    schemaVersion: 1,
    story: input.story,
    implementationPackage: input.implementationPackage,
    commitSha: input.commitSha,
    generatedAt: input.generatedAt,
    summary: {
      total: cases.length,
      automated: cases.filter(({ status }) => status === 'AUTOMATED').length,
      planned: cases.filter(({ status }) => status === 'PLANNED').length
    },
    cases
  };
}

export function validateNonUiAcceptanceReport(report: NonUiAcceptanceReport): void {
  if (report.schemaVersion !== 1) throw new Error('Unsupported non-UI report schema.');
  if (!/^M23-US-[0-9]{2}$/u.test(report.story)) throw new Error(`Invalid Story: ${report.story}`);
  if (!/^NUI-A[0-8]$/u.test(report.implementationPackage)) throw new Error('Invalid implementation package.');
  if (!/^(?:WORKTREE|[0-9a-f]{7,40})$/u.test(report.commitSha)) throw new Error('Invalid commit SHA.');
  if (Number.isNaN(Date.parse(report.generatedAt))) throw new Error('Invalid report timestamp.');
  if (report.cases.length !== 77) throw new Error(`Expected 77 non-UI cases, received ${report.cases.length}.`);
  const ids = report.cases.map(({ automationId }) => automationId);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate non-UI automation ID.');
  for (const item of report.cases) {
    if (!/^BNUI-[A-Z0-9]+-[0-9]{3}$/u.test(item.automationId)) {
      throw new Error(`Invalid automation ID: ${item.automationId}`);
    }
    if (item.status === 'AUTOMATED') {
      if (item.sources.length === 0) throw new Error(`${item.automationId} has no executable source.`);
      if (item.acceptanceIds.length === 0) throw new Error(`${item.automationId} has no acceptance mapping.`);
    }
  }
  const automated = report.cases.filter(({ status }) => status === 'AUTOMATED').length;
  if (
    report.summary.total !== report.cases.length ||
    report.summary.automated !== automated ||
    report.summary.planned !== report.cases.length - automated
  ) {
    throw new Error('Non-UI report summary does not match cases.');
  }
  if (containsSensitiveField(report) || containsCredentialValue(report)) {
    throw new Error('Non-UI report contains a sensitive field.');
  }
}

function containsSensitiveField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsSensitiveField);
  return Object.entries(value).some(
    ([key, nested]) =>
      /^(?:totp|password|secret|receiptBody|accountNumber|privateKey)$/iu.test(key) || containsSensitiveField(nested)
  );
}

function containsCredentialValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return /(?:valid-bot-token|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|\b[0-9]{6}\b)/u.test(value);
  }
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsCredentialValue);
  return Object.values(value).some(containsCredentialValue);
}
