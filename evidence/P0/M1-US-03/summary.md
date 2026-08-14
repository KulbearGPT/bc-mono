# M1-US-03：即时订单草稿与服务端估价

- Story：M1-US-03
- 状态：完成
- 日期：2026-07-17
- 责任类型：backend_api
- 验收用例：AT-ORD-001；AT-ORD-002

## 合同读取

- `AGENTS.md`
- `docs/Codex-P0开发TODO.md`
- `outputs/Codex-P0开发TODO.md`
- `docs/P0开发交付包/02-API/openapi.yaml`
- `database/prisma/schema.prisma`
- `database/prisma/migrations/000001_p0_baseline/migration.sql`

## RED 证据

```text
$ npx vitest run tests/m1-us-03-api.spec.ts

FAIL tests/m1-us-03-api.spec.ts
Error: Cannot find package '@blackcat/api/orders'
```

```text
$ npx vitest run tests/m1-us-03-db.spec.ts

FAIL tests/m1-us-03-db.spec.ts
TypeError: PostgresOrderStore is not a constructor
```

数据库测试继续暴露现有 migration 与 Story 的冲突：

```text
error: protected amount column orders.customer_unit_price_minor cannot be updated directly
```

因此将 `protect_amount_minor_update()` 收窄为：普通订单金额覆写仍拒绝；只有 `orders` 表、`DRAFT -> DRAFT`，且 API 事务内设置 `app.order_draft_amount_update=approved` 时，才允许服务端更新草稿估价快照。

## 实现摘要

- 新增 `@blackcat/api/orders`：
  - `InMemoryOrderStore`
  - `PostgresOrderStore`
  - `registerOrderRoutes`
  - `createOrder/getOrder/updateOrder/estimateOrder` 对应的领域逻辑
- `createOrder`：
  - 绑定用户才可创建。
  - 每个客户只允许一个活跃订单。
  - 新建草稿返回 `201`，已有活跃订单返回 `200` 和现有订单。
  - 创建 `CREATED` order event，并与 audit 一起提交。
- `updateOrder`：
  - 仅订单所有者可更新。
  - 仅 `DRAFT` 可更新。
  - 使用 `expectedVersion` 乐观并发控制。
  - 从服务目录快照游戏、服务、区服、计价单位、客户单价、陪玩结算单价和目录版本。
  - 金额仅由服务端计算，客户端不能自报价格。
  - 创建 `DETAILS_UPDATED` order event，并与 audit 同事务提交。
- `estimateOrder`：
  - 不修改订单版本，不写事件。
  - 响应不包含 `playerEarningMinor`。
- `buildApiServer` 与 API runtime 挂载 order routes。
- 安全中间件支持 staged write 自定义成功状态码，并将 `order.create/read/update/estimate` 纳入 authenticated actor permission。

## 修改文件

- `apps/api/src/orders.ts`
- `apps/api/src/security.ts`
- `apps/api/src/server.ts`
- `apps/api/src/index.ts`
- `apps/api/package.json`
- `database/prisma/migrations/000001_p0_baseline/migration.sql`
- `tests/m1-us-03-api.spec.ts`
- `tests/m1-us-03-db.spec.ts`

## GREEN / 回归证据

```text
$ npx vitest run tests/m1-us-03-api.spec.ts tests/m1-us-03-db.spec.ts

Test Files  2 passed (2)
Tests       10 passed (10)
```

```text
$ npm run typecheck

tsc -b tsconfig.build.json
exit 0
```

```text
$ npm test

Test Files  12 passed (12)
Tests       94 passed (94)
```

```text
$ npm run db:validate

Prisma schema loaded from database/prisma/schema.prisma
The schema at database/prisma/schema.prisma is valid
```

```text
$ npm run db:verify:migration

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

## 风险与非目标

- Discord Bot credential 暂未提供，未执行真实 Discord 端交互测试。
- 本 Story 不包含订单提交、资金预留、派单、取消、完成、预约、多人订单或多个活跃订单。
- 草稿金额更新只允许统一 API 的受控事务路径；普通直接更新仍由 migration verifier 证明会被拒绝。
