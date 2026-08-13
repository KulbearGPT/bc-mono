import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  buildNonUiAcceptanceReport,
  validateNonUiAcceptanceReport
} from '../../tests/support/non-ui-acceptance-report';
import { nonUiAutomationCoverage } from '../../tests/support/non-ui-coverage';

const report = buildNonUiAcceptanceReport({
  story: 'M23-US-08',
  implementationPackage: 'NUI-A7',
  commitSha: process.env.NON_UI_COMMIT_SHA ?? 'WORKTREE',
  generatedAt: process.env.NON_UI_REPORT_AT ?? sourceDate(),
  cases: nonUiAutomationCoverage
});
validateNonUiAcceptanceReport(report);

const directory = resolve('evidence/P0/non-ui-automation');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'coverage.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report.summary)}\n`);

function sourceDate(): string {
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  return Number.isFinite(epoch) && epoch >= 0 ? new Date(epoch * 1000).toISOString() : '1970-01-01T00:00:00.000Z';
}
