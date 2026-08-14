# M9-US-12 订单频道 transcript 事件

- 状态：运行时写入权限已修复并完成真实 PostgreSQL 写入探针；仍待真实 Guild 的创建、编辑、删除三类消息 UAT。
- 合同：订单频道的 `CREATED / UPDATED / DELETED` 消息事件通过统一 API 追加；API 依据可信 Guild + channel 映射派生订单 UUID 与 `P-*` ticket，不接受客户端自报订单。
- 数据：`order_channel_message_events` append-only，按 `order_public_id, observed_at` 和 `order_id, observed_at` 建索引；更新和删除由数据库 trigger 拒绝。
- Bot：启用 `GuildMessages` 与 `MessageContent` intents，三个 Sapphire listener 发送稳定幂等事件；非订单频道由 API 返回 NOT_FOUND 并由客户端安全忽略。
- RED：最初实现阶段 `npx vitest run tests/m9-us-12-transcript.spec.ts` 因模块不存在失败；本次运行时权限回归先得到 1 failed / 4 passed，明确缺少授权迁移。
- GREEN：本次转录专项及 Worker 关联测试 2 files / 10 tests 全通过；`npm run typecheck`、`npm run db:validate`、`npm run db:verify:migration`（空库顺序应用 `000001`～`000037`）与 `git diff --check` 通过。此前实现阶段完整套件曾 build + 156 files / 783 tests 全通过；加入非订单分类过滤后的最终完整复验为 155 files / 782 tests 通过，既有 `m5-us-08-railway-runtime` 并行子进程门禁 1 项因无输出超时失败，随后单独复验 14/14 通过。Story 保持待完整 Discord UAT，不把波动隐藏为全绿。
- 迁移：`000015_order_channel_transcript` 建立 append-only 表和索引；`000037_order_channel_transcript_runtime_grant` 仅授予 `blackcat_app` 所需的 `SELECT, INSERT`，不授予 `UPDATE, DELETE`。两项均已应用到本地 PostgreSQL。
- 故障证据：修复前业务库 transcript 为 0 条，审计中存在 260 条失败的 `APPEND_ORDER_CHANNEL_EVENT`，涉及 48 个 Discord 消息；事务内探针复现 `permission denied for table order_channel_message_events`，确认是迁移创建新表后遗漏运行账号授权，而非 Bot 路由或频道映射错误。
- 真实写入探针：对已完成订单 `P-A6FEB615` 的既有 Discord 消息 `1535509051696357406` 使用新的稳定幂等键调用正式 transcript API，返回 HTTP 201、`request_id=req_02df1728-6f9c-4bdf-8c9c-bd266a2d38d6`；数据库新增对应 `CREATED` 事件，审计状态为 `SUCCEEDED`。探针未发送、编辑或删除 Discord 消息。
- 外部门禁：Discord Developer Portal 必须启用 Message Content Intent；未启用时正文无法完整采集。
- 剩余边界：此前失败的 260 次调用尚未自动回填；当前附件合同只保存 Discord 附件元数据与 URL，不保存附件二进制；已被删除且 Discord 不再提供的历史版本无法凭空恢复。
- 后续：频道删除必须作为独立生命周期 Story，在完整回填成功后才可执行；本 Story 不改变当前频道删除行为。
