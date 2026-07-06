import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();

describe('M11-US-01 selection-pool dispatch contract', () => {
  test('keeps published contract mirrors byte-identical', async () => {
    for (const relative of [
      'Discord陪玩业务Bot最小原型设计开发文档.html',
      'Codex-P0开发TODO.md',
      'P0开发交付包/01-UIUX/交互映射.csv',
      'P0开发交付包/02-API/openapi.yaml',
      'P0开发交付包/03-数据模型/schema.prisma',
      'P0开发交付包/06-开发计划/backlog.csv',
      'P0开发交付包/07-验收测试/acceptance-cases.csv'
    ]) {
      const [docs, outputs] = await Promise.all([
        readFile(resolve(root, 'docs', relative), 'utf8'),
        readFile(resolve(root, 'outputs', relative), 'utf8')
      ]);
      expect(docs).toBe(outputs);
    }
  });

  test('replaces first-success acceptance with customer-finalized selection pools', async () => {
    const [spec, openapi, prisma, interaction, backlog, acceptance, todo] = await Promise.all([
      readFile(resolve(root, 'outputs/Discord陪玩业务Bot最小原型设计开发文档.html'), 'utf8'),
      readFile(resolve(root, 'outputs/P0开发交付包/02-API/openapi.yaml'), 'utf8'),
      readFile(resolve(root, 'outputs/P0开发交付包/03-数据模型/schema.prisma'), 'utf8'),
      readFile(resolve(root, 'outputs/P0开发交付包/01-UIUX/交互映射.csv'), 'utf8'),
      readFile(resolve(root, 'outputs/P0开发交付包/06-开发计划/backlog.csv'), 'utf8'),
      readFile(resolve(root, 'outputs/P0开发交付包/07-验收测试/acceptance-cases.csv'), 'utf8'),
      readFile(resolve(root, 'outputs/Codex-P0开发TODO.md'), 'utf8')
    ]);

    expect(spec).toContain('M11 候选池选秀式派单补充合同');
    expect(spec).toContain('Bot 提供 3、5、10、15、30 分钟报名等待预设');
    expect(spec).toContain('API 校验一至三十分钟整数边界');
    expect(spec).toContain('选秀阶段不设置业务超时');
    expect(spec).toContain('报名和进入选秀语音房均不占用活动订单槽位');
    expect(spec).toContain('不以 Discord presence 或手动 AVAILABLE 状态作为报名资格');

    for (const operationId of [
      'createOrderSelectionPool',
      'applyToOrderSelectionPool',
      'withdrawOrderSelectionApplication',
      'closeOrderSelectionPool',
      'listOrderSelectionApplications',
      'finalizeOrderSelectionPool'
    ]) {
      expect(openapi).toContain(`operationId: ${operationId}`);
      expect(interaction).toContain(operationId);
    }
    expect(openapi).not.toContain('operationId: acceptOrder');
    expect(openapi).not.toContain('operationId: setMyPlayerAvailability');
    expect(openapi).toMatch(/SelectionPool:[\s\S]*?COLLECTING[\s\S]*?SELECTION[\s\S]*?FINALIZED/u);
    expect(openapi).toMatch(/SelectionApplication:[\s\S]*?APPLIED[\s\S]*?SELECTED[\s\S]*?NOT_SELECTED[\s\S]*?INVALIDATED/u);

    expect(prisma).toContain('model SelectionPool');
    expect(prisma).toContain('model SelectionApplication');
    expect(prisma).toContain('enum SelectionPoolStatus');
    expect(prisma).toContain('enum SelectionApplicationStatus');
    expect(prisma).not.toContain('acceptedPlayerId');

    for (const id of ['AT-SEL-001', 'AT-SEL-002', 'AT-SEL-003', 'AT-SEL-004', 'AT-SEL-005', 'AT-SEL-006']) {
      expect(acceptance).toContain(id);
    }
    expect(backlog).toContain('M11-US-01');
    expect(backlog).toContain('M11-US-04');
    expect(todo).toContain('M11：候选池选秀式派单');
  });
});
