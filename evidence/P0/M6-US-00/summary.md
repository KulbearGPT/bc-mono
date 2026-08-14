# M6-US-00 合同基线证据

- 日期：2026-07-19
- 状态：本地合同候选完成
- 设计：`docs/superpowers/specs/2026-07-19-m6-settlement-reports-profiles-gift-ux.md`
- 计划：`docs/superpowers/plans/2026-07-19-m6-settlement-reports-profiles-gift-ux.md`

## 冻结内容

- `EP-M6`、`M6-US-01..06` 和 23 条 M6 重点验收用例。
- 结算批次、结算项、快照 Entry、追加式支付结果、个人周报、汇总周报和修订模型。
- 20 个结算、周报、客户/本人 Profile 与礼物余额检查 operationId。
- 单项整笔支付；`PARTIALLY_PAID` 只表示批次内部分完整项目成功。
- Guild 业务配置提供充值入口；Provider 保持既有 11 操作，余额不足礼物可选择但不会创建业务或资金事实。
- 合同复核补齐 Dashboard-only 管理路由、Bot Actor Context、周报 CSV/追加修订、L1 `customer_profile.read` 对象范围、支付结果证据和 `PARTIALLY_PAID -> PAID` 收敛。
- 二轮复核补齐可执行 `m6-database-constraints.sql`（非空计划键、有效来源唯一归批、作废释放、周报修订 XOR）、Guild `recharge_url` 配置合同、结算 Entry/支付历史、周报修订历史，以及 Profile 字段与余额 `stale` 标记。
- 最终复核把 PLAYER/SUMMARY 指标与修订类型绑定；修订请求类型必须匹配 URL 所指持久化周报，否则返回 `409 REPORT_TYPE_MISMATCH` 且零写入。结算 Entry 来源和支付结果凭证均为条件必填，余额配置镜像包含 `stale`。

## RED/GREEN

- RED：`npx vitest run tests/m6-us-00-contract.spec.ts`，2/3 失败，缺少 M6 Story、验收、模型和 operationId。
- GREEN：同一命令，6/6 通过。
- `ruby -ryaml ...`：OpenAPI YAML 可解析。
- `npx dotenv -e .env.example -- prisma validate --schema outputs/P0开发交付包/03-数据模型/schema.prisma`：schema valid。
- OpenAPI 结构化扫描：121 个 operationId 无重复，1821 个本地 `$ref` 全部可解析。
- 二轮更新后 OpenAPI 仍为 121 个 operationId、无重复，1832 个本地 `$ref` 全部可解析；业务配置 JSON/YAML 可解析。
- 最终镜像测试同时覆盖 OpenAPI、Prisma、数据库约束、业务配置示例/schema/说明、backlog 与验收 CSV，全部字节一致。

## 后续

合同不代表功能已实现。M6-US-01 才开始数据库迁移和结算领域实现。
