# M13-US-03 验收证据

## Story

- Story：`M13-US-03` 可复用集合工具栏与卡片表格接入
- 状态：本地候选完成
- 日期：2026-08-05
- Requirement：`LST-01; ACCESS-02`
- 验收：`AT-LST-004`、`AT-LST-005`、`AT-LST-006`、`AT-LST-007`、`AT-LST-008`

## 实现范围

- 七页共用资源配置：排序选项、默认 `createdAt desc` 与显式表格列白名单。
- 共用筛选/排序/CARD-TABLE 工具栏；七页的卡片与表格使用同一页 API items、详情入口和权限动作。
- 用户、礼物目录与礼物请求补齐卡片展示；原订单、陪玩、服务目录和服务套餐卡片保持。
- TABLE 桌面使用语义化 table，760px 以下使用同一列配置渲染可聚焦行式列表，不依赖 API 返回对象动态生成字段。
- URL 保存并恢复 `view`、`sortBy`、`sortDirection` 和页面允许的筛选；非法值回退，未知筛选丢弃。
- 仅切换视图不发请求；排序或筛选变化清空游标并加载第一页；latest-request 序列阻止旧响应回写。

## RED / GREEN

```text
npx vitest run tests/m13-us-03-dashboard-collections.spec.ts
Test Files  1 failed (1)
Tests       10 failed (10)
```

```text
npx vitest run tests/m13-us-03-dashboard-collections.spec.ts
Test Files  1 passed (1)
Tests       10 passed (10)
```

## 修改文件

- `apps/dashboard/src/admin-business.ts`
- `apps/dashboard/src/AdminBusinessRoute.tsx`
- `apps/dashboard/src/AdminBusinessPage.tsx`
- `apps/dashboard/src/styles.css`
- `tests/m13-us-03-dashboard-collections.spec.ts`
- `tests/dashboard-table-labels.spec.ts`
- `tests/m13-us-01-collection-contract.spec.ts`
- `outputs/Codex-P0开发TODO.md` 与 `docs/Codex-P0开发TODO.md`
- `evidence/P0/acceptance-matrix.csv`
- 本证据目录

## 边界

- 375/768/桌面真实浏览器截图、员工 L1–L4、跨 Guild 和外部签署仍属于 `M13-US-04`。
- 本 Story 没有改变 API 权限、详情动作或服务端业务规则。
