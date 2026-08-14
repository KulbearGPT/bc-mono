# Dashboard 巨型文件重构计划

## 审计结论

当前 Dashboard 顶层 TypeScript/TSX 共 4,553 行，其中存在三个超过 500 行的高耦合文件，并有一个 496 行的临界文件：

| 文件 | 行数 | 混合职责 |
| --- | ---: | --- |
| `AdminBusinessPage.tsx` | 717 | 集合页、卡片/表格、操作表单、详情投影、订单明细编辑 |
| `admin-business.ts` | 542 | 页面定义、集合状态、金额格式、详情请求、全部写请求与校验 |
| `SupportWorkbenchPage.tsx` | 536 | 数据刷新、任务命令、任务 UI、自动化控制、订单预览、指标 |
| `App.tsx` | 496 | 会话与路由、应用外壳、导航、搜索、概览、错误门禁 |

## 目标边界

1. 所有 `apps/dashboard/src/*.ts(x)` 文件不超过 500 行；500 行是巨型文件门禁，不是鼓励接近上限的目标。
2. `AdminBusinessPage` 只编排集合工作区；操作表单和详情区域分别进入 `AdminBusinessActionPanel`、`AdminBusinessDetail`。
3. `admin-business` 保留读取模型、导航、集合查询和格式化；写请求与表单校验进入 `admin-business-actions`，现有公开 import 保持兼容。
4. `SupportWorkbenchPage` 保留状态、刷新和业务命令编排；自动化、订单预览与指标展示进入 `SupportWorkbenchPanels`。
5. `App` 保留会话、授权和路由编排；应用 Chrome、导航、搜索、概览和门禁进入 `DashboardChrome`。
6. 不改变 API 路径、请求体、权限判断、资金换算、状态迁移、文案或 DOM 可访问名称。

## 验证策略

- RED：新增静态模块边界测试，先证明三个巨型文件超标且目标模块不存在。
- Characterization：复用现有 Dashboard 单元测试和 143 条 Chromium E2E，验证请求与渲染行为等价。
- GREEN：模块边界测试、Dashboard 相关 Vitest、TypeScript、Dashboard production build、零警告 ESLint、完整 Chromium 与 `git diff --check` 全通过。
