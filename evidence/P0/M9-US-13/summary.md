# M9-US-13 订单提交创建候选池

## 当前合同（2026-08-07）

- M11 已正式取代旧自动抢单与 90 秒轮询语义。订单提交只进入 `PENDING_DISPATCH` 并保持原 FundReservation；客户选择 3、5、10、15、30 分钟后，统一 API 才创建候选池并由 Worker 向派单频道发布报名卡。
- 真实订单 `P-BE7E43CE` 的订单事件只有 `CREATED`、`SUBMITTED`，数据库没有 selection pool、dispatch attempt、candidate 或相关 Outbox；因此截图中的“已通知符合条件的陪玩：0 人”不是发送失败，而是刷新错误沿用了退役的 matching 投影，并覆盖了等待时间选择器。
- 新增所有者只读 `getCurrentOrderSelectionPool`。Bot 刷新 `PENDING_DISPATCH` 时，无活动池恢复等待时间选择器；`COLLECTING` 池恢复轮次、报名人数、截止时间与提前结束入口。服务端 owner/Guild 校验防止跨用户读取，已有活动池不会重复创建或重复预留。
- Story 仍为 `IN_PROGRESS`：自动化、合同、类型和构建门禁通过后，仍需在真实 Guild 刷新 `P-BE7E43CE`、选择时长，并确认派单频道报名卡实际发布。

## 刷新恢复验证（2026-08-07）

- RED：Bot 刷新恢复新增 2 项失败（无池仍渲染“已通知 0 人”、活动池未恢复报名控件）；API current-pool 路由新增 1 项失败；合同 current-pool operation 新增 1 项失败。
- GREEN：`tests/m1-us-07-bot.spec.ts`、`tests/m11-us-01-selection-pool-contract.spec.ts`、`tests/m11-us-02-selection-pools-api.spec.ts`、`tests/m11-us-02-selection-pools-postgres.spec.ts`、`tests/m11-us-03-selection-discord.spec.ts`、`tests/m9-us-13-auto-dispatch.spec.ts` 共 6 files / 39 tests 通过。
- `npm run typecheck`、`npm run build`、`npm run quality:routes`、Bot 全目录 Prettier 和 `git diff --check` 通过；路由合同为 157 个生产 operation 全部有文档。
- Bot 全量为 48 files 中 47 passed、265 tests 中 263 passed；剩余 2 项均为本改动前已有的 `M17-US-08` 门禁（退役的 versioned refresh 解析预期、按钮适配器 707 行预算），本 Story 未扩大范围修复。
- 本地开发运行时 `GET /api/v1/orders/{orderId}/selection-pools/current` 已对 `P-BE7E43CE` 返回预期 `404 NOT_FOUND`（`request_id: req_0497d360-4869-493b-927a-48ee6f771cc2`），证明当前确实尚未开池且新恢复路由已经热加载；随后以真实 API 客户端执行只读 `handleOrderRefresh`，结果为 `EDIT_ORIGINAL_MESSAGE`、包含等待时间选择器和“等待 3 分钟”、不含“已通知符合条件的陪玩：0 人”。两次核验均未修改订单、资金或 Discord 状态。
- 本地缺少 ESLint 可执行包，`npm run lint:bot` 未能启动；不是 lint 规则失败，已由 TypeScript、Prettier、构建及相关回归覆盖当前改动。
- 创建流程目标卡修复（2026-08-07）：真实 `submit-final` Sapphire 行为测试确认按钮会先 acknowledgement、调用统一提交 API、再编辑原消息；此前目标卡仍使用退役的“正在匹配陪玩”标题和匹配文案，导致客户看不到明确的候选池步骤。提交成功卡现明确显示“订单已提交 · 请选择报名等待时间”、五档选择器，并说明只有选择后才向派单频道发布。RED 1 failed / 4 passed；GREEN 目标 1 file / 5 tests、关联 4 files / 32 tests 通过，覆盖实际 `editReply` Components V2 负载中的 `bc:sp:new` 路由。
- 创建流程修复后的 Bot 全量为 48 files 中 47 passed、266 tests 中 264 passed；仍只有改动前既存的两项 `M17-US-08` 门禁失败。`npm run typecheck`、`npm run build`、Bot Prettier 和 `git diff --check` 通过。
- 本地运行时已恢复：启动 Docker Compose 中挂载原匿名数据卷的既有 `postgres:16-alpine` 容器，确认应用角色为 `blackcat_app`、数据库为 `blackcat`、订单 `P-BE7E43CE` 仍为 `PENDING_DISPATCH v3`；未重建容器、未执行迁移。API `/health` 为 OK、`/ready` 为 READY，Worker `worker.started`，Bot 收到 `discord_gateway.ready` 且 Guild 配置加载 1/1 成功。真实 API 客户端对该订单只读渲染包含 `bc:sp:new:*:o3` 和明确的选择报名时间步骤，不含旧“已通知符合条件的陪玩：0 人”；仍待客户实际点击完成 Discord UAT。
- 活动轮次重复选择修复（2026-08-07）：请求 `req_b28ab0b9-54cd-40af-a575-7ded1db69d41` 已确认是 `CREATE_ORDER_SELECTION_POOL / CONFLICT`；第一轮早 7 秒按 3 分钟成功创建（pool `e43f765f-7710-422a-b4ec-a8dfb57a02e9`，0 人报名），旧订单卡未被替换，客户再选 5 分钟才触发冲突。候选池等待 Select 现在使用 `deferUpdate`：首次创建后原位切换为报名进行中卡并移除等待下拉框；旧卡冲突时读取当前活动池、恢复其实际分钟数/截止时间/提前结束入口，并私密说明活动轮次不能直接改时长。RED 2 failed / 8 passed；GREEN 目标 10/10、关联 7 files / 46 tests，typecheck/build、157 路由合同、Bot Prettier 通过；Bot 全量 47/48 files、266/268 tests，仍只有两项既存 `M17-US-08` 门禁失败。代码热重载后 Bot 再次 `discord_gateway.ready`；该 3 分钟轮次到期关闭与 `SELECTION_POOL_SYNC` 均由 Worker 成功完成。
- 等待预设一致性修复（2026-08-07）：首次与零报名续轮入口统一为一个下拉菜单，均提供 `1/3/5/10/15/30` 六档；移除续轮旧版 `1–15`、`16–30` 双菜单。同步主规格、交互映射与 `AT-SEL-001` 的 docs/outputs 镜像。RED 目标 3 failures / 12 tests，关联回归另捕获 1 个旧五档断言；GREEN 7 files / 46 tests，typecheck/build、157 路由合同与 Bot Prettier 通过。API、Worker、Bot、Dashboard 已重启，Worker `worker.started`、API `api.started`、Bot `discord_gateway.ready` 且 Guild 配置 1/1 加载成功。
- 取消返回续轮恢复（2026-08-07）：首轮结束且 0 候选时，客户从取消确认页点击“暂不取消，返回订单”，刷新渲染不再卡在“等待选择陪玩”；现在恢复 `bc:sp:r` 续轮路由与 `1/3/5/10/15/30` 单下拉菜单。正在报名或已有候选时仍不显示重复开池入口。RED 1 failed / 17 passed；GREEN 目标 18/18、关联 7 files / 47 tests，typecheck/build、157 路由合同与 Bot Prettier 通过；Bot 已热重载并再次 `discord_gateway.ready`。
- 派单频道过期卡收敛（2026-08-07）：`SELECTION_POOL_SYNC` 从 `COLLECTING` 进入 `SELECTION` 或 `FINALIZED` 时，Worker 通过候选池稳定 nonce 找到原派单消息并 PATCH 为“报名已结束”，显示本轮候选人数且将 `components` 清空；不再遗留可点击的报名下拉框，也不新发替代卡。RED 1 failed / 9 passed；GREEN 目标 10/10、关联 7 files / 47 tests，typecheck/build、157 路由合同与 Bot Prettier 通过；主规格、`INT-D-068` 和 `AT-SEL-003` 镜像同步。运行时已重启，Worker `worker.started`、API `api.started`、Bot `discord_gateway.ready`。

## 已退役实现历史（不作为当前运行合同）

## 实现

- 订单从 `DRAFT` 提交为 `PENDING_DISPATCH` 时，在同一数据库事务写入可恢复的 `DISPATCH_START` Outbox 任务。
- Worker 消费起始任务，调用统一领域派单服务；候选仍必须满足 ACTIVE 审核、AVAILABLE 开关、ONLINE Discord 状态、游戏/服务标签匹配且没有活跃订单。
- 每轮有效期为 90 秒。超时任务只结束当前轮；若订单仍为 `PENDING_DISPATCH`，立即以 `TIMEOUT_RETRY` 创建下一轮，不创建第二笔 FundReservation。
- `DISPATCH_START` 纳入生产 Worker 白名单、运维任务查询和 OpenAPI `JobType`，Bot 不保存或重复匹配规则。

## 验证

- RED：新增 `tests/m9-us-13-auto-dispatch.spec.ts`，在 Worker runtime 未注册 `DISPATCH_START` 时失败。
- GREEN 定向：6 个测试文件 / 23 个测试通过。
- 功能实现后的完整 `npm test -- --run`：build 通过，157 个测试文件 / 785 个测试全部通过。合同追踪同步后的最终复验为 156 个文件 / 784 个测试通过；既有 Railway 并行子进程门禁 1 项因进程未输出而失败，随即单独复验该文件 14/14 通过。
- `npm run typecheck`：通过。
- 真实 Guild 接单缺陷复验：派单按钮原先等待 API 完成后才回复 Discord，API 延迟或失败会越过 3 秒确认窗口并显示 `didn't respond in time`。新增回归要求按钮先 `deferReply`，再以 `editReply` 返回成功或携带 request_id 的失败结果；定向测试 3/3 与 Bot typecheck 通过。
- 后续真实点击以 `req_d1ba84b8-6313-40fc-ae4a-6abb6c5c241d` 确认 API 返回 `PLAYER_NOT_ELIGIBLE`：该账号为 OFFLINE / UNKNOWN，批准技能为 VALORANT + RANKED，而订单为 VALORANT + FUN；同轮候选快照为 0。资格拒绝改为可操作说明；零候选轮次会编辑同一消息为“正在等待合格陪玩”并移除按钮，避免旧卡残留。派单/API/Worker delivery 回归 27/27 与完整 build 通过。
- 派单频道防刷屏：同一订单的后续 90 秒轮次按 orderId 复用并编辑上一条 Discord 派单消息，成功后将 messageId 从旧 attempt 原子转移到新 attempt；消息被人工删除时仍可重建。RED 复现新轮创建新消息后，Worker/派单回归 17/17 与全项目 typecheck 通过。
- 真实 Worker 复验修正两个持久化边角：复用查询必须优先非空 message_id；归属转移必须在单条 `UPDATE ... CASE` 中完成以避免唯一约束瞬时冲突。失败任务 `196d37fe-1f7c-48d7-91a6-87f3c56552a9` 重试成功，轮次 283 复用消息 `1533734414838796358`，轮次 282 的归属已清空；最终相关回归 27/27 与 build 通过。
- 本地真实运行：为修复前已卡住的 `P-374DF0C3` 幂等补入一条 `DISPATCH_START`；Worker 完成第 1 轮派单（Discord message `1533628032554766548`），90 秒后将其标记为 `TIMED_OUT`，并在不到 1 秒后自动创建第 2 轮（Discord message `1533628405898281001`）。订单仍为 `PENDING_DISPATCH`、版本 5，没有新建资金预留。
- 接单成功反馈现在使用 API 返回的可信 `channelSpec.channelId` 渲染 `<#channelId>`，陪玩可从 ephemeral 提示直接进入订单文字频道；RED 先证明旧文案为静态字符串，GREEN 定向回归 `2 files / 7 tests passed` 且 Bot typecheck 通过。
- 重复点击接单不再把已接单陪玩误报为资格不符：Bot 在 `CONFLICT` / `PLAYER_NOT_ELIGIBLE` 后通过统一 API 重新读取订单；只有服务端仍授权当前参与者读取时才提示“已经接过这张委托”并附频道链接，其他冲突显示席位已处理。RED 复现旧文案缺失，GREEN 定向回归 `2 files / 8 tests passed` 且 typecheck 通过。

## 状态与剩余门禁

真实 Guild 已验证派单卡、90 秒自动下一轮、按钮及时确认以及 `P-DBDE4FB0` 首席位成功接单。仍需复验新版成功提示、重复接单提示中的订单频道链接和后续订单状态，Story 保持未勾选。
