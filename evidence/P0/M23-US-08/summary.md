# M23-US-08 验证证据

## Story 与范围

- Story：`M23-US-08`
- 实施包：`NUI-A7`
- 范围：可信 Actor/RBAC/Role、Bot 配置、审计、运营指标、稳定列表、跨消费者投影、恢复、订单评价与 Bot adapter，共 12 个 BNUI 场景。
- 外部边界：真实 Discord 客户端视觉、Role 生效提示、频道投递、重启时效和 Dashboard 浏览器交互仍按 acceptance class 保留外部验收，不因 API/DB/Worker/adapter 自动化而改写完成结论。

## 基线、RED 与修复

- A7 新增领域源初始基线为 `23 files / 139 tests` 全部通过。
- 首次累计覆盖门禁中 76 个文件通过、492 项领域测试通过，机器报告测试失败：报告校验对整个 JSON 做词语扫描，把合法测试名称中的 `secrets` 和 `validation token` 误判为敏感数据。
- 校验现递归检查结构化敏感键，并扫描真实凭据值模式；自然语言描述可出现安全术语。新增反向注入回归，向 source 注入 `password: 123456` 时仍明确失败关闭。
- 共用 PostgreSQL Harness 新增已知 migration 的 `exclude`/`only` 选择，未知 migration 立即拒绝；评价升级测试可安全执行“旧迁移→旧数据→升级迁移”，同时复用隔离身份守卫和可靠 stop。

## GREEN 与门禁

- `npm run test:non-ui:a7`：累计 `77 files / 493 tests`，最终版本连续三轮通过。
- `npm run generate:non-ui:coverage`：`77 total / 77 automated / 0 planned`。
- 5 个历史 PostgreSQL 测试迁入共享 Harness：Role/access、Bot config、audit header/change、八项 metrics、order experience review upgrade。
- 覆盖完整性测试逐条确认 77 个 AUTOMATED source 文件和测试名称存在且没有 `skip/todo`；机器报告仍区分 `AUTOMATED_FULL` 与 `AUTOMATED_PARTIAL_EXTERNAL_REMAINS`。
- `npm run test:gift:non-ui`：`18 files / 99 tests`；`npm run quality:bot`：`74 files / 412 tests`，Piece discovery、Bot lint/format/type/build 均通过。
- `npm test`：`309 files / 1555 tests`；Prisma、192 路由双向合同、API lint、全项目 typecheck 全部通过。
- `node scripts/build-p0-acceptance-matrix.mjs` 重建 317 行验收矩阵。

## 场景与验收映射

- `BNUI-AUTH-001`：`AT-AUTH-001;002;003`；Bot/Dashboard 伪造 Actor、Role、level 和 owner 失败关闭。
- `BNUI-RBAC-001`：`AT-RBAC-001;002;007;008;009;010;011`；L1–L4 累积继承不绕过 scope、step-up、原因和不可删除边界。
- `BNUI-ROL-001`：`AT-ROL-001`～`005`；Role 仅为观测信号，首次提权复核、降级和 permissions_version 撤权。
- `BNUI-CFG-001`：`AT-CFG-001`～`009`；validate/preview/token/apply、Channel/Role Select、权限、版本竞态与审计原子性。
- `BNUI-AUD-001`：`AT-AUD-001`～`004`；生产写路由 secure wrapper、成功/拒绝/失败语义、嵌套脱敏及 DB header/change 事务。
- `BNUI-MET-001`：`AT-MET-001`～`008`；固定时区下八项指标由不可变事实复算并保持 Guild scope。
- `BNUI-LST-001`：`AT-LST-001;002;003;008`；排序白名单、唯一 ID tie-breaker、NULLS LAST、HMAC cursor 查询/Guild/scope 绑定。
- `BNUI-STATE-001`：`AT-STATE-002`～`005`；订单/任务跨角色矩阵、原位卡片、Dashboard 最新请求和投影告警收敛。
- `BNUI-REC-001`：`AT-REC-003;004`；stale Job、删除面板、消息丢失和稳定 nonce 恢复不重写领域事实。
- `BNUI-REVW-001`：`AT-REVIEW-001;002;004`；仅订单所有者评价派生目标、逐目标并发唯一、评价与订单/资金隔离。
- `BNUI-REVW-002`：`AT-REVIEW-003;004`；仅明确同意的五星安全快照进入 Outbox，取消/低星/私密字段零公开，重试不重复。
- `BNUI-BOT-001`：`AT-BOT-REV-003;004`、`AT-ACT-004`、`AT-EXP-004;005`；真实 transport Actor/幂等/envelope/失败语义及 renderer custom-id route 可达。
- 精确 executable source 与 acceptance class 见 `evidence/P0/non-ui-automation/coverage.json`。

## 修改文件

- 共用报告、覆盖、migration 与隔离 PostgreSQL Harness。
- `tests/m4-us-05-db.spec.ts`、`tests/m4-us-10-db.spec.ts`、`tests/m4-us-09-db.spec.ts`。
- `tests/m7-us-03-audit-db.spec.ts`、`tests/m21-us-02-postgres.spec.ts`。
- A7 覆盖注册表、累计门禁、机器报告、Backlog、TODO 和验收矩阵。

## 剩余风险

- 77 个 BNUI 业务场景已有自动化证据，但含真实 Discord/Dashboard/外部时效的子条件继续标为 `AUTOMATED_PARTIAL_EXTERNAL_REMAINS`，不得解释为 UAT 已完成。
- NUI-A8 尚需建立 PR quick/main full/release 三层门禁、连续十轮 full、外部证据失败关闭和最终发布审计。
