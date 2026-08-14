# M20-US-08 候选名单双向分页与跨页选择证据

## Story 与验收

- Story：`M20-US-08`
- 验收：`AT-ACT-004;AT-SEL-004`

## RED

首次命令：`npx vitest run tests/m20-us-08-selection-pagination.spec.ts`

结果：`1 file / 4 tests failed`，分别证明 500 字符 cursor 导致 custom ID 超限、缺少上一页、离页选择未携带、页路由没有 pageIndex。

在 renderer 修复后增加 handler/选择合并探针，结果为 `2 failed / 4 passed`，证明尚未导出逐页 cursor 解析和当前页替换算法。

## GREEN

命令：

```text
npx vitest run tests/m20-us-08-selection-pagination.spec.ts tests/m11-us-03-selection-discord.spec.ts tests/m20-us-03-discord-action-renderers.spec.ts tests/m20-us-04-action-release-gate.spec.ts
```

结果：`4 files / 38 tests passed`。

门禁：

```text
npm run lint:bot
npm run format:bot:check
npm run typecheck -w @blackcat/bot
```

结果：全部通过。

## 修改文件

- `apps/bot/src/selection-discord.ts`
- `apps/bot/src/pieces/interaction-handlers/selection-selects.ts`
- `apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts`
- `tests/m20-us-08-selection-pagination.spec.ts`
- `outputs/docs/Codex-P0开发TODO.md`
- `outputs/docs/P0开发交付包/06-开发计划/backlog.csv`

## 结果

- 500 字符 API cursor 不再进入 Discord custom ID。
- 页路由携带紧凑 order/pool UUID、版本与 pageIndex，9999 页仍低于 100 字符。
- handler 在 defer 后从第一页沿 API cursor 解析目标页，重启不依赖进程状态。
- 内页同时渲染上一页和下一页。
- 已选陪玩由 disabled select 存在 Discord 消息中；翻页和修改名单时保留离页选择，本页重选可移除旧选择。
- 旧 `bc:sp:n` 短 cursor 消息仍能解析并升级到新 renderer。
