# M1-US-02 Evidence

Story：一次性绑定与实时账户摘要

验收关联：`AT-ACC-001`、`AT-ACC-002`、`AT-RES-002`

## 当前状态

已完成。

完成范围：

- 建立 `@blackcat/api/accounts` domain contract、in-memory store、PostgreSQL store 和统一 API route contract。
- `createBinding` 仅接受 Discord Bot 来源和一次性绑定码 `ONE_TIME_CODE`，拒绝稳定 `EXTERNAL_USER_ID` 绑定，避免用长期第三方用户 ID 绕过绑定流程。
- 通过 Provider adapter 验证绑定码，保存 Discord 用户与第三方账户的唯一映射，不保存第三方密码。
- 绑定响应、审计记录和幂等 fingerprint 不包含原始绑定码。
- Discord 账号和第三方外部账号均有冲突检测；提交阶段的并发唯一性冲突映射为 `BINDING_CONFLICT`/409。
- 绑定写操作使用 M0 staged write contract；in-memory 和 PostgreSQL store 都能在成功审计提交失败时回滚绑定记录。
- `PostgresAccountStore.createBinding` 使用事务包裹 user、discord account 和 external account 写入，后续唯一性失败不会留下部分绑定记录。
- `getCurrentUser` 仅返回当前 Discord actor 的本人账户摘要，不泄露原始 provider external user id。
- `getCurrentBalance` 每次从 Provider 查询真实余额，并由 API 派生 `availableMinor = providerBalanceMinor - reservedMinor`；`reservedMinor` 只统计 active reservation statuses。
- `buildApiServer({ security, account })` 可自动挂载 account routes；运行入口使用 `pg.Pool`、`PostgresAccountStore`、`MockFundingAdapter` 和 `PostgresStaffDirectory`。
- OpenAPI `createBinding`、`getCurrentUser`、`getCurrentBalance` 的 path/method operationId 与实现一致；绑定输入枚举已收窄为 `ONE_TIME_CODE`。

## 修改文件

- `apps/api/src/accounts.ts`
- `apps/api/src/index.ts`
- `apps/api/src/security.ts`
- `apps/api/src/server.ts`
- `docs/P0开发交付包/02-API/openapi.yaml`
- `outputs/P0开发交付包/02-API/openapi.yaml`
- `tests/m1-us-02-api.spec.ts`
- `tests/m1-us-02-db.spec.ts`

## RED 证据

```bash
npx vitest run tests/m1-us-02-api.spec.ts
```

```text
FAIL tests/m1-us-02-api.spec.ts
createBinding rejects stable external user ids and requires a one-time binding code
  expected 201 to be 400
createBinding is only accepted from the Discord bot client source
  expected 201 to be 403
createBinding maps typed commit-time binding conflicts instead of returning a generic 500
  expected 500 to be 409
documents implemented account operationIds on the expected OpenAPI paths
  expected '' to contain 'enum: [ONE_TIME_CODE]'
```

早期 RED 证据：

- `@blackcat/api/accounts` 不存在时，M1-US-02 API/DB tests 无法导入目标模块。
- `PostgresAccountStore.createBinding` 在外部账号唯一性失败时留下部分 user/discord account 记录。

## GREEN 证据

```bash
npx vitest run tests/m1-us-02-api.spec.ts
```

```text
Test Files  1 passed (1)
Tests  11 passed (11)
```

```bash
npx vitest run tests/m1-us-02-db.spec.ts
```

```text
Test Files  1 passed (1)
Tests  4 passed (4)
```

```bash
npm test
```

```text
Test Files  10 passed (10)
Tests  84 passed (84)
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

Focused review found no Critical issues and three Important items:

- Stable `EXTERNAL_USER_ID` binding bypassed the one-time binding code requirement.
- Commit-time Postgres uniqueness conflicts could return generic `COMMIT_FAILED`/500.
- `POST /api/v1/bindings` did not enforce OpenAPI `acceptedSources: [DISCORD_BOT]`.

All three were fixed with regression tests. The minor contract mismatch for account error codes was addressed by updating the OpenAPI error enum.

## 边界

- Discord Bot credentials are still not provided, so real Discord interaction E2E is intentionally not part of this Story evidence.
- This Story does not implement self-service unbind, multi-account switching, local wallet, recharge UI, or order draft creation.
