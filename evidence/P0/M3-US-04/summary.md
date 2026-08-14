# M3-US-04 验收证据

## 已完成

- 复用 M2 完成订单事务：每订单只创建一条 PENDING PlayerEarning，金额来自订单保存的陪玩单价与单位快照，不读取后续目录价格。
- 新增本人收益列表、L2+ 管理列表和 L3+ 收益变更 API；Discord Bot 与 Dashboard 共用同一业务接口。
- 本人列表从 Discord guild/user 绑定推导 player user，不接受客户端传入他人 playerId。
- L2 只读；CONFIRM、MARK_PAID、CREATE_REVERSAL 均要求 L3+、近期 step-up、原因、对象版本和幂等键。
- 状态只允许 PENDING→CONFIRMED→PAID；人工支付仅记录事实，不调用任何转账或提现能力。
- 原始 amountMinor、orderId、playerId 不修改；冲减只追加 REVERSAL_DEBIT PlayerEarningAdjustment，并派生 netAmountMinor。
- M2 退款/结案路径继续通过 sourceRefundId/sourceResolutionId 追加 Adjustment，不创建第二条订单收益。
- 没有收益删除端点，也不包含自动提现、税务或工资单。

## 验证结果

- 相关回归：`pnpm vitest run tests/m2-us-04-api.spec.ts tests/m2-us-04-db.spec.ts tests/m2-us-06-db.spec.ts tests/m3-us-04-api.spec.ts tests/m3-us-04-db.spec.ts`，5 files / 26 tests passed。
- 全量：`pnpm test`，65 files / 309 tests passed。
- `pnpm typecheck`、`pnpm db:validate`、`pnpm db:verify:migration` passed。

## 验收映射

- AT-EAR-001：订单完成按保存快照创建唯一 PENDING 收益，不自动支付。
- AT-EAR-002：L2 写入被拒绝，L3+ recent step-up、原因和审计上下文后可确认及标记人工已支付。
- AT-EAR-003：退款/纠错追加 Adjustment，主收益金额不可变，净收益按调整汇总。

## 环境边界

- PAID 表示运营已在外部完成支付并登记，不代表系统自动转账；P0 明确不实现提现或支付通道。
