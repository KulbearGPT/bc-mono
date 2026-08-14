# M15-US-05 验收证据

## Story

- Story：`M15-US-05` 钱包 Adjustment 冲正工作流
- 验收：`AT-DOP-004`
- 状态：本地自动化完成

## 实现

- 只有具 `wallet.adjust` 的 L3+ 在客户 Profile 看到“账目冲正”。
- 表单从既有非 Adjustment 流水选择原始账目，收集 CREDIT/DEBIT、USD 金额和必填原因。
- 请求提交 `expectedWalletVersion` 和幂等键；余额只能由统一 API 在并发边界重算。
- 新流水通过 `reversalOfEntryId` 关联原记录；界面不提供修改或删除原流水的能力。

## RED

`npx vitest run tests/m15-us-05-wallet-adjustment-dashboard.spec.ts`：1 file / 2 tests failed，缺少候选筛选与请求构造实现。

## GREEN

```text
Wallet/model Vitest: 2 files / 7 tests passed
API typecheck: passed
Dashboard typecheck: passed
Dashboard production build: passed
Dashboard E2E coverage: 125 planned = 125 implemented
Chromium dashboard-profile-wallet.spec.ts: 13/13 passed in 44.6s
```

现实场景 `DE2E-WLT-011`：客服先登记老板 USD 50.00 充值，复核收据后选择原流水追加 USD 12.50 debit Adjustment；原充值仍为 USD 50.00，预留仍为 USD 25.00，最终 ledger/available 为 USD 137.50 / USD 112.50。

## 剩余边界

不修改或删除原账目，不连接第三方支付渠道。真实员工 UAT 尚未执行。
