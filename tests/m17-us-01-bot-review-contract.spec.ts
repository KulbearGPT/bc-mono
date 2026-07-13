import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const outputRoot = 'outputs';
const docsRoot = 'docs';

describe('M17-US-01 Bot review remediation contract', () => {
  test('freezes the M17 master specification and mirrored delivery contracts', async () => {
    const pairs = [
      'Discord陪玩业务Bot最小原型设计开发文档.html',
      'P0开发交付包/01-UIUX/交互映射.csv',
      'P0开发交付包/06-开发计划/backlog.csv',
      'P0开发交付包/07-验收测试/acceptance-cases.csv',
      'Codex-P0开发TODO.md'
    ];

    for (const path of pairs) {
      const [output, docs] = await Promise.all([
        readFile(`${outputRoot}/${path}`, 'utf8'),
        readFile(`${docsRoot}/${path}`, 'utf8')
      ]);
      expect(docs, `${path} mirror drift`).toBe(output);
    }

    const master = await readFile(`${outputRoot}/Discord陪玩业务Bot最小原型设计开发文档.html`, 'utf8');
    expect(master).toContain('M17：Bot 审查整改');
    expect(master).toContain('readiness barrier');
    expect(master).toContain('BotApiTransport');
    expect(master).toContain('组件—路由可达性');
  });

  test('defines one epic and nine ordered stories without changing business semantics', async () => {
    const backlog = await readFile(`${outputRoot}/P0开发交付包/06-开发计划/backlog.csv`, 'utf8');
    expect(backlog).toContain('"EP-M17","EPIC","M17"');
    for (let story = 1; story <= 9; story += 1) {
      expect(backlog).toContain(`"M17-US-${String(story).padStart(2, '0')}"`);
    }
    expect(backlog).toContain('不改变订单状态机、资金语义、权限矩阵或 API 业务规则');
  });

  test('adds traceable Bot quality and runtime acceptance gates', async () => {
    const acceptance = await readFile(`${outputRoot}/P0开发交付包/07-验收测试/acceptance-cases.csv`, 'utf8');
    for (const id of ['AT-BOT-REV-001', 'AT-BOT-REV-002', 'AT-BOT-REV-003', 'AT-BOT-REV-004', 'AT-BOT-REV-005']) {
      expect(acceptance).toContain(`"${id}"`);
    }

    const interactionMap = await readFile(`${outputRoot}/P0开发交付包/01-UIUX/交互映射.csv`, 'utf8');
    expect(interactionMap).toContain('INT-B-M17-001');
    expect(interactionMap).toContain('INT-B-M17-002');
  });
});
