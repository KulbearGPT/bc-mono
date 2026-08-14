# M23-US-03 验证证据

## Story 与范围

- Story：`M23-US-03`
- 实施包：`NUI-A2`
- 范围：服务目录、套餐、业务标签、陪玩审批与接单资格、个人项目分成，共 8 个 BNUI 场景。
- 非范围：Dashboard 交互、真实 Discord Role 应用及套餐应用/订单定制；外部部分保持 `AUTOMATED_PARTIAL_EXTERNAL_REMAINS`，订单套餐消费路径由 NUI-A3 覆盖。

## RED

1. PostgreSQL 场景首轮 `1 file / 8 tests` 全部失败，暴露 fixture 将多个参数化 SQL 命令作为 prepared statement 执行；拆分为逐条 SQL 后继续验证。
2. 第二轮 `5 failed / 3 passed`，暴露共享数据库中测试代码使用全局唯一业务 code；改为按场景生成稳定且不冲突的 code，没有放宽生产约束。
3. fixture 修正后剩余真实运行时失败 `1 failed / 7 passed`：强制 `audit_logs` 插入失败时接口返回 500，但陪玩资料仍变为 `ACTIVE / version 2`，证明陪玩业务写先提交、审计后写，违反审计原子性。

## GREEN 与门禁

- `npm run test:non-ui:a2`：累计 `4 files / 33 tests` 通过；最终版本连续四轮相同结果。
- 目录、套餐、标签、入驻、分成和陪玩资格相关回归：`15 files / 79 tests` 通过。
- `npm run test:gift:non-ui`：`18 files / 99 tests` 通过。
- `npm test`：`308 files / 1552 tests` 通过。
- `npm run db:validate`：Prisma schema 有效。
- `npm run quality:routes`：192 个生产 operation 与 OpenAPI 双向一致。
- `npm run lint:api`、`npm run typecheck` 及修改文件按既有源码风格执行的 Prettier 检查：通过。
- `npm run generate:non-ui:coverage`：`77 total / 17 automated / 60 planned`。
- `node scripts/build-p0-acceptance-matrix.mjs`：重建 317 行验收矩阵。
- `npm run verify:non-ui:environment`：隔离 PostgreSQL 工具链为 `READY`；全量测试后无临时实例或进程残留。

## 场景与验收映射

- `BNUI-CAT-001`：`AT-CAT-001;002`、`AT-ARC-001`。
- `BNUI-CAT-002`：`AT-CAT-001`、`AT-TAG-002`。
- `BNUI-PKG-001`：`AT-MULTI-012;014`。
- `BNUI-PKG-002`：`AT-MULTI-012;014`。
- `BNUI-TAG-001`：`AT-TAG-001;004`。
- `BNUI-PLY-001`：`AT-ONB-005`、`AT-TAG-002`。
- `BNUI-PLY-002`：`AT-DOP-005`。
- `BNUI-PLY-003`：`AT-COMP-001;002`。

## 关键事实与全局缺陷修复

- 目录版本保存客户价与陪玩价，发布新版本只退役旧版本；归档不改写旧目录版本或订单需求快照。
- 非法价格、计费单位和错误类型标签在创建目录前失败，目录、审计和 Outbox 均无部分写入。
- 套餐席位顺序和总价由 API/Store 根据同游戏目录版本派生；同 code 只保留一个 ACTIVE，跨游戏与并发失败路径不产生第二个有效版本。
- 标签 code/ID 稳定，停用阻止新引用但历史引用继续可读。
- `PostgresPlayerStore` 的批准、拒绝、暂停/恢复和标签更新新增 staged transaction；安全路由生成成功审计后才在同一 PostgreSQL 事务提交。审计失败会回滚 player_profiles、player_profile_events、player_skill_tags 和 Discord role task，连接在 commit/abort 后可靠释放。
- 个人分成批量任一项非法时整批零写入；终选后的 participant 单位收益快照不随个人规则后改而变化。

## 修改文件

- `apps/api/src/players.ts`
- `tests/non-ui/catalog-player.spec.ts`
- `tests/support/non-ui-coverage.ts`
- `tests/non-ui/nui-a0-harness.spec.ts`
- `scripts/non-ui/build-coverage-report.ts`
- `scripts/non-ui/run-domain-gate.mjs`
- `package.json`
- Backlog、TODO 与机器覆盖报告。

## 剩余风险

- 真实 Dashboard 操作和 Discord Role 应用仍需外部/UAT 门禁；自动化只证明 API、数据库和 role task/outbox 事实。
- 套餐应用到订单、逐席位定制与恢复属于 NUI-A3，不以本 Story 的套餐管理自动化代替。
- NUI-A3～A8 尚未实施，剩余 60 个 BNUI 场景保持 `PLANNED`。
