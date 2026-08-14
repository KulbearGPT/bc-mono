# M13-US-01 验收证据

## Story

- Story：`M13-US-01` 排序与双视图合同及 RED 基线
- 状态：合同完成；运行时未实现
- 日期：2026-08-05
- Requirement：`LST-01; ACCESS-02`
- 验收：`AT-LST-001` 至 `AT-LST-008`

## 冻结范围

- 七个 Dashboard 集合：订单、用户、陪玩、服务目录、服务套餐、礼物目录、礼物请求。
- 通用 `sortDirection=asc|desc` 与逐资源 `sortBy` 白名单。
- 默认 `createdAt desc`、`NULLS LAST`、唯一 ID tie-breaker。
- 游标绑定资源、Actor Guild、scope、筛选、排序、方向、排序值和 ID。
- `CARD` / `TABLE` 双视图；TABLE 在窄屏使用同一显式列定义降级为行式列表。
- 切换视图不请求列表 API；筛选或排序变化清空游标并从第一页加载；URL 恢复视图、排序与筛选。

## RED 基线

```text
npx vitest run tests/m13-us-01-collection-contract.spec.ts
Test Files  1 failed (1)
Tests       5 failed (5)
```

五项失败分别证明 backlog、主规格、OpenAPI、交互/验收追踪和 TODO/镜像尚未包含 M13。

## GREEN 与回归

```text
npx vitest run tests/m13-us-01-collection-contract.spec.ts
Test Files  1 passed (1)
Tests       5 passed (5)
```

合同关联回归最终命令与结果记录于同目录 `summary.md`。

```text
npx vitest run tests/m4-us-03-admin-detail-contract.spec.ts \
  tests/m10-us-08-service-packages-contract.spec.ts \
  tests/m10-us-08-service-packages-admin-contract.spec.ts \
  tests/m11-us-01-selection-pool-contract.spec.ts \
  tests/m12-us-01-support-contract.spec.ts \
  tests/m13-us-01-collection-contract.spec.ts \
  tests/m5-us-01-traceability.spec.ts
Test Files  7 passed (7)
Tests       82 passed (82)
```

新增验收第一次进入全量门禁时发现 M13 fixtures 与两个外部 UAT 行缺失；补齐后：

```text
npx vitest run tests/m5-us-03-release-gate.spec.ts \
  tests/m7-us-01-contract.spec.ts \
  tests/m13-us-01-collection-contract.spec.ts \
  tests/m5-us-01-traceability.spec.ts
Test Files  4 passed (4)
Tests       83 passed (83)
```

全仓并发运行曾因 Railway 子进程测试互相干扰出现瞬时失败；该文件单独复跑 `14/14` 通过。随后以单 worker 完整复验：

```text
npx vitest run --maxWorkers=1 --reporter=json --outputFile=/tmp/m13-vitest-serial.json
Test Suites 410 passed / 410 total
Tests       979 passed / 979 total
```

其他结构门禁：

- `npm run typecheck`：通过。
- OpenAPI Ruby YAML 解析：`144 paths; SortDirection present`。
- `test-fixtures.json` JSON 解析：通过。
- `node scripts/build-p0-acceptance-matrix.mjs`：`259 acceptance rows`。
- CSV：backlog `113 × 22`、交互映射 `133 × 14`、验收 `259 × 11`，无列宽错误。

## 修改文件

- `outputs/Discord陪玩业务Bot最小原型设计开发文档.html`
- `outputs/Codex-P0开发TODO.md`
- `outputs/P0开发交付包/01-UIUX/交互映射.csv`
- `outputs/P0开发交付包/02-API/openapi.yaml`
- `outputs/P0开发交付包/06-开发计划/backlog.csv`
- `outputs/P0开发交付包/06-开发计划/M13-业务集合排序与双视图-Story设计提案.md`
- `outputs/P0开发交付包/07-验收测试/acceptance-cases.csv`
- `outputs/P0开发交付包/07-验收测试/test-fixtures.json`
- 上述正式发布镜像对应的 `docs/` 文件
- `docs/runbooks/P0-UAT与发布检查表.md`
- `tests/m13-us-01-collection-contract.spec.ts`
- `tests/m5-us-03-release-gate.spec.ts`
- `evidence/P0/acceptance-matrix.csv`
- `evidence/P0/M13-US-01/README.md`
- `evidence/P0/M13-US-01/summary.md`

## 边界与剩余风险

- 本 Story 只冻结合同，不表示排序 API、SQL、索引或 Dashboard 双视图运行时已实现。
- `M13-US-02` 必须验证每个排序字段的真实投影、索引、collation、keyset 与跨 Guild/scope 行为。
- `M13-US-03` 必须退役动态收集返回字段生成表头的方式，使用显式列白名单，并验证请求竞态。
- `M13-US-04` 仍需真实员工会话、375/768/桌面断点及 L1-L4 UAT。
- 工作区原有 `outputs/P0开发交付包/07-验收测试/Dashboard-E2E自动化测试开发计划.md` 改动不属于本 Story，未修改、未纳入本 Story 提交；其 EOF 空行会使无范围 `git diff --check` 失败，因此本 Story 使用排除该文件的范围化 diff check。
