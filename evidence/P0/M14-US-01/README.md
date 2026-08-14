# M14-US-01 验收证据

## Story

- Story：`M14-US-01` 客服工作台体验合同与 RED 基线
- 状态：合同完成；运行时未实现
- 日期：2026-08-05
- Requirement：`SUP-UX-01; ACCESS-02`
- 验收：`AT-SUX-001` 至 `AT-SUX-007`

## 修改范围

- 新增 M14 主规格、EPIC 和五个有序 Story。
- OpenAPI 冻结 `StaffTaskTriageSummary`、`StaffTaskLinks` 与服务端稳定分诊顺序。
- 新增三条 Dashboard 交互映射和七条验收用例。
- 新增问题清单与 Story 设计提案、TODO、合同门禁和验收矩阵追踪。
- 正式 `outputs/` 与 `docs/` 镜像保持一致。

## RED 基线

```text
pnpm exec vitest run tests/m14-us-01-support-workbench-ux-contract.spec.ts
Test Files  1 failed (1)
Tests       5 failed (5)
```

失败分别证明 backlog、主规格、OpenAPI、交互/验收和 TODO/镜像尚未包含 M14。

## GREEN

```text
pnpm exec vitest run tests/m14-us-01-support-workbench-ux-contract.spec.ts
Test Files  1 passed (1)
Tests       5 passed (5)
```

验收矩阵重建为 266 条。最终关联回归为 5 files / 85 tests passed；OpenAPI YAML 解析为 144 paths；CSV 为 backlog 120×22、交互映射 137×14、验收 267×11，列宽一致；合同测试同时验证七份正式镜像逐字一致。

## 修改文件

- `outputs/Discord陪玩业务Bot最小原型设计开发文档.html` 及 `docs/` 镜像
- `outputs/Codex-P0开发TODO.md` 及 `docs/` 镜像
- `outputs/P0开发交付包/01-UIUX/交互映射.csv` 及镜像
- `outputs/P0开发交付包/02-API/openapi.yaml` 及镜像
- `outputs/P0开发交付包/06-开发计划/backlog.csv`、M14 Story 提案及镜像
- `outputs/P0开发交付包/07-验收测试/acceptance-cases.csv` 及镜像
- `docs/runbooks/P0-UAT与发布检查表.md`
- `tests/m14-us-01-support-workbench-ux-contract.spec.ts`
- `evidence/P0/acceptance-matrix.csv`
- 本证据目录

## 剩余风险

M14-US-02 至 M14-US-05 均未实现；尤其无效 Discord 链接仍是运行时缺陷。任何运行时完成声明必须分别取得 API/数据库、Dashboard、L1-L4 真实员工 UAT，以及自动化跨 Guild 隔离证据；不要求第二个真实 Guild。
