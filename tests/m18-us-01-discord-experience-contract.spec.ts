import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const outputRoot = 'outputs';
const docsRoot = 'docs';

describe('M18-US-01 Discord emotional experience contract', () => {
  test('freezes terminology, density tiers, and embed hierarchy in the master contract', async () => {
    const master = await readFile(`${outputRoot}/Discord陪玩业务Bot最小原型设计开发文档.html`, 'utf8');

    for (const phrase of [
      'M18：Discord 情绪化体验与信息层级',
      '试音匹配',
      '参考店铺的 80–90%',
      '公共欢迎与导航：90',
      '派单与关键里程碑：85',
      '订单私密主面板：70–80',
      '短暂私密反馈：45–55',
      '资金、权限与错误：20–35',
      '标题 → 情绪化引导 → 核心事实 → 老板需求 → 当前进度 → 下一步 → 页脚',
      '禁止使用“选秀”'
    ]) {
      expect(master).toContain(phrase);
    }
  });

  test('defines one epic and eight ordered stories without changing business semantics', async () => {
    const backlog = await readFile(`${outputRoot}/P0开发交付包/06-开发计划/backlog.csv`, 'utf8');
    expect(backlog).toContain('"EP-M18","EPIC","M18"');
    for (let story = 1; story <= 8; story += 1) {
      expect(backlog).toContain(`"M18-US-${String(story).padStart(2, '0')}"`);
    }
    expect(backlog).toContain('不改变订单状态机、资金语义、权限矩阵、Actor Context 或统一 API 业务规则');
    expect(backlog).toContain('80–90% 目标体验');
  });

  test('adds traceable Discord experience interactions and acceptance gates', async () => {
    const interaction = await readFile(`${outputRoot}/P0开发交付包/01-UIUX/交互映射.csv`, 'utf8');
    for (const id of ['INT-B-M18-001', 'INT-B-M18-002', 'INT-B-M18-003']) {
      expect(interaction).toContain(id);
    }

    const acceptance = await readFile(`${outputRoot}/P0开发交付包/07-验收测试/acceptance-cases.csv`, 'utf8');
    for (const id of ['AT-EXP-001', 'AT-EXP-002', 'AT-EXP-003', 'AT-EXP-004', 'AT-EXP-005']) {
      expect(acceptance).toContain(`"${id}"`);
    }
  });

  test('keeps every edited delivery contract mirror identical', async () => {
    for (const path of [
      'Discord陪玩业务Bot最小原型设计开发文档.html',
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
