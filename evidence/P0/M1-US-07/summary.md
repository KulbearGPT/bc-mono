# M1-US-07 结构化需求与一次完整确认证据

## Story

- Story：M1-US-07 结构化需求与一次完整确认
- 验收：AT-PL-001、AT-ORD-002
- 范围：用户提交前在私密订单频道看到完整需求、价格、可用余额和取消规则；Bot 通过统一 API 的 `estimateOrder` 与 `getCurrentBalance` 取数，不自行计算价格或可用余额。

## RED 证据

- `tests/m1-us-07-bot.spec.ts` 先于实现新增，最初执行 `npx vitest run tests/m1-us-07-bot.spec.ts` 时缺少 `buildOrderConfirmationMessage`、`handleOpenOrderConfirmation`、`HttpBotApiClient.estimateOrder` 和 `bc:order:*:submit:v*` custom_id route。
- 新增 Sapphire wiring 检查后，`service-center-buttons` 尚未接入 `handleOpenOrderConfirmation`，测试失败，随后才接入。

## 实现文件

- `apps/bot/src/service-center.ts`
  - 新增 `OrderEstimateSummary`。
  - 新增 Bot API client `estimateOrder(orderId, { expectedVersion }, actor, idempotencyKey)`。
  - 新增 `buildOrderConfirmationMessage`，固定展示 game、service、region、duration、tags、notes、estimate price、available balance、cancellation rule、validUntil。
  - 新增 `handleOpenOrderConfirmation`，通过 `getOrder`、`estimateOrder`、`getCurrentBalance` 组合确认面板。
  - stale expectedVersion 时刷新最新草稿面板并附 request_id；信息不完整时禁用最终确认。
  - 最终确认按钮只携带 order id、action 和 expectedVersion，不携带金额、余额或目录快照。
- `apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts`
  - 接收 `order-action` custom_id。
  - “确认订单”按钮接入 `handleOpenOrderConfirmation` 与 `buildDiscordIdempotencyKey('order:estimate', interaction.id)`。
- `tests/m1-us-07-bot.spec.ts`

## 验证命令

- `npx vitest run tests/m1-us-07-bot.spec.ts`
  - 1 file passed, 7 tests passed.
- `npx vitest run tests/m1-us-07-bot.spec.ts && npm run typecheck -w @blackcat/bot`
  - 7 tests passed.
  - `@blackcat/bot` typecheck passed.
- `npx vitest run tests/m1-us-04-bot.spec.ts tests/m1-us-06-bot.spec.ts tests/m1-us-07-bot.spec.ts tests/m1-us-03-api.spec.ts && npm run typecheck && npm test`
  - focused regression：4 files passed, 34 tests passed.
  - root typecheck passed.
  - full suite：19 files passed, 141 tests passed.

## 验收说明

- AT-PL-001：确认面板一次展示游戏、服务、区服、时长、标签、备注、预计价格、可用余额和取消规则。
- AT-ORD-002：Bot 使用 `estimateOrder` 的金额与 `getCurrentBalance` 的可用余额；测试刻意让 draft `amountMinor` 与 estimate `amountMinor` 不一致，面板展示 estimate 金额而不是草稿字段。
- 余额不足分支：若 API 返回 `availableMinor < estimate.amountMinor`，最终确认按钮 disabled，并显示差额和充值入口。
- 陈旧版本分支：`estimateOrder` 返回 `CONFLICT` 时刷新草稿面板并附 request_id，不继续展示旧确认数据。
- 隐私与边界：确认面板不显示 `playerEarning`、`playerPayout`、陪玩结算价或客户端自报金额。

## 剩余风险

- Discord Bot credential 暂未提供，真实测试 Server 手工 E2E 未执行。
- `submit-final` 最终预留动作会在后续资金/并发 Story 中继续接入；本 Story 只负责打开完整确认与禁用明显不可提交状态，最终提交仍必须由 API 复核。
