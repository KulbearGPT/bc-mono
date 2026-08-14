# M2-US-01 Evidence Summary

## Story

- Story：M2-US-01 陪玩准入、标签、Presence 与可接单状态
- 验收用例：AT-DSP-001; AT-ROL-001
- 范围：`player_profile` 审核、游戏/服务标签、本人 AVAILABLE/BUSY、Discord Presence 同步、单活跃订单候选过滤、统一 API 路由、Sapphire Presence Listener 和 runtime Postgres store wiring。

## 实现文件

- `apps/api/src/players.ts`
  - 新增 `PlayerStore`、`InMemoryPlayerStore`、`PostgresPlayerStore`。
  - 新增 `selectEligibleDispatchCandidates`。
  - 新增玩家工作台、本人可接单状态、Discord Presence sync、管理员审核、运营状态、标签管理 API route。
  - Postgres 查询读取 Discord 绑定、玩家标签、用户状态、Presence、availability 和 active order。
- `apps/api/src/server.ts`
  - `buildApiServer({ player })` 注册玩家相关统一 API。
- `apps/api/src/index.ts`
  - runtime 创建 `PostgresPlayerStore` 并传入统一 API server。
- `apps/api/src/security.ts`
  - 增加玩家准入、状态、标签、Presence sync 所需权限。
- `apps/api/package.json`
  - 暴露 `@blackcat/api/players`。
- `apps/bot/src/service-center.ts`
  - `HttpBotApiClient.syncDiscordPresence` 调用统一 API。
- `apps/bot/src/pieces/listeners/presence-update.ts`
  - 新增 Sapphire PresenceUpdate listener，只同步 Discord presence，不改业务 availability。
- `tests/m2-us-01-api.spec.ts`
  - API、权限、候选过滤、runtime wiring 测试。
- `tests/m2-us-01-bot.spec.ts`
  - Bot HTTP client 与 Sapphire Piece manifest 测试。
- `tests/m2-us-01-db.spec.ts`
  - Postgres store 集成测试。

## RED / GREEN 记录

- RED：`tests/m2-us-01-api.spec.ts` 初始要求 `@blackcat/api/players`、player route、权限与候选筛选，未实现时失败。
- RED：`tests/m2-us-01-bot.spec.ts` 初始要求 `syncDiscordPresence` 和 Sapphire listener，未实现时失败。
- RED：`tests/m2-us-01-db.spec.ts` 初始要求 Postgres store 读取玩家、标签和 presence/availability 独立更新，未实现时失败。
- RED：runtime wiring 测试要求 `apps/api/src/index.ts` import/instantiate `PostgresPlayerStore` 并传入 `buildApiServer({ player })`，未接入时失败。
- GREEN：完成最小实现后，目标测试通过。

## 验证命令

```bash
npx vitest run tests/m2-us-01-db.spec.ts
```

结果：1 file / 2 tests passed。

```bash
npx vitest run tests/m2-us-01-api.spec.ts -t "runtime API entrypoint wires PostgresPlayerStore"
```

结果：1 file / 1 selected test passed，7 skipped。

```bash
npx vitest run tests/m2-us-01-api.spec.ts tests/m2-us-01-bot.spec.ts tests/m2-us-01-db.spec.ts
```

结果：3 files / 12 tests passed。

```bash
npm run typecheck
```

结果：`tsc -b tsconfig.build.json` exit 0。

```bash
npm test
```

结果：25 files / 162 tests passed。

## 验收覆盖

- AT-DSP-001：候选池只包含 ACTIVE + AVAILABLE + ONLINE + 标签匹配 + active user + 无 active order 的陪玩。
- AT-ROL-001：L2 不能审核通过陪玩，L3 可以审核/暂停，L2 可以在审核后更新技能标签；PENDING_REVIEW/PAUSED/SUSPENDED 不可自助切换为可接单。
- Presence 独立性：Discord Presence sync 不会覆盖业务 availability；availability 切换不会覆盖 Discord Presence。
- Runtime 可用性：`PostgresPlayerStore` 已接入 API 入口，Dashboard 与 Bot 共用统一 API。

## 剩余风险

- Discord bot credential 暂未提供，真实 Discord Server PresenceUpdate E2E 未执行。
- M2-US-02 才会实现订单提交后的 dispatch_attempt、集中派单卡片、超时轮次和候选快照；本 Story 只提供候选资格基础能力。

## M11/M15 现行语义更正（2026-08-06）

- 上述 M2 时期的“陪玩本人 AVAILABLE/BUSY”与 first-success-wins 派单是历史实现证据，已被 M11 候选报名池合同取代，不再是当前运行规则。
- 现行资格由客服审核的 `ACTIVE`、Guild 和运营标签决定；Presence 与历史 availability 只侜诊断，不阻止报名。
- 历史自助 availability URL 已返回 404 且零写入，API store 的死写方法也已移除；陪玩端只保留候选池报名/撤回。

## 2026-08-03 Presence 幂等与审计合同回归

- 现场症状：高频 `PresenceUpdate` 出现 `IDEMPOTENCY_IN_PROGRESS`，原请求随后以 `AUDIT_APPEND_FAILED` 结束。
- 根因：监听器使用 `presence:guild:user:observedAt` 作为 source event id；同毫秒回调可能重复，且该值超过 `audit_logs.interaction_id` 的 32 字符上限。
- RED：`tests/m2-us-01-bot.spec.ts` 新增 source event id 唯一性、允许字符和最大长度测试；实现前 3 项测试中 2 项失败。
- GREEN：新增 `buildDiscordSourceEventId('presence')`，每次回调生成独立的 32 字符标识；时间语义继续由 `observedAt` 承载。
- 验证：`npx vitest run tests/m2-us-01-bot.spec.ts tests/m2-us-01-api.spec.ts tests/m2-us-01-db.spec.ts`，3 files / 15 tests passed；`npm run typecheck` 通过。
- 本地运行时复验：通过 `HttpBotApiClient.syncDiscordPresence` 调用统一 API，32 字符事件标识成功返回 Presence 结果，并由 Postgres 审计链路正常记录。
