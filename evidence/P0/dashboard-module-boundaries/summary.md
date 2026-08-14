# Dashboard 模块边界重构证据

日期：2026-08-11  
分支：`codex/dashboard-module-boundaries`  
范围：仅 `apps/dashboard`、相关 Dashboard 测试、证据与 TODO；未修改 API、Bot、数据库或业务合同。

## Story 与验收

- Story：Dashboard 巨型文件与职责边界收口。
- 结构验收 `DB-MOD-001`：`apps/dashboard/src` 中所有 TypeScript/TSX 文件不超过 500 行。
- 结构验收 `DB-MOD-002`：页面、动作表单、详情、金额转换、客服辅助面板和应用壳层分别有单一模块所有者；旧公共导出保持兼容。
- 回归覆盖：`AT-LST-004`、`AT-SUX-004/006`、`AT-REV-001/004/005`、`AT-STATE-001/003` 对应的既有 Dashboard 测试继续通过；本次不替代真实员工或真实 Guild UAT。

## RED 基线

命令：

```text
npx vitest run tests/dashboard-module-boundaries.spec.ts
```

结果：`1 file / 2 tests failed`。基线发现 `AdminBusinessPage.tsx` 718 行、`admin-business.ts` 543 行、`SupportWorkbenchPage.tsx` 537 行，且目标模块导入尚不存在。

## 实现结果

- `AdminBusinessPage.tsx`：718 → 273 行；动作表单、详情、Overlay 与展示辅助函数分别拆分。
- `admin-business.ts`：543 → 320 行；写动作请求构建器迁入 `admin-business-actions.ts`，CAT 金额边界迁入 `cat-money.ts`，原 facade 导出保持不变。
- `SupportWorkbenchPage.tsx`：537 → 381 行；自动流程、订单概览和运营指标展示迁入 `SupportWorkbenchPanels.tsx`，共享视图类型迁入独立类型模块。
- `App.tsx`：496 → 162 行；导航壳层、首页、Gate 与路由空态迁入 `DashboardChrome.tsx`，`App.tsx` 只负责会话、授权和路由装配。
- 最终最大 Dashboard TS/TSX 文件为 `SupportWorkbenchPage.tsx` 381 行；全部低于 500 行。
- 既有源码文本门禁改为读取新职责所有者，测试语义未放宽。

## GREEN 与回归证据

```text
npx vitest run tests/dashboard-module-boundaries.spec.ts
  1 file / 2 tests passed

Dashboard 相关测试按 5 批、单 worker 执行：
  10 files / 60 tests passed
  10 files / 50 tests passed
  10 files / 31 tests passed
  10 files / 61 tests passed
   9 files / 49 tests passed
合计：49 files / 251 tests passed

npm run typecheck -w @blackcat/dashboard
  passed

npx eslint apps/dashboard/src --max-warnings 0
  passed, 0 warnings

npm run build -w @blackcat/dashboard
  passed; 1608 modules transformed
```

全仓 Vitest 并发运行在本机测试进程被提前终止且未返回退出码，因此未将其计为通过证据；改用覆盖所有引用 Dashboard 源码的 49 个测试文件分批执行并全部通过。

## 风险

- 本次是内部模块重构，没有变更 API 请求、权限、资金、状态或幂等语义。
- 真实员工/真实 Guild UAT 状态保持各原 Story 的既有状态，不因本次自动化回归而自动完成。
