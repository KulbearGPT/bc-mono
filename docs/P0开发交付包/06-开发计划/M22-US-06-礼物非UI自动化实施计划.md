# M22-US-06 礼物非 UI 自动化与隔离测试数据实施计划

## 1. Story 定义

- Story：`M22-US-06`
- 名称：礼物非 UI 自动化与隔离测试数据
- 状态：`DONE`
- 依赖：`M22-US-02`；`M22-US-03/04` 的自动化候选运行时属于本 Story 的被测对象，其真人 UAT 不阻塞自动化开工
- 发布依赖：`M22-US-05` 必须在本 Story 自动门禁通过后才能完成外部 UAT 收口
- 估算：5–7 人日
- 主要验收：`AT-GFT-001`–`010`、`AT-GFT-012`–`015`、`AT-RES-003`、`AT-RES-008`–`011`、`AT-GIFT2-001`–`005`

本 Story 将订单内送礼、独立送礼、匿名模式、客服辅助送礼 B、礼物审核、资金捕获/释放和 Outbox 公告恢复纳入同一套可重复自动化。数据库直写只用于构造前置 fixture；所有礼物创建、预留、领取、核对、批准、拒绝、撤回、过期、捕获和重试仍调用统一业务 API 或 Worker，不以直接改表代替业务动作。

## 2. 目标与非目标

### 2.1 目标

1. 每次测试启动独立 PostgreSQL，应用当前全部 migration，测试结束销毁整个临时实例。
2. 提供确定性的客户、陪玩、订单、礼物目录、钱包、员工权限、TOTP、频道和时钟 fixture builder。
3. 自动覆盖三条 Discord 礼物入口背后的统一 API、资金事务、授权、匿名事实和恢复语义。
4. 对每个失败路径同时断言响应和数据库“零业务写入”，不能只断言 HTTP 状态码。
5. 对每个成功路径断言 GiftRequest、FundReservation、StaffTask、Consumption、Outbox、AuditLog 和钱包前后值。
6. 使用 fake Discord transport 验证公开/匿名 payload、allowed mentions、发送失败和幂等重试。
7. 生成可映射到验收编号的机器可读报告，并纳入 CI 和 `evidence/P0/acceptance-matrix.csv`。

### 2.2 非目标

- 不使用用户 Token、自助账号或自动点击真实 Discord 客户端。
- 不声称自动化可以证明 Desktop/Mobile 布局、右键 Apps 菜单、Modal 键盘体验或真实 ephemeral 可见性。
- 不在 Bot 复制余额、权限、陪玩资格、价格、状态迁移或资金规则。
- 不连接生产数据库，不在共享 Sandbox 数据库执行 `TRUNCATE`、批量删除或不可恢复清理。
- 不为测试修改礼物、订单或审批业务合同；发现合同冲突时停止 Story，先同步规格和验收。

## 3. 当前基线与缺口

当前已有可复用基础：

- `tests/m22-us-02-standalone-gift-postgres.spec.ts` 已证明独立礼物并发超支最多成功一笔。
- `tests/m22-us-04-staff-gift-assist-postgres.spec.ts` 已覆盖错误 TOTP、正确 TOTP、老板付款人、客服执行者和 challenge 重放。
- `tests/m6-us-06-api.spec.ts` 已覆盖订单内多人礼物的原子批量、余额不足、刷新和目录变化。
- `tests/m3-us-02-db.spec.ts`、`tests/m3-us-03-worker.spec.ts` 和 `tests/m3-us-06-api.spec.ts` 已分别覆盖审核/释放、公告重试和撤回/过期。
- Bot 层已有独立送礼、订单礼物和客服辅助的 handler/component 测试。

仍缺少一套统一、参数化、真实 PostgreSQL 的全链路矩阵。现有测试分散在多个 Story，部分使用内存 store 或 fake wallet，尚不能一次证明三条入口遵守相同资金、隐私、幂等和审计不变量；也没有统一的 fixture 安全门禁和验收报告。

## 4. 测试架构

```text
isolated PostgreSQL + current migrations
                │
                ▼
deterministic fixture builder
  customer / player / order / catalog / wallet / staff / TOTP / clock
                │
                ▼
real Fastify routes + trusted Actor Context
                │
       ┌────────┴────────┐
       ▼                 ▼
PostgreSQL assertions   Bot adapter interaction stubs
       │                 │
       └────────┬────────┘
                ▼
real Worker handlers + fake Discord transport
                │
                ▼
funds / privacy / idempotency / audit report
```

测试必须使用生产同源的 migration、PostgreSQL store、API route 和 Worker handler。允许替换的只有外部边界：Discord transport、固定时钟和测试 TOTP secret。

## 5. 隔离数据库与 Fixture 设计

### 5.1 数据库生命周期

每个测试文件创建独立临时 PostgreSQL 实例和数据库，例如 `blackcat_m22_gift_<process_id>`：

1. `mkdtemp` 创建临时 socket 和 data 目录。
2. `initdb`、`pg_ctl`、`createdb` 启动实例。
3. `applyCurrentMigrations` 应用当前全部 migration。
4. fixture builder 只插入前置事实。
5. 测试通过 API/Worker 执行业务动作并读取断言。
6. `afterAll` 关闭连接、停止实例并删除临时目录。

增加失败关闭守卫：数据库名称、socket 路径或环境标记不符合测试规则时立即退出；任何 helper 不接受生产 `DATABASE_URL` 作为默认值。

### 5.2 Fixture Builder

计划新增 `tests/support/gift-automation-fixture.ts`，提供：

- `createGuild`：测试 Guild、入口频道、公告频道和配置版本。
- `createCustomer`：Discord 绑定、客户状态、钱包和可配置 CAT 余额。
- `createPlayer`：Guild、Discord 绑定、PlayerProfile 审核/可用状态。
- `createGiftCatalogVersion`：价格、状态、版本、公开模板和匿名模板。
- `createOrderWithParticipants`：订单状态、完成时间、所有者和 1/2/9/26 名参与人。
- `createStaff`：L1–L4、`gift.assist`、`permissions_version`、MFA 登记和固定测试 TOTP。
- `createExistingReservation`：构造订单/礼物并发占用的前置资金事实。
- `snapshotGiftFacts`：统一读取钱包、礼物、预留、预留事件、任务、审批、消费、Outbox 和审计计数。
- `expectZeroGiftWrites`、`expectReservedOnce`、`expectCapturedOnce`、`expectReleasedOnce`：复用资金不变量断言。

固定 UUID、Discord snowflake、时间和 idempotency key 必须带用例前缀，避免跨用例误关联。TOTP secret 只能存在于测试 fixture，报告和错误快照不得包含验证码。

## 6. 自动化用例矩阵

### 6.1 独立送礼

| 自动化编号 | 场景 | 核心断言 |
|---|---|---|
| GTA-S-001 | 同 Guild ACTIVE 陪玩目录 | 只返回有效陪玩；PAUSED、SUSPENDED、跨 Guild 和无绑定陪玩不可见 |
| GTA-S-002 | 公开独立送礼 | 一份 GiftRequest/ACTIVE 预留/GIFT_REVIEW；`PUBLIC`；提交时零消费、零成功公告 |
| GTA-S-003 | 匿名独立送礼 | 内部真实 sender/payer 保留；外部投影为匿名老板 |
| GTA-S-004 | 余额不足 | 返回余额、预留、可用和准确差额；礼物/预留/任务/消费/Outbox 零新增 |
| GTA-S-005 | 充值后刷新 | 只读刷新零写入；充值后最终确认按最新余额成功一次 |
| GTA-S-006 | 目录价格/状态/版本变化 | 旧快照不得提交，必须重新确认；零旧价写入 |
| GTA-S-007 | 两笔并发超支 | 钱包行锁下最多一笔成功，`availableMinor` 不为负 |
| GTA-S-008 | 伪造 receiver/profile/Guild | API 从合法 `playerProfileId` 派生 receiver；伪造请求零写入 |
| GTA-S-009 | 幂等重放 | 相同 key 返回同一业务结果且不重复预留；不同 key 代表新的送礼意图，不错误合并 |

### 6.2 订单内送礼

| 自动化编号 | 场景 | 核心断言 |
|---|---|---|
| GTA-O-001 | ACCEPTED/IN_SERVICE/PENDING_CONFIRMATION/完成24小时内 | 合法状态均可提交，receiver 仅从订单 participant 派生 |
| GTA-O-002 | 完成窗口外、取消、跨 Guild、非订单所有者 | 失败关闭且零礼物资金写入 |
| GTA-O-003 | 1/2/9/26 名参与人 | 去重、分页状态和批量金额正确；每名接收者一份礼物/预留/任务 |
| GTA-O-004 | 任一参与人失效 | 整批回滚，不能部分成功 |
| GTA-O-005 | 多人礼物余额不足 | 按总额计算差额，整批零写入 |
| GTA-O-006 | 确认期间订单/参与人/目录变化 | 最终事务重验并要求重新确认 |
| GTA-O-007 | 重复和并发提交 | 每个合法接收者最多一份对应事实，不重复预留 |
| GTA-O-008 | 订单入口匿名边界 | 当前合同保持公开；不得由篡改 payload 写入匿名事实 |

### 6.3 客服辅助送礼 B

| 自动化编号 | 场景 | 核心断言 |
|---|---|---|
| GTA-A-001 | 公开辅助送礼 | 老板是 sender/payer，客服是 executor，授权消息绑定正确 |
| GTA-A-002 | 匿名辅助送礼 | 内部老板身份完整，外部不出现老板或客服身份 |
| GTA-A-003 | 无 `gift.assist` | 403/不可执行，零业务写入 |
| GTA-A-004 | Bot/未绑定客户/跨 Guild/伪造消息 | challenge 不创建或不可消费，零预留 |
| GTA-A-005 | 错误 TOTP 后正确 TOTP | 失败次数增加；错误时零写入；合法挑战最终成功一次 |
| GTA-A-006 | 第五次错误 | challenge 锁定，后续正确 TOTP 也不能消费 |
| GTA-A-007 | 十分钟过期 | 固定时钟推进后失败关闭 |
| GTA-A-008 | `permissions_version` 变化 | 旧 challenge 失效，零业务写入 |
| GTA-A-009 | 余额不足与充值后刷新 | 始终读取老板钱包；不足零写入；充值后可重新验证 |
| GTA-A-010 | 并发消费和重放 | challenge 单次消费，最多一份请求/预留/任务/成功审计 |
| GTA-A-011 | TOTP/授权隐私 | Audit、错误、日志和 Discord payload 不含 TOTP 或客户完整消息正文 |

### 6.4 审核、资金与公告生命周期

| 自动化编号 | 场景 | 核心断言 |
|---|---|---|
| GTA-L-001 | 三入口创建 GIFT_REVIEW | 来源、orderId、sender、receiver、executor 和匿名事实正确 |
| GTA-L-002 | L1 核对但尝试批准/拒绝 | 权限拒绝且资金、状态、公告不变 |
| GTA-L-003 | L2/L3/L4 金额边界 | 200000/200001/499999/500000 CAT 按现行累积权限和 MFA 执行 |
| GTA-L-004 | 批准 | 捕获原预留；只产生一次消费和一次公告 Outbox |
| GTA-L-005 | 审批期间余额事实变化 | 不违反钱包约束，不创建无资金支持的捕获 |
| GTA-L-006 | 拒绝 | 原预留释放；零消费、零成功公告 |
| GTA-L-007 | 客户撤回 | 仅 sender、捕获前可撤回；释放一次 |
| GTA-L-008 | 过期 | 固定时钟触发；请求、审批和预留一致过期；重放幂等 |
| GTA-L-009 | 重复批准 | 并发/重放最多一次捕获、消费和公告 |
| GTA-L-010 | 批准与拒绝并发 | 最终只有一种终态，不得同时捕获与释放 |
| GTA-L-011 | 公告首次失败后成功 | 只重试 Discord 投递，不重复捕获或消费 |
| GTA-L-012 | 公告重复重试/消息恢复 | 最终单条有效公告，匿名事实不改变 |

### 6.5 Bot Adapter 与隐私 Payload

| 自动化编号 | 场景 | 核心断言 |
|---|---|---|
| GTA-B-001 | 三入口 interaction stub | handler 只调用统一 API，Actor/Guild/interaction ID 完整 |
| GTA-B-002 | 公开卡与私密步骤 | 公开卡不含余额；选择、余额和确认 reply 均为 ephemeral |
| GTA-B-003 | 过期、篡改、换用户 token | 写 API 调用次数为零，返回安全恢复提示 |
| GTA-B-004 | Bot 实例重建 | 未过期签名状态可恢复且不依赖进程 Map |
| GTA-B-005 | 常驻卡重复确保和删卡恢复 | fake transport 最终收敛为一张置顶卡 |
| GTA-B-006 | 公开公告 payload | 无余额、内部 ID、私密频道及意外 mention |
| GTA-B-007 | 匿名公告 payload | 禁止用户名、mention、Discord ID、头像、订单和授权消息字段 |
| GTA-B-008 | 发送失败 payload 重放 | 重试内容与匿名/公开快照一致，不产生第二次资金动作 |

## 7. 计划修改文件

### 7.1 新增

- `tests/support/gift-automation-fixture.ts`
- `tests/m22-us-06-gift-fixture-contract.spec.ts`
- `tests/m22-us-06-gift-entry-postgres.spec.ts`
- `tests/m22-us-06-gift-lifecycle-postgres.spec.ts`
- `tests/m22-us-06-gift-privacy-worker.spec.ts`
- `tests/m22-us-06-gift-bot-adapter.spec.ts`
- `tests/m22-us-06-gift-automation-gate.spec.ts`
- `evidence/P0/M22-US-06/summary.md`
- `evidence/P0/M22-US-06/test-report.json`

### 7.2 可能的最小调整

- `tests/support/postgres-migrations.ts`：仅在需要时抽取安全的临时 PostgreSQL生命周期 helper。
- `tests/support/wallet-fixture.ts`：补充真实 PostgreSQL 钱包断言，不改变生产钱包语义。
- `package.json`：增加精确的 `test:gift:non-ui` 命令。
- `scripts/e2e/`：只在 CI 需要统一检查本地 PostgreSQL binaries 时增加预检脚本。
- `evidence/P0/acceptance-matrix.csv`、`outputs/Codex-P0开发TODO.md` 及镜像：完成时更新真实结果。

生产代码只有在测试揭示外部依赖无法注入时才允许做最小 testability 调整；不得为方便测试复制业务分支或新增测试专用生产路径。

## 8. 实现顺序与验证先行

### 阶段 A：合同和 RED 基线

1. 新增 Story 合同测试，断言计划、Backlog、TODO、验收映射和人工 UAT 保留边界。
2. 新增 fixture contract，引用尚不存在的 builder 和资金断言，保存 RED 输出。
3. 确认当前分散测试为绿，避免把既有失败归因于本 Story。

### 阶段 B：隔离 PostgreSQL Harness

1. 抽取临时 PostgreSQL 启停、migration 和销毁逻辑。
2. 实现数据库安全守卫、固定 ID/时钟和 fixture builder。
3. 实现统一事实快照与零写入/预留/捕获/释放断言。
4. 先通过 fixture 专项，不进入礼物运行时修改。

### 阶段 C：入口与资金矩阵

1. 完成独立送礼矩阵。
2. 完成订单内单人、多人与状态边界矩阵。
3. 完成客服辅助权限、TOTP、过期和重放矩阵。
4. 每一类都同时覆盖成功、业务拒绝、并发冲突和数据库事实。

### 阶段 D：审核、Worker 与隐私

1. 串联领取、核对、批准、拒绝、撤回和过期。
2. 运行真实捕获服务和 Outbox handler。
3. 用 fake Discord transport 注入首次失败、恢复和重复重试。
4. 对所有 public/anonymous payload 做禁止字段扫描。

### 阶段 E：Bot Adapter 与发布门禁

1. 使用真实 renderer 产出的组件 JSON 执行 handler，不手工伪造不可能出现的 custom ID。
2. 覆盖 Actor/Guild 绑定、token 篡改/过期、实例重建和卡片恢复。
3. 建立 `test:gift:non-ui`，运行专项三次检查稳定性。
4. 运行相关回归、全仓测试、矩阵重建和空白检查。
5. 写入证据和 TODO；只完成 `M22-US-06`，不自动勾选 `M22-US-03`、`04`、`05` 的真实 Discord UAT。

## 9. 计划命令与门禁

实现时以真实 package scripts 为准，预期最小命令为：

```text
pnpm exec vitest run tests/m22-us-06-gift-fixture-contract.spec.ts
pnpm exec vitest run tests/m22-us-06-gift-entry-postgres.spec.ts tests/m22-us-06-gift-lifecycle-postgres.spec.ts
pnpm exec vitest run tests/m22-us-06-gift-privacy-worker.spec.ts tests/m22-us-06-gift-bot-adapter.spec.ts
pnpm exec vitest run tests/m22-us-06-gift-automation-gate.spec.ts
npm run test:gift:non-ui
npm run quality:bot
npm test
node scripts/build-p0-acceptance-matrix.mjs
git diff --check
```

PostgreSQL 测试前必须确认 `initdb`、`pg_ctl` 和 `createdb` 可用。任何目标测试失败都保留失败输出并停止完成声明。

## 10. 完成定义

`M22-US-06` 只有同时满足以下条件才能标记完成：

1. 本计划列出的非 UI 自动化矩阵均有可执行测试，不以 TODO/skip/todo case 占位。
2. 每个失败场景验证业务表零新增或状态完全不变。
3. 每个成功场景验证钱包公式、原预留生命周期、单次消费和单次公告。
4. 公开/匿名两类 payload 的隐私负例通过，TOTP 不进入响应、审计、日志和证据。
5. 临时 PostgreSQL 每次从当前 migration 启动并可重复运行三次，无共享数据依赖。
6. `test:gift:non-ui`、Bot 质量门禁、相关回归和全仓测试全部通过。
7. 验收矩阵可复现，Story 证据记录测试数量、命令输出、修改文件和剩余风险。
8. Story 使用独立 Conventional Commit。
9. 真实 Discord Desktop/Mobile、右键菜单、ephemeral 可见性、频道权限和最终视觉仍明确保留给 `M22-US-05`，不得由本 Story 代签。

## 11. 保留人工 UAT

自动化完成后，发布收口只需保留以下高价值真人路径：

1. Desktop 独立公开送礼。
2. Mobile 独立匿名送礼。
3. Desktop 订单多人送礼。
4. Mobile 客服匿名辅助送礼 B。
5. 余额不足、充值后刷新。
6. 真实消息右键 Apps 命令和本人 TOTP Modal。
7. 常驻卡删除、Bot Gateway 重启和旧组件恢复。
8. 老板、陪玩、客服、普通观察者四视角的公开/匿名公告检查。

这些用例仍按 `evidence/P0/M22-US-03/human-uat-runbook.md` 和 `evidence/P0/M22-US-04/human-uat-runbook.md` 采集具名证据。
