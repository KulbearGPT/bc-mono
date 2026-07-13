import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const outputRoot = 'outputs/P0开发交付包';
const docsRoot = 'docs/P0开发交付包';

describe('M16-US-01 API and Dashboard review remediation contract', () => {
  test('freezes the current CAT display and USD payout boundary', async () => {
    const [spec, agents, backlog, interaction, acceptance] = await Promise.all([
      readFile('outputs/Discord陪玩业务Bot最小原型设计开发文档.html', 'utf8'),
      readFile('AGENTS.md', 'utf8'),
      readFile(`${outputRoot}/06-开发计划/backlog.csv`, 'utf8'),
      readFile(`${outputRoot}/01-UIUX/交互映射.csv`, 'utf8'),
      readFile(`${outputRoot}/07-验收测试/acceptance-cases.csv`, 'utf8')
    ]);

    for (const source of [spec, agents, backlog]) {
      expect(source).toContain('除充值付款事实外');
      expect(source).toContain('CAT');
      expect(source).toContain('USD');
      expect(source).toContain('陪玩结算');
      expect(source).toContain('同时展示');
    }
    expect(interaction).toContain('INT-W-M16-001');
    expect(acceptance).toContain('AT-REV-001');
  });

  test('keeps wallet entries paginated and documents every active support mutation', async () => {
    const openapi = await readFile(`${outputRoot}/02-API/openapi.yaml`, 'utf8');
    const walletPath = operationBlock(openapi, '/api/v1/admin/users/{userId}/wallet/entries', 'get');
    expect(walletPath).toContain("'200': {$ref: '#/components/responses/WalletEntryPageResponse'}");
    expect(openapi).toContain('/api/v1/admin/staff-tasks/{staffTaskId}/notes:');
    expect(openapi).toContain('operationId: addStaffTaskNote');
    expect(openapi).toContain('/api/v1/admin/staff-tasks/{staffTaskId}/escalate:');
    expect(openapi).toContain('operationId: escalateStaffTask');
  });

  test('plans the reviewed runtime and quality fixes as separate stories', async () => {
    const backlog = await readFile(`${outputRoot}/06-开发计划/backlog.csv`, 'utf8');
    for (const story of ['M16-US-01', 'M16-US-02', 'M16-US-03', 'M16-US-04']) {
      expect(backlog).toContain(`"${story}"`);
    }
    for (const invariant of [
      '幂等完成失败可恢复',
      'targetId 校验进入统一错误 envelope',
      '旧请求不得覆盖新客户',
      '请求失败必须结束 busy/loading',
      '共享 API DTO',
      'lint'
    ]) expect(backlog).toContain(invariant);
  });

  test('keeps authoritative contract mirrors identical', async () => {
    for (const relative of [
      '01-UIUX/交互映射.csv',
      '02-API/openapi.yaml',
      '06-开发计划/backlog.csv',
      '07-验收测试/acceptance-cases.csv'
    ]) {
      const [output, docs] = await Promise.all([
        readFile(`${outputRoot}/${relative}`),
        readFile(`${docsRoot}/${relative}`)
      ]);
      expect(output.equals(docs)).toBe(true);
    }
  });
});

function operationBlock(openapi: string, path: string, method: string): string {
  const pathStart = openapi.indexOf(`  ${path}:`);
  if (pathStart < 0) return '';
  const pathEnd = openapi.indexOf('\n  /', pathStart + 1);
  const pathBlock = openapi.slice(pathStart, pathEnd < 0 ? undefined : pathEnd);
  const methodStart = pathBlock.indexOf(`\n    ${method}:`);
  if (methodStart < 0) return '';
  const nextMethod = pathBlock.slice(methodStart + 1).search(/\n    (?:get|post|put|patch|delete):/u);
  return nextMethod < 0 ? pathBlock.slice(methodStart) : pathBlock.slice(methodStart, methodStart + 1 + nextMethod);
}
