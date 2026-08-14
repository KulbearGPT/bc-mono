# Codex P0 开发 TODO

> 文档状态：执行清单，全部条目初始为计划中。当前仓库包含规格、合同、原型与验收资料，不代表产品代码或任何 P0 功能已完成。只有实际开发、验证和证据齐备后，才可勾选对应条目。

## Codex 使用说明

1. 先读取本清单、主规格、结构化合同和对应验收用例，确认当前 Story 的所有前置依赖已经有可复验的完成证据。
2. 同一时间只选择一个未阻塞 Story；开始时在进度记录中写明负责人、开始时间、依赖证据和预期验证命令，不提前勾选完成。
3. 严格执行验证先行。代码 Story 使用“读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据”；审查、UAT 或发布 Story 使用“读取合同 → 建立未通过门禁基线 → 执行审查与 UAT → 复验门禁 → 更新证据”，不得为非代码工作伪造自动化 RED。
4. 实现过程中只使用 M0 建立并验证过的真实源码路径、脚本和依赖版本；本文件的推荐结构只表达边界，不代替工程事实。
5. 完成前记录实际修改文件、失败测试或未通过门禁基线、通过命令或复验结果、验收用例、运行环境和风险；全部完成定义满足后才把 Story 勾选完成。
6. 若主规格、OpenAPI、Prisma、状态约束、交互映射、支付合同、业务配置或验收用例互相冲突，立即停止当前 Story，记录阻塞并先修正文档合同，不猜测资金、权限或状态机行为。

统一证据根目录为 `evidence/P0/`：每个 Story 使用 `evidence/P0/<STORY-ID>/` 保存测试输出、截图、沙箱记录和验收说明；每个里程碑使用 `evidence/P0/gates/MX.md` 记录启动/完成门禁。`M0-US-01` 必须创建目录约定和索引。Story 责任类型负责整理证据，技术负责人复核 M0–M4 门禁；M5 发布门禁由 delivery lead 组织产品、运营和技术共同签署。

事实来源优先级：主规格当前版 → backlog.csv → openapi.yaml → schema.prisma 与状态约束 → 交互映射.csv → acceptance-cases.csv → 内部钱包、业务配置和路线图专项合同。M7 是获批的后续变更，明确覆盖 M0–M6 中关于 Provider 资金、账户绑定、渠道充值 URL、支付 Webhook 与非 USD 资金的旧描述；结构化合同内的 ID、状态、字段和 operationId 必须保持一致。

## 全局不变量与边界

- Bot 和 Dashboard 统一使用统一业务 API；两者都是交互客户端，不直连数据库，不保存或重复实现最终业务规则、状态迁移、金额判断或授权策略。
- 内部 CAT 钱包账本是客户余额、充值、订单/礼物扣款和业务退款的唯一资金事实来源；P0 不读取或写入 Stripe、PayPal、信用卡等渠道 API。L2+ 在近期 step-up 有效时根据 USD cents receipt 按固定比例登记 CAT 充值；渠道退款在线下完成后，再登记内部 CAT 扣款。
- 除充值付款事实外，系统内金额、价格和阈值固定使用 CAT subunits；充值表单使用 USD cents，陪玩结算同时显示 CAT 与固定换算 USD。ledgerBalanceMinor = CREDIT - DEBIT，availableMinor = ledgerBalanceMinor - reservedMinor，reservedMinor 只能来自有效 FundReservation 合计，客户端不得自行计算最终可用余额。
- FundReservation 必须绑定业务来源、幂等键、版本和生命周期：订单提交或礼物请求时创建，成功结案时捕获，用户取消、30 分钟待派单预留到期、拒绝或失败时释放，5 分钟派单轮次超时保持，争议时保持，部分结案按决议捕获并释放剩余；创建、捕获、释放均由统一 API 原子并发控制。
- 订单只能从 ACCEPTED 在用户与陪玩双方就绪后进入 IN_SERVICE；任何单方 start、绕过 readiness 或提前计费路径都必须拒绝并审计。
- PROMOTER_FIRST_PURCHASE 与 PLAYER_LIFETIME 来源互斥；被推荐用户不得从 API、Discord、错误、通知或导出得知受益人、关系类型、比例、金额或状态。
- 订单事件、WalletEntry、充值/渠道退款证据、消费、退款、预留、陪玩收益、返佣、Adjustment、AuditLog 和 AuditLogChange 只追加，不覆盖原始事实，不硬删除；纠错通过追加 Adjustment、禁用或归档完成。
- 所有 Dashboard、Discord 用户/陪玩、Bot、受控 Webhook 和系统 Job 非只读操作，无论成功、失败或被拒绝都必须审计；成功业务变更与审计头、逐对象明细在同一数据库事务提交。
- 四级权限固定为 L1_SUPPORT < L2_SUPERVISOR < L3_OPERATIONS < L4_ADMIN_OWNER，高级别累积继承低级别全部执行权限。Discord Role 只是映射信号，最终权限受内部批准等级上限约束；降级和撤权立即生效并撤销旧会话。
- Bot 请求必须具有有效服务身份和可验证 Actor Context；客户端提交的 actor ID、staff ID、level 或 Role ID 不能改变授权结果。Dashboard 使用服务端安全会话，敏感动作按合同要求 MFA 与近期 step-up。
- Discord 交互按锁定的 discord.js 版本验证原生组件能力：当前 Modal 可承载受支持的文本和 Select 组件，最多五个顶层组件；P0 为保持级联选择清晰、可恢复，仍在消息组件中逐步完成结构化选择，Modal 主要收集少量自由文本；Select 单次最多 25 个选项；个人余额、订单、返佣、配置与错误信息使用私密频道或 ephemeral 响应；custom_id 只带操作类型与短期会话标识。
- /bot-config 是 Guild 内仅操作者可见的 ephemeral 流程。L3 可读写运营配置；L4 累积继承 L3 并可管理 Role 映射；L3 写 Role 映射必须由 API 返回 403 拒绝。
- /bot-config 的 L3 运营字段包括频道、`staff_notification_role_id`、`operations_notification_role_id`、时限、模板和功能开关；L4 专属安全映射仅包括 `player_role_id` 与 `staff_l1_role_id`、`staff_l2_role_id`、`staff_l3_role_id`、`staff_l4_role_id`。不能把通知 Role 误归为 L4-only。
- /bot-config 使用 Channel Select 和 Role Select，不手工输入频道 ID 或 Role ID。保存前必须验证 Guild 归属、对象类型和 Bot 权限；无效对象不得保存。
- /bot-config 必须先预览，再由 API 签发绑定 actor、Guild、版本、changes 与 reason 的短期 validationToken，最后确认应用；validationToken 缺失、过期或不匹配时拒绝保存。
- /bot-config 成功保存后立即生效，刷新 Guild 缓存，使下一次派单、播报或业务动作使用新配置；重启后从统一 API 重载。
- P1 不纳入 P0；Nice to Have 不纳入 P0。预约、排班、陪玩试音、用户选陪玩或指定陪玩、完整 BI/财务对账导出、多 Server/多租户、额外登录、白标、营销自动化、VIP、优惠券和活动系统均不得混入本清单。
- P0 仅定义计划目标，未通过对应验收与完成门禁前不得对外声称可用、上线或完成。

## 推荐代码仓库结构

以下仅定义模块边界；M0-US-01 建立工程时记录真实路径与命令，之后以实际仓库为准。

~~~text
workspace/
├── apps/
│   ├── api/          # 唯一业务规则、状态机、授权与数据库入口
│   ├── bot/          # Sapphire 交互适配器与统一 API client
│   └── dashboard/    # 运营界面与统一 API client
├── modules/          # 订单、派单、资金、礼物、返佣、收益、权限、审计
├── contracts/        # OpenAPI、事件、配置与 Provider 合同
├── database/         # Prisma、迁移与种子
├── tests/            # 单元、集成、契约、Bot/Dashboard E2E
└── ops/              # Compose、运行手册、备份恢复与可观测性
~~~

客户端目录不得导入数据库访问层或业务域内部实现；共享只能通过版本化合同和统一 API。

## P0 六项核心能力门禁

以下是 P0 产品放行时必须具备的六项核心能力，不是开始 M0 前置条件。PL-01 与 PL-02 主要在 M1 实现，PL-03 至 PL-06 主要在 M2 实现；对应里程碑完成时再勾选。

- [x] PL-01：结构化需求与完整确认。提交前一次展示游戏、服务、区服、时长、标签、备注、价格、可用余额和取消规则，并由 API 在确认时复核。
- [x] PL-02：原子资金预留。统一展示内部账本余额、预留金额和可用余额，订单与礼物并发请求不得超支。
- [x] PL-03：匹配透明与接单结果。展示匹配阶段、已通知候选数和超时下一步；接单后展示陪玩摘要和用户下一步。
- [x] PL-04：陪玩工作台。独立展示客服审核资格、可报名候选池、本人报名、正式订单、需求、倒计时、收益摘要和 API 允许动作；不提供在线/接单开关。
- [x] PL-05：双方就绪再开始。用户与陪玩分别确认，双方都就绪才进入服务中；超时转客服。
- [x] PL-06：取消影响预览。取消或申请客服前展示可自动处理性、预计释放/退款金额、处理方式和时效，执行时由 API 原子重验。

## M0：工程骨架与统一业务边界

### 启动门禁
- [x] 主规格、结构化合同与验收基线已评审；确认当前仅有规格资料，且工程路径、命令和依赖版本将由本里程碑建立。

- [x] **M0-US-01：可复现的本地工程与运行骨架**
  - 前置依赖：none
  - 责任类型：platform_fullstack
  - 实现结果：建立 TypeScript workspace、API/Bot/Dashboard 进程、Docker Compose、环境变量校验、Sapphire Piece 发现和健康/就绪检查。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：getHealth;getReadiness
  - 验收用例：AT-CHN-001;AT-CHN-002
  - 完成定义：smoke/config 测试和启动文档通过；无密钥入库；代码经评审。
  - 禁止扩展：不提供 Kubernetes、自动扩缩容或多 Server 部署。
  - 进度记录（2026-07-17，2026-08-04 补充）：已建立 TypeScript workspace、`apps/api`、`apps/bot`、`apps/dashboard`、`modules/platform`、`.env.example`、`docker-compose.yml`、M0 smoke/config 测试和证据目录；`npm run m0:verify` 14/14 通过，`npm run typecheck` 通过，API `/health` smoke 通过，`/ready` 已改为使用应用角色登录 PostgreSQL 并检查 baseline schema，`npm run pieces -w @blackcat/bot` 可列出 `service-center` Command 与 `ready` Listener；follow-up code review 通过。根 `npm run dev` 曾遗漏异步 Worker，已用失败测试复现并补为 API/Worker/Bot/Dashboard 四进程；Sandbox `P-DBDE4FB0` 的积压派单任务在 Worker 启动后成功消费。证据：`evidence/P0/M0-US-01/summary.md`。

- [x] **M0-US-02：P0 数据库基线与不可变记录约束**
  - 前置依赖：M0-US-01
  - 责任类型：backend_data
  - 实现结果：实现 P0 表、枚举、外键、唯一约束、活跃订单约束、minor units/currency、迁移和种子；预留、收益与返佣调整记录只追加。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：none
  - 验收用例：AT-AUD-003;AT-REC-001;AT-AUD-001
  - 完成定义：空库及前一版本迁移通过；约束集成测试通过；ERD/Schema 与迁移一致。
  - 禁止扩展：不建本地余额账本，不提供财务、审计或订单事件硬删除。
  - 进度记录（2026-07-17）：已建立 `database` workspace、同步 canonical `database/prisma/schema.prisma`、生成完整空库 baseline migration、同步 `database/seed/seed-data.csv`、新增不可硬删除/保护金额字段策略 helper 和 M0-US-02 合同测试；`npm run m0:verify` 14/14 通过，`npm run db:validate` 通过，`npm run typecheck` 通过，`npm audit --audit-level=moderate` 0 漏洞；本机临时 PostgreSQL 空库 apply 通过，生成 47 张表、3 个抽样关键约束和 7 个抽样 guard triggers，并验证 active slot 伪造、无来源预留、缺少服务开始事件、超额结算、非法预留状态迁移、预留部分结算却进入终态、已激活预留直接 FAILED、审计硬删除、金额覆盖、礼物价格覆盖、Guild 配置事件更新权限和 append-only update 均被拒绝；已补充 P0 首批 trigger guard 名称与实现；follow-up code review 通过。证据：`evidence/P0/M0-US-02/summary.md`。

- [x] **M0-US-03：统一鉴权、Actor Context、幂等与审计中间件**
  - 前置依赖：M0-US-01;M0-US-02
  - 责任类型：backend_security
  - 实现结果：实现 Bot 服务 Token、可信 Actor Header、request_id、Idempotency-Key、权限策略入口、拒绝审计和只追加 audit_logs。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：none
  - 验收用例：AT-AUTH-001;AT-RBAC-001;AT-AUD-001
  - 完成定义：鉴权、幂等、越权和审计集成测试通过；日志脱敏；所有写端点接入中间件。
  - 禁止扩展：不在 Bot Precondition 或 React 前端复制最终 RBAC。
  - 进度记录（2026-07-17）：已实现 API 安全中间件、Bot Service Token 校验、可信 Actor Context 解析、累积权限入口、写操作 Idempotency-Key 合同校验、按 client/operation/actor/key 作用域的原子占位与成功/失败重复请求回放、冲突检测、成功/拒绝/失败审计、route 级 before/after snapshot 入口、transactional staged write `commit(successAuditRecord)` contract 和 M0 安全探针路由；`npx vitest run tests/m0-us-03.spec.ts` 15/15 通过，`npm run m0:verify` 29/29 通过，`npm run typecheck`、`npm run db:validate`、`npm run db:verify:migration`、`npm audit --audit-level=moderate` 均通过。证据：`evidence/P0/M0-US-03/summary.md`。首轮 code review 的 Important 项已修复并补充回归；final narrow review 通过，Critical none，Important none。真实 side-effecting write route 必须使用 staged `{ data, commit(successAuditRecord) }` contract。

- [x] **M0-US-04：第三方资金适配契约与可控 Mock**
  - 前置依赖：M0-US-02;M0-US-03
  - 责任类型：integration_backend
  - 实现结果：实现 adapter-contract.yaml 的 11 个标准操作：discoverCapabilities、resolveUser、getWalletBalance、createReservation、getReservation、captureReservation、releaseReservation、appendWalletDebit、creditBusinessRefund、getWalletEntry、verifySystemEvent；提供可编程 Mock、稳定幂等键和外部交易镜像。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：handleSystemWebhook
  - 验收用例：AT-WHK-001;AT-REC-001;AT-REC-003
  - 完成定义：11 操作契约测试及全部结果分支通过；能力探测、UNKNOWN 恢复、验签与重放测试通过；凭证仅由 Secret 注入。
  - 禁止扩展：不保留任何旧接口别名；不实现充值页或本地余额。
  - 进度记录（2026-07-17）：已实现 `@blackcat/api/payment-adapter` in-memory mock facade，覆盖 `discoverCapabilities`、`resolveUser`、`getWalletBalance`、`createReservation`、`getReservation`、`captureReservation`、`releaseReservation`、`appendWalletDebit`、`creditBusinessRefund`、`getWalletEntry`、`verifySystemEvent` 11 个操作；支持 native/fallback capability profile、providerBalance-only 响应、stable idempotency replay/conflict、hold TTL gate、timeout-after-commit recovery、partial capture/release、native hold capture transaction mirror/refund、modeled reservation binding/version 校验、money/date runtime invariant、insufficient funds、refund cap、webhook signature/timestamp/schema/replay/dedup；`npx vitest run tests/m0-us-04.spec.ts` 9/9 通过，`npm run m0:verify` 38/38 通过，`npm run typecheck`、`npm run db:validate`、`npm run db:verify:migration`、`npm audit --audit-level=moderate` 均通过。证据：`evidence/P0/M0-US-04/summary.md`。首轮 code review 的 Critical/Important 项已修复并补充回归；follow-up code review 通过，Critical none，Important none。

- [x] **M0-US-05：Outbox/Job 运行器与结构化可观测性**
  - 前置依赖：M0-US-02;M0-US-03
  - 责任类型：backend_platform
  - 实现结果：实现数据库 Outbox 领取、锁、退避、失败状态、授权手工重试、结构化日志和核心指标钩子。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：retryJob
  - 验收用例：AT-CHN-003;AT-AUD-003
  - 完成定义：并发领取、退避、失败和恢复测试通过；失败 Job 可受权重试并留审计。
  - 禁止扩展：不引入 Redis/BullMQ，不承诺无限重试或复杂 SLA。
  - 进度记录（2026-07-17）：已实现 `@blackcat/api/outbox` 的 Outbox store/runner contract、in-memory store、PostgreSQL `outbox_events` claim/lock 合同（`FOR UPDATE SKIP LOCKED`）、SQL 层 delivery/system job type allowlist、stale `PROCESSING` recovery、delivery/system job type validation、worker lock claim、attempt/version 增量、按失败时间 backoff、terminal failed、`PROCESSING/COMPLETED` 状态统一、success completion、`request_id` structured logs、metrics hooks 和 `retryJob` 授权手工重试审计；`retryJob` 保留 failed job 上下文并在审计 before/after snapshot 中记录 attempts/lastError/runAfter/version；`job.read/job.retry` 已进入统一权限矩阵并与 OpenAPI L2 要求对齐；OpenAPI JobStatus 已与 Prisma 对齐；PostgreSQL enum 参数 cast 已补合同测试；`npx vitest run tests/m0-us-05.spec.ts` 9/9 通过，`npm run m0:verify` 49/49 通过，`npm run typecheck`、`npm run db:validate`、`npm run db:verify:migration`、`npm audit --audit-level=moderate` 均通过；final narrow code review 返回 Critical none、Important none、Minor none、gate-ready。证据：`evidence/P0/M0-US-05/summary.md`。

### 完成门禁
- [x] 五个 M0 Story 的完成定义全部满足；本地启动、健康/就绪、鉴权、Provider Mock、迁移和 Job 恢复证据可复验。证据：`evidence/P0/gates/M0.md`。

## M1：目录、账户与即时订单入口

### 启动门禁
- [x] M0 完成门禁已有证据；统一 API、数据约束、鉴权、Provider Mock 与 Outbox 可用于实现用户入口。证据：`evidence/P0/gates/M0.md`。

- [x] **M1-US-01：版本化服务目录与双价格快照**
  - 前置依赖：M0-US-02;M0-US-03
  - 责任类型：backend_api
  - 实现结果：实现启用服务查询、后台版本 API、计价单位、最低数量、客户单价、陪玩结算单价、币种和上下架约束。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：listServices;createServiceCatalogVersion;updateServiceCatalogVersion;estimateService
  - 验收用例：AT-CAT-001;AT-CAT-002
  - 完成定义：单元、数据库集成和 API 契约测试通过；OpenAPI operationId 一致。
  - 禁止扩展：不做阶梯价、活动价、优惠券或动态定价。
  - 进度记录（2026-07-17）：已完成 `@blackcat/api/catalog` domain contract、in-memory store、PostgreSQL store、统一 API route contract 和运行入口挂载；覆盖 `listServices`、`estimateService`、`listServiceCatalogVersions`、`createServiceCatalogVersion`、`updateServiceCatalogVersion`。用户端仅返回 ACTIVE 且双价格完整目录，不泄露陪玩价/陪玩收益；后台 L2 可读、L3+ 可创建/更新；启用必须客户价和陪玩价完整且币种一致；`SUPERSEDE` 创建新版本并 retire 旧版本，不覆盖旧价格快照；写操作采用 staged commit，PostgreSQL 使用 dedicated pooled transaction client 同事务写目录记录和 `audit_logs`；`PostgresStaffDirectory` 解析 Discord 绑定员工；非 staff Discord actor idempotency scope 按 guild/user 隔离；OpenAPI 指定 path/method 的 operationId 已测试一致。`npx vitest run tests/m1-us-01.spec.ts tests/m1-us-01-api.spec.ts tests/m1-us-01-db.spec.ts` 20/20 通过，`npm test` 69/69 通过，`npm run typecheck`、`npm run db:validate`、`npm run db:verify:migration` 均通过。Final focused code review：Critical none，Important none，Ready to merge。证据：`evidence/P0/M1-US-01/summary.md`。

- [x] **M1-US-02：一次性绑定与实时账户摘要**
  - 前置依赖：M0-US-03;M0-US-04
  - 责任类型：backend_api
  - 实现结果：实现绑定码验证、Discord/第三方账号唯一映射、个人摘要和余额查询；保存映射而非第三方密码。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：createBinding;getCurrentUser;getCurrentBalance
  - 验收用例：AT-ACC-001;AT-ACC-002;AT-RES-002
  - 完成定义：Provider 契约、归属和隐私测试通过；绑定码及敏感响应不入日志。
  - 禁止扩展：不保存第三方密码，不提供自助解绑或多账号切换。
  - 进度记录（2026-07-17）：已完成 `@blackcat/api/accounts` domain contract、in-memory store、PostgreSQL store、统一 API route contract 和运行入口挂载；覆盖 `createBinding`、`getCurrentUser`、`getCurrentBalance`。绑定仅接受 Discord Bot 来源和一次性绑定码 `ONE_TIME_CODE`，拒绝稳定 `EXTERNAL_USER_ID`，绑定响应、审计记录和幂等 fingerprint 不包含原始绑定码；Discord 账号和第三方外部账号均有冲突检测，提交阶段并发唯一性冲突映射为 `BINDING_CONFLICT`/409；in-memory 和 PostgreSQL store 均支持绑定与成功审计事务性提交，提交失败或后续唯一性失败会回滚部分记录；`getCurrentUser` 仅返回本人账户摘要且不泄露原始 provider external user id；`getCurrentBalance` 每次从 Provider 查询真实余额并由 API 派生 `availableMinor = ledgerBalanceMinor - reservedMinor`，`reservedMinor` 只统计 active reservation statuses；OpenAPI path/method operationId 与实现一致，绑定输入枚举已收窄为 `ONE_TIME_CODE`，account runtime error codes 已补入全局错误枚举。`npx vitest run tests/m1-us-02-api.spec.ts` 11/11 通过，`npx vitest run tests/m1-us-02-db.spec.ts` 4/4 通过，`npm test` 84/84 通过，`npm run typecheck`、`npm run db:validate`、`npm run db:verify:migration` 均通过。Focused code review：Critical none；Important 项已修复并补回归。证据：`evidence/P0/M1-US-02/summary.md`。

- [x] **M1-US-03：即时订单草稿与服务端估价**
  - 前置依赖：M1-US-01;M1-US-02
  - 责任类型：backend_api
  - 实现结果：实现创建/读取/更新草稿、单活跃订单限制、字段校验、目录版本引用、数量和金额计算、订单版本并发控制。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：createOrder;getOrder;updateOrder;estimateOrder
  - 验收用例：AT-ORD-001;AT-ORD-002
  - 完成定义：状态机、计价、约束和 API 测试通过；订单事件只追加。
  - 禁止扩展：不支持预约、多人订单、多个活跃订单或客户端自报价格。
  - 进度记录（2026-07-17）：已完成 `@blackcat/api/orders` domain contract、in-memory store、PostgreSQL store、统一 API route contract 和运行入口挂载；覆盖 `createOrder`、`getOrder`、`updateOrder`、`estimateOrder`。`createOrder` 只允许已绑定用户创建即时草稿，单客户仅一个活跃订单，新草稿返回 `201`，已有活跃订单返回 `200` 且不新增事件；`updateOrder` 仅订单所有者、`DRAFT` 状态和匹配 `expectedVersion` 可执行，服务端从 ACTIVE 服务目录快照目录版本、游戏/服务/区服、计价单位、客户价、陪玩结算价并计算 minor-unit 金额，客户端不能自报价格；`estimateOrder` 不改版本、不写事件且不返回 `playerEarningMinor`；订单创建和更新均写 append-only order event 并与 audit 同事务提交。数据库 migration 已收窄 `protect_amount_minor_update()`：普通订单金额覆写仍被 `db:verify:migration` 证明拒绝，只有 API 事务内 `DRAFT -> DRAFT` 并设置 `app.order_draft_amount_update=approved` 才允许草稿估价快照更新。`npx vitest run tests/m1-us-03-api.spec.ts tests/m1-us-03-db.spec.ts` 10/10 通过，`npm test` 94/94 通过，`npm run typecheck`、`npm run db:validate`、`npm run db:verify:migration` 均通过。证据：`evidence/P0/M1-US-03/summary.md`。

- [x] **M1-US-04：Sapphire 公共入口、私密频道与常驻面板**
  - 前置依赖：M1-US-02;M1-US-03
  - 责任类型：discord_bot
  - 实现结果：实现固定公共入口、绑定 Modal、消息组件完成结构化选择、补充备注 Modal、订单频道创建/补偿、权限覆盖、面板渲染和更新、custom_id 路由及重复交互处理。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：createBinding;createOrder;getOrder;updateOrder
  - 验收用例：AT-CHN-001;AT-ORD-003;AT-UI-001;AT-UI-002;AT-UI-003
  - 完成定义：InteractionHandler、组件约束、权限渲染和 API 错误映射测试通过；测试 Server E2E 留证。
  - 禁止扩展：不把价格、状态机、资金或最终权限规则写入 Sapphire Piece；不在打开的 Modal 内实现级联选择。
  - 进度记录（2026-07-17）：已完成 `@blackcat/bot/service-center`、`HttpBotApiClient`、Discord UI spec renderer、`/service-center` 公共入口回复、`service-center-buttons` / `order-selects` / `service-center-modals` 三个 Sapphire interaction-handler piece。覆盖公共入口只展示 `创建订单` 和 `我的服务中心` 且不公开余额；绑定 Modal 单个一次性绑定码 Text Input；备注 Modal 单个可选 Text Input 并携带订单版本；私密频道权限计划拒绝 `@everyone`，允许客户/Bot/客服 role，陪玩接单前不可见；订单面板用消息 String Select 完成游戏/服务/区服/时长选择，不在打开的 Modal 内级联，不泄露陪玩结算或余额；custom_id parser 只承载安全路由元数据；Bot flow 只通过统一 API client 调用 `createBinding`、`createOrder`、`getOrder`、`updateOrder`，并携带 Bot token、Discord Actor Context、interaction id 和 idempotency key。`npx vitest run tests/m1-us-04-bot.spec.ts` 15/15 通过，`npm run typecheck -w @blackcat/bot`、`npm run typecheck`、`npm run pieces -w @blackcat/bot`、`npm test` 109/109 通过。Discord credential 暂未提供，真实测试 Server E2E 未执行；AT-ORD-003 的完整资金预留重复提交仍属于 M1-US-05 `submitOrder` API。证据：`evidence/P0/M1-US-04/summary.md`。

- [x] **M1-US-05：订单提交与资金预留**
  - 前置依赖：M0-US-04;M1-US-03;M0-US-05
  - 责任类型：backend_api
  - 实现结果：提交时复核价格和 内部账本余额，创建 provider hold-backed 订单 FundReservation，并迁移到 PENDING_DISPATCH；提交阶段不创建消费或 debit external transaction，Provider hold ref 通过 FundReservation 与审计追踪，异常分支释放 hold 或返回可恢复 Provider timeout。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：submitOrder;handleSystemWebhook
  - 验收用例：AT-RES-001;AT-REC-002;AT-ORD-004
  - 完成定义：Provider Mock 全分支、数据库事务和 API 集成测试通过；审计可追溯 reservation 与 external_ref。
  - 禁止扩展：不直接在提交时完成消费；不建可手工编辑 pending 字段。
  - 进度记录（2026-07-17）：已完成 `submitOrder` API、in-memory/Postgres order store 提交事务、Provider hold 预留、timeout-after-commit `getReservation(IDEMPOTENCY_KEY)` 恢复、stable reservation id、目录快照复核、Postgres commit-time `user_currency_locks` 锁与 active reservations 重算、Postgres commit-time 目录快照锁读复核、commit 失败后的 `releaseReservation` 补偿、`SUBMITTED` event next sequence、成功审计 before/after snapshot、以及 `handleSystemWebhook` raw octet/json 验签与进程内 event id 去重。提交响应符合 `OrderReservationEnvelope`，不返回订单内部对象、FundReservation 详情或交易列表；提交阶段不创建 debit/consumption。`npx vitest run tests/m1-us-05-api.spec.ts tests/m1-us-05-db.spec.ts tests/m1-us-05-webhook.spec.ts` 17/17 通过，`npm test` 126/126 通过，`npm run typecheck`、`npm run db:validate`、`npm run db:verify:migration` 均通过。证据：`evidence/P0/M1-US-05/summary.md`。Webhook 当前仅验签、拒绝重放、去重和 acknowledgement，真实业务应用与持久 webhook 去重留给后续扣款/退款 Story。

- [x] **M1-US-06：私密个人服务中心**
  - 前置依赖：M1-US-02;M1-US-03;M1-US-04
  - 责任类型：fullstack_bot_api
  - 实现结果：实现服务中心 API 聚合与 Sapphire ephemeral 视图；消费和返佣在 M3 前可返回结构稳定空列表。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：getCurrentUser;getCurrentBalance;listCurrentUserConsumptions;listCurrentUserCommissions
  - 验收用例：AT-ACC-004
  - 完成定义：API 契约、归属、空/错/加载状态和 Discord 手工验收通过。
  - 禁止扩展：不做公开主页、完整 BI 或余额缓存账本。
  - 进度记录（2026-07-17）：已完成 `/api/v1/me/consumptions` 与 `/api/v1/me/commissions` current-user 安全读路由、`consumption.self.read` / `commission.self.read` 自读权限、M3 前结构稳定空消费列表与本人收益零值 summary、Bot API client 对 `/me`、`/me/balance`、`/me/consumptions`、`/me/commissions` 的复用调用、`buildServiceCenterMessage` ephemeral 面板、活跃订单 `getOrder` 跳转摘要、以及 `service-center-buttons` 对“我的服务中心”按钮的 API-backed flow wiring。面板展示 internal ledger balance/reserved/available/currency/calculatedAt，不公开 external user id、source customer、beneficiary id、rate bps 或 referral attribution。`npx vitest run tests/m1-us-06-api.spec.ts tests/m1-us-06-bot.spec.ts` 8/8 通过，`npm run typecheck` 与 `npm test` 18 files / 134 tests 通过。证据：`evidence/P0/M1-US-06/summary.md`。Discord credential 暂未提供，真实测试 Server 手工 E2E 未执行。

- [x] **M1-US-07：结构化需求与一次完整确认**
  - 前置依赖：M1-US-03;M1-US-06
  - 责任类型：fullstack_bot_api
  - 实现结果：确认面板固定展示 game、service、region、duration、tags、notes、price、available balance、cancellation rule；数据来自 estimateOrder/getCurrentBalance。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：estimateOrder;getCurrentBalance
  - 验收用例：AT-PL-001;AT-ORD-002
  - 完成定义：API schema、Bot 渲染、缺失/陈旧/余额失败分支和 E2E 通过。
  - 禁止扩展：不增加预约字段、陪玩试音或用户选陪玩。
  - 进度记录（2026-07-17）：已完成 `OrderEstimateSummary`、`HttpBotApiClient.estimateOrder`、`buildOrderConfirmationMessage`、`handleOpenOrderConfirmation`、`bc:order:{orderId}:submit:v{version}` 安全 custom_id route，以及 `service-center-buttons` 对确认按钮的 API-backed flow wiring。确认面板固定展示游戏、服务、区服、时长、标签、备注、`estimateOrder` 金额、`getCurrentBalance` 可用余额、取消规则和价格有效期；Bot 不使用 draft `amountMinor` 自行定价，也不展示 `playerEarning`、`playerPayout` 或陪玩结算价。余额不足时禁用最终确认并显示差额/充值入口；`CONFLICT` 陈旧版本刷新草稿面板并附 request_id。`npx vitest run tests/m1-us-07-bot.spec.ts` 7/7 通过，`npx vitest run tests/m1-us-04-bot.spec.ts tests/m1-us-06-bot.spec.ts tests/m1-us-07-bot.spec.ts tests/m1-us-03-api.spec.ts` 34/34 通过，`npm run typecheck` 与 `npm test` 19 files / 141 tests 通过。证据：`evidence/P0/M1-US-07/summary.md`。Discord credential 暂未提供，真实测试 Server 手工 E2E 未执行；`submit-final` 最终预留动作留给后续资金/并发 Story 接入。

- [x] **M1-US-08：资金预留模型与并发控制**
  - 前置依赖：M0-US-02;M0-US-04;M1-US-05
  - 责任类型：backend_payment_data
  - 实现结果：统一 availableMinor=ledgerBalanceMinor-reservedMinor；预留绑定 source/idempotency/version/lifecycle；API 原子创建、捕获和释放并优先使用 Provider hold 能力。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：getCurrentBalance;submitOrder;cancelOrder
  - 验收用例：AT-RES-001;AT-RES-002;AT-RES-003
  - 完成定义：数据库并发、Provider capability、幂等、版本冲突及恢复测试通过；统一资金服务被订单和礼物复用。
  - 禁止扩展：不提供手工编辑预留金额或客户端余额计算。
  - 进度记录（2026-07-17）：已完成订单侧 active FundReservation 对 `getCurrentBalance` 的实时影响、Provider native hold 优先与 `LOCAL_RESERVATION_FALLBACK`、pre-capture `cancelOrder` 释放预留、in-memory/Postgres cancel commit、`order.cancel` 权限、可复用 `@blackcat/api/funding` helper（同一草稿构造支持 ORDER/GIFT source）、Bot `submit-final` 最终提交 flow、`buildSubmittedOrderMessage`、以及 `HttpBotApiClient.submitOrder/cancelOrder`。`npx vitest run tests/m1-us-08-funding-service.spec.ts tests/m1-us-08-api.spec.ts tests/m1-us-08-bot.spec.ts` 9/9 通过，`npm run typecheck` 与 `npm test` 22 files / 150 tests 通过。证据：`evidence/P0/M1-US-08/summary.md`。PL-02 中礼物侧实际请求、审批、捕获和释放仍由 M3-US-01/M3-US-02/M3-US-03/M3-US-06 完成，本 Story 不提前声称礼物功能完成。

### 完成门禁
- [x] 八个 M1 Story 的完成定义全部满足；PL-01、即时订单提交/订单侧预留入口通过关联验收。PL-02 的礼物侧并发预留仍按 M3 礼物 Story 完成，不阻塞 M2 陪玩准入与派单开发。

## M2：陪玩准入、透明派单与订单闭环

### 启动门禁
- [x] M1 完成门禁已有证据；即时订单可提交并建立订单侧原子预留，候选筛选、派单和订单状态合同无冲突。礼物侧资金预留仍留在 M3。

- [x] **M2-US-01：陪玩准入、标签、Presence 与员工控制接单资格**
  - 前置依赖：M0-US-03;M1-US-03
  - 责任类型：backend_bot
  - 实现结果：实现 player_profile 审核、游戏/服务标签、Discord Presence 非授权观测和员工控制的 ACTIVE/PAUSED/SUSPENDED 候选池资格。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：approvePlayer;syncDiscordPresence;setPlayerOperationalStatus;updatePlayerOperationalTags
  - 验收用例：AT-DSP-001;AT-ROL-001
  - 完成定义：候选筛选、Role/Presence Listener 和权限测试通过。
  - 禁止扩展：不做排班、自动技能评分或跨 Server Presence。
  - 历史记录（2026-07-17）：早期实现过 AVAILABLE/BUSY 写入与直接派单候选逻辑；M11 候选池合同后已退役陪玩本人写路由和所有 Bot 交互，Presence 与 legacy availability 只供诊断，不影响报名。现行证据：`tests/m2-us-01-api.spec.ts`、`tests/m11-us-02-selection-pools-api.spec.ts` 和 `tests/m11-us-03-selection-discord.spec.ts`。
  - 回归记录（2026-08-03）：修复 Presence 事件标识超过审计 `interaction_id` 32 字符合同、同毫秒事件共享幂等键的问题。每次监听器回调改用独立的 32 字符 source event id，`observedAt` 继续保存实际观察时间。`npx vitest run tests/m2-us-01-bot.spec.ts tests/m2-us-01-api.spec.ts tests/m2-us-01-db.spec.ts` 3 files / 15 tests 通过，`npm run typecheck` 通过，并通过本地统一 API + Postgres 实测完成 Presence 同步及审计写入。

- [x] **M2-US-02：自动派单候选与集中派单卡片**
  - 前置依赖：M0-US-05;M1-US-05;M2-US-01
  - 责任类型：backend_bot
  - 实现结果：消费 OrderSubmitted，生成候选快照和 dispatch_attempt，经 Outbox 发布卡片并设置超时。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：dispatchOrder;getOrder;acceptOrder;declineOrderOffer
  - 验收用例：AT-DSP-001;AT-DSP-002
  - 完成定义：候选、Outbox、超时 Job、Discord 渲染和重放测试通过。
  - 禁止扩展：不自动扩圈、候补或实现复杂排序算法。
  - 进度记录（2026-07-17）：已完成 `@blackcat/api/dispatch`、`dispatchOrder`、`expireDispatchAttempt`、`InMemoryDispatchStore`、`PostgresDispatchStore`、`InMemoryDispatchPlayerPool`、`PostgresDispatchPlayerPool`、`buildApiServer({ dispatch })` 和 runtime dispatch wiring。系统任务可通过统一 API 创建 `dispatch_attempts`、`dispatch_candidates`、`DISPATCH_MESSAGE` 与 `DISPATCH_TIMEOUT` outbox；5 分钟超时只结束当前轮次并保持订单 `PENDING_DISPATCH`，不释放预留、不自动扩圈。Bot 侧已新增集中派单卡片 renderer、accept/decline API client 与 Sapphire `dispatch-buttons` handler。`npx vitest run tests/m2-us-02-api.spec.ts tests/m2-us-02-bot.spec.ts tests/m2-us-02-db.spec.ts` 3 files / 9 tests 通过，`npm run typecheck` 通过，`npm test` 28 files / 171 tests 通过。证据：`evidence/P0/M2-US-02/summary.md`。Discord credential 暂未提供，真实集中派单频道 E2E 未执行；唯一接单和频道入场留给 M2-US-03。
  - 派单卡信息增强（2026-08-04）：Worker 实际 Discord REST 投递已从三行纯文本改为详细 embed，分区展示游戏、服务、区服、时长、预计收益、语音频道、备注与 Discord 本地化绝对/相对截止时间；多项目派单优先使用需求目录展示名，不再暴露 `VALORANT · FUN` 等内部代码。无候选轮次保留只读状态 embed 并清除旧按钮。RED 2 failed / 8 passed；GREEN 目标 2 files / 15 tests、派单关联 7 files / 36 tests、typecheck 与全仓 182 files / 901 tests 通过。证据：`evidence/P0/M2-US-02/summary.md`。真实 Guild 视觉与按钮 UAT 仍待复验。
  - 集中频道按钮收敛（2026-08-04）：广播式派单卡只保留“接单”，移除“无法接单”；私密陪玩工作台仍保留“暂不接单”及 `declineOrderOffer`。RED 1 failed / 9 passed；GREEN 4 files / 20 tests 及 typecheck 通过。全仓 build 通过，剩余 8 项失败属未提交的 M10 服务套餐改动，详见证据。
  - 派单收益信息收敛（2026-08-09）：公开数字 Reaction 报名卡、Worker Discord 派单 embed 与 Bot 私密派单卡均移除预计收益展示；收益计算和结算事实不变。RED 3 files / 3 failed、14 passed；GREEN 3 files / 17 tests、关联 10 files / 87 tests、typecheck 与全仓 247 files / 1236 tests 通过。证据：`evidence/P0/M2-US-02/summary.md`。

- [x] **M2-US-03：并发唯一接单与订单频道入场**
  - 前置依赖：M2-US-02
  - 责任类型：backend_bot
  - 实现结果：实现条件更新接单、活跃订单约束、订单/attempt 原子写、OrderAccepted Outbox、频道权限添加和按钮失效。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：acceptOrder;getOrder
  - 验收用例：AT-DSP-003;AT-DSP-004
  - 完成定义：数据库并发、API 集成和 Discord E2E 通过。
  - 禁止扩展：不支持一单多陪玩或绕过活跃订单约束。
  - 进度记录（2026-07-17）：已完成 `acceptOrder`、`declineOrderOffer`、`POST /api/v1/orders/:orderId/accept`、`POST /api/v1/orders/:orderId/decline`、in-memory 和 Postgres 接单/拒单事务、OrderAccepted `PANEL_SYNC` outbox、接单后私密订单频道权限计划和集中派单卡片按钮失效。Postgres 并发测试覆盖两个候选同时接同一 active attempt 只允许一个成功，失败方冲突，未接中候选标记 `LOST_RACE`；陪玩已有活跃单时返回 `PLAYER_NOT_ELIGIBLE` 且订单保持 `PENDING_DISPATCH`；拒单只标记本人候选为 `DECLINED`。`npx vitest run tests/m2-us-03-api.spec.ts tests/m2-us-03-bot.spec.ts tests/m2-us-03-db.spec.ts` 3 files / 9 tests 通过，`npm run typecheck` 通过，`npm test` 31 files / 180 tests 通过。证据：`evidence/P0/M2-US-03/summary.md`。Discord credential 暂未提供，真实测试 Guild 中接单按钮、频道权限修改和集中派单消息修改 E2E 未执行。
  - 退役记录（2026-08-06）：移除应用层可调用的 availability 存储写方法，旧 URL 继续返回 404 且零写入；资格失败反馈改为客服审核状态、Guild 与标签语义，不再将 Presence 或 legacy availability 说成陪玩开关。

- [x] **M2-US-04：双方准备、申请完成与用户确认**
  - 前置依赖：M2-US-03;M0-US-05
  - 责任类型：fullstack_bot_api
  - 实现结果：实现双方 READY、ACCEPTED→IN_SERVICE、申请完成、用户确认、Actor 归属、时间戳、面板动作和确认超时任务；旧 start 调用必须拒绝并审计。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：setOrderReadiness;requestOrderCompletion;confirmOrder
  - 验收用例：AT-RDY-001;AT-SVC-001;AT-SVC-002
  - 完成定义：状态机、readiness、超时 Job 和双方 Discord E2E 通过。
  - 禁止扩展：不做单方开始、自动确认、评价、加时或按分钟自动计时。
  - 进度记录（2026-07-17）：已完成 `setOrderReadiness`、`requestOrderCompletion`、`confirmOrder`、`expireOrderCompletionConfirmation`、`rejectLegacyStartService`，以及 `PUT /api/v1/orders/:orderId/readiness`、`POST /api/v1/orders/:orderId/request-completion`、`POST /api/v1/orders/:orderId/confirm`、`POST /api/v1/orders/:orderId/start`。Postgres 事务覆盖双方 READY 后才从 `ACCEPTED` 进入 `IN_SERVICE`，陪玩申请完成后进入 `PENDING_CONFIRMATION`，用户确认完成时原子捕获订单预留、生成 `ORDER_CHARGE` 消费、PENDING 陪玩收益和符合条件的 PENDING 返佣；完成确认超时只创建唯一 `COMPLETION_REVIEW` 客服任务且不结算；旧单方 start 调用固定 403 并审计。Bot 侧已接入 `bc:service:ready/request-completion/confirm` 自定义 ID、HTTP API client 和 Sapphire Button Handler。`npx vitest run tests/m2-us-04-api.spec.ts tests/m2-us-04-bot.spec.ts tests/m2-us-04-db.spec.ts` 3 files / 18 tests 通过，`npm run typecheck`、`npm run db:validate`、`npm run db:verify:migration` 通过，`npm test` 34 files / 198 tests 通过。证据：`evidence/P0/M2-US-04/summary.md`。Discord credential 暂未提供，真实测试 Guild 中双方点击与消息更新 E2E 未执行。
  - 缺陷回归（2026-08-03）：readiness timeout 推进版本后，客户与陪玩旧按钮均因 stale version 失败；Bot 现自动读取最新订单并在仍为 `ACCEPTED` 时安全重试一次。Bot 回归 11/11、typecheck、build 通过，待双方重新点击完成真实 E2E。
  - 完成面板回归（2026-08-03）：`request-completion` 状态迁移现于同一事务投递 `PANEL_SYNC`，Worker 更新订单原消息时显式清空旧 embeds。目标回归 3 files / 30 tests、typecheck、build 通过；真实订单 `P-374DF0C3` 已恢复为 `PENDING_CONFIRMATION` v10 面板并展示“确认完成”。
  - 结单面板回归（2026-08-03）：客户确认结算现于同一事务投递 `ORDER_COMPLETED_CHANNEL_SYNC`；真实订单 `P-374DF0C3` 已恢复为 `COMPLETED` v11，旧 embed 清空且只保留“联系客服”。目标回归 3 files / 31 tests、typecheck、build 通过。
  - 越权按钮反馈（2026-08-04）：业务 API 继续以 Actor Context 拒绝错误角色；Bot 现将 `PERMISSION_DENIED` 翻译为私密说明。陪玩点击“确认完成”会明确得知该按钮仅供客人使用，客人点击“申请完成”会明确得知该按钮仅供陪玩使用。RED 2 failed / 11 passed；GREEN 2 files / 23 tests 及 typecheck 通过。

- [x] **M2-US-05：默认自动取消与异常客服任务**
  - 前置依赖：M1-US-05;M2-US-03;M2-US-04;M0-US-05
  - 责任类型：backend_api
  - 实现结果：实现 DRAFT 取消、待派单释放预留、已接单 CANCELLATION_ASSIST，以及迟到、缺席、中断、完成超时任务和风险事件。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：cancelOrder;createOrderStaffTask;handleSystemWebhook
  - 验收用例：AT-CAN-001;AT-CAN-004;AT-SUP-001
  - 完成定义：取消、预留释放、退款、超时、风险和幂等集成测试通过；Bot 显示客服接管状态。
  - 禁止扩展：不自动裁决爽约、争议或服务中断，不自动扣罚陪玩。
  - 进度记录（2026-07-17）：已完成已接单/服务中/待确认订单取消转 `CANCELLATION_ASSIST` 客服任务，保持订单状态与 active reservation，不显示已取消、不释放预留、不退款；`createOrderStaffTask` 支持 `PLAYER_START_LATE`、`PLAYER_NO_SHOW`、`CUSTOMER_NO_SHOW`、`SERVICE_INTERRUPTED` 等异常任务类型并对相同 order/type/reason 返回唯一 active 任务；新增 `risk-events` API 模块、`POST /api/v1/admin/users/:userId/risk-events`、`user.risk.manage` L2+ 权限、in-memory/Postgres risk event store 和 runtime wiring，风险事件只追加且不改变用户状态；Bot 新增取消结果和 `EXCEPTION`/staffTaskId 客服接管状态渲染，明确不会自动取消、退款或扣罚。`npx vitest run tests/m2-us-05-api.spec.ts tests/m2-us-05-bot.spec.ts tests/m2-us-05-db.spec.ts tests/m2-us-04-bot.spec.ts` 4 files / 18 tests 通过，`npm run typecheck`、`npm run db:validate`、`npm run db:verify:migration` 通过，`npm test` 37 files / 210 tests 通过。证据：`evidence/P0/M2-US-05/summary.md`。Discord credential 暂未提供，真实测试 Guild 中取消按钮、客服接管面板和异常任务消息 E2E 未执行。

- [x] **M2-US-06：人工退款、结案与转派的原子用例**
  - 前置依赖：M0-US-03;M0-US-04;M2-US-05
  - 责任类型：backend_security
  - 实现结果：实现 refundOrder/resolveOrder/reassignOrder、reason/evidence、金额等级路由、Provider 退款、resolution、Adjustment、风险和不可篡改审计事务。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：refundOrder;resolveOrder;reassignOrder
  - 验收用例：AT-CAN-006;AT-CAN-009;AT-RBAC-004
  - 完成定义：等级边界、同人发起并执行、原因、step-up/MFA、Provider 失败、Adjustment 和事务回滚测试通过。
  - 禁止扩展：不硬删除、强制改状态或自动争议裁决。
  - 进度记录（2026-07-17）：已完成 `refundOrder`、`resolveOrder`、`reassignOrder`、L2/L3/L4 金额路由、同人直执、fail-closed step-up、Provider UNKNOWN 恢复、提交失败同幂等键恢复、售后只追加冲正、原子 resolution/Adjustment/风险/审计事务，以及 active/disputed FundReservation 的部分捕获和剩余释放。转派仅允许 ACCEPTED/EXCEPTION，并复核审核、可接单、Presence、游戏/服务标签和单活跃订单；IN_SERVICE 直接转派返回 422。`npm test` 39 files / 234 tests 通过，`npm run typecheck`、`npm run db:validate`、`npm run db:verify:migration` 均通过。证据：`evidence/P0/M2-US-06/summary.md`。Dashboard 正式会话、持久安全存储和 MFA 会话由 M4 完成；真实 Discord Guild/Provider 沙箱 E2E 待凭据。

- [x] **M2-US-07：用户侧匹配进度透明**
  - 前置依赖：M2-US-02;M2-US-03
  - 责任类型：fullstack_bot_api
  - 实现结果：提供匹配进度读模型：stage、notifiedCandidateCount、timeoutAt、nextStep；接单后显示陪玩摘要和用户下一动作。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：getOrder;acceptOrder
  - 验收用例：AT-MAT-001;AT-DSP-004
  - 完成定义：读模型、隐私、超时和 Bot 状态渲染测试通过。
  - 禁止扩展：不展示候选名单、排序分或复杂推荐理由。
  - 进度记录（2026-07-17）：`getOrder` 已返回 `stage`、`notifiedCandidateCount`、`timeoutAt`、`nextStep` 和接单后唯一陪玩摘要；Postgres 只聚合最新派单轮次，不向用户返回候选名单或评分。Discord 普通订单面板在 PENDING_DISPATCH/ACCEPTED 自动切换匹配进度视图。Story 测试 3 files / 7 tests、全量回归 42 files / 241 tests 及类型检查通过。证据：`evidence/P0/M2-US-07/summary.md`。真实 Discord Guild E2E 待凭据。

- [x] **M2-US-08：完整陪玩工作台**
  - 前置依赖：M2-US-01;M2-US-02;M2-US-03
  - 责任类型：fullstack_bot_api
  - 实现结果：聚合 qualification、selectionPools、applications、currentOrder、requirements、countdown、earningsSummary 和 allowedActions；Bot 仅渲染，Presence/legacy availability 只是诊断字段。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：getPlayerWorkbench;applyToOrderSelectionPool;withdrawOrderSelectionApplication
  - 验收用例：AT-WRK-001;AT-EAR-001
  - 完成定义：工作台聚合、权限、加载/空/错/陈旧状态和 Discord E2E 通过。
  - 禁止扩展：不做陪玩公开档案、试音材料、排班或用户挑选。
  - 现行记录（2026-08-06）：`getPlayerWorkbench` 已聚合客服审核准入、可报名候选池、本人报名、正式订单、脱敏需求、倒计时、本人收益及服务端 `nextActions`；陪玩端不展示也不保存在线/接单开关。Sapphire Bot 通过专用 `/player-workbench` 打开 ephemeral 面板，报名/撤回均经统一 API。

- [x] **M2-US-09：双向准备与超时转客服**
  - 前置依赖：M2-US-03;M0-US-05
  - 责任类型：backend_bot
  - 实现结果：为双方保存 readiness 与版本；第二个 READY 原子迁移 IN_SERVICE；超时 Job 创建唯一客服任务；不提供任何兼容 start 权限。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：setOrderReadiness;createOrderStaffTask;listCurrentUserStaffTasks
  - 验收用例：AT-RDY-001;AT-RDY-002
  - 完成定义：并发状态机、超时、Actor 归属、旧调用拒绝和双方 E2E 通过。
  - 禁止扩展：不允许陪玩单方 start 或自动开始计费。
  - 进度记录（2026-07-17）：接单事务已追加十分钟 `READINESS_TIMEOUT` Job；到期处理保持 `ACCEPTED` 和 ACTIVE 预留，只追加唯一超时事件及客服任务，重放安全。`GET /api/v1/me/staff-tasks` 按当前客户返回脱敏进度。双方 READY 原子开始及旧 start 拒绝回归继续通过。Story/数据库定向测试 2 files / 11 tests、全量回归 46 files / 255 tests 及类型检查通过。证据：`evidence/P0/M2-US-09/summary.md`。真实 Discord Guild E2E 待凭据。

- [x] **M2-US-10：取消影响预览与原子执行**
  - 前置依赖：M1-US-08;M2-US-05
  - 责任类型：backend_api
  - 实现结果：实现 previewOrderCancellation；cancelOrder 使用相同规则在事务内重验状态、版本、预留和 Provider 交易。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：previewOrderCancellation;cancelOrder
  - 验收用例：AT-CXL-001;AT-CAN-003;AT-CAN-008
  - 完成定义：预览/执行一致性、并发变化、预留释放、退款 UNKNOWN 和 Bot 面板测试通过。
  - 禁止扩展：不由 Bot 估算退款，不自动裁决已接单争议。
  - 进度记录（2026-07-17）：API 已生成并持久化 60 秒取消预览；执行时事务内重验订单、预留和预览快照。待派单自动取消通过追加资金事件释放预留；原生 Hold 释放超时按原幂等键恢复，仍未知则进入 `EXCEPTION` 并创建客服任务。已接单及后续状态只转客服。Bot 使用 API 金额展示二次确认和过期刷新。Story/关联测试 5 files / 19 tests、全量回归 49 files / 265 tests及类型检查通过。证据：`evidence/P0/M2-US-10/summary.md`。真实支付供应商与 Discord Guild E2E 待凭据。
  - 回退订单修复（2026-08-07）：取消影响预览的次要按钮由“返回服务中心”改为“暂不取消，返回订单”，复用无版本只读刷新路由恢复当前订单，不执行取消或资金写入。RED 1 failed / 3 passed，GREEN 1 file / 4 tests，关联 4 files / 26 tests、完整 Bot 22 files / 128 tests、typecheck/build 通过；待真实 Guild 部署后点击复验。证据：`evidence/P0/M2-US-10/summary.md`。
  - 过期预览修复（2026-08-07）：请求 `req_64667d5c-519c-4787-b270-97fcc078cb29` 已确认订单和预留版本未变，实际为 60 秒预览过期约 11 分 33 秒。Bot 现不会用旧预览重试取消，而是基于最新订单生成新取消说明、原位替换并要求再次确认；一次交互仍最多调用一次 `cancelOrder`。RED 1 failed / 3 passed，GREEN 1 file / 4 tests，关联 5 files / 29 tests、完整 Bot 22 files / 128 tests、typecheck/build 通过；待真实 Guild 完整交互复验。证据：`evidence/P0/M2-US-10/summary.md`。

- [x] **M2-US-11：客服暂停、接管与恢复自动化**
  - 前置依赖：M2-US-05;M2-US-06
  - 责任类型：backend_ops
  - 实现结果：实现订单 automationState、pause/resume、接管人、原因、范围、到期提示；暂停时派单/超时/自动取消 Job 安全跳过；支持重派和审批。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：pauseOrderAutomation;resumeOrderAutomation;createOrderStaffTask;reassignOrder;getStaffTask;resolveStaffTask
  - 验收用例：AT-SUP-005;AT-SUP-002
  - 完成定义：权限、并发 Worker、超时、恢复、转派和 Dashboard/Bot 状态测试通过。
  - 禁止扩展：不提供绕过状态机的任意改状态功能。
  - 进度记录（2026-07-17）：订单已持久化自动化状态、版本、接管人、任务、原因、scope 和到期提示。L1 仅可暂停本人已认领任务，L2+ 可按明确 `resumeAction` 恢复并结清任务。派单、超时、生命周期和取消 Worker 按最新状态及 scope 幂等跳过，预留不变。Discord 与 Dashboard 均展示客服接管状态。Story/关联测试 9 files / 45 tests、全量回归 54 files / 277 tests、schema/migration 验证及类型检查通过。证据：`evidence/P0/M2-US-11/summary.md`。真实 Discord Guild 与 Dashboard 浏览器 E2E 待环境。
  - Dashboard E2E 补验（2026-08-06）：客服工作台已提供真实可操作的接管面板。`DE2E-SUP-007` 通过可见 Chromium 流程执行 L1 认领、选择暂停范围、填写老板临时中断原因并暂停，再由 L2 打开同一任务、填写复核说明并按 `RESTART_READINESS_TIMEOUT` 恢复；订单版本 3→4→5，原 USD 4,000 预留和创建次数保持不变。Dashboard typecheck、M2-US-11 Dashboard/API 5 tests 和 focused Chromium 1/1 通过。证据：`evidence/P0/dashboard-e2e/acceptance.md`。

### 完成门禁
- [x] 十一个 M2 Story 的完成定义全部满足；PL-03、PL-04、PL-05、PL-06 及正常单、异常单闭环通过关联验收。证据：`evidence/P0/gates/M2.md`。

## M3：礼物、消费、收益与保密一级返佣

### 启动门禁
- [x] M2 完成门禁已有证据；订单正常与异常闭环可复验，礼物、收益和返佣可复用统一资金与权限边界。证据：`evidence/P0/gates/M2.md`。

- [x] **M3-US-01：礼物目录与订单内送礼请求**
  - 前置依赖：M2-US-03;M0-US-05
  - 责任类型：fullstack_bot_api
  - 实现结果：实现礼物查询、状态/时间窗口校验、快照、目标从 order.player_id 推导、Gift FundReservation、GIFT_REVIEW 任务和 Bot 面板。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：listGifts;createOrderGiftRequest;getCurrentBalance
  - 验收用例：AT-GFT-001;AT-GFT-003;AT-RES-008
  - 完成定义：四个状态、COMPLETED 24 小时边界、目标防伪、预留、任务、Bot 和隐私测试通过。
  - 禁止扩展：不做脱离订单送礼、匿名礼物或动画。
  - 进度记录（2026-07-17）：新增可复用礼物领域/API、PostgreSQL 原子事务与 Sapphire Bot 展示/调用接口。目录以订单为上下文返回固定陪玩目标、实时余额和可负担状态；创建时忽略客户端收礼人输入，只从订单推导，并在提交与事务内两次校验订单版本、状态、24 小时完成窗口及礼物版本。成功后写入 `PENDING_REVIEW` 礼物快照、两步 `CREATED→ACTIVATED` 资金预留流水和唯一 `GIFT_REVIEW` 任务，不捕获、不记消费、不播报。Story 测试 3 files / 12 tests、全量回归 57 files / 289 tests、类型检查、Prisma 校验和迁移验证通过。证据：`evidence/P0/M3-US-01/summary.md`。真实第三方支付与 Discord Guild E2E 待凭据。

- [x] **M3-US-02：客服认领、核对与分级送礼执行**
  - 前置依赖：M3-US-01;M0-US-03;M2-US-06
  - 责任类型：backend_security
  - 实现结果：实现唯一认领、内部备注、VERIFIED/待执行、拒绝、L2/L3/L4 金额策略、payload_hash 和执行凭据过期；展示预留状态和语音链接。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：claimStaffTask;verifyStaffTask;approveGiftRequest;rejectGiftRequest
  - 验收用例：AT-GFT-004;AT-GFT-005;AT-RBAC-003
  - 完成定义：权限矩阵、等级边界、同人发起并执行、原因、step-up/MFA、并发认领、陈旧凭据、客服卡片和不可篡改审计测试通过。
  - 禁止扩展：L1 不执行资金动作；任何级别不绕过核对。
  - 进度记录（2026-07-17）：复用唯一客服任务认领边界，新增本人已认领任务核对、验证摘要、15 分钟执行凭据、拒绝原因、金额分级授权和高额续办。L1 只能核对；L2 直授权上限 200000；200100–499999 升级 L3；500000 起升级 L4；L3/L4 必须近期 step-up。同一名达到等级的员工可核对后执行，不设置虚假的强制双人审批。PostgreSQL 使用行锁、对象版本、`payload_hash` 与不可变 `approval_request/decision` 防止陈旧执行；客服卡显示预留、订单文字频道和语音入口。Story 测试 3 files / 9 tests、全量回归 60 files / 298 tests、类型检查、Prisma 校验和迁移验证通过。授权后实际捕获、消费和播报由 M3-US-03 完成。证据：`evidence/P0/M3-US-02/summary.md`。

- [x] **M3-US-03：礼物捕获、消费记账与播报恢复**
  - 前置依赖：M3-US-02;M0-US-04;M0-US-05
  - 责任类型：integration_backend
  - 实现结果：批准时捕获现有 Gift FundReservation，原子写 external_transaction/consumption；成功后 Outbox 播报，补发仅重试消息。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：approveGiftRequest;handleSystemWebhook;retryJob
  - 验收用例：AT-GFT-006;AT-GFT-007;AT-WHK-002
  - 完成定义：Provider、数据库幂等、reservation capture、Outbox 和 Discord 播报 E2E 通过。
  - 禁止扩展：不因播报失败退款或再次捕获，不做礼物动画。
  - 进度记录（2026-07-17）：批准接口现调用可复用 `captureApprovedGift` 业务服务，Bot 与 Dashboard 共用同一 API。服务只捕获既有 Gift FundReservation：支持 provider native hold 与 local reservation fallback，使用稳定 Provider 幂等键；PostgreSQL 在单一事务内追加 CAPTURED 预留事件、`GIFT_CHARGE` ExternalTransaction、唯一 ConsumptionEntry、Gift CAPTURED 状态和 `GIFT_ANNOUNCEMENT` Outbox。重复执行返回同一捕获结果，不新建预留或消费。播报 handler 仅发送 Discord 消息并在成功后标记 ANNOUNCED，发送失败由 Outbox 重试且不会触碰支付。Webhook 最小归并逻辑支持退款成功回调早于扣款回调，迟到扣款不会将 REFUNDED/PARTIALLY_REFUNDED 降级，并幂等产生消费/返佣调整。Story 相关测试 6 files / 16 tests、全量回归 63 files / 304 tests、类型检查、Prisma 校验和迁移验证通过。证据：`evidence/P0/M3-US-03/summary.md`。

- [x] **M3-US-04：陪玩收益确认、支付标记与调整**
  - 前置依赖：M2-US-04;M2-US-06
  - 责任类型：backend_api
  - 实现结果：订单完成/结案创建唯一 PENDING PlayerEarning；L3 确认和人工支付；退款或纠错仅新增 PlayerEarningAdjustment。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：listPlayerEarnings;updatePlayerEarning;listCurrentPlayerEarnings
  - 验收用例：AT-EAR-001;AT-EAR-002;AT-EAR-003
  - 完成定义：金额、唯一性、状态迁移、PlayerEarningAdjustment 和权限测试通过；无删除端点。
  - 禁止扩展：不自动提现、转账、税务或工资单。
  - 进度记录（2026-07-17）：M2 订单完成路径继续按订单结算快照原子创建唯一 PENDING PlayerEarning；新增可复用 `player-earnings` API/领域模块与 PostgreSQL store。陪玩仅可按 Discord 绑定读取本人收益；L2 可筛选读取全局收益但不能写；L3+ 在近期 step-up 后可填写原因执行 PENDING→CONFIRMED→PAID。退款或人工冲减仅追加 `PlayerEarningAdjustment`，原主记录金额、订单归属和既有状态事实不覆盖；净收益按调整方向派生，不提供删除或自动支付。相关回归 5 files / 26 tests、全量 65 files / 309 tests、类型检查、Prisma 校验与迁移验证通过。证据：`evidence/P0/M3-US-04/summary.md`。

- [x] **M3-US-05：统一消费历史与本人返佣视图**
  - 前置依赖：M3-US-03;M3-US-04
  - 责任类型：backend_api
  - 实现结果：统一 Consumption 时间线；返佣查询按 beneficiary_id=current_user，来源用户脱敏；退款显示 Adjustment 影响。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：listCurrentUserConsumptions;listCurrentUserCommissions;updateCommission
  - 验收用例：AT-HIS-001;AT-RFP-005;AT-RFP-006;AT-RFP-008
  - 完成定义：消费、分页、归属、脱敏、CommissionAdjustment 和重放测试通过。
  - 禁止扩展：不做多级返佣、自动发放或公开来源用户。
  - 进度记录（2026-07-17）：完成统一消费时间线与稳定游标分页，订单、礼物和退款冲正按当前 Discord 绑定用户隔离展示。`/me/commissions` 只返回当前用户作为 beneficiary 的返佣，来源固定脱敏且不包含推荐关系、客户 ID、比例或归因 ID。新增可复用的返佣管理 API/PostgreSQL store：L3+ 才能读取完整记录，写操作要求近期 step-up、原因、版本与幂等键；确认、标记发放按顺序迁移，退款只追加非负 `CommissionAdjustment`，原始金额和归因快照不变。相关测试 3 files / 9 tests、全量 68 files / 318 tests、类型检查、Prisma 校验与迁移验证通过。证据：`evidence/P0/M3-US-05/summary.md`。

- [x] **M3-US-06：礼物资金预留完整生命周期**
  - 前置依赖：M1-US-08;M3-US-01;M3-US-02;M3-US-03
  - 责任类型：backend_payment_data
  - 实现结果：确认创建 reservation；批准 capture；拒绝/过期/用户撤回 release；不足时禁用确认并显示差额/充值入口；所有动作由 API 并发控制。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：createOrderGiftRequest;approveGiftRequest;rejectGiftRequest;cancelGiftRequest
  - 验收用例：AT-RES-008;AT-RES-009
  - 完成定义：生命周期、边界、并发、幂等、Provider hold/fallback 和 UI 状态测试通过。
  - 禁止扩展：不允许客服改预留金额或批准时重新创建主预留。
  - 进度记录（2026-07-17）：保留既有“创建礼物即建立唯一预留、批准捕获原预留”路径，并补齐客服拒绝、用户撤回和系统到期的统一释放动作。撤回按当前 Discord 绑定校验 sender，捕获后拒绝撤回；Provider native hold 使用稳定幂等键释放，local fallback 由追加 reservation event 推进，重放不重复释放。礼物创建事务新增 `GIFT_EXPIRY` Outbox，Worker 对已结束礼物安全跳过。余额不足返回 available、shortfall 和充值动作，Discord 礼物列表继续禁用不可负担选项。相关回归 8 files / 37 tests、全量 69 files / 323 tests、类型检查、Prisma 校验与迁移验证通过。证据：`evidence/P0/M3-US-06/summary.md`。

- [x] **M3-US-07：保密的两种一级返佣计划**
  - 前置依赖：M3-US-04;M3-US-05
  - 责任类型：backend_finance_security
  - 实现结果：实现 PROMOTER_FIRST_PURCHASE 与 PLAYER_LIFETIME；一名客户一个互斥来源；绑定/改绑/调整审计；按净消费结算；受益人查询掩码来源。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：listCurrentUserCommissions;listCommissions;updateCommission;createReferralAttribution;correctReferralAttribution;getReferralAttributionConfidential;listReferralAttributions;getCommissionConfidential
  - 验收用例：AT-RFP-001;AT-RFP-002;AT-RFP-003;AT-RFP-004;AT-RFP-005;AT-RFP-006;AT-RFP-007;AT-RFP-008
  - 完成定义：两计划、互斥唯一性、净消费、退款 Adjustment、L1-L4 scope、隐私快照及事件重放测试通过。
  - 禁止扩展：不做多级返佣、用户自助改绑、自动发放或代理体系。
  - 进度记录（2026-07-17）：新增可供 Dashboard 与 Discord Bot 复用的保密归因 API/PostgreSQL store。L2 仅能读取不含客户、受益人、计划、比例、金额和状态的脱敏列表；L3+ 近期 step-up 后可创建、查看完整详情或追加改绑记录。系统拒绝自荐、已有消费后的迟绑定、同一客户第二个活动归因和非陪玩长期受益人；比例与固定金额只从活动服务端计划读取，客户端经济字段直接拒绝。改绑将旧记录 SUPERSEDED 并追加 replacement，不覆盖历史。订单与礼物共享返佣生成事务：推广者首笔计划命中后 FULFILLED，陪玩长期计划持续处理合格净消费；整数向下取整、来源唯一和退款 Adjustment 保持。相关跨域回归 11 files / 59 tests、全量 71 files / 331 tests、类型检查、Prisma 校验与迁移验证通过。证据：`evidence/P0/M3-US-07/summary.md`。

### 完成门禁
- [x] 七个 M3 Story 的完成定义全部满足；礼物预留/捕获、消费、陪玩收益、两种一级返佣和保密边界通过关联验收。

## M4：Dashboard、四级权限与运营控制面

### 启动门禁
- [x] M0-M3 完成门禁已有证据；Dashboard、RBAC、Role 映射与 Bot 配置所需 API 合同和验收数据已锁定。

- [x] **M4-US-01：Dashboard OAuth2、会话与 Capabilities 外壳**
  - 前置依赖：M0-US-03
  - 责任类型：frontend_backend_security
  - 实现结果：实现 Discord OAuth2、staff 校验、安全 Cookie、CSRF、permissions_version、Capabilities、导航壳和 401/403。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：getCurrentStaffCapabilities;getDashboardSummary
  - 验收用例：AT-AUTH-002;AT-RBAC-001
  - 完成定义：认证、CSRF、会话撤销和 UI/API 测试通过；Token 不进 localStorage。
  - 禁止扩展：不让 Discord Role 单独成为授权事实，不实现密码登录。
  - 进度记录（2026-07-17）：实现可注入 Discord OAuth2 provider、一次性 state、staff 校验、PostgreSQL `staff_sessions`、8 小时 HttpOnly/SameSite 会话 Cookie、双提交 CSRF 和登出撤销；每次请求从服务端会话与员工记录重建身份，`permissions_version` 不一致即撤销旧会话，忽略浏览器自报等级与 Discord 身份。新增 `getCurrentStaffCapabilities` 与八指标摘要壳，React Dashboard 支持 401 登录、403 禁止、错误态和 capability 驱动导航；API client 仅使用 credentialed Cookie，不读写 localStorage。生产配置强制会话/CSRF，未配置 resolver 时仅保留既有受信 Bot service-token 测试兼容路径。聚焦 3 files / 25 tests、全量 73 files / 339 tests、类型检查、Prisma 校验与迁移验证通过。证据：`evidence/P0/M4-US-01/summary.md`。
  - 视觉重构记录（2026-08-01）：使用 `ui-ux-pro-max` 生成并固化 `design-system/blackcat-operations/MASTER.md`，在不改变业务 API、权限裁剪或资金语义的前提下重构 Dashboard 应用壳、能力导航、运营首页和 401/403/错误/加载状态；新增统一设计 token、Lucide 导航图标、当前页状态、跳转主内容、44px 交互目标、键盘焦点、reduced-motion、桌面/移动响应式和 WCAG AA 关键文本对比度。视觉分支的 RED 为新增 3 条壳层/可访问性测试全部失败；GREEN 为聚焦测试 4/4。合并到 M9 后仍保留 CAT 充值、陪玩审核与 feature capability，验收矩阵为 207 项；1440×900 与 390×844 截图保存于 `evidence/P0/M4-US-01/ui-refresh/`。AT-AUTH-002 与 AT-RBAC-001 的服务端权威边界保持不变；未知运行环境不会被误标为生产环境；真实员工 UAT 仍未在本次视觉维护中声称完成。
  - 弹窗边缘回归（2026-08-05）：修复所有详情与操作 overlay 共用吸顶标题栏的横向负边距；标题栏保持纵向吸顶，但不再覆盖左右边线、圆角或 `action-panel` 紫色装饰。RED 为 `tests/m4-us-01-dashboard-ui.spec.ts` 新增用例 1 failed / 4 passed；GREEN 为 M4-US-01 与 M4-US-03 聚焦回归 2 files / 27 tests，`npm run typecheck`、Dashboard production build 和 `git diff --check` 通过。实际修改：`apps/dashboard/src/styles.css`、`tests/m4-us-01-dashboard-ui.spec.ts`；AT-AUTH-002 与 AT-RBAC-001 权限边界未改变。真实员工登录态视觉 UAT 仍待外部复验，未误报完成。
  - 弹窗标题背景复核（2026-08-05）：根据真实页面反馈移除共用吸顶标题栏的独立深色背景和 backdrop blur，只保留标题、关闭按钮及底部分隔线，使标题区与 action/detail 面板背景连续。RED 1 failed / 4 passed；GREEN 聚焦回归 2 files / 27 tests，typecheck 与 Dashboard production build 通过；真实员工登录态视觉 UAT 仍待外部复验。

- [x] **M4-US-02：L1 统一订单与客服工作台**
  - 前置依赖：M4-US-01;M2-US-05;M3-US-02
  - 责任类型：frontend_dashboard
  - 实现结果：实现摘要、个人/团队任务、订单工作台、筛选、详情、匹配/readiness/automation 状态、频道/语音链接、备注、认领和升级。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：getDashboardSummary;listStaffTasks;claimStaffTask;verifyStaffTask;getAdminOrder;getApprovalRequest;listApprovalRequests;approveApprovalRequest;rejectApprovalRequest
  - 验收用例：AT-SUP-001;AT-RBAC-002;AT-RFP-005
  - 完成定义：组件、API scope、L1 E2E 和跨客户端状态一致性通过。
  - 禁止扩展：不建设独立客服工单、聊天归档或复杂 SLA。
  - 进度记录（2026-07-17）：新增 Dashboard/API 共用客服工作台聚合层和 PostgreSQL store。L1 列表仅显示 OPEN 与本人已认领任务，完整订单详情必须关联本人任务；支持状态/类型查询、原子认领复用、订单与语音频道入口、处理备注和升级到 `PENDING_APPROVAL`。Dashboard 提供摘要、我的/待认领筛选、任务卡、订单 matching/readiness/automation 详情、认领、备注与提交主管处理；升级不提前执行资金或破坏性动作，金额与审批执行闭环留给 M4-US-04。相关 5 files / 15 tests、全量 75 files / 343 tests、类型检查、Dashboard 生产构建、Prisma 校验与迁移验证通过。证据：`evidence/P0/M4-US-02/summary.md`。

- [x] **M4-US-03：订单、用户、陪玩与业务配置页面**
  - 前置依赖：M4-US-01;M2-US-06;M3-US-05
  - 责任类型：frontend_dashboard
  - 实现结果：实现搜索、订单/用户/陪玩详情、服务/礼物目录、返佣、陪玩收益页面和所需读写 API。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：listAdminOrders;getAdminOrder;listAdminUsers;getAdminUser;listAdminPlayers;getAdminPlayer;listServiceCatalogVersions;getAdminServiceCatalogVersion;createServiceCatalogVersion;updateServiceCatalogVersion;getAdminServicePackageVersion;listAdminGiftCatalogItems;createGiftCatalogItem;updateGiftCatalogItem;listCommissions;listPlayerEarnings;updatePlayerEarning;createUserRiskFlag;setUserOperationalStatus;listAdminUserConsumptions;getAdminGiftRequest;listAdminGiftRequests
  - 验收用例：AT-RBAC-003;AT-CAT-003;AT-EAR-002;AT-DTL-001
  - 完成定义：页面、分页、筛选、权限、金额格式和写用例 E2E 通过。
  - 禁止扩展：不做营销画像、完整财务报表、数据仓库或复杂批量操作。
  - 完成记录（2026-07-17）：交付 Bot/Dashboard 共用统一 API 的订单、用户及消费、陪玩、服务目录、礼物目录与请求、返佣、陪玩收益页面；补齐查询、详情、筛选、稳定 HMAC keyset 分页、L1 个人任务 scope、L2-L4 目录权限、版本化服务/礼物写入、风险事件、用户状态和收益操作。写操作复用幂等 key；三项新增管理 mutation 使用 staged write，内存审计失败回滚，PostgreSQL 业务与成功审计同事务提交；生产审计使用 PostgreSQL sink，未知客户端来源仅以审计专用 `UNKNOWN` 记录。相关聚焦 6 files / 48 tests、全量 79 files / 388 tests、类型检查、Dashboard 生产构建、Prisma 校验、迁移验证与 `git diff --check` 通过。证据：`evidence/P0/M4-US-03/summary.md`。
  - 体验回归（2026-08-03）：订单目录由宽表改为 Discord Discussion 风格响应式卡片流；卡片突出业务订单号、中文状态、项目展示名、地区/时长、老板与陪玩业务 ID、价格和创建时间，内部 UUID 收纳为紧凑辅助信息。`tests/m4-us-03-dashboard.spec.ts` 19/19 通过，`npm run typecheck` 通过。
  - 交互回归（2026-08-04）：业务详情与编辑表单改为通过 `document.body` Portal 挂载的全视口 overlay 对话页，不受侧栏或内容布局上下文裁切；保留背景列表上下文，面板独立滚动并支持吸顶关闭、遮罩点击和 Esc 退出。`tests/m4-us-03-dashboard.spec.ts tests/m4-us-08-dashboard.spec.ts` 2 files / 23 tests 通过，类型检查与 Dashboard 生产构建通过。
  - 详情投影回归（2026-08-04）：用户与陪玩详情补齐 Discord 摘要、真实状态、可读业务标签、版本及创建/更新时间；服务目录与服务套餐新增按版本编号读取的独立详情 API，返回价格、状态、审计时间与有序席位。Dashboard 不再把列表快照当详情，也不再用 `active` 默认值伪造“可参与派单”；presence 明确仅作诊断展示。合同新增 `AT-DTL-001` 并同步 OpenAPI、backlog、交互映射与验收镜像。相关 8 files / 71 tests、类型检查、Dashboard 生产构建和 `git diff --check` 通过。证据：`evidence/P0/M4-US-03/summary.md`。
  - 礼物详情投影回归（2026-08-04）：`AT-DTL-001` 从四类扩展为六类业务详情；礼物目录新增 `getAdminGiftCatalogItem`，返回当前不可变版本、分类展示名、价格、播报模板、创建人及生命周期时间。礼物请求详情补齐来源订单、用户/陪玩 Discord 摘要、预留状态、核对/批准/捕获/播报时间线与失败上下文，不返回预留幂等键。Dashboard 两类页面均改为独立详情读取和语义化布局。相关 10 files / 86 tests、类型检查、Dashboard 生产构建及 `git diff --check` 通过。证据：`evidence/P0/M4-US-03/summary.md`。
  - 服务展示名回归（2026-08-05）：修复服务目录创建时把业务标签 code 同时写入 name 列的问题；API 现在保存并返回标签展示名，Dashboard 标题显示 `gameDisplayName · serviceDisplayName`，服务代码与数字版本保留在事实区。新增 `000030_service_offering_display_names` 保守回填仅修复 `name=code` 的旧记录，不覆盖已有正常名称。RED：API 2/14 失败、DB 1/5 失败、Dashboard 1/23 失败；GREEN：关联 3 files / 42 tests、typecheck、Prisma validate、全迁移验证与 Dashboard production build 通过。本机 `localhost:5432/blackcat` 已成功部署 000030；运行 API 复验 200，返回 `LOLNA/英雄联盟美服`、`RANKED/上分陪玩`、version 1。验收对应 `AT-CAT-003;AT-DTL-001`，证据：`evidence/P0/M4-US-03/summary.md`。
  - 订单受控取消入口（2026-08-05，本地候选）：订单卡片按服务端 `order.resolve` capability 展示“取消订单”，仅适用于 `ACCEPTED / IN_SERVICE / PENDING_CONFIRMATION / EXCEPTION`；L1 与终态订单不显示。表单收集合同允许的原因、退款/预留释放金额、保留陪玩收益和证据，调用既有 `resolveOrder` 原子结案 API；L4 仍遵守近期 step-up、幂等、版本与资金边界。RED 2/22，GREEN 聚焦 22/22，关联 3 files / 28 tests、Dashboard typecheck/build 与 diff check 通过；真实员工会话操作 UAT 待复验。证据：`evidence/P0/M4-US-03/summary.md`；验收对应 `AT-CAN-007`。
  - 陪玩收益操作可见性回归（2026-08-10）：`PENDING` 仅显示“确认收益”，`CONFIRMED` 仅显示“标记已支付”，`PAID/REVERSED` 只读且终态集合不保留空操作列；L2 页面明确说明需要内部 L3+ `earnings.manage`，Discord Role 不作为授权事实。RED 为 1 file / 3 tests 全失败；GREEN 为聚焦 7 files / 69 tests、Dashboard 38 files / 201 tests、Chromium 13/13、全仓 251 files / 1262 tests，typecheck、Dashboard build、E2E 覆盖 129/129、矩阵复现与 diff check 均通过。四张 L2/L3/手机截图见 `evidence/P0/M4-US-03/screenshots/player-earnings-actions/`；验收对应 `AT-EAR-002`。

- [x] **M4-US-04：金额策略、MFA 与 step-up**
  - 前置依赖：M4-US-01;M2-US-06;M3-US-02
  - 责任类型：backend_security
  - 实现结果：实现执行影响预览、payload_hash、过期、L2/L3/L4 阈值、最低等级直执、同人发起执行、L3/L4 MFA 和 15 分钟 step-up。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：getCurrentStaffCapabilities;beginStepUp;completeStepUp;enrollMfa;verifyMfaEnrollment
  - 验收用例：AT-RBAC-004;AT-RBAC-005;AT-GFT-005
  - 完成定义：等级边界、同人发起执行、原因、过期/陈旧、MFA 恢复、不可篡改审计和幂等重放测试通过。
  - 禁止扩展：不实现企业 IAM、强制硬件密钥或自定义权限级别。
  - 完成记录（2026-07-18）：交付 Dashboard/API 共用的 TOTP 绑定、一次性恢复码、会话绑定 challenge 与 15 分钟 step-up；L3/L4 未绑定 MFA 时动态降为仅可完成安全设置的 L1 权限，五次错误证明后锁定。密钥独立加密、恢复码仅存哈希，幂等指纹和响应不留明文敏感材料；数据库强制归属、过期、单次消费、不可改写和事务内安全审计。后台新增账户安全与金额影响页面。验证 L2 礼物 200000/退款 50000 直执，200100/50100 仅生成审批且不提前触发资金或广播，同人达到 L3 并 step-up 后可继续。聚焦 2 files / 11 tests、全量 81 files / 399 tests、类型检查、Dashboard 生产构建、Prisma 校验、51 表真实迁移及负向探针与镜像合同一致性通过。证据：`evidence/P0/M4-US-04/summary.md`。

- [x] **M4-US-05：Discord Role 映射、高级授权与即时撤权**
  - 前置依赖：M4-US-01;M4-US-04
  - 责任类型：backend_bot_security
  - 实现结果：实现启动/guildMemberUpdate 同步、版本化映射、L1/L2 自动生效、L3/L4 PENDING_ELEVATION、L4 确认、bootstrap、降级和会话撤销。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：listDiscordRoleMappings;updateDiscordRoleMapping;syncDiscordRoles;updateStaffRole;approveStaffRoleElevation;revokeStaffSessions
  - 验收用例：AT-ROL-001;AT-ROL-004;AT-RBAC-006
  - 完成定义：Role 同步、重放、升降级、会话撤销、上限和审计 E2E 通过。
  - 禁止扩展：不根据客户端 Role ID 临时授权，不允许 L3 授予 L4。
  - 完成记录（2026-07-18）：交付 Bot/Dashboard 共用的 6 个 Role 与访问控制 API，Sapphire `guildMemberUpdate` 和启动对账只上报 Discord 观测事实，由 API 按 Guild 全局单调 generation 的版本化映射计算内部权限。L1/L2 自动生效；首次 L3/L4 保持原有效等级并生成待确认记录；仅另一名已生效 L4 可在近期 step-up 后确认，自批、伪造 Role Header、Role 已移除及陈旧版本均被拒绝。Role 降级或移除、人工降级和显式撤销均增加 `permissionsVersion` 并立即撤销有效会话；人工停用不能被 Discord 对账恢复，倒序观测只追加拒绝证据；一次性 bootstrap 以数据库事务锁和不可变审计事实保护，成功后环境变量必须移除。PostgreSQL 业务、审批、同步事件、会话撤销、对账 Outbox 与成功审计同事务提交，映射并发按 Guild 串行化，事件按 `sourceEventId` 幂等且只追加。聚焦 3 files / 21 tests、全量 84 files / 420 tests、类型检查、Dashboard 生产构建、Prisma 校验、51 表真实迁移及 Sapphire Piece 清单通过。AT-RBAC-006 的 500000 minor units L4 边界由既有金额策略回归继续覆盖。证据：`evidence/P0/M4-US-05/summary.md`。
  - Dashboard 修复记录（2026-08-02）：补齐此前只存在导航、却没有实际路由的 `/access` 权限管理页，接入合同已有的 Role 映射查询与版本化更新；L4 + step-up、服务端最终授权、原因、版本冲突和全量对账边界保持不变。左侧菜单改为 History API 页面内导航，切换加载仅覆盖右侧 `dashboard-content`，Sidebar/Topbar 不再因重新读取 capabilities 被全屏替换。新增测试先 RED 后 GREEN；聚焦 4 files / 21 tests、全量低并发 152 files / 755 tests、Dashboard 类型检查与生产构建通过；浏览器以已登录 L4 会话验证独立权限页、step-up 引导和菜单切换期间 Sidebar 持续存在。证据：`evidence/P0/M4-US-05/summary.md`。
  - Role 同步可靠性修复（2026-08-10）：`guildMemberUpdate` 与启动观测改为先事务写入幂等 PostgreSQL Outbox，任务最多尝试 8 次且失败后保留为 `FAILED`；Worker 默认每 5 分钟执行去重的 Guild 全量对账，同时支持 L4 + step-up 在权限页为每名同 Guild 员工立即创建持久化对账任务。员工卡展示最近同步时间、观察 Role、处理/队列状态、上次错误和待确认级别；映射版本排队期间变化时 Worker 自动刷新一次；权限同步撤销会话后明确提示“权限已变化，请重新登录”。RED 为 5 files / 8 failed；GREEN 为聚焦 8 files / 59 tests、Chromium 3/3、全仓 256 files / 1292 tests，Dashboard build、164 路由合同、131/131 E2E 覆盖、lint、Prisma 和 diff 门禁通过。真实 Discord Guild 的时效与断网恢复仍保留为外部 UAT。证据：`evidence/P0/M4-US-05/summary.md`。

- [x] **M4-US-06：审计、失败任务与最小系统设置**
  - 前置依赖：M4-US-01;M0-US-05
  - 责任类型：frontend_backend_ops
  - 实现结果：实现按 scope 的不可变审计查询、失败 Job 列表/重试、政策/频道/超时配置版本化修改和 request_id 错误展示。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：listAuditLogs;listFailedJobs;retryJob;getPolicySettings;updatePolicySetting
  - 验收用例：AT-AUD-001;AT-AUD-004;AT-CHN-003
  - 完成定义：scope、配置并发、Job 重试和审计完整性测试通过。
  - 禁止扩展：不做日志分析平台或任意 SQL 管理入口。
  - 完成记录（2026-07-18）：交付 Bot/Dashboard 共用的审计、失败 Job、配置与频道失败上报 API，并接入可用的 /operations Dashboard。审计按 L1 本人、L2 同 Guild 业务团队、L3 全业务、L4 全系统分层，access/MFA/step-up/session 安全记录仅本人或 L4 可见；失败 Job 按 L2 投递类、L3 业务定时类、L4 Role 安全类分层，且仅纯展示/投递任务允许手工重试。冻结 PolicyKey 采用 L3+、近期 step-up、原因、乐观版本和追加历史，金额/比例/时间单位严格校验；统一 Policy reader 已接入后续 Dashboard 阈值、礼物/退款审批、派单超时和 step-up 有效期，既有业务快照不回写。PostgreSQL 配置或 Job 变更与成功审计同事务提交。Bot 频道创建失败使用确定性 request_id、有限重试上报、不会创建订单，Dashboard 可查询记录；Bot/Dashboard 同一重试用例的状态、版本和审计事实一致。Discord 频道/Role 具体配置继续由 M4-US-10 的 /bot-config 单一权威负责。聚焦回归 7 files / 54 tests、全量 87 files / 449 tests、类型检查、Dashboard 生产构建、Prisma 校验、51 表真实迁移、OpenAPI YAML 与双镜像一致性通过。证据：evidence/P0/M4-US-06/summary.md。

- [x] **M4-US-07：累积权限解析器与跨渠道一致授权**
  - 前置依赖：M4-US-01;M4-US-04;M4-US-05
  - 责任类型：backend_security_qa
  - 实现结果：实现累积权限解析器，按 L1<L2<L3<L4 合并低级全部执行权限，并统一资源/action/scope 矩阵、金额阈值、破坏性操作定义、推荐隐私和 Role 上限；用同一 API policy 对 Bot/Dashboard 授权。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：getCurrentStaffCapabilities;syncDiscordRoles
  - 验收用例：AT-RBAC-001;AT-RBAC-009;AT-RBAC-010;AT-RBAC-011
  - 完成定义：累积解析、金额边界、四角色两客户端 E2E、拒绝审计及 AT-RBAC-010/011 通过。
  - 禁止扩展：不增加第五级、自定义角色设计器或客户端本地授权。
  - 完成记录（2026-07-18）：新增唯一服务端累积授权解析器，统一 L1<L2<L3<L4 permissions、SELF/TEAM/BUSINESS/ALL scope、推荐信息可见性、破坏性动作空集、金额等级和 Role 授予上限。安全中间件与 `getCurrentStaffCapabilities` 共用同一解析结果，Bot/Dashboard 不做本地最终授权；礼物和退款共用金额等级解析，500000 minor units 起必须 L4，但不增加发起人与执行人分离。Discord Role 同步继续受内部批准等级、permissions_version 和会话撤销约束。跨渠道允许/拒绝与真实 actor 拒绝审计测试通过；聚焦 5 files / 40 tests、全量 88 files / 452 tests、类型检查与构建通过。证据：`evidence/P0/M4-US-07/summary.md`。

- [x] **M4-US-08：统一业务交易时间线**
  - 前置依赖：M1-US-08;M2-US-06;M3-US-03;M3-US-04;M3-US-05
  - 责任类型：backend_dashboard
  - 实现结果：建立只读 timeline projection，合并 internal ledger balance snapshot、FundReservation、Consumption、Refund、PlayerEarning、Commission 及对应 Adjustment；按权限脱敏。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：getAdminOrder
  - 验收用例：AT-TML-001;AT-HIS-002;AT-RFP-005
  - 完成定义：projection、金额方向、分页、脱敏、空/异常状态和 Dashboard E2E 通过。
  - 禁止扩展：不做总账替代、完整财务对账、导出或会计科目。
  - 完成记录（2026-07-18）：`getAdminOrder` 交付单一只读时间线 projection，合并提交时 internal ledger balance 审计快照、订单事件、FundReservation 事件、订单及订单内礼物的 ExternalTransaction/Consumption/Refund、PlayerEarning、Commission 与各自 Adjustment。原始事实和 Adjustment 分行，金额使用非负 minor units 与独立方向；预留捕获/释放金额按不可变事件汇总。分页采用稳定的 `occurredAt + id` 签名游标并绑定订单和权限级别。L1 仅在本人已认领任务内查看脱敏状态事实，L2 受同 Guild 团队范围限制且不见返佣，L3/L4 可查看授权后的返佣经济事实，但所有层级均不返回推荐关系、受益人、比例或基数。客服工作台与管理目录共用唯一 `getAdminOrder` 路由，Bot/Dashboard 均调用同一 API。Dashboard 提供只读时间线、空态、分页、分页失败 request_id，且无编辑、删除或导出入口。聚焦回归 5 files / 27 tests，Story 测试 3 files / 10 tests，全量 91 files / 463 tests、类型检查、构建、Dashboard 生产构建、Prisma 校验、51 表真实迁移、OpenAPI YAML 与双镜像一致性通过。证据：`evidence/P0/M4-US-08/summary.md`。

- [x] **M4-US-09：八项启动运营指标**
  - 前置依赖：M4-US-02;M4-US-08
  - 责任类型：backend_dashboard
  - 实现结果：实现今日订单、进行中订单、待处理任务、已完成净消费、礼物净消费、预留总额、派单成功率、异常数；固定时区、币种和口径。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：getDashboardSummary
  - 验收用例：AT-MET-001;AT-MET-002
  - 完成定义：聚合查询、边界时间、退款/Adjustment、空数据、权限和 Dashboard 快照测试通过。
  - 禁止扩展：不做下钻 BI、趋势图、导出、完整对账或绩效分析。
  - 完成记录（2026-07-18）：交付 Bot/Dashboard 共用的 `getDashboardSummary` 聚合投影，固定 `Asia/Shanghai` 半开业务日与 `USD`，仅返回今日订单、进行中订单、待处理任务、已完成订单净消费、礼物净消费、有效预留余额、派单成功率和异常数八项指标。订单与礼物净消费按不可变 Consumption debit/credit 方向计算，预留余额按 FundReservation 事件计算，退款及 Adjustment 通过 credit 事实冲减；派单成功率使用整数基点且无有效轮次时为 0。L1 仅统计本人认领范围且三项金额返回 null，L2 按同 Guild，L3/L4 按业务/全局范围；Dashboard 提供加载、空值、无权限和 request_id 错误状态，不包含趋势、下钻或导出。Story 聚焦 3 files / 9 tests、全量 94 files / 472 tests、类型检查、构建、Dashboard 生产构建、Prisma 校验、51 表真实迁移、OpenAPI YAML 双镜像与 `git diff --check` 通过。证据：`evidence/P0/M4-US-09/summary.md`。
  - 图表化复核（2026-08-03）：首页移除低信息密度欢迎横幅，复用同一 `getDashboardSummary` 授权投影展示八项 KPI、三项资金构成条形图、派单成功率环图和待办健康度；未新增趋势、昨日对比、下钻、导出或客户端金额汇总。扩展测试先 RED 后 GREEN，聚焦 4 files / 19 tests、全仓 typecheck、Dashboard production build 与 diff check 通过；主规格、交互映射双镜像和 Story 证据已同步。

- [x] **M4-US-10：/bot-config 精简程序设计与实现**
  - 前置依赖：M0-US-03;M0-US-05;M4-US-05;M4-US-07
  - 责任类型：backend_bot_api
  - 实现结果：实现 Guild-only /bot-config Slash Command、Sapphire component handlers、ephemeral presenter 与统一 API client；Channel Select/Role Select 后先预览校验并取得短期 validationToken 再确认；API 以 staff_account 和 bot_config.read、bot_config.operational.manage、bot_config.security.manage 最终授权，处理版本冲突、立即刷新缓存、追加审计和重启重载。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：getBotConfig;updateBotConfig;validateBotConfigChange;testBotConfigDelivery
  - 验收用例：AT-CFG-001;AT-CFG-002;AT-CFG-003;AT-CFG-004;AT-CFG-005;AT-CFG-006;AT-CFG-007;AT-CFG-008;AT-CFG-009;AT-CFG-010
  - 完成定义：AT-CFG-001..010 全部通过；四个 operationId 契约一致；预览防绕过、权限拒绝、立即生效、审计和重载有自动化证据；未新增网页或可点击 Demo。
  - 禁止扩展：不做独立配置网页、Dashboard 配置页、可点击 Demo、可运行 UI Prototype、Secrets/目录/价格/礼物/返佣配置或任意工作流设计器。
  - 完成记录（2026-07-18）：交付 Guild-only `/bot-config` Sapphire Command、Channel Select、Role Select、开关选择、时限/模板 Modal、ephemeral 预览与确认 handlers，以及四个 OpenAPI operation 共用的 Bot client。API 以内部 staff_account 和累积权限最终授权：L3 可读写运营字段，L4 继承并可写安全 Role 映射，L1/L3 越权固定拒绝；Bot 启动服务身份仅可只读重载且无 manageableFields。预览会校验 Guild、对象类型、Role 层级和 Bot 权限，并签发绑定 actor/Guild/version/规范化 changes/reason 的 5 分钟独立 HMAC token；确认时重新验证 Discord 事实和 expectedVersion。成功写入在一个 PostgreSQL 事务内更新当前配置、同步权威 `discord_role_mappings`、追加不可变事件和成功审计，Bot 随即刷新缓存；下一次派单或礼物广播从统一配置读取频道，重启按 Guild 从 API 重建缓存。网络交互先 defer，短会话只保存当前字段所需状态；标量字段与安全字段分组，单个 Select 不超过 25 项，custom_id 仅含动作和短会话 ID。未新增网页、Dashboard 配置页或可点击 Demo。Story 聚焦 3 files / 22 tests、全量 97 files / 494 tests、类型检查、构建、Sapphire Piece 清单、Dashboard 生产构建、Prisma 校验、51 表真实迁移和数据库保护探针通过。证据：`evidence/P0/M4-US-10/summary.md`。

### 完成门禁
- [x] 十个 M4 Story 的完成定义全部满足；四级累积授权、Role 上限、Dashboard 与 Bot 一致性、八指标和 /bot-config 全部通过关联验收。

## M5：验收、真实集成与可恢复部署

### 启动门禁
- [x] M0-M4 完成门禁已有证据；全部 P0 Story 都有实现记录、自动化证据和可部署候选构建。

- [x] **M5-US-01：P0 自动化回归与跨客户端 E2E**
  - 前置依赖：EP-M1;EP-M2;EP-M3;EP-M4
  - 责任类型：qa_automation
  - 实现结果：补齐单元、数据库、Provider、API、RBAC、Sapphire 和 E2E；建立 Requirement ID→Story→operationId→test→evidence 追踪矩阵。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：none
  - 验收用例：AT-AUD-004;AT-RBAC-001;AT-MET-001
  - 完成定义：CI 全绿；失败可复现；记录含环境、构建、Requirement/Story ID、结果和证据链接。
  - 禁止扩展：不追求 P1 设备矩阵或性能压测平台。
  - 完成记录（2026-07-18）：新增确定性验收矩阵构建器与当时 152 行 `evidence/P0/acceptance-matrix.csv`，将权威验收 ID 追踪到 Story、OpenAPI operationId、可执行测试和证据；未知 operation、缺失自动化测试/证据、重复或缺少验收行会使门禁失败。107 条候选自动化用例标记为 `COVERED_BY_REGRESSION`，45 条真实 Discord/UAT/环境用例诚实保留 `PENDING_EXTERNAL`。新增独立 P0 GitHub Actions 候选工作流，运行矩阵 freshness、全量测试、类型/构建、Dashboard Vite、Prisma、51 表迁移保护探针、Sapphire Piece 和镜像检查；AT-AUD-004、AT-RBAC-001、AT-MET-001 继续由 Bot/Dashboard 共用 API 的跨客户端测试覆盖。全量本地候选回归 99 files / 500 tests 通过；Hosted Actions 等待下次 push。2026-07-19 随 M6 权威目录扩展后，矩阵已动态刷新为 175 条，其中 128 条由候选自动化回归覆盖、47 条保留 `PENDING_EXTERNAL`。真实 Guild、Provider、备份恢复和人工签署未被宣称完成。证据：`evidence/P0/M5-US-01/summary.md` 与 `evidence/P0/acceptance-matrix.csv`。
  - 增补记录（2026-07-19）：外部验收账本以 schema v1 空结果集叠加矩阵；仅权威 `EXTERNAL_E2E` ID 可登记 `PASSED`/`FAILED`，候选引用、UTC 时间、执行人、环境、摘要及 ID 专属目录内的非空常规证据文件与 SHA-256 均严格校验。未知/自动化/重复 ID、非法字段、路径穿越、example 文件、符号链接、缺失或哈希错误均失败关闭。矩阵新增 `external_candidate_ref`、`external_executed_at`、`external_evidence_refs` 三列；当前 175 行为 128 `COVERED_BY_REGRESSION`、47 `PENDING_EXTERNAL`、0 `PASSED`，所有外部列为空。RED：`npx vitest run tests/m5-us-01-traceability.spec.ts` 因模块不存在失败；GREEN：同命令 1 file / 26 tests 通过，`node scripts/build-p0-acceptance-matrix.mjs .` 写入 175 行。外部 UAT 与发布签署继续未完成。实际修改：`scripts/external-acceptance-results.mjs`、`scripts/build-p0-acceptance-matrix.mjs`、`tests/m5-us-01-traceability.spec.ts`、`evidence/P0/external-acceptance-results.json`、`evidence/P0/acceptance-matrix.csv` 与两份 TODO 镜像。验收关联：AT-AUD-004、AT-RBAC-001、AT-MET-001；外部证据仍为待执行项。
  - 增补记录（2026-07-19）：外部验收证据合同已加固：`evidence[0]` 必须为 UTF-8 Markdown 主证明，`Status` 和执行元数据与账本一致，`Redaction Review` 精确为 `CONFIRMED`，脱敏详情和四个实质段落满足最小字符数、字符多样性、非占位、非重复及具体结果约束；`Diagnostics` 必须有具体 `request_id`/日志/截图/录屏/命令输出引用或足够长的明确不适用原因。后续条目可为非空哈希附件，仍保留原路径、example、符号链接、普通文件、真实路径和 SHA-256 检查。RED 分别为 30/60 和 3/63 预期失败；GREEN 为 traceability 1 file / 63 tests、traceability/gate/recovery 3 files / 75 tests。`npm run typecheck`、175 行矩阵再生成、OpenAPI/schema/TODO 镜像比较及 `git diff --check` 均通过。恢复测试仅改名为 baseline restore probe，行为不变且不再误称覆盖 `AT-REC-005`。实际修改：`scripts/external-acceptance-results.mjs`、`tests/m5-us-01-traceability.spec.ts`、`tests/m5-us-02-recovery.spec.ts`、`docs/runbooks/P0-UAT与发布检查表.md`、`evidence/P0/M5-US-01/summary.md` 与两份 TODO 镜像。当前矩阵仍为 128 自动化覆盖、47 外部待验收、0 外部通过；真实外部 UAT 与发布签署继续未完成。

- [ ] **M5-US-02：真实 Provider 沙箱与生产样部署恢复**
  - 前置依赖：M5-US-01;M0-US-04
  - 责任类型：integration_devops
  - 实现结果：实现真实 Adapter、签名/回调/对账、Provider hold 能力探测与 fallback、环境隔离、Compose、Secret、迁移、备份恢复和 Bot/Worker 重启演练。
  - 执行步骤：读取合同 → 写失败测试 → 最小实现 → 运行相关回归 → 更新证据
  - 关键接口：getHealth;getReadiness;handleSystemWebhook
  - 验收用例：AT-WHK-003;AT-REC-003;AT-REC-005
  - 完成定义：另一成员按 Runbook 成功部署/恢复；凭证扫描、健康、日志和告警通过。
  - 禁止扩展：不建设 Kubernetes、多区域容灾、自动扩容或自研支付。
  - 进度记录（2026-07-19，未完成）：已交付生产环境变量校验、生产样 Compose 候选、部署/恢复 Runbook、可复用 HTTP Provider Adapter、8 类生产 Worker handler、陈旧 Job 锁恢复与处理租约心跳、稳定 nonce 对账/幂等投递、Discord 429 调度、确定性 Role reconciliation，以及 Dashboard L2+ 面板修复入口。隔离临时 PostgreSQL 恢复探针仅验证 1 条用户、1 条审计及审计删除保护，已作为更窄的本地基线证据保留，但不满足 `AT-REC-005` 对代表性订单/交易/礼物/返佣/收益/任务/审计、API/Bot 启动、引用完整性和活跃订单连续性的要求；该项已从权威账本移除并保持待验收。当前矩阵为 175 总项、128 自动化覆盖、47 外部待验收、0 外部通过；全量本地候选回归记录为 125 files / 698 tests。真实支付供应商尚未指定，Provider 沙箱对账、真实 Discord AT-REC-003/AT-REC-004、完整 AT-REC-005 恢复演练、最终镜像部署和第二成员 Runbook 演练仍为外部阻断项。证据：`evidence/P0/M5-US-02/summary.md` 与 `evidence/P0/external/AT-REC-005/2026-07-19-local-restore.md`。

- [ ] **M5-US-03：安全审查、业务 UAT 与发布门禁**
  - 前置依赖：M5-US-01;M5-US-02
  - 责任类型：delivery_lead
  - 实现结果：执行权限/隐私/日志检查，按用户/陪玩/L1-L4 流程 UAT，核对配置、回滚条件、阻断缺陷和路线图非目标。
  - 执行步骤：读取合同 → 建立未通过门禁基线 → 执行审查与 UAT → 复验门禁 → 更新证据
  - 关键接口：none
  - 验收用例：AT-AUD-004;AT-RBAC-009;AT-RFP-005
  - 完成定义：UAT、风险接受、配置快照、回滚入口和发布检查表由产品/运营/技术签署。
  - 禁止扩展：不把预约、陪玩试音、用户选陪玩、指定陪玩或其他 P1 能力纳入发布门禁。
  - 进度记录（2026-07-19，未完成）：已交付 fail-closed 发布门禁脚本、非批准配置/签署示例和中文 UAT/安全/恢复/发布检查表。门禁按权威 CSV 动态要求当前 175 条验收无 pending、scope 精确为 P0、零阻断缺陷、候选及回滚镜像、Provider/Discord/备份/Worker 证据，以及产品、运营、客服、技术四方显式签署。当前实际结果为 `ready:false`：47 条外部用例待执行、0 条外部用例通过、0/4 签署且外部证据不全；M5 与发布清单保持未完成。证据：`evidence/P0/M5-US-03/summary.md`。
  - 增补记录（2026-07-19，未完成）：`EXTERNAL_E2E` 的 `PASSED` 外部验收现必须将 `external_candidate_ref` 精确绑定到 `config.releaseCandidate`；任何不同候选的已通过证据都会阻断发布，`summary.passedExternal` 显示已通过外部验收数量。RED：`npx vitest run tests/m5-us-03-release-gate.spec.ts` 因缺少陈旧候选证据 blocker 失败；GREEN：同命令 1 file / 5 tests 通过。关联回归 `npx vitest run tests/m5-us-03-release-gate.spec.ts tests/m5-us-01-traceability.spec.ts` 为 2 files / 32 tests 通过。完整 175 行合成候选回归（47 条匹配候选的外部 `PASSED` 加 128 条自动化 `COVERED_BY_REGRESSION`）返回 `ready:true`、`passedExternal:47`；这不代表真实外部 UAT、签署或发布已完成。
  - 增补记录（2026-07-19，未完成）：已将权威矩阵的 47/47 条 `EXTERNAL_E2E` 验收精确映射至五个可执行 UAT 会话；每行包含标题、合同前置条件、步骤、精确预期、证据与空白结果/签署栏，并统一约束候选引用、request_id、脱敏、失败保留和外部证据账本。RED：`npx vitest run tests/m5-us-03-release-gate.spec.ts` 在通用清单缺少外部 ID 时失败；GREEN：同命令为 1 file / 6 tests 通过。`cmp docs/index.html outputs/index.html` 返回 0，两个索引均链接规范 UAT 与部署/恢复 Runbook。此映射不代表真实外部 UAT、签署或发布已完成；M5-US-03 保持未完成。证据：`evidence/P0/M5-US-03/summary.md`。
  - 增补记录（2026-07-19，未完成）：生产门禁不再默认读取 example 输入，必须显式设置 `P0_SIGNOFF_FILE` 和 `P0_CONFIG_SNAPSHOT_FILE`。任一请求路径或解析后的实际路径含不区分大小写的 `example` 均在读取、矩阵计算和 ready 决策前拒绝；完整的 example JSON 也不能参与发布。显式 non-example fixture 仍进入正常签署/验收判定；`evaluateReleaseGate` 纯函数测试保持独立。RED：`npx vitest run tests/m5-us-03-release-gate.spec.ts` 证明混合大小写 example 路径曾被接受；GREEN：同命令 1 file / 8 tests 通过，关联回归 `npx vitest run tests/m5-us-03-release-gate.spec.ts tests/m5-us-01-traceability.spec.ts` 为 2 files / 53 tests 通过。`env -u P0_SIGNOFF_FILE -u P0_CONFIG_SNAPSHOT_FILE node scripts/p0-release-gate.mjs` 以 1 退出，且只返回两个显式输入 blocker。M5-US-03 的外部 UAT/签署仍未完成。证据：`evidence/P0/M5-US-03/summary.md`。

### 完成门禁
- [ ] 三个 M5 Story 的完成定义全部满足；自动化、沙箱、恢复、安全、UAT 与发布签署均有可追溯证据，且无 P0 阻断项。

## M6：周期结算、周报与业务 Profile

### 启动门禁
- [x] M6 设计规格已批准，合同 RED 基线已建立；实际开发必须依次完成 M6-US-01 至 M6-US-06。
- [x] M6-US-00 合同基线：已冻结六个 Story、23 条重点验收、20 个 operationId、结算/周报模型、整项支付语义、受控充值入口和 Profile 权限边界；合同复核后补齐 Bot Actor Context、Dashboard-only 管理接口、周报 CSV/追加修订、类型与持久化目标匹配、L1 对象范围、支付证据和状态收敛；`tests/m6-us-00-contract.spec.ts` 6/6 通过。

- [x] **M6-US-01：结算批次领域与持久化**
  - 验收用例：AT-SET-001;AT-SET-002;AT-SET-003
  - 完成定义：单币种、截止时间、自动去重、并发唯一归批、Adjustment carry-forward 和作废替代均有数据库证据。
  - 完成记录（2026-07-19）：已实现 `SettlementStore`、内存/PostgreSQL store、预览与批次创建；P0 显式仅选 USD，按 `playerUserId`、CONFIRMED 和独立持久化的截止时间筛选。来源守卫校验唯一归批、同一陪玩、来源状态、截止时间、金额、币种和发生时间。批次只能以未封存 DRAFT 插入，封存时核对非空 Entry→Item→Batch 全部合计，封存后不可追加或改写；VOIDED 为终态且 PARTIALLY_PAID 不可作废，替代目标必须已封存、有效、同币种、无环，关系只能设置一次。late debit 可跨期延迟至正收益足额抵扣；单值及合计超出 JavaScript 安全整数范围时显式失败。聚焦测试 2 files / 25 tests、类型检查、Prisma 校验及迁移保护探针通过；证据：`evidence/P0/M6-US-01/summary.md`。
  - 安全修复记录（2026-07-19）：新增可信 Actor Context 派生且不可变的 Guild 所有权，所有来源、列表、详情、导出和写操作按 Guild 隔离；`000007` 迁移严格回填 `guild_id`、按 Guild 唯一化周期任务并在数据库拒绝跨 Guild 来源。作废合同统一为 `replacementBatchId`，已批准/已导出批次必须在同一事务创建并关联同 Guild/同币种替代批次。聚焦修复回归 7 files / 58 tests、Prisma 与真实迁移门禁通过；证据：`evidence/P0/M6-US-01/summary.md`。

- [x] **M6-US-02：结算复核、导出与支付登记**
  - 验收用例：AT-SET-004;AT-SET-005;AT-SET-006;AT-SET-010
  - 完成定义：四级权限、step-up、高额 maker-checker、CSV 和追加式整项支付结果均通过。
  - 完成记录（2026-07-19）：已交付 Dashboard-only 共享 API，覆盖批次查询、提交、审批、CSV 导出、外部付款结果登记和作废；L2 只读、L3 操作、L4 高额/破坏性权限、step-up、幂等、版本与审计原因均已执行。高额 maker-checker 按真实 Actor 身份判断，不能通过角色继承自批。转账清单固化陪玩显示名、Discord ID 与脱敏外部账号快照，不保存银行信息；付款只登记外部结果，整项成功后才将对应收益置为 PAID，失败可追加重试。审查后新增可升级 `000003` 迁移、事务内成功审计和短账号零字符泄露保护。聚焦测试 3 files / 21 tests，M6-US-01/02 合并回归 5 files / 46 tests，类型、Prisma 与迁移验证通过；证据：`evidence/P0/M6-US-02/summary.md`。
  - 安全修复记录（2026-07-19）：生产入口现已真实注册 PostgreSQL 结算 store，并以 `PostgresIdempotencyStore` 持久化统一安全写入的保留、完成、失败和重放结果；新进程可回放同一响应，fingerprint 冲突继续拒绝。OpenAPI 双镜像新增可信 Dashboard Guild scope、`SettlementBatch.guildId` 与专用 `SettlementVoidInput`；结算仍只记录人工外部转账结果，不调用转账通道。证据：`evidence/P0/M6-US-02/summary.md`。

- [x] **M6-US-03：周期周报与通知**
  - 验收用例：AT-RPT-001;AT-RPT-002;AT-RPT-006;AT-RPT-007;AT-RPT-008
  - 完成定义：个人/汇总周报、修订、NEEDS_REVIEW、周期时区和通知恢复均通过。
  - 完成记录（2026-07-19）：已实现 Guild/USD 范围内个人与汇总周报的原子幂等生成、时区周期边界、`pendingMinor`/`settlementReadyMinor`/实际归批 `batchedMinor` 独立口径和 `NEEDS_REVIEW`。共享 API 提供 L2 读取与当前修订 CSV、L3 近期 step-up 后的追加修订；陪玩自查只返回本人且跨对象统一 404。`000004` 新增周报表、唯一范围键及基础快照/旧修订不可变约束；生成与通知使用 Outbox，私信失败只重试通知。独立审查后新增服务端 Dashboard Guild scope、已归批 ready 排除、跨期 Adjustment、持久化 revision fingerprint、无上限周期重放及反向时长异常标记；`000005` 以可升级迁移补充 fingerprint。聚焦测试 4 files / 21 tests、类型检查、Prisma 校验及迁移验证通过；证据：`evidence/P0/M6-US-03/summary.md`。

- [x] **M6-US-04：Dashboard 结算、周报与客户 Profile**
  - 验收用例：AT-PRF-001;AT-PRF-004;AT-PRF-008;AT-PRF-009
  - 完成定义：结算操作、报告浏览、客户统计/订单/资金明细和模块错误隔离通过。
  - 完成记录（2026-07-19）：已交付 Dashboard 结算、周报和客户 Profile 工作页及 production 路由/API wiring。客户 Profile 使用 `customer_profile.read` 与摘要/订单/资金统一对象 scope；L1 仅已分配订单或客服任务客户，L2-L4 为可信 Guild 组织范围。统计覆盖 30/90/全部窗口、`refundCount` 和完成订单均额；余额精确计算 `ledgerBalanceMinor-reservedMinor`，允许负缺口，Provider 失败返回持久化最后成功快照和 stale/error 元数据，其他模块独立可用。Profile DTO 与 L2 备注脱敏不暴露推荐、受益人、比例、佣金、利润或陪玩收益。新增 `000006_m6_customer_profiles` 只追加快照/备注表与不可变守卫。独立审查后，摘要统计与 admin 资金分页通过订单/礼物/退款/冲正来源链严格过滤可信 Guild；Provider 成功但 stale 的值保持 stale 且不落成功快照；Provider 故障且无历史快照时只返回 nullable balance unavailable/error，Profile 其余模块继续可用。聚焦测试 3 files / 22 tests、类型检查、Dashboard production build、Prisma 校验和全迁移链验证通过；Chromium 1440×900/390×844 四张截图无页面级横向溢出。证据：`evidence/P0/M6-US-04/summary.md`。
  - 安全复核修复（2026-07-19）：客户内部备注增加可信 Guild 来源并按 Guild 查询；`000008_m6_profile_note_guild` 对旧无来源备注保持 NULL 和默认隐藏，不在升级时猜测归属，避免同一客户跨 Guild 泄露内部说明。
  - 回归修复（2026-08-05）：修正结算生成器初始 `currency=CAT`、唯一可选项却显示 `USD` 的受控表单错配，当前界面与主规格、OpenAPI 及 API 校验统一显示并提交 `CAT`；新增渲染回归防止再次出现 USD 假象。结算/Dashboard 相关回归 6 files / 48 tests、类型检查和 Dashboard production build 通过；证据：`evidence/P0/M6-US-04/summary.md`。
  - 空预览修复（2026-08-05）：`req_3c40cadf-267a-4850-9935-fd6e130ac721` 定位为 Dashboard 合法提交 `playerUserIds:null` 时被 API 解析器错判为非数组；现 `null` 明确表示全部陪玩，空数据预览返回 200 零金额快照，Dashboard 显示“当前周期没有可结算的已确认收益”，仅正式生成空批次继续返回 `NO_ELIGIBLE_SOURCES`。同步修正非法日期由未捕获 `RangeError` 变成 400 `VALIDATION_ERROR`。结算跨层回归 7 files / 63 tests、类型检查与 Dashboard production build 通过；证据：`evidence/P0/M6-US-04/summary.md`。
  - 支付登记主题修复（2026-08-05）：结算表格内“登记结果”编辑器移除遗留浅色硬编码，外层、逐项 fieldset、边框与 legend 全部改用 Tactical Ops 深色主题 token，并保留字段可读性与层级阴影。新增视觉合同防止白色卡片回归；关联 3 files / 25 tests、类型检查、Dashboard production build 与 diff check 通过；证据：`evidence/P0/M6-US-04/summary.md`。

- [x] **M6-US-05：Discord 用户 Profile 与陪玩周报**
  - 验收用例：AT-PRF-002;AT-PRF-005;AT-PRF-006
  - 完成定义：当前 Actor 归属、ephemeral 隐私、分页、充值刷新和陪玩本人周报通过。
  - 完成记录（2026-07-19）：已交付 `getCurrentUserProfileSummary`、`listCurrentUserOrders` 与 US03 本人周报列表/详情复用。API 仅从可信 `DISCORD_BOT` Actor Context 解析当前用户/陪玩并按可信 Guild 过滤，跨人/未绑定返回不泄露存在性的 404；Profile 复用 US04 fresh/stale/unavailable 余额模块并提供充值 URL。Self Profile/订单采用显式 DTO 白名单，不返回推荐来源/受益人/比例/佣金、内部备注、风险、利润、Provider 交易标识、陪玩内部 ID 或陪玩收益。Sapphire 个人中心与我的周报全程 ephemeral，Link Button 使用现有 discord.js，长 cursor 通过无截断短 token 还原并保持 custom ID ≤100。聚焦测试 2 files / 8 tests，US03/04 回归共 9 files / 51 tests、全仓 typecheck/build、13 个 Sapphire pieces、Prisma validate 与全迁移链验证通过。证据：`evidence/P0/M6-US-05/summary.md`。
  - 独立审查修复（2026-07-19）：本人周报列表/详情改为 API 专用严格 DTO，不再返回 Guild/player/schedule、修订人员/原因、源事实订单 ID、issues 或 detail snapshot；消费记录按可信 Actor Guild 过滤并覆盖同用户跨 Guild；Provider 全局余额的 `reservedMinor`/`availableMinor` 汇总本人所有 Guild 活动预留，而统计、订单、消费仍按 Guild 隔离；订单、消费和周报分页统一使用 API 资源绑定的紧凑 HMAC cursor，Bot 不保存 Map、不截断且 custom ID ≤100，缺失/跨资源/篡改均拒绝。生产通过 `PAGINATION_CURSOR_SIGNING_SECRET` 注入共享密钥（兼容回退 `BOT_SERVICE_TOKEN`）。复核证据及最终门禁见 `evidence/P0/M6-US-05/summary.md`。

- [x] **M6-US-06：余额不足礼物的充值回流**
  - 验收用例：AT-GFT-012;AT-GFT-013;AT-GFT-014;AT-GFT-015
  - 完成定义：所有启用礼物可选，余额不足零业务写入，充值刷新续接和目录变化重确认通过。
  - 完成记录（2026-07-19）：已交付只读 `checkGiftAffordability` 与 Sapphire 充值回流。所有启用礼物保持可点击；API 原子读取 fresh internal ledger balance 和本人全部 Guild 活动预留，返回价格、目录版本、总预留、可用、精确差额、stale/canAfford 及当前 Guild 受控充值 URL。余额不足/stale 时 GiftRequest、FundReservation、Consumption、客服任务和 Outbox 零写入；ephemeral 仅显示差额、充值 Link、刷新和返回。83 字符 HMAC continuation token 绑定 Actor/订单/礼物/版本/价格并保持 custom ID ≤100，不使用 Map、不接受 receiver。该 Story 当时的单陪玩接收语义已由 M10-US-05 取代：现行请求只接受订单内有效陪玩明细 `participantIds`，真实 receiver 由 API 推导。最终确认重新检查余额与目录快照；价格/上下架/version 或并发预留变化安全回到重确认/不足，PostgreSQL 锁内跨 Guild 竞争预留探针证明不产生坏账。聚焦 + M3 礼物 + US05 + 合同共 22 files / 84 tests，全仓 typecheck/build、13 Sapphire pieces、Prisma validate 和完整迁移保护通过。证据：`evidence/P0/M6-US-06/summary.md`。
  - 安全复核修复（2026-07-19）：礼物目录、余额检查与最终创建均要求可信 Actor Guild 与订单 Guild 一致；PostgreSQL 在锁定订单后再次核对。相同客户的跨 Guild 订单统一返回不泄露存在性的 404，且不会调用 Provider 或写入礼物、预留、任务和 Outbox。

### 完成门禁
- [x] 六个 M6 Story 的合同、实现、原型、自动化和可执行验收证据完整；系统不保存银行卡且不发起实际转账。

## M7：内部 USD 钱包与全量审计

> M7 是获批的后续变更。M0–M6 的完成记录保留为历史实施证据，但其中 Provider 资金、账户绑定、第三方充值链接、支付 Webhook、陈旧 Provider 余额和非 USD 资金语义均由 M7 覆盖，不能作为当前发布能力。

### 启动门禁

- [x] 内部 USD 钱包与全量审计设计已确认；实现按 M7-US-01 至 M7-US-07 严格串行。

- [x] **M7-US-01：合同重整与 RED 验收基线**
  - 验收用例：AT-WAL-001;AT-WAL-010;AT-AUD-005;AT-AUD-008
  - 完成定义：主规格、backlog、OpenAPI、Prisma 合同、状态约束、UI 映射、配置、验收和发布镜像统一；合同测试由 RED 转 GREEN。
  - 完成记录（2026-07-21）：已将当前 P0 合同统一为内部 USD 账本，新增人工充值、渠道退款扣款、可选私有凭证和 AuditLogChange；固定 L1 充值上限为 500000（含），更高要求 L2；所有非只读操作均审计。本 Story 只完成合同与验收基线，不声称运行时功能已经实现。证据：`evidence/P0/M7-US-01/summary.md`。
  - 完成审计补充（2026-07-21）：已将主规格、OpenAPI、验收/fixtures、AGENTS、API 使用说明、交付包首页、业务配置及 HTML Backlog 历史视图的旧 Provider/CNY 资金口径同步为当前内部 USD 钱包边界；合同回归先捕获旧资金口径，再捕获 42 个缺失 fixture 索引，最终 7/7 GREEN。验收矩阵保持 196 条，162 个唯一 `FX-*` 均可解析，outputs/docs 镜像一致。

- [x] **M7-US-02：钱包、凭证与审计变更持久化**
  - 验收用例：AT-WAL-001;AT-WAL-002;AT-AUD-005
  - 完成定义：六张新表、USD/正金额/唯一性/只追加约束和完整迁移链通过。
  - 完成记录（2026-07-21）：新增 `000010_internal_usd_wallet`，建立 WalletAccount、WalletEntry、TopUp、ExternalRefundDebit、ReceiptAttachment、AuditLogChange，并扩展 AuditLog 触发上下文。数据库强制 USD、正金额、充值渠道交易号唯一、类型/方向一致、借记不得造成负账本、凭证父对象与格式约束，以及资金/凭证/审计事实不可 UPDATE/DELETE；运行时、outputs 与 docs Prisma 合同一致。迁移验证脚本改为按目录执行完整迁移链。RED 为缺少 000009；GREEN 为数据库测试 3/3、M0 数据回归合计 9/9、Prisma 校验、完整迁移验证和全仓 typecheck 通过。证据：`evidence/P0/M7-US-02/summary.md`。

- [x] **M7-US-03：通用写操作审计封套**
  - 验收用例：AT-AUD-005;AT-AUD-006;AT-AUD-007;AT-AUD-008
  - 完成定义：Dashboard、Discord、Bot、Webhook、Job 写操作成功/失败/拒绝均可归因；成功变化和审计同事务。
  - 完成记录（2026-07-21）：统一安全写路由现在生成带幂等、Job、触发来源、重试次数和逐对象 `AuditLogChange` 的审计封套；成功至少记录主对象变化，失败与拒绝记录空变化尝试，快照递归脱敏并对超限内容保留哈希摘要。PostgreSQL 审计头与明细事务写入，已有业务 Store 改为复用同一事务内的集中插入；历史迁移 schema 通过能力探测保持兼容。Dashboard logout 已纳入安全写路由，Outbox 成功/失败及人工重试包含系统 Job 归因，生产 Worker 注入 PostgreSQL 审计。旧支付 Webhook 是 M7-US-07 明确删除的退役代码，不作为保留入口扩展。RED 为缺少审计变更模块及数据库原子回滚失败；GREEN 为 Story/API/数据库/Worker 定向 32/32、受影响旧迁移数据库回归 48/48及 typecheck 通过。证据：`evidence/P0/M7-US-03/summary.md`。

- [x] **M7-US-04：充值、渠道退款扣款与凭证 API**
  - 验收用例：AT-WAL-003;AT-WAL-004;AT-WAL-005;AT-WAL-006;AT-WAL-007;AT-WAL-008;AT-WAL-009
  - 完成定义：充值即时到账、权限边界、渠道交易号唯一、非负渠道退款扣款、可选私有附件和审计通过。
  - 完成记录（2026-07-21）：新增内存与 PostgreSQL 钱包服务、余额/流水/充值/渠道退款扣款/Adjustment API，以及私有 receipt 文件存储。L1 可充值至 500000（含），500001 起要求 L2；渠道退款锁定钱包并只使用 availableMinor，数据库与服务均拒绝负余额；Adjustment 要求 L3 和原流水冲正链接。充值和渠道退款在 PostgreSQL 中将账户、证据、流水、审计头及明细同事务提交，审计失败全部回滚。凭证改为资金事实创建后以 evidenceType/evidenceId 一次性绑定，支持 JPEG/PNG/WebP/PDF、10 MiB、SHA-256、私有 opaque key 和授权下载，响应不泄露 storage key。运行时启用钱包时旧 binding 与 Provider balance 路由不再注册；源码退役留 M7-US-07。RED 为模块/权限缺失；GREEN 为 M7 Story 12/12、相关 API/安全回归合计 47/47及完整 build 通过。证据：`evidence/P0/M7-US-04/summary.md`。

- [x] **M7-US-05：订单、礼物与退款迁移到内部钱包**
  - 验收用例：AT-WAL-001;AT-WAL-002;AT-WAL-010
  - 完成定义：订单/礼物预留捕获释放、业务退款、Profile、指标与结算全部使用 WalletService 和 USD。
  - 完成记录（2026-07-21）：订单与礼物提交在既有业务事务内锁定钱包并重算 ledger/reserved/available，统一创建 LOCAL_RESERVATION；订单完成、礼物批准和提前结案捕获分别追加 ORDER_CAPTURE_DEBIT/GIFT_CAPTURE_DEBIT，取消、拒绝和过期仅追加释放事件，业务退款追加 ORDER_REFUND_CREDIT。Profile、交易时间线、Dashboard 指标与结算统一为 USD 钱包/消费事实，资金路径不再执行 Provider balance、hold、debit 或 refund 调用；旧 Provider 源码与 Webhook 的物理删除留给 M7-US-07。受影响的旧 Provider/CNY 测试已按新合同重写；M1-M7 定向回归 32 files / 85 tests、M7 合同与钱包回归 9 files / 28 tests、typecheck、build 和 diff check 均通过。证据：`evidence/P0/M7-US-05/summary.md`。

- [x] **M7-US-06：Dashboard 钱包与 Discord 客服引导**
  - 验收用例：AT-WAL-003;AT-WAL-007;AT-WAL-009
  - 完成定义：Dashboard 钱包操作和 Discord 联系客服/内部余额流程通过，客户端不复制权限与资金规则。
  - 完成记录（2026-07-21）：客户 Profile 新增内部 USD 钱包余额、充值、渠道退款扣款、可选 receipt 上传和 WalletEntry 流水；资金事实先创建、附件后绑定，处理期间禁用重复提交，失败重试保持原幂等键。必填字段为金额、渠道、渠道交易号、付款/退款时间和备注，图片/PDF 可选。Discord 服务中心、Profile、订单与礼物余额不足流程改用内部账本字段并保持 ephemeral，只引导联系客服提交付款 receipt，不再展示充值链接；Bot binding 客户端、Modal、路由和提交处理已移除。客户端回归 30 files / 139 tests、Bot/Dashboard typecheck、全仓 build、Dashboard production build 和 diff check 通过。全仓探针仍有 59 个旧 Provider/CNY/历史数据库夹具失败，明确留给 M7-US-07，当前不是发布候选。证据：`evidence/P0/M7-US-06/summary.md`。

- [x] **M7-US-07：Provider 资金能力退役与发布门禁**
  - 验收用例：AT-WAL-010;AT-AUD-008
  - 完成定义：运行时 Provider 资金、绑定、支付 Webhook、充值链接和旧环境变量完全移除；全量验证与 M7 发布证据通过。
  - 完成记录（2026-07-21）：已删除支付适配器、HTTP Provider 客户端、支付 Webhook、路由注册、环境变量与充值 URL；客户 Profile、订单、礼物和退款只使用内部 USD 钱包，不再读取客户第三方支付账户或余额快照。退役测试确定性盘点 71 个 API 写路由与 10 个 Worker handler 的通用审计覆盖。全量 `npm test` 为 133 files / 682 tests，typecheck、build、Prisma validate、完整迁移链（`migration-apply-ok`、66 tables）、`npm audit`（0 vulnerabilities）和 diff check 均通过。验收矩阵重建为 189 条。证据：`evidence/P0/M7-US-07/summary.md`、`evidence/P0/gates/M7.md`。

### 完成门禁

- [x] 七个 M7 Story 的合同、实现、迁移、客户端、退役扫描和自动化证据完整；真实外部 UAT 与最终发布签署仍按发布清单独立完成。

## M8：可配置客户代币展示

> M8 只改变客户钱包与消费的展示层。API、数据库、审计、阈值、员工操作、陪玩收益、返佣、周报、结算和外部转账事实继续使用 USD minor units；固定关系为 `1 USD = 10 MB`，不新增第二账本或汇率配置。

### 启动门禁

- [x] 客户代币展示设计已确认；默认名称/符号为“猫币 / MB”，仅名称与符号可全局替换。

- [x] **M8-US-01：合同同步与 RED 验收基线**
  - 验收用例：AT-TKN-001;AT-TKN-003;AT-TKN-004;AT-TKN-005
  - 完成定义：主规格、OpenAPI、配置、UI 原型/映射、backlog、验收、TODO 和发布镜像统一；合同测试由 RED 转 GREEN；不修改 Prisma 或迁移。
  - 完成记录（2026-07-21）：已冻结固定 `1 USD = 10 MB`、默认“猫币 / MB”、全局可替换名称/符号及客户代币/员工与 payout USD 的显示边界；API、数据库和审计继续使用 USD minor units，未修改 Prisma 或迁移。合同 RED 明确缺少 M8 扩展与 Story，GREEN 为 3 files / 71 tests，验收矩阵由 189 增至 196 条，镜像逐字节一致。本 Story 不声称运行时展示已经交付。证据：`evidence/P0/M8-US-01/summary.md`。

- [x] **M8-US-02：展示配置与精确格式化**
  - 验收用例：AT-TKN-002;AT-TKN-003;AT-TKN-007
  - 完成定义：全局名称/符号校验、固定十倍整数格式化和登录前失败关闭通过；比例不可配置。
  - 完成记录（2026-07-21）：新增 `wallet-display` 模块，以 BigInt 对 USD minor units 做固定十倍、两位小数和千位分组；1 cent 精确显示 `0.10 MB`，非 safe integer 或非法配置失败。默认“猫币 / MB”可由两个全局环境变量替换，比例没有环境变量；Bot 在 Piece discovery/登录前校验，生产发布校验同步。RED 为模块不存在；GREEN 为 3 files / 32 tests、typecheck、build 和 diff check。发布门禁同时补齐两条 M8 外部 UAT 映射。本 Story 尚未接入客户消息。证据：`evidence/P0/M8-US-02/summary.md`。

- [ ] **M8-US-03：客户 Bot 接入与发布门禁（自动化候选已通过，等待外部 UAT）**
  - 验收用例：AT-TKN-004;AT-TKN-005;AT-TKN-006
  - 完成定义：客户钱包、订单、礼物、消费、取消和系统内退款只显示代币；员工与 payout 视图只显示 USD；全量门禁通过。
  - 候选记录（2026-07-21）：Bot 已拆分客户代币与 USD payout 格式化路径；钱包、订单、礼物、消费、取消和完成扣款按配置代币显示，返佣、陪玩收益、工作台、派单和周报保持 USD。服务中心只显示非金额收益状态，避免与 MB 钱包双币同屏；Dashboard 钱包操作继续 USD，仅展示固定发放说明且不并排计算。选择性渲染 RED 及审查补充 RED 均已转绿；完成审计后的全量门禁为 136 files / 709 tests、typecheck、build、Prisma、66 表完整迁移、audit（0 vulnerabilities）和 diff check 全通过。`AT-TKN-004/005` 外部 UAT 仍待执行，因此本 Story 保持未完成。证据：`evidence/P0/M8-US-03/summary.md`、`evidence/P0/gates/M8.md`。

### 完成门禁

- [ ] 三个 M8 Story 的合同、实现、客户端选择性渲染和全量自动化候选证据已就绪；完成 `AT-TKN-004/005` 真实外部 UAT 后才能关闭 M8。

## M9：Discord 自助入驻与 CAT 内部账本（进行中）

> M9 是现行资金和新人入驻合同：付款事实固定 USD cents；内部唯一账本固定猫条 / CAT；`1 USD = 10 猫条`，即 `1 USD cent = 1 CAT subunit`。此前 Provider、绑定码、Sandbox funding、canonical USD 账本和可配置 MB 展示语义均已被取代。

- [x] `M9-US-01` 合同与验收基线：设计与实施计划已冻结；主规格、backlog、验收和 API/数据镜像已同步候选。
- [x] `M9-US-02` CAT 数据迁移与只追加事实：新增 `000011_cat_wallet_onboarding`、USD 充值证据、审核事件、入口消息和产品角色任务。
- [x] `M9-US-03` 玩家注册与陪玩申请 API：可信 Discord Actor Context、幂等建档、CAT 钱包、待审档案与审计事务已实现。
- [x] `M9-US-04` 固定 USD 入金与 CAT 钱包 API：L2+、近期验证、完整依据、固定换算和非负只追加账本已实现。
- [x] `M9-US-05` Discord 常驻入口与角色补偿：两个中文按钮、私密反馈、消息恢复和角色重试任务已实现。
- [x] `M9-US-06` Dashboard 充值与陪玩审核：USD 表单、CAT 预览、批准/拒绝和角色切换任务已实现。
  - 修复记录（2026-08-02）：修复首次批准陪玩时新 `skill_tags` 漏写 UUID，以及状态、标签、审核事件和 Discord 产品 Role 任务未在同一事务提交的问题；新增成功写入与后续失败完整回滚的 PostgreSQL 回归。失败请求 `req_591b7a32-f248-49e4-b784-23c7280c264e` 的半完成测试记录已通过只追加方式补齐 `VALORANT` / `RANKED` 关联，保留原审核与 Role 任务事实。证据：`evidence/P0/M9-US-06/summary.md`。
- [ ] `M9-US-07` Provider 退役与 Railway 发布门禁（自动化候选已通过，等待外部 UAT）：运行时、环境变量和部署手册已移除外部资金 Provider 与 provision；真实 Discord Guild 和 Railway 候选仍需签署。
- [ ] `M9-US-08` 统一业务标签库与受控选择：本地候选已实现；AT-TAG-001～004 自动化聚焦回归 131/131 通过，迁移已应用，待登录 Dashboard 后浏览器 UAT 签署。证据：`evidence/P0/M9-US-08/summary.md`。
  - [ ] `M9-US-09` Discord 客户常驻下单入口：玩家入口常驻消息新增“开始找陪玩”，并接通私密频道与统一订单 API。2026-08-05 修复恢复提交失败：此前 `req_0c151360-45b8-4d05-813d-0f617723d829` 已定位为 `COMMIT_FAILED`，恢复事件改用既有 `CHANNEL_LINKED` 并让订单更新事务持久化替换后的频道/面板映射，无需新增数据库枚举。Bot 校验旧频道，缺失时调用 `recoverOrderChannel`，订单状态和资金不变；客户明确拒绝管理频道，L1-L4 客服可管理。Postgres/API/Bot 目标测试和类型检查通过，待 API/Bot 重启后的真实 Guild 删除/恢复 UAT。证据：`evidence/P0/M9-US-09/summary.md`。
    - 可选区服修复（2026-08-02）：确认面板不再把空区服判为信息不完整，改为显示“无指定区服”并允许提交；RED 1 failed / 7 passed，GREEN 关联 3 files / 29 tests。
    - 刷新状态分流修复（2026-08-02）：已提交订单刷新不再回到草稿确认，`EDIT_ORIGINAL_MESSAGE` 统一原位更新；RED 1 failed / 8 passed，GREEN 关联 4 files / 30 tests，最终 build + 155 files / 779 tests 全通过。`P-374DF0C3` 的 5 条错误确认卡已精确删除，当前匹配消息和数据库面板保留。
  - [ ] `M9-US-10` 陪玩项目分成覆盖：服务目录改为默认分成比例，支持每位陪玩按项目设置百分比或每单位固定金额，并在接单时固化最终收益；Dashboard 现将多个窗口草稿汇总二次确认并用原子批量 API 保存，任一冲突则整批不写入；待 Dashboard 与真实成功接单 UAT。证据：`evidence/P0/M9-US-10/summary.md`。
    - 可见列表回归（2026-08-05）：设置项目分成不再使用服务项目下拉框，改为始终可见的项目规则列表；每行同时展示个人分成、项目默认分成、区服与计费单位，点选后仍按乐观版本单条保存。RED 1/6，GREEN 关联 3 files / 36 tests、typecheck 与 Dashboard production build 通过；真实员工浏览器 UAT 仍待补录，Story 保持未勾选。
    - 草稿确认回归（2026-08-05）：分成输入即时缓存于当前窗口并回显“草稿已缓存”；点击提交后额外弹出确认窗口，展示项目、原分成、新分成和修改方式，只有“确认并保存”才请求服务端，取消或关闭不写入。RED 1/7，GREEN 关联 3 files / 37 tests、typecheck 与 Dashboard production build 通过；真实员工浏览器 UAT 仍待补录，Story 保持未勾选。
  - [ ] `M9-US-11` 服务与礼物目录归档删除：操作列新增删除入口，服务/礼物实体归档并退役活动版本，历史订单、礼物请求和金额快照保持不变；待真实 Dashboard UAT。证据：`evidence/P0/M9-US-11/summary.md`。
  - [ ] `M9-US-12` 订单频道 transcript 事件：Bot 实时追加消息创建、编辑和删除事件，API 从可信 Guild + channel 派生订单与 ticket number，数据库 append-only 并按 ticket 索引。2026-08-07 已定位此前 260 次失败为 `blackcat_app` 缺少新表权限，新增仅含 `SELECT, INSERT` 的 `000037` 授权迁移；迁移链、聚焦测试与真实 API→PostgreSQL 写入探针均通过。既有失败消息仍待清理 Story 完整回填，创建/编辑/删除三类真实 Guild UAT 仍待执行。证据：`evidence/P0/M9-US-12/summary.md`。
  - [ ] `M9-US-13` 订单提交后手动开始候选池：M11-US-05 已取代下述历史六档等待实现。现行入口为“开始招募”按钮，新池无截止时间且仅客户手动终止；历史实现和证据仍保留在 `evidence/P0/M9-US-13/summary.md`，待按新合同完成真实 Guild 复验。
  - [ ] `M9-US-14` 客户优先派单名单：API 与派单层保留最多三名有序名单、首轮合格人选优先、无合格人选即时使用普通池及 90 秒后回退语义；为与 M10-US-09 四步点菜原型一致，旧 Discord User Select 已从向导移除，待独立入口设计与真实 Guild 接单 UAT。证据：`evidence/P0/M9-US-14/summary.md`。
  - [ ] `M9-US-15` 历史自动/手动派单模式：该 Story 的自动轮次、开关与 90 秒单轮语义已被 M11-US-05 取代；当前 API 不再返回、写入或消费旧配置，生产组合也不装配 first-wins Dispatch store。真实 Guild 验收应按客户手动无时限候选池执行，旧证据仅作历史记录。现行收口证据：`evidence/P0/api-review-legacy-dispatch-retirement/summary.md`。
  - [ ] `M9-US-16` 客服选人派单：L2+ Dashboard 实时列出合格陪玩，可选最多三人或全池发出 90 秒抢单；显式人选在提交时重新校验且不静默回退。后台自动化候选已完成，Bot 客服入口和真实 Guild UAT 待后续。证据：`evidence/P0/M9-US-16/summary.md`。
  - [ ] `M9-US-17` 接单后语音房与三方通知：接单成功后 Worker 幂等创建私密语音房，客户/陪玩可进入，已配置 L1-L4 Role 可管理；Ticket @客户、客服任务频道分别发送同一语音链接。自动化与真实订单三项结果已验证；当前 Guild 尚未配置 L1/L3 Role，完整四级 Role UAT 待配置后复验。证据：`evidence/P0/M9-US-17/summary.md`。
    - 客服协调卡增强（2026-08-04）：客服任务频道的匹配成功通知已改为详细 embed，展示订单状态、客户、全部已匹配陪玩、游戏/服务/区服/时长/人数/需求备注、下单与匹配时间，并提供订单文字频道和协调语音房直达按钮；遵守 Story 边界，不展示金额、余额、支付或内部定价。RED 2 failed / 10 passed；GREEN 目标 12/12、关联 3 files / 22 tests、合同镜像 10/10、typecheck/build 与全仓 182 files / 903 tests 通过。真实 Guild 视觉 UAT 仍待复验。
  - [ ] `M9-US-18` 订单面板投影一致性：提交、取消、readiness、超时、自动化控制、客服结案和转派事务均原子写入幂等 `PANEL_SYNC`；Worker 已改用 Components V2 原生负载，显示多陪玩到位/总席位并为全部 ACTIVE 陪玩同步频道权限，客户刷新同样显示剩余席位。专项 4 files / 18 tests通过，待真实 Guild 重启恢复与全席位 readiness UAT。频道删除的 transcript 前置门禁已由 M9-US-19 实现，仍待联合真实 UAT。证据：`evidence/P0/M9-US-18/summary.md`。
  - [ ] `M9-US-19` 终态订单频道封存与僵尸清理：完成、取消和客服终态结案事务原子写入版本化 `CHANNEL_ARCHIVE`；保留期只允许 0–60 分钟且默认 60，Worker 等待最终面板同步、锁定文字频道为只读、分页幂等回填 transcript，成功后先删选秀/服务语音、最后删文字频道，并以启动及每分钟扫描恢复历史漏单；策略缩短时会提前尚未执行的旧 Pending Job。本次上限收紧 RED 2 files / 2 failed，GREEN 核心/PostgreSQL 2 files / 8 tests、合同/配置关联 5 files / 24 tests；重启真实 Worker 补建或提前 14 条到期任务且 14/14 成功，Discord 只读核对 14 个到期订单的 26 个相关频道均为 404。尚缺单频道 100+ 消息真实分页与人工签署，Story 保持 IN_PROGRESS。证据：`evidence/P0/M9-US-19/summary.md`。
    - 客服协同卡跨状态收敛（2026-08-07）：`ACCEPTED` 创建的原协同卡会在后续 `IN_SERVICE`、`PENDING_CONFIRMATION`、`COMPLETED`、`CANCELLED` 面板同步中按稳定 nonce 原位更新状态、参与人、需求及订单/语音入口；原卡不存在时跳过，不补发重复消息。RED 1 file / 4 failed / 14 passed；GREEN 4 files / 41 tests、typecheck/build/diff check 通过。消息对账边界按本轮要求暂不扩展，真实 Guild UAT 仍待执行。
    - 重复刷新详情修复（2026-08-07）：已取消多项目订单不再因主记录兼容字段为空而显示“未选择”；刷新会只读获取 ACTIVE 订单需求并渲染真实游戏、服务、区服、时长与人数。RED 1 failed / 13 passed，GREEN 1 file / 15 tests，关联 7 files / 54 tests、完整 Bot 22 files / 128 tests、typecheck 和 build 通过；待真实 Guild 对 `P-336171B3` 连续刷新复验，Story 保持未勾选。
    - 全状态刷新修复（2026-08-06，未完成）：所有订单向导与持久面板统一加入无版本 `bc:order:<orderId>:refresh`，只读获取 API 最新事实；`ACCEPTED` 刷新会恢复“我已就绪”，服务中/待确认恢复对应主操作，Worker Components V2 同步使用相同路由。聚焦 4 files / 48 tests、完整 Bot + Worker 23 files / 138 tests、typecheck/build 通过；待真实 Guild 部署、历史面板 repair 与陪玩点击 UAT，Story 保持未勾选。
    - 客户终选就绪入口修复（2026-08-06，未完成）：真实订单 `P-336171B3` 终选后虽已为 `ACCEPTED` 且存在 ACTIVE 参与人，但终选事务未投递新版 `PANEL_SYNC`、未设置 `readiness_due_at` 或 `READINESS_TIMEOUT`，导致 Discord 保留旧匹配卡且陪玩没有“我已就绪”。现已在终选原子事务中补齐三项事实；RED 2 files / 2 failed，GREEN 聚焦 2 files / 6 tests、关联 9 files / 46 tests、typecheck/build 通过。当前运行候选位于另一临时目录，尚未部署或原位修复该订单；待受权 panel-repair 与真实陪玩点击 UAT，Story 保持未勾选。
  - Discord UAT 修复（2026-08-02，未完成）：真实下单确认频道分类和 Bot 权限有效，定位订单草稿面板错误地在单个 Action Row 放置两个 String Select，Discord 拒绝面板消息后触发频道清理。新增组件合同 RED（1 failed / 13 passed），将四个 Select 拆为四行并保留第五行操作按钮后 GREEN 14/14；关联回归 3 files / 25 tests、Bot typecheck 和项目 build 通过。两个指向已清理频道的失败 `DRAFT` 已经正式 preview/cancel API 追加取消，均为 `CANCELLED` 且未涉及资金预留；Bot 重启后 ready、配置缓存和常驻入口恢复成功。待客户真实成功下单和重复点击恢复 UAT；Story 保持未勾选。
  - Discord 草稿交互修复（2026-08-02，未完成）：Select handler 原占位实现只发送 ephemeral 回执且未写订单，造成消息堆叠；确认请求 `req_b48a685d-eb10-434f-8a36-e9ce619ae232` 又暴露普通客户钱包读取未按 Discord 绑定解析。RED 2 files / 2 failed / 17 passed；现改为静默 defer、统一 API 更新和原位 edit，并让余额读取通过可信 Guild + Discord 绑定解析客户，GREEN 聚焦 2 files / 19 tests、关联回归 5 files / 29 tests、项目 typecheck/build 通过，真实客户余额 API 200；API 热更新且 Bot 重启成功。旧选择未入库，需重新选择四项并继续真实 UAT；Story 保持未勾选。
  - 订单常驻菜单补强（2026-08-02，未完成）：草稿、待匹配、已接单、服务中、待确认与异常处理面板均保留状态允许的取消/申诉以及就绪或完成动作；申诉正式创建 `ORDER_ASSIST` 客服任务，Select 失败会恢复订单面板而不是清空控件。RED 2 files / 4 failed / 9 passed；GREEN 关联回归 5 files / 39 tests、项目 build 通过。失效草稿 `P-92C0809B` 已原位恢复，Bot 重启 ready；仍待完整真实状态流 UAT，Story 保持未勾选。
  - 数据库目录联动修复（2026-08-02，未完成）：真实选择因 Bot 提交旧 `game/service/region` 字段而被 API `VALIDATION_ERROR` 拒绝，且运行时 DETAILS_UPDATED 事件序号固定 1 会与 CREATED 冲突回滚。现订单菜单读取 ACTIVE `/services`，以 `serviceCatalogId + unitCount` 原子更新，新订单自动按目录 minimumUnits 初始化，事件序号使用更新后订单版本。事件 RED 1 failed / 6 passed；GREEN 3 files / 25 tests，最终关联 6 files / 41 tests、typecheck/build 通过。`P-92C0809B` 已正式初始化为版本 2 并原位重建数据库驱动面板，Bot 重启 ready；待用户继续真实选择与确认 UAT，Story 保持未勾选。
    - Discord Embed 信息层级优化（2026-08-02，未完成）：个人中心、余额、订单/消费列表、周报、订单/生命周期、礼物等结构化 `MessageSpec` 统一渲染为品牌 Embed，交互组件保留在卡片下方；单行结果和错误仍使用普通文字。所有 edit/update 路径同步传递 embeds 并清除旧 content。RED 1 file / 2 failed / 2 passed；GREEN 聚焦 5 files / 39 tests，最终关联 6 files / 41 tests、typecheck/build 通过。当前 `P-92C0809B` 已原位升级 Embed，Bot 重启 ready；待跨页面真实 Discord UAT，Story 保持未勾选。
    - 服务展示名称修复（2026-08-03，未完成）：统一 API 将 PostgreSQL 已查询但曾被 DTO 丢弃的 `game_name/service_name` 作为 `gameDisplayName/serviceDisplayName` 返回；Bot 摘要与 Select label 使用后台展示名称，value 继续使用服务版本 UUID，稳定代码和业务规则不变。OpenAPI 双镜像同步；RED 3 files / 4 failed，GREEN 聚焦 32 tests、关联 26 files / 131 tests、typecheck/build、Prisma、镜像和 diff check 通过。待真实 Guild 刷新旧消息复验，Story 保持未勾选。
    - 展示名称横向修复（2026-08-03，未完成）：订单新增独立区服名称快照并正确固化 game/service/region 展示名称；`000018` 按服务版本回填已有订单。派单 Outbox、陪玩工作台、客服工作台、陪玩标签表格和分成项目下拉统一显示名称，稳定代码继续用于匹配、资格与提交。聚焦 9 files / 74 tests、最终关联 30 files / 159 tests、typecheck/build、Prisma、完整迁移链与合同镜像通过。证据：`evidence/P0/M9-US-09/summary.md`；待真实 Guild 刷新旧消息复验，Story 保持未勾选。
  - Dashboard 视觉门禁补充（2026-08-02，未完成）：完成六个已发布后台页面的全量布局审查与统一样式迁移，服务版本表单改为稳定 label-on-top 自适应网格，表格、状态、操作面板、指标和移动导航统一；浏览器在 375/768/1024/1440px 均无页面级横向溢出。RED 为 `tests/dashboard-release-ui.spec.ts` 3/3 失败；GREEN 为定向 6 files / 37 tests、追踪与视觉 2 files / 66 tests、最终 `npm test` 151 files / 751 tests，typecheck 与 Dashboard build 通过。证据：`evidence/P0/M9-US-07/summary.md`。真实外部 UAT、Railway 部署和签署仍未完成，Story 保持未勾选。
  - Dashboard 科技主题精修（2026-08-02，未完成）：在既有清晰布局上增加克制的紫青能量渐变、HUD 分隔线、玻璃面板高光、数据角标和低频品牌呼吸光；375px 与 1470px 真实浏览器复验均无页面级横向溢出，reduced-motion 约束保留。视觉合同 4/4、Railway 单文件 14/14、4 workers 完整回归 151 files / 752 tests、typecheck 与 Dashboard build 通过。证据：`evidence/P0/M9-US-07/summary.md`；外部门禁状态不变。
  - Dashboard Tactical Ops 深色候选（2026-08-03，未完成）：统一深色石墨工作区、切角业务面板、四组导航、可信会话状态轨、查询模块与等宽数据表，并保留 focus、44px 触控目标和 reduced-motion。RED 为视觉合同 2 files / 3 tests 失败；GREEN 为视觉合同 2 files / 9 tests、全部 Dashboard 回归 15 files / 69 tests，typecheck、Dashboard build 与 `git diff --check` 通过；375/768/1024/1440px 浏览器复验均无页面级横向溢出。证据：`evidence/P0/M9-US-07/summary.md`；真实员工 UAT、Railway、Discord Guild 与最终签署仍未完成，Story 保持未勾选。
  - Bot 长文案抽离（2026-08-03，未完成）：新增强类型 `bot-copy` 目录，集中欢迎词、完整状态说明、客户通知和动态错误反馈；短按钮标签仍就近维护，未引入 i18n。RED 为模块缺失；GREEN 聚焦 5 files / 12 tests，Bot 全量专项 23 files / 112 tests、Bot typecheck、根级 build 与 diff check 通过。证据：`evidence/P0/M9-US-07/summary.md`；真实 Discord 文案 UAT 不变，Story 保持未勾选。
  - 黑猫电竞 Discord 品牌文案（2026-08-03，未完成）：欢迎、登记、下单、匹配、客服、完成、取消、申诉、礼物和接单回复统一为“可靠事实 + 克制猫舍氛围”，关键金额、状态、处理边界和 request_id 保持直白；Discord Role 与业务逻辑未改。RED 文案契约 1/2 失败，GREEN Bot 专项 23 files / 112 tests、Bot typecheck、根级 build 与 diff check 通过。证据：`evidence/P0/M9-US-07/summary.md`；待真实 Guild 文案 UAT，Story 保持未勾选。
  - 黑猫陪玩 Bot 文案与信息层级精修（2026-08-07，未完成）：新人入口、四步下单、服务中心、钱包/Profile、订单生命周期、陪玩工作台、候选池和礼物流程统一为 emoji 标题、事实分组与明确下一步；颜文字只在欢迎语出现一次，金额、状态、权限、失败原因和 request_id 保持直白。RED 为文案契约 2/3 失败；GREEN 聚焦 3/3，完整 Bot 为 47 files / 259 tests 通过，另有改动前已存在的 `M17-US-08` 两项失败。Bot typecheck、根级 build、Bot Prettier 与 diff check 通过；本地依赖缺少 ESLint 运行包，lint 未执行。证据：`evidence/P0/M9-US-07/summary.md`；真实 Guild 排版与语气 UAT 仍待执行，Story 保持未勾选。
  - Dashboard 动态表头补齐（2026-08-03，未完成）：修复服务目录等 DTO 未命中中文映射后统一显示“数据字段”的问题，补齐服务、订单、陪玩、礼物、资金与运营任务字段，英文原字段继续保留在 Tooltip；未知字段改为可辨识的 `未映射字段：<原字段>`。RED 首个服务字段失败；GREEN 表头 3/3、Dashboard 专项 16 files / 75 tests、typecheck、production build 与 diff check 通过。证据：`evidence/P0/M9-US-07/summary.md`；待真实员工浏览器 UAT，Story 保持未勾选。
  - Dashboard 筛选光效定位（2026-08-03，未完成）：修复 `QUERY FILTERS` 标题与顶部能量线共用 `::before` 导致光效下移的问题，文字与光效拆为独立伪元素，光条固定在面板上边缘且可爱主题继续隐藏。RED 视觉合同 1/7 失败；GREEN 聚焦 2 files / 11 tests、Dashboard build 与 diff check 通过。证据：`evidence/P0/M9-US-07/summary.md`；待真实浏览器截图 UAT，Story 保持未勾选。
  - Pilot 全阶段开放（2026-08-04，未完成）：本地 `.env`、开发/生产示例与 Railway Sandbox 手册已统一为 `PILOT_PHASE=OFF`，运行时解析为 `CORE_ORDER + GIFTS + REFERRALS + M6`；API、Worker、Bot、Dashboard 已本地重启 ready，相关 3 files / 19 tests 通过。Railway CLI 尚未关联项目，外部 `web` 变量与重部署待完成；证据：`evidence/P0/M9-US-07/summary.md`，Story 保持未勾选。
  - Pilot 运行时限制退役（2026-08-05，未完成）：生产启动不再读取或要求 `PILOT_PHASE`，统一固定开放 `CORE_ORDER + GIFTS + REFERRALS + M6`，部署环境遗留的 `CORE_ORDER` 不再隐藏礼物、返佣、结算入口或触发 `FEATURE_DISABLED`。开发/生产示例与 Railway 手册移除该变量；`BUSINESS_ENV=SANDBOX` 继续只提供测试资金提示，不参与功能裁剪。RED 为 M9 发布门禁 2/2 失败；GREEN 为发布/环境关联 5 files / 28 tests、跨 API/Bot/Dashboard 8 files / 53 tests、类型检查与 Dashboard production build 通过。仍待重新部署及真实员工/Guild UAT，Story 保持未勾选；证据：`evidence/P0/M9-US-07/summary.md`。
  - Dashboard 业务卡片工作区与详情浮层（2026-08-04，未完成）：陪玩、服务目录、服务套餐统一改为订单式信息卡片流，保留既有操作并在“查看详情”中打开原位置浮层；服务目录/套餐使用已裁剪的列表快照，陪玩保留既有 API 详情，不新增浏览器端业务规则或服务端端点。详情字段使用中文标题，套餐席位不再显示 `[object Object]`。RED 为新增卡片门禁失败；GREEN 为聚焦 3 files / 14 tests、Dashboard 关联回归 6 files / 27 tests、typecheck、production build 与 diff check 通过。独立浏览器缺少员工登录会话，真实截图/操作 UAT 仍待补录；证据：`evidence/P0/M9-US-07/summary.md`，Story 保持未勾选。
  - Dashboard 四类对象详情重排（2026-08-04，未完成）：用户、陪玩、服务目录与服务套餐不再共用原始字段纵向转储；分别改为客户概览、陪玩支持范围、目录价格/计费和套餐席位阵容的语义化详情，保留现有 API 快照、权限与资金事实，套餐价格继续只展示 API 派生值。RED 为 `tests/dashboard-card-workspaces.spec.ts` 新增四类详情门禁后 4/8 失败；GREEN 为 Dashboard 关联 5 files / 41 tests、根级 typecheck、production build 与 diff check 通过。真实员工浏览器截图与操作 UAT 尚未补录，Story 保持未勾选；证据：`evidence/P0/M9-US-07/summary.md`。
  - Dashboard E2E 自动化候选（2026-08-05，未完成）：按 `Dashboard-E2E自动化测试开发计划.md` 实现 101 个唯一 `DE2E-*` ID，覆盖认证/RBAC/Guild、客服、订单、用户、陪玩、目录/套餐、礼物/收益、钱包/档案、结算/周报、治理、恢复、无障碍与兼容性 smoke；覆盖校验为 101 planned = 101 implemented，零缺失/额外/重复。Chromium full 为 101/101，通过可视化 headed 示例；空库单命令完成 33 migrations、测试和清理。稳定性门禁先捕获并修复 PLY-005、PKG-001/005 提交读取竞态，定向 20/20 与 40/40 后，从零重新累计 10 个 full suite，最终 1,010/1,010 通过且 retry=0。Chromium/Firefox compatibility 通过；本机 macOS 14 ARM64 的 frozen WebKit 在 page 创建前因 `PushAPIEnabled` 协议不匹配失败，受控省略该不支持协议设置后，未修改的已提交 WebKit spec 1/1 通过且依赖文件立即恢复；Ubuntu 定时 CI 保留 stock WebKit 执行且不跳过。浏览器 fixture 仍是确定性 Fastify/domain/worker adapter，并非所有场景走生产 PostgreSQL repository 或独立生产 API/Worker 进程；真实外部 UAT 与发布门禁不因此完成。证据：`evidence/P0/dashboard-e2e/README.md`、`evidence/P0/dashboard-e2e/acceptance.md`。
  - Dashboard 现实订单场景 E2E（2026-08-05，未完成）：新增 36 笔确定性订单背景数据，合法状态覆盖 ACCEPTED、PENDING_DISPATCH、IN_SERVICE、PENDING_CONFIRMATION、COMPLETED、CANCELLED、EXCEPTION，并新增 `DE2E-ORD-012`–`016`。浏览器复验两页无重复遗漏；老板开玩前取消由 L2 在订单页全额处理且其余 35 单不变；玩到一半求助由 L1 在客服工作台认领、查看订单、保存双方核对证据，再由 L2 在订单页部分退款并保留对应陪玩收益；另覆盖网络卡顿同幂等键重试及 terminal/stale/超额退款混合拒绝。RED 为批量 seed 端点 404（5/5 failed）；GREEN 新场景 5/5、TypeScript、覆盖门禁 106=106；完整 Chromium 先因既有 GFT-001 提交读取竞态 105/106，增加完成等待与事实轮询后定向 10/10、最终 106/106 通过。浏览器 fixture 边界与外部 UAT 状态不变。证据：`evidence/P0/dashboard-e2e/acceptance.md`。
  - Dashboard 日常客户 Profile 与钱包 E2E（2026-08-05，未完成）：新增 24 位确定性客户背景数据及 `DE2E-USR-004`–`005`、`DE2E-WLT-009`–`010`。L2 从列表筛选准确打开老板的只读身份 Profile，核对私有线下转账附件后充值；异常付款由 L2 追加风险事实并由 L3 暂停服务；渠道退款只追加 USD debit，保持 reservation 和余额恒等式且不修改其他客户。RED 为 `/__e2e/users/bulk` 缺失 4/4 failed；GREEN 新场景 4/4、TypeScript、覆盖门禁 110=110。当前证据仍为确定性 Fastify 浏览器 fixture，不声称所有写入经过生产 PostgreSQL repository；完整 110-case 回归留在最终聚合门禁执行。证据：`evidence/P0/dashboard-e2e/acceptance.md`。
  - Dashboard 日常陪玩业务 E2E（2026-08-05，未完成）：新增 12 位待审申请背景数据及 `DE2E-PLY-008`–`009`。L3 店长从待审队列核验目标档案，批准受控游戏/服务/语言范围，处理后续语言变更并设置新人试用分成；身份资料不完整路径要求明确拒绝说明，且不产生业务范围或分成残留。按现有合同，陪玩身份来自申请流程，Dashboard 不提供凭空创建身份。RED 为 `/__e2e/players/bulk` 缺失 2/2 failed；GREEN 新场景 2/2、TypeScript、覆盖门禁 112=112。浏览器 fixture 与外部 UAT 边界不变。证据：`evidence/P0/dashboard-e2e/acceptance.md`。
  - Dashboard 日常目录上新、改价和下架 E2E（2026-08-05，未完成）：新增 `DE2E-CAT-005`、`DE2E-PKG-006`、`DE2E-GFT-005`。覆盖老板要求服务改价时创建替代版本且旧订单金额不变；创建双席位周末套餐、复制修订并发布，保证同稳定代码仅一个 ACTIVE；节日礼物上新后归档，既有 CAPTURED 礼物请求名称与金额快照不变。删除语义严格为 archive/retire，不硬删除 append-only 历史。RED 为覆盖门禁报告 3 个计划 ID 未实现；GREEN 新场景 3/3、TypeScript、覆盖门禁 115=115。完整回归及可视化运行留在最终聚合门禁。证据：`evidence/P0/dashboard-e2e/acceptance.md`。
  - Dashboard 115-case 聚合回归（2026-08-05，未完成）：`pnpm exec playwright test tests/e2e/dashboard --project=chromium` 在 retry=0 下 115/115 通过（5.6m）；`DE2E-WLT-009` 另以 Chromium headed + 500ms slow motion 可视运行 1/1 通过（17.2s），实际展示客户筛选、打开 Profile、输入充值事实、上传私有凭证和提交。真实外部员工 UAT、生产 PostgreSQL 全链浏览器运行与发布门禁仍未完成，因此 Story 状态不勾选。证据：`evidence/P0/dashboard-e2e/acceptance.md`。
  - Dashboard 服务套餐版本化编辑补齐（2026-08-04，未完成）：套餐版本按合同不可变，不能原地覆盖；现增加卡片级“编辑套餐（创建新版本）”，预填稳定代码、名称、说明、价格和席位，提交仍通过既有创建版本 API 保存，发布需显式勾选。RED 为套餐编辑入口缺失导致 2/6 测试失败；GREEN 为聚焦 2 files / 10 tests、Dashboard 回归 5 files / 23 tests、typecheck、production build 与 diff check 通过。证据：`evidence/P0/M9-US-07/summary.md`，外部员工 UAT 仍待补录。

### M9 候选证据（2026-08-02）

- M9 专项测试：`tests/m9-us-01` 至 `tests/m9-us-07` 全部通过；合并 Dashboard 视觉重构后完整回归为 310 test files / 746 tests 全通过。
- Dashboard 上线视觉补充复验：当前完整套件为 151 test files / 751 tests 全通过；六个后台页面已纳入统一视觉门禁，375/768/1024/1440px 浏览器断点无页面级横向溢出。
- 身份修复：`000012_onboarding_identity_repair` 已将错误拆分的 Discord 员工/玩家身份安全合并，并新增运行时复用与真实 PostgreSQL 余额保留回归；关联 `AT-ONB-001/002/006`。
- 工程门禁：`npm run typecheck`、`npm run build`、`npm run db:validate`、`npm run db:verify:migration` 全部通过；空库迁移后为 69 tables。
- 追踪与安全：验收矩阵已重建为 207 项；`npm audit --omit=dev --audit-level=moderate` 为 0 vulnerabilities；镜像和 `git diff --check` 通过。
- 外部门禁仍开放：`AT-ONB-005` 等真实 Discord/Dashboard UAT、Railway 空库部署/生产启动与最终候选签署。

## 发布清单

- [ ] M0–M13 Story 均满足当前完成定义，依赖顺序与状态有证据，Requirement ID → Story → operationId → test → evidence 追踪完整。Story 内“验收用例”是该 Story 的重点用例，不是验收全集。
- [ ] 以当前 `acceptance-cases.csv` 为验收全集，建立 `evidence/P0/acceptance-matrix.csv`，每一条均执行并保存结果与证据；未被单一 Story 引用的横切、恢复和边界用例同样是发布必需项。
- [ ] 单元、数据库、Wallet、API、RBAC、Sapphire、Dashboard 和跨客户端自动化回归在候选构建上全部通过，失败可复现。
- [ ] Discord 测试 Guild 完成用户、陪玩、L1-L4 的核心 E2E；私密频道、ephemeral、组件限制、并发接单、双方就绪和 /bot-config 均有证据。
- [ ] Dashboard 完成登录、会话撤销、四级 scope、金额边界、订单/客服工作台、交易时间线、八指标和越权直达 URL E2E。
- [x] M7 退役扫描确认不存在 Provider 资金、账户绑定、支付 Webhook 或第三方充值 URL；内部 USD 钱包、充值阈值、非负扣款和可选私有凭证自动化验收通过。
- [ ] 生产样环境从空环境部署成功；迁移、Secret 扫描、健康/就绪、日志、指标和告警通过。
- [ ] 备份恢复、Bot/Worker 重启、Outbox/Job 重试与幂等恢复演练完成，预留和外部交易镜像无重复或丢失。
- [ ] 安全检查覆盖 Actor Context、服务身份、CSRF、MFA/step-up、Role 升降级、即时撤权、返佣保密、日志脱敏和只追加审计。
- [ ] 产品、运营、客服和技术完成用户、陪玩、L1-L4 UAT；配置快照、已知风险、阻断缺陷、回滚入口与签署记录齐备。
- [ ] P1 与 Nice to Have 保持排除，发布说明不把演示、规格或计划状态描述为已实现能力。

## 进度记录模板

~~~markdown
### Story 工作记录

- Story：
- 状态：未开始 / 进行中 / 阻塞 / 待验收 / 完成
- 负责人：
- 开始时间：
- 完成时间：
- 前置依赖证据：
- 读取的合同与版本：
- 失败测试命令及预期失败，或审查/UAT 的未通过门禁基线：
- 实际修改文件：
- 最小实现摘要：
- 相关回归命令与结果：
- 验收用例与证据链接：
- 数据迁移或配置影响：
- 安全、隐私与恢复检查：
- 未解决风险或阻塞：
- 下一项可启动 Story：
~~~

勾选 Story 前必须把对应工作记录写入 `evidence/P0/<STORY-ID>/README.md`，并确保命令、结果和链接可由另一名成员复验。里程碑门禁结果写入 `evidence/P0/gates/MX.md`，不得只在聊天或临时终端中声明通过。

## M10 多陪玩订单与多接收人礼物

- [x] `M10-US-01` 多陪玩合同与 RED 基线：已冻结不限人数、L1 已认领/L2 Guild 范围、逐人价格与分成来源、服务端派生总价、捕获前可改、全陪玩就绪、逐人收益和多接收人礼物合同。同步主规格、OpenAPI、Prisma 目标合同、backlog、交互映射、验收及双 TODO，并新增 `tests/m10-us-01-contract.spec.ts`。RED 为 1 file / 2 tests failed；GREEN 为 M10+M9 合同 2 files / 4 tests passed；三份 CSV 列宽、Prisma validate、OpenAPI YAML 解析、五份交付镜像和 `git diff --check` 通过。证据：`evidence/P0/M10-US-01/summary.md`。本 Story 不声称运行时或迁移已实现。
  - 合同修订（2026-08-04）：确认每位陪玩独立绑定服务目录版本，可在同一订单承接不同游戏/服务/地区项目；参与明细固化项目、计费、价格和分成快照。M10/M9 合同 `2 files / 4 tests` 与 Prisma 双 schema 校验通过。
- [x] `M10-US-02` 多陪玩数据与只追加事实：新增独立项目参与明细、只追加参与事件、旧订单保守回填、捕获后变更保护及逐人收益关联。RED 为 `1 file / 2 tests failed`；GREEN 为 `1 file / 3 tests passed`；M10/M0 聚焦回归 `3 files / 11 tests passed`，TypeScript、完整迁移链、Prisma validate 和 `git diff --check` 通过。证据：`evidence/P0/M10-US-02/README.md`。本 Story 不声称 API、资金重平衡、Dashboard 或 Discord 已实现。
- [ ] `M10-US-03` 客服多陪玩管理与逐人计价。本地候选已补齐订单需求、顾客/陪玩 Discord 身份、逐人项目与分成的详情投影及权限范围回归；支持按 path `participantId` 单席位 `REASSIGN`，保留需求/项目/数量/客户价格，重置就绪并重算新陪玩分成，其他陪玩、总价和等额预留不变。2026-08-10 维护增量沿用 L1 已认领/L2+ 同 Guild 权限且不要求进入招募，新增订单备注和逐席位备注的添加、修改、清空；清空只更新当前投影并追加事件、审计与 `PANEL_SYNC`，金额/预留/收益不变，终态或已捕获订单失败关闭。增量 RED 为 API 3 failed / 4 passed；GREEN 为 API/PostgreSQL 14/14、相关合同 38/38、typecheck、route parity、迁移链、E2E 覆盖门禁及 Chromium `DE2E-ORD-020` 1/1。证据见 `evidence/P0/M10-US-03/README.md` 与 `evidence/P0/dashboard-e2e/acceptance.md`；仍待真实 Dashboard 九陪玩分页、编辑与视觉 UAT，故保持未勾选。
- [ ] `M10-US-04` 预留重平衡、全陪玩就绪与逐人收益。
  - 本地候选已补齐 AT-MULTI-002/003/004 自动化：真实 PostgreSQL 九人捕获、服务中新增未就绪陪玩零写入、九条逐参与收益及捕获后明细锁定均通过；证据见 `evidence/P0/M10-US-04/README.md`。仍待真实 Discord Guild 与 Dashboard 外部 UAT，故保持未勾选。
- [ ] `M10-US-05` 多接收人礼物事务。
  - 本地候选已完成九人去重、服务端接收人推导、单价乘人数、逐人礼物/预留/任务及任一失败整批回滚；Discord 使用消息内压缩游标跨页累积选择且不依赖进程内状态。仓库全量回归 `179 files / 877 tests` 通过，证据见 `evidence/P0/M10-US-05/README.md`。仍待真实 Guild 跨页交互及审批/捕获/播报 UAT，故保持未勾选。
- [ ] `M10-US-06` 九人订单回归与真实 Guild/Dashboard UAT。用户已授权并完成 Dashboard 写入预检：真实双席位套餐成功创建、发布、核验并退役，API/Bot 重启正常；但 Discord Web 三次 `/service-center` 均停在 “Sending command...”，Bot Gateway 未收到 interaction，客户端同期记录 ACK 503。未创建订单或资金事实，真实 Guild 九人及多人礼物 UAT仍未完成。证据：`evidence/P0/M10-US-06/preflight.md`、`evidence/P0/M10-US-08/browser-uat.md`。
- [ ] `M10-US-07` 客户多项目需求编排与逐名额派单。本地候选已完成需求清单 API、服务端报价、逐名额并发派单和 Discord 订单篮子；自动化证据见 `evidence/P0/M10-US-07/summary.md`。仍待真实 Guild 九项目分页、组件行为与重启恢复 UAT，故保持未勾选。
- [ ] `M10-US-08` 套餐模板与可编辑陪玩席位：合同、迁移、运行时 API、PostgreSQL 原子回滚、Discord 套餐选择与逐席位定制、Dashboard 套餐创建/发布/退役及订单套餐详情均已完成本地候选；Bot 全回归 `35 files / 187 tests`、Dashboard 全回归 `27 files / 130 tests`。L4 Sandbox 写入 UAT 已创建、发布、数据库核验并退役真实双席位套餐；期间发现并以 TDD 修复 React change event 释放导致的席位输入崩溃（`cd5c6d7f`）。Discord interaction 因客户端 ACK 503 未投递到 Bot，真实 Guild 选择/改单/恢复仍未完成，故保持未勾选。2026-08-04 点菜式 HTML 原型已修订为 Discord 可实现的 Components V2：游戏与套餐使用 `Section + accessory Button`，单点使用 String Select，套餐仍可逐席位编辑；当前仅为设计候选，评审前不修改正式合同或 Bot。证据见 `evidence/P0/M10-US-08/contract.md`、`api-data.md`、`admin-dashboard.md`、`browser-uat.md` 与 `summary.md`。
  - 套餐价派生修订（2026-08-04，未完成）：Dashboard 已移除套餐总价输入，按席位服务目录单价 × 计费单位数实时只读显示具体金额，创建请求不再提交价格；API 拒绝客户端价格并原子派生固化，迁移 `000028` 回填历史套餐价并收紧非空约束。RED 为聚焦 2 files / 12 tests 中 4 failed；GREEN 为 M10 聚焦 9 files / 36 tests、Dashboard 关联 26 files / 117 tests、PostgreSQL 1 file / 6 tests及全仓 182 files / 903 tests 通过，Dashboard production build、Prisma validate 与 diff check 通过。真实员工 Dashboard/Discord 外部 UAT 尚未复验，Story 保持未勾选；证据见 `evidence/P0/M10-US-08/summary.md`。
- [ ] `M10-US-09` 按游戏点菜式下单与单游戏套餐约束：本地候选已完成稳定套餐游戏归属、API 按游戏过滤、混合游戏套餐/跨游戏改写拒绝、订单多游戏独立需求、Dashboard 单游戏席位编辑，以及 Discord 原型一致的四步 Components V2 流程（选游戏 → 套餐/单点预览 → 分组清单编辑 → 最终确认）。新单直接进入游戏选择；旧优先陪玩、草稿取消/申诉和旧确认控件已从向导移除。Sandbox `000027_game_scoped_service_packages` 已部署并回填；PostgreSQL 席位更新参数歧义已修复并在 `P-DBDE4FB0` 上回滚预演通过，全仓回归 `182 files / 898 tests passed`；仍待真实 Guild Components V2、恢复与提交复验和 Dashboard 浏览器 UAT，故保持未勾选。证据见 `evidence/P0/M10-US-09/contract.md` 与 `summary.md`。
  - 需求备注入口（2026-08-08，未完成）：第二步游戏菜单已增加“填写/修改需求备注”按钮和单字段 Modal；整单备注按订单期望版本经统一 API 保存，成功或冲突刷新后返回原游戏菜单，且最终确认展示该备注；第三步逐席位偏好不变。RED 分别为 `2 failed`、最终确认 `1 failed / 3 passed`和冲突恢复 `1 failed / 4 passed`；GREEN 目标 `5/5`、聚焦回归 `6 files / 43 tests`、Bot typecheck/build、20 个 Pieces、原型脚本语法和 diff check 通过。Bot 全回归 285 项中 283 通过，余下 2 项是既有 M17-US-08 refresh 路由和 707 行预算门禁；本次新增的 2500 行预算回归已通过抽离 Modal 构造器消除。仍待真实 Guild Modal/重启/冲突 UAT，Story 保持未勾选。证据：`evidence/P0/M10-US-09/summary.md`。

## M11：候选池选秀式派单

> M11 取代 first-success-wins 抢单、ONLINE/AVAILABLE 报名门禁、自动重复轮询和“正式接单后才建语音房”。现行招募由客户手动开始和终止，不设置等待分钟数且不会自然收口；报名/撤回后，同一客户订单 Embed 以不触发通知的 Discord mention 实时列出有效报名者；选秀不限时并通知客服，最终选择才原子创建正式参与人。历史等待字段和关闭原因仅为兼容旧数据，不再控制新轮次。

- [x] `M11-US-01` 候选池派单合同与 RED 基线：同步主规格、backlog、OpenAPI、Prisma 目标合同、交互映射、验收和双 TODO；冻结多单报名、不占活动槽、零人由客户决定、部分入选保留、无人数限制选秀语音及落选权限收敛。RED：`npx vitest run tests/m11-us-01-selection-pool-contract.spec.ts` → 1 file / 2 tests 中 1 failed；GREEN：同命令 1 file / 2 tests passed，合同回归 6 files / 12 tests passed，目标 Prisma、OpenAPI 引用、CSV、镜像与 246 条验收矩阵门禁通过。证据：`evidence/P0/M11-US-01/summary.md`。运行时、迁移和外部 UAT 尚未实现。
- [x] `M11-US-02` 候选池数据与原子选择 API：新增 SelectionPool/Application 与只追加事件、六个版本化 API、需求容量、逐人项目/价格/分成快照、跨池失效及排序 advisory active-slot 锁。RED 为缺少模块导出；GREEN 为 M11 2 files / 8 tests passed，M10 关联回归合计 4 files / 17 tests passed；API 类型检查、Prisma 校验及 000001–000029 空库迁移链通过。证据：`evidence/P0/M11-US-02/README.md`。Discord/Worker/外部 UAT 属于 M11-US-03/04。
- [ ] `M11-US-03` Discord 选秀面板、语音与客服通知：本地候选已实现报名/撤回、客户手动开始/终止、分页终选、客户终选二次确认、user_limit=0 语音、客服通知、未选权限收敛和终态失败唯一客服任务；历史 1/3/5/10/15/30 分钟等待入口与自然截止已由 `M11-US-05` 取代，现行订单主卡显示静默 Discord mention 实时名单。真实订单 `P-0BBA84AA` 的旧流程恢复证据仅保留为历史，不替代新流程 UAT。因前置 `M9-US-18` 与真实 Guild 九候选/重启/故障 UAT 未完成，保持 IN_PROGRESS。证据：`evidence/P0/M11-US-03/README.md`、`evidence/P0/M11-US-05/summary.md`。
  - Service 语音切换（2026-08-07）：终选且订单进入 `ACCEPTED` 后，Worker 幂等创建 `service-{订单号}` 私密房，先提示并移动客户，再开放并移动入选陪玩；部分入选仍保留 Selection 房继续下一轮。订单分别保存 `selection_voice_channel_id` 与正式 `voice_channel_id`，客服协调卡保留旧协调入口并新增服务房入口。旧 Selection 房被标记为只退不进，Gateway 在最后一人退出后自动删除。RED 为缺少清理模块；GREEN 为目标与合同/Worker 4 files / 98 tests、PostgreSQL 关联 6 files / 52 tests、287 条可复现验收矩阵、20 个 Sapphire Pieces、类型检查、Prisma 校验、000001–000036 空库迁移链及 `git diff --check` 通过。全仓 `npm test` 完成 build 后仅余 3 个既有非关联失败：M17 旧 refresh route 与 707 行门禁 2 项，以及本地缺少 `eslint` 导致的质量命令 1 项。Story 仍等待真实 Guild 多人移动与权限 UAT，保持 IN_PROGRESS。
  - 单候选返回与主动续轮修复（2026-08-07）：确认页返回时重新读取并渲染无默认选中值的候选卡，单候选可再次选择；非空候选卡新增 1/3/5/10/15/30 分钟主动续轮入口。API 要求客户显式携带旧池 ID/版本，并原子把旧报名记为未入选、结束旧池和创建新池，保持订单及原资金预留不变。RED 2 files / 2 failed / 26 passed；GREEN 目标与关联 5 files / 67 tests，扩大回归 11 files / 82 tests、PostgreSQL 事务、build/typecheck、路由合同及 20 个 Pieces 通过；真实 Guild 复验仍待执行，Story 保持 IN_PROGRESS。证据：`evidence/P0/M11-US-03/README.md`。
  - 返回重选权限回归修复（2026-08-07）：真实 request_id 审计确认客服账号的候选名单读取成功，但新增通用订单读取因客户归属门禁失败。返回流程现移除该不必要读取，新确认卡直接携带版本，旧确认卡从同消息恢复版本，只调用获授权候选接口。RED 1 file / 2 failed / 14 passed；GREEN 目标 1 file / 16 tests，Bot 关联 6 files / 42 passed、2 项既有 M17 门禁失败未变，build/typecheck 及 20 个 Pieces 通过；Story 保持 IN_PROGRESS。证据：`evidence/P0/M11-US-03/README.md`。
  - 返回重选 V2 渲染修复（2026-08-07）：Legacy Embed 确认页切换到 Components V2 候选页时，更新载荷现先按 Discord 编辑合同把旧 `content`/`embeds` 显式重置为空，再设置 V2 组件与 flag。RED 目标 1 file / 1 failed / 15 passed；GREEN 目标 1 file / 16 tests、渲染关联 5 files / 38 tests；全量 Bot 273 tests passed，2 项既有 M17 门禁失败未变，build、Bot typecheck 及 20 个 Pieces 通过；真实 Guild 复验仍待执行，Story 保持 IN_PROGRESS。证据：`evidence/P0/M11-US-03/README.md`。
  - 重选轮次人数投影修复（2026-08-07）：新一轮创建事务立即追加订单主卡 `PANEL_SYNC`，后续报名/撤回继续更新同一主卡；由候选页产生的 ephemeral 副本不再显示无法持续同步的报名人数，改为一次性开始确认并链接实时订单卡。真实订单 `P-A6FEB615` 已确认业务数据与同步任务正常，问题仅在临时消息投影。RED 2 files / 2 failed / 18 passed；GREEN 目标 2 files / 20 tests、关联 6 files / 56 tests，API/Bot typecheck、build 及 20 个 Pieces 通过；真实 Guild 复验仍待执行，Story 保持 IN_PROGRESS。证据：`evidence/P0/M11-US-03/README.md`。
  - 续轮选秀语音映射修复（2026-08-08）：真实订单 `P-A6F6CA12` 仍保存已被 Discord 删除的 Selection 房 ID，新一轮同步因直接信任该 ID 而向客服发布 `# unknown`。Worker 现只复用 Guild 中真实存在且名称为活动态的 Selection 房；旧房已删除或仅剩 `-closing` 退役房时新建活动房，并以投影旧 ID 为并发前提幂等替换订单映射。RED 1 file / 3 failed / 17 passed；GREEN 目标 1 file / 20 tests、PostgreSQL 关联 2 files / 23 tests、全仓 typecheck 与 `git diff --check` 通过；扩大 M11 回归的 2 项失败为既有发布镜像漂移，本地缺少 `eslint` 的既有环境阻断未变，真实 Guild 复验仍待执行，Story 保持 IN_PROGRESS。证据：`evidence/P0/M11-US-03/README.md`。
  - 取消收敛修复（2026-08-07）：待派单取消现于同一事务取消活动候选池、使有效报名失效、追加只读事件并投递 `CANCELLED` Discord 同步；非待派单订单无法继续报名、撤回、关闭或终选。Worker 原位关闭派单卡，已有选秀语音时同步关闭客户候选消息并撤销报名者权限。RED 2 files / 3 failed；GREEN 目标 2 files / 12 tests、关联 10 files / 48 tests、类型检查、Prisma 校验及空库迁移链通过。全仓 1132 tests 中 1128 passed，剩余 4 项为既有非关联门禁失败，详见 Story 证据；Story 继续保持 IN_PROGRESS。
  - 报名卡版本修复（2026-08-07）：候选池版本只在生命周期迁移时递增；陪玩报名/撤回不再使公开报名卡及客户关闭按钮过期，同一初始版本已覆盖双人并发报名和随后原卡关闭。API 在截止时刻硬性拒绝新报名/撤回，PostgreSQL 池行锁继续串行化报名与关闭。RED 2 files / 5 failed / 8 passed；GREEN 目标 2 files / 13 tests、选秀及关联派单回归 20 files / 78 tests、类型检查与 diff check 通过；Story 继续保持 IN_PROGRESS。
  - 客户订单面板同步修复（2026-08-07）：报名、撤回和报名关闭现于业务事务内分别写入稳定 `PANEL_SYNC`；Worker 面板投影读取活动候选池和实时有效报名数，不再把候选池卡覆盖成旧“队伍正在集合”。活动轮次原位展示人数/截止时间/提前结束，零候选关闭后恢复与首次一致的 1/3/5/10/15/30 分钟单下拉，未开池恢复面板也保留首次等待入口。RED 2 files / 3 failed / 13 passed；GREEN 目标 2 files / 16 tests、关联 9 files / 56 tests、类型检查与 diff check 通过；Story 继续保持 IN_PROGRESS。
  - 客户候选菜单终态修复（2026-08-07）：终选完成后 Worker 原位将客户候选下拉更新为入选名单摘要并清空组件，重复执行复用同一稳定消息，不再留下可点击的过期终选菜单。RED 1 file / 1 failed / 10 passed；GREEN 3 files / 24 tests、类型检查与 diff check 通过；Story 继续保持 IN_PROGRESS。
  - 客服选拔通知终态修复（2026-08-07）：选秀开始通知在订单取消或客户终选后，现通过原稳定 nonce 原位更新为取消说明或入选名单并清空组件；消息更新先于语音清理，缺失语音房不会阻断客服频道收敛。RED 1 file / 2 failed / 9 passed；GREEN 5 files / 24 tests、类型检查与 diff check 通过；Story 继续保持 IN_PROGRESS。
  - 客户终选二次确认（2026-08-07）：候选下拉仅生成私密确认预览，不再直接调用终选 API；确认按钮才提交原版本化原子终选，返回按钮关闭预览并保留原候选菜单。禁用选择框携带已选候选 ID，支持一至二十五人且不依赖进程内状态。RED 1 file / 1 failed / 12 passed；GREEN 目标 1 file / 13 tests、关联 7 files / 49 passed，Piece discovery、类型检查与 diff check 通过；M17 两项既有非关联失败不变，Story 继续保持 IN_PROGRESS。
  - 派单频道收益文案精简（2026-08-07）：公开候选池报名卡和项目下拉只保留项目名称及缺口人数，移除“默认预计收益”；私密收益事实不变。按本轮要求不运行测试，仅执行 diff check；Story 继续保持 IN_PROGRESS。
- [ ] `M11-US-04` 候选池派单回归与外部验收：覆盖手动开始/终止、长期招募不自动收口、实时报名 mention 名单、零报名、多单报名、并发选择、部分席位续池、Discord 权限恢复和真实 Guild/Dashboard 签署。
- [ ] `M11-US-05` 无时限手动招募与实时报名名单：合同、迁移与本地运行时候选已完成。“开始招募 / 终止招募”均为按钮；新池拒绝 `waitMinutes`、不生成 `closesAt` 或 `SELECTION_POOL_CLOSE`，时间流逝和旧截止任务不再迁移 `COLLECTING`。关闭原因由服务端固定为 `CUSTOMER_STOPPED`。报名/撤回事务发出稳定 `PANEL_SYNC`，Worker 原位更新同一订单 Embed 的当前有效 `<@discordUserId>` 名单，并保持 `allowed_mentions.parse=[]`。RED 为新测试 4 项中 3 failed；GREEN 为 M11/关联聚焦 `8 files / 81 tests`、PostgreSQL `1 file / 3 tests`、追踪/发布门禁 `2 files / 71 tests`，typecheck、build、Prisma validate、完整迁移链、20 个 Bot Pieces、290 行验收矩阵与 157 路由合同通过。全仓 1172 tests 中 1169 通过；余下 M17 两项与本地缺少 ESLint 一项为既有非关联门禁，Prettier 可执行文件也未安装。仍待真实 Guild 的双人报名、撤回、静默 mention 和客户终止 UAT，故保持未勾选。证据：`evidence/P0/M11-US-05/summary.md`。验收：`AT-SEL-001;AT-SEL-002;AT-SEL-005;AT-SEL-007`。
- [ ] `M11-US-06` 数字 Reaction 报名与撤回：本地候选已完成单张 `1️⃣–9️⃣` 卡、服务端消息/需求映射、Reaction 增删、mention 同步、启动对账、超过九项零写入及 legacy dropdown 原位转换。新增黑猫主题状态图：首次招募按订单幂等地先发“正在派单”图再发原 Embed，仅整单 `CANCELLED` 追加“本单流单”图，终止招募不误发；目标 `1 file / 13 tests`、M11 聚焦 `6 files / 55 tests`、PostgreSQL `1 file / 4 tests`，typecheck、build、159 路由与 292 条验收通过。本地 Worker 已带新资产重启；仍待真实 Guild 图片顺序/取消幂等、多人增删、Bot 重启对账和九/十项目 UAT，故保持未勾选。证据：`evidence/P0/M11-US-06/summary.md`。验收：`AT-SEL-008;AT-SEL-009`。

## M12：轻量客服打卡、首响自动认领与态度评分

> M12 基于当前多陪玩订单与候选池订单系统增加小团队客服运营事实。StaffTask 保持订单级，不绑定 OrderParticipant；打卡不构成权限门禁；首响、超时与评分不产生自动处罚。

- [x] `M12-US-01` 客服运营合同与 RED 基线：冻结 L1/L2 简单打卡、4 分钟提醒、5 分钟超时、任意 ACTIVE L1–L4 真实首响自动认领最早 OPEN 订单级任务、已有负责人不覆盖、24 小时一次评分及无自动处罚边界；同步主规格、backlog、OpenAPI、Prisma 目标合同、交互映射、验收和双 TODO。RED 为 `tests/m12-us-01-support-contract.spec.ts` 1 file / 4 tests failed；GREEN 与合同回归、目标 Prisma、OpenAPI、CSV、镜像和验收矩阵结果见 `evidence/P0/M12-US-01/README.md`。本 Story 不声称运行时或迁移已实现。
- [x] `M12-US-02` 客服打卡与简单汇总：实现 L1/L2 单活动班次、幂等上下班、未结本人任务下班提示及最近 30 天事实汇总；L2+ 汇总包含可参与首响的 ACTIVE L1–L4 员工。RED 为模块、迁移和 UI 缺失；GREEN 为 4 files / 8 tests passed，PostgreSQL 并发、全迁移链、类型检查及 Prisma 校验通过。证据：`evidence/P0/M12-US-02/README.md`。
- [ ] `M12-US-03` 订单频道首响、超时与自动认领：本地候选已基于可信 transcript 实现 4 分钟提醒、5 分钟超时、任意 ACTIVE L1–L4 真实首响、订单锁与最早 OPEN 订单级任务自动认领；已有负责人不覆盖，Bot/空消息/编辑不计入且无自动处罚。`READINESS_TIMEOUT` 提醒现按本单就绪期限及客户/陪玩未就绪方说明自动客服介入原因，其他任务保留通用文案。PostgreSQL 与关联回归通过，真实 Guild AT-SUP-011 尚未执行，故保持未勾选。证据：`evidence/P0/M12-US-03/README.md`。
  - 客户排队提醒终态收敛（2026-08-07）：真实首响事务为每个转为 `MET` 的任务追加即时对账 Job；Worker 按原稳定 nonce 仅将已存在的“等待处理”提醒 PATCH 为“客服已响应，排队提醒已结束”，首响早于提醒或原消息不存在时不补发。RED 3 files / 3 failed / 13 passed；GREEN 目标 3 files / 16 tests、关联 8 files / 35 tests、typecheck/build/diff check 通过。消息对账边界按本轮要求暂不扩展，真实 Guild UAT 仍待执行。
  - 就绪超时提醒文案（2026-08-07）：`READINESS_TIMEOUT` 从订单接受时间、就绪截止时间及任务快照投影本单就绪期限和未就绪方；客户消息明确说明匹配后超时、客户/陪玩尚未确认及系统自动请求客服介入，首响后更新为客服正在处理。普通客服任务文案不变。RED 1 file / 1 failed / 4 passed；GREEN 目标 2 files / 7 tests、关联 10 files / 27 tests、类型检查与 diff check 通过；Story 继续保持 IN_PROGRESS。
- [ ] `M12-US-04` 完单后客服体验评分与发布验收：本地候选已在完成订单面板按真实首响、24 小时窗口和未评价事实显示一次性入口；Discord 支持 1–5 分、低分受控原因及 OTHER 必填文字，API 由可信客户身份归属到实际首响客服，数据库保证一单一次、只追加并异步刷新面板。评分端点与现行多人订单完成事务解耦，M10 多陪玩生命周期关联回归通过。真实 Guild/Railway AT-SUP-012 与前置 AT-SUP-011 尚未执行，故保持未勾选。证据：`evidence/P0/M12-US-04/README.md`。

## M13：业务集合稳定排序与可复用双视图

> M13 为订单、用户、陪玩、服务目录、服务套餐、礼物目录与礼物请求建立统一服务端排序和 CARD/TABLE 双视图。排序必须覆盖完整游标集合，视图只改变展示，不改变权限、scope、脱敏、详情或动作。

- [x] `M13-US-01` 排序与双视图合同及 RED 基线：冻结七资源 `sortBy/sortDirection` 白名单、默认 `createdAt desc`、`NULLS LAST`、唯一 ID tie-breaker、查询绑定 HMAC 游标、CARD/TABLE、窄屏行式列表、URL 状态及筛选/排序/分页联动；同步主规格、backlog、OpenAPI、交互映射、验收、TODO、设计提案和发布镜像。RED 为 `tests/m13-us-01-collection-contract.spec.ts` 1 file / 5 tests failed；GREEN 与合同回归、CSV/YAML、镜像和证据见 `evidence/P0/M13-US-01/README.md`。本 Story 不表示排序 API 或双视图运行时已实现。
- [x] `M13-US-02` 七类列表 API 稳定排序与游标：实现七资源共用白名单与默认值解析、升降序稳定 keyset、`NULLS LAST`、唯一 ID tie-breaker、绑定资源/Guild/scope/筛选/排序的 HMAC 游标，以及内存与 PostgreSQL 查询和必要复合索引；篡改、跨资源、跨排序与跨筛选游标均失败关闭。RED、专项、数据库与全仓回归见 `evidence/P0/M13-US-02/README.md`。跨 Guild 隔离继续由 API/数据库自动化回归证明，真实员工 UAT 只覆盖当前业务 Guild。
- [x] `M13-US-03` 可复用集合工具栏与卡片表格接入：七页共用排序/筛选/CARD-TABLE 配置与显式列白名单；用户、礼物目录和礼物请求补齐卡片，TABLE 在 760px 以下使用同列配置降级为可聚焦行式列表。URL 安全恢复 view/sort/filter，视图切换不请求，排序/筛选重置分页且 latest-request 门禁拒绝旧响应。RED、Dashboard 回归、typecheck 与 production build 见 `evidence/P0/M13-US-03/README.md`；当前业务 Guild 的真实浏览器/L1–L4 UAT 仍归 `M13-US-04`。
- [ ] `M13-US-04` 跨页一致性、可访问性与发布验收：完成排序矩阵、请求竞态、375/768/桌面、L1-L4 和当前业务 Guild 的真实员工 Dashboard UAT；跨 Guild 隔离由 API/数据库自动化回归证明。
  - 本地发布候选与真实 L4 浏览器 UAT 已覆盖七资源排序白名单、50 个 live 排序组合、跨页唯一性、`NULLS LAST`、URL/竞态、CARD/TABLE parity、375/768/桌面及详情一致性；2026-08-06 又恢复七类卡片视图工具栏与首排卡片的统一 12px 间距，聚焦 10 tests、production build 与真实陪玩页无溢出测量通过。当前 fixture 缺少 ACTIVE L2、L3，且真实键盘和产品签署未完成；第二个真实 Guild 不属于发布条件，故保持未勾选。证据见 `evidence/P0/M13-US-04/README.md`。
  - 双视图操作入口修复（2026-08-08）：1280×720 基线证明七页卡片记录动作均被推到 `765–873px` 首屏之外；现在 CARD、桌面 TABLE 与窄屏行式列表复用同一“可用操作”渲染器，详情、编辑、删除、审批、取消等动作在卡片标题后可见，集合级新建按钮保持标题区。未通过基线 1 file / 14 failed；GREEN 为目标与关联 4 files / 57 tests、七页 Chromium 7/7、Dashboard 回归 33 files / 168 tests、根 typecheck、production build 与 diff check 通过；七页 CARD/TABLE 共 14 张截图已保存。Story 因既有真实 L1–L4、键盘与产品签署门禁仍保持未勾选。证据见 `evidence/P0/M13-US-04/action-visibility-results.md`。

## M14：客服任务优先工作台与可行动订单上下文

> M14 修正客服实际使用中发现的首屏优先级、盲认领、无效 Discord 链接、原始标识过载和指标不可行动问题；复用既有 StaffTask、订单、权限及资金事实，不扩展为 CRM。

- [x] `M14-US-01` 客服工作台体验合同与 RED 基线：已整理问题清单，冻结 queue-first 层级、服务端分诊顺序、认领前最小只读摘要、安全 Discord 深链、人性化订单上下文与可行动指标；同步主规格、backlog、OpenAPI、交互映射、验收、TODO 和镜像，并新增合同门禁。此项只完成 Story 与合同设计，不表示客服工作台运行时已实现。
- [x] `M14-US-02` 安全任务分诊投影与 Discord 深链：统一 API 现为列表和详情返回 task-scoped 分诊摘要与服务端可信 Discord 链接；任务按 OVERDUE、PENDING 截止时间、创建时间和 ID 稳定排序，PostgreSQL 查询按订单 Guild 隔离。Dashboard 不再从可空 Guild/频道字段自行拼接 URL，并对非 Discord 或不完整链接失败关闭。RED、API/数据库/Dashboard 聚焦回归、typecheck 和证据见 `evidence/P0/M14-US-02/README.md`。
- [x] `M14-US-03` 首屏任务队列与认领前只读上下文：客服页已改为紧凑班次条后立即展示当前任务，历史 30 天记录和运营指标下移；任务卡显示公开订单号、客户、服务、原因、时间压力和下一步，并提供认领前可展开只读摘要。缺频道明确显示不可用，认领和完整订单仍受既有 capability 控制。RED、Dashboard 回归、typecheck、production build 和证据见 `evidence/P0/M14-US-03/README.md`。
- [x] `M14-US-04` 人性化订单信息层级与可行动指标跳转：订单卡片、表格与详情现在优先展示公开订单号、客户/陪玩展示名、服务摘要、中文状态、业务金额、更新时间、当前阻塞和下一步；UUID 与审计字段收入口径明确的技术详情，高级陪玩维护默认折叠。订单列表 API 直接投影人类可读字段，概览待处理、异常和进行中指标可进入对应受权筛选结果。RED、API/Dashboard 回归、typecheck、production build 和证据见 `evidence/P0/M14-US-04/README.md`。
- [ ] `M14-US-05` RBAC、可访问性与真实员工 UAT 发布验收。
  - 本地发布候选与真实 L4 浏览器 UAT 已完成：修复旧任务缺少 `triage/links` 及认领后共享订单详情缺少旧生命周期投影时白屏、375px 整页横向溢出、待处理指标错误路由、进行中指标无法钻取，以及 L3/L4 指标与订单列表 Guild 范围不一致；新增 `IN_PROGRESS` 受控筛选组。全仓 208 个测试文件 / 1023 个测试、根构建、Dashboard production build、Prisma 校验通过；真实 L4 在 375/768/桌面验证队列、只读摘要、认领、客户展示名、订单概览和指标钻取，`DE2E-SUP-008` 已通过 L2+ 任务结案自动化。真实员工 UAT 只覆盖当前业务 Guild，跨 Guild 隔离由 API/数据库自动化回归证明；当前 fixture 只有 ACTIVE L1/L4、L2 为 DISABLED 且无 L3，真实键盘、真实员工结案与产品/客服/QA 签署仍未完成，故保持未勾选；证据见 `evidence/P0/M14-US-05/README.md`。

## Dashboard E2E：M13/M14 合并兼容性复查

- [x] 合并 `main@08b85e22` 后复跑 115 条 Dashboard Chromium E2E。首次基线为 90/115，通过修正 CARD/TABLE 默认视图定位、M14 客服分诊投影与安全链接、人性化状态/标签及折叠高级操作后，最终 115/115 通过（3.9 分钟、无重试）；M13/M14 定向回归 10 files / 47 tests 通过，typecheck 通过，计划覆盖仍为 115/115。复查发现并修复 1 个此前未识别的产品回归：返佣 fallback 表格遗漏脱敏来源用户列；其余 24 项为测试 fixture/定位器对既定 M13/M14 合同变化的不兼容。证据：`evidence/P0/dashboard-e2e/acceptance.md`。

## Dashboard 客服功能补齐

- [x] 客服任务结案入口：修正“全部”筛选遗漏其他员工已认领任务；L2+ 可在底层业务动作完成后填写必填说明并以 `UNDERLYING_ACTION_COMPLETED` 结案。结案只追加任务处理结果，不修改订单或资金。RED 为 `tests/m4-us-02-dashboard.spec.ts` 新增断言失败；GREEN 为专项 3 files / 8 tests、typecheck 及 Chromium `DE2E-SUP-008` 1/1 通过。计划覆盖更新为 116/116；真实员工结案 UAT 仍归 M14-US-05 外部门禁。证据：`evidence/P0/dashboard-e2e/acceptance.md`。
- [x] 礼物核验、批准与拒绝入口：L1 仅可核验本人已认领的 `GIFT_REVIEW`，核验方式受控且说明必填；L2+ 决策前读取最新礼物 `rowVersion`，批准只捕获既有预留，拒绝只释放既有预留，均不接受 Dashboard 金额。RED 为 Dashboard model 礼物动作断言失败；GREEN 为 typecheck、API/模型 2 files / 11 tests 与 Chromium `DE2E-GFT-006`–`007` 2/2 通过。计划覆盖更新为 118/118。证据：`evidence/P0/dashboard-e2e/acceptance.md`。
- [x] 客户 Profile 只追加内部备注：新增 `customer_profile.note.append`，L1 仅可备注已分配订单/任务对应客户，L2-L4 仅同 Guild；正文限制 1–2000 字，返回投影隐藏作者，数据库触发器继续禁止修改删除。RED 为 API/组件/数据库 3 files / 21 tests 中 4 failed；GREEN 为同组 21/21、API 与 Dashboard typecheck、计划覆盖 119/119，以及 Chromium `DE2E-PRF-004` 1/1 通过。证据：`evidence/P0/dashboard-e2e/acceptance.md`。
- [x] 客服 Profile 备注与多陪玩单席位改派综合回归：新增场景后首次 Chromium 全量为 113/120，7 条钱包失败均为“备注”同时匹配“客服内部备注”的前端定位歧义，尚未发出业务请求；旧钱包 helper 改为 exact accessible label 后专项 7/7、完整 Dashboard 120/120 通过（3.0 分钟、无重试）。证据：`evidence/P0/dashboard-e2e/acceptance.md`。

## M15：Dashboard 客服运营闭环

> M15 只补齐客服视角运营能力。Dashboard 不发送、编辑或删除 Discord 消息；陪玩没有自助在线/接单开关，候选池资格由员工审核状态决定；老板与陪玩个人操作不纳入后台。

- [x] `M15-US-01` 客服运营闭环合同与 RED 基线：冻结独立退款、只读订单频道记录、Bot 配置、钱包 Adjustment、员工控制陪玩接单资格、客户展示名和员工账号管理，新增三项缺失统一 API 合同、八个现实验收场景及明确排除项。RED 为 1 file / 4 tests failed；GREEN、合同校验与镜像证据见 `evidence/P0/M15-US-01/README.md`。本 Story 不声称运行时已实现。
- [x] `M15-US-02` 订单独立退款工作流：订单集合新增仅对 COMPLETED/EXCEPTION 且具 `refund.execute` 权限显示的独立退款入口，提交 expectedVersion、canonical CAT 金额、受控原因与证据，复用统一 API 的只追加退款、收益/返佣冲正、权限、审批与幂等语义。RED 为 1 file / 2 tests failed；GREEN 为 Dashboard/API 4 files / 43 tests、typecheck、覆盖矩阵 121/121，以及 36 单现实 Chromium 场景 6/6（新增 `DE2E-ORD-018`）通过。证据：`evidence/P0/M15-US-02/README.md`。
- [x] `M15-US-03` 订单频道记录只读查看：统一 API 新增 Dashboard-only 稳定游标读取，L1 要求本人已认领任务、L2+ 限同 Guild；返回创建/编辑/删除、回复和附件元数据白名单。订单详情以只读区展示并明确无发送、编辑或删除能力。关联 Vitest 4 files / 12 tests、API/Dashboard typecheck、root build、覆盖矩阵 122/122，以及 36 单 Chromium 现实场景 7/7（新增 `DE2E-ORD-019`）通过。证据：`evidence/P0/M15-US-03/README.md`。
- [x] `M15-US-04` Bot 配置完整后台：新增独立导航与完整字段表单，L3 可查看、预检并以乐观锁保存运营配置及执行频道测试投递，L4 可查看安全 Role 字段；服务端继续决定字段权限且 Dashboard 实际写入安全 Role 时要求近期 step-up。本 Story 发现并修复 1 个既有安全缺陷：原 API 合同声明安全 Role 需要 step-up，但运行时未执行。RED 为缺少 Dashboard model；GREEN 为 Bot 配置相关 4 files / 24 tests、API/Dashboard typecheck、Dashboard build、覆盖矩阵 124/124，以及 Chromium `DE2E-BOT-001`–`002` 2/2 通过。证据：`evidence/P0/M15-US-04/README.md`。
- [x] `M15-US-05` 钱包 Adjustment 冲正工作流：客户钱包对具 `wallet.adjust` 的 L3+ 增加“账目冲正”，只能选择原始业务流水并提交方向、canonical CAT subunit 金额、原因和 expectedWalletVersion；统一 API 追加 Adjustment 并关联 reversalOfEntryId，原流水、预留及客户端余额事实均不可写。RED 为 model 1 file / 2 tests failed；GREEN 为钱包/model 2 files / 7 tests、API/Dashboard typecheck、Dashboard build、覆盖矩阵 125/125，以及完整 Profile/钱包 Chromium 13/13（新增 `DE2E-WLT-011`）通过。证据：`evidence/P0/M15-US-05/README.md`。

## M16：API 与 Dashboard 审查整改

> M16 以 main 分支审查证据为基线，优先修正金额/分页合同漂移、安全路由错误与幂等终态、Dashboard 请求竞态，再建立共享 DTO 与工程门禁。

- [x] `M16-US-01` 审查整改合同与 RED 基线：冻结 CAT/USD 展示边界、钱包分页 envelope、客服备注/升级 OpenAPI 路由和后续运行时/质量 Story。RED 为 1 file / 4 tests 中 3 failed；GREEN 为 M16/M15/M9/M8 合同 4 files / 13 tests passed，OpenAPI YAML、CSV 列宽、七组镜像和 diff check 通过。证据：`evidence/P0/M16-US-01/README.md`。本 Story 不声称运行时完成。
- [x] `M16-US-02` 统一 API 错误、幂等恢复与钱包分页：安全路由 target 解析进入标准 400/审计，已提交响应的幂等终态支持重试与 `COMMITTED_RESPONSE_RECOVERY`，钱包流水改为用户绑定的签名 keyset 分页。RED 1 file / 3 tests failed；GREEN 专项 8 files / 52 tests、PostgreSQL 1 file / 4 tests 与 typecheck 通过。全量中间基线因尚未实施的 M16-US-03/04 矩阵映射保持失败，未声称全量通过。证据：`evidence/P0/M16-US-02/summary.md`。
- [x] `M16-US-03` Dashboard CAT 展示与请求一致性：钱包、业务退款与冲正统一显示 CAT，充值收据仅以 USD 录入，陪玩结算同时显示 CAT/USD；钱包分页使用 `{ items, nextCursor }`，客户切换使用 latest-request gate，mutation 以 `finally` 清除 busy。RED 1 file / 0 tests（缺少请求状态模块）；GREEN 专项 5 files / 14 tests、Dashboard typecheck/build 与 Chromium 4 files / 40 E2E 通过。证据：`evidence/P0/M16-US-03/summary.md`。
- [x] `M16-US-04` 共享 API DTO 与工程门禁：platform 统一钱包/分页/错误类型与解析器；AST route parity 覆盖 156 个 production operations；API/Dashboard lint 为 0 error、39 个历史 warning 锁为不可增长基线；Prettier 门禁、typecheck、Dashboard build、全量 220 files / 1066 tests 通过。证据：`evidence/P0/M16-US-04/summary.md`。
- [x] `M15-US-06` 员工控制陪玩接单资格：陪玩集合对具 `player.status.manage` 的 L3+ 增加“管理接单资格”，通过统一 API 以 expectedVersion 设置 ACTIVE、PAUSED 或 SUSPENDED；Dashboard 明确说明 Discord 在线状态仅诊断。暂停后新订单候选池立即排除该陪玩，既有订单不重写。实现中修复 1 个既有显示缺陷：PAUSED 卡片此前仍显示“可参与派单”，现改为服务端准入状态驱动的新接单资格。RED 为 model 1 file / 2 tests failed；GREEN 为领域/API/Dashboard 4 files / 18 tests、typecheck、build、覆盖矩阵 126/126，以及完整 Chromium 陪玩场景 8/8（新增 `DE2E-PLY-010`）通过。证据：`evidence/P0/M15-US-06/README.md`。
- [x] `M15-US-07` 客户 Profile 展示名编辑：新增 L2+ `customer_profile.manage` 与同 Guild 更新路由，Profile 只允许以 expectedVersion、受控原因和说明修改 displayName；Discord 身份、内部 ID、钱包、订单历史及只追加备注均无编辑入口。并发旧版本返回 409，写入进入安全路由审计。RED 为 1 file / 2 tests failed；GREEN 为 Profile/API/Dashboard 5 files / 28 tests、API/Dashboard typecheck、build、覆盖矩阵 127/127，以及完整 Profile/钱包 Chromium 14/14（新增 `DE2E-PRF-005`）通过。证据：`evidence/P0/M15-US-07/README.md`。
- [x] `M15-US-08` 员工账号完整管理：权限管理页新增同 Guild 员工账号列表、待提权、有效级别、权限版本和活跃会话；L4 完成 step-up 后可由不同所有者确认首次 L3/L4 提权、执行不越级的角色修正/降级、撤销权限或单独撤销会话。PostgreSQL 列表稳定分页，写入继续使用现有双人控制、版本锁、审计和会话撤销；唯一有效所有者不可移除，测试存储也补齐同一门禁。RED 为 Dashboard model 1 file / 2 tests failed；GREEN 为 Access API/DB/Dashboard 3 files / 17 tests、typecheck、build、覆盖矩阵 129/129，以及权限页 Chromium 4/4（新增 `DE2E-STF-001`–`002`）通过。证据：`evidence/P0/M15-US-08/README.md`。
- [x] `M15-US-09` 真实客服业务 E2E 与发布审计：Chromium 全量 129/129 通过，其中 36 个混合状态订单覆盖老板取消、服务中求助、完成后部分退款、网络重试幂等和非法状态零写入；同时覆盖 Bot 配置、钱包冲正、陪玩暂停、客户展示名和员工账号治理。`npm test` 为 216 files / 1052 tests 通过且 build 通过；验收矩阵可重生为 276 条。发现并修复套餐验收 ID 重复、Bot 校验 operationId 旧名、M15 fixture 索引和新路由审计计数等门禁漂移。最终收口又移除不可达的陪玩本人 availability 写方法及旧原型开关，现行候选资格只由客服审核的 ACTIVE、Guild 与运营标签决定；历史 URL 保持 404 且零写入。真实员工 UAT、真实 Discord Guild 与发布签署未执行，继续保留为外部门禁。证据：`evidence/P0/M15-US-09/README.md`。

## M17：Bot 审查整改

> M17 以 main 分支 Bot 代码审查证据为基线，只改善 Discord 适配器的运行时副作用、就绪边界、复用结构、可维护性和工程门禁；不改变订单状态机、资金语义、权限矩阵或 API 业务规则。

- [x] `M17-US-01` Bot 审查整改合同与 RED 基线：冻结私密订单频道创建/恢复/置顶、关键初始化 readiness barrier、可信 Actor 与统一 Bot API transport、服务中心拆分、行为测试及组件—路由可达性门禁。RED 为 1 file / 3 tests failed；GREEN 为 1 file / 3 tests passed，五组合同镜像一致。证据：`evidence/P0/M17-US-01/README.md`。本 Story 不声称运行时整改已实现。
- [x] `M17-US-02` 私密订单频道适配器与面板置顶：频道创建、权限覆盖、占位消息、置顶、最终渲染/改名与失败清理由独立 Discord 适配器执行；handler 在统一 API 写入前完成置顶，新建与原频道丢失后的恢复共用同一计划，重复临时频道会删除。RED 为模块缺失导致 1 suite failed / 0 tests；GREEN 为专项与关联回归 3 files / 21 tests、Bot typecheck 与根 build 通过。证据：`evidence/P0/M17-US-02/README.md`。
- [x] `M17-US-03` 关键初始化 readiness barrier 与后台恢复：Gateway ready 不再直接表示可服务；统一 API health、全部 Guild 配置加载及已配置 onboarding 常驻消息恢复完成后才置 Ready，异常保持 503。全量 Role 与产品 Role 恢复按最多两个 Guild 并发转入后台，停止信号立即清除 Ready。RED 为运行时模块缺失导致 1 suite failed / 0 tests；GREEN 为专项及关联回归 4 files / 28 tests、Bot typecheck、18 个 Piece 发现与根 build 通过。证据：`evidence/P0/M17-US-03/README.md`。
- [x] `M17-US-04` Bot lint、format、typecheck、build、测试及 Piece 发现门禁：新增一条 `quality:bot` 命令，覆盖 0 warning ESLint、全 Bot 源码 Prettier、Bot typecheck、根 build、18 个 Piece 发现及按源码依赖稳定发现的 43 files / 222 tests。首次基线检出 2 errors / 4 warnings 与 31 个未格式化文件，现全部清零；3 个依赖格式空白的旧测试已改为语义等价正则。证据：`evidence/P0/M17-US-04/README.md`。
- [x] `M17-US-05` 可信 Actor Builder 与统一 Bot API Transport：交互、Guild 服务身份与 Gateway 事件 Actor 统一构造，DM/空 Guild 在请求前失败关闭；service-center、Bot 配置、Role sync、onboarding、频道 transcript 五个 HTTP client 共用认证头、Actor 头、幂等键、10 秒超时、fetch 注入、JSON envelope、request ID 及网络/超时/非 JSON 标准错误。RED 为缺少两个共享模块导致 1 suite failed / 0 tests；GREEN 为专项与客户端关联回归 8 files / 55 tests，完整 Bot 44 files / 226 tests、质量门禁与根 build 通过。证据：`evidence/P0/M17-US-05/README.md`。
- [x] `M17-US-06` 服务中心 API 客户端与领域类型拆分：将 DTO、`BotApiClient`、`HttpBotApiClient`、错误与请求辅助函数从 4,535 行混合文件迁入 1,365 行 `service-center-api.ts`，API 模块不含 Discord component、renderer 或文案；旧 `@blackcat/bot/service-center` 通过 re-export 保持兼容，API-only presence consumer 改用直接边界，facade 降至 3,202 行。RED 为 API-only consumer 仍依赖 facade（1/3 failed）；GREEN 为专项/characterization 4 files / 25 tests，完整质量门禁 45 files / 229 tests、typecheck/build/Piece discovery 通过。证据：`evidence/P0/M17-US-06/README.md`。
- [x] `M17-US-07` 服务中心展示、路由与功能边界拆分：提取 `service-center-components`、`service-center-routes` 与 `service-center-profile`，facade 从 3,202 行降至 2,341 行；renderer 在 Discord builder 前校验 custom ID、action row 和 select 限制，分页 ID 与解析器成对测试，展示层不再读取 `process.env`。RED 为模块缺失（1 suite failed / 0 tests）；GREEN 为专项 1 file / 3 tests，完整 Bot 46 files / 232 tests、0-warning lint、format、typecheck、build 与 18 个 Piece 发现通过。证据：`evidence/P0/M17-US-07/README.md`。
- [x] `M17-US-08` Interaction Handler 分层与行为/可达性测试：Profile/周报、礼物、客服评价提取为注入式 feature executor，按钮适配器由 873 行降至 697 行；统一 route registry 被 button/select/modal handler 共用。真实交互 spy 证明 ACK 先于 API、错误走 ephemeral follow-up 且保留 request ID；补齐当前订单、我的收益、充值与确认刷新四类可见组件路由。RED 为 registry 模块缺失（1 suite failed / 0 tests）；GREEN 为专项 1 file / 4 tests，完整 Bot 47 files / 236 tests、18 个 Piece 与质量门禁通过。证据：`evidence/P0/M17-US-08/README.md`。
- [ ] `M17-US-09` Bot 全量回归、真实 Guild UAT 审计与发布收口：经授权复用 main 的 gitignored SANDBOX `.env`，真实 Guild 的 `AT-BOT-REV-001` 私密频道权限/pin/恢复/清理与 `AT-BOT-REV-002` 重启 readiness `503→200` 均已登记 `PASSED`；启动 UAT 发现并修复配置读取误带部分 Actor Context 导致的 `401` 回归。后续真实交互发现候选池 `403` 被 Bot 折叠为含糊的“刷新重试”，现所有用户可见异常统一显示具体操作、准确原因、下一步、写入确定性与 request ID，候选池/派单/订单/Profile/周报/礼物/评价/onboarding/Bot 配置均完成迁移；RED 为模块缺失 1 suite / 0 tests，GREEN 为专项与相关行为 5 files / 38 tests，完整 Bot 门禁 48 files / 250 tests 通过。其余真实多候选流程和 owner/staff 具名签署仍缺失，全项目另有 69 条非 M17 外部验收待完成，故 Story 维持 `IN_PROGRESS` 且发布门禁 fail-closed。证据：`evidence/P0/M17-US-09/summary.md`、`evidence/P0/external/AT-BOT-REV-001/`、`evidence/P0/external/AT-BOT-REV-002/`。

## M18：Discord 情绪化体验与信息层级

> M18 将当前约 20% 的视觉/文案丰富度提升到参考店铺约 80–90% 的体感，默认以 85% 为设计基准，同时保持更稳定的信息层级。用户可见统一使用“试音/试音匹配”，禁止“选秀”；内部 Selection 技术名称可保留。体验改造不改变订单、资金、权限、Actor Context 或统一 API 业务规则。

- [x] `M18-US-01` 术语、视觉密度与 Embed 层级合同：冻结用户可见试音匹配术语、五档视觉密度、高价值节点“横幅 → Embed → 操作”构图、Embed 七段阅读顺序、老板需求独立分组、语义色/emoji、低噪声原位更新、原创素材和真实 Guild 多视角 UAT 边界。RED 为 1 file / 4 tests 中 3 failed；GREEN 为同文件 4/4，根 build 通过，五组合同镜像一致。验收：`AT-EXP-001`–`005`。证据：`evidence/P0/M18-US-01/summary.md`。本 Story 不声称运行时已完成。
  - 密度目标修订（2026-08-09）：整体品牌与情绪体感由参考店铺 60–70% 上调至 80–90%，默认约 85%；公共欢迎 90、派单/里程碑 85、私密订单 70–80、短反馈 45–55，高风险仍为 20–35。RED 1 file / 2 failed、2 passed；合同镜像与 UAT 标尺已同步，运行时升级由后续 Story 独立验证。
- [x] `M18-US-02` 统一 Discord 视觉与文案组件及用户可见禁词门禁：新增五档密度、六种语义色、统一黑猫页脚、独立 Embed fields、老板需求引用区、当前进度/下一步字段和 Discord 长度校验，Renderer 同时支持传统 Embed 与 Components V2。生产 Bot 与 selection Worker 的用户可见“选秀”已清零，并修正“在线可接单”旧资格文案。RED 为缺少模块 1 suite / 0 tests；GREEN 聚焦 5 files / 46 tests、Bot lint/format/typecheck/build、22 个 Pieces 与完整 Bot 52 files / 306 tests 通过。门禁过程中同步修复当前事实已经变化的 3 个旧测试常量及 3 个既有 Prettier 漂移文件，无业务行为变化。证据：`evidence/P0/M18-US-02/summary.md`。
  - 密度 token 修订（2026-08-09）：公共欢迎 90、公共里程碑 85、私密订单 75、短反馈 50，高风险继续 25；RED 1 file / 1 failed、3 passed，GREEN 关联 5 files / 22 tests 与 Bot typecheck 通过。运行时只更新设计 token，不改变状态、金额、权限或 API 事实。
- [x] `M18-US-03` 欢迎入口、服务导航与四步下单向导升级：常驻入口改为品牌 Embed 与三条路径，版本升至 v4 并确保新建/恢复消息均发送 Embed；公共服务入口现采用 90 密度。四步向导统一展示进度、核心事实、老板需求、报价/钱包、提交状态和唯一下一步；Step 2 套餐/单点菜单及套餐预览按游戏安全映射 13 张现有原创横幅，以本地附件方式置于 Components V2 最前，未知游戏回退“其他”。RED 为缺少 banner resolver 1 suite / 0 tests；GREEN 聚焦 6 files / 32 tests，完整 Bot lint/format/typecheck/build、22 个 Pieces、53 files / 311 tests 通过。为保持 M17 拆分预算，将公共入口/资格文案移入独立 presentation 模块，facade 为 2492 行。证据：`evidence/P0/M18-US-03/summary.md`。真实 Guild 三角色/桌面手机 UAT 归 M18-US-08。
  - 迎新私信补充（2026-08-09）：新成员加入自动收到品牌私信；具 `ManageGuild` 的受权员工可用 `/welcome player:@成员` 重发同一消息，当前最小权限边界见下方修复记录。目标为 Bot 时跳过，关闭私信不公开补发，手动失败仅 ephemeral 提示；不自动注册或改变业务状态。RED 1 suite / 0 tests；GREEN 目标 1 file / 5 tests、相关 5 files / 24 tests、Bot 完整 57 files / 333 tests、24 Pieces、lint/format/typecheck/build 与全仓 248 files / 1241 tests 通过。证据与真实 Guild 阻断见 `evidence/P0/M18-US-03/summary.md`。
  - 迎新品牌密度升级（2026-08-09）：自动与手动迎新共用的私信提升至 90 密度，新增品牌署名、原创 2168×725 黑猫迎新横幅、6 个情绪/导航分区与 2 个稳定按钮；不改变 API 授权、业务状态、隐私和资金边界。RED 1 failed / 4 passed；GREEN 目标回归 3 files / 13 tests，Bot 完整 57 files / 333 tests、24 Pieces、lint/format/typecheck/build 与全仓 248 files / 1241 tests 通过。
  - 老板订单频道头图补充（2026-08-09）：第 1/4 步游戏选择面板最前复用同一张原创迎新横幅，刷新/恢复继续携带，进入具体游戏后切换为原有游戏主题横幅；共享固定素材解析器，不开放用户路径。RED 1 failed / 4 passed；GREEN 相关 5 files / 50 tests、Bot 完整 57 files / 333 tests、24 Pieces 与全仓 248 files / 1241 tests 通过。运行中的 Bot 已完成 watch 重启，Discord Guild Command API 确认 `/welcome` 已注册并按 `ManageGuild` 限制可见性，无服务器级权限覆盖。
  - 横幅传输优化（2026-08-09）：迎新/订单横幅缩为 1600×535 WebP，13 张游戏横幅缩为 1600×800 WebP，quality 84；14 张总大小从 29,042,983 降至 2,077,754 bytes（约 -92.8%），单张 112,494–179,230 bytes。Bot/Worker/UAT/manifest/附件映射全部同步，未知游戏回退不变。RED 5 files / 29 tests 中 7 failed；GREEN 同组 5 files / 29 tests、Bot 57 files / 333 tests、24 Pieces、API typecheck、API/Dashboard lint 38 warnings / 0 errors 与全仓 248 files / 1241 tests 通过；发布审计强制 WebP 尺寸、体积和完整集合。Bot watch 与派单 Worker 均已重启，Worker 启动恢复/待发队列为 0。
  - `/welcome` 最小权限修复（2026-08-09）：真实 request_id 证实 L2 有效员工因旧实现借用 L3 `bot_config.read` 被拒；现新增 L2+ `welcome_dm.send` 与 `getWelcomeDmContext`，响应仅含 `guildId/publicEntryChannelId`，保留 Discord `ManageGuild`、同 Guild Actor、L1/服务身份拒绝、审计和先授权后投递顺序，完整 Bot 配置权限不变。验收 `AT-EXP-006`。RED 2 files / 7 tests 中 4 failed；GREEN 专项 2 files / 9 tests、关联 4 files / 75 tests、Bot 57 files / 334 tests、24 Pieces、lint/format/typecheck/build、Prisma、160 条路由合同及全仓 249 files / 1245 tests 通过；矩阵重建为 303 行。本地运行时安全读取返回 200，request_id `req_1dfb623b-6c28-44dc-a86f-fb034a1a806f`。证据：`evidence/P0/M18-US-03/summary.md`。
- [x] `M18-US-04` 订单主面板与状态层级升级：通用订单、提交/资金预留、未招募、报名进行中、无人报名和试音匹配面板统一为 75 密度的“核心事实 → 老板需求 → 当前进度 → 下一步”层级；资金明确标注只是预留，报名名单以 Discord mention 实时展示，招募终止后使用“试音匹配”。RED 为 1 file / 4 tests 全失败；GREEN 为聚焦 3 files / 28 tests，完整 Bot lint/format/typecheck/build、22 个 Pieces、54 files / 315 tests 通过；facade 为 2439 行。证据：`evidence/P0/M18-US-04/summary.md`。
- [x] `M18-US-05` 派单、数字 Reaction 报名与试音匹配体验升级：首次招募仍先发“正在派单”通用图，随后的公开报名 Embed 使用单游戏黑猫主题横幅，混合/未知游戏安全回退“其他”；每个 1️⃣–9️⃣ 项目分区展示缺口、预计收益和老板需求，明示“添加数字＝报名、移除数字＝取消报名”。原位关闭卡、试音房、客服通知、本轮未匹配与最终确认文案统一为试音匹配，生产 Bot/Worker 用户可见“选秀/候选/选拔”扫描为零。RED 1 file / 3 tests 中 2 failed；GREEN 聚焦 4 files / 54 tests、Bot 54 files / 315 tests 通过。全仓 240 files / 1206 tests 中 236 files / 1198 tests 通过，剩余 8 项均为 M18 前置 traceability/fixture 与既有 API lint 基线，未出现本 Story 行为回归。证据：`evidence/P0/M18-US-05/summary.md`。真实 Guild UAT 归 M18-US-08。
- [x] `M18-US-06` 全陪玩就绪、服务中与完成里程碑体验升级：按 M10 高优先级合同纠正旧“双边就绪”措辞，老板不再显示 readiness，ACCEPTED 卡逐名展示有效陪玩 ✅/⏳ 状态；常驻 Worker 面板原位同步服务开始、逐人价格/预计收益/分成来源、老板完成确认及圆满完成反馈，共享按钮标明可操作角色。facade 从 2503 行拆回 2300 行；RED 为生命周期 1 file / 4 tests 全失败及 Worker 常驻卡新增断言 1 failed，GREEN 为聚焦 4 files / 51 tests、Bot 质量门禁 55 files / 322 tests、typecheck/build/Piece discovery 与 Worker ESLint 通过。证据：`evidence/P0/M18-US-06/summary.md`。真实 Guild 三角色/桌面手机 UAT 归 M18-US-08。
- [x] `M18-US-07` 礼物、取消、客服、评分与高风险错误体验升级：礼物最终确认明确“确认后预留”、请求成功明确“已预留但未正式扣除”，审批后的公开庆祝继续使用运营配置模板，拒绝保持释放预留且不广播成功；取消预览以低密度分开资金影响与危险操作，且只有 API 返回 `CANCELLED` 才显示取消终态并允许流单图，非终态统一降级为客服/待核对；客服评分加入温暖反馈并声明不影响订单扣款或陪玩收益，409/5xx 等错误统一为“原因 → 下一步 → 写入结果 → request_id”。RED 为 1 file / 5 tests 全失败；GREEN 为专项与关联回归 11 files / 64 tests、Bot 质量门禁 56 files / 328 tests 通过。证据：`evidence/P0/M18-US-07/summary.md`。真实 Guild 三角色/桌面手机 UAT 归 M18-US-08。
- [ ] `M18-US-08` Bot/全仓回归与真实 Guild 桌面/手机三角色视觉 UAT：自动化收口已完成，修正 2 个旧 operationId、8 个缺失验收 fixture 索引（含独立九项目候选池）、1 个 API `prefer-const` 门禁和 5 条 UAT 清单映射；验收矩阵为 297 行，外部用例 80 条。Bot 质量门禁为 56 files / 328 tests，全仓为 243 files / 1222 tests，均通过。已在配置的真实派单频道幂等发送 6 条视觉样例，覆盖 2 张状态图、13 张游戏横幅和真实 `1️⃣` 报名 Embed，重复执行返回 `REUSED`，业务写入 0。`AT-EXP-001` 自动化通过；`AT-EXP-002`–`005` 仍缺老板/陪玩/客服三账号、桌面/手机、Reaction 增删、重启和具名签署，因此 Story 保持 `IN_PROGRESS` 且发布门禁 fail-closed。证据：`evidence/P0/M18-US-08/summary.md`。
  - 视觉与角色二次校准（2026-08-10）：以用户提供的 1280×720 圆胖黑猫设定图作为唯一母版，逐张重绘迎新、派单/流单和 13 张项目横幅；统一中性蓝调傍晚、青蓝/暖金与圆润标题字体，明确禁止头顶毛束且尾巴只从后腰连接。16 张运行时资产保持既有文件名与尺寸；欢迎/游戏 WebP 为 130872–234798 bytes，派单 PNG 为 1.74–1.84 MB。RED 为角色规范缺失 1 failed / 2 passed；GREEN 为发布审计 3/3、关联 5 files / 30 tests、Bot 57 files / 334 tests、24 Pieces、lint/format/typecheck/build 与全仓 249 files / 1245 tests。真实 Guild `AT-EXP-002`–`005` 仍待具名 UAT，Story 不勾选完成。

## M19：跨角色状态一致性与实时刷新

> M19 以用户体验为优先，把每次业务变化按客户、陪玩、客服 Discord 协同卡和客服工作台逐一审计。客户不提交 readiness；所有当前有效陪玩均已就绪才首次开始服务。展示层只消费统一 API 事实，失败通过 Outbox 或重取恢复。

- [x] `M19-US-01` 跨角色状态与刷新合同：新增九类订单状态、四类受众及礼物/客服任务/退款/陪玩准入/Bot 配置的消费者矩阵；冻结事务与 Outbox 原子性、Discord 原位更新、Dashboard 主动重取、5 秒目标与 30 秒告警边界，并明确 M19/M10 取代旧双边 readiness。RED 为 1 file / 4 tests 全失败；GREEN 证据见 `evidence/P0/M19-US-01/summary.md`。本 Story 不声称运行时已全部修复。
- [x] `M19-US-02` 招募与试音跨角色刷新审计：逐写路径确认开始招募、普通/Reaction 报名与撤回、终止、部分确认和全部确认均在业务事务内写入所需 `SELECTION_POOL_SYNC`/`PANEL_SYNC`；Worker 以稳定 nonce、持久化 Reaction 映射和原位编辑收敛公开卡、客户名单、客服试音通知、阵容和权限。2026-08-10 真实订单回归发现并修复整单备注未向项目派单卡兜底、常驻客户面板绕过 M18 层级 renderer 两处投影缺口；真实订单 `P-D7413498` 只读核对为整单备注“会聊天”且项目备注为空，修复后统一按项目备注优先、整单备注兜底，并将客户卡改为服务/金额/老板需求/阵容/报名进度/下一步的中文品牌层级。Worker 启动时以版本化 dedupe 一次性刷新所有活动客户面板，确保部署后现有订单也收敛。聚焦 5 files / 60 tests 与全仓 typecheck 通过。证据：`evidence/P0/M19-US-02/summary.md`。
- [x] `M19-US-03` 就绪、服务与完成跨角色刷新：ACCEPTED 客服协同卡在状态值不变时改为稳定 nonce 原位 PATCH，客户面板、陪玩视图、客服卡和工作台均使用逐陪玩 readiness；超时只指名未确认陪玩，客户写 readiness 被拒绝，全体当前有效陪玩就绪后才开始。RED 1 file / 3 failed；GREEN 聚焦 11 files / 86 tests、合同门禁 3 files / 78 tests、全仓 245 files / 1229 tests、API/Bot/Dashboard typecheck、route parity 159 operations 与 lint 通过。证据：`evidence/P0/M19-US-03/summary.md`。
- [x] `M19-US-04` 客服任务与高风险业务刷新：客服队列、已打开订单、班次/汇总和今日指标在页面可见时每 5 秒重取，隐藏时停止，恢复可见立即更新；所有客服写操作成功或冲突后统一回读，旧响应不覆盖新事实，失败保留上次可信内容并显示 `request_id`。取消/异常/礼物/退款/接管专项 25 files / 79 tests，新增刷新测试 1 file / 3 tests，Dashboard typecheck/build 和 lint 通过。证据：`evidence/P0/M19-US-04/summary.md`。
- [ ] `M19-US-05` 全业务回归、时效监控与真实 Guild UAT（自动化候选已完成）：Worker 现按目标消费者记录投影收敛秒数与 5 秒目标是否达成；超过 30 秒或耗尽重试时输出包含聚合对象、消费者和 `request_id` 的脱敏告警。失败的招募卡同步与客服提醒已纳入 L2+ 恢复工具，Role 同步仍仅 L4 可见。自动化 RED 1 file / 3 failed，GREEN 可观测性/权限兼容 5 files / 44 tests。待真实 Guild 的客户、陪玩、客服、Dashboard、重启与消息丢失 UAT 后才勾选完成。证据：`evidence/P0/M19-US-05/summary.md`。

## M20：Discord 动作清晰度与控件收敛

> M20 统一状态 × 角色动作、首次使用文案和组件布局。每个客户可操作的非终态订单保留取消入口，客户主面板、陪玩工作台与客服协同卡不再混放跨角色写按钮；展示层只消费 API 返回的可信 `availableActions`。

- [x] `M20-US-01` 状态、角色、文案与布局合同：新增 `Discord动作与按钮矩阵.md`，覆盖九类订单状态、取消处理边界、客户/陪玩/客服动作隔离、完整首次使用词库、一屏一个 Primary、每行通常至多三个按钮、危险动作单独成行和双向分页；同步主规格、backlog、交互映射、验收与镜像。RED 为 1 file / 4 tests 全失败；GREEN 证据见 `evidence/P0/M20-US-01/summary.md`。本 Story 不声称运行时已修复。
- [x] `M20-US-02` 可信可用动作与取消能力：新增服务端 `order-actions` 视图模型，客户订单、陪玩工作台、生命周期和客服订单分别返回角色化 `availableActions`；客户已存在取消任务时只显示处理进度，终态不提供取消。`EXCEPTION` 取消预览现进入幂等 `CANCELLATION_ASSIST`，订单与资金保持原可信事实。RED 为模块缺失 1 suite / 0 tests；GREEN 为专项 1 file / 5 tests、关联 6 files / 21 tests、API/Bot typecheck 通过。证据：`evidence/P0/M20-US-02/summary.md`。
- [x] `M20-US-03` Discord 全流程按钮与角色视图收敛：四步下单与所有客户可操作非终态保留取消/取消申请；常驻 Worker 老板卡移除陪玩写按钮，陪玩工作台只显示陪玩动作；招募、试音、服务中心和提交页统一为动词+对象/结果文案，危险动作独立、无目标禁用按钮省略；订单、消费与周报分页支持上一页/下一页。RED 为 1 file / 6 tests 全失败；GREEN 为专项 1 file / 9 tests、Bot 58 files / 342 tests、24 Pieces、lint/format/typecheck/build 通过。证据：`evidence/P0/M20-US-03/summary.md`。
- [ ] `M20-US-04` 旧 renderer 清理、全量回归与真实 Guild UAT（自动化候选与当前 Guild 老板视图已完成）：删除无生产调用的 first-wins 派单、旧接单完成卡和 dropdown 报名 renderer；发布门禁覆盖现用 custom ID 路由、旧组件恢复与订单/消费/周报双向分页。全仓 253 files / 1264 tests、Bot 59 files / 343 tests、24 Pieces、lint/format/typecheck/build 全通过。2026-08-10 已彻底停止孤儿 API/Dashboard 后同轮启动 API、Worker、Bot、Dashboard，API health/ready 正常；Worker 原位刷新 1 张活跃面板。当前 Guild 核验 `P-976789E1` 与存量草稿 `P-1FA1B829` 均有“取消订单 / 联系猫舍前台 / 刷新最新状态”，无预计收益和含糊“查看/加入单点”标签，保留原消息 ID。仍待老板、陪玩、客服三角色的桌面/手机具名 UAT，因此 Story 不勾选完成。证据：`evidence/P0/M20-US-04/summary.md`。

- [x] `M20-US-05` Discord Bot 审查修复合同与计划：新增九个顺序修复 Story，冻结礼物只接受订单内有效陪玩明细 `participantIds`、API 推导真实 receiver、禁止任意 `receiverId` 的现行合同；同步 AGENTS、主规格、backlog、交互、验收、TODO、演示与镜像。RED 为专项 1 file / 3 tests 全失败；GREEN 为合同专项与 M10/M20 回归 3 files / 9 tests 全通过，`git diff --check` 通过。证据见 `evidence/P0/M20-US-05/summary.md`。本 Story 只完成合同与计划，不声称运行时缺陷已修复。
- [x] `M20-US-06` 礼物确认组件协议修复：统一 affordability renderer 与 handler 的 selected participant custom ID 前缀；真实 Discord renderer JSON 的 confirm/refresh/back 均恢复全部 participantIds，本地组件上下文缺失明确零 API 写入。RED 为 1 file / 4 tests 全失败；GREEN 为礼物专项与体验回归 3 files / 17 tests、Bot lint/format、根 build 和 Bot typecheck 全通过。证据：`evidence/P0/M20-US-06/summary.md`。验收：`AT-MULTI-005;AT-BOT-REV-004`。
- [x] `M20-US-07` 过期就绪动作零写入恢复：删除 readiness `CONFLICT` 后以新版本自动重放旧写入的路径；所有生命周期版本冲突只回读最新订单、原位刷新并显示原 request_id。RED 为 1 file / 1 test 失败且证明发生两次写调用；GREEN 为生命周期、动作 renderer 相关回归 4 files / 31 tests、Bot lint/format/typecheck 全通过。证据：`evidence/P0/M20-US-07/summary.md`。验收：`AT-ACT-003`。
- [x] `M20-US-08` 候选名单双向分页与跨页选择：Discord custom ID 只携带紧凑 UUID、版本和 pageIndex，API 原始 cursor 仅在 deferred handler 内逐页解析；内页同时提供上一页/下一页，已选陪玩通过 Discord disabled select 携带并在本页重选时正确替换。RED 首轮 1 file / 4 tests 全失败，补强 RED 2 failed / 4 passed；GREEN 为候选、动作与发布门禁回归 4 files / 38 tests、Bot lint/format/typecheck 全通过。证据：`evidence/P0/M20-US-08/summary.md`。验收：`AT-ACT-004;AT-SEL-004`。
- [x] `M20-US-09` 可信 Discord 频道副作用恢复：退役语音房仅在 Bot 观察到同 Guild、配置分类、同频道 ID 的精确 `selection-* → selection-*-closing` 迁移后取得短期授权；相似名称、错误分类、跨 Guild、过期或有人频道均零删除，重启丢失内存授权时安全保留频道并交由终态归档收敛。订单频道改名失败返回结构化结果并记录错误；API 创建/恢复事实提交后，面板或改名异常不再删除业务频道。RED 为 1 file / 2 tests 全失败；GREEN 为副作用、选人语音及私密频道回归 3 files / 28 tests，Bot lint/format/typecheck、根 build、piece manifest 与 `git diff --check` 全通过。证据：`evidence/P0/M20-US-09/summary.md`。验收：`AT-BOT-REV-001;AT-CHN-003;AT-TRN-003`。
- [x] `M20-US-10` Discord 交互响应与命令权限收敛：`/service-center` 已设为 Guild-only 且要求 `ManageGuild`，普通成员不能发布公共常驻入口；`/player-workbench`、订单/项目备注 Modal 均在 API 前 defer，409、5xx、非 JSON 与内部异常统一返回私密、含 request_id 的反馈。新增工作台和 Modal feature executor，抽出公共入口订单频道 adapter，并为服务中心 Button Piece 增加按 ACK 状态选择 reply/follow-up 的顶层恢复，使其由 749 行降至约 600 行。RED 为专项 suite 因缺少 executor 模块失败；GREEN 为 Bot 全量 64 files / 362 tests、lint/format/typecheck、根 build、24-piece manifest 与 `git diff --check` 全通过。证据：`evidence/P0/M20-US-10/summary.md`。验收：`AT-BOT-REV-003;AT-BOT-REV-004`。
- [x] `M20-US-11` 静默 mention 与现行文案层级：Embed 与 Components V2 的 reply/update renderer 均默认 `allowedMentions: { parse: [] }`，展示名、备注和 API 返回文本不能意外触发用户、Role、everyone 通知；新人入口只保留“开始找陪玩”一个 Primary 并将渲染版本升至 5；报名反馈改为“本轮招募结束前可撤回”，礼物金额不变量错误文案改为 CAT subunit。RED 为 1 file / 3 tests 全失败；GREEN 为专项/体验回归 4 files / 20 tests、Bot 全量 65 files / 365 tests、lint/typecheck/build/diff check 全通过。证据：`evidence/P0/M20-US-11/summary.md`。验收：`AT-SEL-007;AT-ACT-002`。
- [x] `M20-US-12` Transcript 与 Reaction 稳定事件身份：Message update partial 先 fetch，无法解析时 fail-closed 并记录结构化 warning；UPDATED eventId 由消息 ID、Discord editedTimestamp 与内容/Embed/附件指纹派生，同一重投稳定、同毫秒不同内容仍形成不同 append-only 事实，无 editedTimestamp 不再写入 `unknown` 事件。Reaction live 观察使用有界 TTL transition tracker，同状态重投复用身份、add/remove/add 递增身份；启动对账使用完整 Discord/DB 快照的可复现 hash，Actor sourceEventId 与 API idempotency key 一致，移除随机 UUID。RED 为 1 file / 4 tests 全失败；GREEN 为事件专项回归 3 files / 24 tests、Bot 全量 66 files / 370 tests、format/lint/typecheck/build/diff check 全通过。证据：`evidence/P0/M20-US-12/summary.md`。验收：`AT-DOP-002;AT-SEL-008`。
- [x] `M20-US-13` Bot 运行时边界与模块债务收口：启动期一次构造并注入共享 transport、API/config/onboarding/transcript/role-sync client，Piece 不再读环境或自建 client；订单、钱包、礼物、候选页和 Bot 配置关键 DTO 对非法响应失败关闭并转为稳定 502；config session 与分页历史均有 TTL/容量上限；删除直接 accept/decline、availability/倒计时 DTO、假频道权限计划和死回复 helper，并把陪玩工作台 renderer 拆出，使服务中心门面降至 2200 行以内。RED 为新增 suite 因缺 runtime dependency module 失败；GREEN 为专项 4 files / 15 tests、Bot 全量 67 files / 375 tests，lint/format/typecheck/build/24-piece manifest 全通过。证据：`evidence/P0/M20-US-13/summary.md`。验收：`AT-BOT-REV-002;AT-BOT-REV-003;AT-BOT-REV-004;AT-BOT-REV-005`。
- [ ] `M20-US-14` Discord 生产文案去开发测试痕迹：实现候选已全量清理 P0、测试环境、占位承诺、API/服务端、Bot 配置实现词和原始状态/资金枚举等用户可见文案；“测试投递”改为“发送频道预览”且投递行为不变；保留并重写非真实资金警告，所有异常仍保留 request_id。RED 为 1 file / 3 tests 全失败；GREEN 为专项 8 files / 62 tests、Bot 全量 68 files / 378 tests、`main` 全仓 267 files / 1346 tests，lint/format/typecheck/build/24-piece manifest 全通过。剩余阻断：`AT-ACT-002` 真实 Guild 桌面/移动端文案与布局 UAT。证据：`evidence/P0/M20-US-14/summary.md`。验收：`AT-ACT-002;AT-BOT-REV-005`。
- [x] `M20-US-15` Bot 巨型文件与复杂度收口：已按 API adapter、Bot 配置、selection、route codec、订单领域与交互路由拆分巨型模块，并保留稳定 facade 与共享 transport。RED 结构测试报告 18 项体量/复杂度违规；GREEN 后全目录最大文件 660 行、最大函数 141 行、最高决策复杂度 19，`quality:bot` 69 files / 380 tests 与全仓回归通过。证据：`evidence/P0/M20-US-15/summary.md`。验收：`AT-BOT-REV-003;AT-BOT-REV-004;AT-BOT-REV-005`。
## Dashboard 全量审查整改（2026-08-11）

- [x] `codex/dashboard-full-review-fixes` Dashboard-only 全量审查整改候选：覆盖 `M4-US-02`、`M6-US-02/04`、`M13-US-04`、`M14-US-03/04/05`、`M15-US-04/05/06/08`、`M16-US-03/04`、`M19-US-03/04` 的 Dashboard 呈现与交互门禁；相关验收包括 `AT-LST-004`、`AT-DOP-003/004/005`、`AT-SET-004/006`、`AT-SUX-004/006`、`AT-REV-001/004/005`、`AT-STATE-001/003`。修复了任务/订单错配、乱序详情覆盖、页面白屏、资金权限与可重试幂等、结算替代批次与分页、直达路由 403/404、低权限动作说明、就绪/归档语义、退役 Bot 配置、网络失败恢复、顶部搜索/账户菜单及参考数据失败告警。Dashboard 相关 Vitest `51 files / 261 tests`、根 TypeScript、Dashboard production build、Dashboard ESLint 零警告、Chromium Dashboard E2E `143/143` 与 `git diff --check` 均通过。计划与分批证据见 `evidence/P0/dashboard-full-review-remediation/`。
  - 外部状态不被本次自动化替代：原 Story 中尚待真实员工/真实 Guild 的 UAT 继续保持原未完成状态。
  - 已确认前置阻断：OpenAPI 声明通用 `/api/v1/admin/approval-requests`，但 API 运行时尚未注册对应路由；Dashboard 不显示不存在的审批入口，也不伪造待审批计数或成功路径，L1 继续使用已实现的 StaffTask 升级链路。
  - 此前记录的 API 合同债务已由 `codex/api-review-legacy-dispatch-retirement` 关闭：API 不再返回、接受或消费旧超时、轮次与自动开关，生产组合不装配旧 Dispatch store；Bot 源码仍不在该 API Story 范围内，若仍展示旧字段会收到安全的 400，需由 Bot 专项清理客户端呈现。
- [x] `codex/dashboard-production-copy` Dashboard 生产文案全量整改：删除未接入审批占位；将 Pilot、测试环境、API/服务端、预检、Snowflake、step-up、原子/快照等内部措辞改为员工可执行的业务语言；错误标识统一显示“请求编号”，金额字段统一显示合同规定的 CAT subunit。保留非生产资金警示、Bot 频道验证能力以及原有权限、状态、金额和幂等语义。RED 为 1 file / 2 tests 全失败；GREEN 为专项 10 files / 69 tests、Dashboard 相关 Vitest 52 files / 263 tests、根 typecheck、Dashboard build/ESLint、Chromium E2E 142/143 加旧文案断言复验 1/1 和 `git diff --check` 全通过。证据：`evidence/P0/dashboard-production-copy/summary.md`。相关验收：`AT-ACT-002;AT-LST-004;AT-STATE-001;AT-STATE-003`。
- [x] `codex/dashboard-cat-display` Dashboard 猫条金额输入整改：日常展示和录入不再暴露 subunit/最小单位；退款、取消结算、陪玩固定收益、服务与礼物目录、订单陪玩明细均按猫条填写，支持一位小数，并在共享 builder 边界精确转换为 API 整数金额。USD 充值收据、API/数据库合同、权限、资金状态机和幂等语义不变。RED 为新增 1 file / 3 tests 全失败；GREEN 为专项 6 files / 48 tests、Dashboard 相关 Vitest 53 files / 266 tests、根 typecheck、Dashboard build/ESLint、完整 Chromium E2E 143/143、最终金额相关 Chromium 30/30 与 `git diff --check` 全通过。证据：`evidence/P0/dashboard-cat-display/summary.md`。相关验收：`AT-REV-001;AT-SUX-006;AT-TAG-003;AT-COMP-001;AT-MULTI-001;AT-MULTI-002`。
- [x] `codex/dashboard-module-boundaries` Dashboard 巨型文件与职责边界收口：将后台业务页的动作、详情、Overlay 与展示辅助函数，业务请求构建器与 CAT 金额边界，客服辅助面板与视图类型，以及应用导航壳层分别迁入单一职责模块；`App.tsx` 仅保留会话、授权和路由装配，原公共导出保持兼容。RED 为结构门禁 1 file / 2 tests 全失败；GREEN 后最大 Dashboard TS/TSX 文件 381 行，结构门禁 2/2、全部 Dashboard 相关测试 49 files / 251 tests、Dashboard typecheck/build、ESLint 零警告通过。证据：`evidence/P0/dashboard-module-boundaries/summary.md`。结构验收：`DB-MOD-001;DB-MOD-002`；既有业务验收 `AT-LST-004;AT-SUX-004;AT-SUX-006;AT-REV-001;AT-REV-004;AT-REV-005;AT-STATE-001;AT-STATE-003` 保持不变。

## API 全量审查整改（2026-08-12）

- [x] `codex/api-review-refund-integrity` 独立退款累计上限修复：退款预检按成功来源扣款减去既有 PENDING/SUCCEEDED Refund 计算剩余可退额，PostgreSQL 最终提交锁定来源扣款并在同一事务重算，防止不同幂等键并发或顺序超退；内存实现保持同一不变量，同时纠正遗留 USD 错误文案为 CAT。RED 为专项 1 failed / 7 passed，证明第三笔退款可将累计值推过原始扣款；GREEN 为根 typecheck、API/DB/资金及 Bot/Dashboard 兼容回归 8 files / 23 tests、`git diff --check` 通过。未修改 Bot/Dashboard 源码或请求响应合同。证据：`evidence/P0/api-review-refund-integrity/summary.md`。验收：`AT-DOP-001;AT-CAN-009;AT-REF-005;AT-RFP-008`。
- [x] `codex/api-review-wallet-scope` 钱包客户作用域修复：Dashboard 管理余额、流水、充值、渠道退款、Adjustment 与凭证上传统一按可信 Actor Context 校验目标客户 Guild；凭证下载先从持久化元数据推导客户再鉴权，上传在读取或写入文件前拒绝越权。生产运行时复用客户 Profile PostgreSQL scope，拒绝统一返回不可枚举 404 且不产生资金或附件事实。RED 为跨 Guild 充值错误返回 201 并入账；GREEN 为钱包专项 5/5、关联回归 6 files / 22 tests、Bot 展示兼容回归、根 typecheck 与 `git diff --check` 通过。未修改 Bot/Dashboard 源码、URL、请求或响应合同。证据：`evidence/P0/api-review-wallet-scope/summary.md`。验收：`AT-WAL-003;AT-WAL-007;AT-DOP-004`。
- [x] `codex/api-review-order-guild-scope` 订单 Guild 作用域修复：后台退款/结案/改派、客户订单读取与全部写路径、自动化暂停/恢复以及 readiness/完成链统一按可信 Actor Guild 隔离；生命周期在 PostgreSQL 锁行后的最终提交边界再次校验 Guild。保留内部客户全局一个活跃订单的不变量，跨 Guild 既不泄露既有订单也不创建第二单。RED 证明跨 Guild 退款、客户读取和暂停均错误返回 200；GREEN 为专项 4 files / 33 tests、PostgreSQL/API/Bot/Dashboard 两批兼容回归 10 files / 64 tests 与 6 files / 33 tests、根 typecheck、`git diff --check` 通过。未修改 Bot/Dashboard 源码、URL、请求或响应合同。证据：`evidence/P0/api-review-order-guild-scope/summary.md`。验收：`AT-LST-008;AT-SUX-004;AT-MULTI-003;AT-ACT-003`。
- [x] `codex/api-review-referral-commission-scope` 推荐与返佣 Guild 作用域修复：机密推荐/返佣列表、详情、绑定、纠错、确认、支付登记与 Adjustment 全部把可信 Actor Guild 带入 store；推荐按被推荐人与受益人的持久化 Discord Guild 绑定校验，返佣按不可变消费来源关联的订单或礼物订单推导 Guild，并在事务锁行及幂等重放后仍以相同 scope 重取。跨 Guild 列表为空，详情/写入不可枚举 404 且零写入。RED 为 store 未收到 Guild 的 2 failed / 9 passed；GREEN 为专项 3 files / 18 tests、PostgreSQL/个人隐私/Bot/Dashboard 回归 7 files / 40 tests、根 typecheck 与 `git diff --check` 通过。未修改 Bot/Dashboard 源码或公开合同。证据：`evidence/P0/api-review-referral-commission-scope/summary.md`。验收：`AT-RFP-005;AT-RFP-006;AT-RFP-007;AT-LST-008`。
- [x] `codex/api-review-gift-audit-atomicity` 礼物审计原子性修复：核对、批准/升级、内部钱包捕获、拒绝和客户撤回均延迟到安全写路由的 commit 边界；PostgreSQL 将礼物/任务/审批/钱包/预留事件/交易/消费/返佣/Outbox 与成功审计纳入同一事务，内存实现对审计失败完整回滚。RED 为 2 failed / 7 passed，证明批准/拒绝成功审计缺失且审计失败后仍保留业务事实；GREEN 为专项 1 file / 9 tests、PostgreSQL/钱包回归 4 files / 7 tests、礼物 API/Worker 7 files / 40 tests、Bot/Dashboard 兼容 6 files / 43 tests、根 typecheck 与 `git diff --check` 通过。未修改 Bot/Dashboard 源码或公开合同。证据：`evidence/P0/api-review-gift-audit-atomicity/summary.md`。验收：`AT-GFT-006;AT-GFT-009;AT-RES-009;AT-RES-010;AT-AUD-001;AT-AUD-004`。
- [x] `codex/api-review-approval-contract` 审批事实所有权合同修复：删除允许 Bot/Dashboard 自行构造动作、对象、金额和快照的通用审批创建接口，统一为礼物、退款和订单决议业务接口基于服务端可信事实生成审批；通用队列只读取和决定 `GIFT_APPROVE`、`REFUND_EXECUTE`、`ORDER_RESOLVE`，其他预留动作失败关闭。主规格、OpenAPI、API 说明、数据约束、交互/文案映射、backlog、原型及生成镜像已同步。RED 为 1 file / 2 failed / 1 passed；GREEN 为合同回归 4 files / 11 tests、当前 164 个已注册路由文档门禁和 `git diff --check` 通过。未修改 Bot/Dashboard/API 运行时源码或现有业务请求/响应。证据：`evidence/P0/api-review-approval-contract/summary.md`。验收：`AT-GFT-006;AT-RBAC-001;AT-RBAC-006`。

## M21：低负担完单评价与五星好评播报

> M21 只推进订单完成后的可选评价与明确同意的五星公开流程。礼物合同与运行时不在 M21 范围内；评价不得自动影响派单、准入、收益、权限、处罚或资金。

- [x] `M21-US-01` 完单评价合同与 RED 基线：冻结订单整体、每位有效陪玩和本单实际客服三类可选目标；星级点击成功即保存、留言始终可选；多陪玩可只评部分、批量同分或分别打分。五星好评只有在老板明确同意公开后才生成一张安全聚合快照，并排除一至四星、留言、未评价或非五星对象、客户身份、金额、钱包、私密频道和内部客服身份。验收：`AT-REVIEW-001`–`004`。RED 为专项 1 file / 5 tests 全失败；GREEN 与合同校验证据见 `evidence/P0/M21-US-01/README.md`。本 Story 不声称运行时已实现。
- [x] `M21-US-02` 评价事实、迁移与统一业务 API：统一 API 依据可信 Guild、订单所有者、完成订单、有效参与明细和实际首位客服响应派生目标；24 小时内可按一个或多个目标原子保存不可变星级，低分无需理由，留言可稍后追加且始终可选。迁移回填旧客服评价，旧入口在 Bot 切换前同步写入新事实；公开请求只冻结明确同意时已有的五星安全快照。并发、伪造目标、越权、过期、追加只读约束及订单/钱包/预留不变均通过 PostgreSQL 门禁。验收：`AT-REVIEW-001`、`AT-REVIEW-004`；RED、GREEN、文件与命令证据见 `evidence/P0/M21-US-02/README.md`。本 Story 不声称 Discord 评价中心或好评频道投递已实现。
- [x] `M21-US-03` Discord 低点击评价中心：完单卡统一为一个“评价本次服务”入口；打开后整体评价只需一次星级点击，多位陪玩同分只需多选一次再点一次星级，低分不追问原因，留言通过独立可选 Modal 追加。目标与已保存状态每次来自统一 API；跨页选择使用绑定 Guild、老板和订单的 HMAC 签名状态，Bot 重启不丢失且不使用进程内会话 Map；陈旧组件只回读最新事实，不重放旧评分意图。真实 Button、Select、Modal Sapphire handler、HTTP DTO 失败关闭与订单卡投影均已接通。自动化低点击门禁及兼容回归通过；真实 Guild/移动端 UAT 留在 `M21-US-05`。验收：`AT-REVIEW-002`、`AT-REVIEW-004`；证据见 `evidence/P0/M21-US-03/README.md`。
- [x] `M21-US-04` 明确同意的五星好评聚合播报：评价中心提供五星安全预览、“同意公开五星好评”与“仅内部保存”；统一 API 冻结的快照由 `REVIEW_BROADCAST` Worker 投递至同 Guild 的 `review_broadcast_channel_id`，稳定 nonce 支持重试去重和消息缺失恢复。Bot 配置 API、Discord `/bot-config` 与 Dashboard 均可选择、验证“好评展示频道”。自动化隐私负例、PostgreSQL、配置、Worker 和关联回归已通过；2026-08-13 真实 Guild 自清理 UAT 验证首次播报、重放去重、删卡恢复、单卡收敛和临时频道清理全部通过。老板端移动交互与完整外部签署留在 `M21-US-05`。证据：`evidence/P0/M21-US-04/README.md`。
- [ ] `M21-US-05` 全量回归、真实 Guild 多陪玩/移动端/隐私 UAT 与发布收口进行中：已建立未通过发布基线、真实环境只读预检和桌面/手机执行合同；隔离 Harness 可自动创建/删除 `_uat` 数据库与临时 Discord 频道，幂等准备三陪玩/首响客服订单和已捕获资金、收益、返佣、派单、风控、权限基线，并验证内部保存零公开、五星白名单、重放去重、删卡恢复及所有受保护事实不变。自动专项已通过。当前仍需真实老板 Discord 用户 ID、桌面/手机操作与具名运营/QA 签署；不得用自动 Harness 或 Worker 探针替代真人外部验收。候选证据：`evidence/P0/M21-US-05/README.md`；执行手册：`evidence/P0/M21-US-05/human-uat-runbook.md`。
- [x] `codex/api-review-approval-runtime` 审批运行时闭环：新增只读/决定四个统一审批 API，只执行服务端生成的礼物、退款与订单结案快照；按可信 Actor Guild、累积权限、所需等级、近期 step-up、目标版本与不可变 hash 失败关闭。PostgreSQL 将决定、领域资金事实与成功审计原子提交，礼物拒绝同步释放预留，兼容业务入口直接执行或礼物撤回/过期会把旧审批明确转为 `CANCELLED/EXPIRED`。公开投影不泄露 payload/Guild，分页游标签名并绑定 scope；审计详情与完整 changes 投影补齐，双向门禁确认 179 个生产 operation 与 OpenAPI 精确一致。聚焦回归 11 files / 63 tests、API typecheck、根 build、API ESLint 0 errors 与 `git diff --check` 通过。未修改 Bot/Dashboard 源码或既有业务请求/响应。证据：`evidence/P0/api-review-approval-runtime/summary.md`。验收：`AT-GFT-006;AT-GFT-009;AT-RBAC-001;AT-RBAC-006;AT-AUD-001;AT-AUD-004;AT-REF-005;AT-CAN-009`。
- [x] `codex/api-review-reservation-aggregation` FundReservation 剩余预留统一口径：修复订单提交、礼物提交与账户聚合把 `PARTIALLY_SETTLED` 原始金额全额冻结的问题；订单、礼物、账户、钱包、客户 Profile、运营指标与订单参与者调价现统一按原始金额减 `CAPTURED/RELEASED/EXPIRED` 追加事件计算，并对超额结算夹为零。RED 为领域模块缺失导致 1 suite failed / 0 tests；GREEN 为 PostgreSQL/聚焦回归 9 files / 36 tests、API typecheck、根 build、API ESLint 0 errors 与 `git diff --check` 通过。未修改 Bot/Dashboard 源码或公开请求/响应合同。证据：`evidence/P0/api-review-reservation-aggregation/summary.md`。验收：`AT-PL-002;AT-RES-002;AT-RES-003;AT-RES-007;AT-RES-011;AT-MET-006;AT-PRF-006;AT-MULTI-002;AT-MULTI-005`。
- [x] `codex/api-review-receipt-orphan-cleanup` 私有凭证孤儿文件清理：修复 multipart 文件已落盘后因字段无效、资金依据不存在或事务/成功审计失败而留下不可达敏感文件的问题；私有存储增加 UUID-key 幂等删除，上传 handler 与安全 staged-write abort 在未提交路径执行精确补偿，成功提交和授权下载合同不变。RED 为 1 file / 4 tests 全失败；GREEN 为凭证/钱包/审计/安全写入回归 7 files / 39 tests、API typecheck、根 build、API ESLint 0 errors 与 `git diff --check` 通过。未修改 Bot/Dashboard 源码，也未新增任何文件删除 API。证据：`evidence/P0/api-review-receipt-orphan-cleanup/summary.md`。验收：`AT-WAL-007;AT-AUD-002`。
- [x] `codex/api-review-quality-compatibility` API 静态质量与全量兼容性门禁：清除 API 生产源码 27 个 ESLint warning，新增 API 零告警脚本与回归门禁，删除死 helper/import 和无意义异常重抛；保留 M11 选人池作为唯一派单写入口并修正旧测试，重建 308 条验收追踪矩阵，确认 179 个生产 operation 与 OpenAPI 双向一致；PostgreSQL 服务套餐测试改为私有 Unix socket，消除并行端口碰撞。最终 API/Dashboard lint 零告警、API typecheck、根 build、路由合同、278 files / 1393 tests 全通过。未修改 Bot/Dashboard 源码。API 巨型模块拆分作为 P2 维护性债务保留。证据：`evidence/P0/api-review-quality-compatibility/summary.md`。结构验收：`API-QUAL-001`。
- [x] `codex/api-review-readiness-contract` Readiness 现行合同一致性：解决主规格旧“两方就绪”叙述与 M10/M19、OpenAPI、交互和运行时“客户只读、全体有效陪玩决定开始”的冲突；同步 AGENTS、主规格、数据合同、验收/fixture、UAT、文案、交互原型、演示与发布镜像，删除客户 readiness 按钮和 WAITING_CUSTOMER 场景。RED 为 1 file / 4 failed / 1 passed；GREEN 为合同 5/5、M10/M19/发布追踪联合 7 files / 87 tests、308 条验收矩阵可复现与 `git diff --check` 通过。未修改 Bot/Dashboard 源码或 API 运行时；旧数据库聚合列写入留给下一独立 Story。证据：`evidence/P0/api-review-readiness-contract/summary.md`。验收：`AT-PL-005;AT-RDY-001;AT-RDY-002;AT-RDY-003;AT-RDY-004;AT-RDY-005;AT-MULTI-003;AT-STATE-001`。
- [x] `codex/api-review-readiness-runtime` Readiness 运行时事实完整性：API 只接受订单中当前有效陪玩本人确认，就绪、超时、开始与完成结算全部以逐参与者事实为准；零参与者订单不能开始或完成，`customer_ready_at` 不再伪造为客户确认，收益不再回退到旧订单级陪玩字段。追加数据库守卫要求至少一名有效参与者且全员已就绪，伪造旧聚合时间戳不能绕过。RED 为 1 file / 3 tests 全失败；GREEN 为聚焦 9 files / 55 tests、真实 PostgreSQL 3/3、全仓 280 files / 1403 tests、179 operations、API lint/typecheck、根 build、Prisma 与全量迁移校验全通过。未修改 Bot/Dashboard 源码或现行公开请求/响应结构。证据：`evidence/P0/api-review-readiness-runtime/summary.md`。验收：`AT-PL-005;AT-RDY-001;AT-RDY-002;AT-RDY-003;AT-RDY-004;AT-RDY-005;AT-MULTI-003;AT-STATE-001`。
- [x] `codex/api-review-legacy-dispatch-retirement` 旧自动派单 API 退役：停止对外投影、写入或消费旧超时、轮次和自动开关；Operations 同步退役旧超时策略，生产 API 删除旧 Dispatch store/player pool 装配，SelectionPool 保持唯一分配入口。OpenAPI、API 说明与业务配置合同统一为客户手动开始/终止无时限招募，报名不受 Presence、旧 availability 或活动订单阻断，客户原子终选。RED 为 1 file / 4 tests 全失败；GREEN 为聚焦 9 files / 65 tests、核心 6 files / 44 tests、API lint/typecheck、根 build、179 operations 和最终全仓 281 files / 1407 tests 全通过。未修改 Bot/Dashboard 源码；旧表、历史 JSON 与未装配的 legacy 模块保留为兼容事实。证据：`evidence/P0/api-review-legacy-dispatch-retirement/summary.md`。验收：`AT-DSP-011;AT-DSP-012;AT-DSP-015;AT-SEL-001;AT-SEL-005;AT-SEL-007`。

## M22：独立送礼入口与匿名模式

> M22 保留订单内送礼，并增加同 Guild ACTIVE 陪玩的独立入口。匿名只影响陪玩与公开频道展示，内部客服、资金、风控和审计仍使用真实发送者。客服辅助已冻结为模式 B：专用权限客服依据老板本人授权消息并通过本人 TOTP 后直接预留老板余额。

- [x] `M22-US-01` 独立送礼与匿名合同：同步主规格、AGENTS 护栏、Backlog、planned API、Prisma 数据合同、业务配置、交互、fixture、UAT 清单和验收镜像；冻结 `playerProfileId` 可信接收人、余额不足零写入、匿名老板展示与内部真实 sender 边界。RED 为专项 1 file / 5 tests 全失败；GREEN 为专项 1 file / 5 tests、合同/追踪 5 files / 82 tests、最终全仓 288 files / 1443 tests 全通过；Prisma、183 个运行时路由双向合同、317 行验收矩阵、JSON、镜像、CSV 与 `git diff --check` 同时通过。验收：`AT-GIFT2-001`–`004`；证据：`evidence/P0/M22-US-01/README.md`。本 Story 不声称运行时已实现。
- [x] `M22-US-02` 独立礼物事实、迁移与统一 API：新增同 Guild ACTIVE 陪玩目录、只读 affordability 和原子创建三条统一 API；最终事务从 `playerProfileId` 派生 receiver，重校验目录、价格、Guild 和内部 CAT 余额，并发超支最多成功一笔。匿名公开投影仅显示“匿名老板”，客服任务、资金和审计保留真实 sender；订单内批量送礼保持兼容。验收：`AT-GIFT2-001`–`003`；专项 `6 files / 36 tests`、最终全仓 `290 files / 1449 tests`、186 个路由双向合同、Prisma、完整迁移、API lint/typecheck 和空白门禁通过。证据：`evidence/P0/M22-US-02/README.md`。Discord 常驻入口仍属于 `M22-US-03`。
- [ ] `M22-US-03` Discord 送礼常驻入口与匿名低点击流程（自动化候选及真实 Guild 恢复探针已完成）：新增可配置送礼频道的唯一置顶 Embed、启动/改配置/删卡后的持久恢复；老板以私密“选陪玩 → 选礼物 → 公开或匿名确认”完成独立送礼，余额不足可转充值并原路刷新。选择 token 绑定 Guild、老板、陪玩、目录版本、价格与有效期且不使用进程内 Map；Bot 只调用统一 API，成功仅提示资金已预留。真实 SANDBOX Guild 探针发现并修复删卡后命中 Discord.js 旧缓存导致 `Unknown Message` 的恢复缺陷；现重复确保复用同一 ID、重复卡删除、API/client 重建后投影保留、删卡恢复为一个新置顶 ID，业务写入 0，临时频道和数据库已删除。RED 为缺少独立送礼模块 `1 suite / 0 tests` 及缺少 UAT Harness `1 file / 1 failed`；GREEN 为 Story `3 files / 9 tests`、关联 `13 files / 56 tests`，Bot 门禁 `72 files / 403 tests`、全仓 `293 files / 1458 tests`，API lint、188 条路由合同和 Prisma 校验通过。真实老板桌面/手机点击、余额不足续接、Bot Gateway 重启旧组件与具名签署仍缺，因此保持未勾选；证据：`evidence/P0/M22-US-03/README.md`。
- [ ] `M22-US-04` 客服辅助送礼指令与资金授权（自动化候选完成）：采用模式 B，客服从老板本人授权消息右键进入，API 以 `gift.assist`、可信同 Guild 客户绑定、十分钟/五次失败/单次消费 challenge、必填原因与客服本人六位 TOTP 原子预留老板 CAT；客户端不接受 `senderId`/`receiverId`，匿名只改变外部展示，内部保留老板付款人与客服执行者。新增迁移、四条统一 API、Discord 消息命令及三类 Sapphire handler；真实 PostgreSQL 覆盖错误 TOTP 零预留、正确 TOTP 原子创建与重放不重复。合同 RED 为 `1 file / 4 failed / 1 passed`；GREEN 为专项/受影响门禁 `6 files / 87 tests`、最终全仓 `297 files / 1475 tests`、192 条运行时路由、API/Bot lint、typecheck/build、Prisma、piece discovery、317 行验收矩阵与镜像/空白检查通过。真实 Guild 客服/老板桌面和手机、权限撤销、错误次数、并发重放与匿名多角色签署尚缺，因此保持未勾选；验收：`AT-GIFT2-005`；证据：`evidence/P0/M22-US-04/README.md`。
- [ ] `M22-US-05` 匿名播报、恢复与真实 Guild 外部 UAT 收口：依赖 `M22-US-06` 非 UI 自动门禁通过；保留 Desktop/Mobile、真实消息右键 Apps、ephemeral 可见性、频道权限、Gateway 重启和多角色公开/匿名展示的具名外部验收，不以自动化代签。
- [x] `M22-US-06` 礼物非 UI 自动化与隔离测试数据：新增安全守卫下的临时 PostgreSQL 自动迁移/销毁、确定性送礼 fixture、48 个 GTA 场景的可执行覆盖门禁，以及订单内、独立、客服辅助 B、审核、资金、并发、TOTP、匿名 payload 和 Outbox 恢复矩阵。专项最终 `18 files / 99 tests` 连续三轮通过；Bot 门禁 `74 files / 412 tests`，API/Bot lint、typecheck/build、192 条路由合同、Prisma 与全仓回归通过。修复固定时间 token 测试过期和 CAT 币种错误提示。验收：`AT-GFT-001`–`010`、`AT-GFT-012`–`015`、`AT-RES-003`、`AT-RES-008`–`011`、`AT-GIFT2-001`–`005`；证据：`evidence/P0/M22-US-06/README.md`。真实 Discord Desktop/Mobile、右键 Apps、ephemeral 可见性与多角色签署仍归 `M22-US-05`，本 Story 不代签。

## M23：全业务非 UI 自动化

> M23 覆盖礼物之外八个 P0 业务域的 77 个 BNUI 场景。九个 Story 必须按 `NUI-A0 → A8` 顺序实施；每个 Story 独立验证、留证和提交。A8 才建立最终 PR quick、main full、release 组合门禁。

- [x] `M23-US-01` NUI-A0 合同、覆盖盘点与共用 Harness：冻结 77 个显式 BNUI 场景及 `M23-US-01`～`09` 顺序依赖；新增共用 Unix-socket PostgreSQL、安全守卫、当前 migration、失败现场保留、确定性 fixture kernel、故障注入、零写入/append-only/资金/Guild/幂等/Outbox/审计/隐私断言和机器报告 schema。M22 礼物 fixture 已复用共用 Harness，停止失败不再静默吞掉。最终 Harness `1 file / 11 tests` 连续三轮、礼物 `18 files / 99 tests`、全仓 `305 files / 1530 tests`、192 路由、Prisma、ESLint、Prettier、typecheck、验收矩阵和残留检查全部通过。77 个业务场景仍诚实保持 PLANNED，依次由 A1～A7 实现。证据：`evidence/P0/M23-US-01/summary.md`。
- [x] `M23-US-02` NUI-A1 账户、入驻与钱包：修正被 M9 覆盖后仍残留的内部 USD、可配置代币和 L1 充值合同冲突；新增 9 个 BNUI 场景，以共享隔离 PostgreSQL 覆盖可信注册、陪玩申请、本人 Profile 与订单分页、CAT 余额和订单/礼物预留、USD receipt 充值去重、L1/step-up/非法输入零写入、渠道退款非负与 append-only、响应丢失幂等重放、并发扣减和 Provider/Webhook 退役。运行时 RED 为 `1 file / 9 tests` 中 `3 failed / 6 passed`，修正真实迁移 fixture 后 GREEN 为 `1 file / 9 tests`；累计覆盖为 `9 AUTOMATED / 68 PLANNED`。验收：`AT-ACC-001`–`004`、`AT-ONB-001;002;006`、`AT-PRF-002;004;006`、`AT-PL-002`、`AT-WAL-001`–`010`、`AT-WLT-011`–`013`、`AT-WHK-001`–`003`、`AT-CAT-004;005`；证据：`evidence/P0/M23-US-02/summary.md`。
- [x] `M23-US-03` NUI-A2 目录、套餐、标签与陪玩：新增 8 个共享隔离 PostgreSQL 场景，覆盖目录双价格版本创建/替代/归档与历史快照、非法价格/单位/标签零写入、同游戏有序套餐及服务端总价、跨游戏和并发发布、标签停用与历史引用、陪玩审批/拒绝/暂停/恢复、项目分成批量原子校验及终选收益快照。真实运行时 RED 发现陪玩业务事务先于审计提交，审计失败后仍保留 ACTIVE/version 2；运行时现以 staged transaction 将业务写、角色任务、事件与 audit_logs 同事务提交或回滚。A2 累计门禁 `4 files / 33 tests` 连续四轮、相关回归 `15 files / 79 tests`、礼物 `18 files / 99 tests`、全仓 `308 files / 1552 tests`、Prisma、192 路由、ESLint、Prettier、typecheck 均通过；累计覆盖 `17 AUTOMATED / 60 PLANNED`。验收：`AT-CAT-001;002`、`AT-ARC-001`、`AT-TAG-001;002;004`、`AT-MULTI-012;014`、`AT-ONB-005`、`AT-DOP-005`、`AT-COMP-001;002`；证据：`evidence/P0/M23-US-03/summary.md`。
- [x] `M23-US-04` NUI-A3 下单、候选池与服务状态机：按计划复用并参数化现有 API/PostgreSQL/Worker/Bot 测试，完成 18 个 BNUI-ORD/SEL/RDY/SVC 场景；覆盖多项目和套餐草稿、服务端报价、提交预留、幂等恢复、九项目边界、无时限候选池、Reaction 报名/撤回、跨订单活动槽竞态、部分/多人终选、fake Discord 语音房恢复、客户 readiness 拒绝、全员陪玩逐名就绪、完成捕获和超时仅转客服。新增可控真实 PostgreSQL 订单×礼物竞态，RED 证明 5200 CAT 可被两个事务同时预留；礼物创建现与订单共用 `user_currency_locks`，GREEN 仅一笔成功且 available=0。A3 累计门禁 `19 files / 155 tests` 连续三轮、礼物 `18 files / 99 tests`、全仓 `309 files / 1554 tests` 通过；累计覆盖 `35 AUTOMATED / 42 PLANNED`。验收映射与外部边界详见 `evidence/P0/M23-US-04/summary.md`。
- [x] `M23-US-05` NUI-A4 取消、退款、改派与客服接管：复用并精确映射现有 API/PostgreSQL/Worker 测试，完成 12 个 BNUI-CXL/ORD/SUP/APR 场景，覆盖取消预览与陈旧拒绝、原子释放/退款、超额退款竞态、审计失败全回滚、逐明细改派、客服并发认领/升级/暂停恢复/首响/值班摘要、只读 transcript、跨 Guild 安全链接以及审批快照和直达入口竞态。5 个历史 PostgreSQL 测试迁入共享隔离 Harness，完整 migration 与可靠 stop 均通过。A4 累计门禁 `32 files / 207 tests` 连续三轮、礼物 `18 files / 99 tests` 通过；累计覆盖 `47 AUTOMATED / 30 PLANNED`。精确验收映射与外部边界见 `evidence/P0/M23-US-05/summary.md`。
- [x] `M23-US-06` NUI-A5 消费、收益与返佣：复用并强化生产同源 API/PostgreSQL 测试，完成 9 个 BNUI-FIN/REF/HIS 场景，覆盖完成订单消费与逐人收益、L3+ 确认/支付及重放、退款追加消费/收益/返佣 Adjustment、两类返佣来源互斥、固定额与整数比例、首购一次性、长期订单来源幂等、用户/受益人/员工隐私矩阵和稳定时间线。新增真实 PostgreSQL 双来源并发，证明最终只有一个 ACTIVE 归因；退款事务补齐同一 refund 下三类冲正及审计失败零写入断言。3 个历史数据库测试迁入共享隔离 Harness。A5 累计门禁 `40 files / 242 tests` 连续三轮；累计覆盖 `56 AUTOMATED / 21 PLANNED`。精确验收映射与外部边界见 `evidence/P0/M23-US-06/summary.md`。
- [x] `M23-US-07` NUI-A6 周报与结算：完成 9 个 BNUI-RPT/SET 场景，覆盖周报原子生成/重放/修订、通知失败恢复、结算预览与唯一占用、延期 Adjustment、高额手工异人复核、逐条线下支付登记、替代链防攻击及导出隐私。修正结算非 CAT 错误合同，并在 TRANSFER_LIST 增加由 CAT 固定换算的线下 USD 辅助列而不建立第二账本；4 个历史数据库测试迁入共享 Harness。A6 累计门禁 `49 files / 318 tests` 连续三轮；累计覆盖 `65 AUTOMATED / 12 PLANNED`。证据：`evidence/P0/M23-US-07/summary.md`。
- [x] `M23-US-08` NUI-A7 治理、投影、评价与恢复：完成 12 个 BNUI-AUTH/RBAC/ROL/CFG/AUD/MET/LST/STATE/REC/REVW/BOT 场景，覆盖可信 Actor、累积 RBAC、Role 同步、配置预览/版本、审计脱敏、八项指标、签名游标、跨消费者投影、重启恢复、可选评价、五星明确公开及 Bot transport/route。机器报告 RED 发现自然语言 `secret/token` 被误报为敏感字段，现改为结构化敏感键和真实凭据值扫描并保留失败关闭。5 个历史数据库测试迁入共享 Harness，新增安全 migration include/exclude 支持升级场景。A7 累计门禁 `77 files / 493 tests` 连续三轮；77 个 BNUI 场景全部 AUTOMATED，外部子条件仍按分类保留。证据：`evidence/P0/M23-US-08/summary.md`。
- [ ] `M23-US-09` NUI-A8 组合门禁、CI 与证据收口：本地候选已建立 PR quick、main full、release 三层集中式门禁与 v2 脱敏失败报告；审计修复共享 Harness 停机异步事件、旧 M14 PostgreSQL 端口碰撞及 A8 合同未纳入 quick 的自守护缺口后，新定义 full 连续 10/10 零重试通过，每轮覆盖 quick 15/109、BNUI 77/497、Bot 74/412、全仓 310/1563；M22 礼物 18/99、Dashboard 135/135 追踪及隔离 Chromium 143/143 均通过。release 对缺失真实签署/配置失败关闭，仍有 87 项外部验收待完成，另有 2 项旧候选 Discord UAT 必须对最终候选重跑，因此保持 IN_PROGRESS。证据：`evidence/P0/M23-US-09/summary.md`。验收：`AT-REV-006;AT-BOT-REV-005`。
