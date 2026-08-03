import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const userFacingSources = [
  'apps/bot/src/bot-config.ts',
  'apps/bot/src/bot-copy.ts',
  'apps/bot/src/discord-renderer.ts',
  'apps/bot/src/public-entry-order-interactions.ts',
  'apps/bot/src/service-center-gift-interactions.ts',
  'apps/bot/src/service-center.ts',
  'apps/bot/src/service-lifecycle-message.ts',
  'apps/bot/src/user-facing-error.ts'
];

describe('M20-US-14 production Discord copy', () => {
  test('contains no development phase, test, placeholder, transport or internal enum copy', async () => {
    const source = (await Promise.all(userFacingSources.map((path) => readFile(path, 'utf8')))).join('\n');
    for (const forbidden of [
      /P0 默认匹配/u,
      /测试/u,
      /SANDBOX 测试环境/u,
      /该订单操作将在后续步骤处理/u,
      /local-action-pending/u,
      /等待(?:业务 )?API 返回/u,
      /业务 API/u,
      /服务端(?:报价|原因|日志)/u,
      /Bot (?:内部异常|收到了|服务凭据|的频道)/u,
      /内部审批/u,
      /进入 CANCELLED/u,
      /READY 后/u,
      /CANCELLED · 已取消/u,
      /处理类型：\$\{input\.fundAction\}/u
    ]) {
      expect(source).not.toMatch(forbidden);
    }
  });

  test('uses production-facing Chinese slash command descriptions', async () => {
    const commands = (
      await Promise.all(
        [
          'apps/bot/src/pieces/commands/bot-config.ts',
          'apps/bot/src/pieces/commands/player-workbench.ts',
          'apps/bot/src/pieces/commands/service-center.ts'
        ].map((path) => readFile(path, 'utf8'))
      )
    ).join('\n');
    expect(commands).not.toMatch(/\.setDescription\('(?:Open|Deploy)/u);
  });

  test('keeps non-real-funds and request-id safety copy while hiding internal configuration', async () => {
    const [renderer, entry, errors] = await Promise.all(
      [
        'apps/bot/src/discord-renderer.ts',
        'apps/bot/src/public-entry-order-interactions.ts',
        'apps/bot/src/user-facing-error.ts'
      ].map((path) => readFile(path, 'utf8'))
    );
    expect(renderer).toContain('不代表真实资金');
    expect(entry).not.toContain('尚未配置私密订单频道分类');
    expect(errors).toContain('request_id:');
  });
});
