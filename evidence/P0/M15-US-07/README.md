# M15-US-07 验收证据

## Story

- Story：`M15-US-07` 客户 Profile 展示名编辑
- 验收：`AT-DOP-006`
- 状态：本地自动化完成

## 实现

- `customer_profile.manage` 从 L2 开始累积授权，L1 保持只读。
- PATCH 只接受 displayName、expectedVersion、reasonCode 和 note；额外字段由 API 拒绝。
- 更新使用可信 Dashboard Actor Guild 和 Profile scope，旧版本返回 409；成功写入审计并刷新 Profile。
- UI 不提供 Discord ID、内部用户 ID、钱包、订单历史或内部备注的编辑能力。

## RED

实现前 `tests/m15-us-07-customer-profile-edit.spec.ts` 为 1 file / 2 tests failed：权限与 Dashboard 请求构造均缺失。

## GREEN

```text
Profile/API/Dashboard Vitest: 5 files / 28 tests passed
API typecheck: passed
Dashboard typecheck: passed
Dashboard production build: passed
Dashboard E2E coverage: 127 planned = 127 implemented
Chromium dashboard-profile-wallet.spec.ts: 14/14 passed in 24.0s
```

`DE2E-PRF-005` 将“E2E 老板”纠正为“北美老板小林”；内部 ID、Discord ID、USD 账本、预留和钱包版本均保持不变，仅客户版本 2→3。

## 剩余边界

这不是通用 CRM；没有其他身份或财务字段编辑。真实员工 UAT 尚未执行。
