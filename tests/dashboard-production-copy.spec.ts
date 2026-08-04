import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, test } from 'vitest';

const dashboardSourceDirectory = 'apps/dashboard/src';

function dashboardSource(): string {
  return readdirSync(dashboardSourceDirectory)
    .filter((name) => ['.ts', '.tsx'].includes(extname(name)))
    .sort()
    .map((name) => `\n/* ${name} */\n${readFileSync(join(dashboardSourceDirectory, name), 'utf8')}`)
    .join('');
}

describe('Dashboard production copy gate', () => {
  test('does not expose development, testing or implementation-state language', () => {
    const source = dashboardSource();
    const forbiddenCopy = [
      'SANDBOX 测试环境',
      'Sandbox 环境',
      '审批接口待接入',
      'OpenAPI 已声明审批资源',
      '当前 API 未返回可用的 P0 配置字段',
      'PILOT FEATURE',
      '当前 Pilot 阶段',
      'Role 映射由统一业务 API',
      '统一 API 将',
      '等待 API 返回有效陪玩名单',
      '由 API 根据席位校验并固化',
      '最终金额由 API 校验并固化',
      '由 API 按席位目录价格汇总',
      '测试投递中',
      '测试当前频道投递',
      '测试消息已投递',
      '测试投递失败',
      '测试消息未投递',
      '仅诊断',
      '技术详情与审计字段',
      '配置预检',
      'Discord Snowflake',
      'L4 + Step-up',
      '账户安全 step-up',
      '未映射字段',
      '前端事件编号',
      '金额快照',
      '播报模板快照',
      '原子创建替代批次',
      'minor units',
      'request_id:'
    ];

    for (const copy of forbiddenCopy) expect(source, copy).not.toContain(copy);
  });

  test('keeps operational safety and support context in employee-facing language', () => {
    const source = dashboardSource();
    expect(source).toContain('非生产环境 · 猫条余额不代表已收到 USD');
    expect(source).toContain('发送频道验证消息');
    expect(source).toContain('请求编号：');
    expect(source).toContain('CAT subunit');
  });
});
