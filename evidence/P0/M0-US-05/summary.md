# M0-US-05 Evidence

Story：Outbox/Job 运行器与结构化可观测性

验收关联：`AT-CHN-003`、`AT-AUD-003`

## 修改文件

- `apps/api/package.json`
- `apps/api/src/outbox.ts`
- `apps/api/src/security.ts`
- `docs/P0开发交付包/02-API/openapi.yaml`
- `docs/Codex-P0开发TODO.md`
- `package.json`
- `tests/m0-us-02.spec.ts`
- `tests/m0-us-03.spec.ts`
- `tests/m0-us-05.spec.ts`
- `outputs/P0开发交付包/02-API/openapi.yaml`
- `outputs/Codex-P0开发TODO.md`

## RED 证据

命令：

```bash
npx vitest run tests/m0-us-05.spec.ts
```

结果：

```text
FAIL tests/m0-us-05.spec.ts
Error: Cannot find package '@blackcat/api/outbox'
```

Code review follow-up RED：

```text
FAIL tests/m0-us-05.spec.ts
status: expected PROCESSING, received RUNNING
runAfter: expected 2026-07-17T12:00:03.500Z, received 2026-07-17T12:00:01.000Z
status: expected COMPLETED, received SUCCEEDED
lastError: expected SYNTHETIC_DISCORD_TIMEOUT, received null
TypeError: PostgresOutboxStore is not a constructor
```

```text
FAIL tests/m0-us-03.spec.ts -t "authorizes job.retry"
expected 403 to be 200
```

Final follow-up RED：

```text
FAIL tests/m0-us-05.spec.ts -t "recovers stale|rejects non-delivery"
TypeError: store.recoverStaleProcessingJobs is not a function
promise resolved instead of rejecting non-delivery CAPTURE_HOLD job type
```

```text
FAIL tests/m0-us-03.spec.ts -t "authorizes job.read"
expected 200 to be 403
```

## GREEN 证据

命令：

```bash
npx vitest run tests/m0-us-05.spec.ts
```

结果：

```text
Test Files  1 passed (1)
Tests  9 passed (9)
```

命令：

```bash
npm run m0:verify
```

结果：

```text
Test Files  5 passed (5)
Tests  49 passed (49)
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

## 行为覆盖

- `InMemoryOutboxStore.claimDueJobs` 支持 due job 领取、worker lock、attempt/version 增量，避免两个 worker 同时领取同一 job。
- `PostgresOutboxStore.claimDueJobs` 使用 `outbox_events`、`FOR UPDATE SKIP LOCKED`、稳定排序和 `PENDING -> PROCESSING` 原子状态迁移，提供数据库 claim/lock 合同。
- `PostgresOutboxStore.claimDueJobs` 在 SQL 层使用 delivery/system job type allowlist 过滤，避免业务交易型 event 被更新为 `PROCESSING`。
- `PostgresOutboxStore.markFailed` 对 PostgreSQL enum status 参数使用显式 `::"OutboxStatus"` cast，避免真实 pg 执行时把参数当作 text。
- `recoverStaleProcessingJobs` 可将过期 `PROCESSING` job 恢复为 `PENDING` 或在 attempt 达上限时转 `FAILED`，避免 worker crash 后永久锁定。
- `mapOutboxRow` 和 in-memory fixture 均校验 job type 只能是 delivery/system 展示类 Outbox job，拒绝 `CAPTURE_HOLD` 等业务交易型事件进入 worker handler。
- `OutboxWorker.runOnce` 支持按 job type delivery handler 执行、成功标记为 `COMPLETED`、失败按失败时间 backoff、terminal failed、`request_id` 结构化日志和 metrics hooks。
- 播报/展示类 job 成功只执行 delivery handler，不重复调用业务交易副作用。
- `retryJob` 仅允许 L2+，校验 failed job 和 expectedVersion，重置为 PENDING、保留 lastError、version +1，并写入包含 attempts/lastError/runAfter/version 的 before/after 审计快照。
- `job.read` 与 `job.retry` 已进入统一权限矩阵并与 OpenAPI L2 要求对齐；L1 被拒、L2+ 可通过 secure route contract。
- `JobStatus` 已统一为 Prisma/OpenAPI 使用的 `PENDING/PROCESSING/COMPLETED/FAILED/CANCELLED`。
- `npm run m0:verify` 已纳入 `tests/m0-us-05.spec.ts`。

## 回归验证

命令：

```bash
npm run db:validate
npm run db:verify:migration
npm audit --audit-level=moderate
```

结果：

```text
Prisma schema valid
migration-apply-ok
found 0 vulnerabilities
```

## Code Review

Final narrow review 返回：

```text
Critical: None
Important: None
Minor: None
Assessment: M0-US-05 is gate-ready.
```

## 未关闭项

- 真实 Dashboard `listFailedJobs` API、分页和 UI 将在 M4 相关 Story 接入。
- 真实 Discord credential 未提供，涉及 Discord 实服的 E2E 不阻断 M0。
