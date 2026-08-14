# M12-US-01 客服运营合同与 RED 基线

- 状态：合同完成；运行时、迁移和外部 UAT 未实现。
- 前置事实：以当前 main 的 M10 多陪玩订单、M11 候选池和订单级 `StaffTask` 为基线，不合并旧客服分支的数据模型。
- RED：`npx vitest run tests/m12-us-01-support-contract.spec.ts`，结果为 1 file / 4 tests failed；失败原因是 M12 合同尚不存在，符合预期。
- GREEN：`npx vitest run tests/m12-us-01-support-contract.spec.ts tests/m5-us-03-release-gate.spec.ts` → 2 files / 12 tests passed。
- 合同回归：M10、M11、M12 与发布门禁合计 4 files / 16 tests passed。
- Prisma：outputs/docs 两份目标 schema 分别执行 `npx prisma validate`，均返回 valid。
- OpenAPI：Ruby Psych 成功解析 YAML，并解析 776 个 schema `$ref`，无缺失引用。
- CSV：交互映射 131 rows / 14 columns、backlog 108 rows / 22 columns、验收目录 251 rows / 11 columns，全部列宽一致。
- 验收追踪：`node scripts/build-p0-acceptance-matrix.mjs .` → 251 rows；AT-SUP-011 已唯一映射到外部 UAT 检查表，外部用例总数 60。
- 静态门禁：合同测试覆盖七份 outputs/docs 镜像精确一致；`git diff --check` 通过。
- 验收：AT-SUP-010、AT-SUP-011、AT-SUP-012、AT-SUP-013。
- 边界：StaffTask 保持订单级；任何 ACTIVE L1–L4 可由真实 Discord 首响触发自动认领；已有负责人不覆盖；不要求打卡；不自动处罚；评分失败不影响多陪玩完单、资金捕获或逐人收益。

## 修改文件

- 主规格与 docs 镜像
- backlog、OpenAPI、Prisma 目标合同、交互映射、验收目录及其 docs 镜像
- 双 TODO、UAT 检查表、合同测试和验收矩阵

## 剩余风险

- M12-US-02 至 M12-US-04 尚未实现运行时。
- AT-SUP-011 仍须在真实测试 Guild 执行并提交确定性外部证据。
