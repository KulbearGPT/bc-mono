import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  buildNonUiAcceptanceReport,
  validateNonUiAcceptanceReport
} from '../../tests/support/non-ui-acceptance-report';
import { nonUiAutomationCoverage } from '../../tests/support/non-ui-coverage';

const report = buildNonUiAcceptanceReport({
  story: 'M23-US-05',
  implementationPackage: 'NUI-A4',
  commitSha: process.env.NON_UI_COMMIT_SHA ?? 'WORKTREE',
  generatedAt: process.env.NON_UI_REPORT_AT ?? new Date().toISOString(),
  cases: nonUiAutomationCoverage
});
validateNonUiAcceptanceReport(report);

const directory = resolve('evidence/P0/non-ui-automation');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'coverage.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report.summary)}\n`);
