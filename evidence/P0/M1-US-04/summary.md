# M1-US-04：Sapphire 公共入口、私密频道与常驻面板

- Story：M1-US-04
- 状态：完成（真实 Discord Server E2E 因 credential 未提供未执行）
- 日期：2026-07-17
- 责任类型：discord_bot
- 验收用例：AT-CHN-001；AT-UI-001；AT-UI-002；AT-UI-003；AT-ORD-003 的 Bot 侧重复交互/既有订单返回分支

## 合同读取

- `AGENTS.md`
- `docs/Codex-P0开发TODO.md`
- `docs/P0开发交付包/06-开发计划/backlog.csv`
- `docs/P0开发交付包/01-UIUX/交互映射.csv`
- `docs/P0开发交付包/01-UIUX/界面文案清单.csv`
- `docs/P0开发交付包/07-验收测试/acceptance-cases.csv`
- `docs/P0开发交付包/02-API/openapi.yaml`

## RED 证据

```text
$ npx vitest run tests/m1-us-04-bot.spec.ts

FAIL tests/m1-us-04-bot.spec.ts
Error: Cannot find package '@blackcat/bot/service-center'
```

补充 RED：

```text
TypeError: parseServiceCenterCustomId is not a function
expected Sapphire piece manifest to contain interaction-handlers
TypeError: HttpBotApiClient is not a constructor
```

## 实现摘要

- 新增 `@blackcat/bot/service-center`：
  - 公共入口消息规格：`创建订单`、`我的服务中心` 两个按钮，不展示余额。
  - 绑定 Modal：单个一次性绑定码 Text Input，无 select、无自定义 Modal 按钮。
  - 备注 Modal：单个可选 Text Input，custom_id 带 orderId 与 expectedVersion。
  - 私密订单频道权限计划：`@everyone` 不可见；客户、Bot、客服 role 可见；陪玩 role 接单前不可见；面板需要 pin。
  - 订单面板：用消息组件 String Select 完成游戏、服务、区服、时长选择；按钮打开备注、提交和取消；不泄露陪玩结算金额或余额。
  - custom_id parser 与 Discord interaction scoped idempotency key。
  - Bot flow 函数只调用 `BotApiClient`，不在 Sapphire/Bot 层计算价格、状态机、资金或最终权限。
- 新增 `HttpBotApiClient`：
  - 调用 `/api/v1/bindings`、`/api/v1/orders`、`/api/v1/orders/:id`。
  - 每次请求携带 `Authorization: Bearer <BOT_SERVICE_TOKEN>`、`x-client-source: DISCORD_BOT`、Discord actor headers、interaction id 和 idempotency key。
  - 统一 API error envelope 映射为 `BotApiError`，保留 `code`、`requestId`、`statusCode`。
- 新增 `discord-renderer`，把内部 UI spec 转换为 discord.js reply payload。
- 更新 `/service-center` command，返回真实公共入口消息与按钮，不再是占位文案。
- 新增 Sapphire interaction-handler pieces：
  - `service-center-buttons.ts`
  - `order-selects.ts`
  - `service-center-modals.ts`

## 修改文件

- `apps/bot/package.json`
- `apps/bot/src/service-center.ts`
- `apps/bot/src/discord-renderer.ts`
- `apps/bot/src/pieces/commands/service-center.ts`
- `apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts`
- `apps/bot/src/pieces/interaction-handlers/order-selects.ts`
- `apps/bot/src/pieces/interaction-handlers/service-center-modals.ts`
- `tests/m1-us-04-bot.spec.ts`

## GREEN / 回归证据

```text
$ npx vitest run tests/m1-us-04-bot.spec.ts

Test Files  1 passed (1)
Tests       15 passed (15)
```

```text
$ npm run typecheck -w @blackcat/bot

tsc -p tsconfig.json --noEmit
exit 0
```

```text
$ npm run typecheck

tsc -b tsconfig.build.json
exit 0
```

```text
$ npm run pieces -w @blackcat/bot

pieces:
- commands/service-center.ts
- interaction-handlers/order-selects.ts
- interaction-handlers/service-center-buttons.ts
- interaction-handlers/service-center-modals.ts
- listeners/ready.ts
```

```text
$ npm test

Test Files  13 passed (13)
Tests       109 passed (109)
```

## 边界与风险

- Discord Bot credential 暂未提供，未执行真实 Discord 测试 Server E2E；本项按用户要求不阻断本地进度。
- 当前 interaction-handler piece 已完成 route/parse 和私密反馈骨架；真实频道创建、消息编辑、Modal 展示与 Discord API 写操作将在接入 credential 后做测试 Server 验证。
- AT-ORD-003 的完整资金预留重复提交验收属于 M1-US-05 `submitOrder` API；本 Story 覆盖 Bot 侧重复创建/既有活跃订单返回，不提前实现资金预留。
