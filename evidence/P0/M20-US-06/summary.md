# M20-US-06 礼物确认组件协议修复证据

## Story 与验收

- Story：`M20-US-06`
- 验收：`AT-MULTI-005;AT-BOT-REV-004`

## RED

命令：`npx vitest run tests/m20-us-06-gift-component-protocol.spec.ts`

结果：`1 file / 4 tests failed`。真实 affordability renderer 生成 `bc:gift:selected:<page>`，旧 handler 无法恢复 participantIds；confirm、refresh、back 均未到达 API，本地错误也错误标记为写入不确定。

## GREEN

命令：

```text
npx vitest run tests/m20-us-06-gift-component-protocol.spec.ts tests/m6-us-06-bot.spec.ts tests/m18-us-07-support-risk-experience.spec.ts
```

结果：`3 files / 17 tests passed`。

门禁：

```text
npm run lint:bot
npm run format:bot:check
npm run build
npm run typecheck -w @blackcat/bot
```

结果：全部通过。新 worktree 首次在根 build 前直接执行 Bot typecheck 曾因 `modules/platform/dist` 尚未生成而报 `TS6305`；执行真实根 build 后复验通过，未将该环境前置失败描述为代码失败。

## 修改文件

- `apps/bot/src/gifts.ts`
- `apps/bot/src/service-center-gift-interactions.ts`
- `tests/m20-us-06-gift-component-protocol.spec.ts`
- `outputs/docs/Codex-P0开发TODO.md`
- `outputs/docs/P0开发交付包/06-开发计划/backlog.csv`

## 结果

- selected-recipient custom ID 由共享常量生成和解析。
- confirm 使用渲染消息中的全部 participantIds 创建请求。
- refresh 使用相同 participantIds 重新检查 affordability。
- back 保留 participantIds 返回礼物目录。
- 缺少本地组件上下文时不调用任何业务 API，并明确报告本次零写入。
