# M15-US-06 验收证据

## Story

- Story：`M15-US-06` 员工控制陪玩接单资格
- 验收：`AT-DOP-005`
- 状态：本地自动化完成

## 实现

- L3+ 在陪玩集合使用“管理接单资格”，以 expectedVersion 设置 ACTIVE、PAUSED 或 SUSPENDED。
- 资格由统一 API 的内部 `reviewStatus` 决定；陪玩没有 Dashboard/Bot 自助开关，Discord presence 仅供诊断。
- 页面明确显示“可进入候选池 / 已暂停 / 已停用”，不再从旧 availability 推导授权。
- 既有选择池/派单领域回归继续验证非 ACTIVE 陪玩不能进入候选与申请路径。

## RED 与缺陷

实现前 model 1 file / 2 tests failed：缺少 Dashboard 动作与 API 映射。

E2E 首次运行还发现 1 个既有显示缺陷：后端已返回 PAUSED 时，陪玩卡片仍写“可参与派单”。修复后卡片完全以服务端准入状态表达新接单资格。

## GREEN

```text
Player domain/API/Dashboard Vitest: 4 files / 18 tests passed
API typecheck: passed
Dashboard typecheck: passed
Dashboard production build: passed
Dashboard E2E coverage: 126 planned = 126 implemented
Chromium dashboard-players.spec.ts: 8/8 passed in 26.5s
```

`DE2E-PLY-010` 在老板服务中投诉的现实场景下暂停陪玩：操作前候选列表包含该人，操作后立即排除，旧订单事实未被修改。

## 剩余边界

不替代既有订单候选/申请流程，不将在线状态视为资格。真实 Discord presence 与员工 UAT 尚未执行。
