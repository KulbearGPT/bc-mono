import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const outputRoot = 'outputs';
const docsRoot = 'docs';

describe('M19-US-01 cross-role state projection contract', () => {
  test('freezes the authoritative readiness and projection rules', async () => {
    const [master, matrix] = await Promise.all([
      readFile(`${outputRoot}/Discord陪玩业务Bot最小原型设计开发文档.html`, 'utf8'),
      readFile(`${outputRoot}/P0开发交付包/01-UIUX/跨角色状态刷新矩阵.md`, 'utf8')
    ]);

    for (const phrase of [
      'M19：跨角色状态一致性与实时刷新',
      '客户不提交 readiness',
      '所有当前有效陪玩均已就绪',
      '客服协同卡',
      '客服工作台',
      '事务提交与 Outbox 写入必须处于同一原子边界',
      '原位更新'
    ]) {
      expect(`${master}\n${matrix}`).toContain(phrase);
    }
  });

  test('defines an ordered implementation epic and traceable acceptance gates', async () => {
    const [backlog, interaction, acceptance] = await Promise.all([
      readFile(`${outputRoot}/P0开发交付包/06-开发计划/backlog.csv`, 'utf8'),
      readFile(`${outputRoot}/P0开发交付包/01-UIUX/交互映射.csv`, 'utf8'),
      readFile(`${outputRoot}/P0开发交付包/07-验收测试/acceptance-cases.csv`, 'utf8')
    ]);

    expect(backlog).toContain('"EP-M19","EPIC","M19"');
    for (let story = 1; story <= 5; story += 1) {
      expect(backlog).toContain(`"M19-US-${String(story).padStart(2, '0')}"`);
    }
    for (const id of ['INT-X-M19-001', 'INT-X-M19-002', 'INT-X-M19-003']) {
      expect(interaction).toContain(id);
    }
    for (const id of ['AT-STATE-001', 'AT-STATE-002', 'AT-STATE-003', 'AT-STATE-004', 'AT-STATE-005']) {
      expect(acceptance).toContain(`"${id}"`);
    }
  });

  test('covers every order transition and every affected audience', async () => {
    const matrix = await readFile(`${outputRoot}/P0开发交付包/01-UIUX/跨角色状态刷新矩阵.md`, 'utf8');
    for (const state of [
      'DRAFT',
      'PENDING_DISPATCH',
      'ACCEPTED',
      'IN_SERVICE',
      'PENDING_CONFIRMATION',
      'COMPLETED',
      'CANCELLATION_ASSIST',
      'CANCELLED',
      'EXCEPTION'
    ]) {
      expect(matrix).toContain(`\`${state}\``);
    }
    for (const audience of ['客户订单面板', '陪玩可见信息', '客服协同卡', '客服工作台']) {
      expect(matrix).toContain(audience);
    }
  });

  test('keeps every edited delivery contract mirror identical', async () => {
    for (const path of [
      'Discord陪玩业务Bot最小原型设计开发文档.html',
      'P0开发交付包/01-UIUX/交互映射.csv',
      'P0开发交付包/01-UIUX/跨角色状态刷新矩阵.md',
      'P0开发交付包/06-开发计划/backlog.csv',
      'P0开发交付包/07-验收测试/acceptance-cases.csv',
      'Codex-P0开发TODO.md'
    ]) {
      const [output, docs] = await Promise.all([
        readFile(`${outputRoot}/${path}`),
        readFile(`${docsRoot}/${path}`)
      ]);
      expect(output.equals(docs), `${path} mirror drift`).toBe(true);
    }
  });
});
