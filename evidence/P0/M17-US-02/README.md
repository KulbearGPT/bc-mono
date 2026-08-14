# M17-US-02：私密订单频道适配器与面板置顶

## 实现结果

- 新增 `private-order-channel.ts`，将 `buildPrivateOrderChannelPlan` 转为 discord.js 的真实频道权限覆盖。
- 临时频道依次执行 create → send → pin，完成后才把频道与消息 ID 交给统一 API 下单/恢复流程。
- send 或 pin 失败会删除临时频道；已有订单频道仍存在时会删除重复临时频道。
- 新建订单与原频道丢失后的恢复使用同一适配器，最终面板编辑和公开订单号改名也集中执行。
- 未修改订单状态、资金、权限审批或 API 业务语义。

## RED

```text
./node_modules/.bin/vitest run tests/m17-us-02-private-channel-adapter.spec.ts
Test Files  1 failed (1)
Tests       no tests
Error: Cannot find package '@blackcat/bot/private-order-channel'
```

## GREEN 与回归

```text
./node_modules/.bin/vitest run \
  tests/m17-us-02-private-channel-adapter.spec.ts \
  tests/m1-us-04-bot.spec.ts \
  tests/m9-us-05-onboarding-bot.spec.ts
Test Files  3 passed (3)
Tests       21 passed (21)

npm run typecheck -w @blackcat/bot
tsc -p tsconfig.json --noEmit

npm run build
tsc -b tsconfig.build.json
```

## 修改文件

- `apps/bot/src/private-order-channel.ts`
- `apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts`
- `apps/bot/package.json`
- `tests/m17-us-02-private-channel-adapter.spec.ts`
- Backlog、双 TODO 与本证据。

## 剩余门禁

真实 Guild 中的权限、置顶和删除/恢复交互仍归 M17-US-09 外部 UAT；本 Story 只声明可重复的自动化候选已通过。
