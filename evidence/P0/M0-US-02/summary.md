# M0-US-02 Evidence

Story：P0 数据库基线与不可变记录约束

验收关联：`AT-AUD-003`、`AT-REC-001`、`AT-AUD-001`

## 修改文件

- `database/package.json`
- `database/tsconfig.json`
- `database/prisma/schema.prisma`
- `database/prisma/migrations/000001_p0_baseline/migration.sql`
- `database/seed/seed-data.csv`
- `database/src/immutable-records.ts`
- `tests/m0-us-02.spec.ts`
- `package.json`
- `package-lock.json`
- `tsconfig.base.json`
- `tsconfig.build.json`
- `vitest.config.ts`

## RED 证据

命令：

```bash
npx vitest run tests/m0-us-02.spec.ts
```

结果：

```text
FAIL tests/m0-us-02.spec.ts
Error: Cannot find package '@blackcat/database/immutable-records'
```

完整 baseline migration 覆盖测试的 RED：

```text
expected migration.sql to contain 'CREATE TYPE "StaffLevel" AS ENUM'
```

## GREEN 证据

命令：

```bash
npm run m0:verify
```

结果：

```text
RUN  v4.1.10
Test Files  2 passed (2)
Tests  14 passed (14)
```

命令：

```bash
npm run db:validate
```

结果：

```text
Prisma schema loaded from database/prisma/schema.prisma
The schema at database/prisma/schema.prisma is valid
```

命令：

```bash
npm run typecheck
```

结果：

```text
tsc -b tsconfig.build.json
exit 0
```

命令：

```bash
npm audit --audit-level=moderate
```

结果：

```text
found 0 vulnerabilities
```

## Migration 证据

`database/prisma/migrations/000001_p0_baseline/migration.sql` 已由 Prisma 从 `database/prisma/schema.prisma` 生成完整空库 baseline，并追加 P0 PostgreSQL 补充约束：

- `CREATE TYPE "StaffLevel" AS ENUM`
- `CREATE TABLE "users"`
- `CREATE TABLE "orders"`
- `CREATE TABLE "fund_reservations"`
- currency 三位大写格式约束
- minor units 非负约束
- `fund_reservation_not_over_settled_chk`
- active customer/player slot 状态约束
- active customer/player slot 必须绑定实际 `customer_id` / `player_id`
- `fund_reservation_source_binding_chk`
- `trg_fund_reservation_event_guard`
- `trg_order_readiness_guard`
- `trg_referral_attribution_guard`
- `trg_commission_attribution_guard`
- `trg_external_transaction_reservation_guard`
- `trg_guild_bot_config_event_immutable`
- `protect_amount_minor_update`
- `deny_append_only_mutation`
- `referral_attribution_not_self_chk`
- `blackcat_app` application role
- immutable business tables 的 `REVOKE DELETE`
- protected amount columns 的 `REVOKE UPDATE`

## Empty Database Apply

命令：

```bash
npm run db:verify:migration
```

结果：

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

## Seed 证据

`database/seed/seed-data.csv` 已同步 P0 批准的业务配置资料，包括 L1-L4 access policy、L2/L4 金额阈值、资金预留策略、两种一级返佣计划和基础权限代码。

## 未关闭项

- Follow-up code review 已通过。后续资金服务/API 写路径实现时，应进一步收紧 `blackcat_app` 对 `fund_reservations` 的直接状态更新权限。
