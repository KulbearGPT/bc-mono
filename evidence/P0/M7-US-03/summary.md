# M7-US-03 通用写操作审计封套证据

- Story：M7-US-03
- 日期：2026-07-21
- 验收：AT-AUD-005、AT-AUD-006、AT-AUD-007、AT-AUD-008

## RED

```text
npx vitest run tests/m7-us-03-audit.spec.ts tests/m7-us-03-audit-db.spec.ts
FAIL: apps/api/src/audit-changes.ts 不存在
FAIL: AuditLog 新触发上下文为空、AuditLogChange 未写入、非法明细未回滚审计头
```

## 实现

- 新增统一审计变化规范化模块，生成主对象变化、排序去重 changedFields、递归删除密钥/令牌/Cookie/卡号/CVV/附件正文/签名 URL，并将超过 64 KiB 的快照替换为长度与 SHA-256 摘要。
- 安全写路由对成功、失败、拒绝统一记录幂等键；成功记录至少一个逐对象变化，失败和拒绝明确记录空变化数组。
- PostgreSQL 审计写入在同一事务保存 AuditLog 与有序 AuditLogChange，任一明细失败即回滚审计头；已有业务 Store 的事务内审计插入全部复用该实现。
- 审计写入会探测 M7 列能力：当前完整 schema 保存扩展字段和明细，历史 Story 只加载旧迁移时仍使用原字段写入，避免改写历史迁移。
- Dashboard logout 改用安全写路由；Outbox Worker 的成功、失败和人工重试记录 SYSTEM_JOB、jobId、triggerSource、retryAttempt、幂等键及受影响对象，生产 Worker 使用 PostgreSQL 审计写入器。
- 旧第三方支付 Webhook 属于 M7-US-07 的删除目标，静态覆盖测试显式隔离该文件，不为即将退役的 Provider 资金入口增加新能力。

## GREEN

```text
npx vitest run tests/m7-us-03-audit.spec.ts tests/m7-us-03-audit-db.spec.ts tests/m0-us-03.spec.ts tests/m0-us-05.spec.ts
Test Files  4 passed (4)
Tests       32 passed (32)

npx vitest run tests/m2-us-06-db.spec.ts tests/m6-us-03-db.spec.ts tests/m1-us-05-db.spec.ts tests/m3-us-01-db.spec.ts tests/m2-us-11-db.spec.ts tests/m5-us-02-worker-db.spec.ts tests/m4-us-05-db.spec.ts tests/m4-us-06-db.spec.ts tests/m1-us-02-db.spec.ts tests/m1-us-03-db.spec.ts tests/m4-us-10-db.spec.ts
Test Files  11 passed (11)
Tests       48 passed (48)

npm run typecheck
exit 0
```

## 全量回归状态与剩余风险

`npm test` 曾在集中审计插入首次运行时失败；其中由 M7 新审计列导致的旧迁移兼容失败已经修复并以上述 48 个数据库回归验证。剩余失败是 M7-US-01 已替换但旧测试仍断言 Provider/CNY/binding operationId 的合同和派生验收矩阵，须在 M7-US-07 的 Provider 退役与矩阵重建中收口。

本 Story 不声称内部钱包 API 已实现；充值、渠道退款扣款、资金迁移、客户端和 Provider 退役分别属于 M7-US-04 至 M7-US-07。
