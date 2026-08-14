# M6-US-06 验收证据

- Story：M6-US-06 余额不足礼物的充值回流
- 验收：AT-GFT-012、AT-GFT-013、AT-GFT-014、AT-GFT-015
- 日期：2026-07-19

## 交付结果

- `checkGiftAffordability` 只读接口原子读取 fresh Provider balance 与本人全部 Guild 的 active reservations，返回 `priceMinor`、`reservedMinor`、`availableMinor`、`shortfallMinor`、`currency`、`catalogVersion`、`fetchedAt`、`stale`、`canAfford` 和当前 Guild 受控 `rechargeUrl`。
- 所有启用礼物保持可点击。余额不足或 stale 时不创建 GiftRequest、FundReservation、ConsumptionEntry、客服任务或 Outbox；Discord ephemeral 面板只显示差额、充值 Link、刷新余额和返回礼物。
- Bot 使用 83 字符 HMAC continuation token 绑定 Actor、订单、礼物、版本、价格和 30 分钟有效期；所有 custom ID 不超过 100 字符，不使用进程内 Map，不接受 receiver 输入。
- 最终确认重新调用 affordability，并要求当前 order version、catalog version、price 和 fresh balance 一致。目录价格、version、上下架或并发预留变化时回到重确认/不足路径，不按旧价写入。
- PostgreSQL 最终事务按用户全局 Provider 账户汇总全部 Guild 的 active reservations，并在 advisory lock 内锁定订单与目录；并发不足零业务写入。Provider native hold 在本地事务失败时使用独立幂等键释放。
- 安全复核后，礼物目录、余额检查和最终创建均要求可信 Actor Guild 与订单 Guild 一致；PostgreSQL 在锁定订单后再次核对。相同客户的跨 Guild 订单统一返回不泄露存在性的 404，且不会调用 Provider 或写入任何业务事实。

## 修改文件

- API/Bot：`.env.example`、`apps/api/src/bot-config.ts`、`apps/api/src/gifts.ts`、`apps/bot/src/gifts.ts`、`apps/bot/src/service-center.ts`、`apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts`
- 自动化：`tests/m6-us-06-api.spec.ts`、`tests/m6-us-06-bot.spec.ts`、`tests/m3-us-01-api.spec.ts`、`tests/m3-us-01-bot.spec.ts`、`tests/m3-us-01-db.spec.ts`
- 合同/交互：`outputs/P0开发交付包/02-API/openapi.yaml`、`outputs/P0开发交付包/01-UIUX/交互映射.csv` 及 `docs/` 镜像
- 原型：`outputs/陪玩业务系统第一版产品演示.html`、`outputs/陪玩业务系统非技术演示版.html` 及 `docs/` 镜像
- 跟踪：`outputs/Codex-P0开发TODO.md`、`docs/Codex-P0开发TODO.md`

## 验证证据

- RED：`npx vitest run tests/m6-us-06-api.spec.ts tests/m6-us-06-bot.spec.ts` -> 2 files / 10 tests failed，缺少 affordability route、enabled 控件、HMAC continuation 和 Bot client。
- receiver RED：`npx vitest run tests/m6-us-06-api.spec.ts -t "rejects receiver input"` -> 1 failed，旧解析器错误接受 receiver；收紧 exact body 后纳入最终回归。
- cross-Guild RED：`npx vitest run tests/m6-us-06-api.spec.ts` -> 新增用例观察到旧实现错误返回 200；修复后跨 Guild affordability/create 均为 404 且零写入。
- 聚焦 + M3 礼物 + US05 + 合同：`npx vitest run tests/m6-us-00-contract.spec.ts tests/m6-us-05-api.spec.ts tests/m6-us-05-bot.spec.ts tests/m6-us-06-api.spec.ts tests/m6-us-06-bot.spec.ts tests/m3-us-*.spec.ts` -> 22 files / 84 tests passed。
- 数据库聚焦：`npx vitest run tests/m3-us-01-db.spec.ts` -> 1 file / 5 tests passed；包含目录变化零写入与跨 Guild 竞争预留回退。
- `npm run typecheck` -> exit 0。
- `npm run build` -> exit 0。
- `npm run pieces -w @blackcat/bot` -> exit 0，发现 13 个 Sapphire pieces。
- `npm run db:validate` -> Prisma schema valid，exit 0。
- `npm run db:verify:migration` -> `migration-apply-ok`，60 tables，约束/不可变/迁移保护探针全部通过，exit 0。
- authoritative/docs 镜像：OpenAPI、交互映射和两份原型均 `cmp` 相等。

## 剩余风险

- 自动化覆盖共享 API、Discord 组件渲染、HMAC 上下文、并发和 PostgreSQL 事务；真实 Discord 测试 Guild 与 Provider 沙箱充值回跳仍属于发布/UAT 门禁，未在本 Story 本地验证中冒充完成。
- `recharge_url` 缺失、非 HTTPS 或 Provider balance stale 时接口失败关闭；部署前必须为目标 Guild 写入有效受控配置，并配置至少 32 字符的 `GIFT_CONTINUATION_SIGNING_SECRET`。
