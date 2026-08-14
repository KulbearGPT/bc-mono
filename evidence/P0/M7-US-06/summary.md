# M7-US-06 Dashboard 钱包与 Discord 客服引导证据

- Story：M7-US-06
- 日期：2026-07-21
- 验收：AT-WAL-003、AT-WAL-007、AT-WAL-009

## RED

```text
pnpm exec vitest run tests/m7-us-06-dashboard.spec.ts tests/m7-us-06-bot.spec.ts
FAIL: CustomerWalletPanel / customer-wallet module 不存在
FAIL: buildCurrentWalletMessage 不存在
FAIL: Discord 仍包含 binding modal、第三方充值 Link 和 Provider 余额字段
```

## 实现

- 客户 Profile 新增内部 USD 钱包面板，直接显示 API 返回的 ledger/reserved/available，不在客户端复制权限、阈值或可用余额计算。
- 充值与渠道退款扣款表单要求金额、支付渠道、渠道交易号、付款/退款时间和备注；receipt 图片/PDF 可选。
- 资金事实先以稳定幂等键提交；成功后可选上传 receipt，并用 `evidenceType`、`evidenceId` 绑定已创建事实。失败重试保留原资金幂等键，处理期间禁用重复提交。
- 钱包流水表读取 append-only WalletEntry；金额统一按 USD minor units 展示。
- Discord 服务中心、个人中心、订单确认与礼物余额不足流程改用内部钱包字段；余额私密展示，余额不足只引导联系客服并提交付款 receipt，不再生成第三方充值链接。
- 移除 Bot 账户绑定 HTTP 客户端、Modal、custom ID 路由和提交处理；账户不可用时仅返回私密客服指引。
- 受影响的历史 Bot/Dashboard 测试同步到 USD 与内部钱包客户端合同。

## GREEN

```text
pnpm exec vitest run tests/*-bot.spec.ts tests/*-dashboard.spec.ts
Test Files  30 passed (30)
Tests       139 passed (139)

pnpm exec tsc -p apps/dashboard/tsconfig.json --noEmit
exit 0

pnpm exec tsc -p apps/bot/tsconfig.json --noEmit
exit 0

npm run build
exit 0

npm run build -w @blackcat/dashboard
✓ built in 688ms

git diff --check
exit 0
```

## 剩余风险

- 全仓旧 API/数据库测试和源码仍含 Provider、CNY、绑定、Webhook、充值链接及旧迁移夹具；一次全仓探针为 59 个失败，主要是这些待退役合同与未应用 `000009` 的历史测试数据库。它们属于 M7-US-07，不能作为当前发布候选。
- 本 Story 仅声明客户端钱包和客服引导完成，不声明 M7 或发布门禁完成。
