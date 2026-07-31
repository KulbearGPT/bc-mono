import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const outputs = 'outputs';
const docs = 'docs';

describe('M20-US-05 Discord Bot review remediation contract', () => {
  test('freezes the ordered remediation stories and their evidence gates', async () => {
    const [plan, backlog] = await Promise.all([
      readFile(`${outputs}/P0开发交付包/06-开发计划/Discord-Bot代码审查修复计划.md`, 'utf8'),
      readFile(`${outputs}/P0开发交付包/06-开发计划/backlog.csv`, 'utf8')
    ]);

    for (let story = 5; story <= 13; story += 1) {
      const id = `M20-US-${String(story).padStart(2, '0')}`;
      expect(plan).toContain(id);
      expect(backlog).toContain(`"${id}"`);
    }
    for (const gate of [
      'AT-MULTI-005',
      'AT-ACT-003',
      'AT-ACT-004',
      'AT-BOT-REV-001',
      'AT-BOT-REV-003',
      'AT-BOT-REV-004',
      'AT-BOT-REV-005',
      'AT-DOP-002',
      'AT-SEL-008'
    ]) {
      expect(plan).toContain(gate);
    }
  });

  test('uses the current multi-participant gift recipient contract everywhere', async () => {
    const [agents, spec, interaction, acceptance, todo] = await Promise.all([
      readFile('AGENTS.md', 'utf8'),
      readFile(`${outputs}/Discord陪玩业务Bot最小原型设计开发文档.html`, 'utf8'),
      readFile(`${outputs}/P0开发交付包/01-UIUX/交互映射.csv`, 'utf8'),
      readFile(`${outputs}/P0开发交付包/07-验收测试/acceptance-cases.csv`, 'utf8'),
      readFile(`${outputs}/Codex-P0开发TODO.md`, 'utf8')
    ]);
    const currentContracts = `${agents}\n${spec}\n${interaction}\n${acceptance}\n${todo}`;

    expect(currentContracts).toContain('participantIds');
    expect(currentContracts).toContain('订单内有效陪玩明细');
    expect(currentContracts).not.toContain('接收人仅由 `order.playerId` 推导');
    expect(currentContracts).not.toContain('接收人由 order.playerId 固定');
    expect(currentContracts).not.toContain('receiver_id 始终由订单当前陪玩推导');
  });

  test('keeps the new delivery artifacts byte-identical to their published mirrors', async () => {
    for (const relative of [
      'P0开发交付包/01-UIUX/交互映射.csv',
      'P0开发交付包/06-开发计划/backlog.csv',
      'P0开发交付包/06-开发计划/Discord-Bot代码审查修复计划.md',
      'P0开发交付包/07-验收测试/acceptance-cases.csv',
      'Codex-P0开发TODO.md'
    ]) {
      const [published, mirror] = await Promise.all([
        readFile(`${outputs}/${relative}`),
        readFile(`${docs}/${relative}`)
      ]);
      expect(published.equals(mirror), `${relative} mirror drift`).toBe(true);
    }
  });
});
