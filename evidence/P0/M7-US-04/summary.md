# M7-US-04 钱包与客服资金 API 证据

- Story：M7-US-04
- 日期：2026-07-21
- 验收：AT-WAL-003、AT-WAL-004、AT-WAL-005、AT-WAL-006、AT-WAL-007、AT-WAL-008、AT-WAL-009

## RED

```text
npx vitest run tests/m7-us-04-wallet.spec.ts tests/m7-us-04-api.spec.ts tests/m7-us-04-db.spec.ts
FAIL: Cannot find package @blackcat/api/wallet
FAIL: wallet.read / wallet.top_up / wallet.external_refund / wallet.adjust 权限不存在
FAIL: wallet.ts 与 receipt-storage.ts 不存在
```

## 合同冲突修正

实现前发现旧 API 要求先上传 `attachmentIds`，但数据合同要求 ReceiptAttachment 创建时必须关联且只追加，无法在上传后 UPDATE 绑定。已先独立提交 `1fcfbe9`：充值或渠道退款先完成，可选附件随后用 `evidenceType + evidenceId` 创建并一次性绑定；不创建悬空附件。合同测试 12/12 通过。

## 实现

- 新增 `WalletService`、`InMemoryWalletStore`、`PostgresWalletStore`；余额只汇总 USD WalletEntry，并减去活动 FundReservation 剩余金额。
- 自动创建一用户一钱包；钱包余额和版本服务端计算。
- 充值必填正整数 amountMinor、paymentChannel、externalTransactionId、paidAt、note；同渠道交易号重复拒绝；成功立即追加 TOP_UP_CREDIT。
- `amountMinor <= 500000` 允许 L1，`500001` 起最低 L2；渠道退款扣款最低 L2，Adjustment 最低 L3。
- 渠道退款在钱包行锁下重算 availableMinor，不能使用活动预留，不能形成负余额；Adjustment 必须链接原 WalletEntry。
- PostgreSQL 充值和渠道退款采用 staged commit，将钱包账户/版本、证据、WalletEntry、AuditLog 与 AuditLogChange 放入同一事务；审计明细失败时全部回滚。
- 新增 `@fastify/multipart` 与私有文件存储：JPEG/PNG/WebP/PDF、最大 10485760 bytes、opaque UUID key、0600 文件、SHA-256；API 只返回安全元数据，下载重新鉴权。
- 钱包启用时不再注册旧 `/api/v1/bindings` 与 Provider balance 路由；旧源码和 Provider 运行时依赖将在 M7-US-07 物理删除。

## GREEN

```text
npx vitest run tests/m7-us-04-wallet.spec.ts tests/m7-us-04-api.spec.ts tests/m7-us-04-db.spec.ts
Test Files  3 passed (3)
Tests       12 passed (12)

npx vitest run tests/m7-us-04-wallet.spec.ts tests/m7-us-04-api.spec.ts tests/m7-us-04-db.spec.ts tests/m1-us-02-api.spec.ts tests/m1-us-06-api.spec.ts tests/m0-us-03.spec.ts tests/m7-us-03-audit.spec.ts
Test Files  7 passed (7)
Tests       47 passed (47)

npm run build
exit 0
```

## 剩余风险

订单、礼物、业务退款、Profile、指标和结算仍使用旧资金实现，属于 M7-US-05。Dashboard/Discord 客户流程属于 M7-US-06。旧 Provider 源码、环境变量、Webhook 与测试仍存在但生产钱包配置不注册 binding/balance 路由，物理退役和全量回归属于 M7-US-07。
