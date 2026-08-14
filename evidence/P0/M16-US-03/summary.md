# M16-US-03 Dashboard CAT 展示与请求一致性

## 结果

- `AT-REV-001`：钱包、退款、冲正和业务金额统一使用 CAT；充值收据金额仍以 USD 输入；陪玩结算同时显示应付 CAT 与实际付款 USD。
- `AT-REV-002`：Dashboard 严格解析钱包 `{ items, nextCursor }` 分页 envelope，并提供继续加载入口；裸数组或非 CAT 钱包响应被拒绝。
- `AT-REV-005`：客户资料各模块使用独立 latest-request gate，旧对象响应不能覆盖新对象；mutation 使用 `try/finally` 统一恢复 busy，模块请求失败彼此隔离。

## RED

```text
npx vitest run tests/m16-us-03-dashboard-consistency.spec.ts
Test Files  1 failed (1)
Tests       no tests
Error       Cannot find module apps/dashboard/src/request-state.js
```

## GREEN 与回归

```text
npx vitest run tests/m16-us-03-dashboard-consistency.spec.ts tests/m15-us-02-dashboard-refund.spec.ts tests/m15-us-05-wallet-adjustment-dashboard.spec.ts tests/m7-us-06-dashboard.spec.ts tests/m9-us-04-cat-wallet.spec.ts
Test Files  5 passed (5)
Tests       14 passed (14)

npm run typecheck -w @blackcat/dashboard
exit 0

npm run build -w @blackcat/dashboard
1597 modules transformed; built in 1.21s; exit 0

npx playwright test tests/e2e/dashboard/dashboard-profile-wallet.spec.ts tests/e2e/dashboard/dashboard-settlements.spec.ts tests/e2e/dashboard/dashboard-order-mutations.spec.ts tests/e2e/dashboard/dashboard-order-volume.spec.ts --project=chromium
Tests       40 passed (59.8s)
```

## 修改文件

- `apps/dashboard/src/customer-wallet.ts`
- `apps/dashboard/src/request-state.ts`
- `apps/dashboard/src/CustomerProfileRoute.tsx`
- `apps/dashboard/src/CustomerProfilePage.tsx`
- `apps/dashboard/src/CustomerWalletPanel.tsx`
- `apps/dashboard/src/SettlementPage.tsx`
- `apps/dashboard/src/AdminBusinessPage.tsx`
- `tests/m16-us-03-dashboard-consistency.spec.ts` 及受影响的单元/E2E 测试和 fixture
- backlog、TODO 及对应 `docs/` 镜像

## 剩余风险

共享 DTO、生产 route/OpenAPI parity、lint 和格式门禁属于已解锁的 `M16-US-04`，本 Story 不提前声明完成。陪玩实际付款 USD 当前按固定 `1 USD = 10 CAT` 由展示层从同一结算 minor amount 派生；不建立第二账本，也不允许 Dashboard 写汇率或余额。
