import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('API review approval contract alignment', () => {
  test('only domain APIs can create trusted approval payloads', () => {
    const openapi = read('outputs/P0开发交付包/02-API/openapi.yaml');
    const approvalCollection = pathBlock(openapi, '/api/v1/admin/approval-requests');
    expect(methods(approvalCollection)).toEqual(['get']);
    expect(openapi).not.toContain('operationId: createApprovalRequest');
    expect(openapi).not.toContain('CreateApprovalBody:');
    expect(openapi).not.toContain('CreateApprovalRequest:');

    const guide = read('outputs/P0开发交付包/02-API/API使用说明.md');
    expect(guide).toContain('审批请求只能由对应业务写接口');
    expect(guide).toContain('GIFT_APPROVE');
    expect(guide).toContain('REFUND_EXECUTE');
    expect(guide).toContain('ORDER_RESOLVE');
  });

  test('interaction and backlog contracts no longer expose generic approval creation', () => {
    for (const path of [
      'outputs/Discord陪玩业务Bot最小原型设计开发文档.html',
      'outputs/P0开发交付包/01-UIUX/交互映射.csv',
      'outputs/P0开发交付包/01-UIUX/界面文案清单.csv',
      'outputs/P0开发交付包/01-UIUX/Discord与Dashboard交互原型.html',
      'outputs/P0开发交付包/03-数据模型/状态枚举与约束.md',
      'outputs/P0开发交付包/06-开发计划/backlog.csv'
    ]) {
      expect(read(path)).not.toContain('createApprovalRequest');
    }
    const interaction = read('outputs/P0开发交付包/01-UIUX/交互映射.csv');
    expect(interaction).toContain('approveGiftRequest');
    expect(interaction).toContain('refundOrder;resolveOrder');
    expect(interaction).toContain('L1 只通过客服任务提交建议');
    expect(interaction).toContain('"L2_SUPERVISOR","REQ-P0-RBAC-01"');
  });

  test('canonical contract mirrors stay identical', () => {
    for (const relative of [
      'P0开发交付包/02-API/openapi.yaml',
      'P0开发交付包/02-API/API使用说明.md',
      'P0开发交付包/01-UIUX/交互映射.csv',
      'P0开发交付包/01-UIUX/界面文案清单.csv',
      'P0开发交付包/01-UIUX/Discord与Dashboard交互原型.html',
      'P0开发交付包/03-数据模型/状态枚举与约束.md',
      'P0开发交付包/06-开发计划/backlog.csv',
      'P0开发交付包/06-开发计划/Prototype开发Backlog.html',
      'Discord陪玩业务Bot最小原型设计开发文档.html',
      '陪玩业务系统第一版产品演示.html'
    ]) {
      expect(read(`docs/${relative}`)).toBe(read(`outputs/${relative}`));
    }
  });
});

function pathBlock(openapi: string, path: string): string {
  const start = openapi.indexOf(`  ${path}:`);
  if (start < 0) throw new Error(`Missing OpenAPI path ${path}`);
  const next = openapi.indexOf('\n  /api/', start + path.length + 3);
  return openapi.slice(start, next < 0 ? undefined : next);
}

function methods(block: string): string[] {
  return [...block.matchAll(/^    (get|post|put|patch|delete):$/gmu)].map((match) => match[1]!);
}
