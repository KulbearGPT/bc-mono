# M9-US-18 订单面板投影一致性

- 状态：本地候选，待真实 Guild 跨状态与重启 UAT。
- 验收：`AT-PRJ-001`、`AT-PRJ-002`。
- 事务覆盖：订单提交、自动化暂停/恢复、自动取消、双方 readiness、完成确认超时、readiness 超时、客服结案和客服转派均在订单事实提交前写入幂等 `PANEL_SYNC` Outbox；已有接单、申请完成和确认完成路径继续保留事务性同步。
- Worker：PATCH 使用 `MessageFlags.IsComponentsV2` 对应的 V2 Container/Text Display 原生负载，不再向 V2 消息混入 legacy `content` / `embeds`；`PENDING_DISPATCH` 面板显示已到位/总席位并保留刷新、取消和联系客服入口；所有 custom_id 使用数据库当前 `row_version`。
- 多陪玩一致性：投影从 `order_participants` 聚合全部 ACTIVE 陪玩 Discord ID、总席位与已到位席位；Worker 为每位已到位陪玩同步文字频道权限，匹配完成后语音频道也包含全部陪玩。客户手动刷新复用 API 聚合进度，明确显示“1/3、还差 2 位，全部到齐后开放准备确认”。
- 真实故障复现：订单 `P-43C1C40C` 为 3 席位、已到位 1 席位，旧 PANEL_SYNC 连续失败；Discord 返回 HTTP 400 / `MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2`。RED 同时证明旧 Worker 只授权单一 `orders.player_id` 且客户刷新缺少到位进度；GREEN 专项 `4 files / 18 tests passed` 与 typecheck 通过。
- RED：`tests/m9-us-18-order-projection-consistency.spec.ts` 3/3 失败，分别证明 lifecycle、submit/cancel 和 staff resolution/reassignment 缺少持久同步。
- GREEN：订单相关 11 files / 44 tests，专项投影与 Worker 2 files / 14 tests，`npm run typecheck`、`npm run build` 通过。
- 全量门禁：最终 160/161 files、808/809 tests 通过；唯一失败为既有 `m5-us-08-railway-runtime` 并行子进程无输出波动，随后单独复验 14/14 通过。合同/追踪门禁 6 files / 90 tests、Prisma validate、空库迁移验证（74 tables）通过。
- 频道归档阻断：主规格要求完成后保留 24 小时，并且 transcript 封存成功后才能删除。当前只有 append-only 消息事件，没有封存成功事实、状态或 API，因此本 Story 不生产 `CHANNEL_ARCHIVE`，避免丢失最后消息。该阻断必须由 transcript 封存生命周期 Story 解决。
- 剩余风险：客服转派的面板与新陪玩访问会同步，但旧陪玩的 Discord permission overwrite 撤销仍需独立权限协调验收；本轮仍需完成真实 Discord Worker 重启恢复与全席位 readiness UAT。

## 2026-08-06 客户终选后的就绪入口回归

- 真实复现：订单 `P-336171B3` 已有 1 名 ACTIVE 正式参与人且数据库状态为 `ACCEPTED`/版本 4，但 `readiness_due_at` 为空；唯一 `PANEL_SYNC` 是版本 3 的提交同步并已完成，终选事务没有产生版本 4 面板同步，因此 Discord 仍显示“正在匹配陪玩”，陪玩看不到“我已就绪”。
- 修复：`PostgresSelectionPoolStore.mutateFinalize` 在同一事务内为每次终选追加订单级幂等 `PANEL_SYNC`；全部席位填满进入 `ACCEPTED` 时，同时设置 10 分钟 `readiness_due_at` 并追加 `READINESS_TIMEOUT`。Worker 继续从数据库最新事实生成带 `bc:service:ready:<orderId>:v<version>` 的面板，并为全部 ACTIVE 陪玩同步频道权限。
- RED：`npx vitest run tests/m9-us-18-order-projection-consistency.spec.ts tests/m11-us-02-selection-pools-postgres.spec.ts` → 2 files / 6 tests 中 2 failed；实际观测为 `accepted_with_deadline_count: 0`、`panel_sync_count: 0`、`readiness_timeout_count: 0`。
- GREEN：同命令 → 2 files / 6 tests passed。关联选秀、Worker、多人就绪、Bot 及超时回归 → 9 files / 46 tests passed；`npm run typecheck`、`npm run build` 通过。
- 修改文件：`apps/api/src/selection-pools.ts`、`tests/m9-us-18-order-projection-consistency.spec.ts`、`tests/m11-us-02-selection-pools-postgres.spec.ts`、本证据和 `outputs/Codex-P0开发TODO.md`。
- 外部门禁：当前开发工作区不是正在运行 Bot/Worker 的 `/private/tmp/codex-main-merge.VygbgP` 候选目录，因此本轮未冒充已部署；现存订单仍需在修复候选部署后通过受权 `panel-repair` 恢复并完成真实陪玩点击 UAT，Story 保持未完成。

## 2026-08-06 全状态只读刷新入口

- 修复范围：订单向导、提交后匹配、自动化暂停、`ACCEPTED`、`IN_SERVICE`、`PENDING_CONFIRMATION`、完成、取消、异常及 Worker 持久面板统一提供 `bc:order:<orderId>:refresh`。刷新 custom_id 不绑定旧 `row_version`，因此旧 Discord 面板也能读取 API 最新事实。
- 行为约束：刷新只执行 GET/read-only API；不提交订单、不创建或变更 FundReservation、不写 readiness、订单事件或 Outbox。最新状态为 `ACCEPTED` 时重新生成“我已就绪”，服务中和待确认状态分别恢复其当前有效主操作。
- 路由适配：按 `main` 的 M17 分层结构，解析、registry、interaction handler 与业务 presenter 分开接入；Worker 的 Components V2 投影使用同一无版本刷新路由。
- 验证：聚焦 `npx vitest run tests/m1-us-07-bot.spec.ts tests/m1-us-08-bot.spec.ts tests/m2-us-04-bot.spec.ts tests/m5-us-02-worker-adapters.spec.ts` → 4 files / 48 tests passed；完整 Bot + Worker 回归 → 23 files / 138 tests passed；`npm run typecheck`、`npm run build` 通过。
- 修改文件：`apps/bot/src/service-center-routes.ts`、`apps/bot/src/service-center-route-registry.ts`、`apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts`、`apps/bot/src/service-center.ts`、`apps/api/src/worker-adapters.ts`、四个相关测试、本证据和 `outputs/Codex-P0开发TODO.md`。
- 外部门禁：尚未重启/部署真实 Guild Bot 与 Worker，也未对历史订单执行受权 `panel-repair`；真实陪玩点击“刷新订单”后出现“我已就绪”的 UAT 仍待执行，Story 保持未完成。

## 2026-08-07 已取消多项目订单重复刷新详情回归

- 真实复现：订单 `P-336171B3` 取消后首次状态投影为 `CANCELLED`，但再次点击“刷新订单”时 Bot 仅使用 `getOrder` 的订单主记录。多项目订单的游戏、服务、区服、时长快照位于 `order_requirements`，主记录对应兼容字段为空，因此面板退化为“未选择游戏 · 未选择服务 / 无指定区服 · 未选择时长”。
- 修复：非草稿刷新在订单使用多项目构成或主记录缺少兼容详情时，同时只读调用 `listOrderRequirements`；终态面板以 ACTIVE 需求快照显示真实项目、区服、时长和人数，状态与金额仍取 `getOrder`。重复点击每次重新读取 API 事实，不写订单、资金、事件或 Outbox。陪玩不具备需求列表权限时仅回退到既有状态面板，不阻断 readiness 等最新操作恢复。
- RED：`npx vitest run tests/m1-us-07-bot.spec.ts` → 1 failed / 13 passed；实际返回包含“未选择游戏”“未选择服务”“未选择时长”，且未显示“瓦洛兰特”。
- GREEN：同命令最终 → 1 file / 15 tests passed；连续两次刷新均显示“瓦洛兰特 / 娱乐陪玩 / 北美 / 2 小时”，且 `listOrderRequirements` 调用 2 次；陪玩无需求列表权限时仍保留最新状态操作。
- 关联回归：订单刷新、生命周期、匹配、取消、多项目和投影一致性共 `7 files / 54 tests passed`；完整 Bot 回归 `22 files / 128 tests passed`；`npm run typecheck` 与 `npm run build` 通过。
- 修改文件：`apps/bot/src/service-center.ts`、`tests/m1-us-07-bot.spec.ts`、本证据和 `outputs/Codex-P0开发TODO.md`。
- 外部门禁：尚未在部署后的真实 Guild 对 `P-336171B3` 连续点击刷新复验；`M9-US-18` 继续保持未完成。

## 2026-08-07 客服协同卡跨状态收敛

- RED：正式订单在 `ACCEPTED` 时向客服任务频道创建协同卡，但后续 `PANEL_SYNC` 只更新客户订单面板，客服卡长期停留在“等待双方准备（ACCEPTED）”。表驱动 RED 覆盖 `IN_SERVICE`、`PENDING_CONFIRMATION`、`COMPLETED`、`CANCELLED`，1 file / 4 failed / 14 passed。
- 修复：非 `ACCEPTED` 的订单面板同步在已有 Guild、客服频道、正式参与人和语音房时，按 `accepted-staff:<orderId>` 稳定 nonce 找到原协同卡并 PATCH 当前数据库投影；状态、参与人、项目需求、关键时间及订单/语音入口随最新事实更新。找不到原卡时安全跳过，不补发来源不明的新通知。
- GREEN：Worker adapter、runtime、订单生命周期与投影一致性关联回归 `4 files / 41 tests passed`；`npm run typecheck`、`npm run build` 与 `git diff --check` 通过。
- 外部门禁：分页查找超过消息对账边界的可靠性按本轮要求暂不扩展；仍需真实 Guild 依次推进准备、服务、确认、完成/取消，确认同一客服卡原位更新。Story 保持未完成。
