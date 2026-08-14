# M14-US-02 验收证据

## Story

- Story：`M14-US-02` 安全任务分诊投影与 Discord 深链
- 状态：完成
- 日期：2026-08-05
- Requirement：`SUP-UX-01; ACCESS-02`
- 验收：`AT-SUX-002; AT-SUX-003; AT-SUX-004`

## RED

```text
pnpm exec vitest run tests/m14-us-02-support-triage-api.spec.ts
Test Files 1 failed
Tests      3 failed
```

失败证明列表/详情缺少 triage/links、仍按 createdAt 排序且未隔离任务中的另一 Guild 上下文。

## 实现

- 列表与详情统一返回扁平 `SupportTaskView`，包含最小 `triage` 与 `links`。
- 分诊顺序固定为 OVERDUE、PENDING 最早截止、其余最早创建，最后以 ID 打破平局。
- PostgreSQL 从可信订单和客户投影公开订单号、展示名、项目、金额、币种及频道，并在 SQL 中按订单 Guild 隔离。
- In-memory 与 PostgreSQL 使用相同的分诊和权限语义。
- Discord URL 只接受完整 snowflake；Dashboard 只消费 API 链接并对畸形或非 Discord URL 失败关闭，不再自行拼接。

## GREEN 与验证

```text
pnpm exec vitest run tests/m14-us-02-support-triage-api.spec.ts   tests/m14-us-02-support-triage-postgres.spec.ts   tests/m4-us-02-api.spec.ts tests/m4-us-02-dashboard.spec.ts
Test Files 4 passed
Tests      10 passed

npm run typecheck
通过
```

PostgreSQL 测试从空库应用完整迁移链，验证真实 join、排序、字段投影、安全链接和跨 Guild 排除。

## 修改文件

- `apps/api/src/support-workbench.ts`
- `apps/dashboard/src/support-workbench.ts`
- `apps/dashboard/src/SupportWorkbenchPage.tsx`
- `tests/m14-us-02-support-triage-api.spec.ts`
- `tests/m14-us-02-support-triage-postgres.spec.ts`
- `tests/m4-us-02-api.spec.ts`
- `tests/m4-us-02-dashboard.spec.ts`
- backlog、TODO、验收矩阵与本证据目录

## 剩余边界

认领前 UI 信息层级、首屏队列和响应式/键盘行为属于 M14-US-03；订单页和指标跳转属于 M14-US-04。工作区原有 Dashboard E2E 计划改动未触碰。

