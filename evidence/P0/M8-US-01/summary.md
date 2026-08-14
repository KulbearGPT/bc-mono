# M8-US-01 合同同步与 RED 验收基线证据

日期：2026-07-21

## 范围

- 验收：`AT-TKN-001`、`AT-TKN-003`、`AT-TKN-004`、`AT-TKN-005`，并建立 `AT-TKN-002`、`AT-TKN-006`、`AT-TKN-007` 的后续验收合同。
- 固定 `1 USD = 10 MB`；默认展示名称/符号为“猫币 / MB”，名称与符号可全局替换，比例不可配置。
- API、数据库、审计与全部业务金额继续使用整数 USD minor units；没有修改 Prisma、迁移或运行时代码。
- 客户钱包/消费只展示代币；员工操作、陪玩收益、返佣、周报、结算及转账只展示 USD；不并排双显。

## RED

命令：

```text
npx vitest run tests/m8-us-01-contract.spec.ts
```

结果：1 个测试文件中 2/3 失败；明确缺少 `x-customer-display-unit` 与 `EP-M8` / `M8-US-01..03`，证明测试针对本次合同增量生效。

追踪矩阵首次扩展到 M8 后，既有 `tests/m5-us-01-traceability.spec.ts` 因 Story 正则仅允许 M0–M7 而失败；测试随后扩展到 M0–M8。

## GREEN

```text
node scripts/build-p0-acceptance-matrix.mjs
# Wrote 196 acceptance rows to evidence/P0/acceptance-matrix.csv.

npx vitest run tests/m8-us-01-contract.spec.ts tests/m7-us-01-contract.spec.ts tests/m5-us-01-traceability.spec.ts
# 3 files / 71 tests passed

git diff --check
# exit 0
```

## 修改事实

- 同步主规格、Discord/Dashboard 原型、交互映射、界面文案、OpenAPI、业务配置、backlog、验收目录、TODO 与全部 `docs` 发布镜像。
- OpenAPI 新增 `x-customer-display-unit`，但原 `x-money-policy`、`currency: USD` 与金额字段保持不变。
- 验收矩阵从 M7 门禁记录的 189 条增加到 196 条。
- 本 Story 仅完成合同和测试基线；展示配置、格式化器和客户端运行时行为尚未交付，分别由 M8-US-02 和 M8-US-03 实现。
