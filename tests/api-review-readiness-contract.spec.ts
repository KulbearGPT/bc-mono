import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read=(path:string)=>readFileSync(path,'utf8');

describe('API review readiness contract',()=>{
  test('makes current player-only readiness authoritative in the main specification and repository guardrails',()=>{
    const main=read('outputs/Discord陪玩业务Bot最小原型设计开发文档.html');
    const agents=read('AGENTS.md');
    for(const source of [main,agents]){
      expect(source).toContain('客户不提交 readiness');
      expect(source).toContain('所有当前有效陪玩');
      expect(source).not.toMatch(/双方就绪|双方都就绪|用户(?:和|与)陪玩(?:分别)?确认就绪/);
    }
  });

  test('removes the contradictory two-party readiness cases from acceptance fixtures and release guidance',()=>{
    const acceptance=read('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv');
    const fixtures=read('outputs/P0开发交付包/07-验收测试/test-fixtures.json');
    const plan=read('outputs/P0开发交付包/07-验收测试/Prototype验收测试计划.html');
    const runbook=read('docs/runbooks/P0-UAT与发布检查表.md');
    expect(acceptance).toContain('最后一名有效陪玩就绪原子开始服务');
    expect(acceptance).not.toMatch(/第二方就绪|等待用户的下一步/);
    expect(fixtures).not.toMatch(/customerReadyAt|WAITING_CUSTOMER|WAITING_BOTH/);
    expect(plan).not.toMatch(/双方就绪|用户与陪玩均就绪/);
    expect(runbook).not.toMatch(/双方就绪|用户和陪玩分别确认就绪/);
  });

  test('keeps the data contract explicit about legacy columns without treating them as customer actions',()=>{
    const schema=read('outputs/P0开发交付包/03-数据模型/schema.prisma');
    const constraints=read('outputs/P0开发交付包/03-数据模型/状态枚举与约束.md');
    const openapi=read('outputs/P0开发交付包/02-API/openapi.yaml');
    expect(schema).toContain('Legacy history-only event; current APIs never emit customer readiness.');
    expect(schema).toContain('Legacy aggregate compatibility column; current customer actions never write it.');
    expect(constraints).toContain('所有当前有效 `order_participants.ready_at` 均非空');
    expect(constraints).not.toContain('requires both parties ready');
    expect(constraints).not.toContain('customer_ready_at IS NOT NULL AND player_ready_at IS NOT NULL');
    expect(openapi).not.toContain('two-sided readiness');
    expect(openapi).toContain('every current ACTIVE player confirms readiness');
  });

  test('removes customer readiness controls and two-party copy from published prototypes',()=>{
    for(const path of [
      'outputs/P0开发交付包/01-UIUX/Discord与Dashboard交互原型.html',
      'outputs/陪玩业务系统第一版产品演示.html',
      'outputs/陪玩业务系统非技术演示版.html'
    ]){
      const source=read(path);
      expect(source).not.toMatch(/customerReadyButton|等待用户就绪|双方就绪|双方都就绪/);
    }
  });

  test('keeps every edited published contract mirror byte-identical',()=>{
    for(const relative of [
      'Discord陪玩业务Bot最小原型设计开发文档.html',
      'P0开发交付包/01-UIUX/Discord与Dashboard交互原型.html',
      'P0开发交付包/01-UIUX/界面文案清单.csv',
      'P0开发交付包/02-API/openapi.yaml',
      'P0开发交付包/03-数据模型/schema.prisma',
      'P0开发交付包/03-数据模型/数据模型与ERD.html',
      'P0开发交付包/03-数据模型/状态枚举与约束.md',
      'P0开发交付包/07-验收测试/Prototype验收测试计划.html',
      'P0开发交付包/07-验收测试/acceptance-cases.csv',
      'P0开发交付包/07-验收测试/test-fixtures.json',
      'P0开发交付包/index.html',
      'index.html',
      '陪玩业务系统第一版产品演示.html',
      '陪玩业务系统非技术演示版.html'
    ]) expect(read(`docs/${relative}`)).toBe(read(`outputs/${relative}`));
  });
});
