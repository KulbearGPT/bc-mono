# M17-US-06：Service Center API 类型与 client 拆分

## 实现结果

- 将 service-center 的订单、Profile、礼物、选秀及生命周期 DTO、`BotApiClient`、`HttpBotApiClient`、`BotApiError` 和 API 请求辅助函数迁入 `service-center-api.ts`。
- API 模块为 1,365 行，不导入/构造 `MessageSpec`、Discord component、renderer 或 Bot 文案。
- 原 `service-center.ts` 通过 `export *` 保持既有 import 兼容，并缩减到约 3,200 行；此次仅移动边界，没有修改 API 路由、DTO 字段或业务合同。
- presence listener 作为 API-only consumer 改为直接依赖 `service-center-api.ts`。
- 拆分过程中全量回归发现并恢复了遗漏的 `buildDispatchIneligibleReply` facade 导出，证明 compatibility gate 有效。

## RED

```text
./node_modules/.bin/vitest run tests/m17-us-06-service-center-api-split.spec.ts
Test Files  1 failed (1)
Tests       1 failed | 2 passed (3)
```

失败原因：API-only presence listener 仍通过混合 facade 导入 client。

## GREEN 与回归

```text
./node_modules/.bin/vitest run \
  tests/m17-us-06-service-center-api-split.spec.ts \
  tests/m17-us-05-bot-transport.spec.ts \
  tests/m2-us-01-bot.spec.ts tests/m1-us-04-bot.spec.ts
Test Files  4 passed (4)
Tests       25 passed (25)

npm run quality:bot
ESLint/Prettier/typecheck/root build passed
18 pieces discovered
Test Files  45 passed (45)
Tests       229 passed (229)
```

## 修改文件

- `apps/bot/src/service-center-api.ts`
- `apps/bot/src/service-center.ts`
- `apps/bot/src/pieces/listeners/presence-update.ts`
- `apps/bot/package.json`
- `tests/m17-us-06-service-center-api-split.spec.ts`
- `tests/m17-us-05-bot-transport.spec.ts`
- Backlog、双 TODO 与本证据。

## 剩余门禁

展示、路由和 feature action 的进一步拆分归 M17-US-07；handler 行为与组件可达性归 M17-US-08。
