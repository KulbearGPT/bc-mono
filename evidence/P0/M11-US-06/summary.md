# M11-US-06 数字 Reaction 报名与撤回证据

日期：2026-08-08

状态：本地候选完成；真实 Guild 的多人增删 Reaction、Bot 重启与十项目拒绝 UAT 尚未签署，因此 Story 保持 `IN_PROGRESS`。

## 合同与实现

- 新增 Story `M11-US-06` 与验收 `AT-SEL-008`，并补充状态图验收 `AT-SEL-009`；同步主规格、backlog、OpenAPI、Prisma 目标合同、交互映射、验收目录、UAT runbook 和 TODO 镜像。
- 单张公开招募卡按稳定需求顺序使用 `1️⃣` 至 `9️⃣`；不再渲染报名 Select。超过九个仍有空缺的需求时，API 在创建候选池前零写入拒绝，Worker 同时防御性拒绝截断或拆卡。
- `selection_pools` 持久化派单频道、消息 ID 与 emoji-to-requirement 绑定；Reaction 请求只提交消息、emoji 和期望状态，API 从服务端映射解析真实池与需求并重新验证陪玩资格。
- 添加 Reaction 幂等创建或恢复 `APPLIED`；移除 Reaction 幂等迁移到 `WITHDRAWN`；撤回后重新添加复用同一 application 并递增版本，避免唯一键冲突。每次真实变更仍追加应用事件和 `PANEL_SYNC`。
- Bot 新增 Reaction Gateway intent、partial 支持、增删监听与同用户同项目事件串行队列。新增失败时移除未确认 Reaction 并私信；移除失败由日志和启动对账恢复。
- Worker 原位发布或恢复稳定消息、添加数字 Reaction、持久化精确消息 ID；终止或取消时编辑同一消息并清除 Reaction。Bot 启动读取受限服务端活动卡投影，对 Discord 用户与当前 `APPLIED` 事实提交幂等增删观测。
- 旧版恢复修复：Worker 现在会规范化所有 `COLLECTING` 池，而不只处理尚无消息映射的池；它可通过旧 Select `custom_id` 精确识别同一候选池，将映射消息原位改成 Reaction-only payload，并清空、停用同池重复旧卡，避免“旧 dropdown 仍可见”或重启后复发。
- 派单状态图：使用内置 imagegen 生成并落库两张 `1774×887` PNG。新订单首次招募按订单稳定 nonce 先上传 `apps/api/assets/dispatch/dispatching.png`，再发送原报名 Embed；整单进入 `CANCELLED` 后幂等上传 `apps/api/assets/dispatch/order-cancelled.png`。终止招募进入 `SELECTION` 不发送流单图，后续轮次、Outbox 重试和 Worker 重启不会重复同一状态图。

## RED / GREEN

- RED：`npx vitest run tests/m11-us-06-selection-reactions.spec.ts`
  - 结果：suite 在导入时失败，缺少 `apps/bot/src/selection-reactions.ts`；这是实现前基线。
- GREEN：`npx vitest run tests/m11-us-06-selection-reactions.spec.ts`
  - 初始结果：`1 file / 8 tests passed`。
- 旧卡恢复缺陷 RED：同一候选池已有两条旧 dropdown，持久化消息只被加上 `1️⃣`，未移除 Select；新增测试分别因重复卡未停用、未映射旧卡被重复 POST、已有映射池未进入启动规范化而失败（`3 failed / 8 passed`）。
- 旧卡恢复缺陷 GREEN：`npm test -- --run tests/m11-us-06-selection-reactions.spec.ts`
  - 结果：build 通过，`1 file / 11 tests passed`。
- 状态图 RED：首次招募只发报名 Embed，取消分支不发附件；新增两项测试得到 `2 failed / 11 passed`。
- 状态图 GREEN：`npm test -- --run tests/m11-us-06-selection-reactions.spec.ts`
  - 结果：build 通过，`1 file / 13 tests passed`；覆盖 multipart 文件名、派单图先于 Embed、订单级 nonce 去重、仅 `CANCELLED` 发布流单图，以及生产 Docker runtime 必须包含图片资产目录。
- 生产资产 RED/GREEN：新增 Docker 资产断言首次因 runtime 只复制 `dist` 而失败；补充 `COPY --from=build /app/apps/api/assets ./apps/api/assets` 后目标测试恢复通过，避免开发环境可用但部署后 `ENOENT`。
- PostgreSQL 与完整迁移链：`npx vitest run tests/m11-us-02-selection-pools-postgres.spec.ts`
  - 结果：`1 file / 4 tests passed`；覆盖持久映射及 `APPLIED → WITHDRAWN → APPLIED`，同一 application 版本为 `1 → 2 → 3`。
- M11 聚焦回归：`npx vitest run tests/m11-us-01-selection-pool-contract.spec.ts tests/m11-us-02-selection-pools-api.spec.ts tests/m11-us-02-selection-pools-postgres.spec.ts tests/m11-us-03-selection-discord.spec.ts tests/m11-us-05-manual-recruitment.spec.ts tests/m11-us-06-selection-reactions.spec.ts`
  - 最新结果：`6 files / 55 tests passed`。
- `npm run db:validate`：Prisma schema valid。
- `npm run quality:routes`：`159 production operations are documented`。
- 主规格、backlog、交互映射和验收镜像逐字节一致；验收矩阵现为 292 条业务验收（另 1 行表头）。
- `npm run pieces -w @blackcat/bot`：发现 22 个 Pieces，包含 `message-reaction-add` 与 `message-reaction-remove`。
- `npm run typecheck -w @blackcat/api`、`npm run typecheck -w @blackcat/bot`、`npm run build`：通过。
- `git diff --check`：通过。
- 全仓 Vitest：预计 `1181 tests` 中 `1178 passed / 3 failed`；失败仍为既有非关联门禁：M17 refresh 路由未识别、button adapter 707 行超过 700 行，以及本地 `eslint` executable 缺失。

## 本地运行时恢复

- `npm run db:migrate:deploy` 已在本地 PostgreSQL 应用 `000039_selection_reaction_signup` 与 `000040_selection_reaction_card_backfill`。
- 新 Worker 启动日志：`queuedSelectionReactionCards: 1`；随后 `SELECTION_POOL_SYNC` 成功，request_id `req_b4bcb153-c069-485c-932e-190a03f201a9`。
- 活动订单 `P-40D34053` 已持久化派单频道 `1533342003478138910`、消息 `1535716063952502868` 和 1 条数字 Reaction 绑定，可用于后续真实 Guild 点击验收。
- 旧卡修复后再次启动 Worker：`queuedSelectionReactionCards: 1`；规范化任务第二次尝试成功，request_id `req_5ca22087-1be5-467c-a105-f6c0879a8424`。Discord API 复核：消息 `1535716063952502868` 的 `components=[]`、footer 为精确 pool marker、Reaction 为 `1️⃣`；重复消息 `1535598108837421130` 已显示“旧报名卡”、`components=[]` 且无 Reaction。
- 状态图实现后使用真实 `.env` 重启 Worker，启动日志为 `recoveredJobs: 0`、`queuedSelectionReactionCards: 0`、`queuedTerminalChannelCleanups: 0`；当前没有新订单任务，故未对现有活动卡补发图片，避免破坏“新订单先图后 Embed”的顺序。

## 剩余外部验收

- 真实陪玩分别添加多个项目 Reaction，确认只报名相应需求且客户订单卡 mention 实时更新。
- 移除其中一个 Reaction，确认只撤回该需求；再次添加确认 application 恢复且无重复记录。
- 在事件遗漏条件下重启 Bot，确认 Discord Reaction 与数据库报名事实收敛。
- 以九项目验证 `1️⃣–9️⃣`，以十项目验证开始招募零写入、不拆卡、不截断，并保存 request_id、Discord 录屏与数据库快照。
- 在真实 Guild 新建一单，确认“正在派单”图严格早于报名 Embed 且刷新/重启不重复；分别执行“终止招募”和“取消整单”，确认前者不发、后者只发一次“本单流单”图。
