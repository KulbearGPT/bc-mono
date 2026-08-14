# M7-US-05 订单、礼物、退款与资金投影迁移证据

- Story：M7-US-05
- 日期：2026-07-21
- 验收：AT-WAL-001、AT-WAL-002、AT-WAL-010

## RED

```text
npx vitest run tests/m7-us-05-funding-migration.spec.ts tests/m7-us-05-funding-db.spec.ts
FAIL: WalletService.capture is not a function
FAIL: orders.ts、gifts.ts、admin-order-actions.ts 仍执行 Provider 资金调用
```

## 实现

- WalletFundingService 补齐 reserve、capture、release、creditBusinessRefund；内存与 PostgreSQL 实现统一使用 USD、幂等键、钱包行锁和 FundReservation 生命周期。
- 订单和礼物创建在既有业务事务中锁定钱包、读取 WalletEntry 账本、扣除活动预留并原子创建 LOCAL_RESERVATION，避免并发超支。
- 订单完成、礼物批准和提前结案捕获分别追加 ORDER_CAPTURE_DEBIT 或 GIFT_CAPTURE_DEBIT；捕获幂等且只记一次账。
- 订单取消、礼物拒绝/撤回/过期只追加 RELEASED/EXPIRED 事件，不产生 WalletEntry。
- 业务退款不再调用外部渠道，改为在退款、消费冲正、收益/返佣调整和审计的同一事务内追加 ORDER_REFUND_CREDIT。
- Profile 读取 WalletBalance；交易时间线新增 WALLET_ENTRY；Dashboard 指标和结算只接受 USD。
- 生产订单、礼物和退款配置不再注入 Provider 资金适配器。旧资金适配器、绑定、支付 Webhook 和外部交易兼容镜像的物理退役属于 M7-US-07。
- 原 M1-M6 中断言 Provider hold、Provider timeout、CNY 或 Provider balance fallback 的冲突测试已改写为内部钱包合同，同时保留并发锁、状态机、RBAC、step-up、退款调整和审计覆盖。

## GREEN

```text
npx vitest run tests/m7-us-01-contract.spec.ts tests/m7-us-02-db.spec.ts tests/m7-us-03-audit.spec.ts tests/m7-us-03-audit-db.spec.ts tests/m7-us-04-wallet.spec.ts tests/m7-us-04-api.spec.ts tests/m7-us-04-db.spec.ts tests/m7-us-05-funding-migration.spec.ts tests/m7-us-05-funding-db.spec.ts
Test Files  9 passed (9)
Tests       28 passed (28)

npx vitest run tests/m1-us-05-* tests/m1-us-08-* tests/m2-us-05-* tests/m2-us-06-* tests/m2-us-10-* tests/m3-us-01-* tests/m3-us-03-* tests/m3-us-06-* tests/m4-us-08-* tests/m4-us-09-* tests/m6-us-04-* tests/m7-us-05-* --reporter=dot
Test Files  32 passed (32)
Tests       85 passed (85)

npm run typecheck
exit 0

npm run build
exit 0

git diff --check
exit 0
```

## 剩余风险

- Dashboard 钱包表单、流水、附件与 Discord 内部余额/联系客服流程属于 M7-US-06。
- Provider 源码、环境变量、账户绑定、充值链接、支付 Webhook、沙箱和旧兼容镜像尚未物理删除，属于 M7-US-07。
- 本 Story 只声明资金领域迁移完成，不声明整个 M7 或产品已完成。
