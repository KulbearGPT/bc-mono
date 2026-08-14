# 批次 A：客服工作台与最新对象一致性

## RED

命令：

```text
npx vitest run tests/m14-us-05-support-release.spec.ts tests/m19-us-04-support-live-refresh.spec.ts
```

结果：2 files failed；13 tests 中 3 failed。失败分别为 readiness 缺少 participants 时抛出 `TypeError`、缺少任务/订单绑定函数、业务详情缺少独立 request sequence 与页面 Error Boundary。

## GREEN

- readiness 投影缺字段时显示安全兜底，不再崩溃。
- 当前客服选择改为不可拆分的 `{ task, order }`，载入新任务时先清空旧上下文，并校验 `task.orderId === order.id`。
- Admin 详情使用独立 latest-request sequence；页面切换、详情关闭和后续响应均不能让旧对象回写。
- Dashboard 内容加入页面级 Error Boundary；异常时显示零写入说明和前端事件编号。

验证：

```text
npx vitest run tests/m14-us-05-support-release.spec.ts tests/m19-us-03-service-state-sync.spec.ts tests/m19-us-04-support-live-refresh.spec.ts tests/m16-us-03-dashboard-consistency.spec.ts
# 4 files / 20 tests passed

npm run typecheck -w @blackcat/dashboard
# passed

npx eslint apps/dashboard/src/SupportWorkbenchPage.tsx apps/dashboard/src/AdminBusinessRoute.tsx apps/dashboard/src/DashboardErrorBoundary.tsx apps/dashboard/src/App.tsx --max-warnings 0
# passed

npm run build -w @blackcat/dashboard
# passed; JS 447.89 kB, gzip 126.89 kB

npx playwright test tests/e2e/dashboard/dashboard-support.spec.ts --project=chromium --reporter=line
# 7/7 passed
```
