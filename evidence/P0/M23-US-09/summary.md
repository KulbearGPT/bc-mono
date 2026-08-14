# M23-US-09 候选验证证据

## Story 与当前结论

- Story：`M23-US-09`
- 实施包：`NUI-A8`
- 当前状态：`IN_PROGRESS`。三层自动化门禁、连续十轮 full 稳定性及 M22/Dashboard 兼容验证均已完成；发布门禁按合同失败关闭，因为生产签署/配置输入缺失、317 项验收中仍有 87 项外部验收待完成，且 2 项已通过外部证据绑定旧候选、必须对最终候选重跑。
- 本提交是允许复核的本地候选，不把自动化覆盖或合成 evaluator 输入描述成外部 UAT、生产签署或发布就绪。

## RED 与修复

- A8 合同测试初始因 `gate-definition.mjs` 不存在而失败；新增集中式 gate definition 后转绿。
- release 缺少生产证据时触发 runner 的 `GateStepError` 暂时性死区；将错误类声明提前后，门禁可生成脱敏失败报告并以非零退出。
- 旧 `M5-US-01` 工作流合同硬编码查找顶层 `npm test`，无法识别组合门禁内的 repository regression；测试改为检查 full 定义中的精确步骤。
- 覆盖报告使用墙钟时间导致同一源码连续生成不同；现仅接受显式 `NON_UI_REPORT_AT`/`SOURCE_DATE_EPOCH`，默认使用固定 epoch，commit 字段也仅接受显式输入或 `WORKTREE`。连续生成 SHA-256 均为 `c085322f469d981481eb76f0c86f91acda58311f4866ef05e8223134d096fe87`。
- Dashboard 覆盖验证发现实现已有 135 个 ID、计划仅有 131 个；补入 `DE2E-AUTH-011`、`DE2E-BOT-003`、`DE2E-MFA-002`、`DE2E-TAG-003` 的错误与重试语义，最终 135 planned = 135 implemented。
- 完成审计发现 failure artifact 虽有必需字段，但仍使用占位上下文，无法把失败测试可靠关联到本轮临时数据库。新增受环境开关控制的安全上下文、覆盖映射回退、request-id 提取和 before/after SHA-256 摘要；artifact schema 升至 v2，fixture namespace 只保存 12 位 SHA-256 指纹。
- 首次加强版稳定性在第 5 轮捕获到共享 Harness 停机期间的 PostgreSQL `57P01` 异步事件。先以分类测试复现，再仅在主动 stop 边界忽略该管理员终止码；其他 pool 错误仍聚合失败并保留数据库。`tests/m2-us-05-db.spec.ts` 随后连续 10 次、30 个测试通过。
- 第二次稳定性在第 7 轮捕获到 `M14-US-02` 旧自建 PostgreSQL 的 20 端口候选碰撞。该测试已迁移到共享 Harness 的私有 Unix Socket 并关闭 TCP；与同端口范围测试连续并行 10 次、30 个测试通过。两次失败都按零重试规则停止，最终稳定性从第 1 轮重新计算。
- 最终完成审计发现 A8 合同测试只由人工精确命令执行，PR quick 与 main full 均未包含它；先加入自守护 RED，再将 `nui-a8-gates.spec.ts` 纳入 quick。release evaluator 同时新增逐 ID 的 pending、failed 与 stale candidate 明细，避免只报数量而低估重验范围。门禁变更后废弃上一组稳定性完成声明并重新从第 1 轮验证。

## 三层门禁

- PR quick：环境检查、15 files / 109 个关键场景（包含 A8 门禁自守护）、77/77 覆盖报告。
- main full：包含 quick，并执行 77 files / 497 个 BNUI 测试、Prisma、192 条路由双向合同、Bot 74 files / 412 tests、全仓 310 files / 1563 tests、317 行验收矩阵、生成证据零漂移及 diff check。
- release：首先执行生产证据 preflight，只有通过后才包含 full、M22 礼物、Dashboard 覆盖和隔离 Chromium E2E。三个入口均由集中定义驱动，不含 retry/rerun/continue-on-error。
- v2 失败报告包含失败行或覆盖映射解析出的 test ID、commit SHA、run ID、实际观察到的临时数据库集合及关联强度、脱敏 Guild/Actor 指纹、request-id、before/after 摘要和覆盖映射；不会把先前 PASS 场景误记为失败。Authorization、密码、receipt、账号及私钥模式会被删除。

## 稳定性与兼容验证

- `NON_UI_RUN_ID=candidate-audit-stability npm run test:non-ui:stability`：2026-08-14T12:41:27.120Z 至 13:04:31.648Z 连续 10/10 通过，零重试；每轮均包含 quick 15/109、BNUI 77/497、Bot 74/412 和全仓 310/1563。逐轮耗时见 `stability.json`。
- `npm run test:gift:non-ui`：18 files / 99 tests 通过，确认礼物 M22 无回归。
- `npm run e2e:coverage:verify`：135 planned IDs = 135 unique implemented IDs。
- `npm run test:e2e:dashboard:isolated`：应用 45 个 migration 后 Chromium 143/143 通过，耗时 3.8 分钟；临时数据库 `blackcat_e2e_dashboard_16011` 已删除。
- `npm exec vitest run tests/non-ui/nui-a0-harness.spec.ts tests/non-ui/nui-a8-gates.spec.ts`：2 files / 20 tests 通过。

## 发布失败关闭证据

- 未设置真实 `P0_SIGNOFF_FILE` 与 `P0_CONFIG_SNAPSHOT_FILE` 时，`node scripts/p0-release-gate.mjs` 退出码为 1，并逐项报告两个缺失输入。
- 使用结构完整的合成对象仅验证 evaluator 逻辑时，结果仍为 `ready=false`：317 项验收、87 项 `PENDING_EXTERNAL`（53 项 P0_BLOCKER、34 项 P0_HIGH）、2 项已有外部候选证据和 2 个结构化签署角色。`AT-BOT-REV-001`、`AT-BOT-REV-002` 均绑定旧候选 `a078146…`，与最终候选不一致时必须重跑；evaluator 现返回全部具体 ID 和候选差异。
- 合成对象不是生产证据，详细机器记录见 `release-preflight.json`。

## 修改范围

- `.github/workflows/p0-ci.yml`、`.github/workflows/p0-release.yml`、`package.json`。
- `scripts/non-ui/gate-definition.mjs`、`run-layered-gate.mjs`、`run-stability.mjs`、`run-domain-gate.mjs`、`build-coverage-report.ts`。
- `tests/support/isolated-postgres.ts`、`non-ui-failure-context.ts`、`non-ui-assertions.ts` 与 fixture 上下文。
- `tests/non-ui/nui-a0-harness.spec.ts`、`nui-a8-gates.spec.ts`、`tests/m14-us-02-support-triage-postgres.spec.ts`、`tests/m5-us-01-cross-client.spec.ts`。
- Dashboard E2E 计划、覆盖 verifier 与验收证据。
- 覆盖报告、验收矩阵、Backlog、TODO 与本 Story 证据。

## 未解决风险

- 87 项真实 Discord、Railway/备份恢复、浏览器/运营签署等外部验收仍待对应负责人执行；另有 2 项旧候选 Discord UAT 必须重跑。全部外部结果必须绑定同一最终 release candidate。
- 仓库没有非 example 的生产签署文件和配置快照；在这些证据齐备前 release 必须继续失败，`M23-US-09` 不得标记完成。
