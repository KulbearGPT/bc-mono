# M1-US-05：订单提交与资金预留

- Story：M1-US-05
- 状态：完成
- 日期：2026-07-17
- 责任类型：backend_api
- 验收用例：AT-RES-001；AT-REC-002；AT-ORD-004

## 合同读取

- `AGENTS.md`
- `docs/Codex-P0开发TODO.md`
- `docs/P0开发交付包/02-API/openapi.yaml`
- `docs/P0开发交付包/04-支付集成/adapter-contract.yaml`
- `database/prisma/schema.prisma`
- `database/prisma/migrations/000001_p0_baseline/migration.sql`

## RED 证据

```text
$ npx vitest run tests/m1-us-05-api.spec.ts

FAIL tests/m1-us-05-api.spec.ts
Error: submitOrder route not registered / missing funding adapter wiring
```

补充 RED：

```text
expected 503 to be 504
expected promise resolved "undefined" instead of rejecting
expected ACTIVE hold to match RELEASED
expected SUBMITTED sequence 1 to equal 2
expected 401 to be 200 for signed application/json webhook
```

这些失败分别覆盖 Provider timeout 语义、commit-time 余额复核、provider hold 补偿释放、提交事件序号、以及 webhook 原始字节验签。

## 实现摘要

- `submitOrder`：
  - 仅订单所有者、`DRAFT` 状态和匹配 `expectedVersion` 可提交。
  - 提交前复核服务目录快照，拒绝目录下架、价格、币种、计价单位、游戏/服务/区服或金额不一致。
  - 读取 Provider 余额，并按 `availableMinor = providerBalanceMinor - reservedMinor` 校验可用余额。
  - 使用稳定 reservation id 和 Idempotency-Key 创建 provider-native hold。
  - Provider timeout-after-commit 时通过 `getHold(IDEMPOTENCY_KEY)` 恢复已创建 hold；无法恢复返回 504。
  - 成功后创建 ACTIVE order FundReservation，写 reservation event，订单进入 `PENDING_DISPATCH`。
  - 提交阶段不创建消费、扣款或 external debit transaction；扣款仍保留到订单完成阶段。
- Postgres `commitSubmit`：
  - 在事务内锁定 `user_currency_locks(user_id, currency)`。
  - 在事务内重新读取并校验当前服务目录快照。
  - 在事务内重新合计同用户/币种 active reservations，防止订单与礼物并发超支。
  - 先通过所有复核再更新订单、插入 FundReservation、reservation event、order event 和 audit。
  - 使用 `nextEventSequence()` 避免 `SUBMITTED` 与已有 `CREATED` event 的 `(order_id, sequence)` 冲突。
- 提交失败补偿：
  - 如果 provider hold 已创建但本地 commit 失败，API 会调用 `releaseHold` 释放该 hold，并保留原始业务错误返回。
- 审计：
  - 成功审计包含 before/after snapshot，可追溯 orderId、reservationId、provider、providerHoldRef、金额、币种、状态、版本与 providerBalanceMinor。
- Webhook：
  - `handlePaymentWebhook` 支持 raw `application/octet-stream` 和 `application/json` 原始字节验签。
  - 无效签名或 replay timestamp 在确认前拒绝。
  - provider event id 在当前进程内去重，当前版本仅返回 acknowledgement，`applied=false`，不执行扣款/退款业务应用。

## 修改文件

- `apps/api/src/orders.ts`
- `apps/api/src/server.ts`
- `apps/api/src/index.ts`
- `apps/api/src/webhooks.ts`
- `docs/P0开发交付包/02-API/openapi.yaml`
- `tests/m1-us-05-api.spec.ts`
- `tests/m1-us-05-db.spec.ts`
- `tests/m1-us-05-webhook.spec.ts`

## GREEN / 回归证据

```text
$ npx vitest run tests/m1-us-05-api.spec.ts tests/m1-us-05-db.spec.ts tests/m1-us-05-webhook.spec.ts

Test Files  3 passed (3)
Tests       17 passed (17)
```

```text
$ npm run typecheck

tsc -b tsconfig.build.json
exit 0
```

```text
$ npm test

Test Files  16 passed (16)
Tests       126 passed (126)
```

```text
$ npm run db:validate && npm run db:verify:migration

Prisma schema loaded from database/prisma/schema.prisma
The schema at database/prisma/schema.prisma is valid
active-slot-mismatch-rejected
source-less-reservation-rejected
readiness-event-required-rejected
over-settlement-rejected
reservation-bad-transition-rejected
reservation-partial-terminal-rejected
active-reservation-failed-terminal-rejected
audit-delete-rejected
protected-amount-update-rejected
order-amount-update-rejected
gift-price-update-rejected
guild-config-event-update-privilege-rejected
append-only-update-rejected
migration-apply-ok
table_count=47
constraint_count=3
trigger_count=7
```

## Code Review 处理

- Critical：`SUBMITTED` event sequence 与既有 `CREATED` event 冲突。已新增 `OrderStore.nextEventSequence()`，Postgres 使用 `MAX(sequence)+1`，并补回归。
- Critical：provider hold 创建后本地 commit 失败会留下 orphan hold。已在 staged commit 失败时释放 hold，并补回归。
- Important：目录快照只在事务外复核。已在 Postgres `commitSubmit` 事务内锁读并复核目录快照，并补回归。
- Important：JSON webhook 不能按原始字节验签。已使用 webhook-scoped raw-body preservation，并补回归。

## 边界与风险

- Webhook 当前只完成验签、重放拒绝、event id 去重和 acknowledgement；真实扣款/退款业务应用、`external_webhook_events` 持久去重和跨实例 exactly-once 应在后续支付/完成/退款 Story 中接入。
- 提交阶段不创建 debit external transaction，也不写 consumption；这与 OpenAPI 中“订单完成前不扣款”的边界一致。
- Provider hold 释放补偿为同步 best-effort；若真实供应商释放失败，后续需要结合 Outbox/对账任务持久化 UNKNOWN/reconciliation 记录。
