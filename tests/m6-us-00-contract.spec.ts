import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const outputRoot = `${root}/outputs/P0开发交付包`;
const docsRoot = `${root}/docs/P0开发交付包`;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function parseQuotedCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(field); field = '';
    } else if (char === '\n' && !quoted) {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (char !== '\r') field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

describe('M6-US-00 settlement, report, profile, and gift contracts', () => {
  test('freezes six M6 stories and their acceptance families', () => {
    const backlog = read(`${outputRoot}/06-开发计划/backlog.csv`);
    const acceptance = read(`${outputRoot}/07-验收测试/acceptance-cases.csv`);

    for (const story of ['M6-US-01', 'M6-US-02', 'M6-US-03', 'M6-US-04', 'M6-US-05', 'M6-US-06']) {
      expect(backlog).toContain(`"${story}"`);
    }
    for (const acceptanceId of ['AT-SET-001', 'AT-SET-010', 'AT-RPT-001', 'AT-RPT-008', 'AT-PRF-001', 'AT-PRF-009', 'AT-GFT-012', 'AT-GFT-015']) {
      expect(acceptance).toContain(`"${acceptanceId}"`);
    }
  });

  test('freezes settlement/report data models and operations', () => {
    const schema = read(`${outputRoot}/03-数据模型/schema.prisma`);
    const openapi = read(`${outputRoot}/02-API/openapi.yaml`);

    for (const model of ['SettlementBatch', 'SettlementItem', 'SettlementItemEntry', 'SettlementPaymentResult', 'PlayerWeeklyReport', 'WeeklyReportSummary', 'WeeklyReportRevision']) {
      expect(schema).toContain(`model ${model}`);
    }
    expect(openapi).toContain('deferredAdjustmentMinor');
    expect(openapi).toMatch(/netAmountMinor:\s*\{type: integer, minimum: 0\}/);
    for (const operationId of [
      'previewSettlementBatch', 'createSettlementBatch', 'listSettlementBatches', 'getSettlementBatch',
      'submitSettlementBatch', 'approveSettlementBatch', 'exportSettlementBatch',
      'recordSettlementPaymentResults', 'voidSettlementBatch', 'listAdminWeeklyReports',
      'getAdminWeeklyReport', 'exportWeeklyReport', 'createWeeklyReportRevision',
      'listCurrentPlayerWeeklyReports', 'getCurrentPlayerWeeklyReport',
      'getAdminCustomerProfileSummary', 'listAdminCustomerOrders', 'getCurrentUserProfileSummary',
      'listCurrentUserOrders', 'checkGiftAffordability'
    ]) {
      expect(openapi).toContain(`operationId: ${operationId}`);
    }
    expect(schema).toContain('enum SettlementPaymentResultStatus');
    expect(openapi).toContain('x-recharge-url-source: guild-business-configuration');
    expect(openapi).not.toContain('getRechargeUrl');
    expect(read(`${outputRoot}/03-数据模型/状态枚举与约束.md`)).toContain('PARTIALLY_PAID -> PARTIALLY_PAID | PAID');
  });

  test('keeps authoritative contract mirrors byte-identical', () => {
    for (const relative of [
      '02-API/openapi.yaml',
      '03-数据模型/schema.prisma',
      '03-数据模型/状态枚举与约束.md',
      '06-开发计划/backlog.csv',
      '07-验收测试/acceptance-cases.csv'
    ]) {
      expect(read(`${docsRoot}/${relative}`)).toBe(read(`${outputRoot}/${relative}`));
    }
  });

  test('keeps OpenAPI operation IDs unique and local references resolvable', () => {
    const openapi = read(`${outputRoot}/02-API/openapi.yaml`);
    const operationIds = [...openapi.matchAll(/^\s+operationId:\s+([^\s]+)$/gm)].map((match) => match[1]);
    expect(new Set(operationIds).size).toBe(operationIds.length);

    const componentKeys = new Set<string>();
    let componentGroup: string | null = null;
    for (const line of openapi.split('\n')) {
      const group = line.match(/^  ([A-Za-z][A-Za-z0-9]*):$/);
      if (group) {
        componentGroup = group[1];
        continue;
      }
      const key = line.match(/^    ([A-Za-z][A-Za-z0-9]*):(?:\s|$)/);
      if (componentGroup && key) componentKeys.add(`#/components/${componentGroup}/${key[1]}`);
    }
    const refs = [...openapi.matchAll(/\$ref:\s*['"]?(#\/components\/[A-Za-z0-9/]+)['"]?/g)].map((match) => match[1]);
    expect([...new Set(refs)].filter((ref) => !componentKeys.has(ref))).toEqual([]);
  });

  test('keeps planning CSVs structurally valid with unique IDs', () => {
    for (const relative of ['06-开发计划/backlog.csv', '07-验收测试/acceptance-cases.csv']) {
      const rows = parseQuotedCsv(read(`${outputRoot}/${relative}`));
      const width = rows[0].length;
      expect(rows.every((row) => row.length === width)).toBe(true);
      const ids = rows.slice(1).map((row) => row[0]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
