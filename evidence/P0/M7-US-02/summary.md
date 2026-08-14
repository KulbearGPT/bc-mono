# M7-US-02 钱包持久化证据

- Story：M7-US-02
- 日期：2026-07-21
- 验收：AT-WAL-001、AT-WAL-002、AT-AUD-005

## RED

```text
npx vitest run tests/m7-us-02-db.spec.ts
FAIL: ENOENT database/prisma/migrations/000010_internal_usd_wallet/migration.sql
Tests 3 skipped
```

## 实现

- 新增 wallet_accounts、wallet_entries、top_ups、external_refund_debits、receipt_attachments、audit_log_changes。
- AuditLog 新增 idempotency/job/trigger/retry 上下文。
- 数据库强制钱包 USD、金额为正、充值 `payment_channel + external_transaction_id` 唯一、WalletEntry 类型与方向一致。
- 钱包行锁与触发器拒绝会形成负账本的 DEBIT。
- TopUp/ExternalRefundDebit 与 WalletEntry 的账户、金额、币种、来源和类型必须一致。
- 凭证必须且只能关联一项资金证据，限制图片/PDF、正文件大小和小写 SHA-256。
- WalletEntry、TopUp、ExternalRefundDebit、ReceiptAttachment、AuditLog、AuditLogChange 由数据库与应用双层保护为只追加。
- 迁移验证脚本从显式停在 000006 改为顺序执行全部迁移目录，并补齐 000007 后所需的 Guild 数据探针。

## GREEN

```text
npx vitest run tests/m7-us-02-db.spec.ts tests/m0-us-02.spec.ts
Test Files  2 passed (2)
Tests       9 passed (9)

npm run db:validate
The schema at database/prisma/schema.prisma is valid

npm run db:verify:migration
migration-apply-ok
table_count=66

npm run typecheck
exit 0
```

## 剩余风险

本 Story 只交付持久化与约束。通用写操作审计封套属于 M7-US-03，钱包业务 API 与 availableMinor 并发语义属于 M7-US-04，旧 Provider 表和运行时代码将在 M7-US-07 退役。
