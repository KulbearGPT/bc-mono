# M16-US-02 统一 API 错误与幂等恢复

## 结果

- `AT-REV-002`：钱包流水运行时返回 `{ items, nextCursor }`，内存与 PostgreSQL 均使用 `occurredAt + id` 稳定降序 keyset；游标由 HMAC 签名并绑定 `userId`。
- `AT-REV-003`：读/写安全路由均在认证后解析 `targetId`，解析错误进入 `mapError`、标准 error envelope 和 `REJECTED` 审计，不再泄漏 Fastify 500。
- `AT-REV-004`：业务与成功审计提交后，幂等完成最多尝试三次；仍失败则以 `COMMITTED_RESPONSE_RECOVERY` 写入终态记录并保留原成功 status/payload。同 key 仅回放原响应，不重跑 handler/commit。

## RED

```text
npx vitest run tests/m16-us-02-api-resilience.spec.ts
Test Files  1 failed (1)
Tests       3 failed (3)
```

三个失败分别为：非法 target 返回 500、幂等 complete 失败后返回 500、钱包返回裸数组。

## GREEN 与回归

```text
npx vitest run tests/m16-us-02-api-resilience.spec.ts
Test Files  1 passed (1)
Tests       3 passed (3)

npx vitest run tests/m0-us-03.spec.ts tests/m1-us-01-api.spec.ts tests/m1-us-05-api.spec.ts tests/m1-us-08-api.spec.ts tests/m7-us-01-contract.spec.ts tests/m7-us-03-audit.spec.ts tests/m7-us-04-api.spec.ts tests/m16-us-02-api-resilience.spec.ts
Test Files  8 passed (8)
Tests       52 passed (52)

npx vitest run tests/m7-us-04-db.spec.ts
Test Files  1 passed (1)
Tests       4 passed (4)

npm run typecheck
exit 0
```

`npm test` 在当前中间状态为 `215 passed / 3 failed` test files、`1053 passed / 7 failed` tests；失败中 6 条是验收矩阵尚要求未开始的 `M16-US-03/04` 必须已有可执行测试，1 条是 M7 历史合同测试仍断言 USD 钱包。M7 断言已更新为 M9/M16 现行 CAT 边界；矩阵计划态语义在 `M16-US-04` 质量门禁 Story 收口。本 Story 不虚假声称全量回归已通过。

## 修改文件

- `apps/api/src/security.ts`
- `apps/api/src/signed-cursor.ts`
- `apps/api/src/wallet.ts`
- `tests/m16-us-02-api-resilience.spec.ts`
- `tests/m7-us-04-db.spec.ts`
- `tests/m1-us-05-api.spec.ts`
- `tests/m1-us-08-api.spec.ts`
- `tests/m7-us-01-contract.spec.ts`
- OpenAPI、backlog、TODO 及对应 `docs/` 镜像

## 剩余风险

如果数据库对幂等正常完成和终态恢复写入都持续不可用，当次 HTTP 仍只能返回 500；业务事实已提交时无法用独立幂等表在数据库全面不可用期间制造原子终态。短暂单点失败和独立终态更新失败已由故障注入覆盖。
