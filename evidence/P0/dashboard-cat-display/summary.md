# Dashboard 猫条金额输入整改证据

## 范围与业务口径

- 分支：`codex/dashboard-cat-display`
- 相关验收：`AT-REV-001`、`AT-SUX-006`、`AT-TAG-003`、`AT-COMP-001`、`AT-MULTI-001/002`。
- Dashboard 日常展示和录入统一使用“猫条”；运营人员不再直接接触实现层金额单位。
- API 与持久化合同不变：内部金额仍为安全整数，`1 猫条 = 10` 个 API 金额单位；Dashboard 提交前统一转换，API 返回后统一换算展示。
- USD 充值收据仍按美元录入；本次未修改 API、Bot、数据库、资金状态机、权限或幂等语义。

## 修复内容

1. 新增共享的 CAT 输入转换与回填格式化，精确支持一位小数，不使用浮点乘法生成请求金额；拒绝超过一位小数、负数、不安全整数及不合法格式。
2. 退款、取消订单的客户退款/陪玩收益、陪玩固定收益、礼物价格、服务单价、订单陪玩明细价格全部改为猫条录入，并在请求 builder 中转换为 API 整数金额。
3. 编辑表单把 API 返回的整数金额除以 10 回填；帮助文字和边界值也使用猫条，避免员工按原始整数误操作。
4. Dashboard 用户可见源码不再出现 `CAT subunit`、`minor units` 或“CAT 最小单位”；金额格式异常改为业务语言。
5. 同步所有受影响的单元与 Chromium E2E，用例继续断言 API 收到的金额整数完全不变。

## 修改文件

- `apps/dashboard/src/admin-business.ts`
- `apps/dashboard/src/AdminBusinessPage.tsx`
- `apps/dashboard/src/customer-wallet.ts`
- `tests/dashboard-cat-amount-input.spec.ts`
- `tests/dashboard-production-copy.spec.ts`
- `tests/m4-us-03-dashboard.spec.ts`
- `tests/m9-us-10-player-compensation.spec.ts`
- `tests/m10-us-03-api.spec.ts`
- `tests/m15-us-02-dashboard-refund.spec.ts`
- `tests/e2e/dashboard/dashboard-catalog.spec.ts`
- `tests/e2e/dashboard/dashboard-catalog-daily-operations.spec.ts`
- `tests/e2e/dashboard/dashboard-gifts-earnings.spec.ts`
- `tests/e2e/dashboard/dashboard-order-mutations.spec.ts`
- `tests/e2e/dashboard/dashboard-order-volume.spec.ts`

## RED / GREEN

RED：

```text
npx vitest run tests/dashboard-cat-amount-input.spec.ts
# 1 file / 3 tests failed
# 缺少共享换算函数；旧表单仍按实现单位显示和提交。
```

GREEN：

```text
npx vitest run tests/dashboard-cat-amount-input.spec.ts
# 1 file / 3 tests passed

npx vitest run tests/dashboard-cat-amount-input.spec.ts tests/dashboard-production-copy.spec.ts \
  tests/m4-us-03-dashboard.spec.ts tests/m15-us-02-dashboard-refund.spec.ts \
  tests/m9-us-10-player-compensation.spec.ts tests/m10-us-03-api.spec.ts
# 6 files / 48 tests passed

rg -l -0 'apps/dashboard|@blackcat/dashboard' tests/*.spec.ts | xargs -0 npx vitest run
# 53 files / 266 tests passed

npx playwright test --project=chromium --reporter=line
# 143/143 passed

npx playwright test tests/e2e/dashboard/dashboard-catalog.spec.ts \
  tests/e2e/dashboard/dashboard-catalog-daily-operations.spec.ts \
  tests/e2e/dashboard/dashboard-gifts-earnings.spec.ts \
  tests/e2e/dashboard/dashboard-order-mutations.spec.ts \
  tests/e2e/dashboard/dashboard-order-volume.spec.ts \
  --project=chromium --workers=1 --reporter=line
# 最终树 30/30 passed

npm run typecheck
# passed

npm run build -w @blackcat/dashboard
# passed；JS 459.41 kB，gzip 129.67 kB

npx eslint apps/dashboard/src --max-warnings 0
# passed；zero warnings

git diff --check
# passed
```

## 剩余风险

- 没有已知的 Dashboard 金额单位回归。
- 技术字段名与 API DTO 中的 `*Minor`/整数金额仍按合同保留，但不会作为日常金额标签或输入单位展示给员工。
