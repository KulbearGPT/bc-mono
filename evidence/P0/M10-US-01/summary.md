# M10-US-01 多陪玩合同与 RED 基线证据

## Story 与验收

- Story：`M10-US-01`
- 验收：`AT-MULTI-001` 至 `AT-MULTI-005`
- 范围：合同基线，不声称数据库迁移、API、Dashboard、Bot、结算或礼物运行时已经实现。

## 冻结结果

- 订单陪玩数量不设业务上限；Dashboard 以搜索、分页和逐项写入支持九人等极端订单。
- L1 仅操作本人已认领任务，L2+ 受服务端 Guild scope 限制。
- 客服只写逐人价格；API 固化个人覆盖或项目默认分成来源，并从有效明细价格之和派生订单总价。
- 最终资金捕获前允许新增、移除和改价；API 原子增加或释放预留差额，余额不足或版本冲突时零写入；捕获后锁定。
- 客户没有 readiness 动作；全部有效陪玩就绪才首次开始服务，服务中新增陪玩不倒退状态但未全员就绪禁止捕获。
- 客户确认最新逐人价格后捕获，并为每位有效陪玩创建独立收益。
- 礼物请求提交一个或多个订单参与明细 ID；API 推导接收人，按礼物单价乘去重人数原子预留并创建逐人礼物事实，不接受任意 `receiverId`。

## RED

`npx vitest run tests/m10-us-01-contract.spec.ts`

- 结果：`1 file / 2 tests failed`。
- 失败原因：M10 主规格、operationId、`OrderParticipant`、backlog 与验收 ID 尚不存在；同时识别到既有 TODO 镜像历史差异，因此 GREEN 测试只校验本 Story 新增 TODO 标记，不覆盖既有差异。

## GREEN 与结构验证

- `npx vitest run tests/m10-us-01-contract.spec.ts tests/m9-us-01-contract.spec.ts`：`2 files / 4 tests passed`。
- CSV 结构：backlog `96 rows / 22 columns`；acceptance `233 / 11`；interaction `115 / 14`。
- `npx prisma validate --schema outputs/P0开发交付包/03-数据模型/schema.prisma`：schema valid。
- Ruby Psych 解析 OpenAPI：`3.1.0 / 130 paths`。
- OpenAPI、Prisma、backlog、acceptance、fixtures、interaction 与主规格 docs/outputs 镜像逐字节一致；canonical `database/prisma/schema.prisma` 同步。
- 追踪矩阵生成器已从单数字里程碑扩展为支持 `M10+`，并刷新为 `232` 条；M10 五条均映射到可执行合同测试和本证据。
- 聚焦回归：`tests/m5-us-01-traceability.spec.ts`、`tests/m5-us-03-release-gate.spec.ts`、M10/M9 合同、M0/M7 schema 合同共 `6 files / 84 tests passed`。

## 全量回归状态

`npm test` 已完成 TypeScript build，但测试阶段为 `7 failed`。失败均不由本 Story 的 M10 合同变更触发：既有双 TODO 镜像差异 2 项、当前测试数据库缺少既有 `region_name_snapshot` 迁移 3 项、Railway 缺少环境变量输出 1 项、既有 M9-US-14 SQL 参数序号断言 1 项。M10 聚焦、追踪、schema 和发布门禁相关 84 项均通过；本 Story 不把全量门禁误报为通过。

## 未完成边界

`M10-US-02` 至 `M10-US-06` 保持未完成。真实迁移、九人 Dashboard/Discord UAT、资金捕获、逐人结算和多接收人礼物尚未交付。

## 2026-08-04 多项目客户下单补充

- 消除主规格中“每个订单一名陪玩”和 M10 多陪玩合同的冲突。
- 新增 `OrderRequirement` 目标合同，将客户草稿需求与最终 `OrderParticipant` 分离；优先陪玩名单不得提前生成参与者。
- 冻结客户需求清单 API、服务端报价、Discord 可恢复编排器，以及每条需求按所需人数产生独立派单名额的语义。
- 新增 `M10-US-07`、`AT-MULTI-006`、`AT-MULTI-007` 及交互映射；追踪矩阵刷新为 `234` 条。
- 合同测试：`tests/m10-us-01-contract.spec.ts` 与 `tests/m10-us-07-order-requirements.spec.ts` 共 `2 files / 3 tests passed`；canonical Prisma schema 校验通过。
- 运行时迁移、API、逐名额派单和 Discord 真实 Guild UAT 尚未实现，因此 `M10-US-07` 保持未勾选。

## 2026-08-04 独立陪玩项目合同修订

- 用户确认同一订单中的陪玩可承接不同项目，例如一人技术陪玩、一人娱乐陪玩。
- `OrderParticipant` 因此独立绑定 `serviceCatalogVersionId`，并固化游戏、服务、地区、计费单位、数量、目录单价及展示名称；订单级项目仅保留旧数据兼容投影。
- 管理端新增参与人时必须提交服务目录版本、数量和逐人价格；更新动作支持 `CHANGE_PROJECT`，客户端仍不得提交订单总价。
- RED：合同测试新增独立项目断言后，因主规格、OpenAPI 和 Prisma 缺少这些字段而失败。
- GREEN：主规格、OpenAPI、Prisma、backlog、交互映射和验收合同同步后，M10/M9 合同测试 `2 files / 4 tests` 通过，两份 Prisma schema 校验通过，`git diff --check` 通过。
