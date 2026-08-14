# M2-US-10 Evidence: 取消影响预览与原子执行

## Scope

- Story：M2-US-10 取消影响预览与原子执行
- 验收用例：AT-CXL-001、AT-CAN-003、AT-CAN-008
- 前置依赖：M1-US-08、M2-US-05

## Implemented

- 实现 `POST /api/v1/orders/:orderId/cancellation-preview`，由 API 返回是否可自动处理、预留释放金额、退款金额、处理方式、客服介入要求及 60 秒有效期。
- 取消执行必须携带同一预览；事务内锁定并重验订单版本、预留版本、原因、预览状态和有效期，失效时返回 `CANCELLATION_PREVIEW_STALE` 且无资金写入。
- 待派单订单自动取消时，在同一 PostgreSQL 事务中取消订单、追加释放事件、由数据库触发器释放预留、应用预览并写审计记录。
- 原生 Hold 释放超时后使用原幂等键查询恢复；只有明确 `RELEASED` 才继续取消。结果仍为 `UNKNOWN` 时订单进入 `EXCEPTION`、预留保持活动并创建 `AUTOMATION_FAILURE` 客服任务。
- 已接单、服务中和待确认订单只生成客服处理结果，不自动裁决取消、退款、陪玩收益或返佣。
- Discord 取消按钮先展示 API 预览和金额，再要求二次确认；过期或状态变化时提示刷新，不在 Bot 端计算金额。
- OpenAPI 已补齐 `releaseAmountMinor` 与 `refundAmountMinor`；取消写入允许同一幂等键在事务提交失败后安全重试。

## Verification

- RED：取消接口原先无需预览；预览/版本变化无法阻止资金写入；原生 Hold 释放未知直接返回 `504`；PostgreSQL 释放事件序号与状态更新顺序触发约束失败。
- GREEN：`npm test -- --run tests/m2-us-10-api.spec.ts tests/m2-us-10-bot.spec.ts tests/m2-us-10-db.spec.ts tests/m1-us-08-api.spec.ts tests/m2-us-05-api.spec.ts`，5 files / 19 tests passed。
- `npm test`：49 files / 265 tests passed。
- `npm run typecheck`：exit 0。
- `git diff --check`：exit 0。

## Residual Risk

- 真实支付供应商的 release 查询语义需在接入验收时确认，尤其是按释放幂等键查询及 `UNKNOWN` 到终态的轮询 SLA。
- Discord credential 暂未提供，测试 Guild 中取消预览、确认及过期刷新 E2E 未执行。
- 捕获后的人工退款与 UNKNOWN 恢复由 M2-US-06 的管理员退款流程处理；本 Story 不允许用户侧自动裁决已接单争议。

## 2026-08-07 取消预览回退订单修复

- 真实复现：客户打开“取消影响确认”后，次要按钮为“返回服务中心”，会离开当前订单，无法直接放弃取消并恢复订单面板。
- 修复：次要按钮改为“暂不取消，返回订单”，路由使用无版本 `bc:order:<orderId>:refresh`。该操作只读取订单最新事实并原位恢复订单面板；只有“确认取消”继续携带预览 ID 与版本调用 `cancelOrder`。
- RED：`npx vitest run tests/m2-us-10-bot.spec.ts` → 1 failed / 3 passed；实际 custom ID 为 `bc:entry:service-center`，不符合返回当前订单的预期。
- GREEN：同命令 → 1 file / 4 tests passed；取消/刷新 API、数据库和 Bot 关联回归 → 4 files / 26 tests passed；完整 Bot 回归 → 22 files / 128 tests passed；`npm run typecheck` 与 `npm run build` 通过。
- 额外跨 Story 审计：加入 `tests/m17-us-08-handler-behavior.spec.ts` 时为 2 failed / 28 passed；两个既有失败分别仍期待已废弃的带版本刷新 ID，以及现有按钮适配器 702 行超过旧 700 行阈值。本修复未修改对应路由或适配器，不跨 Story 调整该门禁。
- 修改文件：`apps/bot/src/service-center.ts`、`tests/m2-us-10-bot.spec.ts`、本证据和 `outputs/Codex-P0开发TODO.md`。
- 外部门禁：尚未把候选部署到真实 Guild 并点击“暂不取消，返回订单”复验。

## 2026-08-07 过期取消预览自动刷新

- 真实请求核对：`request_id=req_64667d5c-519c-4787-b270-97fcc078cb29` 对应订单 `P-BE7E43CE`。确认请求发生于 `2026-08-07 19:28:19.990 UTC`；订单仍为 `PENDING_DISPATCH v3`，内部预留仍为 `ACTIVE v1`，均未发生变化。旧预览有效期截止 `19:16:46.913 UTC`，确认时已过期约 11 分 33 秒，因此 API 正确返回 `CANCELLATION_PREVIEW_STALE`，但原 Bot 文案错误笼统描述为“订单状态发生变化”。
- 修复：Bot 收到 stale 后不重试取消；先只读获取最新订单版本，再调用 `previewOrderCancellation` 生成新预览，原位替换旧卡片并明确提示“原说明已过期或订单有新变化、本次刷新没有取消订单”。客户必须核对新金额、方式和时效后再次点击确认。
- 安全边界：一次确认交互最多调用一次 `cancelOrder`；刷新预览使用独立幂等键 `<cancel-confirm-key>:refresh-preview`，不释放预留、不退款、不改变订单状态。若最新订单已不允许预览，则返回刷新失败的 API 错误，不绕过服务端状态与资金校验。
- RED：`npx vitest run tests/m2-us-10-bot.spec.ts` → 1 failed / 3 passed；旧实现返回 `EPHEMERAL_MESSAGE` 并把用户留在失效 preview ID 上。
- GREEN：同命令 → 1 file / 4 tests passed；断言新卡片使用新 preview ID/订单版本、重新预览采用最新版本，且 `cancelOrder` 只调用一次。取消 API/数据库、订单刷新与文案关联回归 → 5 files / 29 tests passed；完整 Bot 回归 → 22 files / 128 tests passed；`npm run typecheck` 与 `npm run build` 通过。
- 修改文件：`apps/bot/src/bot-copy.ts`、`apps/bot/src/service-center.ts`、`apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts`、`tests/m2-us-10-bot.spec.ts`、本证据和 `outputs/Codex-P0开发TODO.md`。
- 外部门禁：候选尚未在真实 Guild 复验“过期确认 → 原位出现新预览 → 再次确认取消”的完整交互。
