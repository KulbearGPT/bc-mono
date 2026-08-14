# M23-US-07 验证证据

## Story 与范围

- Story：`M23-US-07`
- 实施包：`NUI-A6`
- 范围：周报生成、本人/员工读取与修订、结算预览/创建/复核/导出/线下支付登记/作废替代，共 9 个 BNUI-RPT/SET 场景。
- 非范围：系统不连接银行或第三方转账通道；实际外部转账仍由工作人员完成，`BNUI-SET-004` 因而保持 `AUTOMATED_PARTIAL_EXTERNAL_REMAINS`。

## RED 与缺口修复

- 领域源初始基线为 `9 files / 76 tests` 全部通过；随后按主规格核对发现运行时仅接受 CAT，但非 CAT 错误仍声称“仅支持 USD”。精确错误合同 RED 为目标 `1 failed / 8 skipped`，修正后返回 `P0 settlements support CAT only.`。
- TRANSFER_LIST 与结算合同相比缺少“应付 CAT + 线下实际支付 USD 辅助显示”。精确 CSV RED 为目标 `1 failed / 14 skipped`；修正后保留 CAT 为唯一结算币种和账本金额，并新增 `manual_transfer_usd` 派生列。固定关系下 CAT subunit 与 USD cent 数值相同，例如 `2000.0 CAT → 200.00 USD`，不持久化第二套余额或流水。
- 强化替代批次攻击测试：self replacement、跨 Guild、跨币种均在零变更状态下拒绝；合法替代才原子作废原批次并创建同 Guild、同 CAT 新批次。

## GREEN 与门禁

- `npm run test:non-ui:a6`：累计 `49 files / 318 tests`，最终版本连续三轮通过。
- `npm run generate:non-ui:coverage`：`77 total / 65 automated / 12 planned`。
- 覆盖完整性测试逐条确认 AUTOMATED source 文件和测试名称存在，且没有 `skip/todo`。
- 周报、结算及 durable idempotency 的 4 个历史 PostgreSQL 测试均使用共用隔离 Harness、Unix socket、当前全部 migration、安全目标守卫和可靠 stop。
- `npm run test:gift:non-ui`：`18 files / 99 tests`；`npm test`：`309 files / 1555 tests`，全部通过。
- `npm run db:validate`、`npm run quality:routes`、`npm run lint:api`、`npm run typecheck`：Prisma 有效、192 个生产 operation 与 OpenAPI 一致、API ESLint 零警告、类型通过。
- `node scripts/build-p0-acceptance-matrix.mjs` 重建 317 行验收矩阵。
- 残留检查确认 A6 共用 Harness 未遗留实例；另识别并停止 3 个前一日旧测试留下、父进程为 1 的孤儿 PostgreSQL，仅停止明确测试数据目录，未删除数据。

## 场景与核心验收映射

- `BNUI-RPT-001`：`AT-RPT-001`；周期内个人周报、汇总、通知原子生成并幂等重放，跨周期 Adjustment 正确归属。
- `BNUI-RPT-002`：`AT-RPT-002;007;008`；本人只读、L2 当前投影与 CSV、L3 step-up 追加修订并幂等。
- `BNUI-RPT-003`：`AT-RPT-006`；首次通知失败只重试通知，不重放报表生成。
- `BNUI-SET-001`：`AT-SET-001`；空预览成功但空批次拒绝，同一收益并发只进入一个活动批次。
- `BNUI-SET-002`：`AT-SET-002;003`；自动调度重放返回同批次，负 Adjustment 延期并只抵扣后续正收益。
- `BNUI-SET-003`：`AT-SET-004`；高额手工批次要求不同人员复核，创建者不能凭继承 L4 自批。
- `BNUI-SET-004`：`AT-SET-005;010`；逐条成功/失败只追加，失败可重试，未选择项不变，并发登记不重复。
- `BNUI-SET-005`：`AT-AUD-005`；作废替代限制同 Guild、同币种、不可 self/cycle 且原子审计。
- `BNUI-SET-006`：`AT-SET-006`；RFC4180/BOM/固定列导出脱敏外部账号，仅输出 CAT 账本金额及线下 USD 辅助值。
- 精确逐场景 executable source 见 `evidence/P0/non-ui-automation/coverage.json`。

## 修改文件

- `apps/api/src/settlements.ts`
- `tests/m6-settlement-security.spec.ts`
- `tests/m6-us-01.spec.ts`、`tests/m6-us-01-db.spec.ts`
- `tests/m6-us-02-api.spec.ts`、`tests/m6-us-02-db.spec.ts`
- `tests/m6-us-03.spec.ts`、`tests/m6-us-03-api.spec.ts`、`tests/m6-us-03-db.spec.ts`、`tests/m6-us-03-worker.spec.ts`
- 非 UI 覆盖、累计门禁、机器报告、Backlog、TODO 和验收矩阵。

## 剩余风险

- 实际第三方转账与真实下载响应仍需外部验收；自动化只验证转账清单、人工结果登记和内部事实收敛，不把外部支付写成系统已执行。
- NUI-A7～A8 尚未实施，剩余 12 个 BNUI 场景保持 `PLANNED`。
