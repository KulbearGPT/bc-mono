# M14-US-03 验收证据

## Story

- Story：`M14-US-03` 首屏任务队列与认领前只读上下文
- 状态：完成
- 日期：2026-08-05
- Requirement：`SUP-UX-01; ACCESS-02`
- 验收：`AT-SUX-001; AT-SUX-003; AT-SUX-004`

## RED

```text
pnpm exec vitest run tests/m14-us-03-support-queue-dashboard.spec.ts
Test Files 1 failed
Tests      2 failed | 1 passed
```

失败证明队列仍位于历史报表和 KPI 之后，且任务卡没有分诊摘要或认领前预览。

## 实现

- 页面信息顺序变为：标题 → 紧凑班次条 → 当前任务队列 → 最近 30 天记录 → 运营指标。
- 卡片主区展示公开订单号、客户展示名、游戏/服务、处理原因、时间压力和下一步。
- 认领前“查看任务上下文”展开最小只读摘要；完整订单和写入继续要求既有任务 capability。
- 超时任务强化视觉提示；缺频道显示不可用，不出现死链接。
- 空筛选有明确状态；筛选使用按钮组和 `aria-pressed`；展开按钮提供 `aria-expanded` 和命名 region。
- 375/768 断点将班次条、操作区和四列摘要降为单列。

## GREEN

```text
pnpm exec vitest run tests/m14-us-03-support-queue-dashboard.spec.ts   tests/m4-us-02-dashboard.spec.ts tests/m12-us-02-dashboard.spec.ts   tests/m12-us-03-dashboard.spec.ts tests/dashboard-release-ui.spec.ts
Test Files 5 passed
Tests      16 passed

npm run typecheck
通过

npm run build -w @blackcat/dashboard
1593 modules transformed; built in 409ms
```

## 修改文件

- `apps/dashboard/src/SupportWorkbenchPage.tsx`
- `apps/dashboard/src/styles.css`
- `tests/m14-us-03-support-queue-dashboard.spec.ts`
- backlog、TODO、验收矩阵与本证据目录

## 剩余边界

订单集合/详情的人性化信息层级与指标跳转属于 M14-US-04。当前业务 Guild 的真实 L1-L4、键盘与多断点浏览器签署属于 M14-US-05；跨 Guild 隔离由自动化安全回归证明。
