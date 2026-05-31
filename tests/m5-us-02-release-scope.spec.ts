import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('Railway Sandbox release scope contracts', () => {
  it('makes M5-US-02 and M5-US-03 Railway/Sandbox scoped instead of Provider-gated', () => {
    const backlog = read('outputs/P0开发交付包/06-开发计划/backlog.csv');
    const todo = read('outputs/Codex-P0开发TODO.md');
    const acceptance = read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');

    const m5us02 = backlog.split('\n').find((line) => line.startsWith('"M5-US-02",'));
    const m5us03 = backlog.split('\n').find((line) => line.startsWith('"M5-US-03",'));
    expect(m5us02).toContain('Railway Sandbox 发布与恢复基线');
    expect(m5us02).toContain('Railway PostgreSQL 备份恢复');
    expect(m5us02).toContain('Sandbox transactions');
    expect(m5us02).not.toContain('真实 Provider 沙箱');
    expect(m5us02).not.toContain('RUN:provider-sandbox');
    expect(m5us03).toContain('Railway/Sandbox 发布门禁');
    expect(m5us03).toContain('OWNER+STAFF');
    expect(m5us03).toContain('第三方支付 Provider 为后续独立 Story');

    expect(todo).toContain('M5-US-02：Railway Sandbox 发布与恢复基线');
    expect(todo).toContain('M5-US-03：Railway/Sandbox 发布门禁');
    expect(todo).toContain('第三方支付 Provider 集成不阻断当前 Railway Sandbox 发布');

    expect(acceptance).toContain('Railway 已配置 Web、Worker、Bot 与 PostgreSQL');
    expect(acceptance).not.toContain('PostgreSQL 与 Redis');
    expect(acceptance).toContain('Sandbox 交易');
  });

  it('keeps current-stage runbooks free of Provider-gated release language', () => {
    const docs = [
      read('docs/runbooks/P0-UAT与发布检查表.md'),
      read('docs/runbooks/P0部署与恢复Runbook.md'),
      read('docs/runbooks/Railway-Sandbox运行手册.md'),
      read('evidence/P0/index.md')
    ].join('\n');
    expect(docs).toContain('Railway Sandbox');
    expect(docs).toContain('第三方支付 Provider 集成为后续独立 Story');
    expect(docs).not.toContain('真实 Provider、Discord 与人工签收阻断项');
    expect(docs).not.toContain('Provider 沙箱充值回跳仍属于发布/UAT门禁');
  });
});
