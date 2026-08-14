# 批次 B：资金权限、幂等与币种

## RED

命令：

```text
npx vitest run tests/m16-us-03-dashboard-consistency.spec.ts tests/m7-us-06-dashboard.spec.ts
```

结果：9 tests 中 3 failed。只读员工仍可看到充值表单；稳定写入键注册器不存在；CAT 阈值被显示为人民币。

## GREEN

- 钱包面板分别消费 `wallet.top_up`、`wallet.external_refund` 和 `wallet.adjust`，只读员工看到禁用原因且没有可提交表单。
- 钱包冲正、客户内部备注、客户展示名、订单参与人/备注/需求写入按请求指纹保留幂等键，只有明确成功后才释放。
- 安全页使用 capability 返回的 currency 和共享金额格式化器，不再硬编码人民币。
- 修正 `DE2E-WLT-010` 的旧单位预期：18 CAT 为 180 CAT subunits，余额从 10,000 变为 9,820。

验证：

```text
npx vitest run tests/m16-us-03-dashboard-consistency.spec.ts tests/m7-us-06-dashboard.spec.ts tests/m4-us-03-dashboard.spec.ts
# 3 files / 32 tests passed

npm run typecheck -w @blackcat/dashboard
# passed

npx eslint apps/dashboard/src/CustomerProfileRoute.tsx apps/dashboard/src/CustomerProfilePage.tsx apps/dashboard/src/CustomerWalletPanel.tsx apps/dashboard/src/SecurityPage.tsx apps/dashboard/src/request-state.ts apps/dashboard/src/AdminBusinessRoute.tsx --max-warnings 0
# passed

npm run build -w @blackcat/dashboard
# passed; JS 449.34 kB, gzip 127.36 kB

npx playwright test tests/e2e/dashboard/dashboard-profile-wallet.spec.ts tests/e2e/dashboard/dashboard-customer-daily-operations.spec.ts --project=chromium --reporter=line
# DE2E-WLT-010 修正后已通过；输出传递至 15/18 时执行器提前回收，剩余 DE2E-WLT-007/008/011 另行复跑 3/3 passed。
```
