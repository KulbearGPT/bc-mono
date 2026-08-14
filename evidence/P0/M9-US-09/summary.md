# M9-US-09 Discord 客户常驻下单入口证据

玩家入口频道的唯一常驻消息已扩展为注册、申请陪玩和“开始找陪玩”三个入口。下单按钮创建私密文字频道和占位面板，再调用统一订单 API；成功后写入真实订单面板，重复创建会删除临时频道并引导至既有订单频道，失败也会清理临时频道并返回 request_id。

Bot 配置中的 `public_entry_channel_id` 对外名称调整为“玩家入口频道（注册 / 下单）”，继续复用既有持久消息投影和启动恢复机制，不新增重复业务规则。

自动化候选通过后仍需在真实 Discord Guild 验证频道权限、消息恢复、重复点击和失败清理，因此 Story 暂不关闭。

## 2026-08-02 Discord UAT 修复

真实 Guild 首次下单暴露订单草稿面板把两个 String Select 放进同一 Action Row，违反 Discord 每个 Select 必须独占一行的组件约束。RED：`npx vitest run tests/m1-us-04-bot.spec.ts` 为 1 failed / 13 passed；修复后游戏、服务、区服、时长四个 Select 分别独占一行，操作按钮占第五行。GREEN：同一聚焦测试 14/14 通过；关联回归 `tests/m1-us-04-bot.spec.ts tests/m9-us-05-onboarding-bot.spec.ts tests/m4-us-10-bot.spec.ts` 为 3 files / 25 tests 通过，`npm run typecheck -w @blackcat/bot` 与 `npm run build` 通过。频道分类存在且 Bot 在分类中具备 View Channel、Manage Channels、Send Messages 与 Manage Roles，排除配置和 Discord 权限问题。

本次失败在 API 留下两个指向已清理 Discord 频道的 `DRAFT` 订单。确认对应频道均为 Discord `10003 Unknown Channel` 后，已分别通过正式 cancellation preview 与 cancel API 追加取消事实，没有直接修改或删除订单；两笔均转为 `CANCELLED`，`reservationAction=null`，未涉及资金预留。取消 request_id 为 `req_6e8f2665-00a0-4289-91ca-5cf47dd07853` 与 `req_1dcf7781-840a-4854-b574-aa4581fb4c5a`。Bot 已重新构建并重启，启动日志确认 ready、配置缓存 1/1 加载成功、常驻入口消息原位恢复。剩余门禁为客户再次点击后的真实成功下单与重复点击恢复。

后续真实草稿操作发现 Select handler 仍是早期占位实现：每次选择只发送“订单选项已收到”的 ephemeral 消息，既不调用统一订单 API，也不原位更新面板，导致消息堆叠且订单仍为空；确认请求 `req_b48a685d-eb10-434f-8a36-e9ce619ae232` 同时暴露 `/api/v1/me/balance` 只读取员工 `actorUserId`、未通过可信 Discord 绑定解析普通客户的问题。新增 RED 为 2 files / 2 failed / 17 passed；修复后 Select 静默 defer、调用 `updateOrder` 并 edit 原面板，钱包读取在无员工身份时通过 Guild + Discord 绑定解析客户。GREEN 聚焦为 2 files / 19 tests，关联回归为 5 files / 29 tests，项目 typecheck 与 build 通过；真实客户 Actor 余额 API 返回 200（request_id `req_5e923941-9566-4618-aa69-6c34052a1376`）。API 已热更新，Bot 重启日志确认 ready、配置缓存和常驻入口恢复成功。旧面板显示的选择未曾写入数据库，UAT 需重新选择四项。

订单常驻菜单补强：所有活跃阶段保留可执行控制。草稿与待匹配提供取消/申诉；已接单提供就绪/取消/申诉；服务中陪玩可申请完成，客户不获得违反双方流程的单方完成入口，但双方始终可取消或申诉；待确认由客户确认完成，并保留取消/申诉。申诉按钮调用统一 `POST /orders/:id/staff-tasks` 创建 `ORDER_ASSIST` 客服任务，不再使用占位回执。Select 更新失败时先重新读取订单并恢复原面板，再单独给出私密错误，不再清空频道的唯一操作面板。RED 为 2 files / 4 failed / 9 passed；GREEN 关联回归 5 files / 39 tests，项目 build 通过。失效草稿 `P-92C0809B` 的原消息 `1533589150656364696` 已原位恢复为五行面板，Bot 重启 ready。

数据库目录联动修复：真实选择请求 `req_06e752d5-14d7-4436-8c42-4542d426e37d`、`req_3e130a9b-d566-4d31-903a-d120466c3560` 均因旧 Bot 分别提交 `game/service/region` 而被统一 API 以 `VALIDATION_ERROR` 拒绝；API 合同要求完整 `serviceCatalogId + unitCount`。订单菜单现通过 `GET /services` 读取 ACTIVE 数据库目录，以服务版本 UUID 作为唯一选项值，项目自身携带游戏、服务和区服；时长变更会连同当前目录 ID 原子提交。新订单在频道创建后立即按首个可用目录和 minimumUnits 初始化，不再创建无法编辑的空草稿。另修复运行时 `DETAILS_UPDATED` 事件序号错误固定为 1、与 CREATED 事件冲突导致 PostgreSQL 更新回滚的问题，现使用更新后订单版本作为序号。事件序号 RED 1 failed / 6 passed；GREEN 3 files / 25 tests，最终关联回归 6 files / 41 tests、typecheck/build 通过。当前 `P-92C0809B` 已通过正式订单 API 初始化为目录 `761572da-dfb0-4139-8934-43e5f5aeabc7`，版本 2，并将原消息重建为三行数据库驱动面板；Bot 重启 ready。

Discord 信息层级优化：共享 `MessageSpec` 渲染边界从粗体标题加纯文本正文升级为单一 Embed，覆盖个人中心、余额、订单/消费列表、陪玩周报、订单详情与生命周期、礼物及其他结构化面板；按钮和 Select 继续作为 Embed 下方组件。单行成功、失败和 request_id 提示仍由 handler 使用普通文字，避免小提示卡片化。Embed 统一使用品牌色、标题、最多 4096 字描述和 Blackcat Companion footer；所有原位 edit/update 调用同步传递 embeds 并清除旧 content，防止更新后正文消失。RED 为 1 file / 2 failed / 2 passed；GREEN 聚焦 5 files / 39 tests，最终关联 6 files / 41 tests、typecheck/build 通过。当前 `P-92C0809B` 原消息已原位升级为 1 个 Embed + 3 行组件，Bot 重启 ready。

可选区服修复：订单确认完整性检查错误地把 `region=null` 判为缺失，导致本身未配置区服的服务项目无法提交。现区服为空时展示“无指定区服”，只校验游戏、服务和时长。RED 为 `tests/m1-us-07-bot.spec.ts` 1 failed / 7 passed；GREEN 关联 3 files / 29 tests。历史订单与目录数据无需修改。

订单刷新状态分流修复：`P-374DF0C3` 已进入 `PENDING_DISPATCH` 后，“刷新订单”仍复用草稿确认 handler，且 handler 错把 `EDIT_ORIGINAL_MESSAGE` 作为新消息回复，连续生成过期确认卡。现非 `DRAFT` 状态直接读取并渲染当前订单面板，不调用 estimate/balance；草稿确认和最终提交均使用 `interaction.update` 原位替换。RED 为 `tests/m1-us-07-bot.spec.ts` 1 failed / 8 passed；GREEN 关联 4 files / 30 tests；最终 `npm test` build 通过且 155 files / 779 tests 全通过。已按频道与订单号精确核对并删除 5 条错误生成的“最后确认”Bot 消息，保留当前匹配状态消息与数据库面板消息。

服务展示名称修复：Discord 订单面板和项目 Select 此前直接显示服务目录的稳定 `game/service` 代码。PostgreSQL 查询本已读取 `service_offerings.game_name/service_name`，但 `mapServiceCatalogRow` 与 Public DTO 丢弃了名称。现统一 API 在稳定代码之外明确返回 `gameDisplayName/serviceDisplayName`，Bot 仅将展示名称用于摘要和选项 label，Select value 仍为服务版本 UUID，订单匹配与历史代码事实不变。OpenAPI outputs/docs 双镜像已同步。RED 为 3 files / 4 failed / 28 passed；GREEN 聚焦 3 files / 32 tests，Bot/API/合同回归 26 files / 131 tests、全仓 typecheck/build、Prisma validate、镜像比较和 diff check 通过。真实 Guild 旧消息需刷新或重新选择后验证，Story 保持未完成。

展示名称横向修复：继续审计发现订单名称快照实际写入稳定代码、区服无名称快照，以及陪玩工作台、派单 Outbox/Worker、客服工作台、陪玩标签表格和分成项目下拉仍可能直出代码。现订单分别持久化 game/service/region 代码与名称快照，统一 API Order DTO 返回三组展示名称；派单 payload 使用名称快照，Bot 和 Dashboard 显示名称，匹配、Select value 与资格标签继续使用稳定代码。`000018_order_display_name_snapshots` 新增 `region_name_snapshot`，并按服务版本关联回填已有订单的游戏/服务/区服名称；服务目录通过 REGION 标签解析区服展示名。RED/聚焦回归 9 files / 74 tests，最终关联 30 files / 159 tests通过；typecheck/build、Prisma validate、完整 18 段迁移链（74 tables）、OpenAPI/Prisma 双镜像和 diff check均通过。真实 Guild 旧消息仍需刷新复验，Story保持未完成。

## 2026-08-04 活跃订单频道缺失恢复

复现确认重复下单入口只信任 API 返回的旧 `channelId`，Discord 频道已删除时仍输出 `<#channelId>`，客户端显示 `#unknown` 并阻止客户继续下单。采用恢复而非隐式取消：Bot 已创建的新临时私密频道成为替代频道，`recoverOrderChannel` 在统一 API 内校验订单仍活跃、版本与旧频道映射仍一致后，原子追加带 `recovered=true` 的既有 `CHANNEL_LINKED` 订单事件、审计并替换频道/面板映射；订单状态、预留、价格和其他快照保持不变。旧频道仍存在时继续删除临时频道并返回原频道。

权限覆盖明确拒绝客户 `ManageChannels`，Bot 与配置的 L1-L4 客服 Role 可管理频道。未采用“频道删除即自动取消”，因为现有取消合同要求 cancellation preview，且已接单/服务中状态可能需要客服复核和资金处置。

RED：`tests/m1-us-04-bot.spec.ts` 权限合同 1 failed / 14 passed。GREEN：`npm exec vitest run tests/m1-us-03-api.spec.ts tests/m1-us-04-bot.spec.ts -- --reporter=dot` 为 2 files / 23 tests；`npm run typecheck` 通过。真实 Guild 删除频道后再次点击并验证恢复仍待 UAT，Story 保持未完成。

## 2026-08-05 恢复提交失败修复

真实请求 `req_0c151360-45b8-4d05-813d-0f617723d829` 在审计中定位为 `RECOVER_ORDER_CHANNEL / COMMIT_FAILED`。根因是草稿更新 SQL 未持久化替换后的 `channel_id/panel_message_id`；恢复事件改用数据库已有的 `CHANNEL_LINKED` 并携带 `recovered=true`，无需新增枚举或迁移。Postgres 恢复事件提交和 API/Bot 回归通过；真实 Guild 需重启 API/Bot 后复验。
