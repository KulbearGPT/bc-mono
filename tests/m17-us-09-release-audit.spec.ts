import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

describe('M17-US-09 release audit', () => {
  test('records the executed Guild acceptance while failing closed on remaining human release evidence', async () => {
    const [audit, backlog, todo, matrix] = await Promise.all([
      readFile('evidence/P0/M17-US-09/summary.md', 'utf8'),
      readFile('outputs/P0开发交付包/06-开发计划/backlog.csv', 'utf8'),
      readFile('outputs/Codex-P0开发TODO.md', 'utf8'),
      readFile('evidence/P0/acceptance-matrix.csv', 'utf8')
    ]);
    expect(audit).toContain('npm run quality:bot');
    expect(audit).toContain('npm test');
    expect(audit).toContain('node scripts/build-p0-acceptance-matrix.mjs');
    expect(audit).toContain('PENDING_EXTERNAL');
    expect(audit).toContain('AT-BOT-REV-001');
    expect(audit).toContain('AT-BOT-REV-002');
    expect(audit).toContain('owner/staff');
    expect(matrix).toMatch(/"AT-BOT-REV-001"[^\n]+"PASSED"/u);
    expect(matrix).toMatch(/"AT-BOT-REV-002"[^\n]+"PASSED"/u);
    expect(backlog).toMatch(/"M17-US-09"[^\n]+"IN_PROGRESS"/u);
    expect(todo).toContain('- [ ] `M17-US-09`');
    expect(audit).not.toMatch(/状态：.*(?:DONE|PASSED)/u);
  });

  test('keeps all implementation stories completed while the external release story stays open', async () => {
    const backlog = await readFile('outputs/P0开发交付包/06-开发计划/backlog.csv', 'utf8');
    for (let story = 1; story <= 8; story += 1) {
      const id = `M17-US-${String(story).padStart(2, '0')}`;
      expect(backlog, id).toMatch(new RegExp(`"${id}"[^\\n]+"DONE"`, 'u'));
    }
  });

  test('provides an executable, fail-closed handoff for the two remaining human Guild scenarios', async () => {
    const runbook = await readFile('evidence/P0/M17-US-09/human-uat-runbook.md', 'utf8');
    expect(runbook).toContain('git:a07814637ca31a66b3b65bb69bac5d5945ab2111');
    expect(runbook).toContain('UAT-1：失效组件与错误恢复');
    expect(runbook).toContain('UAT-2：多候选终选与权限收敛');
    expect(runbook).toContain('不得直连数据库写入');
    expect(runbook).toContain('实际结果：`PENDING`');
    expect(runbook).toContain('| owner |  | `PENDING` |');
    expect(runbook).toContain('| staff |  | `PENDING` |');
    expect(runbook).not.toMatch(/实际结果：`PASSED`/u);
  });
});
