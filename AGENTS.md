# Blackcat P0 仓库协作规则

## 1. 仓库定位与当前状态

- 本仓库同时保存 P0 业务规格、结构化合同、可运行源码、数据库迁移、自动化测试、验收矩阵、运维 Runbook 与历史证据。文档、原型、测试替身或勾选状态都不能单独证明生产能力。
- 当前工程已经建立，不再处于“等待 M0 创建目录”的阶段。真实工作区包含：
  - `apps/api`：Fastify 统一业务 API 与异步 Worker；
  - `apps/bot`：Sapphire/discord.js 交互适配器；
  - `apps/dashboard`：React/Vite 运营控制面；
  - `database`：Prisma schema、迁移与种子；
  - `modules/platform`：跨进程平台合同与环境校验；
  - `tests`、`scripts/non-ui`、`tests/e2e`：单元、集成、隔离 PostgreSQL、Bot 和 Dashboard 门禁。
- 截至 2026-08-14，M23 三层非 UI 自动化候选已建立，但发布仍是 **fail-closed**：`evidence/P0/M23-US-09/summary.md` 记录 317 项验收中仍有 87 项外部验收待执行，且 2 项旧候选证据必须绑定最终候选重跑。`M5-US-02`、`M5-US-03`、`M23-US-09` 以及若干真实 Discord、Dashboard、Railway、恢复与签署门禁仍未完成。
- 因此，除非验收矩阵、最终候选外部证据、生产配置快照和具名签署全部通过，不得声称“P0 已发布”“生产就绪”或“全部完成”。后续提交可能改变上述数量；每次工作必须重新生成矩阵并读取最新证据，不能复制本节数字作为新结论。

## 2. 事实来源与冲突处理

动手前按任务范围读取事实。业务语义发生冲突时，优先级如下：

1. 主规格：`outputs/Discord陪玩业务Bot最小原型设计开发文档.html`。
2. 开发计划：`outputs/P0开发交付包/06-开发计划/backlog.csv`。
3. API 合同：`outputs/P0开发交付包/02-API/openapi.yaml`。
4. 数据合同：`database/prisma/schema.prisma`、`outputs/P0开发交付包/03-数据模型/schema.prisma` 及状态约束。
5. 交互映射：`outputs/P0开发交付包/01-UIUX/交互映射.csv`。
6. 验收合同：`outputs/P0开发交付包/07-验收测试/acceptance-cases.csv`。
7. 专项合同、业务配置、钱包、客户代币展示、路线图和已批准的后续变更。

实现状态必须另外由以下事实共同证明：

1. 当前源码和已应用迁移；
2. 与真实生产入口一致的测试；
3. `evidence/P0/acceptance-matrix.csv` 和对应 Story 证据；
4. `outputs/Codex-P0开发TODO.md` 与 backlog 状态；
5. 对外部能力而言，绑定同一 release candidate 的真实 UAT、环境证据和具名签署。

- `PLANNED`、OpenAPI path、Prisma model、页面原型、合成 fixture、截图或自动化 `PASSED` 均不能替代真实运行时实现与外部验收。
- M7 及之后获批的合同变更覆盖早期 Provider 资金、账户绑定、支付 Webhook、充值 URL 和非 CAT 资金语义。不得从 M0–M6 历史证据恢复已退役设计。
- 如果主规格、OpenAPI、Prisma、状态机、交互映射或验收用例互相冲突，停止当前 Story。先记录冲突并同步修正所有权威镜像和引用，再继续实现；不得猜测资金、权限、Guild、状态迁移或隐私规则。

## 3. 架构边界

### 3.1 统一 API

- API 是业务规则、授权、状态迁移、金额计算、幂等、审计和数据库访问的唯一入口。
- Bot 只负责把 Discord 交互转换为携带可信 Actor Context 的 API 调用，并渲染 API 返回事实。Bot 不直连数据库，不在 renderer、handler、custom ID 或进程内 Map 中复制资格、价格、余额、状态机和 RBAC。
- Dashboard 只通过统一 API 工作。浏览器端不直连数据库，不自行计算最终余额、允许动作、审批级别或对象归属。
- Worker 只消费事务内创建的 Outbox/Job，并通过稳定 nonce、幂等键和可恢复 handler 推进投影或后台任务；重试不得重复业务写入。
- 客户端共享只能使用版本化 API/平台合同。禁止从 `apps/bot` 或 `apps/dashboard` 导入 API domain/store 内部实现。

### 3.2 可信身份、权限与租户隔离

- 每个 Bot、Dashboard、受控 Webhook 和系统 Job 请求都必须解析可信 Actor Context：真实 actor、Guild、对象归属、有效权限、scope 与 `permissions_version`。
- 不信任客户端提交的 actor ID、staff ID、sender ID、receiver ID、权限等级、Discord Role、Guild 所有权或对象所有权。
- 权限固定为 `L1_SUPPORT < L2_SUPERVISOR < L3_OPERATIONS < L4_ADMIN_OWNER`，高级别累积继承低级别权限，但仍受批准等级、scope、MFA/step-up 和 maker-checker 约束。
- Discord Role 只是授权映射信号，不是最终授权事实。降级或撤权必须增加 `permissions_version`、撤销旧会话并使后续请求立即失败关闭。
- 所有查询、写入、幂等作用域、Outbox、审计、导出、替代链和恢复动作必须按可信 Actor Context 中的 Guild 隔离。跨 Guild 猜测 ID 不能返回可枚举信息。

## 4. 不可破坏的领域规则

### 4.1 CAT 钱包与资金

- 内部 CAT 钱包负责客户账户事实、真实余额、充值、消费和退款，是这些资金事实的唯一来源。Stripe、PayPal、信用卡、银行等渠道只由工作人员线下核对 receipt、换汇、退款或转账；P0 不连接这些支付 API，也不保存支付密码或完整支付凭证。
- 除充值付款事实外，内部金额一律使用 CAT subunit 整数。固定 `1 USD = 10 CAT`，且 `1 USD cent = 1 CAT subunit`。充值表单录入 USD cents、付款渠道和 receipt。陪玩结算同时展示应付 CAT 与线下实际支付 USD；USD 只用于充值录入或人工结算辅助展示，不建立第二账本。
- 对外余额字段保持 `ledgerBalanceMinor`、`reservedMinor`、`availableMinor`、`currency`、`calculatedAt`。`availableMinor = ledgerBalanceMinor - reservedMinor` 必须由 API 在同一并发控制边界计算，客户端不得提交或覆盖最终值。
- WalletEntry、消费、退款、收益、返佣和 Adjustment 只追加。纠错使用反向记录或 Adjustment，不覆盖原始金额，不硬删除资金事实。
- receipt 只保存合同允许的最小元数据与受控私有附件；日志、错误、测试报告和 Git 中不得出现凭证正文、账号、密码、TOTP 或密钥。

### 4.2 FundReservation

- 订单提交或礼物请求时创建预留；完成或批准时捕获；取消、拒绝、过期、撤回或失败时释放；争议期间保持；部分结案按决议捕获并释放剩余金额。
- 创建、捕获、释放和恢复必须经统一 API，在数据库事务、幂等和并发锁内完成。失败路径不得留下部分资金事实。
- 当前候选池招募和选秀均无自然截止：只由客户明确开始招募、终止招募、重新招募、取消或提交终选；系统不得按时间自动收口、续轮、选人或释放订单预留。客户取消时由 API 原子取消并释放未捕获预留。

### 4.3 订单、候选池与就绪

- 价格、目录版本、需求、参与人、分成和资金都使用服务端快照；客户端不根据当前目录追改历史订单。
- 当前 P0 使用候选池、报名和终选流程。不得恢复已退役的自动派单、客户选秀旧语义或客户端决定正式参与人。
- 订单从 `ACCEPTED` 进入 `IN_SERVICE` 前，客户不提交 readiness，只读查看逐名进度。所有当前有效陪玩必须分别确认本人就绪；前 N-1 人确认不能开始计费，最后一人确认后 API 只迁移一次。
- 取消、退款、改派、客服接管、异常结案和完成确认必须先由 API 返回允许动作和影响预览，再在版本、权限、金额与预留均仍有效时原子执行。

### 4.4 礼物、收益、返佣与结算

- P0 礼物支持订单内与独立入口两种来源。订单内礼物只接受有效订单参与人 `participantIds`；独立入口只接受 API 返回的同 Guild 有效陪玩 playerProfileId。真实 receiver 由 API 派生，Bot、Dashboard 和请求体不得接受任意 receiverId。
- 匿名只改变陪玩和公共频道看到的 sender 展示。资金、客服、风控和审计始终保留真实 `sender_id`。
- 客服辅助礼物采用模式 B：从客户本人同 Guild Discord 消息解析付款人，验证客服本人的六位 TOTP、专用 `gift.assist` 权限、必填原因和消息证据后直接预留。请求不得接受任意 `senderId`；错误、过期、重放或并发冲突必须零资金写入。
- 返佣关系、受益人、比例、金额与状态对被推荐用户保密。用户只能查看自己作为受益人的记录，来源用户默认脱敏；错误、通知、Discord、导出和日志均不得泄露关系。
- 周报与结算只汇总可信订单、收益和 Adjustment。系统生成外部转账清单，但不连接银行或转账通道；员工完成线下转账后才逐条登记成功或失败，未选择条目保持未登记。
- 高额结算必须异人复核。创建者即使具有 L4 也不能自批。作废已批准或已导出批次时，替代批次必须同 Guild、同币种且不得形成循环。

### 4.5 只追加审计

- 订单事件、配置事件、资金、消费、收益、返佣、预留、Adjustment、AuditLog 和 AuditLogChange 均只追加，不修改、不硬删除。
- 所有非只读操作——包括成功、拒绝和失败——都必须审计。成功业务变更与审计头、逐对象 change 应在同一事务提交。
- 日志和失败报告必须带 `request_id`，但必须对 Authorization、密钥、TOTP、receipt、外部账号和个人敏感数据脱敏。

## 5. Discord 与 Dashboard 交互规则

- Discord 中个人余额、订单、消费、返佣、配置、错误和其他敏感内容只能出现在私密频道或 ephemeral 响应；ephemeral 不能替代 API 权限和归属校验。
- Channel、Role、用户可见目录和 PlayerProfile 使用 API 限定的 Select，不提供手工输入 ID 的绕过路径。Discord Select 单次最多 25 个选项，分页和返回必须保持选择状态。
- 当前锁定 `discord.js` 版本的实际 Builder 能力必须由测试 Server 验证。结构化级联选择使用消息组件；Modal 主要收集少量自由文本，不能假设已打开 Modal 可动态级联刷新。
- `custom_id` 只保存操作类型、短期会话标识和恢复所需的最小版本信息，不携带可信业务事实或敏感数据。旧组件、重复点击、进程重启和消息丢失必须安全恢复或明确失效。
- `/bot-config` 是仅操作者可见的 Guild 内流程。L3 管理运营配置，L4 可管理安全 Role 映射；保存前校验对象 Guild、类型、Bot 权限、配置版本和短期 validation token，成功后刷新缓存并由 API/数据库保证重启恢复。
- Dashboard 导航和按钮可按 API capabilities 选择性显示，但隐藏按钮不是授权。所有写操作仍须由 API 复核 Actor、Guild、scope、step-up、版本和幂等键。

## 6. 开发工作流

### 6.1 开始前

1. 读取 `outputs/Codex-P0开发TODO.md`、backlog 对应行、相关合同、验收 ID 和现有 Story 证据。
2. 检查前置 Story、合同一致性和当前工作树。不得覆盖或混入其他人未完成的改动。
3. 同一时间只实施一个已解锁 Story 或一个边界明确的缺陷。修复若属于某个未完成 Story，应回到该 Story 的验收与证据，不另造平行业务规则。
4. 明确真实生产入口和测试入口。使用 in-memory store、fake transport 或浏览器 fixture 的测试必须如实说明边界，不能推断 PostgreSQL、真实 Discord 或部署环境已经通过。

### 6.2 实施

- 代码 Story 使用：合同与现状核对 → 可观察的失败测试（RED）→ 最小实现 → 聚焦测试 → 相关回归 → 证据和状态同步。
- 审查、UAT、恢复或发布 Story 使用：建立未通过门禁基线 → 执行真实检查 → 复验门禁 → 保存证据。不得为非代码工作伪造 RED，也不得用合成 evaluator 输入冒充真实 UAT。
- 保持最小修改范围。禁止顺手引入 P1、Nice to Have、未知依赖、未批准状态、支付集成、多租户或无关重构。
- 不为迁就代码擅改规格、OpenAPI、Prisma、交互或验收。确需改变合同时，必须同步所有权威副本、生成物、映射、测试、矩阵和证据。
- 数据库变更必须新增可升级迁移，并同时验证 fresh apply 与从当前基线升级。不得修改已发布迁移来掩盖问题。
- 新写端点必须接入统一鉴权、Actor Context、Guild scope、Idempotency-Key、事务审计和错误脱敏；禁止仅在路由外观上声明这些能力。

### 6.3 文档与证据

- 每个完成的 Story 都要更新 `outputs/Codex-P0开发TODO.md` 和 backlog 状态，记录验收编号、实际修改文件、RED/GREEN、精确命令、环境、结果与剩余风险。
- Story 证据放入 `evidence/P0/<STORY-ID>/`；门禁证据放入对应 `evidence/P0/gates/` 或专项目录。证据必须可复核、脱敏、绑定候选，不保存真实秘密。
- `docs/` 与 `outputs/` 中的合同镜像必须保持一致。生成验收矩阵后检查 diff，不允许提交陈旧生成物。
- 外部验收只能写入权威外部结果账本，并满足候选引用、执行人、UTC 时间、证据哈希和脱敏要求。未执行项保持 `PENDING_EXTERNAL`，不得为了让门禁通过而改成 `PASSED`。
- 已提交的 Story 证据是当时执行事实。后续合同替代旧设计时，保留原证据正文，在 `evidence/P0/index.md`、新 Story 证据和验收矩阵中标记覆盖关系；不得为追求当前术语一致而改写历史命令、结果、候选引用或签署。当前行为只由最新合同、源码、测试和未被覆盖的证据共同判断。

## 7. 使用真实工程命令

环境基线：Node.js 22+、npm 10+；数据库集成和非 UI 门禁需要本机 PostgreSQL 工具。首次安装使用 `npm ci`，只有明确更新依赖时才使用 `npm install`。

按修改范围选择最小充分验证：

```bash
npm run typecheck
npm run build
npm run db:validate
npm run db:verify:migration
npm run quality:routes
npm run lint:api-dashboard
npm run quality:bot
npm test
```

非 UI 分层门禁：

```bash
npm run verify:non-ui:environment
npm run test:non-ui:quick
npm run test:non-ui:full
npm run test:non-ui:stability
```

Dashboard 门禁：

```bash
npm run e2e:coverage:verify
npm run test:e2e:dashboard:isolated
npm run test:e2e:dashboard:compat
```

- PR 使用 quick；`main` 候选使用 full；release 只在真实 `P0_SIGNOFF_FILE` 与 `P0_CONFIG_SNAPSHOT_FILE` 齐备后运行 `npm run test:non-ui:release`。
- Release preflight 失败是正确结果，不能跳过、降级或用 example/合成输入替代。不得增加无条件 retry、rerun 或 `continue-on-error` 来制造绿色门禁。
- 不盲目运行不存在的脚本，也不把历史证据中的通过数量当作本次结果。完成汇报只引用本次实际运行的命令和输出。

## 8. Git 与提交历史

- 提交使用 Conventional Commits：`type(scope): imperative summary`。允许的常用 type 为 `feat`、`fix`、`test`、`refactor`、`perf`、`build`、`ci`、`chore`、`docs`。
- scope 必须从以下 20 个稳定值中选择，不得创造近义词或临时 scope：`identity`、`catalog`、`orders`、`matching`、`wallet`、`gifts`、`players`、`referrals`、`support`、`settlement`、`reviews`、`bot`、`dashboard`、`database`、`platform`、`quality`、`operations`、`release`、`contracts`、`repo`。
- scope 优先表达提交负责的业务领域，而不是修改文件所在目录。订单 API 使用 `orders`，礼物 Bot 入口使用 `gifts`，结算 Dashboard 页面使用 `settlement`；不要因为代码位于 `apps/api`、`apps/bot` 或 `apps/dashboard` 就机械选择技术层 scope。
- 只有纯 Discord adapter、组件协议、transport 或跨领域通用展示使用 `bot`；只有纯 Dashboard shell、通用 UI、导航或浏览器请求状态使用 `dashboard`。单一领域的客户端实现和测试仍使用对应领域 scope。
- 通用 API 中间件、Outbox、审计、环境和跨领域配置使用 `platform`；跨领域 schema、迁移框架与数据库基础约束使用 `database`。领域专属 Worker、迁移和 API 改动仍跟随业务领域。
- 跨领域测试框架、lint、覆盖率和自动化门禁使用 `quality`；部署、进程运行、监控、备份和恢复使用 `operations`；候选、外部 UAT、签署与发布门禁使用 `release`；Monorepo、依赖、开发工具、Git 和仓库维护使用 `repo`。
- 单领域合同和证据跟随业务 scope，例如 `docs(gifts)` 或 `test(wallet)`；只有同时约束多个领域的权威合同与镜像使用 `contracts`。`feat`、`fix`、`test`、`docs` 已表达提交类型，不得再以 `evidence`、`design`、`e2e`、`non-ui` 等内容类型作为 scope。
- 如果一个提交似乎需要两个业务 scope，优先按 Story 的主要业务责任选择；若包含两个可独立交付的责任，则拆分提交，不创建 `orders-wallet` 一类组合 scope。
- 一个 Story 对应一个独立实现提交，不混入另一个 Story。紧随 feature 产生、且确实修复同一具体功能的修复应在整理历史时折回该 `feat(scope)`；仅 scope 相同、文件相邻或时间接近不足以合并。
- 文档不得夹在代码提交中。必要文档使用独立 `docs(scope): ...` 提交；合同、运行手册和验收证据分别使用清晰 scope。临时计划、对话纪要、重复说明和无长期价值的过程文档不进入历史。
- 不提交 `.env`、Token、Cookie、TOTP、receipt 内容、生产签署、真实账号、数据库 dump、私钥或带个人数据的日志。
- 提交前检查 `git diff --check`、目标测试、生成物一致性和 `git status`。不得改写或删除他人未授权的工作树内容。

## 9. 完成与发布声明

一次 Story/修复的完成汇报必须包含：

- Story/缺陷及关联验收 ID；
- 修改文件与行为变化；
- 本次实际执行的 RED、聚焦测试、回归和门禁结果；
- `outputs/Codex-P0开发TODO.md`、backlog、验收矩阵和证据的同步状态；
- 未执行的真实 Discord、Dashboard、PostgreSQL、Railway、恢复或人工检查；
- 已知风险、外部阻断和 release candidate 绑定状态。

只有同时满足以下条件，才可声明 P0 release ready：

1. 当前候选的自动化 full/release 门禁通过；
2. 验收矩阵不存在 `PENDING_EXTERNAL`、失败或旧候选证据；
3. Discord Guild、Dashboard、Railway/Worker、完整备份恢复等要求均有真实环境证据；
4. 非 example 的生产配置快照、回滚镜像和所需签署齐备；
5. P0 阻断缺陷为零，P1 与 Nice to Have 明确排除。

任何一项缺失，都应明确报告“候选实现/自动化已通过，但外部门禁未完成”，而不是弱化或省略阻断。
