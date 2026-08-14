# M15-US-02 验收证据

## Story

- Story：`M15-US-02` 订单独立退款工作流
- 验收：`AT-DOP-001`
- 状态：本地自动化完成

## RED

```text
pnpm exec vitest run tests/m15-us-02-dashboard-refund.spec.ts
Test Files  1 failed (1)
Tests       2 failed (2)
```

失败分别证明订单页没有独立退款 action，也没有到 `refundOrder` 的完整表单/API 映射。

## 实现

- 订单列表对具有 `refund.execute` 的员工显示独立退款；仅 COMPLETED/EXCEPTION 可执行。
- 表单明确不会取消订单，要求正数金额、canonical currency、受控原因与证据。
- 写入复用既有统一 API 的 L2+ 权限、金额审批、L3/L4 step-up、幂等和 append-only 资金冲正。
- 浏览器 fixture 使用 36 笔混合状态订单，验证目标完单保持完成且其他 35 笔订单不变。

## GREEN

```text
Vitest Dashboard/API regression: 4 files / 43 tests passed
Dashboard typecheck: passed
Dashboard E2E coverage: 121 planned = 121 implemented
Chromium DE2E-ORD-018: 1/1 passed
Chromium dashboard-order-volume.spec.ts: 6/6 passed in 17.0s
Root build: passed
```

## 剩余边界

服务中订单尚未捕获时不能使用独立资金退款；现实的“玩到一半联系客服”继续使用订单取消/处置流程，按已服务比例退款并保留合理陪玩收益，已由 `DE2E-ORD-014` 覆盖。外部真实员工 UAT 尚未执行。
