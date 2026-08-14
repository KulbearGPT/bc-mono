# M1-US-01 Evidence

Story：版本化服务目录与双价格快照

验收关联：`AT-CAT-001`、`AT-CAT-002`

## 当前状态

已完成。

完成范围：

- 建立 `@blackcat/api/catalog` domain contract、in-memory store、PostgreSQL store 和统一 API route contract。
- `listServices` 仅返回 `ACTIVE` 且客户价/陪玩价完整的服务。
- 用户端目录与估价响应不包含 `playerUnitPayoutMinor` 或 `playerEarningMinor`。
- `estimateService` 使用指定 catalog version 快照计算客户金额，内部保留陪玩收益快照供订单提交使用。
- L3+ 才能创建/更新目录版本；L2 只能读取后台目录；普通可信 Discord actor 可访问用户端目录和估价。
- 启用服务必须有客户价与陪玩价，且币种一致。
- `SUPERSEDE` 创建新版本并 retire 旧版本，不覆盖旧价格快照。
- `reasonCode` 写入成功审计原因。
- Catalog 写操作使用 M0 staged write contract，PostgreSQL store 使用独立 pooled transaction client 在同一事务中提交目录记录和 `audit_logs`。
- `buildApiServer({ security, catalog })` 可自动挂载 catalog routes；运行入口使用 `pg.Pool`、`PostgresServiceCatalogStore` 和 `PostgresStaffDirectory`。
- 非 staff Discord actor 的 idempotency scope 使用 `DISCORD:{guildId}:{discordUserId}`，避免不同用户共享 anonymous scope。
- OpenAPI 指定 path/method 的 operationId 与实现接口一致。

## 修改文件

- `apps/api/src/catalog.ts`
- `apps/api/src/index.ts`
- `apps/api/src/security.ts`
- `apps/api/src/server.ts`
- `tests/m1-us-01.spec.ts`
- `tests/m1-us-01-api.spec.ts`
- `tests/m1-us-01-db.spec.ts`

## RED 证据

```bash
npx vitest run tests/m1-us-01.spec.ts
```

```text
FAIL tests/m1-us-01.spec.ts
Error: Cannot find package '@blackcat/api/catalog'
```

```bash
npx vitest run tests/m1-us-01-api.spec.ts
```

```text
FAIL tests/m1-us-01-api.spec.ts
TypeError: registerCatalogRoutes is not a function
TypeError: PostgresServiceCatalogStore is not a constructor
```

后续 review 回归红灯覆盖：

- 普通非 staff Discord actor 被用户端目录接口拒绝。
- Dashboard source 被鉴权层拒绝。
- 审计失败后 catalog record 已落入 in-memory store。
- `buildApiServer` 未自动挂载 catalog routes。
- 非 staff Discord actor idempotency scope 落到 `SYSTEM:anonymous`。
- `PostgresServiceCatalogStore` commit 未使用 pooled dedicated transaction client。
- 缺少 DB-backed `PostgresStaffDirectory`。

## GREEN 证据

```bash
npx vitest run tests/m1-us-01.spec.ts tests/m1-us-01-api.spec.ts tests/m1-us-01-db.spec.ts
```

```text
Test Files  3 passed (3)
Tests  20 passed (20)
```

```bash
npm test
```

```text
Test Files  8 passed (8)
Tests  69 passed (69)
```

```bash
npm run typecheck
```

```text
tsc -b tsconfig.build.json
exit 0
```

```bash
npm run db:validate
```

```text
The schema at database/prisma/schema.prisma is valid
```

```bash
npm run db:verify:migration
```

```text
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

## Code Review

首轮 review 发现 Critical/Important：

- 用户端目录和估价只支持 staff actor。
- Catalog staged commit 不是业务记录和成功审计的事务提交。
- 运行入口没有挂载 catalog routes。
- Dashboard source 与 OpenAPI contract 不一致。
- `reasonCode` 丢失。
- PostgreSQL tests 不是真实 DB integration。
- OpenAPI operationId 测试过弱。
- 运行入口没有 DB-backed staff resolver。
- 生产 store 用共享 `pg.Client` 进行事务。
- 非 staff actor 的 idempotency scope 落到 anonymous。

所有 Critical/Important 均已修复并补回归。Final focused review 结论：

```text
No remaining Critical or Important issues found in the focused M1-US-01 follow-up scope.
Ready to merge? Yes
```
