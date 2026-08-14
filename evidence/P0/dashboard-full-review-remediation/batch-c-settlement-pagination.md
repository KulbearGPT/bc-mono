# 批次 C：结算作废与管理分页

## RED

```text
npx vitest run tests/m6-us-04-dashboard.spec.ts tests/m15-us-08-staff-account-dashboard.spec.ts
```

结果：17 tests 中 3 failed。Dashboard 没有最终批次替代参数构造、结算 model 丢弃 nextCursor、员工列表没有下一页入口。

## GREEN

- DRAFT/PENDING_REVIEW 作废要求显式原因；APPROVED/EXPORTED 作废必须确认由统一 API 原子创建同周期、同 Actor Guild、同币种替代批次。
- E2E fixture 与真实 API 合同对齐：新替代批次由作废请求原子创建；失败不写原批次。
- `DE2E-SET-008` 改为真实点击 Dashboard 作废控件，不再使用原始 fetch 绕过 UI。
- 结算批次、周报和员工账号均保留并消费 `nextCursor`，下一页失败有可见反馈。

验证：

```text
npx vitest run tests/m6-us-04-dashboard.spec.ts tests/m15-us-08-staff-account-dashboard.spec.ts
# 2 files / 17 tests passed

npm run typecheck -w @blackcat/dashboard
npx eslint apps/dashboard/src/SettlementPage.tsx apps/dashboard/src/SettlementRoute.tsx apps/dashboard/src/settlements.ts apps/dashboard/src/AccessManagementPage.tsx apps/dashboard/src/AccessManagementRoute.tsx --max-warnings 0
npm run build -w @blackcat/dashboard
# passed; JS 452.67 kB, gzip 128.19 kB

npx playwright test tests/e2e/dashboard/dashboard-settlements.spec.ts --project=chromium --reporter=line
# 10/10 passed
```
