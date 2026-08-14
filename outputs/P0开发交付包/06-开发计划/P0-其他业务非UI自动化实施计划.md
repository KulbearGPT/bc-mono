# P0 其他业务非 UI 自动化实施总计划

> 文档状态：实施规划，不表示运行时或自动门禁已经完成
> 参考基线：`M22-US-06 礼物非 UI 自动化与隔离测试数据实施计划`
> 适用范围：礼物之外的当前 P0 业务 API、PostgreSQL、Worker、Outbox、Bot 适配边界与安全不变量
> 排除范围：`M22-US-06` 已覆盖的订单内送礼、独立送礼、客服辅助送礼、礼物审核/捕获/释放和礼物公告
> 实施约束：`NUI-A0`～`NUI-A8` 已正式映射为 `M23-US-01`～`M23-US-09`；必须按依赖顺序实施、验证、留证并分别提交 Conventional Commit

## 1. 规划结论

礼物以外业务不应再各自搭建临时数据库和报告脚本。建议先交付一个全业务共用的隔离 PostgreSQL Harness，再按领域依次建立八个可独立运行的自动门禁：

1. 账户、入驻、Profile 与内部 CAT 钱包。
2. 服务目录、套餐、标签、陪玩准入与分成配置。
3. 下单、需求、报价、订单预留与幂等恢复。
4. 候选池、终选、逐名就绪、服务完成、取消、退款与改派。
5. 客服任务、自动化暂停/恢复、审批和只读订单上下文。
6. 消费、陪玩收益、返佣、Adjustment 与保密投影。
7. 周报、结算批次、外部转账登记和替代批次。
8. RBAC、Role 同步、配置、审计、指标、跨角色投影、评价与恢复。

八个业务域共 **77 个显式 BNUI 场景**：A1 账户/钱包 9 个、A2 目录/陪玩 8 个、A3 下单/选人/服务 18 个、A4 取消/客服 12 个、A5 财务/返佣 9 个、A6 周报/结算 9 个、A7 治理/恢复 12 个。A0 是共用基础设施门禁，不额外伪造业务场景编号；A8 是 77 个场景的组合发布门禁。

正式顺序 Story 为：

| 实施包 | Story | 内容 |
|---|---|---|
| NUI-A0 | M23-US-01 | 合同、覆盖盘点与共用 Harness |
| NUI-A1 | M23-US-02 | 账户、入驻与钱包 |
| NUI-A2 | M23-US-03 | 目录、套餐、标签与陪玩 |
| NUI-A3 | M23-US-04 | 下单、候选池与服务状态机 |
| NUI-A4 | M23-US-05 | 取消、退款、改派与客服接管 |
| NUI-A5 | M23-US-06 | 消费、收益与返佣 |
| NUI-A6 | M23-US-07 | 周报与结算 |
| NUI-A7 | M23-US-08 | 治理、投影、评价与恢复 |
| NUI-A8 | M23-US-09 | 组合门禁、CI 与证据收口 |

预计净新增工作量为 **36–52 人日**。该估算以复用现有 Vitest、PostgreSQL、API、Worker 和 Bot adapter 测试为前提，不包含修复自动化揭示的产品缺陷，也不包含真实 Discord/Dashboard UAT。

## 2. 目标与非目标

### 2.1 目标

1. 每次领域门禁使用自动创建、应用当前全部 migration、自动销毁的独立 PostgreSQL；不得依赖共享 Sandbox 的存量数据。
2. 数据库直写仅用于建立无法经公开业务入口自然生成的前置 fixture；所有业务动作必须调用统一 API、领域服务或真实 Worker handler。
3. 每个成功场景同时断言响应、领域状态、资金事实、Outbox/Job 和审计；每个失败场景同时断言响应与数据库零业务写入或完全不变。
4. 把 Actor Context、Guild、scope、`permissions_version`、MFA/step-up、幂等键和 expectedVersion 作为所有高风险矩阵的公共维度。
5. 资金测试统一断言 `ledgerBalanceMinor - reservedMinor = availableMinor`、只追加 WalletEntry/FundReservationEvent/Adjustment，以及捕获/释放不超过原预留。
6. 使用 fake Discord transport 验证 Bot/Worker payload、allowed mentions、失败重试和幂等恢复，但不让适配器持有最终业务规则。
7. 为每个自动化编号生成可映射到 `acceptance-cases.csv` 的机器可读报告，并汇入 `evidence/P0/acceptance-matrix.csv`。
8. 自动化完成后仍保留真实 Guild、真实浏览器、真实员工和 Desktop/Mobile 体验验收，不以合成探针代签。

### 2.2 非目标

- 不重复 `M22-US-06` 的任何礼物创建、审核、资金或公告用例；礼物来源的消费/返佣由 M22 报告提供覆盖事实。
- 不使用真实 Discord 用户 Token，不自动点击 Discord Desktop/Mobile，也不绕过 Discord 的真实权限模型声明 UAT 通过。
- 不使用 Playwright 证明 Dashboard 视觉、键盘、响应式、路由和 Dialog；这些继续由 Dashboard E2E 计划负责。
- 不连接 Stripe、PayPal、信用卡、银行或第三方转账 API；充值和结算只验证内部事实与人工登记边界。
- 不在共享或生产数据库执行 `TRUNCATE`、全库清理或不可恢复写入。
- 不为方便测试新增测试专用生产路由、复制权限判断、硬编码金额阈值或在 Bot/fixture 内重写业务规则。
- 不把 `PLANNED`、原型、fixture 或测试文件存在本身描述为运行时完成。

## 3. 当前基线与主要缺口

当前仓库已有大量可复用测试：

- M0–M10 已有账户、目录、订单、预留、钱包、审计、入驻、标签、分成、多陪玩和套餐的 API/DB/Bot 测试。
- M11–M15 已有候选池、Reaction 报名、客服班次、首响认领、工作台、退款、transcript、Bot 配置、钱包 Adjustment 和员工管理测试。
- M16–M20 已有 API 失败恢复、Bot transport/readiness、跨角色刷新、动作权限和模块质量门禁。
- M21 已有评价事务、Bot 评价中心、五星公告和真实 Guild UAT Harness。
- Dashboard 已有单独的 Playwright E2E 计划和实现，不应被本计划重复建设。

现状的主要缺口不是“完全没有测试”，而是：

1. 测试按历史 Story 分散，真实 PostgreSQL、内存 store、fake wallet 和 mock adapter 混用，缺少一次性证明全业务不变量的参数化门禁。
2. 临时 PostgreSQL 生命周期只提供 migration helper，尚无统一的生产库防误连守卫、固定时钟、Actor/Guild 工厂和失败保留策略。
3. 许多失败测试只断言 HTTP/异常，没有统一快照证明资金、任务、事件、Outbox 和审计零部分写入。
4. 跨 Guild、permissions version 变化、timeout-after-commit、并发版本冲突和 Worker 重放没有在每个高风险领域形成一致矩阵。
5. 验收编号与测试文件的映射分散，缺少按领域生成的稳定机器报告和 PR/main/release 分层命令。

本计划优先复用和参数化现有测试；只有现有测试无法证明真实事务或统一不变量时才新增场景，不按验收编号机械复制 300 余条测试。

## 4. 共用测试架构

```text
isolated PostgreSQL + current migrations
                │
                ▼
shared fixture kernel
Actor / Guild / clock / wallet / catalog / order / staff / fault injection
                │
                ▼
real Fastify routes + trusted Actor Context
                │
       ┌────────┴────────┐
       ▼                 ▼
PostgreSQL facts       real Worker handlers
       │                 │
       │                 ▼
       │          fake Discord transport
       └────────┬────────┘
                ▼
domain invariants + privacy scan + acceptance report
```

允许替换的外部边界只有固定时钟、测试 TOTP/step-up proof、Discord transport、文件存储和可控网络故障。API policy、PostgreSQL store、钱包锁、领域状态机、审计与 Worker handler 必须使用生产同源实现。

## 5. 隔离数据库与 Fixture Kernel

### 5.1 数据库生命周期

公共 Harness 为每个测试文件创建独立实例，例如 `blackcat_non_ui_<domain>_<pid>`：

1. 使用 `mkdtemp` 创建受控临时目录和 socket。
2. 预检 `initdb`、`pg_ctl`、`createdb`、`psql` 与可用端口。
3. 启动临时 PostgreSQL，调用现有 `applyCurrentMigrations` 应用全部 migration。
4. fixture 只 Seed 前置身份和必要历史事实。
5. 测试经 API/Worker 执行业务动作并读取只读快照。
6. 成功后关闭连接和实例并删除临时目录；失败时可由显式 `NON_UI_KEEP_FAILED_DB=1` 保留现场。

必须失败关闭：数据库名称、socket 路径、临时目录或 `NODE_ENV=test` 任一不符合规则时立即退出；helper 不读取普通 `DATABASE_URL` 作为默认连接，也不接受远程 host。

### 5.2 共用 Fixture

计划提供以下分层 builder：

- `createGuildFixture`：Guild A/B、频道、Role mapping、配置版本和可控 feature flags。
- `createActorFixture`：客户、陪玩、L1–L4、双 L4、降级员工、非员工及可信 Actor Context。
- `createAccountFixture`：Discord identity、内部账户、运营状态、风险和 Profile 历史。
- `createWalletFixture`：CAT 余额、有效/部分结算预留、充值 receipt、WalletEntry 和版本。
- `createCatalogFixture`：服务、套餐、标签、客户价/陪玩价快照、ACTIVE/RETIRED/ARCHIVED 版本。
- `createPlayerFixture`：准入状态、项目范围、受控标签、分成覆盖和活动订单槽。
- `createOrderFixture`：1/2/9 人及九项目订单、各生命周期状态、参与人、需求、预留和任务。
- `createReferralFixture`：两类互斥计划、来源资格、已结算首购和脱敏受益人。
- `createSettlementFixture`：周报、修订、普通/高额批次、转账项目和替代链。
- `createJobFixture`：Outbox、FAILED Job、过期任务、首次投递失败和重复事件。
- `snapshotBusinessFacts`：按领域读取对象、事件、资金、任务、审批、审计、Job 和 Outbox。

所有 UUID、Discord snowflake、publicId、receipt、幂等键和 reason code 必须带测试用例前缀。fixture 中的 TOTP secret、proof、receipt 私密内容和外部账号不得进入报告或失败日志。

### 5.3 共用断言

- `expectNoBusinessWrites(before, after)`：除允许的拒绝审计外，业务对象、事件、资金、任务和 Outbox 完全不变。
- `expectAppendOnlyDelta`：只允许新增指定类型，不允许覆盖或硬删除旧事实。
- `expectWalletInvariant`：账本、剩余预留、可用余额、版本和币种一致。
- `expectIdempotentReplay`：同一幂等键返回同一业务对象且副作用计数不增加。
- `expectGuildIsolation`：跨 Guild 列表为空，详情/写入不可枚举且零写入。
- `expectAuditAtomicity`：成功业务事实与成功审计同事务；拒绝/失败保留最小尝试审计且不泄密。
- `expectOutboxConvergence`：失败、重启和重放后只产生一个有效外部副作用。
- `expectPrivacyAllowlist`：响应、日志、审计、报告和 Discord payload 只含受众允许字段。

## 6. 领域自动化矩阵

优先级：`BLOCKER` 失败即禁止候选发布；`HIGH` 必须在 main/full gate 通过。

### 6.1 账户、入驻、Profile 与内部 CAT 钱包

| 自动化编号 | 优先级 | 场景 | 核心断言 |
|---|---|---|---|
| BNUI-ACC-001 | BLOCKER | Discord 玩家注册与重复注册 | 可信身份在 Guild 内唯一；幂等返回同一账户；不接受客户端自报对象归属 |
| BNUI-ACC-002 | BLOCKER | 玩家申请陪玩与身份合并 | 玩家身份保留；陪玩申请只新增；跨 Guild/伪造身份零写入 |
| BNUI-ACC-003 | HIGH | 当前用户 Profile、订单/消费分页 | 只读本人事实；模块级失败互不污染；返佣与内部备注不越权泄露 |
| BNUI-WLT-001 | BLOCKER | 余额、订单预留和可用余额快照 | 同一锁边界计算；客户端不能写入或自行决定 available |
| BNUI-WLT-002 | BLOCKER | USD cents 充值与 receipt 去重 | 固定换算为 CAT subunit；凭证私有；相同渠道交易事实只入账一次 |
| BNUI-WLT-003 | BLOCKER | 充值权限、近期验证与金额边界 | 低权限、过期 step-up、非法币种/金额全部零写入 |
| BNUI-WLT-004 | BLOCKER | 渠道退款登记与余额不足 | 只追加 debit/Adjustment；不能产生负账本；原记录和预留不改写 |
| BNUI-WLT-005 | BLOCKER | 并发充值/扣减与 timeout-after-commit | 钱包行锁和幂等恢复保证一次写入，余额公式始终成立 |
| BNUI-WLT-006 | HIGH | Provider/Webhook 退役扫描 | 旧回调、密钥和运行时入口不能创建任何资金事实 |

主要映射：`AT-ACC-*`、`AT-ONB-001`–`006`、`AT-PRF-001;002;004;005;006;008;009;010`、`AT-PL-002`、`AT-WAL-*`、`AT-WLT-011`–`013`、`AT-TKN-001`–`007`、`AT-WHK-*`、`AT-CAT-005`、`AT-REC-001`–`002`。

### 6.2 服务目录、套餐、标签、陪玩准入与分成

| 自动化编号 | 优先级 | 场景 | 核心断言 |
|---|---|---|---|
| BNUI-CAT-001 | BLOCKER | 服务版本创建、发布、替代与归档 | 双价格、币种、标签和状态完整；历史版本/订单快照不可覆盖 |
| BNUI-CAT-002 | BLOCKER | 缺价、非法单位、跨 Guild 标签 | 整笔拒绝，目录版本、审计和 Outbox 零部分写入 |
| BNUI-PKG-001 | BLOCKER | 同游戏有序席位套餐发布 | API 派生总价；同 code 仅一个 ACTIVE；旧版本保持不可变 |
| BNUI-PKG-002 | BLOCKER | 跨游戏席位与并发发布 | 非法套餐零写入；并发仅一个发布成功 |
| BNUI-TAG-001 | HIGH | 标签创建、停用和历史回显 | code/ID 稳定；停用只影响新选择，不回写历史 |
| BNUI-PLY-001 | BLOCKER | 陪玩申请批准/拒绝 | expectedVersion、范围、标签、审计和通知任务原子一致 |
| BNUI-PLY-002 | BLOCKER | 暂停/恢复陪玩接单资格 | 新候选池立即排除/恢复；既有订单和历史事实不改写 |
| BNUI-PLY-003 | HIGH | 项目分成和个人覆盖 | 固定额/比例校验正确；终选固化收益快照；变更不追改旧订单 |

主要映射：`AT-CAT-001`–`004`、`AT-TAG-001;002;004`、`AT-COMP-*`、`AT-ARC-001`、`AT-MULTI-008`–`009`、`AT-MULTI-012`–`014`、`AT-ONB-005`、`AT-DOP-005`。

### 6.3 下单、结构化需求、报价与订单预留

| 自动化编号 | 优先级 | 场景 | 核心断言 |
|---|---|---|---|
| BNUI-ORD-001 | BLOCKER | 单项目与多项目即时草稿 | 不接受预约字段；需求顺序、备注、版本和服务端报价正确 |
| BNUI-ORD-002 | BLOCKER | 套餐展开、席位定制与新增游戏 | 套餐原子展开；只能同游戏换项；总价始终由 API 派生 |
| BNUI-ORD-003 | BLOCKER | 提交订单创建预留 | 锁定最新目录和钱包；一份订单对应一份有效原预留 |
| BNUI-ORD-004 | BLOCKER | 余额不足和跨业务并发占用 | 草稿保持可恢复；订单/预留/派单 Outbox 零写入；available 不为负 |
| BNUI-ORD-005 | BLOCKER | 重复提交与响应丢失 | 原幂等键恢复同一订单/预留；不同重试不能形成重复活动订单 |
| BNUI-ORD-006 | BLOCKER | 目录、需求或钱包版本在确认期间变化 | 最终事务重验；陈旧报价失败关闭并要求重新确认 |
| BNUI-ORD-007 | HIGH | 私密频道/面板创建 adapter 失败 | 未满足可提交前置时不产生可提交订单；恢复任务不直接篡改订单 |
| BNUI-ORD-008 | HIGH | 九项目上限与分页恢复 | 九项目完整保序；超合同数量失败关闭，不截断、不拆分 |

主要映射：`AT-CAT-002`–`003`、`AT-CHN-*`、`AT-ORD-*`、`AT-PL-001`、`AT-RES-001`–`004`、`AT-MULTI-006`、`AT-MULTI-008`–`009`、`AT-MULTI-011`–`013`、`AT-PRJ-001`–`002`、`AT-REV-004`。

### 6.4 候选池、终选、就绪、完成、取消、退款与改派

| 自动化编号 | 优先级 | 场景 | 核心断言 |
|---|---|---|---|
| BNUI-SEL-001 | BLOCKER | 客户开始/终止无时限招募 | 不接受倒计时；停止后保持原预留；不会自动续轮 |
| BNUI-SEL-002 | BLOCKER | Reaction/API 报名、撤回和重放 | 只依赖有效准入/Guild/需求标签；同人同需求单一有效事实 |
| BNUI-SEL-003 | BLOCKER | 多订单报名与活动槽竞争 | 忙碌陪玩可报名；终选锁行时才原子校验活动槽 |
| BNUI-SEL-004 | BLOCKER | 零报名、部分入选与多人终选 | 客户决定下一步；所选 participant 原子落库，不产生系统自动决定者 |
| BNUI-SEL-005 | HIGH | 选秀/正式语音房 Worker 恢复 | fake transport 下权限计划、移动顺序、撤权、删房和重放最终收敛 |
| BNUI-RDY-001 | BLOCKER | 客户尝试 readiness | 拒绝且零写入；仅当前有效陪玩能提交本人状态 |
| BNUI-RDY-002 | BLOCKER | 1/2/9 人逐名就绪 | 部分就绪保持 ACCEPTED；最后一名才原子进入 IN_SERVICE |
| BNUI-RDY-003 | BLOCKER | 旧兼容开始入口与并发就绪 | 不能绕过未就绪陪玩；仅一次服务开始事件/投影 Outbox |
| BNUI-SVC-001 | BLOCKER | 完成确认与重复事件 | 捕获原订单预留；逐人消费/收益/返佣单次生成 |
| BNUI-SVC-002 | BLOCKER | 超时、爽约与中断 | 只创建相应客服任务/风险事实；不自动捕获、退款、扣罚或结算 |
| BNUI-CXL-001 | BLOCKER | 草稿、待派单、已接单、服务中取消预览 | 返回最新可执行影响；预览 token 绑定订单/Guild/版本且不可跨对象复用 |
| BNUI-CXL-002 | BLOCKER | 自动取消、人工结案与部分退款 | 释放/捕获/退款/收益原子一致；终态不倒退；争议保持预留 |
| BNUI-CXL-003 | BLOCKER | 事务失败、重复取消与超额结案 | 不提前标终态，不产生部分资金写入，幂等重放结果一致 |
| BNUI-ORD-009 | BLOCKER | 单席位改派、备注更正和已捕获保护 | 只改变目标 participant/备注；其他席位、总价和预留不变；终态/已捕获拒绝 |

主要映射：`AT-DSP-*`、`AT-WRK-*`、`AT-MAT-*`、`AT-SEL-*`、`AT-RDY-*`、`AT-STATE-001`、`AT-SVC-*`、`AT-CAN-*`、`AT-CXL-*`、`AT-RES-004`–`007`、`AT-MULTI-001`–`004`、`AT-MULTI-007`、`AT-MULTI-010`、`AT-MULTI-015`、`AT-TRN-003`–`004`。

### 6.5 客服任务、自动化接管、审批与订单上下文

| 自动化编号 | 优先级 | 场景 | 核心断言 |
|---|---|---|---|
| BNUI-SUP-001 | BLOCKER | 两名客服并发认领 | 条件更新保证唯一 claimedBy；失败者不覆盖版本 |
| BNUI-SUP-002 | BLOCKER | L1 备注/核对/升级与 L2+ 结案 | 累积权限、本人/团队 scope 和 Guild 均由 API 重验 |
| BNUI-SUP-003 | BLOCKER | 暂停、恢复、接管和转派 | 暂停时 Worker 安全跳过；原预留保持；恢复按最新事实执行明确动作 |
| BNUI-SUP-004 | BLOCKER | 自动超时与首响自动认领竞态 | 只产生一个任务/认领结果；人工抢先处理后自动任务不反向覆盖 |
| BNUI-SUP-005 | HIGH | 客服打卡和 30 天摘要 | 班次只追加；统计口径可复算；不成为业务授权事实 |
| BNUI-SUP-006 | BLOCKER | 只读 transcript 与安全 Discord 深链 | 同 Guild 最小字段；无发送/编辑/删除能力；不泄露其他频道 |
| BNUI-APR-001 | BLOCKER | 订单退款/结案审批读取和决定 | 只决定服务端领域快照；版本/hash/权限/step-up 陈旧时零写入 |
| BNUI-APR-002 | BLOCKER | 直接业务入口与审批竞态 | 最终只有一种领域结果；旧审批明确取消/过期，不重复资金动作 |

主要映射：`AT-SUP-001`–`006`、`AT-SUP-010`–`013`、`AT-SUX-002`–`004`、`AT-DOP-001`–`003`、`AT-MULTI-015`、`AT-RBAC-*` 中订单/退款权限、`AT-AUD-001`、`AT-AUD-004`。

### 6.6 消费、陪玩收益、返佣、Adjustment 与保密

| 自动化编号 | 优先级 | 场景 | 核心断言 |
|---|---|---|---|
| BNUI-FIN-001 | BLOCKER | 订单完成生成消费与逐人收益 | 订单/参与人快照、金额、来源和唯一约束正确 |
| BNUI-FIN-002 | BLOCKER | 收益确认、支付登记和重放 | 合法状态迁移；L3+；不重复支付，不覆盖原始收益 |
| BNUI-FIN-003 | BLOCKER | 部分退款/纠错 | 仅追加收益与消费 Adjustment；原记录不可改、不可删 |
| BNUI-REF-001 | BLOCKER | 两类返佣绑定与互斥来源 | 一名被推荐用户只有一个有效来源；非法/跨 Guild 绑定零写入 |
| BNUI-REF-002 | BLOCKER | 固定额首购与净消费比例 | 整数算法和比例快照正确；首购只结算一次 |
| BNUI-REF-003 | BLOCKER | PLAYER_LIFETIME 订单来源结算 | 只处理符合配置的可信订单消费；重放不重复返佣 |
| BNUI-REF-004 | BLOCKER | 退款冲正返佣 | 追加非负 CommissionAdjustment；主 Commission 不覆盖 |
| BNUI-REF-005 | BLOCKER | 用户/受益人/员工四级隐私矩阵 | 被推荐用户全链路零泄露；受益人只看本人且来源脱敏 |
| BNUI-HIS-001 | HIGH | 消费/返佣分页与时间线 | 稳定 cursor、角色脱敏、订单来源不重复，金额方向可追溯 |

主要映射：`AT-HIS-*`、`AT-EAR-*`、`AT-REF-*`、`AT-RFP-*`、`AT-TML-*`、`AT-COMP-002`、`AT-MULTI-004`。礼物来源返佣和礼物消费不在本套件重跑，由 `M22-US-06` 汇入最终组合门禁。

### 6.7 周报、结算批次与外部转账登记

| 自动化编号 | 优先级 | 场景 | 核心断言 |
|---|---|---|---|
| BNUI-RPT-001 | BLOCKER | 周期周报生成和重放 | 可信订单/收益/Adjustment 汇总；同周期重放返回同一结果 |
| BNUI-RPT-002 | BLOCKER | 本人周报、管理员导出和修订 | 陪玩只看本人；修订只追加；CSV 与当前修订一致 |
| BNUI-RPT-003 | HIGH | 周报通知首次失败 | 报告事实不回滚；只重试通知，不重复生成报告 |
| BNUI-SET-001 | BLOCKER | 空周期预览和普通批次 | 预览不落库；批次来源锁定；同一收益不进入两个有效批次 |
| BNUI-SET-002 | BLOCKER | 自动/手动生成幂等与调整分期 | 重放同批次；cutoff 后 Adjustment 进入后续周期 |
| BNUI-SET-003 | BLOCKER | 高额批次异人复核 | 创建者即使 L4 也不可自批；不同合格人员方可批准 |
| BNUI-SET-004 | BLOCKER | 转账清单与逐条成功/失败登记 | 不连接外部通道；未选择保持未登记；重复提交不改结果 |
| BNUI-SET-005 | BLOCKER | 作废、替代和跨 Guild/币种/循环攻击 | 替代链同 Guild/币种且无循环；非法请求零写入 |
| BNUI-SET-006 | HIGH | 导出隐私和总额 | 不含支付密码/完整账号；CAT 应付与人工 USD 辅助列不形成第二账本 |

主要映射：`AT-SET-*`、`AT-RPT-001;002;006;007;008`、`AT-EAR-*`、`AT-AUD-001`、`AT-AUD-005`。

### 6.8 RBAC、Role、配置、审计、指标、投影、评价与恢复

| 自动化编号 | 优先级 | 场景 | 核心断言 |
|---|---|---|---|
| BNUI-AUTH-001 | BLOCKER | Bot/Dashboard 伪造 Actor、role、level、owner | API 以可信上下文解析；跨用户/Guild 零数据、零业务写入 |
| BNUI-RBAC-001 | BLOCKER | L1–L4 累积权限与金额边界 | 高级别继承低级能力；scope/step-up/MFA/原因仍独立生效 |
| BNUI-ROL-001 | BLOCKER | Role 同步、提权、降级和移除 | Discord Role 只作信号；首次高权限按合同复核；降级撤销旧 session |
| BNUI-CFG-001 | BLOCKER | Bot 配置 validate/preview/apply | 服务端验证 Channel/Role、版本和权限；陈旧 token/版本不覆盖 |
| BNUI-AUD-001 | BLOCKER | 全量生产写路由审计覆盖 | 成功原子审计，失败/拒绝可归因，所有记录只追加 |
| BNUI-MET-001 | HIGH | 八项指标重算 | 时区、状态、剩余预留、净消费、派单轮次和异常唯一口径一致 |
| BNUI-LST-001 | BLOCKER | 排序白名单、HMAC cursor 和 scope 绑定 | 稳定 keyset；篡改、跨筛选、跨 Guild 游标失败关闭 |
| BNUI-STATE-001 | BLOCKER | 订单/任务/配置/角色跨消费者投影 | 业务事实与 Outbox 原子；Worker 重试后 Bot/Dashboard 消费者最终收敛 |
| BNUI-REC-001 | BLOCKER | API/Worker/Bot 重启、FAILED Job 和消息丢失 | 只创建恢复任务或重放外部投影，不直接重写领域事实 |
| BNUI-REVW-001 | BLOCKER | 可选目标评价事务 | 仅订单所有者评价实际订单/陪玩/客服；失败不影响订单和资金 |
| BNUI-REVW-002 | BLOCKER | 明确同意的五星公告 | 只有安全快照进入 Outbox；取消/低星/未同意零公告；重试不重复 |
| BNUI-BOT-001 | HIGH | 生产 renderer→route→API 可达性 | 使用真实 renderer JSON；Actor/Guild/interaction ID 完整；错误准确且不泄密 |

主要映射：`AT-AUTH-*`、`AT-RBAC-*`、`AT-ROL-*`、`AT-CFG-*`、`AT-AUD-*`、`AT-MET-*`、`AT-LST-001`–`003`、`AT-LST-008`、`AT-REV-003`–`006`、`AT-BOT-REV-*`、`AT-EXP-004`–`006`、`AT-STATE-002`–`005`、`AT-ACT-001`、`AT-ACT-003`–`004`、`AT-REVIEW-*`、`AT-REC-003`–`004`。

## 7. 与验收合同的边界

以下验收只自动证明其 API/DB/Worker/adapter 子条件，不能由本计划改写为外部 UAT 已通过：

- `E2E`、`UAT`、`BOT_DISCORD_*` 中的真实频道权限、真实消息可见性、Desktop/Mobile、Reaction、右键菜单、ephemeral 和视觉布局。
- Dashboard 的真实浏览器导航、表单、可访问性、响应式、请求竞态和下载体验。
- `AT-REC-005` 的真实备份恢复演练。
- 真实员工 L1–L4、不同 L4 复核人、真实客户/陪玩/客服多角色具名签署。

自动报告必须把每个验收项标记为：`AUTOMATED_FULL`、`AUTOMATED_PARTIAL_EXTERNAL_REMAINS`、`EXTERNAL_ONLY` 或 `OUT_OF_SCOPE_GIFT`，禁止仅以“测试存在”推导验收完成。

## 8. 计划修改文件

### 8.1 共用基础设施

- `tests/support/isolated-postgres.ts`
- `tests/support/non-ui-fixtures/actors.ts`
- `tests/support/non-ui-fixtures/business.ts`
- `tests/support/non-ui-fixtures/faults.ts`
- `tests/support/non-ui-assertions.ts`
- `tests/support/non-ui-acceptance-report.ts`
- `scripts/non-ui/verify-environment.mjs`
- `scripts/non-ui/run-domain-gate.mjs`

### 8.2 领域测试

- `tests/non-ui/account-wallet.spec.ts`
- `tests/non-ui/catalog-player.spec.ts`
- `tests/non-ui/order-submission.spec.ts`
- `tests/non-ui/order-lifecycle.spec.ts`
- `tests/non-ui/support-approval.spec.ts`
- `tests/non-ui/earnings-referrals.spec.ts`
- `tests/non-ui/reports-settlements.spec.ts`
- `tests/non-ui/governance-projections.spec.ts`
- `tests/non-ui/non-ui-automation-gate.spec.ts`

### 8.3 报告与证据

- `evidence/P0/non-ui-automation/<domain>/summary.md`
- `evidence/P0/non-ui-automation/<domain>/test-report.json`
- `evidence/P0/non-ui-automation/coverage.json`
- `evidence/P0/acceptance-matrix.csv`
- 对应实现 Story 的 `outputs/Codex-P0开发TODO.md` 与 `docs/` 镜像

生产代码只有在测试揭示外部边界不可注入时才允许最小 testability 调整。任何业务修复都必须归属于当期唯一 Story，并在同一 Story 的 RED/GREEN 和证据中说明；不得顺手跨域重构。

## 9. 顺序实施包

### NUI-A0：合同、覆盖盘点与共用 Harness，4–6 人日

- 冻结本计划的纳入/排除验收矩阵，建立当前分散测试的 GREEN 基线。
- 先写缺失 Harness 和断言的 RED contract。
- 建立临时 PostgreSQL、安全守卫、fixture kernel、统一快照、故障注入和报告 schema。
- 与 `M22-US-06` 共用通用 Harness；礼物专用 fixture 继续留在 M22，不反向耦合其他领域。

门禁：Harness 专项连续三次启动/迁移/销毁，无残留进程或目录；故意传入普通/远程数据库必须失败关闭。

### NUI-A1：账户、入驻与钱包，4–6 人日

- 完成 BNUI-ACC/WLT 矩阵。
- 复用现有 M7/M9 钱包与入驻测试，补真实 PostgreSQL 并发、审计原子性和零写入快照。

### NUI-A2：目录、套餐、标签与陪玩，4–5 人日

- 完成 BNUI-CAT/PKG/TAG/PLY 矩阵。
- 重点覆盖不可变版本、并发发布、停用历史和陪玩资格即时影响。

### NUI-A3：下单、候选池与服务状态机，7–10 人日

- 先完成订单草稿/报价/预留，再完成候选池/终选/readiness/服务完成。
- 每种并发测试使用独立 Actor Context 和真实 PostgreSQL 锁，不用串行 mock 伪造竞态。

### NUI-A4：取消、退款、改派与客服接管，5–7 人日

- 完成预览 token、部分结案、事务失败、自动化暂停/恢复、任务认领、审批竞态和 transcript 隐私。
- 资金结案必须同时断言订单、预留事件、WalletEntry、Consumption、Earning/Adjustment、Outbox 和审计。

### NUI-A5：消费、收益与返佣，4–6 人日

- 完成订单来源消费/收益/返佣及冲正、分页和保密矩阵。
- 组合门禁只读取 M22 报告确认礼物来源覆盖，不在本包复制礼物动作。

### NUI-A6：周报与结算，4–5 人日

- 完成报告重放/修订、批次唯一、异人复核、付款登记、导出隐私和替代链。
- 使用两名独立 L4 fixture，明确证明累积权限不能绕过创建者自批禁令。

### NUI-A7：治理、投影、评价与恢复，4–6 人日

- 完成 RBAC、Role、配置、审计、指标、游标、投影收敛、评价和 Bot adapter 矩阵。
- fake transport 覆盖首次失败、timeout、消息丢失、重启和重复事件；资金/领域副作用不得重放。

### NUI-A8：组合门禁、CI 与证据收口，3–4 人日

- 建立 quick/full/release 三层脚本和机器报告。
- 各领域专项连续三次，完整 full gate 连续十次，无未解释 flaky failure。
- 合并 M22 礼物自动报告、Dashboard E2E 报告和外部 UAT 状态，但不篡改它们各自的完成结论。
- 更新验收矩阵和 TODO；每个前置实现包仍保持独立 Story、独立证据、独立 commit。

依赖顺序：`A0 → A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8`。按仓库规则同一时间只实施一个已解锁 Story，不并行修改共用 Harness。

## 10. 计划命令与 CI 分层

实施后以真实 `package.json` scripts 为准，建议增加：

```text
npm run test:non-ui:account-wallet
npm run test:non-ui:catalog-player
npm run test:non-ui:orders
npm run test:non-ui:support-finance
npm run test:non-ui:settlements-governance
npm run test:non-ui:full
npm run test:non-ui:stability
```

在 scripts 尚未建立前，目标测试使用仓库当前 Vitest：

```text
npm exec -- vitest run tests/non-ui/account-wallet.spec.ts
npm exec -- vitest run tests/non-ui/order-submission.spec.ts tests/non-ui/order-lifecycle.spec.ts
npm exec -- vitest run tests/non-ui/non-ui-automation-gate.spec.ts
npm run quality:routes
npm run quality:bot
npm test
node scripts/build-p0-acceptance-matrix.mjs
git diff --check
```

CI 分层：

- PR quick：Harness 守卫、账户/钱包、订单提交、全员 readiness、取消原子性、返佣隐私、高额结算自批拒绝、审计抽样。
- main full：全部 BNUI BLOCKER/HIGH、空库 migration、Worker/fake transport、跨 Guild 和 fault injection。
- release：main full + `M22-US-06` + Dashboard E2E + 外部验收状态校验；任何外部必需证据缺失继续 fail-closed。

失败 artifact 至少包含测试编号、commit SHA、run ID、临时数据库名、Guild/Actor fixture ID、request_id、脱敏日志、前后事实快照和验收映射；不得包含 TOTP、receipt 正文、完整外部账户、内部幂等密钥或返佣隐私字段。

## 11. 完成定义

全业务非 UI 自动化只有同时满足以下条件才可声明完成：

1. `NUI-A0`～`A8` 已转为正式、顺序依赖的独立 Story，并逐个遵守验证先行和独立 commit。
2. 所有列出的 BNUI 用例均为可执行测试，不以 `skip`、`todo` 或手工说明占位。
3. 每个失败场景都有零业务写入/完全不变断言；每个成功场景都有领域、资金、Outbox/Job 和审计后置断言。
4. 所有资金路径满足 CAT 整数、钱包公式、原预留生命周期、只追加和不形成第二账本。
5. 所有高风险路径覆盖可信 Actor、Guild、scope、累积权限、permissions version、step-up/MFA、幂等和 expectedVersion。
6. 临时 PostgreSQL 从当前 migration 可重复启动和销毁，且无法误连共享/远程数据库。
7. 各领域专项连续三次、full gate 连续十次通过；不得用无条件 retry 隐藏 flaky failure。
8. `quality:routes`、`quality:bot`、相关回归、全仓测试、验收矩阵重建和 `git diff --check` 全部通过。
9. 每个 Story 的证据记录实际修改文件、命令、测试数量、失败/通过输出和剩余风险，TODO 只按真实结果更新。
10. 报告明确区分自动化全覆盖、部分自动且外部剩余、外部专属和礼物域，不替真实 UAT 签署。

## 12. 保留人工 UAT

即使本计划全部通过，以下仍需真实人员和真实客户端验证：

1. 老板 Desktop/Mobile 的注册、下单、候选池、取消、完单、Profile 和评价体验。
2. 陪玩报名/撤回 Reaction、选秀语音、正式服务房、逐名就绪和本人周报。
3. 客服真实打卡、首响认领、订单接管、transcript、退款、Bot 配置和异常恢复。
4. L1–L4 与不同 L4 复核人的真实权限、MFA、Role 降级和会话撤销。
5. Dashboard 的浏览器布局、键盘、响应式、下载、请求竞态和真实员工签署。
6. Discord 频道 overwrite、置顶、allowed mentions、消息删除、Gateway 重启和 Desktop/Mobile 扫读性。
7. 真实测试环境备份恢复演练与发布/回滚操作。

这些外部项继续沿用各 Story 的 human UAT runbook 和 `evidence/P0/external/` 证据，不因非 UI 门禁通过而自动勾选。

## 13. 实施前必须确认的事项

1. 先决定 `NUI-A0` 是否作为礼物与其他业务共同前置；若 `M22-US-06` 先实施，应将通用 PostgreSQL 生命周期抽到共享 helper，而不是留在礼物专用文件后再复制。
2. 为每个规划包建立正式 Story 时，必须从当前 `acceptance-cases.csv` 选择精确验收 ID，不能仅引用整个前缀后直接宣称全部覆盖。
3. 若主规格、Backlog、OpenAPI、Prisma、状态约束或验收对 CAT/USD、权限阈值、状态迁移、退款或结算语义存在冲突，应停止对应包，先修正并同步合同。
4. `M23-US-01` 可把 M22 礼物数据库生命周期改为共用 Harness，但不得在该 Story 混入礼物业务规则、验收状态或其他业务域实现。
