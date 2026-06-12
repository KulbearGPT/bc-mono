import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();

describe('M10-US-01 multi-player order contract', () => {
  test('keeps changed delivery artifacts byte-identical to their published mirrors', async () => {
    for (const relative of [
      'P0开发交付包/01-UIUX/交互映射.csv',
      'P0开发交付包/02-API/openapi.yaml',
      'P0开发交付包/03-数据模型/schema.prisma',
      'P0开发交付包/06-开发计划/backlog.csv',
      'P0开发交付包/07-验收测试/acceptance-cases.csv',
      'P0开发交付包/07-验收测试/test-fixtures.json'
    ]) {
      const [docs, outputs] = await Promise.all([
        readFile(resolve(root, 'docs', relative), 'utf8'),
        readFile(resolve(root, 'outputs', relative), 'utf8')
      ]);
      expect(docs).toBe(outputs);
    }

    const [docsTodo, outputsTodo] = await Promise.all([
      readFile(resolve(root, 'docs/Codex-P0开发TODO.md'), 'utf8'),
      readFile(resolve(root, 'outputs/Codex-P0开发TODO.md'), 'utf8')
    ]);
    expect(docsTodo).toContain('M10-US-01');
    expect(outputsTodo).toContain('M10-US-01');
  });

  test('freezes unlimited participants, derived totals, all-player readiness, and gift recipient derivation', async () => {
    const [spec, openapi, prisma, backlog, acceptance, matrixBuilder] = await Promise.all([
      readFile(resolve(root, 'outputs/Discord陪玩业务Bot最小原型设计开发文档.html'), 'utf8'),
      readFile(resolve(root, 'outputs/P0开发交付包/02-API/openapi.yaml'), 'utf8'),
      readFile(resolve(root, 'outputs/P0开发交付包/03-数据模型/schema.prisma'), 'utf8'),
      readFile(resolve(root, 'outputs/P0开发交付包/06-开发计划/backlog.csv'), 'utf8'),
      readFile(resolve(root, 'outputs/P0开发交付包/07-验收测试/acceptance-cases.csv'), 'utf8'),
      readFile(resolve(root, 'scripts/build-p0-acceptance-matrix.mjs'), 'utf8')
    ]);

    expect(spec).toContain('订单多陪玩与多接收人礼物补充合同');
    expect(spec).toContain('不设业务人数上限');
    expect(openapi).toContain('operationId: addAdminOrderParticipant');
    expect(openapi).toContain('operationId: updateAdminOrderParticipant');
    expect(openapi).toContain('participantIds:');
    expect(openapi).not.toContain('maxItems: 4');
    expect(prisma).toContain('model OrderParticipant');
    expect(prisma).toContain('linePriceMinor');
    expect(backlog).toContain('M10-US-01');
    expect(matrixBuilder).toContain('/^M[0-9]+-US-[0-9]{2}$/u');
    for (const id of ['AT-MULTI-001', 'AT-MULTI-002', 'AT-MULTI-003', 'AT-MULTI-004', 'AT-MULTI-005']) {
      expect(acceptance).toContain(id);
    }
  });
});
