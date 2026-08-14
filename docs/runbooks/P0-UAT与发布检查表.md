# P0 UAT 与发布检查表

本文定义执行方法、证据格式和放行条件，不重复维护会快速变化的逐项用例。逐项步骤使用 `outputs/P0外部UAT待执行清单.md`；验收状态只以 `evidence/P0/acceptance-matrix.csv` 和 `evidence/P0/external-acceptance-results.json` 为准。

## 1. 当前基线

M23-US-09 已提交证据中的矩阵共 317 项：228 项自动化回归覆盖、87 项等待外部执行、2 项在旧候选上通过但必须对最终候选重跑。该数字只是文档对齐时的快照；候选变化后必须重新生成矩阵和执行清单。

在 87 项待执行、2 项旧候选重跑、真实配置快照、阻断缺陷清零和具名签署全部完成前，P0 不是 release ready。

## 2. 会话准备

- 在真实测试 Guild、Railway Sandbox、隔离恢复数据库和受支持浏览器执行，不使用生产凭证、真实个人数据或真实付款。
- 每轮冻结同一个不可变 `candidateRef`：`git:<40 位 SHA>` 或 `sha256:<64 位 digest>`。源码、配置或镜像变化即产生新候选，受影响项目必须重跑。
- 记录执行者、UTC 时间、环境、Guild/部署标识、测试数据命名空间和候选引用。
- 预先确认 Bot permissions、L1–L4 账号、客户/陪玩账号、Dashboard OAuth、Worker、故障注入和隔离恢复权限。
- 不直接改业务表伪造前置状态；使用统一 API、受控 fixture 或文档明确允许的准备流程。

## 3. 执行顺序

按 `outputs/P0外部UAT待执行清单.md` 的批次执行：

1. 账户、公共入口、私密频道、订单、CAT 余额与预留。
2. 候选池报名/撤回/终选、多陪玩权限和全员就绪。
3. 取消、退款、改派、客服接管、礼物、评价和跨角色投影。
4. Dashboard、RBAC、Guild 隔离、Bot 配置、列表/详情和可访问性。
5. Worker/Discord 重启恢复、消息修复、Railway 部署和数据库备份恢复。
6. 对旧候选已通过项在同一最终候选重跑，不复用旧截图、日志或签署。

本轮 89 个外部验收 ID 的唯一索引如下；具体步骤、状态和候选引用仍由外部 UAT 执行清单与验收矩阵维护：

`AT-ACC-001`, `AT-ACC-004`, `AT-CHN-001`, `AT-CHN-002`, `AT-CHN-003`, `AT-ORD-001`, `AT-ORD-004`, `AT-DSP-002`, `AT-SVC-002`, `AT-SVC-004`, `AT-CAN-004`, `AT-SUP-002`, `AT-SUP-004`, `AT-GFT-001`, `AT-GFT-010`, `AT-HIS-002`, `AT-RBAC-001`, `AT-ROL-004`, `AT-REC-003`, `AT-REC-004`, `AT-REC-005`, `AT-PL-001`, `AT-PL-003`, `AT-PL-004`, `AT-PL-005`, `AT-PL-006`, `AT-WRK-001`, `AT-WRK-003`, `AT-MAT-001`, `AT-MAT-002`, `AT-RDY-003`, `AT-RDY-004`, `AT-SUP-005`, `AT-SUP-006`, `AT-RFP-005`, `AT-UI-001`, `AT-UI-002`, `AT-UI-003`, `AT-UI-004`, `AT-UI-005`, `AT-CFG-001`, `AT-CFG-004`, `AT-CFG-006`, `AT-CFG-009`, `AT-CFG-010`, `AT-PRF-005`, `AT-GFT-013`, `AT-PRF-010`, `AT-WAL-007`, `AT-TKN-004`, `AT-TKN-005`, `AT-ONB-005`, `AT-DSP-017`, `AT-DSP-019`, `AT-DSP-020`, `AT-PRJ-002`, `AT-TRN-003`, `AT-MULTI-014`, `AT-MULTI-011`, `AT-SEL-001`, `AT-SEL-003`, `AT-SEL-007`, `AT-SEL-008`, `AT-SEL-009`, `AT-SEL-006`, `AT-SUP-011`, `AT-LST-004`, `AT-LST-008`, `AT-SUX-001`, `AT-SUX-003`, `AT-SUX-004`, `AT-SUX-005`, `AT-SUX-006`, `AT-SUX-007`, `AT-BOT-REV-001`, `AT-BOT-REV-002`, `AT-EXP-002`, `AT-EXP-003`, `AT-EXP-004`, `AT-EXP-005`, `AT-STATE-003`, `AT-STATE-004`, `AT-STATE-005`, `AT-ACT-002`, `AT-ACT-004`, `AT-REVIEW-002`, `AT-REVIEW-003`, `AT-GIFT2-004`, `AT-GIFT2-005`.

每项只在全部预期结果满足时标记 `PASSED`。失败、超时、环境不可信或证据不完整时：

- 保留原失败、`request_id`、时间戳和最小复现；
- 停止该项通过判断，不用重跑覆盖失败；
- 修复后使用新候选或明确同一候选重新执行，并追加新结果；
- 涉及资金、跨 Guild、权限或隐私问题时停止相关批次并评估影响范围。

## 4. 外部结果账本

每项完成后：

1. 在 `evidence/P0/external/<acceptanceId>/` 保存主 Markdown 和必要附件。
2. 对每个文件计算 SHA-256。
3. 向 `evidence/P0/external-acceptance-results.json` 追加唯一结果。

账本项字段必须恰为：

- `acceptanceId`
- `status`：只允许 `PASSED` 或 `FAILED`
- `candidateRef`
- `executedAt`：UTC ISO 8601
- `executor`
- `environment`
- `summary`
- `evidence`：每项含受限目录内相对 `path` 和 `sha256`

`evidence[0]` 必须是非空 UTF-8 Markdown 主证明；其余可为日志、截图、录屏或命令输出。不得使用符号链接、example、合成 evaluator 输入或另一候选的附件。

## 5. 主 Markdown 合同

元数据标签、顺序和五个二级标题必须精确如下。标签冒号后一个空格，值无首尾空白；账本字段与 Markdown 规范化后必须一致。

```markdown
Acceptance ID: AT-XXX-001
Status: PASSED
candidateRef: git:0123456789abcdef0123456789abcdef01234567
executedAt: 2026-08-15T12:00:00.000Z
executor: qa-reviewer
environment: test-guild-and-isolated-database
Redaction Review: CONFIRMED
Redaction Details: Tokens, secrets, account identifiers, balances, and personal data were removed; controlled originals are retained by QA.

## Preconditions
写明已建立并核验的状态、数据、身份和环境。

## Steps
按执行顺序写明可复现操作。

## Expected Result
写明验收合同的精确预期，不省略零写入、权限或时效条件。

## Actual Result
写明实际观察、状态、时间和对账，不只写 passed 或 ok。

## Diagnostics
request_id=req_xxxxxxxx；或 command-output: evidence/P0/external/AT-XXX-001/command-output.log
```

`Redaction Review` 必须逐字为 `CONFIRMED`。`Redaction Details` 至少包含 40 个 Unicode 字母或数字，并具体说明删除/保护的敏感内容和受控原件保留策略。

## 6. 脱敏与证据质量

- Git 证据只保存脱敏副本。Token、Secret、TOTP、Cookie、数据库密码、完整 Session、receipt 正文、完整外部参考号、账号、余额、返佣来源和个人数据不得进入仓库。
- 受控原件的访问策略和存储引用可以记录，但不能把原件内容复制进 Markdown。
- 截图必须包含足够界面上下文、候选/环境关联和实际状态；不能只截成功 Toast。
- 日志保留 request ID、状态迁移、Job/Outbox 和时间信息，同时删除 Authorization 与敏感 payload。
- 资金用例要对账预留、WalletEntry、消费/收益/返佣或 Adjustment，不能只验证界面文案。
- 权限用例同时验证允许和拒绝路径、跨 Guild、审计归因和 session/Role 撤权。

## 7. 发布前自动化与恢复

候选至少执行并保存结果：

```bash
npm run verify:non-ui:environment
npm run test:non-ui:full
npm run e2e:coverage:verify
npm run test:e2e:dashboard:isolated
```

按当前合同完成：

- Railway `web`/`bot`/`worker` 健康、迁移和私网连接；
- 真实 Guild 的入口、频道、Role、候选池、礼物、评价和恢复；
- Dashboard 关键路径、四级权限、双视图、响应式与键盘操作；
- Worker/Discord 故障恢复且不重复资金、消息或任务；
- 新隔离数据库备份恢复，核对引用、只追加事实和活跃流程续行；
- 候选镜像与回滚镜像 digest、P0 范围和零阻断缺陷。

## 8. Release gate

真实签署和配置快照不得使用包含 `example` 的路径。输入齐备后运行：

```bash
P0_SIGNOFF_FILE=evidence/P0/release/signoff.json \
P0_CONFIG_SNAPSHOT_FILE=evidence/P0/release/config-snapshot.json \
npm run test:non-ui:release
```

配置快照至少要有：

- 与外部证据一致的 `releaseCandidate`
- `rollbackImageDigest`
- Railway、CAT funding mode、Discord Guild、备份恢复和 Worker 恢复证据
- `scope=P0`、`p1Excluded=true`、`blockingDefects=0`
- `realMoneyFundingExcluded=true`、`providerIntegrationDeferred=true`

签署至少包含具名 `owner` 与 `staff` 明确批准、UTC 时间和证据。产品、运营、客服或技术的附加签署按组织要求保存，但不能替代门禁要求。

## 9. 放行判断

只有以下条件同时满足才可声明 release ready：

- 当前候选 full/release 自动化通过；
- 矩阵没有 `PENDING_EXTERNAL`、失败、无效状态或旧候选通过记录；
- Discord、Dashboard、Railway、Worker 和备份恢复均有真实候选证据；
- 配置快照、回滚 digest、owner/staff 签署完整；
- P0 阻断缺陷为零，P1 与 Nice to Have 明确排除。

任一条件缺失时，结论必须是“候选自动化或部分 UAT 已通过，但发布门禁未完成”。
