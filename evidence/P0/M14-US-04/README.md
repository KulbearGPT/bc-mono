# M14-US-04 验收证据

## Story

- Story：`M14-US-04` 人性化订单信息层级与可行动指标跳转
- 状态：完成
- 日期：2026-08-05
- Requirement：`SUP-UX-01; ACCESS-02`
- 验收：`AT-SUX-005; AT-SUX-006`

## RED

```text
pnpm exec vitest run tests/m14-us-04-order-operational-context.spec.ts
Test Files 1 failed
Tests      4 failed
```

失败证明订单卡仍以老板/陪玩 UUID 为主要事实，订单表格仍显示技术 ID，详情未优先说明阻塞与下一步，概览指标也不能进入对应筛选结果。接口投影测试随后单独以 `1 failed | 4 passed` 证明人类可读字段尚未由目录事实生成。

## 实现

- 订单卡片优先展示公开订单号、客户与陪玩展示名、中文状态、服务摘要、业务金额、当前阻塞、下一步和相对/精确更新时间，不再展示完整 UUID。
- 订单表格改为客户、陪玩、服务、金额与最近更新等运营字段；状态统一中文化。
- 订单列表 API 从客户和参与人事实投影 `customerDisplayName`、`playerDisplayNames` 与 `serviceSummary`，PostgreSQL 继续按可信 Guild 查询订单。
- 订单详情首屏新增处理概览；内部 ID、版本和审计时间放入默认折叠的技术详情，高级陪玩维护操作默认折叠。
- 进行中订单、待处理任务和异常指标分别进入带筛选条件的受权页面；客服页读取 `taskFilter` URL 状态。

## GREEN

```text
pnpm exec vitest run tests/m14-us-04-order-operational-context.spec.ts tests/m4-us-03-dashboard.spec.ts tests/m4-us-08-dashboard.spec.ts tests/dashboard-card-workspaces.spec.ts tests/m13-us-03-dashboard-collections.spec.ts tests/m4-us-09-dashboard.spec.ts tests/m14-us-03-support-queue-dashboard.spec.ts tests/m4-us-03-api.spec.ts tests/m4-us-03-db.spec.ts
Test Files 9 passed
Tests      78 passed

pnpm run typecheck
通过

npm run build -w @blackcat/dashboard
1593 modules transformed; built in 305ms
```

## 修改文件

- `apps/api/src/admin-directory.ts`
- `apps/dashboard/src/AdminBusinessPage.tsx`
- `apps/dashboard/src/SupportWorkbenchPage.tsx`
- `apps/dashboard/src/admin-business.ts`
- `apps/dashboard/src/styles.css`
- `tests/m14-us-04-order-operational-context.spec.ts`
- `tests/m4-us-03-dashboard.spec.ts`
- backlog、TODO、验收矩阵与本证据目录

## 剩余边界

当前业务 Guild 的真实 L1-L4、375/768/桌面、键盘、读屏名称和员工闭环签署属于 M14-US-05；跨 Guild 隔离由自动化安全回归证明，AT-SUX-005/006 的外部浏览器状态仍保持 `PENDING_EXTERNAL`。
