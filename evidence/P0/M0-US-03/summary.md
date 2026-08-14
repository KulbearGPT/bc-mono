# M0-US-03 Evidence

Story：统一鉴权、Actor Context、幂等与审计中间件

验收关联：`AT-AUTH-001`、`AT-RBAC-001`、`AT-AUD-001`

## 修改文件

- `apps/api/package.json`
- `apps/api/src/server.ts`
- `apps/api/src/security.ts`
- `package.json`
- `tests/m0-us-02.spec.ts`
- `tests/m0-us-03.spec.ts`

## RED 证据

命令：

```bash
npx vitest run tests/m0-us-03.spec.ts
```

结果：

```text
FAIL tests/m0-us-03.spec.ts
Error: Cannot find package '@blackcat/api/security'
```

## GREEN 证据

命令：

```bash
npx vitest run tests/m0-us-03.spec.ts
```

结果：

```text
Test Files  1 passed (1)
Tests  15 passed (15)
```

命令：

```bash
npm run m0:verify
```

结果：

```text
Test Files  3 passed (3)
Tests  29 passed (29)
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

- 无效 Bot service token 时返回 `401 AUTH_REQUIRED`，伪造的 `X-Actor-Level` / `X-Actor-Staff-Id` 不被解析为授权事实。
- 有效 Bot service token 后，API 通过 `X-Actor-Discord-User-Id` 与 `X-Actor-Guild-Id` 解析内部 staff 账号和真实等级。
- L1 访问 `gift.approve` 返回 `403 PERMISSION_DENIED` 并写拒绝审计。
- L1 访问基础客服动作 `staff_task.claim` 成功并写成功审计。
- 写操作缺少 `Idempotency-Key` 返回 `400 VALIDATION_ERROR` 并写拒绝审计。
- `Idempotency-Key` 按 OpenAPI 合同校验长度 16-200 与字符集 `^[A-Za-z0-9:_-]+$`，短 key、空格等非法 key 返回 `400 VALIDATION_ERROR` 并写拒绝审计。
- 同一 `Idempotency-Key` 与同一 fingerprint 重试返回首次响应；同 key 不同 payload 返回 `409 IDEMPOTENCY_CONFLICT`。
- `Idempotency-Key` 作用域按 `clientId + operation + actorKey + key` 计算，符合数据库唯一约束口径；不同 actor 或不同操作可以复用同一稳定 key。
- 同作用域并发重复请求会先原子占位；只有第一个请求执行 handler，后续请求等待首次结果并 replay，不重复执行副作用。
- 首次 handler 失败、失败审计 append 失败、snapshot resolver 失败或 success audit append 失败时，幂等记录保存失败响应；同 fingerprint 重试 replay 首次失败响应，不重复执行 handler。
- route handler 可返回 transactional staged write `{ data, commit(successAuditRecord) }`；middleware 会构造完整 SUCCEEDED audit record 交给 `commit`，由真实业务端点在自己的事务中同时提交业务副作用和 audit；若 commit 失败，middleware 不会自行追加 SUCCEEDED audit，并会保存/replay `COMMIT_FAILED`。
- `actorKey` 使用合同格式：`STAFF:<uuid>`、`USER:<uuid>` 或 `SYSTEM:<stable-name>`。
- 缺失或非法 `X-Client-Source` 返回认证错误，避免错误归因到默认客户端。
- 审计记录包含 actor、level、source、client、interaction、permission、target、request_id、outcome 和 reason；支持 route 级 before/after snapshot 写入；不会记录 Bearer token 原文。

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

## 未关闭项

- 当前实现是 M0 级 API 安全中间件和测试探针路由；真实业务端点接入将在后续 Story 中逐个完成。
- Dashboard session / OAuth、CSRF、MFA、step-up、数据库持久化 IdempotencyRecord、真实 audit_logs 写入和数据库事务边界将在后续 Dashboard/业务 API Story 中完成。
- Code review follow-up 通过：Critical none，Important none；真实 side-effecting write route 必须使用 staged `{ data, commit(successAuditRecord) }` contract。
