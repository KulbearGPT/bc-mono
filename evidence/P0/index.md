# P0 证据索引

本目录保存 P0 Story、自动化门禁、外部 UAT 和发布判断的可复核记录。它是审计轨迹，不是规格替代品：当前业务语义以权威合同、当前源码、迁移、测试和未被覆盖的证据共同判断。

## 当前发布结论

截至 M23-US-09 已提交候选：

- 验收矩阵共 317 项：228 项 `COVERED_BY_REGRESSION`、87 项 `PENDING_EXTERNAL`、2 项在旧候选上 `PASSED`；
- 2 项旧候选结果必须绑定最终 release candidate 重新执行，不能直接计入最终签署；
- quick、full、稳定性、礼物回归和 Dashboard 隔离 E2E 已有候选证据；
- 非 example 的生产配置快照、最终候选外部证据和具名签署尚未齐备；
- `M23-US-09` 保持 `IN_PROGRESS`，发布门禁必须继续失败关闭。

数量会随矩阵重生成而变化。作出新结论前必须读取并核对：

1. `acceptance-matrix.csv`
2. `external-acceptance-results.json`
3. `M23-US-09/summary.md`
4. `M23-US-09/release-preflight.json`
5. `../../outputs/P0外部UAT待执行清单.md`

## 历史证据的解释规则

- 每个 `M*-US-*/summary.md` 记录该 Story 当时的合同、命令、结果、候选和剩余风险，正文不得为了匹配后续设计而改写。
- M0–M6 中的 Provider、账户绑定、支付 Webhook、自动派单、双边 readiness 和早期金额语义，后来分别被 M7、M9、M10、M11 及后续整改覆盖；它们只能证明当时的开发轨迹，不能恢复为当前要求。
- 覆盖关系由新 Story 证据、最新验收矩阵和当前合同表达。旧记录中的 `PASSED` 不等于当前候选、当前环境或当前业务语义已经通过。
- 外部结果只有在 `external-acceptance-results.json` 中满足候选、执行人、UTC 时间、证据哈希和脱敏合同后才有效；示例、合成 evaluator 输入和旧候选不能替代最终 UAT。

## 里程碑导航

| 阶段 | 主题 | 解释 |
|---|---|---|
| M0–M4 | 工程骨架、目录/订单、早期派单、礼物、Dashboard/RBAC | 保存早期实现轨迹；资金、派单和 readiness 的部分设计已被后续里程碑覆盖 |
| M5–M6 | 验收/部署、结算/周报/Profile | 部署证据仍需结合当前 Runbook；发布和真实环境签收未因此自动完成 |
| M7–M9 | 内部钱包、客户代币展示、Discord 入驻与 CAT 账本 | M7 退役 Provider；M9 建立当前 CAT 钱包和线下 USD 凭证边界 |
| M10–M11 | 多陪玩订单、候选池报名与终选 | 覆盖单陪玩/自动派单设计；当前不使用自动派单和客户 readiness |
| M12–M15 | 客服班次、集合视图、任务优先工作台、运营闭环 | 当前客服与 Dashboard 交互基线 |
| M16–M20 | API/Dashboard/Bot 审查与跨角色一致性 | 安全、恢复、状态投影和 Discord 控件整改 |
| M21–M22 | 完单评价、独立与匿名礼物 | 当前评价广播和两类送礼入口合同 |
| M23 | 全业务非 UI 自动化与候选门禁 | `M23-US-01` 至 `08` 已建立分域覆盖；`M23-US-09` 因外部验收和签署未完成 |

逐 Story 状态、验收编号和修改范围以 `outputs/Codex-P0开发TODO.md`、backlog 及对应目录内的 `summary.md` 为准。

## 目录约定

- `M<里程碑>-US-<序号>/`：单个 Story 的 RED/GREEN、命令、结果与风险。
- `gates/`：里程碑门禁记录。存在文件只说明保存了记录，是否仍有效需核对覆盖关系和候选。
- `non-ui-automation/`：非 UI 覆盖定义、报告与组合门禁输入。
- `dashboard-e2e/`：Dashboard 浏览器覆盖与隔离执行证据。
- `external/<acceptanceId>/`：真实外部验收附件；必须由外部结果账本引用。
- `external-acceptance-results.json`：外部验收唯一结果账本。
- `release/`：发布配置和签署模板或真实受控输入。文件名或内容为 example 时不能用于放行。
- `api-review-*`、`dashboard-*`：专项审查整改证据，须结合关联 Story 和当前源码阅读。

## 提交新证据前

- 绑定不可变候选引用并记录真实环境、执行者和 UTC 时间；
- 只记录实际执行的命令和输出，不从历史报告复制数量；
- 对 Token、TOTP、receipt、账号、余额、返佣来源和个人数据脱敏；
- 失败保留复现、`request_id` 和最小诊断，不用重跑覆盖原失败；
- 更新矩阵、TODO/backlog 和对应 Story summary，并检查生成物零漂移；
- 没有真实外部执行时保持 `PENDING_EXTERNAL`，没有最终签署时保持 release fail-closed。
