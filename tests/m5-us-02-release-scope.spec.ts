import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
const read=(path:string)=>readFileSync(path,'utf8');

describe('Railway CAT-ledger release scope contracts',()=>{
  it('defines M9 Railway release without a funding Provider dependency',()=>{
    const backlog=read('outputs/P0开发交付包/06-开发计划/backlog.csv');
    const todo=read('outputs/Codex-P0开发TODO.md');
    const runbook=read('docs/runbooks/Railway-Sandbox测试部署手册.md');
    expect(backlog).toContain('"M9-US-07"');
    expect(backlog).toContain('Provider 退役与 Railway 发布门禁');
    expect(todo).toContain('M9：Discord 自助入驻与 CAT 内部账本');
    expect(runbook).toContain('没有 Sandbox Funding provision');
    expect(runbook).toContain('不运行任何资金 provision 脚本');
    expect(runbook).not.toContain('sandbox:provision:prod');
  });
});
