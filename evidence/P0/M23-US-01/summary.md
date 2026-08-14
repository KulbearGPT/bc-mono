# M23-US-01 验证证据

## Story 与范围

- Story：`M23-US-01`
- 实施包：`NUI-A0`
- 范围：合同、77 场景清单、共用隔离 PostgreSQL Harness、fixture kernel、统一断言、故障注入、机器报告与 M22 Harness 兼容。
- 非范围：A1～A7 的业务动作自动化、A8 三层发布门禁、真实 Discord/Dashboard UAT。

## RED

1. 首次运行 `npm exec -- vitest run tests/non-ui/nui-a0-harness.spec.ts`：`1 suite failed / 0 tests`，缺少 `tests/support/isolated-postgres.ts`。
2. 正式 Story 合同测试：`1 failed / 9 passed`，Backlog 尚无 `M23-US-01`～`M23-US-09`。
3. 分层 fixture builder 合同：`1 failed / 9 passed`，计划列出的 builder 尚未全部导出。
4. append-only 断言合同：`1 failed / 10 passed`，旧实现错误依赖快照行顺序。

## GREEN

- `npm run test:non-ui:harness`：`1 file / 11 tests` 通过。
- Harness 最终版本连续三轮：每轮 `1 file / 11 tests` 通过。
- `npm run test:gift:non-ui`：`18 files / 99 tests` 通过。
- `npm run verify:non-ui:environment`：PostgreSQL `initdb`、`pg_ctl`、`createdb`、`psql` 全部可用。
- `npm run typecheck`：通过。
- 新增文件 ESLint `--max-warnings 0` 与 Prettier 检查：通过。
- `npm test`：`305 files / 1530 tests` 通过。
- `npm run quality:routes`：192 个生产 operation 与 OpenAPI 双向一致。
- `npm run db:validate`：Prisma schema 有效。
- `node scripts/build-p0-acceptance-matrix.mjs`：重建 317 行验收矩阵。
- 残留检查：`/tmp/blackcat-non-ui-*` 无目录，进程表无 Harness PostgreSQL 实例。
- `npm run generate:non-ui:coverage`：`77 total / 0 automated / 77 planned`；A0 基础设施不伪装成业务场景完成。

## 关键事实

- 只允许 `NODE_ENV=test`、受控数据库名、受控临时根目录和私有 Unix socket；不读取普通 `DATABASE_URL`。
- 每次应用当前全部 migration；成功关闭后验证进程确已停止再删除目录。
- 显式失败现场可停止实例后保留数据目录；停止失败会报告并保留现场，不再静默删除。
- M22 礼物 fixture 复用共用 Harness，礼物专项 99 个测试保持通过。
- 77 个 BNUI 场景当前全部保持 `PLANNED`，由 A1～A7 顺序转为 `AUTOMATED`；没有以测试文件存在代替覆盖结论。

## 修改文件

- 计划、Backlog、TODO 及 `docs/` 镜像。
- `tests/support/isolated-postgres.ts`
- `tests/support/non-ui-fixtures/*`
- `tests/support/non-ui-assertions.ts`
- `tests/support/non-ui-acceptance-report.ts`
- `tests/support/non-ui-coverage.ts`
- `tests/non-ui/nui-a0-harness.spec.ts`
- `scripts/non-ui/*`
- `package.json`
- M22 礼物 fixture 及其合同测试。

## 剩余风险

- A1～A8 尚未实施，77 个业务场景均未宣称完成。
- M22 审查发现的订单×礼物真实并发和捕获后钱包账变缺口保留给 `M23-US-04 / NUI-A3`，当前未伪造关闭。
- PR quick、main full、release 三层门禁由 `M23-US-09 / NUI-A8` 建立。
