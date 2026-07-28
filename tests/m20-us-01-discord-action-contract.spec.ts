import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const outputRoot = 'outputs';
const docsRoot = 'docs';

describe('M20-US-01 Discord action clarity contract', () => {
  test('freezes the status, role, and cancellation action matrix', async () => {
    const [master, matrix] = await Promise.all([
      readFile(`${outputRoot}/Discord陪玩业务Bot最小原型设计开发文档.html`, 'utf8'),
      readFile(`${outputRoot}/P0开发交付包/01-UIUX/Discord动作与按钮矩阵.md`, 'utf8')
    ]);

    for (const phrase of [
      'M20：Discord 动作清晰度与控件收敛',
      '每个客户可操作的非终态订单',
      '取消订单',
      'DRAFT',
      'PENDING_DISPATCH',
      'ACCEPTED',
      'IN_SERVICE',
      'PENDING_CONFIRMATION',
      'CANCELLATION_ASSIST',
      'EXCEPTION',
      'COMPLETED',
      'CANCELLED',
      '客户主面板',
      '陪玩工作台',
      '客服协同卡'
    ]) {
      expect(`${master}\n${matrix}`).toContain(phrase);
    }
  });

  test('freezes clear first-use labels and component layout rules', async () => {
    const matrix = await readFile(
      `${outputRoot}/P0开发交付包/01-UIUX/Discord动作与按钮矩阵.md`,
      'utf8'
    );

    for (const label of [
      '查看这个游戏',
      '查看套餐内容',
      '加入这个单点服务',
      '把此套餐加入订单',
      '继续添加游戏或服务',
      '查看已选服务',
      '填写这个席位的需求',
      '核对订单与总价',
      '提交订单并预留猫条',
      '结束报名，进入试音',
      '确认这些陪玩',
      '陪玩：我已准备好',
      '老板：确认服务完成',
      '刷新最新状态',
      '联系猫舍前台'
    ]) {
      expect(matrix).toContain(label);
    }
    expect(matrix).toContain('一屏最多一个 Primary');
    expect(matrix).toContain('每行通常不超过三个按钮');
    expect(matrix).toContain('危险动作单独成行');
  });

  test('defines ordered implementation stories and traceable acceptance gates', async () => {
    const [backlog, interaction, acceptance] = await Promise.all([
      readFile(`${outputRoot}/P0开发交付包/06-开发计划/backlog.csv`, 'utf8'),
      readFile(`${outputRoot}/P0开发交付包/01-UIUX/交互映射.csv`, 'utf8'),
      readFile(`${outputRoot}/P0开发交付包/07-验收测试/acceptance-cases.csv`, 'utf8')
    ]);

    expect(backlog).toContain('"EP-M20","EPIC","M20"');
    for (let story = 1; story <= 4; story += 1) {
      expect(backlog).toContain(`"M20-US-${String(story).padStart(2, '0')}"`);
    }
    for (const id of ['INT-X-M20-001', 'INT-X-M20-002', 'INT-X-M20-003']) {
      expect(interaction).toContain(id);
    }
    for (const id of ['AT-ACT-001', 'AT-ACT-002', 'AT-ACT-003', 'AT-ACT-004']) {
      expect(acceptance).toContain(`"${id}"`);
    }
  });

  test('keeps every edited delivery contract mirror identical', async () => {
    for (const path of [
      'Discord陪玩业务Bot最小原型设计开发文档.html',
      'P0开发交付包/01-UIUX/Discord动作与按钮矩阵.md',
      'P0开发交付包/01-UIUX/交互映射.csv',
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
