# M1-US-08 资金预留模型与并发控制证据

## Story

- Story：M1-US-08 资金预留模型与并发控制
- 验收：AT-RES-001、AT-RES-002、AT-RES-003
- 范围：统一 `availableMinor = providerBalanceMinor - reservedMinor`；订单提交创建有效 FundReservation；Provider native hold 优先，本地预留 fallback 可用；取消服务开始前订单会释放预留；Bot 最终提交继续调用统一 API。

## RED 证据

- `tests/m1-us-08-api.spec.ts` 先于实现新增，最初执行 `npx vitest run tests/m1-us-08-api.spec.ts` 时 3/3 失败：
  - `getCurrentBalance` 未反映订单提交后的 active reservation。
  - Provider 不支持 native hold 时 `submitOrder` 未走 local reservation fallback。
  - `/api/v1/orders/{orderId}/cancel` 缺失，无法释放 pre-capture reservation。
- `tests/m1-us-08-bot.spec.ts` 先于 Bot 实现新增，最初执行 `npx vitest run tests/m1-us-08-bot.spec.ts` 时 4/4 失败：
  - 缺少 `buildSubmittedOrderMessage`。
  - 缺少 `handleSubmitFinalOrder`。
  - `service-center-buttons` 未接入 `submit-final`。
  - `HttpBotApiClient` 缺少 `submitOrder` 与 `cancelOrder`。
- `tests/m1-us-08-funding-service.spec.ts` 先于 funding helper 实现新增，最初执行时因 `@blackcat/api/funding` 模块不存在失败。

## 实现文件

- `apps/api/src/accounts.ts`
  - `InMemoryAccountStore` 支持 live `reservationSource`，余额查询可实时读取订单 store 中 active reservations。
- `apps/api/src/funding.ts`
  - 新增可复用 funding helper：`resolveFundReservationMode` 与 `buildFundReservationDraft`。
  - 同一 helper 可为 `ORDER` 与 `GIFT` 构建 deterministic reservation draft；礼物实际请求、审批和捕获生命周期仍按 M3 Story 实现。
- `apps/api/package.json`
  - 导出 `@blackcat/api/funding`。
- `apps/api/src/orders.ts`
  - `submitOrder` 使用 Provider capability 选择 `PROVIDER_NATIVE_HOLD` 或 `LOCAL_RESERVATION_FALLBACK`。
  - 订单 reservation 草稿改用通用 funding helper。
  - 新增 `prepareCancelOrder`、`cancelOrder` API route 和 in-memory/Postgres `commitCancel`。
  - cancel 仅覆盖 `DRAFT` / `PENDING_DISPATCH` 的 pre-capture 自动释放路径；完整取消影响预览仍属于 M2-US-10。
  - 释放 native hold 时调用 Provider `releaseHold`；local fallback 不调用 Provider。
- `apps/api/src/security.ts`
  - 增加 `order.cancel` authenticated actor permission。
- `apps/bot/src/service-center.ts`
  - 增加 `OrderReservationSummaryResult`、`CancelOrderRequest`、`CancellationResultSummary`。
  - `HttpBotApiClient` 增加 `submitOrder` 和 `cancelOrder`。
  - 新增 `buildSubmittedOrderMessage` 与 `handleSubmitFinalOrder`。
- `apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts`
  - `submit-final` 按钮接入 `handleSubmitFinalOrder`，幂等键为 `discord:order:submit-final:{interaction.id}`。
- `tests/m1-us-08-api.spec.ts`
- `tests/m1-us-08-bot.spec.ts`
- `tests/m1-us-08-funding-service.spec.ts`

## 验证命令

- `npx vitest run tests/m1-us-08-bot.spec.ts`
  - 1 file passed, 4 tests passed。
- `npx vitest run tests/m1-us-08-api.spec.ts tests/m1-us-08-bot.spec.ts && npm run typecheck -w @blackcat/bot && npm run typecheck && npm test`
  - M1-US-08 API+Bot：2 files passed, 7 tests passed。
  - `@blackcat/bot` typecheck passed。
  - root typecheck passed。
  - full suite：21 files passed, 148 tests passed。
- `npx vitest run tests/m1-us-08-funding-service.spec.ts tests/m1-us-08-api.spec.ts tests/m1-us-08-bot.spec.ts`
  - 3 files passed, 9 tests passed。
- `npm run typecheck && npm test`
  - root typecheck passed。
  - full suite：22 files passed, 150 tests passed。

## 验收说明

- AT-RES-001：订单提交后返回 `PENDING_DISPATCH`、active reservation、amount/captured/released 和 balance summary；提交阶段不创建消费。
- AT-RES-002：`getCurrentBalance` 使用 Provider 真实余额减去 active FundReservation，测试验证 `reservedMinor=12000`、`availableMinor=988000`。
- AT-RES-003：Provider native hold 不可用时使用 `LOCAL_RESERVATION_FALLBACK`；服务开始前取消会释放 reservation，余额压力恢复为 0，并在 native hold 模式释放 Provider hold。
- Bot 边界：最终提交面板显示预留金额、提交后可用余额和“当前只预留金额，不产生正式消费”；不泄露陪玩结算价或收益字段。

## 剩余风险

- Discord credential 暂未提供，真实测试 Server 手工 E2E 未执行。
- 本 Story 只完成订单侧资金预留与可复用 funding helper。礼物侧具体请求、审批、捕获、拒绝/过期释放和并发超支验证将在 M3-US-01、M3-US-02、M3-US-03、M3-US-06 中落地。
- 完整取消影响预览和已接单后的争议/退款路径仍属于 M2-US-10，不在本 Story 内扩展。
